//! Agent enrollment and certificate rotation (M1-8).
//!
//! - `akari node add` / `POST /api/v1/nodes` create the node with a one-time
//!   enrollment token (256-bit random, only its SHA-256 stored, short TTL);
//!   the bootstrap file carries the panel address, server name, CA and the
//!   token — never a private key.
//! - `AgentEnrollment.Enroll(token, CSR)` is the one gRPC method callable
//!   without a client certificate (TLS client auth is optional at the
//!   handshake; every AgentChannel method insists on a verified one). The
//!   CSR is checked first (`install::check_csr`), then the token is burned
//!   by a conditional UPDATE under the node's row lock: two racing
//!   enrollments with one token → exactly one wins. Unknown, used, expired
//!   and deleting-node tokens are one uniform PERMISSION_DENIED with the
//!   same database work (one lookup that only matches live tokens).
//! - `AgentChannel.Renew(CSR)` (mTLS) issues a new certificate for a new
//!   key. nodes.cert_serial = newest issued; nodes.prev_cert_serial = the
//!   one renewed from, accepted until cert_serial is first seen on a
//!   connection (`promote_on_first_sight`: prev is tombstoned 'rotated') or
//!   until it expires. A renewal from prev (the agent lost the answer)
//!   tombstones the unseen cert_serial and issues another.
//! - 'rotated' tombstones are refused like unknown certificates; only
//!   'deleted' ones get the accept-then-retire treatment (grpc.rs).
//! - Every issuance, token burn and promotion is audited in its own
//!   transaction (actor `agent`, the source address).

use crate::auth::{bad_request, conflict};
use std::net::IpAddr;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use tonic::{Request, Response, Status};
use uuid::Uuid;
use x509_parser::prelude::{FromDer, X509Certificate};

use crate::audit::Actor;
use crate::auth::ApiError;
use crate::install::{self, CsrError};
use crate::pb::agent_enrollment_server::AgentEnrollment;
use crate::pb::{EnrollRequest, IssuedCertificate, RenewRequest};
use crate::state::AppState;

/// The one answer to every token problem (no oracle).
pub const ENROLL_REFUSED: &str = "enrollment refused";

/// Renewals per node per hour (a healthy agent renews every ~60 days).
const RENEW_PER_HOUR: i64 = 20;

/// A new enrollment token: 32 random bytes, base64url (43 chars).
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// Shape check before any database work.
pub(crate) fn plausible_token(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Issue (or replace) the node's enrollment token. Locks the node row
/// (lock order: nodes first); refuses deleting nodes (409) and unknown ones
/// (404). Audited as `node.enroll_token`. Returns the token (shown once)
/// and its expiry.
/// Where an install link's script downloads from (R18-2). `None` for a
/// token meant for a bootstrap file (never served as a script).
#[derive(Debug, Clone, Copy)]
pub struct InstallLink<'a> {
    /// "https://host[:port]" (validated by `nodeinstall::parse_origin`).
    pub origin: &'a str,
    /// curl --pinnedpubkey value, when the origin's certificate is not
    /// publicly trusted.
    pub pin: Option<&'a str>,
}

///
/// `endpoint` (R22) is what the token's bootstrap tells the agent
/// (panel_addr, server_name; `settings::node_endpoint` in the caller's
/// transaction): stored with the token, and its server name is recorded in
/// `grpc_server_names` so the gRPC certificate keeps covering it.
pub async fn apply_issue_token(
    conn: &mut PgConnection,
    actor: &Actor,
    node_id: Uuid,
    ttl_secs: u64,
    link: Option<InstallLink<'_>>,
    endpoint: &crate::settings::NodeEndpoint,
) -> Result<(String, DateTime<Utc>), ApiError> {
    let deleting: Option<bool> =
        sqlx::query_scalar("SELECT deleting_at IS NOT NULL FROM nodes WHERE id = $1 FOR UPDATE")
            .bind(node_id)
            .fetch_optional(&mut *conn)
            .await?;
    match deleting {
        None => return Err(ApiError::not_found()),
        Some(true) => return Err(conflict!("node.deleting", "node is being deleted")),
        Some(false) => {}
    }
    let token = generate_token();
    let expires: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO node_enrollments (node_id, token_hash, expires_at, install_origin, install_pin, \
             panel_addr, server_name) \
         VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5, $6, $7) \
         ON CONFLICT (node_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, \
             created_at = now(), expires_at = EXCLUDED.expires_at, used_at = NULL, \
             install_origin = EXCLUDED.install_origin, install_pin = EXCLUDED.install_pin, \
             panel_addr = EXCLUDED.panel_addr, server_name = EXCLUDED.server_name \
         RETURNING expires_at",
    )
    .bind(node_id)
    .bind(hash_token(&token))
    .bind(ttl_secs as f64)
    .bind(link.map(|l| l.origin))
    .bind(link.and_then(|l| l.pin))
    .bind(&endpoint.panel_addr)
    .bind(&endpoint.server_name)
    .fetch_one(&mut *conn)
    .await?;
    crate::settings::record_server_name(conn, &endpoint.server_name, "enrollment").await?;
    crate::audit::record(
        conn,
        actor,
        "node.enroll_token",
        "node",
        Some(node_id.to_string()),
        None,
        Some(json!({
            "token": crate::audit::CHANGED,
            "expires_at": expires,
            "install_link": link.is_some(),
            "panel_addr": endpoint.panel_addr,
            "server_name": endpoint.server_name,
        })),
    )
    .await?;
    Ok((token, expires))
}

