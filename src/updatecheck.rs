//! One-click agent update check: fetch the latest akari-agent release from
//! GitHub (or a configured compatible source), verify it and store it
//! exactly like a manual upload (`updates::apply_create_release` +
//! `updates::apply_store_binary`, manifest bytes verbatim). The manual
//! three-file upload stays as the advanced path.
//!
//! Trust is unchanged: agents verify every manifest under the keys compiled
//! into them; the panel checks the signature under its trusted keys (compiled-in
//! official keys + 系统设置 → 安全's extra keys)
//! (and, here, the sha256 against the release's SHA256SUMS and the platform)
//! before anything is stored. Nothing here ever starts a rollout.
//!
//! Safety:
//! * outbound HTTPS only, to the configured source host (plus GitHub's
//!   download hosts when the source is api.github.com, where asset
//!   downloads redirect); plain http only to loopback (tests, local
//!   mirrors); at most `MAX_REDIRECTS` redirects, each re-checked;
//! * every response is size-capped (release JSON 1 MiB, manifest 4 KiB,
//!   signature 16 KiB, SHA256SUMS 64 KiB, binary = the signed manifest's
//!   size), requests time out, a stalled download is dropped, the whole
//!   check is bounded by `CHECK_TIMEOUT`;
//! * no downgrade: a source whose latest version is older than the newest
//!   stored release is refused, and rollback manifests are refused (they
//!   stay a deliberate manual upload);
//! * all platforms are stored in ONE transaction: any failure stores
//!   nothing; the outcome (success or the coded error) is recorded in
//!   `agent_update_settings.last_check_*` and audited
//!   (`agent_update.check`);
//! * multi-instance: the check holds a transaction-level advisory lock for
//!   its whole run (the storing transaction itself), so two instances never
//!   fetch concurrently; the 6-hourly auto check is claimed by one instance
//!   with a conditional UPDATE.
//!
//! Settings live in `agent_update_settings` (0150; no panel.toml key, R39),
//! read on every request and tick.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use http_body_util::{BodyExt, Empty, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, Postgres, Transaction};

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{api_error, bad_request, conflict, ApiError, AuthUser};
use crate::state::AppState;
use crate::updates::{self, CreateReleaseReq, SigFile};

/// The project's own releases.
pub const DEFAULT_SOURCE: &str =
    "https://api.github.com/repos/akari-projectX/akari-agent/releases/latest";
/// Platforms fetched by a check (the agent's `make dist` set).
pub const ARCHES: [&str; 2] = ["amd64", "arm64"];
/// Where api.github.com's asset downloads redirect to.
const GITHUB_DOWNLOAD_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
const AUTO_EVERY: &str = "6 hours";
const AUTO_TICK: Duration = Duration::from_secs(300);
const META_MAX: usize = 1 << 20;
const SIG_MAX: usize = 16 << 10;
const SUMS_MAX: usize = 64 << 10;
const MAX_ASSETS: usize = 200;
const MAX_REDIRECTS: usize = 5;
/// Connect + response head of any request, and the body of small ones.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// A binary download with no data for this long is dropped.
const STALL: Duration = Duration::from_secs(60);
/// The whole check (both platforms).
const CHECK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// `check_started_at` older than this is a check that died with its
/// instance (> CHECK_TIMEOUT).
const RUNNING_FOR: &str = "20 minutes";

// ---------------------------------------------------------------------------
// Source URL policy and the HTTP client
// ---------------------------------------------------------------------------

struct Target {
    tls: bool,
    host: String,
    port: u16,
    authority: String,
    path: String,
}

fn host_is_loopback(host: &str) -> bool {
    crate::billing::http::is_loopback_host(host)
}

/// Parses an absolute http(s) URL: https, or http to a loopback host; no
/// user info, no fragment.
fn target(url: &str) -> Result<Target, String> {
    if url.len() > 2048 || url.contains('#') || url.chars().any(|c| c.is_ascii_control()) {
        return Err("not a plain URL".into());
    }
    let uri: hyper::Uri = url.parse().map_err(|_| "not a URL".to_string())?;
    let auth = uri.authority().ok_or("URL without host")?;
    if auth.as_str().contains('@') {
        return Err("URL must not carry credentials".into());
    }
    let host = auth.host().to_ascii_lowercase();
    if host.is_empty() {
        return Err("URL without host".into());
    }
    let tls = match uri.scheme_str() {
        Some("https") => true,
        Some("http") if host_is_loopback(&host) => false,
        _ => return Err("URL must be https".into()),
    };
    let port = auth.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let path = uri
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    Ok(Target {
        tls,
        authority: auth.as_str().to_ascii_lowercase(),
        host,
        port,
        path,
    })
}

