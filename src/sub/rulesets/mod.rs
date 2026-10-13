//! Remote rule-sets of the subscription routing (routing PR 2, migration
//! 1108): the panel downloads every rule-set link the routing names
//! (Clash `.yaml` / `.list` / `.txt`, `parse.rs`), keeps a converted copy
//! per link in `sub_rule_sets` and hosts it for sing-box as a `source`
//! rule-set on the subscription host: `/{sub_path}/rules/<id>.json`
//! (`id` = the first 32 hex digits of SHA-256(link); public, nothing
//! secret; an unknown id is the canonical rejection). Clash profiles keep
//! loading the original link themselves (a classical rule-provider).
//!
//! * **Save** (`PUT /settings/subscription`, admin): every link without a
//!   good copy is downloaded and validated BEFORE anything is written;
//!   one that fails refuses the save (422 with the link and the reason).
//!   Links already held are not downloaded again (the daily refresh
//!   keeps them current), links no longer named are dropped in the same
//!   transaction.
//! * **Check** (`POST /settings/subscription/rule-set/check`, admin,
//!   20/min per admin): the same download and parse, nothing stored or
//!   audited — counts and sample rules for the editor.
//! * **Daily refresh** (`run`, every instance every 5 min; one instance
//!   per round by an advisory try-lock): links checked over a day ago (a
//!   failing one: an hour) are fetched with `If-None-Match` /
//!   `If-Modified-Since`; a failure keeps the last good copy and records
//!   the error (`failing_since`); a list failing for 2 days turns the
//!   job red on 系统状态. Links named by the routing but missing here
//!   (saved before this feature) are picked up the same way.
//! * Downloads go through `fetch.rs` (SSRF guard).

pub mod fetch;
pub mod parse;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;

use super::routing::{self, Config};
use crate::api::ApiJson;
use crate::auth::{ApiError, AuthUser, MaybeClientIp, api_error, bad_request};
use crate::reject;
use crate::state::AppState;
use crate::sysstatus::{Job, Outcome};
use fetch::{FetchError, Fetched, Held, Policy};
use parse::{Counts, Rule};

/// Sample rules in a check answer.
pub const SAMPLE: usize = 20;
/// Hosted lists are cached this long by clients and proxies.
pub const MAX_AGE_SECS: u32 = 3600;
/// Checks per admin per minute.
const CHECKS_PER_MINUTE: i64 = 20;
/// Downloads at once (save and refresh).
const PARALLEL: usize = 4;
/// Every instance tries a refresh round this often.
pub const TICK: Duration = Duration::from_secs(300);
/// Due rows per round.
const ROUND_ROWS: i64 = 64;
const REFRESH_AFTER: &str = "1 day";
const RETRY_AFTER: &str = "1 hour";
/// A list failing this long turns the job red.
pub const BROKEN_AFTER: &str = "2 days";

const LOCK_SQL: &str = "SELECT pg_try_advisory_xact_lock(hashtextextended('akari.sub_rule_sets.' || current_schema(), 0))";

/// The rule-set links the stored routing names (strict path: only
/// objects with `type` = "rule_set" anywhere in it).
const USED_SQL: &str = "SELECT DISTINCT u #>> '{}' AS url FROM panel_settings s, \
     jsonb_path_query(s.sub_routing, 'strict $.** ? (@.type == \"rule_set\").value') u \
     WHERE s.id = 1 AND jsonb_typeof(u) = 'string'";

/// The hosted name of a link.
pub fn id_of(url: &str) -> String {
    hex::encode(Sha256::digest(url.as_bytes()))[..32].to_string()
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A downloaded, parsed and converted list.
#[derive(Debug, Clone)]
pub struct Converted {
    pub url: String,
    pub id: String,
    /// The hosted sing-box source rule-set (JSON text) and its ETag.
    pub body: String,
    pub etag: String,
    pub counts: Counts,
    /// Kept rules (the sample source).
    pub rules: Vec<Rule>,
    pub upstream_etag: Option<String>,
    pub upstream_last_modified: Option<String>,
}

/// Why a link cannot be used (the admin's error, also stored as text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    Fetch(FetchError),
    Refused(parse::Refused),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Fetch(e) => e.fmt(f),
            Failure::Refused(r) => r.fmt(f),
        }
    }
}

