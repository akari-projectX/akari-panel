use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde_json::{Value, json};
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
pub(crate) fn plausible_token(token: &str) -> bool {
    token.len() == TOKEN_LEN
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

// ---------------------------------------------------------------------------
// Subscription rendering
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    SingBox,
    Clash,
    Links,
}

/// Every output format, by id (the `panel_settings_sub_formats` CHECK;
/// section 5 switches). A later own-client format joins this list.
pub const FORMATS: [&str; 3] = ["clash", "sing-box", "links"];

impl Format {
    pub fn id(self) -> &'static str {
        match self {
            Format::Clash => "clash",
            Format::SingBox => "sing-box",
            Format::Links => "links",
        }
    }
}

/// The portal's one-click import clients and the format each one imports
/// (the `panel_settings_sub_import_clients` CHECK; SPA `sub-links.ts`).
pub const IMPORT_CLIENTS: [(&str, Format); 5] = [
    ("clash", Format::Clash),
    ("stash", Format::Clash),
    ("shadowrocket", Format::Links),
    ("sing-box", Format::SingBox),
    ("hiddify", Format::Links),
];

/// The import buttons to show: the configured ones (None = all) whose
/// format is on.
pub fn import_clients(configured: Option<&[String]>, formats: &[String]) -> Vec<String> {
    IMPORT_CLIENTS
        .iter()
        .filter(|(id, f)| {
            configured.is_none_or(|c| c.iter().any(|x| x == id))
                && formats.iter().any(|x| x == f.id())
        })
        .map(|(id, _)| (*id).to_string())
        .collect()
}

/// Section 5: the format to answer with, among the enabled ones (`None`
/// = the uniform rejection). An explicit `?format=` that is off, or a
/// recognised client whose format is off, gets nothing; an unrecognised
/// client falls through to the first enabled of links, Clash, sing-box.
pub fn choose_format(query: Option<&str>, user_agent: &str, enabled: &[String]) -> Option<Format> {
    let on = |f: Format| enabled.iter().any(|x| x == f.id());
    if let Some(f) = requested_format(query) {
        return on(f).then_some(f);
    }
    match known_client(user_agent) {
        Some(f) => on(f).then_some(f),
        None => [Format::Links, Format::Clash, Format::SingBox]
            .into_iter()
            .find(|f| on(*f)),
    }
}

/// All formats on (the default).
pub fn all_formats() -> Vec<String> {
    FORMATS.iter().map(|f| (*f).to_string()).collect()
}

/// W20: `?format=clash|sing-box|links` on the subscription URL picks the
/// format explicitly (the portal's format selector and one-click import
/// links); anything else — no query, other keys, unknown values — falls
/// back to User-Agent detection. Never a rejection: the token alone decides
/// whether the request is answered.
fn requested_format(query: Option<&str>) -> Option<Format> {
    query?.split('&').find_map(|pair| match pair {
        "format=clash" => Some(Format::Clash),
        "format=sing-box" | "format=singbox" => Some(Format::SingBox),
        "format=links" | "format=base64" => Some(Format::Links),
        _ => None,
    })
}

/// W30: the format a recognised client understands, by its User-Agent:
/// - sing-box: the core and the official apps (`SFA/`, `SFI/`, `SFM/`,
///   `SFT/` = sing-box for Android/iOS/macOS/tvOS);
/// - Clash: Clash Verge (Rev), Clash Meta for Android, FlClash, mihomo
///   (Mihomo Party: `mihomo.party/`), Stash (`Stash/... Clash/...`),
///   NekoBox ("Prefer ClashMeta Format");
/// - links (base64 share links): v2rayN/v2rayNG, Shadowrocket, Hiddify
///   (its sing-box core is older than the 1.12 configuration the sing-box
///   format targets; it applies its own routing to imported links).
///
/// None = not recognised (links when on, `choose_format`).
fn known_client(user_agent: &str) -> Option<Format> {
    let ua = user_agent.to_ascii_lowercase();
    let sing_box_app = ["sfa/", "sfi/", "sfm/", "sft/"]
        .iter()
        .any(|p| ua.starts_with(p));
    if ["hiddify", "shadowrocket", "v2ray"]
        .iter()
        .any(|c| ua.contains(c))
    {
        Some(Format::Links)
    } else if ua.contains("sing-box") || sing_box_app {
        Some(Format::SingBox)
    } else if ["clash", "mihomo", "stash"].iter().any(|c| ua.contains(c)) {
        Some(Format::Clash)
    } else {
        None
    }
}

#[derive(FromRow)]
struct SubUser {
    id: Uuid,
    traffic_used_bytes: i64,
    traffic_limit_bytes: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
}