/// Validates a source URL for the settings form.
pub fn validate_source(url: &str) -> Result<(), ApiError> {
    if !(8..=512).contains(&url.len()) {
        return Err(bad_request!(
            "agent_update.source_invalid",
            "source URL must be 8–512 characters"
        ));
    }
    target(url).map(|_| ()).map_err(|e| {
        bad_request!(
            "agent_update.source_invalid",
            "invalid source URL: {detail}",
            detail = e
        )
    })
}

/// Hosts a check may contact for `source`.
fn allowed_hosts(source: &str) -> Result<Vec<String>, ApiError> {
    let t = target(source).map_err(|e| {
        bad_request!(
            "agent_update.source_invalid",
            "invalid source URL: {detail}",
            detail = e
        )
    })?;
    let mut hosts = vec![t.host.clone()];
    if t.host == "api.github.com" {
        hosts.extend(GITHUB_DOWNLOAD_HOSTS.iter().map(|h| h.to_string()));
    }
    Ok(hosts)
}

/// A request's failure as the check's coded error. `what` names the file
/// (never a URL: redirect targets carry signed query strings).
fn fetch_failed(what: &str, detail: impl std::fmt::Display) -> ApiError {
    api_error!(
        BAD_GATEWAY,
        "agent_update.fetch_failed",
        "fetching {what} failed: {detail}",
        what = what.to_string(),
        detail = detail.to_string()
    )
}

/// GET with the redirect and host policy. Returns the final 200 response
/// (body unread).
async fn open(
    url: &str,
    accept: &str,
    allowed: &[String],
    what: &str,
) -> Result<hyper::Response<Incoming>, ApiError> {
    let mut url = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let t = target(&url).map_err(|e| fetch_failed(what, e))?;
        if !allowed.contains(&t.host) {
            return Err(bad_request!(
                "agent_update.host_not_allowed",
                "{what}: host {host} is not the configured source",
                what = what.to_string(),
                host = t.host.clone()
            ));
        }
        let res = tokio::time::timeout(REQUEST_TIMEOUT, send(&t, accept))
            .await
            .map_err(|_| fetch_failed(what, "timed out"))?
            .map_err(|e| fetch_failed(what, e))?;
        let status = res.status();
        if status.is_redirection() {
            let loc = res
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| fetch_failed(what, "redirect without location"))?;
            url = if loc.starts_with('/') && !loc.starts_with("//") {
                format!(
                    "{}://{}{loc}",
                    if t.tls { "https" } else { "http" },
                    t.authority
                )
            } else {
                loc.to_string()
            };
            continue;
        }
        if status != StatusCode::OK {
            return Err(api_error!(
                BAD_GATEWAY,
                "agent_update.http_status",
                "fetching {what}: HTTP {status}",
                what = what.to_string(),
                status = status.as_u16()
            ));
        }
        return Ok(res);
    }
    Err(fetch_failed(what, "too many redirects"))
}

async fn send(t: &Target, accept: &str) -> Result<hyper::Response<Incoming>, String> {
    let connect_host = t
        .host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let tcp = tokio::net::TcpStream::connect((connect_host.as_str(), t.port))
        .await
        .map_err(|e| format!("connect: {}", e.kind()))?;
    let _ = tcp.set_nodelay(true);
    let req = hyper::Request::get(t.path.as_str())
        .header(header::HOST, t.authority.as_str())
        .header(header::ACCEPT, accept)
        .header(header::USER_AGENT, "akari-panel")
        .body(Empty::<Bytes>::new())
        .map_err(|_| "bad request".to_string())?;
    if t.tls {
        let name = rustls::pki_types::ServerName::try_from(connect_host)
            .map_err(|_| "bad host name".to_string())?;
        let stream = tokio_rustls::TlsConnector::from(crate::billing::http::tls_config()?)
            .connect(name, tcp)
            .await
            .map_err(|e| format!("tls: {e}"))?;
        request(TokioIo::new(stream), req).await
    } else {
        request(TokioIo::new(tcp), req).await
    }
}