/// Create a node (pending, no certificate) with its first enrollment
/// token. Audited as `node.create` + `node.enroll_token`.
pub async fn apply_create_node(
    conn: &mut PgConnection,
    actor: &Actor,
    name: &str,
    ttl_secs: u64,
    link: Option<InstallLink<'_>>,
    endpoint: &crate::settings::NodeEndpoint,
) -> Result<(Uuid, String, DateTime<Utc>), ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(bad_request!(
            "node.name_invalid",
            "name must be 1-64 characters without control characters"
        ));
    }
    let id = Uuid::new_v4();
    let inserted = sqlx::query(
        "INSERT INTO nodes (id, name, status) VALUES ($1, $2, 'pending') \
         ON CONFLICT (name) DO NOTHING",
    )
    .bind(id)
    .bind(name)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Err(conflict!(
            "node.name_exists",
            "a node with this name exists"
        ));
    }
    crate::audit::record(
        conn,
        actor,
        "node.create",
        "node",
        Some(id.to_string()),
        None,
        Some(json!({ "name": name })),
    )
    .await?;
    let (token, expires) = apply_issue_token(conn, actor, id, ttl_secs, link, endpoint).await?;
    Ok((id, token, expires))
}

/// The bootstrap file for a node (v2: no private key).
pub fn bootstrap_toml(
    name: &str,
    panel_addr: &str,
    server_name: &str,
    ca_pem: &str,
    token: &str,
    expires: DateTime<Utc>,
) -> String {
    format!(
        "# akari agent bootstrap for node '{name}'\n\
         # Contains a one-time enrollment token (expires {exp}); no private key.\n\
         # The agent generates its key locally on first start and enrolls.\n\
         panel_addr = \"{panel_addr}\"\n\
         server_name = \"{server_name}\"\n\
         enrollment_token = \"{token}\"\n\
         \n[identity]\nca_pem = '''{ca_pem}'''\n",
        exp = expires.to_rfc3339(),
    )
}

/// Verified client certificate of a request: (normalized serial,
/// not_after). Without one the call never reaches session code.
pub fn peer_cert<T>(req: &Request<T>) -> Result<(String, DateTime<Utc>), Status> {
    let certs = req
        .peer_certs()
        .ok_or_else(|| Status::unauthenticated("missing client certificate"))?;
    let der = certs
        .first()
        .ok_or_else(|| Status::unauthenticated("missing client certificate"))?;
    let (_, cert) = X509Certificate::from_der(der.as_ref())
        .map_err(|_| Status::unauthenticated("malformed certificate"))?;
    let not_after = DateTime::from_timestamp(cert.validity().not_after.timestamp(), 0)
        .ok_or_else(|| Status::unauthenticated("malformed certificate"))?;
    Ok((install::normalize_serial(cert.raw_serial()), not_after))
}

/// Tombstone a superseded serial: refused from now on like an unknown
/// certificate, and never assignable to a node again.
async fn tombstone_rotated(conn: &mut PgConnection, serial: &str, node: Uuid) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO revoked_certs (cert_serial, node_id, reason) VALUES ($1, $2, 'rotated') \
         ON CONFLICT (cert_serial) DO NOTHING",
    )
    .bind(serial)
    .bind(node)
    .execute(conn)
    .await?;
    Ok(())
}