/// One usable entrance of the subscribing user (W28-a: every entrance is
/// its own proxy): the node's public data, the entrance's client-facing
/// address and the user's credential on it (input of `render`).
#[derive(FromRow)]
pub struct NodeRow {
    pub name: String,
    /// W11 (`nodemeta.rs`): user-facing name and tags (proxy names).
    pub display_name: Option<String>,
    pub tags: Vec<String>,
    /// The entrance's name ("直连", "IPLC") and multiplier (permille;
    /// shown in the proxy name when it is not 1x).
    pub entrance: String,
    pub rate_permille: i32,
    /// The node's inbound (xray JSON).
    pub inbound: Value,
    /// What clients dial: the entrance's host (else the server's TLS
    /// domain; none = left out) and port (none = the inbound's).
    pub server: Option<String>,
    pub port: Option<i32>,
    /// The user's account on this entrance.
    pub protocol: String,
    pub account: Value,
}

mod clash;
mod links;
pub(crate) mod proxy;
pub mod routing;
mod singbox;

use clash::render_clash;
use links::render_links;
use proxy::collect_proxies;
use singbox::render_sing_box;

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
/// type, padded (`pad`), with the built-in routing template. Pure: the
/// benchmarks and the fuzzer use it.
pub fn render(user_agent: &str, rows: &[NodeRow]) -> (&'static str, String) {
    render_for(None, user_agent, rows, &routing::Routing::default())
}

/// `render` with the URL's query string (`requested_format`) taking
/// precedence over the User-Agent, and the site's routing template.
pub fn render_for(
    query: Option<&str>,
    user_agent: &str,
    rows: &[NodeRow],
    routing: &routing::Routing,
) -> (&'static str, String) {
    let format = choose_format(query, user_agent, &all_formats()).unwrap_or(Format::Links);
    render_as(format, rows, routing)
}