async fn request<T>(
    io: T,
    req: hyper::Request<Empty<Bytes>>,
) -> Result<hyper::Response<Incoming>, String>
where
    T: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| format!("http: {e}"))?;
    // The connection task ends with the body (or when it is dropped).
    tokio::spawn(async move {
        let _ = conn.await;
    });
    sender
        .send_request(req)
        .await
        .map_err(|e| format!("http: {e}"))
}

/// A small file, whole, at most `max` bytes.
async fn fetch_small(
    url: &str,
    accept: &str,
    allowed: &[String],
    what: &str,
    max: usize,
) -> Result<Bytes, ApiError> {
    let res = open(url, accept, allowed, what).await?;
    if content_length(&res).is_some_and(|n| n > max as u64) {
        return Err(too_large(what, max as u64));
    }
    let body = tokio::time::timeout(
        REQUEST_TIMEOUT,
        Limited::new(res.into_body(), max).collect(),
    )
    .await
    .map_err(|_| fetch_failed(what, "timed out"))?;
    match body {
        Ok(b) => Ok(b.to_bytes()),
        Err(e) if e.is::<http_body_util::LengthLimitError>() => Err(too_large(what, max as u64)),
        Err(e) => Err(fetch_failed(what, e)),
    }
}

fn content_length<B>(res: &hyper::Response<B>) -> Option<u64> {
    res.headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
}

fn too_large(what: &str, max: u64) -> ApiError {
    bad_request!(
        "agent_update.too_large",
        "{what} is larger than {max} bytes",
        what = what.to_string(),
        max = max
    )
}

// ---------------------------------------------------------------------------
// The release and its files
// ---------------------------------------------------------------------------

/// The fields of a GitHub release object the check uses (others ignored).
#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    size: i64,
    browser_download_url: String,
}

impl GhRelease {
    fn asset(&self, name: &str) -> Result<&GhAsset, ApiError> {
        self.assets.iter().find(|a| a.name == name).ok_or_else(|| {
            bad_request!(
                "agent_update.asset_missing",
                "release {version} has no {name}",
                version = self.tag_name.clone(),
                name = name.to_string()
            )
        })
    }
}

fn release_invalid(detail: impl std::fmt::Display) -> ApiError {
    bad_request!(
        "agent_update.release_invalid",
        "the source's release is invalid: {detail}",
        detail = detail.to_string()
    )
}

/// SHA256SUMS ("<64 hex>  <name>" or "<64 hex> *<name>" per line).
fn parse_sums(b: &[u8]) -> Result<BTreeMap<String, String>, ApiError> {
    let text = std::str::from_utf8(b).map_err(|_| sums_invalid("not UTF-8"))?;
    let mut out = BTreeMap::new();
    for line in text.lines().map(str::trim_end).filter(|l| !l.is_empty()) {
        let (hash, rest) = line
            .split_at_checked(64)
            .ok_or_else(|| sums_invalid("short line"))?;
        let name = rest
            .strip_prefix("  ")
            .or_else(|| rest.strip_prefix(" *"))
            .filter(|n| !n.is_empty())
            .ok_or_else(|| sums_invalid("malformed line"))?;
        if !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(sums_invalid("malformed digest"));
        }
        if out
            .insert(name.to_string(), hash.to_ascii_lowercase())
            .is_some()
        {
            return Err(sums_invalid("duplicate name"));
        }
    }
    Ok(out)
}

fn sums_invalid(detail: &str) -> ApiError {
    bad_request!(
        "agent_update.checksums_invalid",
        "SHA256SUMS is invalid: {detail}",
        detail = detail.to_string()
    )
}

fn sum_of<'a>(sums: &'a BTreeMap<String, String>, name: &str) -> Result<&'a str, ApiError> {
    sums.get(name).map(String::as_str).ok_or_else(|| {
        bad_request!(
            "agent_update.checksum_missing",
            "SHA256SUMS does not list {name}",
            name = name.to_string()
        )
    })
}