impl Failure {
    /// The coded API error for `url`.
    pub fn api(&self, url: &str) -> ApiError {
        let url = url.to_string();
        match self {
            Failure::Fetch(FetchError::Blocked) => api_error!(
                UNPROCESSABLE_ENTITY,
                "settings.sub_rule_set_blocked",
                "rule-set {url}: the address is not public",
                url = url
            ),
            Failure::Fetch(FetchError::TooLarge) => api_error!(
                UNPROCESSABLE_ENTITY,
                "settings.sub_rule_set_too_large",
                "rule-set {url}: larger than {max_mib} MiB",
                url = url,
                max_mib = fetch::MAX_BYTES >> 20
            ),
            Failure::Fetch(FetchError::Failed(d)) => api_error!(
                UNPROCESSABLE_ENTITY,
                "settings.sub_rule_set_fetch_failed",
                "rule-set {url}: {detail}",
                url = url,
                detail = d.clone()
            ),
            Failure::Refused(r) => api_error!(
                UNPROCESSABLE_ENTITY,
                "settings.sub_rule_set_invalid",
                "rule-set {url}: {detail}",
                url = url,
                detail = r.to_string()
            ),
        }
    }
}

/// What a download produced.
#[derive(Debug)]
pub enum Download {
    Fresh(Box<Converted>),
    /// 304 on a conditional request: the held copy is current.
    Unchanged,
}

/// Parse and convert a downloaded list (pure).
pub fn convert(
    url: &str,
    text: &str,
    upstream_etag: Option<String>,
    upstream_last_modified: Option<String>,
) -> Result<Converted, parse::Refused> {
    let p = parse::parse(text);
    parse::check(&p)?;
    let body = parse::source_json(&p.rules).to_string();
    let etag = hex::encode(Sha256::digest(body.as_bytes()))[..32].to_string();
    Ok(Converted {
        url: url.to_string(),
        id: id_of(url),
        body,
        etag,
        counts: p.counts,
        rules: p.rules,
        upstream_etag,
        upstream_last_modified,
    })
}

/// Download `url` (conditionally when `held` has validators) and convert.
pub async fn download(url: &str, policy: Policy, held: &Held) -> Result<Download, Failure> {
    let conditional = held.etag.is_some() || held.last_modified.is_some();
    match fetch::fetch(url, policy, held)
        .await
        .map_err(Failure::Fetch)?
    {
        Fetched::NotModified if conditional => Ok(Download::Unchanged),
        Fetched::NotModified => Err(Failure::Fetch(FetchError::Failed(
            "HTTP 304 without a conditional request".into(),
        ))),
        Fetched::Body {
            text,
            etag,
            last_modified,
        } => convert(url, &text, etag, last_modified)
            .map(|c| Download::Fresh(Box::new(c)))
            .map_err(Failure::Refused),
    }
}

/// The fetch policy of this instance (`Limits::rule_set_fetch_loopback`:
/// tests only).
pub fn policy(state: &AppState) -> Policy {
    Policy {
        loopback_http: state.cfg().limits.rule_set_fetch_loopback,
    }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Store (or replace) a good copy, only while the stored routing names the
/// link (a refresh racing a save that dropped it never brings it back).
pub async fn apply_store(conn: &mut PgConnection, c: &Converted) -> sqlx::Result<()> {
    let counts = serde_json::to_value(&c.counts).unwrap_or(Value::Null);
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO sub_rule_sets (id, url, body, etag, counts, kept, upstream_etag, \
           upstream_last_modified, fetched_at, checked_at) \
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, now(), now() \
         WHERE $2 IN ({USED_SQL}) \
         ON CONFLICT (url) DO UPDATE SET body = EXCLUDED.body, etag = EXCLUDED.etag, \
           counts = EXCLUDED.counts, kept = EXCLUDED.kept, \
           upstream_etag = EXCLUDED.upstream_etag, \
           upstream_last_modified = EXCLUDED.upstream_last_modified, \
           fetched_at = now(), checked_at = now(), last_error = NULL, failing_since = NULL"
    )))
    .bind(&c.id)
    .bind(&c.url)
    .bind(&c.body)
    .bind(&c.etag)
    .bind(counts)
    .bind(i32::try_from(c.counts.kept()).unwrap_or(i32::MAX))
    .bind(&c.upstream_etag)
    .bind(&c.upstream_last_modified)
    .execute(&mut *conn)
    .await
    .map(|_| ())
}

/// The held copy is current (304).
async fn store_unchanged(conn: &mut PgConnection, url: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE sub_rule_sets SET fetched_at = now(), checked_at = now(), last_error = NULL, \
         failing_since = NULL WHERE url = $1 AND body IS NOT NULL",
    )
    .bind(url)
    .execute(&mut *conn)
    .await
    .map(|_| ())
}

