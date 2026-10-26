//! DNS management: the admin console manages the Cloudflare DNS of every
//! zone its tokens can see (PLAN-next「DNS 管理」).
//!
//! * **Cloudflare is the only source of truth.** Zones and records are
//!   fetched on every request and never stored; the database holds only the
//!   API tokens (`accounts`, sealed with the master key, owner-only) and the
//!   audit log.
//! * Every call goes through `cloudflare::Client` → `outbound` (SSRF guard)
//!   to `api.cloudflare.com` only; the token never appears in a response, a
//!   log line or an audit row.
//! * Every record write is audited (`dns.record.*`, before/after values, no
//!   token) right after Cloudflare accepted it. The network call cannot
//!   share a transaction with the audit row, so it never runs inside one.
//! * **Dangerous records** — names the panel itself depends on (site
//!   domains, the passkey centre, a server's certificate domain, an
//!   entrance's connect address; `records::managed`) — are shown with what
//!   uses them, and deleting or changing one needs `confirm`.
//! * Cloudflare errors keep their meaning as coded API errors (`dns.*`).

pub mod accounts;
pub mod cloudflare;
pub mod link;
pub mod records;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::api::ApiJson;
use crate::audit::{self, Actor};
use crate::auth::{ApiError, AuthUser, bad_request, conflict};
use crate::state::AppState;
use cloudflare::{Client, DnsError, Record};
use records::{Managed, RecordReq, Use};

/// Batch operations touch at most this many records per request.
const BATCH_MAX: usize = 100;
/// Test connection: at most this many zone names are listed.
const TEST_SAMPLE: usize = 20;

fn token_unreadable() -> ApiError {
    conflict!(
        "dns.stored_token_unreadable",
        "the stored token cannot be opened (data/master.key changed); paste it again"
    )
}

/// Zone and record ids are 32 hex digits; anything else never reaches the
/// request path.
fn cf_id(s: &str) -> Result<&str, ApiError> {
    if s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(s)
    } else {
        Err(ApiError::not_found())
    }
}

/// The saved account and a client for its token.
async fn client_of(state: &AppState, id: Uuid) -> Result<(accounts::Row, Client), ApiError> {
    let mut conn = state.pg().acquire().await?;
    let row = accounts::load(&mut conn, id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    drop(conn);
    let client = client_of_row(state, &row)?;
    Ok((row, client))
}

/// A client for the token of `row`.
fn client_of_row(state: &AppState, row: &accounts::Row) -> Result<Client, ApiError> {
    let token = accounts::open_token(state.master_key(), row).ok_or_else(token_unreadable)?;
    Ok(Client::new(&state.cfg().limits.cloudflare_api_base, token))
}

async fn managed(state: &AppState) -> Result<Managed, ApiError> {
    let mut conn = state.pg().acquire().await?;
    Ok(records::managed(&mut conn).await?)
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// GET /dns/accounts (admin).
async fn list_accounts(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut conn = state.pg().acquire().await?;
    let rows = accounts::load_all(&mut conn).await?;
    let views: Vec<accounts::View> = rows.iter().map(accounts::View::from).collect();
    Ok(Json(json!({ "accounts": views })))
}

/// POST /dns/accounts (owner).
async fn create_account(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<accounts::AccountReq>,
) -> Result<(StatusCode, Json<accounts::View>), ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let row = accounts::apply_create(&mut tx, state.master_key(), &Actor::of(&user), &req).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json((&row).into())))
}

/// PUT /dns/accounts/{id} (owner).
async fn update_account(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<accounts::AccountReq>,
) -> Result<Json<accounts::View>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let row =
        accounts::apply_update(&mut tx, state.master_key(), &Actor::of(&user), id, &req).await?;
    tx.commit().await?;
    Ok(Json((&row).into()))
}

