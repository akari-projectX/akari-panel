use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use rand::Rng;
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
    /// Surge (2026-10-27, subscription templates).
    Surge,
    Surfboard,
}

/// Every output format, by id (the `panel_settings_sub_formats` CHECK;
/// section 5 switches). A later own-client format joins this list.
pub const FORMATS: [&str; 5] = ["clash", "sing-box", "links", "surge", "surfboard"];

impl Format {
    pub fn id(self) -> &'static str {
        match self {
            Format::Clash => "clash",
            Format::SingBox => "sing-box",
            Format::Links => "links",
            Format::Surge => "surge",
            Format::Surfboard => "surfboard",
        }
    }
}

/// The portal's one-click import clients and the format each one imports
/// (the `panel_settings_sub_import_clients` CHECK; SPA `sub-links.ts`).
pub const IMPORT_CLIENTS: [(&str, Format); 7] = [
    ("clash", Format::Clash),
    ("stash", Format::Clash),
    ("shadowrocket", Format::Links),
    ("sing-box", Format::SingBox),
    ("hiddify", Format::Links),
    ("surge", Format::Surge),
    ("surfboard", Format::Surfboard),
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

/// The Akari client (`akari-client/<version> mihomo`, akari-client
/// CLAUDE.md): it runs mihomo, so it gets the Clash profile.
pub const OWN_CLIENT_UA: &str = "akari-client/";

/// Is this the Akari client? A prefix match on the User-Agent: a soft
/// check (any client can send it); the hard one is signing in inside the
/// client (B3, later).
pub fn own_client(user_agent: &str) -> bool {
    user_agent
        .get(..OWN_CLIENT_UA.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(OWN_CLIENT_UA))
}

/// Section 5: the format to answer with, among the enabled ones (`None`
/// = the uniform rejection). The Akari client always gets Clash (the
/// switches are about third-party clients); with `own_client_only` nothing
/// else is answered. An explicit `?format=` that is off, or a recognised
/// client whose format is off, gets nothing; an unrecognised client falls
/// through to the first enabled of links, Clash, sing-box.
pub fn choose_format(
    query: Option<&str>,
    user_agent: &str,
    enabled: &[String],
    own_client_only: bool,
) -> Option<Format> {
    if own_client(user_agent) {
        return Some(Format::Clash);
    }
    if own_client_only {
        return None;
    }
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

/// The third-party formats on: the stored list (NULL = all), none in
/// own-client-only mode (the Akari client is answered either way,
/// `choose_format`).
pub fn third_party_formats(stored: &crate::settings::Stored) -> Vec<String> {
    if stored.sub_own_client_only.unwrap_or(false) {
        return Vec::new();
    }
    stored.sub_formats.clone().unwrap_or_else(all_formats)
}

/// All formats on (the default).
pub fn all_formats() -> Vec<String> {
    FORMATS.iter().map(|f| (*f).to_string()).collect()
}

/// W20: `?format=clash|sing-box|links|surge|surfboard` on the subscription URL picks the
/// format explicitly (the portal's format selector and one-click import
/// links); anything else — no query, other keys, unknown values — falls
/// back to User-Agent detection. Never a rejection: the token alone decides
/// whether the request is answered.
fn requested_format(query: Option<&str>) -> Option<Format> {
    query?.split('&').find_map(|pair| match pair {
        "format=clash" => Some(Format::Clash),
        "format=sing-box" | "format=singbox" => Some(Format::SingBox),
        "format=links" | "format=base64" => Some(Format::Links),
        "format=surge" => Some(Format::Surge),
        "format=surfboard" => Some(Format::Surfboard),
        _ => None,
    })
}

/// W30: the format a recognised client understands, by its User-Agent:
/// - sing-box: the core and the official apps (`SFA/`, `SFI/`, `SFM/`,
///   `SFT/` = sing-box for Android/iOS/macOS/tvOS);
/// - Clash: Clash Verge (Rev), Clash Meta for Android, FlClash, mihomo
///   (Mihomo Party: `mihomo.party/`), Stash (`Stash/... Clash/...`),
///   NekoBox ("Prefer ClashMeta Format");
/// - Surge (`Surge iOS/…`, `Surge Mac/…`) and Surfboard (`Surfboard/…`):
///   their own profile formats (templates);
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
    } else if ua.contains("surfboard") {
        Some(Format::Surfboard)
    } else if ua.contains("surge") {
        Some(Format::Surge)
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
#[derive(Clone, FromRow)]
pub struct NodeRow {
    /// The entrance's id (routing pins lines by it) and its node's
    /// user-facing region (region groups).
    pub entrance_id: Uuid,
    pub region: Option<String>,
    pub name: String,
    /// W11 (`nodemeta.rs`): user-facing name; `tags` are the entrance's (1104).
    pub display_name: Option<String>,
    pub tags: Vec<String>,
    /// The entrance's name ("直连", "IPLC") and the multiplier the proxy
    /// name shows (permille; None = none, the default: names must not
    /// change with the rate, clients remember the selected proxy by name).
    /// With the operator switch (`panel_settings.sub_name_rate`) it is the
    /// entrance's base multiplier, shown when not 1x, never a time-window
    /// rule's.
    pub entrance: String,
    pub name_rate_permille: Option<i32>,
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

mod links;
pub(crate) mod proxy;
pub(crate) mod surge;
pub mod templates;

use links::render_links;
use proxy::collect_proxies;
use templates::{Ctx, Info, TemplateFormat};

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
/// type, padded (`pad`), with the built-in templates. Pure: the benchmarks
/// and the fuzzer use it.
pub fn render(user_agent: &str, rows: &[NodeRow]) -> (&'static str, String) {
    render_for(None, user_agent, rows)
}

/// `render` with the URL's query string (`requested_format`) taking
/// precedence over the User-Agent.
pub fn render_for(
    query: Option<&str>,
    user_agent: &str,
    rows: &[NodeRow],
) -> (&'static str, String) {
    let format = choose_format(query, user_agent, &all_formats(), false).unwrap_or(Format::Links);
    render_as(format, rows)
}

/// One format's body and content type, padded, from the built-in template.
pub fn render_as(format: Format, rows: &[NodeRow]) -> (&'static str, String) {
    let content_type = content_type(format);
    let body = match TemplateFormat::of(format) {
        None => render_links(&collect_proxies(rows)),
        Some(tf) => templates::render_sample_for(tf, tf.default_body(), &collect_proxies(rows))
            .unwrap_or_default(),
    };
    (content_type, pad(body))
}

fn content_type(format: Format) -> &'static str {
    match TemplateFormat::of(format) {
        Some(tf) => tf.content_type(),
        None => "text/plain; charset=utf-8",
    }
}

/// The user's usable entrances (`NodeRow`s) in the operator's order.
pub(crate) async fn load_rows(
    pg: &sqlx::PgPool,
    user_id: Uuid,
    name_rate: bool,
) -> sqlx::Result<Vec<NodeRow>> {
    sqlx::query_as::<_, NodeRow>(sqlx::AssertSqlSafe(format!(
        "SELECT e.id AS entrance_id, n.region, n.name, n.display_name, e.tags, e.name AS entrance, \
         CASE WHEN $2 THEN e.rate_permille END AS name_rate_permille, n.inbound, \
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
    .bind(user_id)
    .bind(name_rate)
    .fetch_all(pg)
    .await
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
    let rows = match load_rows(state.pg(), user.id, state.settings().get().sub_name_rate).await {
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
    // Section 5: a format that is off is the uniform rejection; so is any
    // client but the Akari client in own-client-only mode.
    let Some(format) = choose_format(
        query.as_deref(),
        user_agent,
        &settings.sub_formats,
        settings.sub_own_client_only,
    ) else {
        return reject::not_found();
    };
    let proxies = collect_proxies(&rows);
    let site = settings
        .stored
        .site_name
        .as_deref()
        .unwrap_or(crate::settings::DEFAULT_SITE_NAME);
    let (content_type, body) = match TemplateFormat::of(format) {
        None => (content_type(format), pad(render_links(&proxies))),
        Some(tf) => {
            let link = state.sub_link(user.id, &token);
            let link = format!("{link}?format={}", tf.id());
            let domain = link
                .split_once("://")
                .and_then(|(_, r)| r.split('/').next())
                .unwrap_or_default()
                .to_string();
            let ctx = Ctx {
                subs_link: &link,
                subs_domain: &domain,
                site_name: site,
                info: Info {
                    upload: 0,
                    download: user.traffic_used_bytes,
                    total: user.traffic_limit_bytes.unwrap_or(0),
                    expire: user.expires_at.map_or(0, |t| t.timestamp()),
                },
                format_id: tf.id(),
            };
            let stored = match templates::body_of(state.pg(), tf).await {
                Ok(b) => b,
                Err(e) => {
                    tracing::error!(error = %e, "subscription db error");
                    return reject::not_found();
                }
            };
            let rendered = templates::render(tf, &stored, &proxies, &ctx, false).or_else(|e| {
                tracing::error!(format = tf.id(), error = %e.message, "stored subscription template unusable; using the built-in one");
                templates::render(tf, tf.default_body(), &proxies, &ctx, false)
            });
            match rendered {
                Ok(b) => (tf.content_type(), pad(b)),
                Err(e) => {
                    tracing::error!(format = tf.id(), error = %e.message, "built-in subscription template failed");
                    return reject::not_found();
                }
            }
        }
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
            // The body carries the user's node credentials: a shared cache
            // (a "cache everything" CDN rule) must not keep it.
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, no-store"),
            ),
            (header::CONTENT_DISPOSITION, disposition(site)),
            (
                header::HeaderName::from_static("profile-title"),
                profile_title(site),
            ),
        ],
        body,
    )
        .into_response()
}

/// `Content-Disposition` naming the profile after the site (站点名称):
/// `filename*` (RFC 5987) carries the exact name, the plain `filename` an
/// ASCII token for clients that read only that (never a quoted string: some
/// clients keep the quotes and show `"akari"` as the profile name).
fn disposition(site: &str) -> HeaderValue {
    let token: String = site
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    let token = if token.is_empty() {
        "akari".into()
    } else {
        token
    };
    let mut enc = String::new();
    for b in site.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                enc.push(b as char)
            }
            _ => enc.push_str(&format!("%{b:02X}")),
        }
    }
    HeaderValue::from_str(&format!(
        "attachment; filename={token}; filename*=UTF-8''{enc}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=akari"))
}

/// `Profile-Title: base64:<name>` (Hiddify, v2rayN and other clients that
/// read it; base64 keeps non-ASCII names intact).
fn profile_title(site: &str) -> HeaderValue {
    use base64::Engine as _;
    HeaderValue::from_str(&format!(
        "base64:{}",
        base64::engine::general_purpose::STANDARD.encode(site)
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("base64:QWthcmk="))
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
    use super::proxy::{Proxy, collect_proxies, net_from_inbound};
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

    /// The built-in Clash template rendered for `proxies`.
    fn render_clash_default(proxies: &[Proxy]) -> String {
        templates::render_sample_for(
            TemplateFormat::Clash,
            TemplateFormat::Clash.default_body(),
            proxies,
        )
        .unwrap()
    }

    /// The proxies of a rendered Clash profile as JSON values.
    fn clash_proxies(yaml: &str) -> Vec<Value> {
        let doc: Value = serde_saphyr::from_str(yaml).unwrap();
        doc["proxies"].as_array().unwrap().clone()
    }

    fn render_sing_box_default(proxies: &[Proxy]) -> Value {
        serde_json::from_str(
            &templates::render_sample_for(
                TemplateFormat::SingBox,
                TemplateFormat::SingBox.default_body(),
                proxies,
            )
            .unwrap(),
        )
        .unwrap()
    }

    /// A sing-box outbound by tag (the template's groups come first).
    fn outbound<'a>(profile: &'a Value, tag: &str) -> &'a Value {
        profile["outbounds"]
            .as_array()
            .and_then(|o| o.iter().find(|o| o["tag"] == tag))
            .unwrap_or_else(|| panic!("no outbound {tag}"))
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
                render_clash_default(&p)
                    .contains(&format!("    client-fingerprint: {want}\n"))
            );
            let sb = render_sing_box_default(&p);
            let ob = outbound(&sb, "n");
            assert_eq!(ob["tls"]["utls"]["fingerprint"], want);
            assert_eq!(ob["tls"]["utls"]["enabled"], true);
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
        assert!(!render_clash_default(&p).contains("client-fingerprint"));
        let sb = render_sing_box_default(&p);
        assert!(outbound(&sb, "n").get("tls").is_none());
    }

    /// One row per (inbound, credential) pair: a node `name` per inbound
    /// (D2), its entrance named after the inbound's tag, at `server`.
    pub(crate) fn rows_of(
        name: &str,
        server: Option<&str>,
        inbounds: &Value,
        creds: &Value,
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
                entrance_id: Uuid::from_u128(rows.len() as u128 + 1),
                region: None,
                name: name.into(),
                display_name: None,
                tags: vec![],
                entrance: tag.into(),
                name_rate_permille: None,
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
        rows_of("HK 1", Some("hk.example.com"), &inbounds, &creds)
    }

    /// Section 5: which format answers, among the enabled ones.
    #[test]
    fn format_switches() {
        let on = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let all = all_formats();
        assert_eq!(
            choose_format(None, "clash-verge/v2", &all, false),
            Some(Format::Clash)
        );
        assert_eq!(
            choose_format(None, "curl", &all, false),
            Some(Format::Links)
        );
        let clash = on(&["clash"]);
        assert_eq!(
            choose_format(None, "clash-verge/v2", &clash, false),
            Some(Format::Clash)
        );
        assert_eq!(
            choose_format(None, "curl", &clash, false),
            Some(Format::Clash),
            "falls through"
        );
        assert_eq!(
            choose_format(None, "v2rayN/7", &clash, false),
            None,
            "recognised: no fallback"
        );
        assert_eq!(choose_format(None, "SFA/1.12", &clash, false), None);
        assert_eq!(
            choose_format(Some("format=links"), "clash-verge/v2", &clash, false),
            None
        );
        assert_eq!(
            choose_format(Some("x=1"), "curl", &on(&["sing-box"]), false),
            Some(Format::SingBox)
        );
        assert_eq!(choose_format(None, "curl", &[], false), None);
        // The Akari client: always Clash, also with every format off; in
        // own-client-only mode nothing else answers, whatever the query.
        for ua in ["akari-client/0.1.0 mihomo", "Akari-Client/1"] {
            assert_eq!(choose_format(None, ua, &[], false), Some(Format::Clash));
            assert_eq!(choose_format(None, ua, &all, true), Some(Format::Clash));
            assert_eq!(
                choose_format(Some("format=links"), ua, &[], true),
                Some(Format::Clash)
            );
        }
        for ua in [
            "clash-verge/v2",
            "mihomo/1.19",
            "curl",
            "",
            "x akari-client/1",
            "akari-client",
        ] {
            assert_eq!(choose_format(None, ua, &all, true), None, "{ua}");
            assert_eq!(choose_format(Some("format=clash"), ua, &all, true), None);
        }
        assert_eq!(
            import_clients(None, &all),
            ["clash", "stash", "shadowrocket", "sing-box", "hiddify", "surge", "surfboard"]
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
             &flow=xtls-rprx-vision&sni=www.apple.com&pbk=PUBKEY&sid=ab12&fp=firefox#in-vless"
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
                   "port": "8443", "ps": "in-vmess", "scy": "auto", "sni": "", "tls": "",
                   "type": "none", "v": "2"})
        );
        assert_eq!(
            lines[2],
            "trojan://pw@hk.example.com:9443?type=tcp&security=tls&sni=t.example.com#in-trojan"
        );

        let (ct, body) = render("clash.meta", &rows);
        assert_eq!(ct, "text/yaml; charset=utf-8");
        // The built-in template: its DNS first, the proxies injected where
        // the template has `proxies:`, groups expanded, rules last.
        let body = body.trim_end();
        assert!(body.starts_with("# Akari") || body.starts_with("mixed-port:"), "{body}");
        let ps = clash_proxies(body);
        assert_eq!(
            ps,
            [
                json!({"name": "in-vless", "type": "vless", "server": "hk.example.com", "port": 443,
                    "uuid": "11111111-1111-1111-1111-111111111111", "flow": "xtls-rprx-vision",
                    "network": "tcp", "tls": true, "servername": "www.apple.com",
                    "client-fingerprint": "firefox",
                    "reality-opts": {"public-key": "PUBKEY", "short-id": "ab12"}}),
                json!({"name": "in-vmess", "type": "vmess", "server": "hk.example.com", "port": 8443,
                    "uuid": "22222222-2222-2222-2222-222222222222", "alterId": 0, "cipher": "auto",
                    "network": "ws", "ws-opts": {"path": "/ws", "headers": {"Host": "cdn.example.com"}}}),
                json!({"name": "in-trojan", "type": "trojan", "server": "hk.example.com", "port": 9443,
                    "password": "pw", "network": "tcp", "tls": true, "sni": "t.example.com"}),
            ]
        );
        let doc: Value = serde_saphyr::from_str(body).unwrap();
        let group = |n: &str| doc["proxy-groups"].as_array().unwrap().iter().find(|g| g["name"] == n).unwrap().clone();
        assert_eq!(
            group("🚀 默认代理")["proxies"],
            json!(["♻️ 自动选择", "🇭🇰 香港", "🇯🇵 日本", "🇺🇸 美国", "🇸🇬 新加坡", "🇹🇼 台湾", "in-vless", "in-vmess", "in-trojan", "DIRECT"])
        );
        assert_eq!(group("🇭🇰 香港")["filter"], "(?i)港|hk|hong");
        assert!(group("🇭🇰 香港").get("proxies").is_none(), "include-all groups list nothing");
        for want in [
            "  - RULE-SET,geosite-category-ads-all,REJECT\n  - RULE-SET,geosite-private,DIRECT\n  - RULE-SET,geoip-private,DIRECT,no-resolve\n  - RULE-SET,geosite-cn,DIRECT\n  - RULE-SET,geoip-cn,DIRECT,no-resolve\n  - RULE-SET,geosite-netflix,",
            "nameserver-policy:",
        ] {
            assert!(body.contains(want), "missing:\n{want}\nin:\n{body}");
        }
        assert!(body.ends_with("\n  - MATCH,🚀 默认代理"), "{body}");

        let (ct, body) = render("sing-box 1.12", &rows);
        assert_eq!(ct, "application/json; charset=utf-8");
        let v = serde_json::from_str::<Value>(body.trim_end()).unwrap();
        let all = v["outbounds"].as_array().unwrap();
        let groups = all.iter().take_while(|o| o["type"] == "selector" || o["type"] == "urltest").count();
        // The template's groups, its direct outbound, then the proxies.
        assert_eq!(all[groups], json!({"type": "direct", "tag": "direct"}));
        let want = json!([
            {"flow": "xtls-rprx-vision", "server": "hk.example.com", "server_port": 443,
             "tag": "in-vless",
             "tls": {"enabled": true, "reality": {"enabled": true, "public_key": "PUBKEY", "short_id": "ab12"},
                     "server_name": "www.apple.com", "utls": {"enabled": true, "fingerprint": "firefox"}},
             "type": "vless", "uuid": "11111111-1111-1111-1111-111111111111"},
            {"server": "hk.example.com", "server_port": 8443, "tag": "in-vmess",
             "transport": {"headers": {"Host": "cdn.example.com"}, "path": "/ws", "type": "ws"},
             "type": "vmess", "uuid": "22222222-2222-2222-2222-222222222222"},
            {"password": "pw", "server": "hk.example.com", "server_port": 9443, "tag": "in-trojan",
             "tls": {"enabled": true, "server_name": "t.example.com"}, "type": "trojan"}]);
        assert_eq!(all[groups + 1..], want.as_array().unwrap()[..]);
        assert_eq!(all[0]["tag"], "🚀 默认代理");
        assert_eq!(all[0]["outbounds"].as_array().unwrap()[6..], [json!("in-vless"), json!("in-vmess"), json!("in-trojan"), json!("direct")]);
        // W30: a complete client profile: TUN + local mixed inbound, DNS,
        // the routing, everything else through the default proxy.
        assert_eq!(v["inbounds"][0]["type"], "tun");
        assert_eq!(v["inbounds"][1]["listen"], "127.0.0.1");
        assert_eq!(v["route"]["final"], "🚀 默认代理");
        assert_eq!(v["route"]["rule_set"].as_array().unwrap().len(), 11);
        assert_eq!(
            v["route"]["rules"][2],
            json!({"rule_set": ["geosite-category-ads-all"], "action": "reject"})
        );
        assert_eq!(
            v["dns"]["rules"],
            json!([{"rule_set": ["geosite-private", "geosite-cn"], "server": "local"},
                   {"query_type": ["A", "AAAA"], "server": "fakeip"}])
        );
        assert_eq!(v["experimental"]["cache_file"]["store_fakeip"], true);

        // Surge and Surfboard: the VLESS line is left out, the others written.
        let (ct, body) = render("Surge iOS/3000", &rows);
        assert_eq!(ct, "text/plain; charset=utf-8");
        assert!(body.contains("in-vmess = vmess, hk.example.com, 8443, username=22222222-2222-2222-2222-222222222222, vmess-aead=true, ws=true, ws-path=/ws, ws-headers=Host:cdn.example.com\n"), "{body}");
        assert!(body.contains("in-trojan = trojan, hk.example.com, 9443, password=pw, sni=t.example.com\n"), "{body}");
        assert!(!body.contains("in-vless ="), "{body}");
        let (_, body) = render("Surfboard/2.30", &rows);
        assert!(body.contains("in-trojan = trojan, hk.example.com, 9443, password=pw, udp-relay=true, sni=t.example.com\n"), "{body}");
        assert!(body.contains("in-vmess = vmess, hk.example.com, 8443, username=22222222-2222-2222-2222-222222222222, udp-relay=true, ws=true, ws-path=/ws, ws-headers=Host:cdn.example.com\n"), "{body}");
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
        rows_of("N", Some("n.example.com"), &inbounds, &creds)
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
            &sni=www.apple.com&pbk=PUB&sid=ab&fp=chrome&path=%2Fxh&mode=stream-one#rx"
        );
        assert_eq!(
            l[1],
            "vless://22222222-2222-2222-2222-222222222222@n.example.com:2083?type=httpupgrade&security=tls\
            &sni=n.example.com&path=%2Fup&host=n.example.com#hu"
        );
        assert_eq!(
            l[2],
            "trojan://tp@n.example.com:2087?type=grpc&security=tls&sni=n.example.com\
            &serviceName=svc&mode=gun#gr"
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
            @n.example.com:8388#ss"
        );
        assert_eq!(
            l[6],
            "hysteria2://a1b2@n.example.com:443/?sni=n.example.com#hy"
        );
        assert_eq!(
            l[7],
            "vless://55555555-5555-5555-5555-555555555555@n.example.com:8443?type=ws&path=%2Fw#ws"
        );
    }

    #[test]
    fn w8_matrix_clash() {
        let (_, body) = render("mihomo/1.19", &matrix_rows());
        let ps = clash_proxies(&body);
        let by = |n: &str| ps.iter().find(|p| p["name"] == n).unwrap_or_else(|| panic!("no {n}"));
        // vmess+xhttp has no mihomo equivalent: left out (and out of the groups).
        assert!(ps.iter().all(|p| p["name"] != "vx"), "{body}");
        assert_eq!(
            by("rx"),
            &json!({"name": "rx", "type": "vless", "server": "n.example.com", "port": 443,
                "uuid": "11111111-1111-1111-1111-111111111111", "network": "xhttp", "tls": true,
                "servername": "www.apple.com", "client-fingerprint": "chrome",
                "reality-opts": {"public-key": "PUB", "short-id": "ab"},
                "xhttp-opts": {"path": "/xh", "mode": "stream-one"}})
        );
        assert_eq!(by("hu")["ws-opts"], json!({"path": "/up", "headers": {"Host": "n.example.com"}, "v2ray-http-upgrade": true}));
        assert_eq!((by("hu")["network"].clone(), by("hu")["servername"].clone()), (json!("ws"), json!("n.example.com")));
        assert_eq!(
            by("gr"),
            &json!({"name": "gr", "type": "trojan", "server": "n.example.com", "port": 2087, "password": "tp",
                "network": "grpc", "tls": true, "sni": "n.example.com", "grpc-opts": {"grpc-service-name": "svc"}})
        );
        assert_eq!(
            by("vg"),
            &json!({"name": "vg", "type": "vmess", "server": "n.example.com", "port": 2096,
                "uuid": "33333333-3333-3333-3333-333333333333", "alterId": 0, "cipher": "auto",
                "network": "grpc", "grpc-opts": {"grpc-service-name": "vs"}})
        );
        assert_eq!(
            by("ss"),
            &json!({"name": "ss", "type": "ss", "server": "n.example.com", "port": 8388,
                "cipher": "2022-blake3-aes-128-gcm", "password": "+/+/+/+/+/+/+/+/+/+/+w==:dXNlcmtleXVzZXJrZXkxMg==", "udp": true})
        );
        assert_eq!(
            by("hy"),
            &json!({"name": "hy", "type": "hysteria2", "server": "n.example.com", "port": 443,
                "password": "a1b2", "sni": "n.example.com", "alpn": ["h3"]})
        );
        assert_eq!(by("ws")["uuid"], "55555555-5555-5555-5555-555555555555");
        assert_eq!(by("ws")["ws-opts"], json!({"path": "/w"}));
        assert!(!body.contains("flow:"), "stale vision flow rendered: {body}");
        // Every proxy is in the default and the automatic group.
        let doc: Value = serde_saphyr::from_str(&body).unwrap();
        let groups = doc["proxy-groups"].as_array().unwrap();
        for name in ["rx", "hu", "gr", "vg", "ss", "hy", "ws"] {
            let n = groups
                .iter()
                .filter(|g| g["proxies"].as_array().is_some_and(|m| m.iter().any(|x| x == name)))
                .count();
            assert!(n >= 2, "{name} is in {n} groups");
        }
    }

    #[test]
    fn w8_matrix_sing_box() {
        let (_, body) = render("sing-box/1.12", &matrix_rows());
        let v: Value = serde_json::from_str(body.trim_end()).unwrap();
        let all = v["outbounds"].as_array().unwrap();
        // The template's groups come first, the proxies after them.
        let groups = all.iter().take_while(|o| o["type"] == "selector" || o["type"] == "urltest").count();
        assert_eq!(
            all[0]["outbounds"],
            json!(["♻️ 自动选择", "🇭🇰 香港", "🇯🇵 日本", "🇺🇸 美国", "🇸🇬 新加坡", "🇹🇼 台湾", "hu", "gr", "vg", "ss", "hy", "ws", "direct"])
        );
        let ob = &all[groups..];
        let tags: Vec<&str> = ob.iter().filter_map(|o| o["tag"].as_str()).collect();
        // Both xhttp proxies are left out (sing-box has no xhttp); the
        // template's own direct outbound sits before the proxies.
        assert_eq!(tags, ["direct", "hu", "gr", "vg", "ss", "hy", "ws"]);
        let ob = &ob[1..];
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
            json!({"tag": "ss", "type": "shadowsocks", "server": "n.example.com", "server_port": 8388,
            "method": "2022-blake3-aes-128-gcm", "password": "+/+/+/+/+/+/+/+/+/+/+w==:dXNlcmtleXVzZXJrZXkxMg=="})
        );
        assert_eq!(
            ob[4],
            json!({"tag": "hy", "type": "hysteria2", "server": "n.example.com", "server_port": 443,
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
        rows[2].name_rate_permille = Some(2000);
        let single = |name: &str, server: Option<&str>| NodeRow {
            entrance_id: Uuid::nil(),
            region: None,
            name: name.into(),
            display_name: Some("东京".into()),
            tags: vec![],
            entrance: "直连".into(),
            name_rate_permille: None,
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
                "in-vless | IPLC | 0.5x",
                "in-vmess | IPLC | 0.5x",
                "in-trojan | IPLC | 0.5x 2.0x",
                "直连",
                "直连 #2",
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
        let relay = clash_proxies(&clash);
        assert_eq!((relay[2]["server"].as_str(), relay[2]["port"].as_i64()), (Some("relay.example.net"), Some(30443)));
        let (_, links) = render("v2rayN", &rows);
        let links = String::from_utf8(STANDARD.decode(links.trim_end()).unwrap_or_default())
            .unwrap_or(links);
        assert!(links.contains("@relay.example.net:30443"), "{links}");
        let (_, sb) = render("sing-box", &rows);
        assert!(sb.contains("\"server\":\"relay.example.net\""), "{sb}");
        assert!(sb.contains("\"server_port\":30443"), "{sb}");
    }

    fn plain_proxy(protocol: &'static str, server: &str, inbound: &Value) -> Proxy {
        Proxy {
            name: "n".into(),
            protocol,
            id_or_password: "6ba7b810-9dad-11d1-80b4-00c04fd430c8".into(),
            flow: String::new(),
            method: "2022-blake3-aes-128-gcm".into(),
            udp: false,
            server: server.into(),
            net: net_from_inbound(inbound).unwrap(),
        }
    }

    /// Audit P2-1 (defence in depth): rows saved before the save-time
    /// validation, or written by hand, cannot add keys to a Clash document
    /// or parameters to a share link.
    #[test]
    fn hostile_security_strings_stay_inside_their_value() {
        let inbound = json!({
            "port": 443,
            "streamSettings": {"network": "ws", "security": "reality",
                "wsSettings": {"path": "/ws", "host": "[a]"},
                "realitySettings": {
                    "serverNames": ["a.example\n    udp: true\nrules: [x]"],
                    "publicKey": "k: v #c",
                    "shortId": "ab&flow=x"}},
        });
        let p = [plain_proxy("vless", "s.example", &inbound)];
        let clash = render_clash_default(&p);
        let doc: Value = serde_saphyr::from_str(&clash).unwrap();
        // The hostile strings are values, not structure.
        assert_eq!(doc["rules"].as_array().unwrap().last().unwrap(), "MATCH,🚀 默认代理");
        assert!(doc.get("udp").is_none(), "{clash}");
        let px = &clash_proxies(&clash)[0];
        assert_eq!(px["servername"], "a.example\n    udp: true\nrules: [x]");
        assert_eq!(px["reality-opts"]["public-key"], "k: v #c");
        assert_eq!(px["reality-opts"]["short-id"], "ab&flow=x");
        assert_eq!(px["ws-opts"]["headers"]["Host"], "[a]");
        let links = String::from_utf8(STANDARD.decode(render_links(&p)).unwrap()).unwrap();
        assert!(!links.contains("&flow=x"), "{links}");
        assert!(links.contains("sid=ab%26flow%3Dx"), "{links}");
        assert!(links.contains("pbk=k%3A%20v%20%23c"), "{links}");
        assert!(
            links.contains("sni=a.example%0A%20%20%20%20udp%3A%20true"),
            "{links}"
        );
    }

    /// Audit P2-2: an IPv6 literal is bracketed in share-link authorities
    /// (RFC 3986); the Clash document quotes it.
    #[test]
    fn ipv6_servers_are_bracketed_in_links() {
        let tcp = json!({"port": 443, "streamSettings": {"network": "tcp", "security": "tls",
                         "tlsSettings": {"serverName": "n.example.com"}}});
        let ss = json!({"port": 8388});
        let want = |l: &str, prefix: &str| {
            assert!(l.starts_with(prefix), "{l}");
        };
        for protocol in ["vless", "trojan", "hysteria2"] {
            let p = [plain_proxy(protocol, "2001:db8::1", &tcp)];
            let links = String::from_utf8(STANDARD.decode(render_links(&p)).unwrap()).unwrap();
            let at = links.split('@').nth(1).unwrap();
            want(at, "[2001:db8::1]:443");
        }
        let p = [plain_proxy("ss2022", "2001:db8::1", &ss)];
        let links = String::from_utf8(STANDARD.decode(render_links(&p)).unwrap()).unwrap();
        assert!(links.contains("@[2001:db8::1]:8388#"), "{links}");
        // IPv4 and names are untouched.
        let p = [plain_proxy("vless", "203.0.113.7", &tcp)];
        let links = String::from_utf8(STANDARD.decode(render_links(&p)).unwrap()).unwrap();
        assert!(links.contains("@203.0.113.7:443?"), "{links}");
        let p = [plain_proxy("vless", "2001:db8::1", &tcp)];
        let clash = render_clash_default(&p);
        assert_eq!(clash_proxies(&clash)[0]["server"], "2001:db8::1");
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
                render_for(q, ua, &rows).0,
                ct,
                "{q:?} {ua}"
            );
        }
        assert_eq!(
            render_for(Some("format=clash"), "", &rows).1,
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
        let unknown = format!("/sub/{}", generate_token());
        assert_eq!(b.get(&unknown).await.fingerprint(), junk);
        // Per token (any address): 3 fetches, then the rejection.
        for c in [&a, &b, &a] {
            let r = c.get(&format!("/sub/{token}")).await;
            assert_eq!(r.status, StatusCode::OK);
            assert!(r.headers.contains_key("subscription-userinfo"));
            // The profile is named after the site (default "Akari"), with no
            // quoted filename (clients showed it as \"akari\").
            assert_eq!(
                r.headers["content-disposition"],
                "attachment; filename=Akari; filename*=UTF-8''Akari"
            );
            assert_eq!(r.headers["profile-title"], "base64:QWthcmk=");
        }
        assert_eq!(b.get(&format!("/sub/{token}")).await.fingerprint(), junk);
        assert_eq!(
            b.get(&format!("/sub/{token2}")).await.status,
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
            let r = a.get(&format!("/sub/{token2}")).await;
            if r.status != StatusCode::OK {
                assert_eq!(r.fingerprint(), junk);
                break;
            }
        }
        assert_eq!(a.get(&format!("/sub/{token2}")).await.fingerprint(), junk);
        // Another address still gets token2.
        let c = Client::new(&state, rand_ip());
        assert_eq!(
            c.get(&format!("/sub/{token2}")).await.status,
            StatusCode::OK
        );
        // Implausible tokens never touch Valkey or the database.
        assert_eq!(c.get("/sub/short").await.fingerprint(), junk);
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

    #[test]
    fn profile_name_headers_carry_the_site_name() {
        assert_eq!(
            disposition("Akari"),
            "attachment; filename=Akari; filename*=UTF-8''Akari"
        );
        // Non-ASCII: the exact name in filename*, an ASCII token (or
        // "akari") in filename; never a quoted string.
        assert_eq!(
            disposition("星云加速"),
            "attachment; filename=akari; filename*=UTF-8''%E6%98%9F%E4%BA%91%E5%8A%A0%E9%80%9F"
        );
        assert_eq!(
            disposition("My VPN \"1\""),
            "attachment; filename=MyVPN1; filename*=UTF-8''My%20VPN%20%221%22"
        );
        assert!(!disposition("Akari").to_str().unwrap().contains('"'));
        assert_eq!(profile_title("Akari"), "base64:QWthcmk=");
        assert_eq!(profile_title("星云"), "base64:5pif5LqR");
    }
}