/// A failed refresh: the last good copy stays, the error is recorded.
async fn store_failure(conn: &mut PgConnection, url: &str, error: &str) -> sqlx::Result<()> {
    let error: String = error.chars().take(300).collect();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO sub_rule_sets (id, url, checked_at, last_error, failing_since) \
         SELECT $1, $2, now(), $3, now() WHERE $2 IN ({USED_SQL}) \
         ON CONFLICT (url) DO UPDATE SET checked_at = now(), last_error = EXCLUDED.last_error, \
           failing_since = coalesce(sub_rule_sets.failing_since, now())"
    )))
    .bind(id_of(url))
    .bind(url)
    .bind(error)
    .execute(&mut *conn)
    .await
    .map(|_| ())
}

/// Drop the copies of links the stored routing no longer names (one
/// statement: a save committed meanwhile is never undone).
pub async fn apply_prune(conn: &mut PgConnection) -> sqlx::Result<u64> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DELETE FROM sub_rule_sets WHERE url NOT IN ({USED_SQL})"
    )))
    .execute(&mut *conn)
    .await
    .map(|r| r.rows_affected())
}

/// Download, concurrently, every link of `urls` (stop at the first
/// failure: the caller refuses the whole save).
async fn download_all(urls: Vec<String>, policy: Policy) -> Result<Vec<Converted>, ApiError> {
    let mut out = Vec::new();
    for chunk in urls.chunks(PARALLEL) {
        let mut set = tokio::task::JoinSet::new();
        for (i, url) in chunk.iter().enumerate() {
            let url = url.clone();
            set.spawn(async move { (i, download(&url, policy, &Held::default()).await, url) });
        }
        let mut done: Vec<(usize, Converted)> = Vec::new();
        while let Some(r) = set.join_next().await {
            let (i, res, url) = r.map_err(anyhow::Error::from)?;
            match res {
                Ok(Download::Fresh(c)) => done.push((i, *c)),
                Ok(Download::Unchanged) => {
                    return Err(Failure::Fetch(FetchError::Failed("HTTP 304".into())).api(&url));
                }
                Err(f) => return Err(f.api(&url)),
            }
        }
        done.sort_by_key(|(i, _)| *i);
        out.extend(done.into_iter().map(|(_, c)| c));
    }
    Ok(out)
}

/// Save path, before any lock: download every link of `config` that has no
/// good copy yet. Any failure = the coded 422 (nothing is saved).
pub async fn fetch_new(state: &AppState, config: &Config) -> Result<Vec<Converted>, ApiError> {
    let urls = config.rule_set_urls();
    if urls.is_empty() {
        return Ok(Vec::new());
    }
    let have: Vec<String> = sqlx::query_scalar(
        "SELECT url FROM sub_rule_sets WHERE url = ANY($1) AND body IS NOT NULL",
    )
    .bind(&urls)
    .fetch_all(state.pg())
    .await?;
    let missing: Vec<String> = urls.into_iter().filter(|u| !have.contains(u)).collect();
    download_all(missing, policy(state)).await
}

// ---------------------------------------------------------------------------
// Rendering: which links sing-box profiles reference
// ---------------------------------------------------------------------------

/// The hosted lists a sing-box profile may reference: link → hosted URL.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Hosted {
    urls: HashMap<String, String>,
}

impl Hosted {
    /// `base` = `<subscription origin>/<sub_path>`; `ready` = (link, id) of
    /// the copies with at least one rule sing-box can use.
    pub fn new(base: &str, ready: impl IntoIterator<Item = (String, String)>) -> Self {
        Self {
            urls: ready
                .into_iter()
                .map(|(url, id)| (url, format!("{base}/rules/{id}.json")))
                .collect(),
        }
    }

    pub(crate) fn url_of(&self, link: &str) -> Option<&str> {
        self.urls.get(link).map(String::as_str)
    }
}