/// DELETE /dns/accounts/{id} (owner).
async fn delete_account(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    accounts::apply_delete(&mut tx, &Actor::of(&user), id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The error of a failed call as a test outcome the console can show.
fn failure(e: DnsError) -> Value {
    let e = ApiError::from(e);
    json!({ "ok": false, "code": e.code(), "message": e.message(), "params": e.params() })
}

/// POST /dns/accounts/{id}/test (admin): list the zones the token sees and
/// the permission Cloudflare reports for each.
async fn test_account(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let allowed = crate::rate::hit(&state, format!("akari:rl:dnstest:{}", user.id), 10, 60)
        .await
        .unwrap_or(true);
    if !allowed {
        return Err(ApiError::too_many());
    }
    let (_, client) = client_of(&state, id).await?;
    let zones = match client.zones().await {
        Ok(z) => z,
        Err(e) => return Ok(Json(failure(e))),
    };
    let editable = zones.iter().filter(|z| z.can_edit() == Some(true)).count();
    let read_only = zones.iter().filter(|z| z.can_edit() == Some(false)).count();
    let sample: Vec<&str> = zones
        .iter()
        .take(TEST_SAMPLE)
        .map(|z| z.name.as_str())
        .collect();
    Ok(Json(json!({
        "ok": true, "zones": zones.len(), "editable": editable, "read_only": read_only,
        "unknown": zones.len() - editable - read_only, "sample": sample,
    })))
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ZoneView {
    account_id: Uuid,
    account_name: String,
    #[serde(flatten)]
    zone: cloudflare::Zone,
    can_edit: Option<bool>,
}

/// Every token's zones, fetched concurrently (a token that fails is its own
/// error; the others still answer). `None` = the stored token cannot be opened.
async fn fetch_zones(
    state: &AppState,
) -> Result<
    Vec<(
        accounts::Row,
        Option<Result<Vec<cloudflare::Zone>, DnsError>>,
    )>,
    ApiError,
> {
    let mut conn = state.pg().acquire().await?;
    let rows = accounts::load_all(&mut conn).await?;
    drop(conn);
    let mut tasks = tokio::task::JoinSet::new();
    for (index, row) in rows.iter().enumerate() {
        let Some(token) = accounts::open_token(state.master_key(), row) else {
            continue;
        };
        let client = Client::new(&state.cfg().limits.cloudflare_api_base, token);
        tasks.spawn(async move { (index, client.zones().await) });
    }
    let mut answers: HashMap<usize, Result<Vec<cloudflare::Zone>, DnsError>> = HashMap::new();
    while let Some(done) = tasks.join_next().await {
        if let Ok((index, result)) = done {
            answers.insert(index, result);
        }
    }
    Ok(rows
        .into_iter()
        .enumerate()
        .map(|(i, row)| (row, answers.remove(&i)))
        .collect())
}

/// GET /dns/zones (admin): the zones of every token. A token that fails
/// is reported next to the zones of the others.
async fn list_zones(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let fetched = fetch_zones(&state).await?;
    let (mut zones, mut errors) = (Vec::new(), Vec::new());
    for (row, answer) in fetched {
        match answer {
            Some(Ok(list)) => zones.extend(list.into_iter().map(|zone| ZoneView {
                account_id: row.id,
                account_name: row.name.clone(),
                can_edit: zone.can_edit(),
                zone,
            })),
            Some(Err(e)) => errors.push(error_entry(&row, ApiError::from(e))),
            None => errors.push(error_entry(&row, token_unreadable())),
        }
    }
    zones.sort_by(|a, b| a.zone.name.cmp(&b.zone.name));
    Ok(Json(json!({ "zones": zones, "errors": errors })))
}

fn error_entry(row: &accounts::Row, e: ApiError) -> Value {
    json!({ "account_id": row.id, "account_name": row.name,
            "code": e.code(), "message": e.message(), "params": e.params() })
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ListQuery {
    search: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
}

#[derive(Serialize)]
struct RecordView {
    #[serde(flatten)]
    record: Record,
    /// What in the panel depends on this name (empty = nothing).
    uses: Vec<Use>,
}

fn view_of(managed: &Managed, record: Record) -> RecordView {
    let uses = records::uses_of(managed, &record.name).to_vec();
    RecordView { record, uses }
}

/// GET /dns/accounts/{account}/zones/{zone}/records (admin).
async fn list_records(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, account, zone)): Path<(String, Uuid, String)>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let zone = cf_id(&zone)?;
    let search = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if search.is_some_and(|s| s.chars().count() > 100 || s.chars().any(char::is_control)) {
        return Err(bad_request!(
            "dns.query_invalid",
            "the search text is invalid"
        ));
    }
    let kind = match q.kind.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        None => None,
        Some(k) => Some(
            records::TYPES
                .iter()
                .copied()
                .find(|t| t.eq_ignore_ascii_case(k))
                .ok_or_else(|| bad_request!("dns.query_invalid", "unknown record type"))?,
        ),
    };
    let page = q.page.unwrap_or(1).clamp(1, 100_000);
    let per_page = q.per_page.unwrap_or(50).clamp(5, 100);
    let (_, client) = client_of(&state, account).await?;
    let (list, info) = client.records(zone, search, kind, page, per_page).await?;
    let managed = managed(&state).await?;
    let list: Vec<RecordView> = list.into_iter().map(|r| view_of(&managed, r)).collect();
    Ok(Json(json!({ "records": list, "page_info": info })))
}

/// The 409 asking the admin to confirm changes to records the panel
/// depends on.
fn confirm_required(items: &[(String, Vec<Use>)]) -> ApiError {
    let names = items
        .iter()
        .map(|(n, _)| n.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let impact: Vec<Value> = items
        .iter()
        .map(|(name, uses)| json!({ "name": name, "uses": uses }))
        .collect();
    conflict!(
        "dns.confirm_required",
        "the panel depends on {names}: confirm the change",
        names = names,
        impact = impact
    )
}

/// One record write to audit.
struct Written<'a> {
    action: &'static str,
    account: &'a accounts::Row,
    zone: &'a str,
    record_id: &'a str,
    before: Option<&'a Record>,
    after: Option<&'a Record>,
}

/// The audit row of one record write.
async fn audit_record_inner(
    state: &AppState,
    user: &AuthUser,
    w: Written<'_>,
) -> Result<(), ApiError> {
    let wrap = |r: &Record| json!({ "account": w.account.name, "zone": r.zone_name, "record": records::audit_view(r) });
    let mut tx = state.pg().begin().await?;
    audit::record(
        &mut tx,
        &Actor::of(user),
        w.action,
        "dns_record",
        Some(format!("{}/{}", w.zone, w.record_id)),
        w.before.map(wrap),
        w.after.map(wrap),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// [`audit_record_inner`] for a write Cloudflare already accepted: when the
/// audit row cannot be written the change is live without a trace, so the
/// failure is logged with what changed (never a token) before the 500.
async fn audit_record(state: &AppState, user: &AuthUser, w: Written<'_>) -> Result<(), ApiError> {
    let (action, zone, record_id) = (w.action, w.zone.to_string(), w.record_id.to_string());
    let name = w.after.or(w.before).map(|r| r.name.clone());
    let result = audit_record_inner(state, user, w).await;
    if result.is_err() {
        tracing::error!(
            action,
            zone,
            record_id,
            record = name.as_deref().unwrap_or(""),
            "the DNS change was accepted by Cloudflare but its audit row could not be written"
        );
    }
    result
}

/// POST /dns/accounts/{account}/zones/{zone}/records (admin).
async fn create_record(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, account, zone)): Path<(String, Uuid, String)>,
    ApiJson(req): ApiJson<RecordReq>,
) -> Result<(StatusCode, Json<RecordView>), ApiError> {
    user.require_admin()?;
    let zone = cf_id(&zone)?;
    let checked = records::check(&req)?;
    let (row, client) = client_of(&state, account).await?;
    let created = client.create(zone, &checked.body).await?;
    let written = Written {
        action: "dns.record.create",
        account: &row,
        zone,
        record_id: &created.id,
        before: None,
        after: Some(&created),
    };
    audit_record(&state, &user, written).await?;
    let managed = managed(&state).await?;
    Ok((StatusCode::CREATED, Json(view_of(&managed, created))))
}

/// Whether `after` changes what a dependent panel feature sees.
fn changes_target(before: &Record, after: &records::Checked) -> bool {
    let body = &after.body;
    before.kind != after.kind
        || !before.name.eq_ignore_ascii_case(&after.name)
        || body
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|c| c != before.content)
        || body.get("proxied").and_then(Value::as_bool) != before.proxied
        || body
            .get("data")
            .is_some_and(|d| Some(d) != before.data.as_ref())
}

