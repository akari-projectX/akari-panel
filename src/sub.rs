use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::MaybeClientIp;
use crate::{reject, state::AppState};

// ---------------------------------------------------------------------------
// Token management. The subscription URL credential is a 256-bit random; the
// database stores only its SHA-256, so a database leak does not leak live
// subscription URLs.
// ---------------------------------------------------------------------------

pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Length of a generated token (32 bytes, base64url without padding).
const TOKEN_LEN: usize = 43;

/// Could this path segment be a token we issued? Anything else is
/// rejected before any hashing or database work.
fn plausible_token(token: &str) -> bool {
    token.len() == TOKEN_LEN
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

// ---------------------------------------------------------------------------
// Subscription rendering
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Format {
    SingBox,
    Clash,
    Links,
}

fn detect_format(user_agent: &str) -> Format {
    let ua = user_agent.to_ascii_lowercase();
    if ua.contains("sing-box") {
        Format::SingBox
    } else if ua.contains("clash") || ua.contains("mihomo") || ua.contains("stash") {
        Format::Clash
    } else {
        Format::Links
    }
}

#[derive(FromRow)]
struct SubUser {
    id: Uuid,
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
}

/// One assignment of the subscribing user: the node's public data and the
/// user's credentials on it (input of `render`).
#[derive(FromRow)]
pub struct NodeRow {
    pub name: String,
    pub xray_inbounds: Value,
    pub server_addr: Option<String>,
    pub credentials: Value,
}

#[derive(serde::Deserialize)]
struct Credential {
    inbound_tag: String,
    protocol: String,
    account: Value,
}

/// uTLS fingerprints a client library accepts for REALITY.
pub(crate) const FINGERPRINTS: &[&str] = &[
    "chrome",
    "firefox",
    "safari",
    "ios",
    "android",
    "edge",
    "360",
    "qq",
    "random",
    "randomized",
];
const DEFAULT_FINGERPRINT: &str = "chrome";

/// The admin's `realitySettings.fingerprint` hint when it is on the
/// allow-list, else the default. Most clients refuse REALITY without one.
fn reality_fingerprint(reality: Option<&Value>) -> String {
    reality
        .and_then(|t| t.get("fingerprint"))
        .and_then(|v| v.as_str())
        .filter(|f| FINGERPRINTS.contains(f))
        .unwrap_or(DEFAULT_FINGERPRINT)
        .to_string()
}

struct Net {
    port: u16,
    network: String,
    security: String, // none | tls | reality
    sni: String,
    public_key: String,
    short_id: String,
    /// uTLS client fingerprint (REALITY only; empty otherwise).
    fingerprint: String,
    ws_path: String,
    ws_host: String,
}

fn net_from_inbound(inbound: &Value) -> Option<Net> {
    let port = inbound.get("port")?.as_u64()? as u16;
    let ss = inbound.get("streamSettings");
    let get = |key: &str| ss.and_then(|s| s.get(key));
    let network = get("network")
        .and_then(|v| v.as_str())
        .unwrap_or("tcp")
        .to_string();
    let security = get("security")
        .and_then(|v| v.as_str())
        .unwrap_or("none")
        .to_string();
    let sni = match security.as_str() {
        "tls" => get("tlsSettings")
            .and_then(|t| t.get("serverName"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "reality" => get("realitySettings")
            .and_then(|t| t.get("serverNames"))
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    };
    let reality = get("realitySettings");
    let (public_key, short_id, fingerprint) = if security == "reality" {
        (
            reality
                .and_then(|t| t.get("publicKey"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            reality
                .and_then(|t| t.get("shortId"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            reality_fingerprint(reality),
        )
    } else {
        (String::new(), String::new(), String::new())
    };
    let ws = get("wsSettings");
    let (ws_path, ws_host) = if network == "ws" {
        (
            ws.and_then(|w| w.get("path"))
                .and_then(|v| v.as_str())
                .unwrap_or("/")
                .to_string(),
            ws.and_then(|w| w.get("headers"))
                .and_then(|h| h.get("Host"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
    } else {
        (String::new(), String::new())
    };
    Some(Net {
        port,
        network,
        security,
        sni,
        public_key,
        short_id,
        fingerprint,
        ws_path,
        ws_host,
    })
}

struct Proxy {
    name: String,
    protocol: String,
    id_or_password: String, // vless/vmess uuid, trojan password
    flow: String,
    server: String,
    net: Net,
}

fn collect_proxies(rows: &[NodeRow]) -> Vec<Proxy> {
    let mut proxies = Vec::new();
    for row in rows {
        let Some(server) = row.server_addr.as_deref().filter(|s| !s.is_empty()) else {
            continue; // admin has not set a public address yet
        };
        let credentials: Vec<Credential> = match serde_json::from_value(row.credentials.clone()) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(node = %row.name, error = %e,
                    "node_users.credentials is not a valid credential list; node skipped in subscription");
                continue;
            }
        };
        for cred in credentials {
            let Some(inbound) = row
                .xray_inbounds
                .as_array()
                .and_then(|arr| {
                    arr.iter()
                        .find(|i| i.get("tag").and_then(|t| t.as_str()) == Some(&cred.inbound_tag))
                })
                .cloned()
            else {
                continue;
            };
            let Some(net) = net_from_inbound(&inbound) else {
                continue;
            };
            let id_or_password = match cred.protocol.as_str() {
                "vless" | "vmess" => cred.account.get("id").and_then(|v| v.as_str()),
                "trojan" => cred.account.get("password").and_then(|v| v.as_str()),
                _ => None,
            };
            let Some(id_or_password) = id_or_password else {
                continue;
            };
            proxies.push(Proxy {
                name: format!("{} · {}", row.name, cred.inbound_tag),
                protocol: cred.protocol.clone(),
                id_or_password: id_or_password.to_string(),
                flow: cred
                    .account
                    .get("flow")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                server: server.to_string(),
                net,
            });
        }
    }
    proxies
}

/// Percent-encode a link fragment (node names may hold spaces/unicode).
fn encode_fragment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn query_params(p: &Proxy, include_flow: bool) -> String {
    let mut params = vec![format!("type={}", p.net.network)];
    if p.net.security != "none" {
        params.push(format!("security={}", p.net.security));
    }
    if include_flow && !p.flow.is_empty() {
        params.push(format!("flow={}", p.flow));
    }
    if !p.net.sni.is_empty() {
        params.push(format!("sni={}", p.net.sni));
    }
    if !p.net.public_key.is_empty() {
        params.push(format!("pbk={}", p.net.public_key));
    }
    if !p.net.short_id.is_empty() {
        params.push(format!("sid={}", p.net.short_id));
    }
    if !p.net.fingerprint.is_empty() {
        params.push(format!("fp={}", p.net.fingerprint));
    }
    if p.net.network == "ws" {
        if !p.net.ws_path.is_empty() {
            params.push(format!("path={}", encode_fragment(&p.net.ws_path)));
        }
        if !p.net.ws_host.is_empty() {
            params.push(format!("host={}", p.net.ws_host));
        }
    }
    params.join("&")
}

fn render_links(proxies: &[Proxy]) -> String {
    let mut lines = Vec::new();
    for p in proxies {
        let frag = encode_fragment(&p.name);
        match p.protocol.as_str() {
            "vless" => lines.push(format!(
                "vless://{}@{}:{}?{}#{}",
                p.id_or_password,
                p.server,
                p.net.port,
                query_params(p, true),
                frag
            )),
            "trojan" => lines.push(format!(
                "trojan://{}@{}:{}?{}#{}",
                p.id_or_password,
                p.server,
                p.net.port,
                query_params(p, false),
                frag
            )),
            "vmess" => {
                let payload = json!({
                    "v": "2",
                    "ps": p.name,
                    "add": p.server,
                    "port": p.net.port.to_string(),
                    "id": p.id_or_password,
                    "aid": "0",
                    "scy": "auto",
                    "net": p.net.network,
                    "type": "none",
                    "host": p.net.ws_host,
                    "path": p.net.ws_path,
                    "tls": if p.net.security == "tls" { "tls" } else { "" },
                });
                lines.push(format!(
                    "vmess://{}",
                    STANDARD.encode(payload.to_string().as_bytes())
                ));
            }
            _ => {}
        }
    }
    // V2ray-family clients expect the link list itself to be base64.
    STANDARD.encode(lines.join("\n"))
}

fn render_clash(proxies: &[Proxy]) -> String {
    let mut out = String::from("proxies:\n");
    let mut names = Vec::new();
    for p in proxies {
        names.push(serde_json::to_string(&p.name).unwrap_or_else(|_| "\"proxy\"".into()));
        out.push_str("  - name: ");
        out.push_str(&serde_json::to_string(&p.name).unwrap_or_else(|_| "\"proxy\"".into()));
        out.push('\n');
        out.push_str(&format!("    type: {}\n", p.protocol));
        out.push_str(&format!("    server: {}\n", p.server));
        out.push_str(&format!("    port: {}\n", p.net.port));
        match p.protocol.as_str() {
            "vless" => {
                out.push_str(&format!("    uuid: {}\n", p.id_or_password));
                if !p.flow.is_empty() {
                    out.push_str(&format!("    flow: {}\n", p.flow));
                }
            }
            "vmess" => {
                out.push_str(&format!("    uuid: {}\n", p.id_or_password));
                out.push_str("    alterId: 0\n    cipher: auto\n");
            }
            "trojan" => {
                out.push_str(&format!("    password: {}\n", p.id_or_password));
            }
            _ => {}
        }
        out.push_str(&format!("    network: {}\n", p.net.network));
        if p.net.security == "tls" || p.net.security == "reality" {
            out.push_str("    tls: true\n");
            if !p.net.sni.is_empty() {
                out.push_str(&format!("    servername: {}\n", p.net.sni));
            }
        }
        if !p.net.fingerprint.is_empty() {
            out.push_str(&format!("    client-fingerprint: {}\n", p.net.fingerprint));
        }
        if p.net.security == "reality" {
            out.push_str("    reality-opts:\n");
            out.push_str(&format!("      public-key: {}\n", p.net.public_key));
            if !p.net.short_id.is_empty() {
                out.push_str(&format!("      short-id: {}\n", p.net.short_id));
            }
        }
        if p.net.network == "ws" {
            out.push_str("    ws-opts:\n");
            out.push_str(&format!("      path: {}\n", p.net.ws_path));
            if !p.net.ws_host.is_empty() {
                out.push_str("      headers:\n");
                out.push_str(&format!("        Host: {}\n", p.net.ws_host));
            }
        }
    }
    out.push_str("proxy-groups:\n  - name: PROXY\n    type: select\n    proxies:\n");
    for name in &names {
        out.push_str(&format!("      - {name}\n"));
    }
    out.push_str("rules:\n  - MATCH,PROXY\n");
    out
}

fn render_sing_box(proxies: &[Proxy]) -> Value {
    let outbounds: Vec<Value> = proxies
        .iter()
        .map(|p| {
            let mut obj = serde_json::Map::new();
            obj.insert("tag".into(), json!(p.name));
            obj.insert("type".into(), json!(p.protocol));
            obj.insert("server".into(), json!(p.server));
            obj.insert("server_port".into(), json!(p.net.port));
            match p.protocol.as_str() {
                "vless" | "vmess" => {
                    obj.insert("uuid".into(), json!(p.id_or_password));
                    if p.protocol == "vless" && !p.flow.is_empty() {
                        obj.insert("flow".into(), json!(p.flow));
                    }
                }
                "trojan" => {
                    obj.insert("password".into(), json!(p.id_or_password));
                }
                _ => {}
            }
            if p.net.security == "tls" || p.net.security == "reality" {
                let mut tls = json!({"enabled": true});
                if !p.net.sni.is_empty() {
                    tls["server_name"] = json!(p.net.sni);
                }
                if p.net.security == "reality" {
                    tls["utls"] = json!({
                        "enabled": true,
                        "fingerprint": p.net.fingerprint,
                    });
                    tls["reality"] = json!({
                        "enabled": true,
                        "public_key": p.net.public_key,
                        "short_id": p.net.short_id,
                    });
                }
                obj.insert("tls".into(), tls);
            }
            if p.net.network == "ws" {
                let mut transport = json!({"type": "ws"});
                if !p.net.ws_path.is_empty() {
                    transport["path"] = json!(p.net.ws_path);
                }
                if !p.net.ws_host.is_empty() {
                    transport["headers"] = json!({"Host": p.net.ws_host});
                }
                obj.insert("transport".into(), transport);
            }
            Value::Object(obj)
        })
        .collect();
    json!({
        "outbounds": outbounds
            .into_iter()
            .chain(std::iter::once(json!({"type": "direct", "tag": "direct"})))
            .collect::<Vec<Value>>(),
    })
}

/// Round the response body up to fixed-size buckets so subscription size
/// does not reveal node/user counts.
fn pad(body: String) -> String {
    let target = (body.len().div_ceil(4096) * 4096).max(8192);
    let mut body = body;
    while body.len() < target {
        body.push('\n');
    }
    body
}

/// The subscription body for `user_agent` (format by UA) and its content
/// type, padded (`pad`). Pure: the request path and the benchmarks share it.
pub fn render(user_agent: &str, rows: &[NodeRow]) -> (&'static str, String) {
    let format = detect_format(user_agent);
    let proxies = collect_proxies(rows);
    let body = match format {
        Format::SingBox => render_sing_box(&proxies).to_string(),
        Format::Clash => render_clash(&proxies),
        Format::Links => render_links(&proxies),
    };
    let content_type = match format {
        Format::SingBox => "application/json; charset=utf-8",
        Format::Clash => "text/yaml; charset=utf-8",
        Format::Links => "text/plain; charset=utf-8",
    };
    (content_type, pad(body))
}

/// GET /{prefix}/sub/{token} — the client-facing subscription. The token is
/// the credential; no cookie or other auth applies. Any failure (unknown
/// token, disabled or expired user, rate limit) returns the same empty 404
/// rejection as everything else, and success headers are only sent on
/// success.
///
/// Rate limit (M1-10, `[sub]` config): per client address (IPv6 per /64)
/// checked first, then per token — the per-token counter is only created
/// for tokens that belong to a served user, so junk tokens cannot multiply
/// Valkey keys (per-address keys are bounded by the distinct addresses
/// seen in a window). Over a limit = the canonical rejection, never 429.
/// If Valkey is unreachable the limit fails open (subscriptions keep
/// working; logged).
///
/// The token never reaches a log line: nothing here logs it, and request
/// paths that are logged anywhere must go through `web::redacted_path`.
pub async fn subscription(
    State(state): State<AppState>,
    MaybeClientIp(client): MaybeClientIp,
    Path((_, token)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let limits = &state.cfg().sub;
    if let Some(ip) = client {
        let key = format!("akari:rl:sub:ip:{}", crate::client_ip::bucket(ip));
        if !within_limit(&state, key, limits.rate_per_ip, limits.rate_window_secs).await {
            return reject::not_found();
        }
    }
    if !plausible_token(&token) {
        return reject::not_found();
    }
    let hash = hash_token(&token);

    // Only served users (role=user, enabled, not expired; enforce::SERVED).
    let user = match sqlx::query_as::<_, SubUser>(sqlx::AssertSqlSafe(format!(
        "SELECT u.id, u.traffic_used_bytes, u.traffic_limit_bytes, u.expires_at \
         FROM users u WHERE u.sub_token_hash = $1 AND {}",
        crate::enforce::SERVED
    )))
    .bind(&hash)
    .fetch_optional(state.pg())
    .await
    {
        Ok(Some(user)) => user,
        Ok(None) => return reject::not_found(),
        Err(e) => {
            tracing::error!(error = %e, "subscription db error");
            return reject::not_found();
        }
    };
    // Keyed by user id (bounded by the number of users; a rotated token
    // does not reset the user's window).
    let key = format!("akari:rl:sub:user:{}", user.id);
    if !within_limit(&state, key, limits.rate_per_token, limits.rate_window_secs).await {
        return reject::not_found();
    }
    let rows = match sqlx::query_as::<_, NodeRow>(
        "SELECT n.name, n.xray_inbounds, n.server_addr, nu.credentials \
         FROM node_users nu \
         JOIN nodes n ON n.id = nu.node_id AND n.enabled = true \
         JOIN users u ON u.id = nu.user_id AND u.enabled = true \
         WHERE nu.user_id = $1",
    )
    .bind(user.id)
    .fetch_all(state.pg())
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(error = %e, "subscription db error");
            return reject::not_found();
        }
    };

    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let (content_type, body) = render(user_agent, &rows);

    // Quota header only after every failure path is cleared.
    let expire = user
        .expires_at
        .map(|t| format!("expire={}", t.timestamp()))
        .unwrap_or_else(|| "expire=0".into());
    let userinfo = format!(
        "upload=0; download={}; total={}; {expire}",
        user.traffic_used_bytes,
        user.traffic_limit_bytes.unwrap_or(0)
    );

    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (
                header::HeaderName::from_static("subscription-userinfo"),
                HeaderValue::from_str(&userinfo)
                    .unwrap_or_else(|_| HeaderValue::from_static("upload=0; download=0; total=0")),
            ),
            (
                header::HeaderName::from_static("profile-update-interval"),
                HeaderValue::from_static("24"),
            ),
            (
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"akari\""),
            ),
        ],
        body,
    )
        .into_response()
}

async fn within_limit(state: &AppState, key: String, limit: i64, window: i64) -> bool {
    match crate::rate::hit(state, key, limit, window).await {
        Ok(ok) => ok,
        Err(e) => {
            tracing::warn!(error = %e, "subscription rate limit unavailable (failing open)");
            true
        }
    }
}

/// Mint a new subscription token for a user (the old one stops working at
/// commit), in the caller's transaction, audited ("user.sub_token.rotate"
/// with no token material). The plaintext is returned exactly once; the
/// database keeps only its SHA-256. `None` if the user does not exist.
pub async fn rotate_token(
    conn: &mut sqlx::PgConnection,
    actor: &crate::audit::Actor,
    user_id: Uuid,
) -> sqlx::Result<Option<String>> {
    let token = generate_token();
    let n = sqlx::query("UPDATE users SET sub_token_hash = $2 WHERE id = $1")
        .bind(user_id)
        .bind(hash_token(&token))
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if n == 0 {
        return Ok(None);
    }
    crate::audit::record(
        conn,
        actor,
        "user.sub_token.rotate",
        "user",
        Some(user_id.to_string()),
        None,
        Some(json!({ "sub_token": crate::audit::CHANGED })),
    )
    .await?;
    Ok(Some(token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::http::{rand_ip, Client};
    use crate::testdb::TestDb;
    use axum::http::StatusCode;
    use fred::prelude::KeysInterface;

    fn reality_proxy(inbound_fp: Option<&str>) -> Proxy {
        let mut rs = json!({
            "serverNames": ["www.apple.com"],
            "publicKey": "PUB",
            "shortId": "ab12",
        });
        if let Some(f) = inbound_fp {
            rs["fingerprint"] = json!(f);
        }
        let inbound = json!({
            "port": 443,
            "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": rs},
        });
        Proxy {
            name: "n".into(),
            protocol: "vless".into(),
            id_or_password: "u".into(),
            flow: "xtls-rprx-vision".into(),
            server: "s.example".into(),
            net: net_from_inbound(&inbound).unwrap(),
        }
    }

    #[test]
    fn reality_renders_utls_fingerprint_in_all_formats() {
        for (hint, want) in [
            (None, "chrome"),
            (Some("firefox"), "firefox"),
            (Some("bogus"), "chrome"),
            (Some(""), "chrome"),
        ] {
            let p = [reality_proxy(hint)];
            let links = String::from_utf8(STANDARD.decode(render_links(&p)).unwrap()).unwrap();
            assert!(links.contains(&format!("&fp={want}")), "{links}");
            assert!(render_clash(&p).contains(&format!("    client-fingerprint: {want}\n")));
            let sb = render_sing_box(&p);
            assert_eq!(sb["outbounds"][0]["tls"]["utls"]["fingerprint"], want);
            assert_eq!(sb["outbounds"][0]["tls"]["utls"]["enabled"], true);
        }
    }

    #[test]
    fn non_reality_has_no_fingerprint() {
        let inbound = json!({"port": 1, "streamSettings": {"network": "tcp"}});
        let p = [Proxy {
            name: "n".into(),
            protocol: "vless".into(),
            id_or_password: "u".into(),
            flow: String::new(),
            server: "s".into(),
            net: net_from_inbound(&inbound).unwrap(),
        }];
        let links = String::from_utf8(STANDARD.decode(render_links(&p)).unwrap()).unwrap();
        assert!(!links.contains("fp="));
        assert!(!render_clash(&p).contains("client-fingerprint"));
        assert!(render_sing_box(&p)["outbounds"][0].get("tls").is_none());
    }

    /// A user on one node with a REALITY vless, a websocket vmess and a TLS
    /// trojan inbound (every protocol and transport the renderers branch on).
    fn snapshot_rows() -> Vec<NodeRow> {
        let inbounds = json!([
            {"tag": "in-vless", "protocol": "vless", "port": 443, "streamSettings": {
                "network": "tcp", "security": "reality",
                "realitySettings": {"serverNames": ["www.apple.com"], "publicKey": "PUBKEY",
                                    "shortId": "ab12", "fingerprint": "firefox"}}},
            {"tag": "in-vmess", "protocol": "vmess", "port": 8443, "streamSettings": {
                "network": "ws", "security": "none",
                "wsSettings": {"path": "/ws", "headers": {"Host": "cdn.example.com"}}}},
            {"tag": "in-trojan", "protocol": "trojan", "port": 9443, "streamSettings": {
                "network": "tcp", "security": "tls",
                "tlsSettings": {"serverName": "t.example.com"}}},
        ]);
        let creds = json!([
            {"inbound_tag": "in-vless", "protocol": "vless", "account":
                {"id": "11111111-1111-1111-1111-111111111111", "flow": "xtls-rprx-vision"}},
            {"inbound_tag": "in-vmess", "protocol": "vmess", "account":
                {"id": "22222222-2222-2222-2222-222222222222"}},
            {"inbound_tag": "in-trojan", "protocol": "trojan", "account": {"password": "pw"}},
        ]);
        vec![NodeRow {
            name: "HK 1".into(),
            xray_inbounds: inbounds,
            server_addr: Some("hk.example.com".into()),
            credentials: creds,
        }]
    }

    /// A10: the three renderers' exact output (any change to a client-facing
    /// format must be deliberate), plus UA routing, content types and the
    /// padding bucket.
    #[test]
    fn three_formats_snapshot() {
        let rows = snapshot_rows();

        let (ct, body) = render("Shadowrocket/2.2", &rows);
        assert_eq!(ct, "text/plain; charset=utf-8");
        assert_eq!(body.len(), 8192, "padded to the 8 KiB minimum bucket");
        let links = String::from_utf8(STANDARD.decode(body.trim_end()).unwrap()).unwrap();
        let lines: Vec<&str> = links.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(
            lines[0],
            "vless://11111111-1111-1111-1111-111111111111@hk.example.com:443?type=tcp&security=reality\
             &flow=xtls-rprx-vision&sni=www.apple.com&pbk=PUBKEY&sid=ab12&fp=firefox#HK%201%20%C2%B7%20in-vless"
        );
        let vmess: Value = serde_json::from_slice(
            &STANDARD
                .decode(lines[1].strip_prefix("vmess://").unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            vmess,
            json!({"add": "hk.example.com", "aid": "0", "host": "cdn.example.com",
                   "id": "22222222-2222-2222-2222-222222222222", "net": "ws", "path": "/ws",
                   "port": "8443", "ps": "HK 1 · in-vmess", "scy": "auto", "tls": "",
                   "type": "none", "v": "2"})
        );
        assert_eq!(
            lines[2],
            "trojan://pw@hk.example.com:9443?type=tcp&security=tls&sni=t.example.com#HK%201%20%C2%B7%20in-trojan"
        );

        let (ct, body) = render("clash.meta", &rows);
        assert_eq!(ct, "text/yaml; charset=utf-8");
        assert_eq!(
            body.trim_end(),
            r#"proxies:
  - name: "HK 1 · in-vless"
    type: vless
    server: hk.example.com
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    flow: xtls-rprx-vision
    network: tcp
    tls: true
    servername: www.apple.com
    client-fingerprint: firefox
    reality-opts:
      public-key: PUBKEY
      short-id: ab12
  - name: "HK 1 · in-vmess"
    type: vmess
    server: hk.example.com
    port: 8443
    uuid: 22222222-2222-2222-2222-222222222222
    alterId: 0
    cipher: auto
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: cdn.example.com
  - name: "HK 1 · in-trojan"
    type: trojan
    server: hk.example.com
    port: 9443
    password: pw
    network: tcp
    tls: true
    servername: t.example.com
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - "HK 1 · in-vless"
      - "HK 1 · in-vmess"
      - "HK 1 · in-trojan"
rules:
  - MATCH,PROXY"#
        );

        let (ct, body) = render("sing-box 1.12", &rows);
        assert_eq!(ct, "application/json; charset=utf-8");
        let want = json!({"outbounds": [
            {"flow": "xtls-rprx-vision", "server": "hk.example.com", "server_port": 443,
             "tag": "HK 1 · in-vless",
             "tls": {"enabled": true, "reality": {"enabled": true, "public_key": "PUBKEY", "short_id": "ab12"},
                     "server_name": "www.apple.com", "utls": {"enabled": true, "fingerprint": "firefox"}},
             "type": "vless", "uuid": "11111111-1111-1111-1111-111111111111"},
            {"server": "hk.example.com", "server_port": 8443, "tag": "HK 1 · in-vmess",
             "transport": {"headers": {"Host": "cdn.example.com"}, "path": "/ws", "type": "ws"},
             "type": "vmess", "uuid": "22222222-2222-2222-2222-222222222222"},
            {"password": "pw", "server": "hk.example.com", "server_port": 9443, "tag": "HK 1 · in-trojan",
             "tls": {"enabled": true, "server_name": "t.example.com"}, "type": "trojan"},
            {"tag": "direct", "type": "direct"}]});
        assert_eq!(
            serde_json::from_str::<Value>(body.trim_end()).unwrap(),
            want
        );
    }

    #[test]
    fn ua_routing_and_padding_buckets() {
        for (ua, ct) in [
            ("sing-box/1.9", "application/json; charset=utf-8"),
            ("Stash/2.0", "text/yaml; charset=utf-8"),
            ("mihomo", "text/yaml; charset=utf-8"),
            ("ClashX", "text/yaml; charset=utf-8"),
            ("curl/8", "text/plain; charset=utf-8"),
            ("", "text/plain; charset=utf-8"),
        ] {
            assert_eq!(render(ua, &snapshot_rows()).0, ct, "{ua}");
        }
        assert_eq!(pad("x".into()).len(), 8192);
        assert_eq!(pad("x".repeat(8192)).len(), 8192);
        assert_eq!(pad("x".repeat(8193)).len(), 12288);
    }

    async fn user_with_token(db: &TestDb) -> (Uuid, String) {
        let u = db.user().await;
        let token = generate_token();
        sqlx::query("UPDATE users SET sub_token_hash = $2 WHERE id = $1")
            .bind(u)
            .bind(hash_token(&token))
            .execute(&db.pool)
            .await
            .unwrap();
        (u, token)
    }

    /// M1-10: over either limit the subscription answers the canonical
    /// rejection — the same bytes as a junk URL or an unknown token, no
    /// 429, no quota headers — while other clients/tokens are unaffected.
    #[tokio::test]
    async fn over_limit_is_byte_identical_to_junk() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = AppState::for_test_with(db.pool.clone(), |c| {
            c.sub.rate_per_token = 3;
            c.sub.rate_per_ip = 5;
        })
        .await;
        let (u, token) = user_with_token(&db).await;
        let (u2, token2) = user_with_token(&db).await;
        let a = Client::new(&state, rand_ip());
        let b = Client::new(&state, rand_ip());
        let junk = a.get("/test/definitely-not-here").await.fingerprint();
        assert_eq!(junk.0, StatusCode::NOT_FOUND);
        assert!(junk.1.is_empty() && junk.2.is_empty(), "{junk:?}");
        let unknown = format!("/test/sub/{}", generate_token());
        assert_eq!(b.get(&unknown).await.fingerprint(), junk);
        // Per token (any address): 3 fetches, then the rejection.
        for c in [&a, &b, &a] {
            let r = c.get(&format!("/test/sub/{token}")).await;
            assert_eq!(r.status, StatusCode::OK);
            assert!(r.headers.contains_key("subscription-userinfo"));
        }
        assert_eq!(
            b.get(&format!("/test/sub/{token}")).await.fingerprint(),
            junk
        );
        assert_eq!(
            b.get(&format!("/test/sub/{token2}")).await.status,
            StatusCode::OK
        );
        // Per address: a has made 1 junk + 2 token + ... requests; exhaust it.
        let mut n = 0;
        while a.get(&unknown).await.fingerprint() == junk {
            n += 1;
            if n > 10 {
                break;
            }
            // Keep going until a valid token is refused for this address.
            let r = a.get(&format!("/test/sub/{token2}")).await;
            if r.status != StatusCode::OK {
                assert_eq!(r.fingerprint(), junk);
                break;
            }
        }
        assert_eq!(
            a.get(&format!("/test/sub/{token2}")).await.fingerprint(),
            junk
        );
        // Another address still gets token2.
        let c = Client::new(&state, rand_ip());
        assert_eq!(
            c.get(&format!("/test/sub/{token2}")).await.status,
            StatusCode::OK
        );
        // Implausible tokens never touch Valkey or the database.
        assert_eq!(c.get("/test/sub/short").await.fingerprint(), junk);
        let mut keys = vec![
            format!("akari:rl:sub:user:{u}"),
            format!("akari:rl:sub:user:{u2}"),
        ];
        for cl in [&a, &b, &c] {
            keys.push(format!(
                "akari:rl:sub:ip:{}",
                crate::client_ip::bucket(cl.ip)
            ));
        }
        let _: i64 = state.valkey().del(keys).await.unwrap();
        drop(state);
        db.drop().await;
    }
}
