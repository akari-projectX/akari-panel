//! M6 agent self-update: signed release manifests, the release store and
//! the artifact download RPC.
//!
//! Trust model: agents run only binaries described by a manifest signed
//! with an Ed25519 release key PINNED IN THE AGENT (akari-agent
//! `release-keys.txt`); the panel is a relay and cannot add trust. The
//! panel verifies the same signatures before it stores or offers a release
//! (an early, friendly refusal — not the security boundary) under the
//! official keys compiled into it (`src/release-keys.txt`, a byte-identical
//! copy of akari-agent's, CI-checked) plus 系统设置 → 安全 → 额外信任的发布
//! 公钥 (W25; e.g. the public TEST key in smoke). Manifest format and signature: see "Agent
//! self-update" in proto/agent.proto; the Go reference is
//! akari-agent/release (cross-checked by `proto/update_vector.json`).
//!
//! Storage: manifest bytes verbatim + the binary in 1 MiB rows
//! (`agent_release_chunks`), so every panel instance can serve it.

use crate::auth::{bad_request, conflict};
use std::cmp::Ordering;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio_stream::StreamExt;
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::Actor;
use crate::auth::{ApiError, AuthUser};
use crate::state::AppState;

/// The panel's control-protocol revision (UpdateOffer.panel_protocol;
/// a release's min_panel_protocol must not exceed it).
pub const PANEL_PROTOCOL: u32 = 3;
/// Rows of agent_release_chunks / FetchArtifact chunks.
pub const CHUNK: usize = 1 << 20;
pub const MAX_ARTIFACT: i64 = 256 << 20;
pub const MAX_MANIFEST: usize = 4096;
/// A download whose reader takes no chunk for this long is dropped.
const SEND_STALL: std::time::Duration = std::time::Duration::from_secs(60);
const SIG_CONTEXT: &[u8] = b"akari-agent-manifest-v1\n";

// ---------------------------------------------------------------------------
// Keys, manifest, signatures, versions
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ReleaseKey {
    pub id: String,
    pub key: Vec<u8>,
    pub label: String,
}

/// First 8 bytes of SHA-256(public key), lowercase hex (as the agent).
pub fn key_id(pubkey: &[u8]) -> String {
    hex::encode(&Sha256::digest(pubkey)[..8])
}

/// The official release keys: akari-agent's release-keys.txt, copied
/// verbatim (CI compares it with akari-agent main).
const OFFICIAL_RELEASE_KEYS: &str = include_str!("release-keys.txt");

/// The official keys ('#' comment lines and blank lines skipped). A copy
/// that does not parse (unit-tested: impossible for a release) yields no
/// keys with an error log, never a panic.
pub fn official_release_keys() -> Vec<ReleaseKey> {
    let lines: Vec<String> = OFFICIAL_RELEASE_KEYS
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect();
    match parse_release_keys(&lines) {
        Ok(k) => k,
        Err(e) => {
            tracing::error!(error = %e, "compiled-in release keys do not parse");
            Vec::new()
        }
    }
}

/// Parses release key lines ("<base64 32-byte key> [label]").
pub fn parse_release_keys(lines: &[String]) -> Result<Vec<ReleaseKey>, String> {
    let mut out: Vec<ReleaseKey> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let mut f = line.split_whitespace();
        let Some(b64) = f.next() else {
            return Err(format!("entry {} is empty", i + 1));
        };
        let key = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .ok()
            .filter(|k| k.len() == 32)
            .ok_or_else(|| format!("entry {} is not a base64 Ed25519 public key", i + 1))?;
        let id = key_id(&key);
        if out.iter().any(|k| k.id == id) {
            return Err(format!("entry {}: duplicate key {id}", i + 1));
        }
        out.push(ReleaseKey {
            id,
            key,
            label: f.collect::<Vec<_>>().join(" "),
        });
    }
    Ok(out)
}

/// Longest life of a signed rollback manifest (`expires_at` − `created_at`).
pub const MAX_ROLLBACK_LIFETIME_DAYS: i64 = 30;

/// A release manifest. Schema 1 = a normal forward release; schema 2 = a
/// signed rollback bound to the version it replaces (`rollback_from`) and
/// to an expiry (`expires_at`), so a leaked rollback cannot be replayed
/// later or against another version (agent audit P2-2). Schema-1 rollback
/// manifests are refused.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub sha256: String,
    pub size: i64,
    pub min_panel_protocol: u32,
    pub created_at: String,
    #[serde(default)]
    pub rollback: bool,
    /// Schema 2 rollback only: the exact version this rollback replaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback_from: Option<String>,
    /// Schema 2 rollback only (RFC 3339): not valid at or after this time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