fn checksum_mismatch(name: &str) -> ApiError {
    bad_request!(
        "agent_update.checksum_mismatch",
        "{name} does not match SHA256SUMS",
        name = name.to_string()
    )
}

/// The newest stored complete release that is not a rollback.
async fn newest_stored(conn: &mut PgConnection) -> sqlx::Result<Option<String>> {
    let versions: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT version FROM agent_releases WHERE complete_at IS NOT NULL AND NOT rollback",
    )
    .fetch_all(conn)
    .await?;
    Ok(newest(versions))
}

fn newest(versions: impl IntoIterator<Item = String>) -> Option<String> {
    versions
        .into_iter()
        .filter(|v| updates::parse_version(v).is_some())
        .max_by(|a, b| updates::compare_versions(a, b).unwrap_or(Ordering::Equal))
}

/// What a successful check did.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Outcome {
    /// "stored" (at least one platform was stored) or "up_to_date".
    pub result: &'static str,
    pub version: String,
    /// "linux/<arch>" of each release stored by this check.
    pub stored: Vec<String>,
}

/// Fetches, verifies and stores the source's latest release in `tx`.
async fn fetch_and_store(
    tx: &mut PgConnection,
    keys: &[updates::ReleaseKey],
    source: &str,
    actor: &Actor,
) -> Result<Outcome, ApiError> {
    let allowed = allowed_hosts(source)?;
    let raw = fetch_small(
        source,
        "application/vnd.github+json",
        &allowed,
        "release metadata",
        META_MAX,
    )
    .await?;
    let rel: GhRelease = serde_json::from_slice(&raw).map_err(release_invalid)?;
    if rel.assets.len() > MAX_ASSETS {
        return Err(release_invalid("too many assets"));
    }
    if updates::parse_version(&rel.tag_name).is_none() {
        return Err(release_invalid(format!(
            "tag {:?} is not a version",
            rel.tag_name
        )));
    }
    if rel.draft || rel.prerelease {
        return Err(bad_request!(
            "agent_update.prerelease",
            "the source's latest release {version} is a draft or pre-release",
            version = rel.tag_name.clone()
        ));
    }
    let version = rel.tag_name.clone();
    if let Some(have) = newest_stored(tx).await?
        && updates::compare_versions(&version, &have) == Some(Ordering::Less)
    {
        return Err(conflict!(
            "agent_update.downgrade",
            "the source's latest release {latest} is older than the stored {have}: refusing to go back",
            latest = version.clone(),
            have = have
        ));
    }
    // Platforms already stored completely are left alone.
    let mut todo: Vec<(&str, Option<(uuid::Uuid, String)>)> = Vec::new();
    for arch in ARCHES {
        let row: Option<(uuid::Uuid, String, bool)> = sqlx::query_as(
            "SELECT id, sha256, complete_at IS NOT NULL FROM agent_releases \
             WHERE version = $1 AND os = 'linux' AND arch = $2 FOR UPDATE",
        )
        .bind(&version)
        .bind(arch)
        .fetch_optional(&mut *tx)
        .await?;
        match row {
            Some((_, _, true)) => {}
            Some((id, sha, false)) => todo.push((arch, Some((id, sha)))),
            None => todo.push((arch, None)),
        }
    }
    if todo.is_empty() {
        return Ok(Outcome {
            result: "up_to_date",
            version,
            stored: Vec::new(),
        });
    }
    let sums_asset = rel.asset("SHA256SUMS")?;
    let sums = parse_sums(
        &fetch_small(
            &sums_asset.browser_download_url,
            "application/octet-stream",
            &allowed,
            "SHA256SUMS",
            SUMS_MAX,
        )
        .await?,
    )?;
    let mut stored = Vec::new();
    for (arch, existing) in todo {
        let bin_name = format!("akari-agent-linux-{arch}");
        let man_name = format!("{bin_name}.manifest.json");
        let sig_name = format!("{bin_name}.manifest.sig");
        let (bin, man, sig) = (
            rel.asset(&bin_name)?,
            rel.asset(&man_name)?,
            rel.asset(&sig_name)?,
        );
        let man_bytes = fetch_small(
            &man.browser_download_url,
            "application/octet-stream",
            &allowed,
            &man_name,
            updates::MAX_MANIFEST,
        )
        .await?;
        let sig_bytes = fetch_small(
            &sig.browser_download_url,
            "application/octet-stream",
            &allowed,
            &sig_name,
            SIG_MAX,
        )
        .await?;
        if hex::encode(Sha256::digest(&man_bytes)) != sum_of(&sums, &man_name)? {
            return Err(checksum_mismatch(&man_name));
        }
        if hex::encode(Sha256::digest(&sig_bytes)) != sum_of(&sums, &sig_name)? {
            return Err(checksum_mismatch(&sig_name));
        }
        let m = updates::parse_manifest(&man_bytes)
            .map_err(|e| bad_request!("release.manifest_invalid", "{detail}", detail = e))?;
        if m.os != "linux" || m.arch != arch {
            return Err(bad_request!(
                "agent_update.platform_mismatch",
                "{name} is for {os}/{arch}",
                name = man_name.clone(),
                os = m.os.clone(),
                arch = m.arch.clone()
            ));
        }
        if m.version != version {
            return Err(bad_request!(
                "agent_update.version_mismatch",
                "{name} is version {got}, the release is {version}",
                name = man_name.clone(),
                got = m.version.clone(),
                version = version.clone()
            ));
        }
        if m.rollback {
            return Err(bad_request!(
                "agent_update.rollback_refused",
                "{name} is a rollback manifest: upload it by hand if that is intended",
                name = man_name.clone()
            ));
        }
        if sum_of(&sums, &bin_name)? != m.sha256 {
            return Err(checksum_mismatch(&bin_name));
        }
        if bin.size != m.size {
            return Err(bad_request!(
                "agent_update.size_mismatch",
                "{name} is {got} bytes, its manifest says {want}",
                name = bin_name.clone(),
                got = bin.size,
                want = m.size
            ));
        }
        let id = match existing {
            Some((id, sha)) if sha == m.sha256 => id,
            Some(_) => {
                return Err(conflict!(
                    "release.exists",
                    "a release with this version/platform or digest already exists"
                ))
            }
            None => {
                let manifest = String::from_utf8(man_bytes.to_vec()).map_err(|_| {
                    bad_request!("release.manifest_invalid", "{detail}", detail = "not UTF-8")
                })?;
                let sig: SigFile = serde_json::from_slice(&sig_bytes).map_err(|e| {
                    bad_request!(
                        "release.signature_invalid",
                        "{detail}",
                        detail = format!("{sig_name}: {e}")
                    )
                })?;
                updates::apply_create_release(tx, actor, keys, &CreateReleaseReq { manifest, sig })
                    .await?
            }
        };
        let res = open(
            &bin.browser_download_url,
            "application/octet-stream",
            &allowed,
            &bin_name,
        )
        .await?;
        if content_length(&res).is_some_and(|n| n != m.size as u64) {
            return Err(bad_request!(
                "agent_update.size_mismatch",
                "{name} is {got} bytes, its manifest says {want}",
                name = bin_name.clone(),
                got = content_length(&res).unwrap_or(0),
                want = m.size
            ));
        }
        let what = bin_name.clone();
        updates::apply_store_binary(
            tx,
            actor,
            id,
            http_body_util::BodyDataStream::new(res.into_body()),
            Some(STALL),
            move || fetch_failed(&what, "download interrupted"),
        )
        .await?;
        stored.push(format!("linux/{arch}"));
    }
    Ok(Outcome {
        result: "stored",
        version,
        stored,
    })
}