/// First connection with a node's newest certificate while the one it
/// renewed from is still accepted: tombstone the old one ('rotated').
/// Conditional on the row still looking like that (multi-instance safe),
/// audited in the same transaction.
pub async fn promote_on_first_sight(
    pg: &sqlx::PgPool,
    node: Uuid,
    serial: &str,
    ip: Option<IpAddr>,
) -> sqlx::Result<()> {
    let mut tx = pg.begin().await?;
    let old: Option<Option<String>> = sqlx::query_scalar(
        "UPDATE nodes SET prev_cert_serial = NULL \
         WHERE id = $1 AND cert_serial = $2 AND prev_cert_serial IS NOT NULL \
         RETURNING old.prev_cert_serial",
    )
    .bind(node)
    .bind(serial)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(Some(old)) = old else {
        return Ok(());
    };
    tombstone_rotated(&mut tx, &old, node).await?;
    crate::audit::record(
        &mut tx,
        &Actor::agent(ip),
        "node.cert.rotated",
        "node",
        Some(node.to_string()),
        Some(json!({ "cert_serial": old })),
        Some(json!({ "cert_serial": serial })),
    )
    .await?;
    tx.commit().await?;
    tracing::info!(node = %node, "agent switched to its renewed certificate; old one revoked");
    Ok(())
}

/// Record the expiry of a certificate issued before nodes.cert_not_after
/// existed (v1 bootstrap files), from the certificate the agent presents.
pub async fn note_legacy_expiry(
    pg: &sqlx::PgPool,
    node: Uuid,
    serial: &str,
    not_after: DateTime<Utc>,
) {
    let r = sqlx::query(
        "UPDATE nodes SET cert_not_after = $3 \
         WHERE id = $1 AND cert_serial = $2 AND cert_not_after IS NULL",
    )
    .bind(node)
    .bind(serial)
    .bind(not_after)
    .execute(pg)
    .await;
    if let Err(e) = r {
        tracing::warn!(node = %node, error = %e, "failed to record certificate expiry");
    }
}

fn csr_status(e: CsrError) -> Status {
    Status::invalid_argument(e.to_string())
}

fn db_unavailable(what: &str, e: impl std::fmt::Display) -> Status {
    tracing::error!(error = %e, "{what}");
    Status::unavailable("temporarily unavailable")
}

async fn within(state: &AppState, key: String, limit: i64, window: i64) -> bool {
    // Valkey unavailable: fail open, bounded by the in-process fallback
    // (W9). Tokens are 256-bit: the limit protects CPU/DB, not secrecy.
    crate::rate::hit_or_local(state, "enroll", key, limit, window).await
}

pub struct AgentEnrollmentService {
    pub state: AppState,
}

#[tonic::async_trait]
impl AgentEnrollment for AgentEnrollmentService {
    async fn enroll(
        &self,
        request: Request<EnrollRequest>,
    ) -> Result<Response<IssuedCertificate>, Status> {
        let ip = request.remote_addr().map(|a| a.ip());
        let issued = enroll(&self.state, ip, request.into_inner()).await?;
        Ok(Response::new(issued))
    }
}

/// Enroll: rate limits (per source, then global), CSR, then the token.
pub async fn enroll(
    state: &AppState,
    ip: Option<IpAddr>,
    req: EnrollRequest,
) -> Result<IssuedCertificate, Status> {
    let cfg = &state.cfg().limits;
    let bucket = ip
        .map(crate::client_ip::bucket)
        .unwrap_or_else(|| "unknown".into());
    if !within(
        state,
        format!("akari:rl:enroll:ip:{bucket}"),
        cfg.enroll_rate_per_ip,
        cfg.enroll_rate_window_secs,
    )
    .await
        || !within(
            state,
            "akari:rl:enroll:all".into(),
            cfg.enroll_rate_global,
            cfg.enroll_rate_window_secs,
        )
        .await
    {
        crate::metrics::enroll("rate_limited");
        return Err(Status::resource_exhausted("too many enrollment attempts"));
    }
    let key = install::check_csr(&req.csr_der).map_err(|e| {
        crate::metrics::enroll("bad_csr");
        csr_status(e)
    })?;
    if !plausible_token(&req.token) {
        crate::metrics::enroll("refused");
        return Err(Status::permission_denied(ENROLL_REFUSED));
    }
    let hash = hash_token(&req.token);
    match burn_and_issue(state, &hash, &key, ip).await {
        Ok(Some(issued)) => {
            crate::metrics::enroll("ok");
            Ok(issued)
        }
        Ok(None) => {
            crate::metrics::enroll("refused");
            Err(Status::permission_denied(ENROLL_REFUSED))
        }
        Err(e) => Err(db_unavailable("enrollment failed", e)),
    }
}