impl Manifest {
    /// Whether a rollback manifest's `expires_at` has passed (a manifest
    /// without one never expires; only rollbacks carry one).
    pub fn expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at
            .as_deref()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| now >= t)
    }
}

fn platform_ok(s: &str) -> bool {
    (1..=16).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Decodes and validates manifest bytes with the agent's rules.
pub fn parse_manifest(b: &[u8]) -> Result<Manifest, String> {
    if b.is_empty() || b.len() > MAX_MANIFEST {
        return Err(format!("manifest size {} out of range", b.len()));
    }
    let m: Manifest = serde_json::from_slice(b).map_err(|e| format!("manifest: {e}"))?;
    if m.schema != 1 && m.schema != 2 {
        return Err(format!("unsupported manifest schema {}", m.schema));
    }
    if parse_version(&m.version).is_none() {
        return Err(format!("invalid version {:?}", m.version));
    }
    if !platform_ok(&m.os) || !platform_ok(&m.arch) {
        return Err("invalid os/arch".into());
    }
    if m.sha256.len() != 64
        || !m
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("sha256 must be 64 lowercase hex digits".into());
    }
    if m.size <= 0 || m.size > MAX_ARTIFACT {
        return Err(format!("size {} out of range", m.size));
    }
    let Ok(created) = DateTime::parse_from_rfc3339(&m.created_at) else {
        return Err("created_at is not RFC 3339".into());
    };
    check_rollback_binding(&m, created.with_timezone(&Utc))?;
    Ok(m)
}

/// The rollback rules of the manifest format (same as the agent's
/// `release` package): a rollback is schema 2 and names the version it
/// replaces and an expiry within 30 days of signing; nothing else may
/// carry those fields.
fn check_rollback_binding(m: &Manifest, created: DateTime<Utc>) -> Result<(), String> {
    if !m.rollback {
        if m.schema != 1 {
            return Err("schema 2 is for rollback manifests only".into());
        }
        if m.rollback_from.is_some() || m.expires_at.is_some() {
            return Err("rollback_from / expires_at belong to rollback manifests".into());
        }
        return Ok(());
    }
    if m.schema != 2 {
        return Err(
            "rollback manifests need schema 2 (rollback_from, expires_at); schema-1 rollbacks are refused"
                .into(),
        );
    }
    let from = m
        .rollback_from
        .as_deref()
        .ok_or("rollback manifest lacks rollback_from")?;
    if compare_versions(from, &m.version) != Some(Ordering::Greater) {
        return Err(format!(
            "rollback_from {from:?} must be a version newer than {}",
            m.version
        ));
    }
    let exp = m
        .expires_at
        .as_deref()
        .ok_or("rollback manifest lacks expires_at")?;
    let exp = DateTime::parse_from_rfc3339(exp)
        .map_err(|_| "expires_at is not RFC 3339".to_string())?
        .with_timezone(&Utc);
    if exp <= created {
        return Err("expires_at is not after created_at".into());
    }
    if exp - created > chrono::Duration::days(MAX_ROLLBACK_LIFETIME_DAYS) {
        return Err(format!(
            "expires_at is more than {MAX_ROLLBACK_LIFETIME_DAYS} days after created_at"
        ));
    }
    Ok(())
}

/// One signature as in the agent's `.manifest.sig` file.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Signature {
    pub key_id: String,
    /// Standard base64 of the 64-byte Ed25519 signature.
    pub sig: String,
}

impl Signature {
    pub fn bytes(&self) -> Option<Vec<u8>> {
        base64::engine::general_purpose::STANDARD
            .decode(&self.sig)
            .ok()
            .filter(|s| s.len() == 64)
    }
}

/// The id of a configured key with a valid signature over the manifest.
pub fn verify(manifest: &[u8], sigs: &[Signature], keys: &[ReleaseKey]) -> Result<String, String> {
    if keys.is_empty() {
        return Err("no release keys trusted".into());
    }
    let mut msg = SIG_CONTEXT.to_vec();
    msg.extend_from_slice(manifest);
    for s in sigs {
        let Some(sig) = s.bytes() else { continue };
        for k in keys.iter().filter(|k| k.id == s.key_id) {
            let pk = ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &k.key);
            if pk.verify(&msg, &sig).is_ok() {
                return Ok(k.id.clone());
            }
        }
    }
    Err("no valid signature by a configured release key".into())
}