/// PUT /dns/accounts/{account}/zones/{zone}/records/{id} (admin).
async fn update_record(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, account, zone, id)): Path<(String, Uuid, String, String)>,
    ApiJson(req): ApiJson<RecordReq>,
) -> Result<Json<RecordView>, ApiError> {
    user.require_admin()?;
    let (zone, id) = (cf_id(&zone)?, cf_id(&id)?);
    let checked = records::check(&req)?;
    let (row, client) = client_of(&state, account).await?;
    let before = client.record(zone, id).await?;
    let managed = managed(&state).await?;
    if !req.confirm && changes_target(&before, &checked) {
        let mut hit: Vec<(String, Vec<Use>)> = Vec::new();
        for name in [before.name.as_str(), checked.name.as_str()] {
            let uses = records::uses_of(&managed, name);
            if !uses.is_empty() && !hit.iter().any(|(n, _)| n.eq_ignore_ascii_case(name)) {
                hit.push((name.to_string(), uses.to_vec()));
            }
        }
        if !hit.is_empty() {
            return Err(confirm_required(&hit));
        }
    }
    let after = client.update(zone, id, &checked.body).await?;
    let written = Written {
        action: "dns.record.update",
        account: &row,
        zone,
        record_id: id,
        before: Some(&before),
        after: Some(&after),
    };
    audit_record(&state, &user, written).await?;
    Ok(Json(view_of(&managed, after)))
}

