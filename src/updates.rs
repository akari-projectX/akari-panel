//! M6 agent self-update: signed release manifests, the release store and
//! the artifact download RPC.
//!
//! Trust model: agents run only binaries described by a manifest signed
//! with an Ed25519 release key PINNED IN THE AGENT (akari-agent
//! `release-keys.txt`); the panel is a relay and cannot add trust. The
//! panel verifies the same signatures under `updates.release_keys` before
//! it stores or offers a release (an early, friendly refusal — not the
//! security boundary). Manifest format and signature: see "Agent
//! self-update" in proto/agent.proto; the Go reference is
//! akari-agent/release (cross-checked by `proto/update_vector.json`).
//!
//! Storage: manifest bytes verbatim + the binary in 1 MiB rows
//! (`agent_release_chunks`), so every panel instance can serve it.

use crate::auth::{bad_request, conflict};
use std::cmp::Ordering;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
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
/// Lowest agent protocol that is ever offered an update.
pub const MIN_UPDATE_PROTOCOL: u32 = 3;
/// Rows of agent_release_chunks / FetchArtifact chunks.
pub const CHUNK: usize = 1 << 20;
pub const MAX_ARTIFACT: i64 = 256 << 20;
const MAX_MANIFEST: usize = 4096;
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

/// Parses `updates.release_keys` ("<base64 32-byte key> [label]").
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

/// A release manifest (schema 1).
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
    if m.schema != 1 {
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
    if DateTime::parse_from_rfc3339(&m.created_at).is_err() {
        return Err("created_at is not RFC 3339".into());
    }
    Ok(m)
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
        return Err("no release keys configured (updates.release_keys)".into());
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
    if let Some(b) = build {
        if !b.split('.').all(ident_ok) {
            return None;
        }
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
    complete: bool,
    created_at: DateTime<Utc>,
    complete_at: Option<DateTime<Utc>>,
}

const RELEASE_VIEW_SQL: &str = "SELECT id, version, os, arch, sha256, size, key_id, \
     min_panel_protocol, rollback, complete_at IS NOT NULL AS complete, created_at, complete_at \
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
    if keys.is_empty() {
        return Err(conflict!(
            "release.no_keys",
            "no release keys configured (updates.release_keys): self-update is off"
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
            ))
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
    let keys = parse_release_keys(&state.cfg().updates.release_keys).map_err(|e| {
        tracing::error!(error = %e, "updates.release_keys invalid");
        ApiError::internal()
    })?;
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
    let mut stream = body.into_data_stream();
    let mut h = Sha256::new();
    let mut buf: Vec<u8> = Vec::with_capacity(CHUNK);
    let mut total: i64 = 0;
    let mut idx: i32 = 0;
    while let Some(frame) = stream.next().await {
        let frame =
            frame.map_err(|_| bad_request!("release.upload_interrupted", "upload interrupted"))?;
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
                insert_chunk(&mut tx, id, idx, &buf).await?;
                idx += 1;
                buf.clear();
            }
        }
    }
    if !buf.is_empty() {
        insert_chunk(&mut tx, id, idx, &buf).await?;
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
        &mut tx,
        &Actor::of(&user),
        "agent_release.upload",
        "agent_release",
        Some(id.to_string()),
        None,
        Some(json!({ "version": version, "sha256": sha, "size": total })),
    )
    .await?;
    let view = release_view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(view))
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
pub fn offer(rollout_id: Uuid, manifest: Vec<u8>, sigs: &[Signature]) -> crate::gen::UpdateOffer {
    crate::gen::UpdateOffer {
        rollout_id: rollout_id.to_string(),
        manifest,
        signatures: sigs
            .iter()
            .filter_map(|s| {
                s.bytes().map(|b| crate::gen::ManifestSignature {
                    key_id: s.key_id.clone(),
                    signature: b,
                })
            })
            .collect(),
        panel_protocol: PANEL_PROTOCOL,
    }
}

pub type ChunkStream = std::pin::Pin<
    Box<dyn tokio_stream::Stream<Item = Result<crate::gen::ArtifactChunk, tonic::Status>> + Send>,
>;

/// AgentChannel.FetchArtifact for an identified (non-revoked) node: the
/// complete release with this digest, from `offset`. Bounded per instance
/// (`updates.max_concurrent_downloads`).
pub async fn fetch_artifact(
    state: &AppState,
    node: Uuid,
    req: crate::gen::FetchArtifactRequest,
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
                    Ok(crate::gen::ArtifactChunk { data })
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
            let m = Manifest {
                schema: 1,
                version: version.into(),
                os: "linux".into(),
                arch: "amd64".into(),
                sha256: hex::encode(Sha256::digest(bin)),
                size: bin.len() as i64,
                min_panel_protocol: 3,
                created_at: "2026-10-02T00:00:00Z".into(),
                rollback: false,
            };
            let manifest = serde_json::to_string(&m).unwrap_or_default();
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
        assert!(verify(
            M.as_bytes(),
            std::slice::from_ref(&s),
            std::slice::from_ref(&k2)
        )
        .is_err());
        let tampered = M.replace("v1.2.3", "v1.2.4");
        assert!(verify(
            tampered.as_bytes(),
            std::slice::from_ref(&s),
            std::slice::from_ref(&k)
        )
        .is_err());
        assert!(verify(M.as_bytes(), std::slice::from_ref(&s), &[]).is_err());
        // Rotation: dual-signed verifies under either key.
        let s2 = sign(&kp2, &k2.id, M.as_bytes());
        assert!(verify(
            M.as_bytes(),
            &[s.clone(), s2.clone()],
            std::slice::from_ref(&k2)
        )
        .is_ok());
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
    }
}