/// Semantic version "vMAJOR.MINOR.PATCH[-pre][+build]".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    core: [u64; 3],
    pre: Vec<String>,
}

fn numeric_ident(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn ident_ok(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn parse_version(v: &str) -> Option<Version> {
    if v.len() > 128 {
        return None;
    }
    let rest = v.strip_prefix('v')?;
    let (rest, build) = match rest.split_once('+') {
        Some((r, b)) => (r, Some(b)),
        None => (rest, None),
    };
    if let Some(b) = build
        && !b.split('.').all(ident_ok)
    {
        return None;
    }
    let (core, pre) = match rest.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (rest, None),
    };
    let mut parts = core.split('.');
    let mut nums = [0u64; 3];
    for n in &mut nums {
        let p = parts.next()?;
        if !numeric_ident(p) || (p.len() > 1 && p.starts_with('0')) {
            return None;
        }
        *n = p.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    let pre = match pre {
        None => Vec::new(),
        Some(p) => {
            let ids: Vec<String> = p.split('.').map(String::from).collect();
            for id in &ids {
                if !ident_ok(id) || (numeric_ident(id) && id.len() > 1 && id.starts_with('0')) {
                    return None;
                }
            }
            ids
        }
    };
    Some(Version { core: nums, pre })
}

fn cmp_ident(a: &str, b: &str) -> Ordering {
    match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(x), Ok(y)) if numeric_ident(a) && numeric_ident(b) => x.cmp(&y),
        _ if numeric_ident(a) && numeric_ident(b) => a.len().cmp(&b.len()).then(a.cmp(b)),
        _ if numeric_ident(a) => Ordering::Less,
        _ if numeric_ident(b) => Ordering::Greater,
        _ => a.cmp(b),
    }
}