/// One format's body and content type, padded.
pub fn render_as(
    format: Format,
    rows: &[NodeRow],
    routing: &routing::Routing,
) -> (&'static str, String) {
    let proxies = collect_proxies(rows);
    let body = match format {
        Format::SingBox => render_sing_box(&proxies, routing).to_string(),
        Format::Clash => render_clash(&proxies, routing),
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
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    let limits = &state.cfg().limits;
    if let Some(ip) = client {
        let key = format!("akari:rl:sub:ip:{}", crate::client_ip::bucket(ip));
        if !within_limit(
            &state,
            key,
            limits.sub_rate_per_ip,
            limits.sub_rate_window_secs,
        )
        .await
        {
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
    if !within_limit(
        &state,
        key,
        limits.sub_rate_per_token,
        limits.sub_rate_window_secs,
    )
    .await
    {
        return reject::not_found();
    }
    let rows = match sqlx::query_as::<_, NodeRow>(sqlx::AssertSqlSafe(format!(
        "SELECT n.name, n.display_name, n.tags, e.name AS entrance, \
         akari_entrance_rate(e.id, statement_timestamp()) AS rate_permille, n.inbound, \
         coalesce(e.connect_host, s.tls_domain) AS server, e.connect_port AS port, \
         eu.protocol, eu.account \
         FROM entrance_users eu \
         JOIN entrances e ON e.id = eu.entrance_id AND e.enabled AND e.hidden_since IS NULL \
         JOIN nodes n ON n.id = e.node_id AND n.enabled AND n.visible AND n.inbound IS NOT NULL \
         JOIN servers s ON s.id = n.server_id AND {} \
         JOIN users u ON u.id = eu.user_id AND u.enabled \
         WHERE eu.user_id = $1 \
         ORDER BY n.sort, coalesce(n.display_name, n.name), n.id, e.kind <> 'direct', e.sort, e.name",
        crate::grpc::SERVER_SERVES
    )))
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
    let settings = state.settings().get();
    // Section 5: a format that is off is the uniform rejection.
    let Some(format) = choose_format(query.as_deref(), user_agent, &settings.sub_formats) else {
        return reject::not_found();
    };
    let (content_type, body) = render_as(format, &rows, &settings.sub_routing);

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
    // Valkey unavailable: fail open, bounded by the in-process fallback
    // (W9). Tokens are 256-bit: the limit protects CPU/DB, not secrecy.
    crate::rate::hit_or_local(state, "sub", key, limit, window).await
}

/// Mint a new subscription token for a user (the old one stops working at
/// commit), in the caller's transaction, audited ("user.sub_token.rotate"
/// with no token material). The database keeps its SHA-256 (lookup) and,
/// W20, its ciphertext (`users.sub_token_enc`, `masterkey::Keys::seal_sub_token`)
/// so the owner can see the link again. `None` if the user does not exist.
pub async fn rotate_token(
    conn: &mut sqlx::PgConnection,
    keys: &crate::masterkey::Keys,
    actor: &crate::audit::Actor,
    user_id: Uuid,
) -> anyhow::Result<Option<String>> {
    let token = generate_token();
    let enc = keys.seal_sub_token(user_id, &token)?;
    let n = sqlx::query("UPDATE users SET sub_token_hash = $2, sub_token_enc = $3 WHERE id = $1")
        .bind(user_id)
        .bind(hash_token(&token))
        .bind(&enc)
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

/// "重置订阅" (运营审查高-3; portal `/me/sub-token`, console
/// `/users/{id}/sub-token`): a new subscription token AND a new account on
/// every entrance of the user (`entitle::apply_rotate_user`: the agents
/// drop the old credentials and their live connections), so a leaked or
/// shared link — and every client that already imported it — stops
/// working. In the caller's transaction: `entitle::lock` → nodes → user →
/// credentials; audited `user.sub_token.rotate` + `user.credentials.rotate`.
/// `None` if the user does not exist.
pub async fn apply_reset(
    conn: &mut sqlx::PgConnection,
    keys: &crate::masterkey::Keys,
    actor: &crate::audit::Actor,
    user_id: Uuid,
) -> Result<Option<(String, crate::entitle::Outcome)>, crate::auth::ApiError> {
    crate::entitle::lock(conn).await?;
    let outcome = crate::entitle::apply_rotate_user(conn, user_id).await?;
    let Some(token) = rotate_token(conn, keys, actor, user_id).await? else {
        return Ok(None);
    };
    crate::audit::record(
        conn,
        actor,
        "user.credentials.rotate",
        "user",
        Some(user_id.to_string()),
        None,
        Some(json!({ "entitlement": outcome.summary() })),
    )
    .await?;
    Ok(Some((token, outcome)))
}

/// W20: what the panel can show about an account's subscription link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stored {
    /// The working token (decrypted, and its hash matches the lookup hash).
    Ready(String),
    /// A token works but cannot be shown: issued before 0120 (hash only),
    /// or the ciphertext does not open (data/master.key changed). Only a
    /// reset gives a showable link; it is never rotated implicitly.
    Legacy,
}

#[derive(FromRow)]
struct StoredRow {
    sub_token_hash: Option<String>,
    sub_token_enc: Option<Vec<u8>>,
}

/// W20: the account's subscription token, issuing one if the account has
/// none at all (no working link exists, so nothing is disrupted: audited
/// "user.sub_token.issue" by `actor`). An existing token is never replaced
/// here. `None` if the user does not exist. Runs in the caller's
/// transaction; the conditional UPDATE (`sub_token_hash IS NULL`) makes
/// concurrent first reads issue exactly one token.
pub async fn ensure_token(
    conn: &mut sqlx::PgConnection,
    keys: &crate::masterkey::Keys,
    actor: &crate::audit::Actor,
    user_id: Uuid,
) -> anyhow::Result<Option<Stored>> {
    for _ in 0..2 {
        let Some(row) = sqlx::query_as::<_, StoredRow>(
            "SELECT sub_token_hash, sub_token_enc FROM users WHERE id = $1",
        )
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?
        else {
            return Ok(None);
        };
        match (row.sub_token_hash, row.sub_token_enc) {
            (Some(hash), Some(enc)) => {
                return Ok(Some(match keys.open_sub_token(user_id, &enc) {
                    Some(t) if hash_token(&t) == hash => Stored::Ready(t),
                    _ => {
                        tracing::error!(user = %user_id,
                            "stored subscription token does not open (data/master.key changed?); \
                             the user must reset the link to see it");
                        Stored::Legacy
                    }
                }));
            }
            (Some(_), None) => return Ok(Some(Stored::Legacy)),
            (None, _) => {
                let token = generate_token();
                let enc = keys.seal_sub_token(user_id, &token)?;
                let n = sqlx::query(
                    "UPDATE users SET sub_token_hash = $2, sub_token_enc = $3 \
                     WHERE id = $1 AND sub_token_hash IS NULL",
                )
                .bind(user_id)
                .bind(hash_token(&token))
                .bind(&enc)
                .execute(&mut *conn)
                .await?
                .rows_affected();
                if n == 1 {
                    crate::audit::record(
                        conn,
                        actor,
                        "user.sub_token.issue",
                        "user",
                        Some(user_id.to_string()),
                        None,
                        Some(json!({ "sub_token": crate::audit::CHANGED })),
                    )
                    .await?;
                    return Ok(Some(Stored::Ready(token)));
                }
                // Issued concurrently: read what the other request stored.
            }
        }
    }
    Ok(Some(Stored::Legacy))
}

#[cfg(test)]
mod tests {
    use super::proxy::{Proxy, collect_proxies, net_from_inbound, yaml};
    use super::*;
    use crate::testdb::TestDb;
    use crate::testdb::http::{Client, rand_ip};
    use axum::http::StatusCode;
    use base64::engine::general_purpose::STANDARD;
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
            protocol: "vless",
            id_or_password: "u".into(),
            flow: "xtls-rprx-vision".into(),
            method: String::new(),
            udp: false,
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
            assert!(
                render_clash(&p, &routing::Routing::default())
                    .contains(&format!("    client-fingerprint: {want}\n"))
            );
            let sb = render_sing_box(&p, &routing::Routing::default());
            // [0] is the PROXY selector (W30).
            assert_eq!(sb["outbounds"][1]["tls"]["utls"]["fingerprint"], want);
            assert_eq!(sb["outbounds"][1]["tls"]["utls"]["enabled"], true);
        }
    }

    #[test]
    fn non_reality_has_no_fingerprint() {
        let inbound = json!({"port": 1, "streamSettings": {"network": "tcp"}});
        let p = [Proxy {
            name: "n".into(),
            protocol: "vless",
            id_or_password: "u".into(),
            flow: String::new(),
            method: String::new(),
            udp: false,
            server: "s".into(),
            net: net_from_inbound(&inbound).unwrap(),
        }];
        let links = String::from_utf8(STANDARD.decode(render_links(&p)).unwrap()).unwrap();
        assert!(!links.contains("fp="));
        assert!(!render_clash(&p, &routing::Routing::default()).contains("client-fingerprint"));
        assert!(
            render_sing_box(&p, &routing::Routing::default())["outbounds"][1]
                .get("tls")
                .is_none()
        );
    }

    /// One row per (inbound, credential) pair: a node `name` per inbound
    /// (D2), its entrance named after the inbound's tag, at `server`.
    pub(crate) fn rows_of(
        name: &str,
        server: Option<&str>,
        inbounds: Value,
        creds: Value,
    ) -> Vec<NodeRow> {
        let mut rows = Vec::new();
        for c in creds.as_array().into_iter().flatten() {
            let tag = c["inbound_tag"].as_str().unwrap_or_default();
            let Some(ib) = inbounds
                .as_array()
                .into_iter()
                .flatten()
                .find(|i| i["tag"] == tag)
            else {
                continue;
            };
            rows.push(NodeRow {
                name: name.into(),
                display_name: None,
                tags: vec![],
                entrance: tag.into(),
                rate_permille: 1000,
                inbound: ib.clone(),
                server: server.map(String::from),
                port: None,
                protocol: c["protocol"].as_str().unwrap_or_default().into(),
                account: c["account"].clone(),
            });
        }
        rows
    }

    /// A user on three entrances: a REALITY vless, a websocket vmess and a
    /// TLS trojan (every protocol and transport the renderers branch on).
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
        rows_of("HK 1", Some("hk.example.com"), inbounds, creds)
    }

    /// Section 5: which format answers, among the enabled ones.
    #[test]
    fn format_switches() {
        let on = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let all = all_formats();
        assert_eq!(
            choose_format(None, "clash-verge/v2", &all),
            Some(Format::Clash)
        );
        assert_eq!(choose_format(None, "curl", &all), Some(Format::Links));
        let clash = on(&["clash"]);
        assert_eq!(
            choose_format(None, "clash-verge/v2", &clash),
            Some(Format::Clash)
        );
        assert_eq!(
            choose_format(None, "curl", &clash),
            Some(Format::Clash),
            "falls through"
        );
        assert_eq!(
            choose_format(None, "v2rayN/7", &clash),
            None,
            "recognised: no fallback"
        );
        assert_eq!(choose_format(None, "SFA/1.12", &clash), None);
        assert_eq!(
            choose_format(Some("format=links"), "clash-verge/v2", &clash),
            None
        );
        assert_eq!(
            choose_format(Some("x=1"), "curl", &on(&["sing-box"])),
            Some(Format::SingBox)
        );
        assert_eq!(choose_format(None, "curl", &[]), None);
        assert_eq!(
            import_clients(None, &all),
            ["clash", "stash", "shadowrocket", "sing-box", "hiddify"]
        );
        assert_eq!(
            import_clients(None, &on(&["links"])),
            ["shadowrocket", "hiddify"]
        );
        assert_eq!(
            import_clients(Some(&on(&["stash", "hiddify"])), &on(&["clash"])),
            ["stash"]
        );
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
             &flow=xtls-rprx-vision&sni=www.apple.com&pbk=PUBKEY&sid=ab12&fp=firefox#HK%201%20in-vless"
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
                   "port": "8443", "ps": "HK 1 in-vmess", "scy": "auto", "sni": "", "tls": "",
                   "type": "none", "v": "2"})
        );
        assert_eq!(
            lines[2],
            "trojan://pw@hk.example.com:9443?type=tcp&security=tls&sni=t.example.com#HK%201%20in-trojan"
        );

        let (ct, body) = render("clash.meta", &rows);
        assert_eq!(ct, "text/yaml; charset=utf-8");
        assert_eq!(
            body.trim_end(),
            r#"proxies:
  - name: "HK 1 in-vless"
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
  - name: "HK 1 in-vmess"
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
  - name: "HK 1 in-trojan"
    type: trojan
    server: hk.example.com
    port: 9443
    password: pw
    network: tcp
    tls: true
    sni: t.example.com
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - "HK 1 in-vless"
      - "HK 1 in-vmess"
      - "HK 1 in-trojan"
rule-providers:
  geosite-category-ads-all:
    type: http
    behavior: domain
    format: text
    url: "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/category-ads-all.list"
    interval: 86400
  geosite-private:
    type: http
    behavior: domain
    format: text
    url: "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/private.list"
    interval: 86400
  geoip-private:
    type: http
    behavior: ipcidr
    format: text
    url: "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geoip/private.list"
    interval: 86400
  geosite-cn:
    type: http
    behavior: domain
    format: text
    url: "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/cn.list"
    interval: 86400
  geoip-cn:
    type: http
    behavior: ipcidr
    format: text
    url: "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geoip/cn.list"
    interval: 86400
rules:
  - RULE-SET,geosite-category-ads-all,REJECT
  - RULE-SET,geosite-private,DIRECT
  - RULE-SET,geoip-private,DIRECT,no-resolve
  - RULE-SET,geosite-cn,DIRECT
  - RULE-SET,geoip-cn,DIRECT,no-resolve
  - MATCH,PROXY"#
        );

        let (ct, body) = render("sing-box 1.12", &rows);
        assert_eq!(ct, "application/json; charset=utf-8");
        let want = json!([
            {"type": "selector", "tag": "PROXY",
             "outbounds": ["HK 1 in-vless", "HK 1 in-vmess", "HK 1 in-trojan"]},
            {"flow": "xtls-rprx-vision", "server": "hk.example.com", "server_port": 443,
             "tag": "HK 1 in-vless",
             "tls": {"enabled": true, "reality": {"enabled": true, "public_key": "PUBKEY", "short_id": "ab12"},
                     "server_name": "www.apple.com", "utls": {"enabled": true, "fingerprint": "firefox"}},
             "type": "vless", "uuid": "11111111-1111-1111-1111-111111111111"},
            {"server": "hk.example.com", "server_port": 8443, "tag": "HK 1 in-vmess",
             "transport": {"headers": {"Host": "cdn.example.com"}, "path": "/ws", "type": "ws"},
             "type": "vmess", "uuid": "22222222-2222-2222-2222-222222222222"},
            {"password": "pw", "server": "hk.example.com", "server_port": 9443, "tag": "HK 1 in-trojan",
             "tls": {"enabled": true, "server_name": "t.example.com"}, "type": "trojan"},
            {"tag": "direct", "type": "direct"}]);
        let v = serde_json::from_str::<Value>(body.trim_end()).unwrap();
        assert_eq!(v["outbounds"], want);
        // W30: a complete client profile: TUN + local mixed inbound, DNS,
        // the routing template, everything else through PROXY.
        assert_eq!(v["inbounds"][0]["type"], "tun");
        assert_eq!(v["inbounds"][1]["listen"], "127.0.0.1");
        assert_eq!(v["route"]["final"], "PROXY");
        assert_eq!(v["route"]["rule_set"].as_array().unwrap().len(), 5);
        assert_eq!(
            v["route"]["rules"][2],
            json!({"rule_set": ["geosite-category-ads-all"], "action": "reject"})
        );
        assert_eq!(
            v["dns"]["rules"],
            json!([{"rule_set": ["geosite-private", "geosite-cn"], "server": "local"}])
        );
    }

    /// W8 matrix rows: every new protocol/transport the renderers branch on.
    fn matrix_rows() -> Vec<NodeRow> {
        let inbounds = json!([
            {"tag": "rx", "protocol": "vless", "port": 443, "streamSettings": {
                "network": "xhttp", "security": "reality", "xhttpSettings": {"path": "/xh", "mode": "stream-one"},
                "realitySettings": {"serverNames": ["www.apple.com"], "publicKey": "PUB", "shortId": "ab"}}},
            {"tag": "hu", "protocol": "vless", "port": 2083, "streamSettings": {
                "network": "httpupgrade", "security": "tls", "httpupgradeSettings": {"path": "/up", "host": "n.example.com"},
                "tlsSettings": {"serverName": "n.example.com"}}},
            {"tag": "gr", "protocol": "trojan", "port": 2087, "streamSettings": {
                "network": "grpc", "security": "tls", "grpcSettings": {"serviceName": "svc"},
                "tlsSettings": {"serverName": "n.example.com"}}},
            {"tag": "vg", "protocol": "vmess", "port": 2096, "streamSettings": {
                "network": "grpc", "grpcSettings": {"serviceName": "vs"}}},
            {"tag": "vx", "protocol": "vmess", "port": 8080, "streamSettings": {
                "network": "xhttp", "xhttpSettings": {"path": "/vx"}}},
            {"tag": "ss", "protocol": "shadowsocks", "port": 8388, "settings": {
                "method": "2022-blake3-aes-128-gcm", "password": "+/+/+/+/+/+/+/+/+/+/+w==", "clients": [], "network": "tcp,udp"}},
            {"tag": "hy", "protocol": "hysteria", "port": 443, "settings": {"version": 2},
             "streamSettings": {"network": "hysteria", "security": "tls", "tlsSettings": {"serverName": "n.example.com"},
                                "hysteriaSettings": {"version": 2}}},
            {"tag": "ws", "protocol": "vless", "port": 8443, "streamSettings": {"network": "ws", "wsSettings": {"path": "/w"}}},
        ]);
        let creds = json!([
            {"inbound_tag": "rx", "protocol": "vless", "account": {"id": "11111111-1111-1111-1111-111111111111", "flow": ""}},
            {"inbound_tag": "hu", "protocol": "vless", "account": {"id": "22222222-2222-2222-2222-222222222222", "flow": ""}},
            {"inbound_tag": "gr", "protocol": "trojan", "account": {"password": "tp"}},
            {"inbound_tag": "vg", "protocol": "vmess", "account": {"id": "33333333-3333-3333-3333-333333333333"}},
            {"inbound_tag": "vx", "protocol": "vmess", "account": {"id": "44444444-4444-4444-4444-444444444444"}},
            {"inbound_tag": "ss", "protocol": "shadowsocks", "account": {"password": "dXNlcmtleXVzZXJrZXkxMg=="}},
            {"inbound_tag": "hy", "protocol": "hysteria", "account": {"auth": "a1b2"}},
            // A stale Vision flow on a ws inbound is never rendered.
            {"inbound_tag": "ws", "protocol": "vless", "account": {"id": "55555555-5555-5555-5555-555555555555", "flow": "xtls-rprx-vision"}},
        ]);
        rows_of("N", Some("n.example.com"), inbounds, creds)
    }

    #[test]
    fn w8_matrix_links() {
        let (_, body) = render("v2rayN/7", &matrix_rows());
        let links = String::from_utf8(STANDARD.decode(body.trim_end()).unwrap()).unwrap();
        let l: Vec<&str> = links.lines().collect();
        assert_eq!(l.len(), 8);
        assert_eq!(
            l[0],
            "vless://11111111-1111-1111-1111-111111111111@n.example.com:443?type=xhttp&security=reality\
            &sni=www.apple.com&pbk=PUB&sid=ab&fp=chrome&path=%2Fxh&mode=stream-one#N%20rx"
        );
        assert_eq!(
            l[1],
            "vless://22222222-2222-2222-2222-222222222222@n.example.com:2083?type=httpupgrade&security=tls\
            &sni=n.example.com&path=%2Fup&host=n.example.com#N%20hu"
        );
        assert_eq!(
            l[2],
            "trojan://tp@n.example.com:2087?type=grpc&security=tls&sni=n.example.com\
            &serviceName=svc&mode=gun#N%20gr"
        );
        let vm = |s: &str| -> Value {
            serde_json::from_slice(
                &STANDARD
                    .decode(s.strip_prefix("vmess://").unwrap())
                    .unwrap(),
            )
            .unwrap()
        };
        let g = vm(l[3]);
        assert_eq!(
            (g["net"].as_str(), g["path"].as_str(), g["type"].as_str()),
            (Some("grpc"), Some("vs"), Some("gun"))
        );
        let x = vm(l[4]);
        assert_eq!(
            (x["net"].as_str(), x["path"].as_str(), x["type"].as_str()),
            (Some("xhttp"), Some("/vx"), Some("auto"))
        );
        assert_eq!(
            l[5],
            "ss://2022-blake3-aes-128-gcm:%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2B%2F%2Bw%3D%3D%3AdXNlcmtleXVzZXJrZXkxMg%3D%3D\
            @n.example.com:8388#N%20ss"
        );
        assert_eq!(
            l[6],
            "hysteria2://a1b2@n.example.com:443/?sni=n.example.com#N%20hy"
        );
        assert_eq!(
            l[7],
            "vless://55555555-5555-5555-5555-555555555555@n.example.com:8443?type=ws&path=%2Fw#N%20ws"
        );
    }

    #[test]
    fn w8_matrix_clash() {
        let (_, body) = render("mihomo/1.19", &matrix_rows());
        let y = body.trim_end();
        // vmess+xhttp has no mihomo equivalent: left out (and out of the group).
        assert!(!y.contains("N vx"), "{y}");
        for want in [
            "  - name: \"N rx\"\n    type: vless\n    server: n.example.com\n    port: 443\n    uuid: 11111111-1111-1111-1111-111111111111\n    network: xhttp\n    tls: true\n    servername: www.apple.com\n    client-fingerprint: chrome\n    reality-opts:\n      public-key: PUB\n      short-id: ab\n    xhttp-opts:\n      path: /xh\n      mode: stream-one\n",
            "    network: ws\n    tls: true\n    servername: n.example.com\n    ws-opts:\n      path: /up\n      headers:\n        Host: n.example.com\n      v2ray-http-upgrade: true\n",
            "    type: trojan\n    server: n.example.com\n    port: 2087\n    password: tp\n    network: grpc\n    tls: true\n    sni: n.example.com\n    grpc-opts:\n      grpc-service-name: svc\n",
            "    type: vmess\n    server: n.example.com\n    port: 2096\n    uuid: 33333333-3333-3333-3333-333333333333\n    alterId: 0\n    cipher: auto\n    network: grpc\n    grpc-opts:\n      grpc-service-name: vs\n",
            "  - name: \"N ss\"\n    type: ss\n    server: n.example.com\n    port: 8388\n    cipher: 2022-blake3-aes-128-gcm\n    password: \"+/+/+/+/+/+/+/+/+/+/+w==:dXNlcmtleXVzZXJrZXkxMg==\"\n    udp: true\n",
            "  - name: \"N hy\"\n    type: hysteria2\n    server: n.example.com\n    port: 443\n    password: a1b2\n    sni: n.example.com\n    alpn:\n      - h3\n",
            "    uuid: 55555555-5555-5555-5555-555555555555\n    network: ws\n    ws-opts:\n      path: /w\n",
        ] {
            assert!(y.contains(want), "missing:\n{want}\nin:\n{y}");
        }
        assert!(!y.contains("flow:"), "stale vision flow rendered: {y}");
        // 7 proxies (+ the PROXY group's own "- name:"), all in the group.
        assert_eq!(y.matches("  - name: ").count(), 8);
        assert_eq!(y.matches("      - \"N ").count(), 7);
    }

    #[test]
    fn w8_matrix_sing_box() {
        let (_, body) = render("sing-box/1.12", &matrix_rows());
        let v: Value = serde_json::from_str(body.trim_end()).unwrap();
        // [0] is the PROXY selector (W30) over the proxies.
        let all = v["outbounds"].as_array().unwrap();
        assert_eq!(
            all[0],
            json!({"type": "selector", "tag": "PROXY",
                   "outbounds": ["N hu", "N gr", "N vg", "N ss", "N hy", "N ws"]})
        );
        let ob = &all[1..];
        let tags: Vec<&str> = ob.iter().filter_map(|o| o["tag"].as_str()).collect();
        // Both xhttp proxies are left out (sing-box has no xhttp).
        assert_eq!(
            tags,
            ["N hu", "N gr", "N vg", "N ss", "N hy", "N ws", "direct"]
        );
        assert_eq!(
            ob[0]["transport"],
            json!({"type": "httpupgrade", "path": "/up", "host": "n.example.com"})
        );
        assert_eq!(
            ob[1]["transport"],
            json!({"type": "grpc", "service_name": "svc"})
        );
        assert_eq!(
            ob[2]["transport"],
            json!({"type": "grpc", "service_name": "vs"})
        );
        assert_eq!(
            ob[3],
            json!({"tag": "N ss", "type": "shadowsocks", "server": "n.example.com", "server_port": 8388,
            "method": "2022-blake3-aes-128-gcm", "password": "+/+/+/+/+/+/+/+/+/+/+w==:dXNlcmtleXVzZXJrZXkxMg=="})
        );
        assert_eq!(
            ob[4],
            json!({"tag": "N hy", "type": "hysteria2", "server": "n.example.com", "server_port": 443,
            "password": "a1b2", "tls": {"enabled": true, "server_name": "n.example.com", "alpn": ["h3"]}})
        );
        assert!(ob[5].get("flow").is_none());
    }

    /// W11/W28-a: display name + tags + the entrance name (+ its
    /// multiplier when not 1x) name the proxies; the
    /// entrance's address and port are what clients dial in all three
    /// formats; without any address (no host, no TLS domain) the entrance is
    /// left out; equal names stay unique.
    #[test]
    fn w11_names_and_entrance_addresses() {
        let mut rows = snapshot_rows();
        for r in &mut rows {
            r.display_name = Some("香港 01".into());
            r.tags = vec!["IPLC".into(), "0.5x".into()];
        }
        rows[2].server = Some("relay.example.net".into());
        rows[2].port = Some(30443);
        rows[2].rate_permille = 2000;
        let single = |name: &str, server: Option<&str>| NodeRow {
            name: name.into(),
            display_name: Some("东京".into()),
            tags: vec![],
            entrance: "直连".into(),
            rate_permille: 1000,
            inbound: json!({"protocol": "trojan", "port": 443,
                "streamSettings": {"network": "tcp", "security": "tls",
                    "tlsSettings": {"serverName": "x.example.com"}}}),
            server: server.map(String::from),
            port: None,
            protocol: "trojan".into(),
            account: json!({"password": "p"}),
        };
        rows.push(single("jp-1", Some("jp1.example.com")));
        rows.push(single("jp-2", Some("nat.example.org")));
        rows.push(single("jp-3", None));
        let proxies = collect_proxies(&rows);
        let names: Vec<&str> = proxies.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "香港 01 | IPLC | 0.5x in-vless",
                "香港 01 | IPLC | 0.5x in-vmess",
                "香港 01 | IPLC | 0.5x in-trojan 2.0x",
                "东京 直连",
                "东京 直连 #2",
            ]
        );
        let trojan = &proxies[2];
        assert_eq!(
            (trojan.server.as_str(), trojan.net.port),
            ("relay.example.net", 30443)
        );
        assert_eq!(
            (proxies[0].server.as_str(), proxies[0].net.port),
            ("hk.example.com", 443)
        );
        assert_eq!(proxies[4].server, "nat.example.org");
        assert_eq!(proxies[4].net.port, 443);

        let (_, clash) = render("clash.meta", &rows);
        assert!(
            clash.contains("server: relay.example.net\n    port: 30443\n"),
            "{clash}"
        );
        let (_, links) = render("v2rayN", &rows);
        let links = String::from_utf8(STANDARD.decode(links.trim_end()).unwrap_or_default())
            .unwrap_or(links);
        assert!(links.contains("@relay.example.net:30443"), "{links}");
        let (_, sb) = render("sing-box", &rows);
        assert!(sb.contains("\"server\":\"relay.example.net\""), "{sb}");
        assert!(sb.contains("\"server_port\":30443"), "{sb}");
    }

    #[test]
    fn yaml_scalars() {
        assert_eq!(yaml("/ws"), "/ws");
        assert_eq!(yaml("svc"), "svc");
        assert_eq!(yaml("123"), "\"123\"");
        assert_eq!(yaml("true"), "\"true\"");
        assert_eq!(yaml("a:b"), "\"a:b\"");
        assert_eq!(yaml("-x"), "\"-x\"");
        assert_eq!(yaml(""), "\"\"");
        assert_eq!(yaml("1e5"), "\"1e5\"");
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

    /// W20: `?format=` beats the User-Agent; anything unrecognised falls
    /// back to UA detection (never a rejection).
    #[test]
    fn query_format_overrides_user_agent() {
        let rows = snapshot_rows();
        for (q, ua, ct) in [
            (Some("format=clash"), "curl/8", "text/yaml; charset=utf-8"),
            (
                Some("format=sing-box"),
                "clash.meta",
                "application/json; charset=utf-8",
            ),
            (
                Some("format=singbox"),
                "",
                "application/json; charset=utf-8",
            ),
            (
                Some("x=1&format=links"),
                "mihomo",
                "text/plain; charset=utf-8",
            ),
            (
                Some("format=base64"),
                "sing-box",
                "text/plain; charset=utf-8",
            ),
            (
                Some("format=CLASH"),
                "sing-box",
                "application/json; charset=utf-8",
            ),
            (Some("format=yaml"), "", "text/plain; charset=utf-8"),
            (Some(""), "mihomo", "text/yaml; charset=utf-8"),
            (None, "mihomo", "text/yaml; charset=utf-8"),
        ] {
            assert_eq!(
                render_for(q, ua, &rows, &routing::Routing::default()).0,
                ct,
                "{q:?} {ua}"
            );
        }
        assert_eq!(
            render_for(
                Some("format=clash"),
                "",
                &rows,
                &routing::Routing::default()
            )
            .1,
            render("clash.meta", &rows).1
        );
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
            c.limits.sub_rate_per_token = 3;
            c.limits.sub_rate_per_ip = 5;
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