// ---------------------------------------------------------------------------
// Running a check
// ---------------------------------------------------------------------------

/// Begins the transaction a check runs in, holding the check's advisory
/// lock; None = another check (any instance) holds it.
pub async fn begin_locked(
    pg: &sqlx::PgPool,
) -> sqlx::Result<Option<Transaction<'static, Postgres>>> {
    let mut tx = pg.begin().await?;
    let got: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('akari.agent_update.' || current_schema(), 0))",
    )
    .fetch_one(&mut *tx)
    .await?;
    Ok(got.then_some(tx))
}

async fn source_url(conn: &mut PgConnection) -> sqlx::Result<String> {
    let s: Option<String> = sqlx::query_scalar("SELECT source_url FROM agent_update_settings")
        .fetch_one(conn)
        .await?;
    Ok(s.unwrap_or_else(|| DEFAULT_SOURCE.to_string()))
}

fn source_host(source: &str) -> Option<String> {
    target(source).ok().map(|t| t.host)
}

/// Runs a check in `tx` (from `begin_locked`) and records its outcome:
/// success commits the stored releases with the outcome and its audit row;
/// failure rolls everything back and records the coded error (audited) in
/// a transaction of its own.
pub async fn run(
    state: &AppState,
    mut tx: Transaction<'static, Postgres>,
    actor: &Actor,
) -> Result<Outcome, ApiError> {
    let source = source_url(&mut tx).await?;
    let keys = state.settings().get().release_keys.clone();
    let res = if keys.is_empty() {
        Err(no_keys())
    } else {
        tokio::time::timeout(
            CHECK_TIMEOUT,
            fetch_and_store(&mut tx, &keys, &source, actor),
        )
        .await
        .unwrap_or_else(|_| {
            Err(api_error!(
                GATEWAY_TIMEOUT,
                "agent_update.timed_out",
                "the update check took too long"
            ))
        })
    };
    let host = source_host(&source);
    match res {
        Ok(out) => {
            sqlx::query(
                "UPDATE agent_update_settings SET check_started_at = NULL, last_check_at = now(), \
                 last_check_ok = TRUE, last_check_result = $1, last_check_version = $2, \
                 last_check_code = NULL, last_check_params = NULL, last_check_message = NULL, \
                 last_check_stored = $3",
            )
            .bind(out.result)
            .bind(&out.version)
            .bind(&out.stored)
            .execute(&mut *tx)
            .await?;
            crate::audit::record(
                &mut tx,
                actor,
                "agent_update.check",
                "agent_update",
                None,
                None,
                Some(json!({
                    "source_host": host, "result": out.result, "version": out.version,
                    "stored": out.stored,
                })),
            )
            .await?;
            tx.commit().await?;
            tracing::info!(version = %out.version, result = out.result, stored = ?out.stored, "agent update check");
            Ok(out)
        }
        Err(e) => {
            drop(tx);
            tracing::warn!(
                code = e.code(),
                error = e.message(),
                "agent update check failed"
            );
            let mut tx = state.pg().begin().await?;
            sqlx::query(
                "UPDATE agent_update_settings SET check_started_at = NULL, last_check_at = now(), \
                 last_check_ok = FALSE, last_check_result = 'failed', last_check_version = NULL, \
                 last_check_code = $1, last_check_params = $2, last_check_message = $3, \
                 last_check_stored = NULL",
            )
            .bind(e.code())
            .bind(Value::Object(e.params().clone()))
            .bind(e.message())
            .execute(&mut *tx)
            .await?;
            crate::audit::record(
                &mut tx,
                actor,
                "agent_update.check",
                "agent_update",
                None,
                None,
                Some(json!({ "source_host": host, "result": "failed", "code": e.code() })),
            )
            .await?;
            tx.commit().await?;
            Err(e)
        }
    }
}