impl Ord for Version {
    fn cmp(&self, o: &Self) -> Ordering {
        self.core
            .cmp(&o.core)
            .then_with(|| match (self.pre.is_empty(), o.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => {
                    for (a, b) in self.pre.iter().zip(&o.pre) {
                        let c = cmp_ident(a, b);
                        if c != Ordering::Equal {
                            return c;
                        }
                    }
                    self.pre.len().cmp(&o.pre.len())
                }
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// Semver precedence of two version strings; None if either is not one.
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    Some(parse_version(a)?.cmp(&parse_version(b)?))
}

// ---------------------------------------------------------------------------
// API: /api/v1/agent-releases
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct ReleaseView {
    id: Uuid,
    version: String,
    os: String,
    arch: String,
    sha256: String,
    size: i64,
    key_id: String,
    min_panel_protocol: i32,
    rollback: bool,
    /// Rollback releases only (read from the stored manifest): the version
    /// it replaces and when the signature stops being valid.
    rollback_from: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    complete: bool,
    created_at: DateTime<Utc>,
    complete_at: Option<DateTime<Utc>>,
}

const RELEASE_VIEW_SQL: &str = "SELECT id, version, os, arch, sha256, size, key_id, \
     min_panel_protocol, rollback, \
     convert_from(manifest, 'UTF8')::jsonb ->> 'rollback_from' AS rollback_from, \
     (convert_from(manifest, 'UTF8')::jsonb ->> 'expires_at')::timestamptz AS expires_at, \
     complete_at IS NOT NULL AS complete, created_at, complete_at \
     FROM agent_releases";

pub async fn list_releases(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<ReleaseView>>, ApiError> {
    user.require_admin()?;
    let rows = sqlx::query_as::<_, ReleaseView>(sqlx::AssertSqlSafe(format!(
        "{RELEASE_VIEW_SQL} ORDER BY created_at DESC"
    )))
    .fetch_all(state.pg())
    .await?;
    Ok(Json(rows))
}

/// POST body: the manifest file's text and its signature file.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateReleaseReq {
    pub manifest: String,
    pub sig: SigFile,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SigFile {
    pub signatures: Vec<Signature>,
}

/// Registers a signed manifest (the binary follows with PUT .../binary).
pub async fn apply_create_release(
    conn: &mut sqlx::PgConnection,
    actor: &Actor,
    keys: &[ReleaseKey],
    req: &CreateReleaseReq,
) -> Result<Uuid, ApiError> {
    let raw = req.manifest.as_bytes();
    let m = parse_manifest(raw)
        .map_err(|e| bad_request!("release.manifest_invalid", "{detail}", detail = e))?;
    if m.rollback && m.expired(Utc::now()) {
        return Err(bad_request!(
            "release.rollback_expired",
            "this signed rollback has expired ({expires_at}): sign a new one",
            expires_at = m.expires_at.clone().unwrap_or_default()
        ));
    }
    if keys.is_empty() {
        return Err(conflict!(
            "release.no_keys",
            "no release keys trusted (系统设置 → 安全): self-update is off"
        ));
    }
    let key = verify(raw, &req.sig.signatures, keys)
        .map_err(|e| bad_request!("release.signature_invalid", "{detail}", detail = e))?;
    if m.min_panel_protocol > PANEL_PROTOCOL {
        return Err(bad_request!(
            "release.panel_too_old",
            "release needs panel protocol {needed} (this panel speaks {have}): upgrade the panel first",
            needed = m.min_panel_protocol,
            have = PANEL_PROTOCOL
        ));
    }
    let id = Uuid::new_v4();
    let r = sqlx::query(
        "INSERT INTO agent_releases (id, version, os, arch, sha256, size, manifest, signatures, \
         key_id, min_panel_protocol, rollback) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    )
    .bind(id)
    .bind(&m.version)
    .bind(&m.os)
    .bind(&m.arch)
    .bind(&m.sha256)
    .bind(m.size)
    .bind(raw)
    .bind(json!(req.sig.signatures))
    .bind(&key)
    .bind(m.min_panel_protocol as i32)
    .bind(m.rollback)
    .execute(&mut *conn)
    .await;
    match r {
        Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
            return Err(conflict!(
                "release.exists",
                "a release with this version/platform or digest already exists"
            ));
        }
        r => r?,
    };
    crate::audit::record(
        conn,
        actor,
        "agent_release.create",
        "agent_release",
        Some(id.to_string()),
        None,
        Some(json!({
            "version": m.version, "os": m.os, "arch": m.arch, "sha256": m.sha256,
            "size": m.size, "key_id": key, "rollback": m.rollback,
        })),
    )
    .await?;
    Ok(id)
}

async fn release_view(conn: &mut sqlx::PgConnection, id: Uuid) -> Result<ReleaseView, ApiError> {
    sqlx::query_as::<_, ReleaseView>(sqlx::AssertSqlSafe(format!(
        "{RELEASE_VIEW_SQL} WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or_else(ApiError::not_found)
}

pub async fn create_release(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateReleaseReq>,
) -> Result<(StatusCode, Json<ReleaseView>), ApiError> {
    user.require_admin()?;
    let keys = state.settings().get().release_keys.clone();
    let mut tx = state.pg().begin().await?;
    let id = apply_create_release(&mut tx, &Actor::of(&user), &keys, &req).await?;
    let view = release_view(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(view)))
}

/// PUT /agent-releases/{id}/binary (raw body): the binary, streamed into
/// 1 MiB rows in ONE transaction; size and SHA-256 must match the signed
/// manifest or nothing is kept.
pub async fn upload_binary(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    body: Body,
) -> Result<Json<ReleaseView>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    apply_store_binary(
        &mut tx,
        &Actor::of(&user),
        id,
        body.into_data_stream(),
        None,
        || bad_request!("release.upload_interrupted", "upload interrupted"),
    )
    .await?;
    let view = release_view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(view))
}

/// Stores the binary of release `id` (the manual upload and the update
/// check share it): 1 MiB rows, size and SHA-256 checked against the signed
/// manifest, `complete_at` and the `agent_release.upload` audit row in the
/// caller's transaction (any error = the caller rolls everything back).
/// `stall`: give up when no frame arrives for this long; `interrupted`:
/// the error for a broken or stalled stream.
pub async fn apply_store_binary<S, E>(
    tx: &mut sqlx::PgConnection,
    actor: &Actor,
    id: Uuid,
    mut stream: S,
    stall: Option<std::time::Duration>,
    interrupted: impl Fn() -> ApiError,
) -> Result<(), ApiError>
where
    S: tokio_stream::Stream<Item = Result<axum::body::Bytes, E>> + Unpin,
{
    let row: Option<(i64, String, bool, String)> = sqlx::query_as(
        "SELECT size, sha256, complete_at IS NOT NULL, version FROM agent_releases \
         WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((size, want_sha, complete, version)) = row else {
        return Err(ApiError::not_found());
    };
    if complete {
        return Err(conflict!(
            "release.binary_exists",
            "binary already uploaded"
        ));
    }
    let mut h = Sha256::new();
    let mut buf: Vec<u8> = Vec::with_capacity(CHUNK);
    let mut total: i64 = 0;
    let mut idx: i32 = 0;
    loop {
        let next = match stall {
            Some(d) => tokio::time::timeout(d, stream.next())
                .await
                .map_err(|_| interrupted())?,
            None => stream.next().await,
        };
        let Some(frame) = next else { break };
        let frame = frame.map_err(|_| interrupted())?;
        total += frame.len() as i64;
        if total > size {
            return Err(bad_request!(
                "release.binary_too_large",
                "binary larger than the manifest's {size} bytes",
                size = size
            ));
        }
        h.update(&frame);
        let mut rest: &[u8] = &frame;
        while !rest.is_empty() {
            let take = (CHUNK - buf.len()).min(rest.len());
            buf.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if buf.len() == CHUNK {
                insert_chunk(tx, id, idx, &buf).await?;
                idx += 1;
                buf.clear();
            }
        }
    }
    if !buf.is_empty() {
        insert_chunk(tx, id, idx, &buf).await?;
    }
    let sha = hex::encode(h.finalize());
    if total != size || sha != want_sha {
        return Err(bad_request!(
            "release.binary_mismatch",
            "binary does not match the signed manifest (got {total} bytes, sha256 {sha})",
            total = total,
            sha = sha
        ));
    }
    sqlx::query("UPDATE agent_releases SET complete_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::audit::record(
        tx,
        actor,
        "agent_release.upload",
        "agent_release",
        Some(id.to_string()),
        None,
        Some(json!({ "version": version, "sha256": sha, "size": total })),
    )
    .await?;
    Ok(())
}

async fn insert_chunk(
    tx: &mut sqlx::PgConnection,
    id: Uuid,
    idx: i32,
    data: &[u8],
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO agent_release_chunks (release_id, idx, data) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(idx)
        .bind(data)
        .execute(tx)
        .await?;
    Ok(())
}

/// DELETE /agent-releases/{id}: refused while an open rollout targets its
/// version.
pub async fn delete_release(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    crate::rollout::lock(&mut tx).await?;
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT version, os, arch, sha256 FROM agent_releases WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((version, os, arch, sha)) = row else {
        return Err(ApiError::not_found());
    };
    let open: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM rollouts WHERE version = $1 \
         AND status IN ('running','paused','halted'))",
    )
    .bind(&version)
    .fetch_one(&mut *tx)
    .await?;
    if open {
        return Err(conflict!(
            "release.rollout_open",
            "an open rollout targets this version: abort it first"
        ));
    }
    sqlx::query("DELETE FROM agent_releases WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::audit::record(
        &mut tx,
        &Actor::of(&user),
        "agent_release.delete",
        "agent_release",
        Some(id.to_string()),
        Some(json!({ "version": version, "os": os, "arch": arch, "sha256": sha })),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// The offer and the download
// ---------------------------------------------------------------------------

/// The UpdateOffer for a release (manifest bytes and signatures verbatim).
pub fn offer(rollout_id: Uuid, manifest: Vec<u8>, sigs: &[Signature]) -> crate::pb::UpdateOffer {
    crate::pb::UpdateOffer {
        rollout_id: rollout_id.to_string(),
        manifest,
        signatures: sigs
            .iter()
            .filter_map(|s| {
                s.bytes().map(|b| crate::pb::ManifestSignature {
                    key_id: s.key_id.clone(),
                    signature: b,
                })
            })
            .collect(),
        panel_protocol: PANEL_PROTOCOL,
    }
}

pub type ChunkStream = std::pin::Pin<
    Box<dyn tokio_stream::Stream<Item = Result<crate::pb::ArtifactChunk, tonic::Status>> + Send>,
>;

/// AgentChannel.FetchArtifact for an identified (non-revoked) node: the
/// complete release with this digest, from `offset`. Bounded per instance
/// (`updates.max_concurrent_downloads`).
pub async fn fetch_artifact(
    state: &AppState,
    node: Uuid,
    req: crate::pb::FetchArtifactRequest,
) -> Result<ChunkStream, tonic::Status> {
    use tonic::Status;
    if req.sha256.len() != 64 || !req.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Status::invalid_argument("bad digest"));
    }
    let permit = state
        .fetch_permits()
        .clone()
        .try_acquire_owned()
        .map_err(|_| Status::resource_exhausted("too many concurrent downloads; retry later"))?;
    let row: Option<(Uuid, i64)> = sqlx::query_as(
        "SELECT id, size FROM agent_releases WHERE sha256 = $1 AND complete_at IS NOT NULL",
    )
    .bind(&req.sha256)
    .fetch_optional(state.pg())
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "artifact lookup failed");
        Status::unavailable("temporarily unavailable")
    })?;
    let Some((id, size)) = row else {
        return Err(Status::not_found("unknown artifact"));
    };
    let offset = i64::try_from(req.offset).unwrap_or(i64::MAX);
    if offset > size {
        return Err(Status::invalid_argument("offset past the end"));
    }
    tracing::info!(node = %node, release = %id, offset, "artifact download");
    let (tx, rx) = tokio::sync::mpsc::channel(2);
    let pg = state.pg().clone();
    tokio::spawn(async move {
        let _permit = permit;
        let chunk = CHUNK as i64;
        let mut idx = (offset / chunk) as i32;
        let mut skip = (offset % chunk) as usize;
        let last = ((size - 1) / chunk) as i32;
        while idx <= last {
            let data: Result<Vec<u8>, sqlx::Error> = sqlx::query_scalar(
                "SELECT data FROM agent_release_chunks WHERE release_id = $1 AND idx = $2",
            )
            .bind(id)
            .bind(idx)
            .fetch_one(&pg)
            .await;
            let msg = match data {
                Ok(mut d) => {
                    let data = if skip > 0 {
                        d.split_off(skip.min(d.len()))
                    } else {
                        d
                    };
                    skip = 0;
                    Ok(crate::pb::ArtifactChunk { data })
                }
                Err(e) => {
                    tracing::warn!(release = %id, idx, error = %e, "artifact chunk read failed");
                    Err(Status::unavailable("temporarily unavailable"))
                }
            };
            let failed = msg.is_err();
            // A peer that stops reading must not hold a download permit
            // forever.
            match tokio::time::timeout(SEND_STALL, tx.send(msg)).await {
                Ok(Ok(())) if !failed => {}
                Ok(_) => return,
                Err(_) => {
                    tracing::warn!(node = %node, release = %id, "artifact download stalled; dropped");
                    return;
                }
            }
            idx += 1;
        }
    });
    Ok(Box::pin(tokio_stream::wrappers::ReceiverStream::new(rx)))
}

