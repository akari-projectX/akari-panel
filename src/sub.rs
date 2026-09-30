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
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct NodeRow {
    name: String,
    xray_inbounds: Value,
    server_addr: Option<String>,
    credentials: Value,
}

#[derive(serde::Deserialize)]
struct Credential {
    inbound_tag: String,
    protocol: String,
    account: Value,
}

struct Net {
    port: u16,
    network: String,
    security: String, // none | tls | reality
    sni: String,
    public_key: String,
    short_id: String,
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
    let (public_key, short_id) = if security == "reality" {
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
        )
    } else {
        (String::new(), String::new())
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
        let credentials: Vec<Credential> =
            serde_json::from_value(row.credentials.clone()).unwrap_or_default();
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
            let mut ob = json!({
                "tag": p.name,
                "type": p.protocol,
                "server": p.server,
                "server_port": p.net.port,
            });
            let obj = ob.as_object_mut().unwrap();
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
            ob
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

/// GET /{prefix}/sub/{token} — the client-facing subscription. The token is
/// the credential; no cookie or other auth applies. Any failure (unknown
/// token, disabled or expired user) returns the same empty 404 rejection as everything
/// else, and success headers are only sent on success.
pub async fn subscription(
    State(state): State<AppState>,
    Path((_, token)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let hash = hash_token(&token);

    // Expiry via the shared DB-clock predicate (enforce::EXPIRED).
    let user = match sqlx::query_as::<_, SubUser>(sqlx::AssertSqlSafe(format!(
        "SELECT u.traffic_used_bytes, u.traffic_limit_bytes, u.expires_at \
         FROM users u WHERE u.sub_token_hash = $1 AND u.enabled = true AND NOT {}",
        crate::enforce::EXPIRED
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
    let rows = match sqlx::query_as::<_, NodeRow>(
        "SELECT n.name, n.xray_inbounds, n.server_addr, nu.credentials \
         FROM node_users nu \
         JOIN nodes n ON n.id = nu.node_id AND n.enabled = true \
         JOIN users u ON u.id = nu.user_id AND u.enabled = true \
         WHERE nu.user_id = (SELECT id FROM users WHERE sub_token_hash = $1)",
    )
    .bind(&hash)
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
    let format = detect_format(user_agent);
    let proxies = collect_proxies(&rows);
    let body = match format {
        Format::SingBox => render_sing_box(&proxies).to_string(),
        Format::Clash => render_clash(&proxies),
        Format::Links => render_links(&proxies),
    };
    let body = pad(body);

    let content_type = match format {
        Format::SingBox => "application/json; charset=utf-8",
        Format::Clash => "text/yaml; charset=utf-8",
        Format::Links => "text/plain; charset=utf-8",
    };

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

/// Admin-side helper: mint a subscription token for a user, store only its
/// hash. The plaintext is shown exactly once, to the admin.
pub async fn issue_token_for(state: &AppState, user_id: Uuid) -> anyhow::Result<String> {
    let token = generate_token();
    sqlx::query("UPDATE users SET sub_token_hash = $2 WHERE id = $1")
        .bind(user_id)
        .bind(hash_token(&token))
        .execute(state.pg())
        .await?;
    Ok(token)
}