fn no_keys() -> ApiError {
    conflict!(
        "release.no_keys",
        "no release keys trusted (系统设置 → 安全): self-update is off"
    )
}

fn check_running() -> ApiError {
    conflict!(
        "agent_update.check_running",
        "an update check is already running"
    )
}

/// Marks a check as running (status display) and runs it to the end.
pub async fn check_now(state: &AppState, actor: &Actor) -> Result<Outcome, ApiError> {
    let tx = begin_locked(state.pg()).await?.ok_or_else(check_running)?;
    mark_started(state).await?;
    run(state, tx, actor).await
}

async fn mark_started(state: &AppState) -> sqlx::Result<()> {
    sqlx::query("UPDATE agent_update_settings SET check_started_at = now()")
        .execute(state.pg())
        .await
        .map(|_| ())
}

/// One auto-check tick: when auto_check is on and due, claim the next
/// slot (one instance wins) and check. Some = a check ran.
pub async fn auto_tick(state: &AppState) -> Result<Option<Result<Outcome, ApiError>>, ApiError> {
    let claimed: Option<bool> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "UPDATE agent_update_settings SET next_auto_check_at = now() + interval '{AUTO_EVERY}' \
         WHERE auto_check AND (next_auto_check_at IS NULL OR next_auto_check_at <= now()) \
         RETURNING TRUE"
    )))
    .fetch_optional(state.pg())
    .await?;
    if claimed.is_none() {
        return Ok(None);
    }
    let Some(tx) = begin_locked(state.pg()).await? else {
        return Ok(None);
    };
    mark_started(state).await?;
    Ok(Some(run(state, tx, &Actor::system()).await))
}