/// The hosted lists for `routing` on `base` (`None` = no subscription
/// origin configured: none). A database error = none (logged): the
/// profile then simply leaves the lists out.
pub async fn hosted(state: &AppState, routing: &routing::Routing, base: Option<&str>) -> Hosted {
    let urls = routing.config.rule_set_urls();
    let Some(base) = base else {
        if !urls.is_empty() {
            tracing::info!("no subscription domain: remote rule-sets left out of sing-box");
        }
        return Hosted::default();
    };
    if urls.is_empty() {
        return Hosted::default();
    }
    match sqlx::query_as::<_, (String, String)>(
        "SELECT url, id FROM sub_rule_sets WHERE url = ANY($1) AND body IS NOT NULL AND kept > 0",
    )
    .bind(&urls)
    .fetch_all(state.pg())
    .await
    {
        Ok(rows) => Hosted::new(base, rows),
        Err(e) => {
            tracing::error!(error = %e, "rule-set lookup failed");
            Hosted::default()
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// GET `/{sub_path}/rules/{id}.json` (public, on the subscription hosts):
/// the hosted sing-box source rule-set. Rate limited per client address
/// like subscriptions; unknown / malformed ids and everything else = the
/// canonical rejection.
pub async fn serve(
    State(state): State<AppState>,
    MaybeClientIp(client): MaybeClientIp,
    Path((_, file)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let limits = &state.cfg().limits;
    if let Some(ip) = client {
        let key = format!("akari:rl:subrules:ip:{}", crate::client_ip::bucket(ip));
        if !crate::rate::hit_or_local(
            &state,
            "sub",
            key,
            limits.sub_rate_per_ip,
            limits.sub_rate_window_secs,
        )
        .await
        {
            return reject::not_found();
        }
    }
    let Some(id) = file.strip_suffix(".json").filter(|id| valid_id(id)) else {
        return reject::not_found();
    };
    let row: Option<(String, String)> = match sqlx::query_as(
        "SELECT body, etag FROM sub_rule_sets WHERE id = $1 AND body IS NOT NULL",
    )
    .bind(id)
    .fetch_optional(state.pg())
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "rule-set read failed");
            return reject::not_found();
        }
    };
    let Some((body, etag)) = row else {
        return reject::not_found();
    };
    let etag = format!("\"{etag}\"");
    let cache = format!("public, max-age={MAX_AGE_SECS}");
    let Ok(etag_value) = HeaderValue::from_str(&etag) else {
        return reject::not_found();
    };
    let Ok(cache_value) = HeaderValue::from_str(&cache) else {
        return reject::not_found();
    };
    let matched = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*"));
    if matched {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag_value),
                (header::CACHE_CONTROL, cache_value),
            ],
        )
            .into_response();
    }
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            ),
            (header::ETAG, etag_value),
            (header::CACHE_CONTROL, cache_value),
        ],
        body,
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckReq {
    pub url: String,
}

/// POST /api/v1/settings/subscription/rule-set/check {url} (admin): the
/// download and parse a save would do, without storing anything — counts
/// (total, per type, unsupported for sing-box by type, invalid lines), the
/// first `SAMPLE` rules, the Clash format, the hosted id and the stored
/// copy's state if any. 20 per minute per admin.
pub async fn check(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CheckReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let url = req.url.trim().to_string();
    if !routing::rule_set_url(&url) {
        return Err(bad_request!(
            "settings.sub_rule_set_link_invalid",
            "a rule-set link must be https, without spaces, quotes or a fragment, at most {max} characters",
            max = routing::MAX_URL_CHARS
        ));
    }
    let allowed = crate::rate::hit(
        &state,
        format!("akari:rl:rulecheck:{}", user.id),
        CHECKS_PER_MINUTE,
        60,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "rule-set check rate limit unavailable");
        ApiError::internal()
    })?;
    if !allowed {
        return Err(ApiError::too_many());
    }
    let c = match download(&url, policy(&state), &Held::default()).await {
        Ok(Download::Fresh(c)) => c,
        Ok(Download::Unchanged) => {
            return Err(Failure::Fetch(FetchError::Failed("HTTP 304".into())).api(&url));
        }
        Err(f) => return Err(f.api(&url)),
    };
    let stored = status_of(&state, std::slice::from_ref(&url))
        .await?
        .into_iter()
        .next();
    Ok(Json(json!({
        "url": url,
        "id": c.id,
        "clash_format": routing::clash_format(&url),
        "counts": c.counts,
        "kept": c.counts.kept(),
        "sample": c.rules.iter().take(SAMPLE).collect::<Vec<_>>(),
        "stored": stored,
    })))
}

/// The stored state of a link (the editor shows it next to each link).
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Status {
    pub url: String,
    pub id: String,
    pub counts: Option<Value>,
    pub kept: Option<i32>,
    pub fetched_at: Option<DateTime<Utc>>,
    pub checked_at: DateTime<Utc>,
    pub last_error: Option<String>,
    pub failing_since: Option<DateTime<Utc>>,
}