/// Test signing (a throwaway release key per signer).
#[cfg(test)]
pub(crate) mod testkit {
    use super::*;

    pub struct Signer {
        kp: ring::signature::Ed25519KeyPair,
        pub key: ReleaseKey,
    }

    impl Signer {
        pub fn new() -> Self {
            let (kp, key) = tests::keypair();
            Self { kp, key }
        }

        /// The config line for `updates.release_keys`.
        pub fn config_line(&self) -> String {
            base64::engine::general_purpose::STANDARD.encode(&self.key.key)
        }

        /// A signed linux/amd64 release of `bin`.
        pub fn release(&self, version: &str, bin: &[u8]) -> CreateReleaseReq {
            self.release_for(version, "amd64", bin, false)
        }

        /// A signed linux/`arch` release of `bin`.
        pub fn release_for(
            &self,
            version: &str,
            arch: &str,
            bin: &[u8],
            rollback: bool,
        ) -> CreateReleaseReq {
            let now = Utc::now();
            let (schema, created_at, rollback_from, expires_at) = if rollback {
                (
                    2,
                    now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    Some("v999.0.0".to_string()),
                    Some(
                        (now + chrono::Duration::days(7))
                            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    ),
                )
            } else {
                (1, "2026-10-02T00:00:00Z".to_string(), None, None)
            };
            let m = Manifest {
                schema,
                version: version.into(),
                os: "linux".into(),
                arch: arch.into(),
                sha256: hex::encode(Sha256::digest(bin)),
                size: bin.len() as i64,
                min_panel_protocol: 3,
                created_at,
                rollback,
                rollback_from,
                expires_at,
            };
            self.sign_manifest(serde_json::to_string(&m).unwrap_or_default())
        }