/// Every instance: the 6-hourly automatic check (off by default; it only
/// stores releases, never starts a rollout).
pub async fn auto_loop(state: AppState) {
    let mut tick = tokio::time::interval(AUTO_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if let Err(e) = auto_tick(&state).await {
            tracing::warn!(code = e.code(), "agent auto update check failed to start");
        }
    }
}

// ---------------------------------------------------------------------------
// API: /api/v1/agent-updates
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct Row {
    source_url: Option<String>,
    auto_check: bool,
    version: i64,
    next_auto_check_at: Option<DateTime<Utc>>,
    checking: bool,
    last_check_at: Option<DateTime<Utc>>,
    last_check_ok: Option<bool>,
    last_check_result: Option<String>,
    last_check_version: Option<String>,
    last_check_code: Option<String>,
    last_check_params: Option<Value>,
    last_check_message: Option<String>,
    last_check_stored: Option<Vec<String>>,
}

#[derive(Serialize)]
pub struct LastCheck {
    at: DateTime<Utc>,
    ok: bool,
    result: String,
    version: Option<String>,
    code: Option<String>,
    params: Option<Value>,
    message: Option<String>,
    stored: Vec<String>,
}

#[derive(Serialize)]
pub struct Latest {
    pub version: String,
    /// "linux/amd64", … with a complete release of `version`.
    pub platforms: Vec<String>,
}

#[derive(Serialize)]
pub struct StatusView {
    pub version: i64,
    /// The stored source (null = `default_source_url`).
    pub source_url: Option<String>,
    pub default_source_url: &'static str,
    pub auto_check: bool,
    pub next_auto_check_at: Option<DateTime<Utc>>,
    pub checking: bool,
    pub keys_configured: bool,
    pub last_check: Option<LastCheck>,
    /// The newest complete (non-rollback) stored release.
    pub latest: Option<Latest>,
    /// Enrolled nodes (protocol ≥ 3, platform covered by `latest`) running
    /// an older version than `latest`.
    pub outdated_nodes: i64,
    /// `latest.version` when `outdated_nodes > 0` (the "有新版本" badge).
    pub update_available: Option<String>,
}

pub async fn status(state: &AppState) -> Result<StatusView, ApiError> {
    let mut conn = state.pg().acquire().await?;
    let r: Row = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT source_url, auto_check, version, next_auto_check_at, \
         check_started_at IS NOT NULL AND check_started_at > now() - interval '{RUNNING_FOR}' AS checking, \
         last_check_at, last_check_ok, last_check_result, last_check_version, last_check_code, \
         last_check_params, last_check_message, last_check_stored FROM agent_update_settings"
    )))
    .fetch_one(&mut *conn)
    .await?;
    let latest = match newest_stored(&mut conn).await? {
        None => None,
        Some(v) => {
            let platforms: Vec<String> = sqlx::query_scalar(
                "SELECT os || '/' || arch FROM agent_releases \
                 WHERE version = $1 AND complete_at IS NOT NULL AND NOT rollback ORDER BY 1",
            )
            .bind(&v)
            .fetch_all(&mut *conn)
            .await?;
            Some(Latest {
                version: v,
                platforms,
            })
        }
    };
    let mut outdated = 0i64;
    if let Some(l) = &latest {
        let nodes: Vec<(String, String)> = sqlx::query_as(
            "SELECT agent_version, agent_os || '/' || agent_arch FROM nodes \
             WHERE deleting_at IS NULL AND agent_version IS NOT NULL AND agent_os IS NOT NULL \
             AND agent_arch IS NOT NULL AND agent_protocol >= $1",
        )
        .bind(updates::MIN_UPDATE_PROTOCOL as i32)
        .fetch_all(&mut *conn)
        .await?;
        outdated = nodes
            .iter()
            .filter(|(v, p)| {
                l.platforms.contains(p)
                    && updates::compare_versions(v, &l.version) == Some(Ordering::Less)
            })
            .count() as i64;
    }
    let last_check = match (r.last_check_at, r.last_check_result) {
        (Some(at), Some(result)) => Some(LastCheck {
            at,
            ok: r.last_check_ok.unwrap_or(false),
            result,
            version: r.last_check_version,
            code: r.last_check_code,
            params: r.last_check_params,
            message: r.last_check_message,
            stored: r.last_check_stored.unwrap_or_default(),
        }),
        _ => None,
    };
    Ok(StatusView {
        version: r.version,
        source_url: r.source_url,
        default_source_url: DEFAULT_SOURCE,
        auto_check: r.auto_check,
        next_auto_check_at: r.next_auto_check_at.filter(|_| r.auto_check),
        checking: r.checking,
        keys_configured: !state.settings().get().release_keys.is_empty(),
        last_check,
        update_available: latest
            .as_ref()
            .filter(|_| outdated > 0)
            .map(|l| l.version.clone()),
        latest,
        outdated_nodes: outdated,
    })
}