/// The stored state of `urls` (all stored links when empty).
pub async fn status_of(state: &AppState, urls: &[String]) -> sqlx::Result<Vec<Status>> {
    sqlx::query_as(
        "SELECT url, id, counts, kept, fetched_at, checked_at, last_error, failing_since \
         FROM sub_rule_sets WHERE cardinality($1::text[]) = 0 OR url = ANY($1) ORDER BY url",
    )
    .bind(urls)
    .fetch_all(state.pg())
    .await
}

// ---------------------------------------------------------------------------
// Daily refresh
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct Due {
    url: String,
    upstream_etag: Option<String>,
    upstream_last_modified: Option<String>,
    has_body: bool,
}

/// What one round did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Round {
    pub pruned: u64,
    pub checked: usize,
    pub failed: usize,
    /// Lists failing for over `BROKEN_AFTER`.
    pub broken: i64,
}

/// One refresh round; None = another instance holds the round.
pub async fn round(state: &AppState) -> anyhow::Result<Option<Round>> {
    // The lock transaction only serializes rounds; every write is its own
    // short statement, so a save never waits for a round's downloads.
    let mut lock = state.pg().begin().await?;
    let won: bool = sqlx::query_scalar(LOCK_SQL).fetch_one(&mut *lock).await?;
    if !won {
        return Ok(None);
    }
    let mut conn = state.pg().acquire().await?;
    let mut out = Round {
        pruned: apply_prune(&mut conn).await?,
        ..Round::default()
    };
    let due: Vec<Due> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT u.url, r.upstream_etag, r.upstream_last_modified, r.body IS NOT NULL AS has_body \
         FROM ({USED_SQL}) u LEFT JOIN sub_rule_sets r ON r.url = u.url \
         WHERE r.url IS NULL OR r.checked_at <= now() - interval '{REFRESH_AFTER}' \
            OR (r.last_error IS NOT NULL AND r.checked_at <= now() - interval '{RETRY_AFTER}') \
         ORDER BY r.checked_at NULLS FIRST LIMIT {ROUND_ROWS}"
    )))
    .fetch_all(&mut *conn)
    .await?;
    let policy = policy(state);
    for chunk in due.chunks(PARALLEL) {
        let mut set = tokio::task::JoinSet::new();
        for d in chunk {
            let url = d.url.clone();
            let held = if d.has_body {
                Held {
                    etag: d.upstream_etag.clone(),
                    last_modified: d.upstream_last_modified.clone(),
                }
            } else {
                Held::default()
            };
            set.spawn(async move {
                let ok = routing::rule_set_url(&url);
                let res = if ok {
                    download(&url, policy, &held).await
                } else {
                    Err(Failure::Fetch(FetchError::Failed(
                        "not a valid link".into(),
                    )))
                };
                (url, res)
            });
        }
        while let Some(r) = set.join_next().await {
            let (url, res) = r?;
            out.checked += 1;
            match res {
                Ok(Download::Fresh(c)) => apply_store(&mut conn, &c).await?,
                Ok(Download::Unchanged) => store_unchanged(&mut conn, &url).await?,
                Err(f) => {
                    out.failed += 1;
                    tracing::warn!(id = %id_of(&url), error = %f, "rule-set refresh failed; keeping the last good copy");
                    store_failure(&mut conn, &url, &f.to_string()).await?;
                }
            }
        }
    }
    out.broken = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM sub_rule_sets WHERE failing_since <= now() - interval '{BROKEN_AFTER}'"
    )))
    .fetch_one(&mut *conn)
    .await?;
    drop(conn);
    lock.commit().await?;
    Ok(Some(out))
}

/// Every instance: a refresh round every `TICK` (one instance wins each),
/// recorded on 系统状态 (red while a list has failed for 2 days).
pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let started = Instant::now();
        let st = state.sysstatus();
        match round(&state).await {
            Ok(None) => st.record(Job::RuleSets, started, Outcome::Skipped, None),
            Ok(Some(r)) if r.broken > 0 => st.record(
                Job::RuleSets,
                started,
                Outcome::Error,
                Some(&format!(
                    "{} rule-set list(s) failing for over {BROKEN_AFTER}",
                    r.broken
                )),
            ),
            Ok(Some(_)) => st.record(Job::RuleSets, started, Outcome::Ok, None),
            Err(e) => {
                tracing::warn!(error = %e, "rule-set refresh round failed");
                st.record(Job::RuleSets, started, Outcome::Error, Some(&e.to_string()));
            }
        }
    }
}