        /// The request for an arbitrary manifest text, signed by this key.
        pub fn sign_manifest(&self, manifest: String) -> CreateReleaseReq {
            let sig = tests::sign(&self.kp, &self.key.id, manifest.as_bytes());
            CreateReleaseReq {
                manifest,
                sig: SigFile {
                    signatures: vec![sig],
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn keypair() -> (ring::signature::Ed25519KeyPair, ReleaseKey) {
        let rng = ring::rand::SystemRandom::new();
        let Ok(doc) = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng) else {
            panic!("keygen")
        };
        let Ok(kp) = ring::signature::Ed25519KeyPair::from_pkcs8(doc.as_ref()) else {
            panic!("keypair")
        };
        use ring::signature::KeyPair;
        let key = kp.public_key().as_ref().to_vec();
        (
            kp,
            ReleaseKey {
                id: key_id(&key),
                key,
                label: String::new(),
            },
        )
    }

    pub(super) fn sign(kp: &ring::signature::Ed25519KeyPair, id: &str, m: &[u8]) -> Signature {
        let mut msg = SIG_CONTEXT.to_vec();
        msg.extend_from_slice(m);
        Signature {
            key_id: id.into(),
            sig: base64::engine::general_purpose::STANDARD.encode(kp.sign(&msg).as_ref()),
        }
    }

    const M: &str = r#"{"schema":1,"version":"v1.2.3","os":"linux","arch":"amd64","sha256":"abababababababababababababababababababababababababababababababab","size":1234,"min_panel_protocol":3,"created_at":"2026-10-02T00:00:00Z","rollback":false}"#;

    #[test]
    fn verify_good_wrong_key_tampered_rotation() {
        let (kp, k) = keypair();
        let (kp2, k2) = keypair();
        let s = sign(&kp, &k.id, M.as_bytes());
        assert_eq!(
            verify(
                M.as_bytes(),
                std::slice::from_ref(&s),
                std::slice::from_ref(&k)
            )
            .as_deref(),
            Ok(k.id.as_str())
        );
        assert!(
            verify(
                M.as_bytes(),
                std::slice::from_ref(&s),
                std::slice::from_ref(&k2)
            )
            .is_err()
        );
        let tampered = M.replace("v1.2.3", "v1.2.4");
        assert!(
            verify(
                tampered.as_bytes(),
                std::slice::from_ref(&s),
                std::slice::from_ref(&k)
            )
            .is_err()
        );
        assert!(verify(M.as_bytes(), std::slice::from_ref(&s), &[]).is_err());
        // Rotation: dual-signed verifies under either key.
        let s2 = sign(&kp2, &k2.id, M.as_bytes());
        assert!(verify(M.as_bytes(), &[s, s2], std::slice::from_ref(&k2)).is_ok());
        // No context prefix = not a release signature.
        let bare = Signature {
            key_id: k.id.clone(),
            sig: base64::engine::general_purpose::STANDARD.encode(kp.sign(M.as_bytes()).as_ref()),
        };
        assert!(verify(M.as_bytes(), &[bare], &[k]).is_err());
    }

    #[test]
    fn manifest_parse_is_strict() {
        assert!(parse_manifest(M.as_bytes()).is_ok());
        for bad in [
            M.replace(r#""schema":1"#, r#""schema":2"#),
            M.replace("\"v1.2.3\"", "\"1.2.3\""),
            M.replace("\"linux\"", "\"Linux\""),
            M.replace("\"size\":1234", "\"size\":0"),
            M.replace("{", "{\"extra\":1,"),
            format!("{M}{{}}"),
            M.replace("2026-10-02T00:00:00Z", "yesterday"),
        ] {
            assert!(parse_manifest(bad.as_bytes()).is_err(), "{bad}");
        }
    }

    #[test]
    fn rollback_manifests_are_bound() {
        let rb = |from: &str, expires: &str| {
            format!(
                r#"{{"schema":2,"version":"v1.2.3","os":"linux","arch":"amd64","sha256":"{}","size":5,"min_panel_protocol":3,"created_at":"2026-10-20T00:00:00Z","rollback":true,"rollback_from":"{from}","expires_at":"{expires}"}}"#,
                "ab".repeat(32)
            )
        };
        let good = parse_manifest(rb("v1.3.0", "2026-10-27T00:00:00Z").as_bytes()).unwrap();
        let at = |t: &str| DateTime::parse_from_rfc3339(t).unwrap().with_timezone(&Utc);
        assert!(!good.expired(at("2026-10-26T23:59:59Z")));
        assert!(good.expired(at("2026-10-27T00:00:00Z")));
        // The bytes re-serialize to what was signed (they are stored
        // verbatim anyway; this keeps the test signer honest).
        assert_eq!(
            serde_json::to_string(&good).unwrap(),
            rb("v1.3.0", "2026-10-27T00:00:00Z")
        );
        for bad in [
            rb("v1.2.3", "2026-10-27T00:00:00Z"),
            rb("v1.1.0", "2026-10-27T00:00:00Z"),
            rb("1.3.0", "2026-10-27T00:00:00Z"),
            rb("v1.3.0", "2026-10-20T00:00:00Z"),
            rb("v1.3.0", "2026-11-19T00:00:01Z"),
            rb("v1.3.0", "tomorrow"),
            rb("v1.3.0", "2026-10-27T00:00:00Z").replace("\"schema\":2", "\"schema\":1"),
            rb("v1.3.0", "2026-10-27T00:00:00Z")
                .replace(",\"expires_at\":\"2026-10-27T00:00:00Z\"", ""),
            M.replace("\"rollback\":false", "\"rollback\":true"),
            M.replace(
                "\"rollback\":false",
                "\"rollback\":false,\"rollback_from\":\"v1.3.0\"",
            ),
        ] {
            assert!(parse_manifest(bad.as_bytes()).is_err(), "{bad}");
        }
        assert!(parse_manifest(rb("v1.3.0", "2026-11-19T00:00:00Z").as_bytes()).is_ok());
    }

    #[test]
    fn semver_order_matches_the_agent() {
        let order = [
            "v1.0.0-alpha",
            "v1.0.0-alpha.1",
            "v1.0.0-alpha.beta",
            "v1.0.0-beta",
            "v1.0.0-beta.2",
            "v1.0.0-beta.11",
            "v1.0.0-rc.1",
            "v1.0.0",
            "v1.0.1",
            "v1.1.0",
            "v2.0.0",
            "v10.0.0",
        ];
        for (i, a) in order.iter().enumerate() {
            for (j, b) in order.iter().enumerate() {
                assert_eq!(compare_versions(a, b), Some(i.cmp(&j)), "{a} vs {b}");
            }
        }
        assert_eq!(
            compare_versions("v1.0.0+build.1", "v1.0.0"),
            Some(Ordering::Equal)
        );
        for bad in ["dev", "1.0.0", "v01.0.0", "v1.0", "v1.0.0-", "v1.0.0-01"] {
            assert!(parse_version(bad).is_none(), "{bad}");
        }
    }

    /// The Go signer's output (akari-agent cmd/akari-sign, test key)
    /// verifies here: one wire format on both sides.
    #[test]
    fn cross_language_vector() {
        let raw = include_str!("../proto/update_vector.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
        let keys = parse_release_keys(&[v["public_key"].as_str().unwrap_or("").to_string()])
            .unwrap_or_default();
        let manifest = v["manifest"].as_str().unwrap_or("");
        let sigs: SigFile =
            serde_json::from_value(v["sig"].clone()).unwrap_or(SigFile { signatures: vec![] });
        assert_eq!(keys.len(), 1);
        assert!(parse_manifest(manifest.as_bytes()).is_ok());
        assert!(verify(manifest.as_bytes(), &sigs.signatures, &keys).is_ok());
        let tampered = manifest.replace("\"rollback\":false", "\"rollback\":true");
        assert!(verify(tampered.as_bytes(), &sigs.signatures, &keys).is_err());

        // Schema-2 rollback binding (agent audit P2-2): every case verifies
        // under the same signature rules, parses (or not) like the agent,
        // and is due only for the node and time the agent accepts.
        let cases = v["rollback_cases"].as_array().cloned().unwrap_or_default();
        assert!(cases.len() >= 10, "vector lost its rollback cases");
        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let manifest = c["manifest"].as_str().unwrap_or("");
            let sigs: SigFile =
                serde_json::from_value(c["sig"].clone()).unwrap_or(SigFile { signatures: vec![] });
            assert!(
                verify(manifest.as_bytes(), &sigs.signatures, &keys).is_ok(),
                "{name}: signature"
            );
            let parsed = parse_manifest(manifest.as_bytes());
            assert_eq!(parsed.is_ok(), c["parse_ok"] == true, "{name}: {parsed:?}");
            let Ok(m) = parsed else { continue };
            let now = DateTime::parse_from_rfc3339(c["now"].as_str().unwrap_or(""))
                .unwrap_or_default()
                .with_timezone(&Utc);
            let running = c["running"].as_str().unwrap_or("");
            let due = crate::rollout::update_due(running, &m.version, m.rollback_from.as_deref())
                && !m.expired(now);
            // `unknown_target` is the agent's own history check.
            let want = matches!(c["verdict"].as_str(), Some("ok" | "unknown_target"));
            assert_eq!(due, want, "{name}");
        }
    }
}