/// GET /agent-updates (admin): settings, the last check, the newest stored
/// release and how many nodes run something older.
pub async fn get_status(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<StatusView>, ApiError> {
    user.require_admin()?;
    Ok(Json(status(&state).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsReq {
    pub version: i64,
    /// null or "" = the project's GitHub releases.
    pub source_url: Option<String>,
    pub auto_check: bool,
}

/// Saves the update-check settings (optimistic `version`; audited as
/// `agent_update.settings.update`). Turning the auto check on makes it due
/// at the next tick.
pub async fn apply_update_settings(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &SettingsReq,
) -> Result<(), ApiError> {
    let source = req
        .source_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    if let Some(s) = &source {
        validate_source(s)?;
    }
    let (version, cur_source, cur_auto): (i64, Option<String>, bool) = sqlx::query_as(
        "SELECT version, source_url, auto_check FROM agent_update_settings FOR UPDATE",
    )
    .fetch_one(&mut *conn)
    .await?;
    if version != req.version {
        return Err(conflict!(
            "settings.version_conflict",
            "设置已被修改（可能是其他管理员），请刷新后重试"
        ));
    }
    if cur_source == source && cur_auto == req.auto_check {
        return Ok(());
    }
    sqlx::query(
        "UPDATE agent_update_settings SET source_url = $1, auto_check = $2, \
         next_auto_check_at = CASE WHEN $2 AND NOT auto_check THEN NULL ELSE next_auto_check_at END, \
         version = version + 1, updated_at = now()",
    )
    .bind(&source)
    .bind(req.auto_check)
    .execute(&mut *conn)
    .await?;
    crate::audit::record(
        conn,
        actor,
        "agent_update.settings.update",
        "settings",
        None,
        Some(json!({ "source_url": cur_source, "auto_check": cur_auto })),
        Some(json!({ "source_url": source, "auto_check": req.auto_check })),
    )
    .await?;
    Ok(())
}

/// PUT /agent-updates/settings (admin).
pub async fn put_settings(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<SettingsReq>,
) -> Result<Json<StatusView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_update_settings(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok(Json(status(&state).await?))
}

/// POST /agent-updates/check (admin): starts a check in the background
/// (202; the outcome appears in GET /agent-updates `last_check`). 409 when
/// a check is already running on any instance, or no release keys are
/// configured.
pub async fn post_check(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<(StatusCode, Json<StatusView>), ApiError> {
    user.require_admin()?;
    if state.settings().get().release_keys.is_empty() {
        return Err(no_keys());
    }
    let tx = begin_locked(state.pg()).await?.ok_or_else(check_running)?;
    mark_started(&state).await?;
    let actor = Actor::of(&user);
    let st = state.clone();
    tokio::spawn(async move {
        let _ = run(&st, tx, &actor).await;
    });
    Ok((StatusCode::ACCEPTED, Json(status(&state).await?)))
}

#[cfg(test)]
mod tests;