#[derive(Debug, Deserialize)]
struct DeleteQuery {
    #[serde(default)]
    confirm: bool,
}

/// DELETE /dns/accounts/{account}/zones/{zone}/records/{id} (admin).
async fn delete_record(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, account, zone, id)): Path<(String, Uuid, String, String)>,
    Query(q): Query<DeleteQuery>,
) -> Result<StatusCode, ApiError> {
    user.require_admin()?;
    let (zone, id) = (cf_id(&zone)?, cf_id(&id)?);
    let (row, client) = client_of(&state, account).await?;
    let before = client.record(zone, id).await?;
    let managed = managed(&state).await?;
    let uses = records::uses_of(&managed, &before.name);
    if !q.confirm && !uses.is_empty() {
        return Err(confirm_required(&[(before.name.clone(), uses.to_vec())]));
    }
    client.delete(zone, id).await?;
    let written = Written {
        action: "dns.record.delete",
        account: &row,
        zone,
        record_id: id,
        before: Some(&before),
        after: None,
    };
    audit_record(&state, &user, written).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BatchAction {
    Delete,
    /// Orange / grey cloud (`proxied`).
    Proxied,
    /// A new address for A / AAAA records (`content`).
    Content,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchReq {
    action: BatchAction,
    ids: Vec<String>,
    #[serde(default)]
    proxied: Option<bool>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    confirm: bool,
}

/// The change one batch makes to `before` (`None` = skip it with a reason).
fn batch_change(req: &BatchReq, before: &Record) -> Result<Value, &'static str> {
    match req.action {
        BatchAction::Delete => Ok(Value::Null),
        BatchAction::Proxied => {
            if !records::PROXIABLE.contains(&before.kind.as_str()) {
                return Err("not_proxiable");
            }
            Ok(json!({ "proxied": req.proxied.unwrap_or(false) }))
        }
        BatchAction::Content => {
            let content = req.content.as_deref().unwrap_or_default().trim();
            let fits = match before.kind.as_str() {
                "A" => content.parse::<std::net::Ipv4Addr>().is_ok(),
                "AAAA" => content.parse::<std::net::Ipv6Addr>().is_ok(),
                _ => return Err("not_an_address_record"),
            };
            if fits {
                Ok(json!({ "content": content }))
            } else {
                Err("address_family")
            }
        }
    }
}

/// POST /dns/accounts/{account}/zones/{zone}/records/batch (admin): delete,
/// switch the cloud, or change the address of up to 100 records. Each record
/// is its own Cloudflare call and its own audit row; the answer lists the
/// outcome per record.
async fn batch(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, account, zone)): Path<(String, Uuid, String)>,
    ApiJson(req): ApiJson<BatchReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let zone = cf_id(&zone)?;
    if req.ids.is_empty() || req.ids.len() > BATCH_MAX {
        return Err(bad_request!(
            "dns.batch_size",
            "select 1-{max} records",
            max = BATCH_MAX
        ));
    }
    match req.action {
        BatchAction::Proxied if req.proxied.is_none() => {
            return Err(bad_request!("dns.batch_invalid", "proxied is required"));
        }
        BatchAction::Content if req.content.as_deref().is_none_or(|c| c.trim().is_empty()) => {
            return Err(bad_request!("dns.batch_invalid", "content is required"));
        }
        _ => {}
    }
    let mut ids: Vec<&str> = Vec::with_capacity(req.ids.len());
    for raw in &req.ids {
        let id = cf_id(raw)?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let (row, client) = client_of(&state, account).await?;
    let managed = managed(&state).await?;
    // Phase 1: read every record, so nothing is changed before the admin has
    // confirmed the dangerous ones.
    let mut loaded: Vec<(&str, Result<Record, DnsError>)> = Vec::new();
    for id in &ids {
        let result = client.record(zone, id).await;
        if matches!(
            result,
            Err(DnsError::RateLimited { .. } | DnsError::TokenRejected)
        ) {
            return Err(result.err().map_or_else(ApiError::internal, ApiError::from));
        }
        loaded.push((id, result));
    }
    let mut hit: Vec<(String, Vec<Use>)> = Vec::new();
    for (_, result) in &loaded {
        if let Ok(rec) = result {
            let uses = records::uses_of(&managed, &rec.name);
            if !uses.is_empty() && batch_change(&req, rec).is_ok() {
                hit.push((rec.name.clone(), uses.to_vec()));
            }
        }
    }
    if !hit.is_empty() && !req.confirm {
        return Err(confirm_required(&hit));
    }
    // Phase 2.
    let mut results = Vec::new();
    let mut stop: Option<ApiError> = None;
    for (id, result) in loaded {
        let fail = |name: Option<&str>, e: ApiError| {
            json!({ "id": id, "name": name, "ok": false, "code": e.code(),
                    "message": e.message(), "params": e.params() })
        };
        let before = match result {
            Ok(r) => r,
            Err(e) => {
                results.push(fail(None, e.into()));
                continue;
            }
        };
        if let Some(e) = &stop {
            results.push(fail(
                Some(&before.name),
                ApiError::from(DnsError::RateLimited {
                    retry_after_secs: e.params().get("retry_after_secs").and_then(Value::as_u64),
                }),
            ));
            continue;
        }
        let change = match batch_change(&req, &before) {
            Ok(c) => c,
            Err(reason) => {
                results.push(fail(
                    Some(&before.name),
                    bad_request!("dns.batch_skipped", "skipped: {reason}", reason = reason),
                ));
                continue;
            }
        };
        let outcome = if matches!(req.action, BatchAction::Delete) {
            client.delete(zone, id).await.map(|()| None)
        } else {
            let mut patch = change.clone();
            if change.get("proxied") == Some(&json!(true)) {
                patch["ttl"] = json!(records::TTL_AUTO);
            }
            client.update(zone, id, &patch).await.map(Some)
        };
        match outcome {
            Ok(after) => {
                let action = if after.is_none() {
                    "dns.record.delete"
                } else {
                    "dns.record.update"
                };
                let written = Written {
                    action,
                    account: &row,
                    zone,
                    record_id: id,
                    before: Some(&before),
                    after: after.as_ref(),
                };
                audit_record(&state, &user, written).await?;
                results.push(json!({ "id": id, "name": before.name, "ok": true }));
            }
            Err(e) => {
                if matches!(e, DnsError::RateLimited { .. }) {
                    stop = Some(e.clone().into());
                }
                results.push(fail(Some(&before.name), e.into()));
            }
        }
    }
    let ok = results.iter().filter(|r| r["ok"] == true).count();
    Ok(Json(
        json!({ "ok": ok, "failed": results.len() - ok, "results": results }),
    ))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post};
    let linking = link::routes();
    const ZONE: &str = "/{prefix}/api/v1/dns/accounts/{account}/zones/{zone}/records";
    axum::Router::new()
        .merge(linking)
        .route(
            "/{prefix}/api/v1/dns/accounts",
            get(list_accounts).post(create_account),
        )
        .route(
            "/{prefix}/api/v1/dns/accounts/{id}",
            axum::routing::put(update_account).delete(delete_account),
        )
        .route(
            "/{prefix}/api/v1/dns/accounts/{id}/test",
            post(test_account),
        )
        .route("/{prefix}/api/v1/dns/zones", get(list_zones))
        .route(ZONE, get(list_records).post(create_record))
        .route(&format!("{ZONE}/batch"), post(batch))
        .route(
            &format!("{ZONE}/{{id}}"),
            axum::routing::put(update_record).delete(delete_record),
        )
}