/// The token transaction. None = refused (uniform).
async fn burn_and_issue(
    state: &AppState,
    hash: &[u8],
    key: &install::CsrKey,
    ip: Option<IpAddr>,
) -> anyhow::Result<Option<IssuedCertificate>> {
    let mut tx = state.pg().begin().await?;
    // One indexed lookup that only matches live tokens: unknown, used and
    // expired cost the same.
    let found: Option<(Uuid, Vec<u8>)> = sqlx::query_as(
        "SELECT node_id, token_hash FROM node_enrollments \
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    )
    .bind(hash)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((node, stored)) = found else {
        return Ok(None);
    };
    // Belt and braces: the index lookup already matched; compare the
    // hashes in constant time anyway.
    if !bool::from(subtle::ConstantTimeEq::ct_eq(stored.as_slice(), hash)) {
        return Ok(None);
    }
    // Lock order: the node row first, then its enrollment row.
    let row: Option<(bool, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT deleting_at IS NOT NULL, cert_serial, prev_cert_serial FROM nodes \
         WHERE id = $1 FOR UPDATE",
    )
    .bind(node)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((deleting, old_serial, old_prev)) = row else {
        return Ok(None);
    };
    if deleting {
        return Ok(None);
    }
    // The burn. Conditional: a concurrent enrollment that got here first
    // (it held the row lock) left used_at set → 0 rows.
    let burned = sqlx::query(
        "UPDATE node_enrollments SET used_at = now() \
         WHERE node_id = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()",
    )
    .bind(node)
    .bind(hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if burned != 1 {
        return Ok(None);
    }
    let inst = state.install();
    let issued = install::sign_agent_csr(
        &inst.ca_pem,
        &inst.ca_key_pem,
        &node.to_string(),
        key,
        state.cfg().limits.cert_validity_secs,
    )?;
    // Re-enrollment of a node that had certificates: they are superseded.
    for s in [&old_serial, &old_prev].into_iter().flatten() {
        tombstone_rotated(&mut tx, s, node).await?;
    }
    sqlx::query(
        "UPDATE nodes SET cert_serial = $2, prev_cert_serial = NULL, cert_not_after = $3, \
             server_name = (SELECT server_name FROM node_enrollments WHERE node_id = $1), \
             enrolled_at = now() \
         WHERE id = $1",
    )
    .bind(node)
    .bind(&issued.serial)
    .bind(issued.not_after)
    .execute(&mut *tx)
    .await?;
    crate::audit::record(
        &mut tx,
        &Actor::agent(ip),
        "node.enroll",
        "node",
        Some(node.to_string()),
        Some(json!({ "cert_serial": old_serial })),
        Some(json!({ "cert_serial": issued.serial, "cert_not_after": issued.not_after })),
    )
    .await?;
    tx.commit().await?;
    tracing::info!(node = %node, "agent enrolled");
    Ok(Some(IssuedCertificate {
        cert_pem: issued.cert_pem,
        ca_pem: inst.ca_pem.clone(),
    }))
}

/// AgentChannel.Renew: the caller is identified by its verified client
/// certificate only.
pub async fn renew(
    state: &AppState,
    request: Request<RenewRequest>,
) -> Result<IssuedCertificate, Status> {
    let (serial, _) = peer_cert(&request)?;
    let ip = request.remote_addr().map(|a| a.ip());
    let req = request.into_inner();
    let key = install::check_csr(&req.csr_der).map_err(csr_status)?;
    let mut tx = state
        .pg()
        .begin()
        .await
        .map_err(|e| db_unavailable("renewal failed", e))?;
    let r = renew_in_tx(state, &mut tx, &serial, &key, ip).await;
    match r {
        Ok(issued) => {
            tx.commit()
                .await
                .map_err(|e| db_unavailable("renewal commit failed", e))?;
            crate::metrics::enroll("renewed");
            Ok(issued)
        }
        Err(RenewError::Status(s)) => Err(s),
        Err(RenewError::Other(e)) => Err(db_unavailable("renewal failed", e)),
    }
}

enum RenewError {
    Status(Status),
    Other(anyhow::Error),
}

impl From<sqlx::Error> for RenewError {
    fn from(e: sqlx::Error) -> Self {
        RenewError::Other(e.into())
    }
}

impl From<anyhow::Error> for RenewError {
    fn from(e: anyhow::Error) -> Self {
        RenewError::Other(e)
    }
}

async fn renew_in_tx(
    state: &AppState,
    tx: &mut PgConnection,
    serial: &str,
    key: &install::CsrKey,
    ip: Option<IpAddr>,
) -> Result<IssuedCertificate, RenewError> {
    // Tombstones first (hard invariant).
    let revoked: Option<String> =
        sqlx::query_scalar("SELECT reason FROM revoked_certs WHERE cert_serial = $1")
            .bind(serial)
            .fetch_optional(&mut *tx)
            .await?;
    if revoked.is_some() {
        return Err(RenewError::Status(Status::unauthenticated(
            "unknown certificate",
        )));
    }
    let row: Option<(Uuid, Option<String>, Option<String>, bool)> = sqlx::query_as(
        "SELECT id, cert_serial, prev_cert_serial, deleting_at IS NOT NULL FROM nodes \
         WHERE cert_serial = $1 OR prev_cert_serial = $1 FOR UPDATE",
    )
    .bind(serial)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((node, current, prev, deleting)) = row else {
        return Err(RenewError::Status(Status::unauthenticated(
            "unknown certificate",
        )));
    };
    if deleting {
        return Err(RenewError::Status(Status::failed_precondition(
            "node is being deleted",
        )));
    }
    if !crate::rate::hit(
        state,
        format!("akari:rl:renew:{node}"),
        RENEW_PER_HOUR,
        3600,
    )
    .await
    .unwrap_or(true)
    {
        return Err(RenewError::Status(Status::resource_exhausted(
            "too many renewals",
        )));
    }
    let inst = state.install();
    let issued = install::sign_agent_csr(
        &inst.ca_pem,
        &inst.ca_key_pem,
        &node.to_string(),
        key,
        state.cfg().limits.cert_validity_secs,
    )?;
    // The caller's certificate stays accepted (prev) until the new one is
    // seen. Whatever else was pending is superseded:
    let superseded = if current.as_deref() == Some(serial) {
        // a renewal from the current certificate: an older prev cannot be
        // in use any more (current is);
        prev
    } else {
        // a renewal from prev: the newest one was never seen (the agent
        // lost it).
        current
    };
    if let Some(s) = &superseded {
        tombstone_rotated(tx, s, node).await?;
    }
    sqlx::query(
        "UPDATE nodes SET cert_serial = $2, prev_cert_serial = $3, cert_not_after = $4 \
         WHERE id = $1",
    )
    .bind(node)
    .bind(&issued.serial)
    .bind(serial)
    .bind(issued.not_after)
    .execute(&mut *tx)
    .await?;
    crate::audit::record(
        tx,
        &Actor::agent(ip),
        "node.cert.renew",
        "node",
        Some(node.to_string()),
        Some(json!({ "cert_serial": serial })),
        Some(json!({ "cert_serial": issued.serial, "cert_not_after": issued.not_after })),
    )
    .await?;
    tracing::info!(node = %node, "agent certificate renewed");
    Ok(IssuedCertificate {
        cert_pem: issued.cert_pem,
        ca_pem: inst.ca_pem.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::TestDb;
    use crate::testdb::fake_agent::{AgentCreds, PanelHarness};
    use tonic::Code;

    /// The default config's node endpoint.
    pub(crate) fn test_endpoint() -> crate::settings::NodeEndpoint {
        crate::settings::NodeEndpoint {
            panel_addr: "127.0.0.1:8443".into(),
            server_name: "localhost".into(),
        }
    }

    async fn token_for(db: &TestDb, node: Uuid) -> String {
        let mut tx = db.pool.begin().await.unwrap();
        let (t, _) = apply_issue_token(&mut tx, &Actor::test(), node, 3600, None, &test_endpoint())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        t
    }

    async fn serials(db: &TestDb, node: Uuid) -> (Option<String>, Option<String>) {
        sqlx::query_as("SELECT cert_serial, prev_cert_serial FROM nodes WHERE id = $1")
            .bind(node)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    }

    async fn tombstone(db: &TestDb, serial: &str) -> Option<String> {
        sqlx::query_scalar("SELECT reason FROM revoked_certs WHERE cert_serial = $1")
            .bind(serial)
            .fetch_optional(&db.pool)
            .await
            .unwrap()
    }

    fn serial_of(c: &AgentCreds) -> String {
        let (_, p) = x509_parser::pem::parse_x509_pem(c.cert.as_bytes()).unwrap();
        let (_, cert) = X509Certificate::from_der(&p.contents).unwrap();
        install::normalize_serial(cert.raw_serial())
    }

    /// Connect, Hello, get the first snapshot: the certificate is served.
    async fn served(panel: &PanelHarness, c: &AgentCreds) {
        let mut a = panel.connect(c).await.expect("served");
        a.hello_v((0, 0), String::new(), 2).await;
        a.snapshot().await;
    }

    /// The certificate never gets a working channel; the status code.
    async fn refused(panel: &PanelHarness, c: &AgentCreds) -> Code {
        match panel.connect(c).await {
            Err(st) => st.code(),
            Ok(mut a) => {
                a.hello((0, 0), String::new()).await;
                match a.next().await {
                    Some(Err(st)) => st.code(),
                    other => panic!("expected a refusal, got {other:?}"),
                }
            }
        }
    }

    async fn actions(db: &TestDb, node: Uuid) -> Vec<(String, String)> {
        sqlx::query_as("SELECT actor_label, action FROM audit_log WHERE target_id = $1 ORDER BY id")
            .bind(node.to_string())
            .fetch_all(&db.pool)
            .await
            .unwrap()
    }

    fn csr_der() -> Vec<u8> {
        let key = rcgen::KeyPair::generate().unwrap();
        rcgen::CertificateParams::default()
            .serialize_request(&key)
            .unwrap()
            .der()
            .to_vec()
    }

    /// Key-less bootstrap → Enroll without a client certificate → the
    /// issued certificate is served; the token is single use; AgentChannel
    /// refuses a client without a certificate while Enroll works.
    #[tokio::test]
    async fn enroll_then_serve_and_token_is_single_use() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let panel = PanelHarness::start(&db).await;
        let mut tx = db.pool.begin().await.unwrap();
        let (node, token, _) = apply_create_node(
            &mut tx,
            &Actor::test(),
            "n-enroll",
            3600,
            None,
            &test_endpoint(),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(serials(&db, node).await, (None, None), "no certificate yet");
        let stored: Vec<u8> =
            sqlx::query_scalar("SELECT token_hash FROM node_enrollments WHERE node_id = $1")
                .bind(node)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(stored, hash_token(&token), "only the hash is stored");

        // No client certificate: the channel is refused before any session.
        let anon = match panel.connect_anonymous().await {
            Err(st) => st.code(),
            Ok(mut a) => {
                a.hello((0, 0), String::new()).await;
                a.next().await.unwrap().unwrap_err().code()
            }
        };
        assert_eq!(anon, Code::Unauthenticated);
        assert_eq!(panel.state.agents().len(), 0);
        let r = panel.renew(None).await.unwrap_err();
        assert_eq!(
            r.code(),
            Code::Unauthenticated,
            "Renew needs a certificate too"
        );

        let creds = panel.enroll(&token).await.expect("enroll");
        let serial = serial_of(&creds);
        assert_eq!(serials(&db, node).await, (Some(serial.clone()), None));
        let enrolled: bool = sqlx::query_scalar(
            "SELECT enrolled_at > now() - interval '1 minute' FROM nodes WHERE id = $1",
        )
        .bind(node)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(enrolled, "W23: the enrollment time is recorded");
        let not_after: Option<chrono::DateTime<Utc>> =
            sqlx::query_scalar("SELECT cert_not_after FROM nodes WHERE id = $1")
                .bind(node)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        let days = (not_after.unwrap() - Utc::now()).num_days();
        assert!((89..=90).contains(&days), "{days}");
        served(&panel, &creds).await;

        // Reuse: the uniform refusal.
        let again = panel.enroll(&token).await.unwrap_err();
        assert_eq!(
            (again.code(), again.message()),
            (Code::PermissionDenied, ENROLL_REFUSED)
        );
        assert_eq!(
            actions(&db, node).await,
            [
                ("test", "node.create"),
                ("test", "node.enroll_token"),
                ("agent", "node.enroll"),
            ]
            .map(|(a, b)| (a.to_string(), b.to_string()))
        );
        let text: String = sqlx::query_scalar("SELECT string_agg(after::text, ' ') FROM audit_log")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(!text.contains(&token), "token never audited");
        panel.stop().await;
        db.drop().await;
    }

    /// Unknown, used, expired, malformed, deleting-node tokens: one answer.
    /// A bad CSR is refused before the token, which stays usable.
    #[tokio::test]
    async fn token_errors_are_uniform_and_csr_checked_first() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let panel = PanelHarness::start(&db).await;
        let st = &panel.state;
        let ip = Some(crate::testdb::http::rand_ip());
        let req = |token: &str, csr: Vec<u8>| EnrollRequest {
            token: token.into(),
            csr_der: csr,
        };
        let node = db.node().await;

        // Bad CSRs: INVALID_ARGUMENT, token untouched.
        let token = token_for(&db, node).await;
        let sans = {
            let key = rcgen::KeyPair::generate().unwrap();
            let mut p = rcgen::CertificateParams::default();
            p.subject_alt_names = vec![rcgen::SanType::DnsName("x.example".try_into().unwrap())];
            p.serialize_request(&key).unwrap().der().to_vec()
        };
        let ed = {
            let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
            rcgen::CertificateParams::default()
                .serialize_request(&key)
                .unwrap()
                .der()
                .to_vec()
        };
        for csr in [sans, ed, b"junk".to_vec()] {
            let e = enroll(st, ip, req(&token, csr)).await.unwrap_err();
            assert_eq!(e.code(), Code::InvalidArgument);
        }
        // Still unused: works now.
        enroll(st, ip, req(&token, csr_der())).await.unwrap();

        let mut refusals = Vec::new();
        // used
        refusals.push(enroll(st, ip, req(&token, csr_der())).await.unwrap_err());
        // unknown (well-formed) and malformed
        refusals.push(
            enroll(st, ip, req(&generate_token(), csr_der()))
                .await
                .unwrap_err(),
        );
        refusals.push(enroll(st, ip, req("short", csr_der())).await.unwrap_err());
        // expired
        let n2 = db.node().await;
        let t2 = token_for(&db, n2).await;
        sqlx::query(
            "UPDATE node_enrollments SET expires_at = now() - interval '1 s' WHERE node_id = $1",
        )
        .bind(n2)
        .execute(&db.pool)
        .await
        .unwrap();
        refusals.push(enroll(st, ip, req(&t2, csr_der())).await.unwrap_err());
        // node being deleted
        let n3 = db.node().await;
        let t3 = token_for(&db, n3).await;
        let mut tx = db.pool.begin().await.unwrap();
        crate::api::apply_begin_delete_node(&mut tx, &Actor::test(), n3)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        refusals.push(enroll(st, ip, req(&t3, csr_der())).await.unwrap_err());
        // A replaced token is dead.
        let n4 = db.node().await;
        let old = token_for(&db, n4).await;
        let _new = token_for(&db, n4).await;
        refusals.push(enroll(st, ip, req(&old, csr_der())).await.unwrap_err());
        for r in &refusals {
            assert_eq!(
                (r.code(), r.message()),
                (Code::PermissionDenied, ENROLL_REFUSED)
            );
        }
        // A deleting node cannot get a token either.
        let mut tx = db.pool.begin().await.unwrap();
        let e = apply_issue_token(&mut tx, &Actor::test(), n3, 3600, None, &test_endpoint())
            .await
            .unwrap_err();
        assert_eq!(e.status(), axum::http::StatusCode::CONFLICT);
        drop(tx);
        panel.stop().await;
        db.drop().await;
    }

    /// Two enrollments racing with one token: exactly one wins.
    #[tokio::test]
    async fn concurrent_enrollments_with_one_token_one_wins() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let panel = PanelHarness::start(&db).await;
        for _ in 0..10 {
            let node = db.node().await;
            let token = token_for(&db, node).await;
            let tasks: Vec<_> = (0..4)
                .map(|_| {
                    let st = panel.state.clone();
                    let token = token.clone();
                    tokio::spawn(async move {
                        enroll(
                            &st,
                            Some(crate::testdb::http::rand_ip()),
                            EnrollRequest {
                                token,
                                csr_der: csr_der(),
                            },
                        )
                        .await
                    })
                })
                .collect();
            let mut ok = 0;
            for t in tasks {
                match t.await.unwrap() {
                    Ok(_) => ok += 1,
                    Err(e) => assert_eq!(e.code(), Code::PermissionDenied, "{e:?}"),
                }
            }
            assert_eq!(ok, 1);
            let issued: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM audit_log WHERE action = 'node.enroll' AND target_id = $1",
            )
            .bind(node.to_string())
            .fetch_one(&db.pool)
            .await
            .unwrap();
            assert_eq!(issued, 1);
        }
        panel.stop().await;
        db.drop().await;
    }

    /// Per-source rate limit (RESOURCE_EXHAUSTED before any other check).
    #[tokio::test]
    async fn enrollment_is_rate_limited_per_source() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let panel = PanelHarness::start_with(&db, |c| c.limits.enroll_rate_per_ip = 3).await;
        let ip = crate::testdb::http::rand_ip();
        let req = || EnrollRequest {
            token: generate_token(),
            csr_der: csr_der(),
        };
        for _ in 0..3 {
            let e = enroll(&panel.state, Some(ip), req()).await.unwrap_err();
            assert_eq!(e.code(), Code::PermissionDenied);
        }
        let e = enroll(&panel.state, Some(ip), req()).await.unwrap_err();
        assert_eq!(e.code(), Code::ResourceExhausted);
        let other = crate::testdb::http::rand_ip();
        let e = enroll(&panel.state, Some(other), req()).await.unwrap_err();
        assert_eq!(e.code(), Code::PermissionDenied, "other sources unaffected");
        let key = format!("akari:rl:enroll:ip:{}", crate::client_ip::bucket(ip));
        let ttl: i64 = fred::prelude::KeysInterface::ttl(panel.state.valkey(), &key)
            .await
            .unwrap();
        assert!(ttl > 0 && ttl <= 600, "bounded key: {ttl}");
        panel.stop().await;
        db.drop().await;
    }

    /// Renewal: new cert recorded, the old one stays valid until the new
    /// one is seen (crash between receive and persist), a renewal from the
    /// old one replaces the unseen one, first sight of the newest retires
    /// the old one ('rotated' = refused, not retired).
    #[tokio::test]
    async fn renewal_rotation_and_crash_safety() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (node, _u) = db.member().await;
        let panel = PanelHarness::start(&db).await;
        let token = token_for(&db, node).await;
        let a = panel.enroll(&token).await.unwrap();
        served(&panel, &a).await;

        let b = panel.renew(Some(&a)).await.expect("renew");
        assert_eq!(
            serials(&db, node).await,
            (Some(serial_of(&b)), Some(serial_of(&a)))
        );
        // "Crash" before persisting b: a still works.
        served(&panel, &a).await;
        // Renew again from a: b (never seen) is superseded.
        let c = panel.renew(Some(&a)).await.expect("renew from prev");
        assert_eq!(
            serials(&db, node).await,
            (Some(serial_of(&c)), Some(serial_of(&a)))
        );
        assert_eq!(
            tombstone(&db, &serial_of(&b)).await.as_deref(),
            Some("rotated")
        );
        assert_eq!(refused(&panel, &b).await, Code::Unauthenticated);
        assert_eq!(
            panel.renew(Some(&b)).await.unwrap_err().code(),
            Code::Unauthenticated
        );
        // First sight of c retires a.
        served(&panel, &c).await;
        assert_eq!(serials(&db, node).await, (Some(serial_of(&c)), None));
        assert_eq!(
            tombstone(&db, &serial_of(&a)).await.as_deref(),
            Some("rotated")
        );
        assert_eq!(refused(&panel, &a).await, Code::Unauthenticated);
        // Renewal from c: plain rotation.
        let d = panel.renew(Some(&c)).await.unwrap();
        assert_eq!(
            serials(&db, node).await,
            (Some(serial_of(&d)), Some(serial_of(&c)))
        );
        let acts: Vec<String> = actions(&db, node)
            .await
            .into_iter()
            .filter(|(who, _)| who == "agent")
            .map(|(_, a)| a)
            .collect();
        assert_eq!(
            acts,
            [
                "node.enroll",
                "node.cert.renew",
                "node.cert.renew",
                "node.cert.rotated",
                "node.cert.renew"
            ]
        );

        // Deleting: renewal refused; phase 2 tombstones BOTH live serials
        // as 'deleted' and upgrades the rotated ones.
        let mut tx = db.pool.begin().await.unwrap();
        crate::api::apply_begin_delete_node(&mut tx, &Actor::test(), node)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            panel.renew(Some(&c)).await.unwrap_err().code(),
            Code::FailedPrecondition
        );
        sqlx::query("UPDATE nodes SET deleting_at = now() - interval '1 hour' WHERE id = $1")
            .bind(node)
            .execute(&db.pool)
            .await
            .unwrap();
        let mut tx = db.pool.begin().await.unwrap();
        assert!(
            crate::reaper::finalize_delete(&mut tx, node)
                .await
                .unwrap()
                .is_some()
        );
        tx.commit().await.unwrap();
        for x in [&a, &b, &c, &d] {
            assert_eq!(
                tombstone(&db, &serial_of(x)).await.as_deref(),
                Some("deleted")
            );
        }
        panel.stop().await;
        db.drop().await;
    }

    /// A v1 agent (panel-generated key in its bootstrap file, protocol 1)
    /// keeps working; its certificate's expiry is learned on connect.
    #[tokio::test]
    async fn v1_certificate_and_protocol_1_agent_unaffected() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let (node, _u) = db.member().await;
        let panel = PanelHarness::start(&db).await;
        let v1 = panel.register(&db, node).await;
        let mut a = panel.connect(&v1).await.unwrap();
        a.hello_v((0, 0), String::new(), 1).await;
        let snap = a.snapshot().await;
        assert_eq!(snap.users.len(), 1, "protocol 1 is served normally");
        let not_after: Option<chrono::DateTime<Utc>> =
            sqlx::query_scalar("SELECT cert_not_after FROM nodes WHERE id = $1")
                .bind(node)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert!(not_after.is_some_and(|t| t > Utc::now() + chrono::Duration::days(700)));
        // It may migrate onto a local key at any time (Renew works for v1
        // certificates too).
        let fresh = panel.renew(Some(&v1)).await.unwrap();
        served(&panel, &fresh).await;
        assert_eq!(
            tombstone(&db, &serial_of(&v1)).await.as_deref(),
            Some("rotated")
        );
        panel.stop().await;
        db.drop().await;
    }
}
