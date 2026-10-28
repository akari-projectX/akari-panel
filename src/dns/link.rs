//! Linking the panel's own names to DNS: "point this at the panel".
//!
//! * The panel's public addresses (`panel_settings.public_ipv4/ipv6`)
//!   are the owner's to set (`PUT /settings/public-addresses`,
//!   audited, global unicast only).
//! * `GET /dns/domains` lists the site domains (main / subscription / node /
//!   passkey centre) with the A / AAAA / CNAME records that exist for each
//!   in the zone some token manages (longest zone-name suffix wins).
//! * `POST /dns/link` creates or updates A / AAAA records of given names to
//!   an address (default: the panel's own). Every record write is its own
//!   Cloudflare call and its own `dns.record.*` audit row, exactly like the
//!   records API; changing a record of a name the panel depends on needs
//!   `confirm` (409 `dns.confirm_required`, nothing written before it).
//!   Names used as a node domain, a server certificate domain or an
//!   entrance connect address are always grey cloud.
//! * `GET|POST /dns/link/server/{id}` does the same for one server: its
//!   certificate domain and its direct entrances' connect hosts, pointing at
//!   `servers.agent_addr` (or an address the admin types after the machine
//!   changed IP). Relay entrances have no known address: the admin types it
//!   and uses `POST /dns/link`.

use std::net::IpAddr;

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use super::cloudflare::{Client, DnsError, Record, Zone};
use super::records::{self, Use};
use super::{Written, accounts, audit_record, client_of_row, confirm_required, fetch_zones};
use crate::api::ApiJson;
use crate::audit::{self, Actor};
use crate::auth::{ApiError, AuthUser, api_error, bad_request, conflict};
use crate::outbound::public_address;
use crate::state::AppState;

/// Hosts one request may link.
const HOSTS_MAX: usize = 50;
/// The comment on records this module creates.
const COMMENT: &str = "akari panel";

// ---------------------------------------------------------------------------
// The panel's public addresses
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Addresses {
    /// The `panel_settings` row version (shared with the other settings).
    pub version: i64,
    pub public_ipv4: Option<String>,
    pub public_ipv6: Option<String>,
}

pub async fn read_addresses(conn: &mut PgConnection) -> sqlx::Result<Addresses> {
    sqlx::query_as("SELECT version, public_ipv4, public_ipv6 FROM panel_settings WHERE id = 1")
        .fetch_one(conn)
        .await
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddressesReq {
    pub version: i64,
    /// null or "" = none.
    #[serde(default)]
    pub public_ipv4: Option<String>,
    #[serde(default)]
    pub public_ipv6: Option<String>,
}

fn clean_address(raw: Option<&str>, v6: bool) -> Result<Option<String>, ApiError> {
    let Some(raw) = raw.map(str::trim).filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    match raw.parse::<IpAddr>() {
        Ok(ip) if ip.is_ipv6() == v6 && public_address(ip) => Ok(Some(ip.to_string())),
        _ => Err(bad_request!(
            "settings.public_address_invalid",
            "the {family} address must be a public (global unicast) address",
            family = if v6 { "IPv6" } else { "IPv4" }
        )),
    }
}

/// Set (or clear) the panel's public addresses. Owner only; the same row and
/// `version` as the other settings (409 on a stale form); audited
/// `settings.public_addresses.update`.
pub async fn apply_update_addresses(
    conn: &mut PgConnection,
    actor: &Actor,
    req: &AddressesReq,
) -> Result<Addresses, ApiError> {
    crate::owner::require(conn, actor).await?;
    let v4 = clean_address(req.public_ipv4.as_deref(), false)?;
    let v6 = clean_address(req.public_ipv6.as_deref(), true)?;
    let cur: Addresses = sqlx::query_as(
        "SELECT version, public_ipv4, public_ipv6 FROM panel_settings WHERE id = 1 FOR UPDATE",
    )
    .fetch_one(&mut *conn)
    .await?;
    if cur.version != req.version {
        return Err(conflict!(
            "settings.version_conflict",
            "设置已被修改（可能是其他管理员），请刷新后重试"
        ));
    }
    if cur.public_ipv4 == v4 && cur.public_ipv6 == v6 {
        return Ok(cur);
    }
    let row: Addresses = sqlx::query_as(
        "UPDATE panel_settings SET public_ipv4 = $1, public_ipv6 = $2, version = version + 1, \
         updated_at = now() WHERE id = 1 RETURNING version, public_ipv4, public_ipv6",
    )
    .bind(&v4)
    .bind(&v6)
    .fetch_one(&mut *conn)
    .await?;
    audit::record(
        conn,
        actor,
        "settings.public_addresses.update",
        "settings",
        None,
        Some(json!({ "public_ipv4": cur.public_ipv4, "public_ipv6": cur.public_ipv6 })),
        Some(json!({ "public_ipv4": v4, "public_ipv6": v6 })),
    )
    .await?;
    Ok(row)
}

/// PUT /settings/public-addresses (owner).
async fn put_addresses(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<AddressesReq>,
) -> Result<Json<Addresses>, ApiError> {
    user.require_admin()?;
    let mut tx = state.pg().begin().await?;
    let row = apply_update_addresses(&mut tx, &Actor::of(&user), &req).await?;
    tx.commit().await?;
    crate::settings::reload_logged(&state).await;
    Ok(Json(row))
}

// ---------------------------------------------------------------------------
// Zones and the records of a name
// ---------------------------------------------------------------------------

type Index = Vec<(accounts::Row, Vec<Zone>)>;

/// The zones of every token that answered, plus one error entry for each
/// token that did not.
async fn zone_index(state: &AppState) -> Result<(Index, Vec<Value>), ApiError> {
    let (mut index, mut errors) = (Vec::new(), Vec::new());
    for (row, answer) in fetch_zones(state).await? {
        let err = match answer {
            Some(Ok(zones)) => {
                index.push((row, zones));
                continue;
            }
            Some(Err(e)) => ApiError::from(e),
            None => super::token_unreadable(),
        };
        errors.push(super::error_entry(&row, &err));
    }
    Ok((index, errors))
}

/// The zone that manages `host`: the longest zone name the host is in; at
/// equal length one the token may edit.
fn pick_zone<'a>(index: &'a Index, host: &str) -> Option<(&'a accounts::Row, &'a Zone)> {
    let mut best: Option<(&accounts::Row, &Zone)> = None;
    for (row, zones) in index {
        for z in zones {
            let name = z.name.to_ascii_lowercase();
            if !(host == name || host.ends_with(&format!(".{name}"))) {
                continue;
            }
            let better = best.is_none_or(|(_, b)| {
                name.len() > b.name.len()
                    || (name.len() == b.name.len()
                        && b.can_edit() == Some(false)
                        && z.can_edit() != Some(false))
            });
            if better {
                best = Some((row, z));
            }
        }
    }
    best
}

/// The A / AAAA / CNAME records named exactly `host`.
async fn records_of(client: &Client, zone: &str, host: &str) -> Result<Vec<Record>, DnsError> {
    let (list, _) = client.records(zone, Some(host), None, 1, 100).await?;
    Ok(list
        .into_iter()
        .filter(|r| {
            r.name.trim_end_matches('.').eq_ignore_ascii_case(host)
                && matches!(r.kind.as_str(), "A" | "AAAA" | "CNAME")
        })
        .collect())
}

fn is_name(host: &str) -> bool {
    host.parse::<IpAddr>().is_err()
        && host.contains('.')
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'))
}

fn norm_host(raw: &str) -> String {
    raw.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn failure(host: &str, e: &ApiError) -> Value {
    json!({ "host": host, "ok": false, "code": e.code(), "message": e.message(), "params": e.params() })
}

/// One name's DNS state for the console.
async fn host_status(state: &AppState, index: &Index, host: &str, uses: &[Use]) -> Value {
    let mut out = json!({ "host": host, "uses": uses, "zone": null, "records": [] });
    if !is_name(host) {
        out["not_a_name"] = json!(true);
        return out;
    }
    let Some((row, zone)) = pick_zone(index, host) else {
        return out;
    };
    out["zone"] = json!({ "account_id": row.id, "account_name": row.name,
        "zone_id": zone.id, "zone_name": zone.name, "can_edit": zone.can_edit() });
    let listed = match client_of_row(state, row) {
        Ok(client) => records_of(&client, &zone.id, host)
            .await
            .map_err(ApiError::from),
        Err(e) => Err(e),
    };
    match listed {
        Ok(list) => {
            out["records"] = json!(
                list.iter()
                    .map(
                        |r| json!({ "id": r.id, "type": r.kind, "content": r.content,
                                     "proxied": r.proxied, "ttl": r.ttl })
                    )
                    .collect::<Vec<_>>()
            );
        }
        Err(e) => {
            out["error"] =
                json!({ "code": e.code(), "message": e.message(), "params": e.params() });
        }
    }
    out
}

/// GET /dns/panel-addresses (admin).
async fn get_addresses(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Addresses>, ApiError> {
    user.require_admin()?;
    let mut conn = state.pg().acquire().await?;
    Ok(Json(read_addresses(&mut conn).await?))
}

/// GET /dns/domains (admin): the panel's own addresses, and each configured
/// site domain with its records.
async fn domains(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let mut conn = state.pg().acquire().await?;
    let panel = read_addresses(&mut conn).await?;
    let managed = records::managed(&mut conn).await?;
    drop(conn);
    const SITE: [&str; 4] = ["main", "sub", "node", "passkey"];
    let mut hosts: Vec<(&String, Vec<Use>)> = managed
        .iter()
        .filter_map(|(h, uses)| {
            let site: Vec<Use> = uses
                .iter()
                .filter(|u| SITE.contains(&u.kind))
                .cloned()
                .collect();
            (!site.is_empty()).then_some((h, site))
        })
        .collect();
    let rank = |uses: &[Use]| {
        uses.iter()
            .filter_map(|u| SITE.iter().position(|k| *k == u.kind))
            .min()
            .unwrap_or(9)
    };
    hosts.sort_by(|a, b| (rank(&a.1), a.0).cmp(&(rank(&b.1), b.0)));
    let (index, errors) = zone_index(&state).await?;
    let mut out = Vec::new();
    for (host, uses) in hosts {
        out.push(host_status(&state, &index, host, &uses).await);
    }
    Ok(Json(
        json!({ "panel": panel, "hosts": out, "errors": errors }),
    ))
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/// What one name should point at.
struct Wish {
    host: String,
    ips: Vec<IpAddr>,
    /// `None` = keep what the record has (grey for a new one).
    proxied: Option<bool>,
}

enum Op {
    Create(Value),
    Update { before: Record, patch: Value },
    Unchanged(Record),
}

struct Planned {
    wish_index: usize,
    zone: String,
    account: accounts::Row,
    ops: Vec<Op>,
}

/// Names whose uses force grey cloud: they are connection endpoints, not web.
fn must_be_grey(uses: &[Use]) -> bool {
    uses.iter()
        .any(|u| matches!(u.kind, "node" | "server" | "entrance"))
}

fn kind_of(ip: &IpAddr) -> &'static str {
    if ip.is_ipv4() { "A" } else { "AAAA" }
}

fn no_zone(host: &str) -> ApiError {
    conflict!(
        "dns.link_no_zone",
        "no Cloudflare token manages the zone of {host}",
        host = host
    )
}

fn read_only(host: &str) -> ApiError {
    conflict!(
        "dns.link_read_only",
        "the token can only read the zone of {host}",
        host = host
    )
}

fn ambiguous(host: &str, kind: &str) -> ApiError {
    conflict!(
        "dns.link_ambiguous",
        "{host} has several {kind} records: edit them on the DNS page",
        host = host,
        kind = kind
    )
}

fn cname_conflict(host: &str) -> ApiError {
    conflict!(
        "dns.link_cname_conflict",
        "{host} is a CNAME record: remove it on the DNS page first",
        host = host
    )
}

fn not_a_name(host: &str) -> ApiError {
    bad_request!(
        "dns.link_not_a_name",
        "{host} is an IP address, not a name",
        host = host
    )
}

/// Plan one name: find its zone and records, decide create / update /
/// leave. Returns the per-name failure when it cannot be linked.
async fn plan_one(
    state: &AppState,
    index: &Index,
    wish: &Wish,
    wish_index: usize,
    uses: &[Use],
) -> Result<Planned, ApiError> {
    let host = &wish.host;
    if !is_name(host) {
        return Err(not_a_name(host));
    }
    let (row, zone) = pick_zone(index, host).ok_or_else(|| no_zone(host))?;
    if zone.can_edit() == Some(false) {
        return Err(read_only(host));
    }
    let client = client_of_row(state, row)?;
    let existing = records_of(&client, &zone.id, host).await?;
    if existing.iter().any(|r| r.kind == "CNAME") {
        return Err(cname_conflict(host));
    }
    let grey = must_be_grey(uses);
    let mut ops = Vec::new();
    for ip in &wish.ips {
        let kind = kind_of(ip);
        let content = ip.to_string();
        let same: Vec<&Record> = existing.iter().filter(|r| r.kind == kind).collect();
        if same.len() > 1 {
            return Err(ambiguous(host, kind));
        }
        let proxied = if grey {
            false
        } else {
            wish.proxied
                .unwrap_or_else(|| same.first().and_then(|r| r.proxied).unwrap_or(false))
        };
        match same.first() {
            None => ops.push(Op::Create(json!({
                "type": kind, "name": host, "content": content, "proxied": proxied,
                "ttl": records::TTL_AUTO, "comment": COMMENT,
            }))),
            Some(r) if r.content == content && r.proxied.unwrap_or(false) == proxied => {
                ops.push(Op::Unchanged((*r).clone()));
            }
            Some(r) => {
                let mut patch = json!({ "content": content, "proxied": proxied });
                if proxied {
                    patch["ttl"] = json!(records::TTL_AUTO);
                }
                ops.push(Op::Update {
                    before: (*r).clone(),
                    patch,
                });
            }
        }
    }
    Ok(Planned {
        wish_index,
        zone: zone.id.clone(),
        account: row.clone(),
        ops,
    })
}

/// Link the wishes: plan every name first (nothing written), ask for
/// confirmation when a record the panel depends on would change, then write.
async fn link(
    state: &AppState,
    user: &AuthUser,
    wishes: Vec<Wish>,
    confirm: bool,
) -> Result<Value, ApiError> {
    let (index, _) = zone_index(state).await?;
    let managed = {
        let mut conn = state.pg().acquire().await?;
        records::managed(&mut conn).await?
    };
    let mut results: Vec<Option<Value>> = vec![None; wishes.len()];
    let mut planned = Vec::new();
    for (i, wish) in wishes.iter().enumerate() {
        let uses = records::uses_of(&managed, &wish.host);
        match plan_one(state, &index, wish, i, uses).await {
            Ok(p) => planned.push(p),
            Err(e) => results[i] = Some(failure(&wish.host, &e)),
        }
    }
    let mut hit: Vec<(String, Vec<Use>)> = Vec::new();
    for p in &planned {
        let host = &wishes[p.wish_index].host;
        let uses = records::uses_of(&managed, host);
        if !uses.is_empty() && p.ops.iter().any(|o| matches!(o, Op::Update { .. })) {
            hit.push((host.clone(), uses.to_vec()));
        }
    }
    if !hit.is_empty() && !confirm {
        return Err(confirm_required(&hit));
    }
    let mut stop: Option<DnsError> = None;
    for p in planned {
        let host = wishes[p.wish_index].host.clone();
        let client = client_of_row(state, &p.account)?;
        let mut changes = Vec::new();
        let mut failed: Option<ApiError> = None;
        for op in p.ops {
            if let Some(e) = &stop {
                failed = Some(e.clone().into());
                break;
            }
            let step = match op {
                Op::Unchanged(r) => {
                    changes.push(change("unchanged", &r, &r.content, r.proxied));
                    continue;
                }
                Op::Create(body) => match client.create(&p.zone, &body).await {
                    Ok(after) => Ok(("dns.record.create", None, after)),
                    Err(e) => Err(e),
                },
                Op::Update { before, patch } => {
                    match client.update(&p.zone, &before.id, &patch).await {
                        Ok(after) => Ok(("dns.record.update", Some(before), after)),
                        Err(e) => Err(e),
                    }
                }
            };
            match step {
                Ok((action, before, after)) => {
                    let written = Written {
                        action,
                        account: &p.account,
                        zone: &p.zone,
                        record_id: &after.id,
                        before: before.as_ref(),
                        after: Some(&after),
                    };
                    audit_record(state, user, written).await?;
                    let from = before.as_ref().map(|b| b.content.clone());
                    let mut c = change(
                        if before.is_some() {
                            "updated"
                        } else {
                            "created"
                        },
                        &after,
                        &after.content,
                        after.proxied,
                    );
                    c["from"] = json!(from);
                    changes.push(c);
                }
                Err(e) => {
                    if matches!(e, DnsError::RateLimited { .. }) {
                        stop = Some(e.clone());
                    }
                    failed = Some(e.into());
                    break;
                }
            }
        }
        results[p.wish_index] = Some(match failed {
            Some(e) => failure(&host, &e),
            None => json!({ "host": host, "ok": true, "changes": changes }),
        });
    }
    let results: Vec<Value> = results.into_iter().flatten().collect();
    let ok = results.iter().filter(|r| r["ok"] == true).count();
    Ok(json!({ "ok": ok, "failed": results.len() - ok, "results": results }))
}

fn change(action: &str, r: &Record, to: &str, proxied: Option<bool>) -> Value {
    json!({ "type": r.kind, "action": action, "to": to, "proxied": proxied })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkItem {
    host: String,
    /// One address (A or AAAA by family); default = the panel's addresses.
    #[serde(default)]
    address: Option<String>,
    /// null = keep the record's state (grey for a new record).
    #[serde(default)]
    proxied: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkReq {
    hosts: Vec<LinkItem>,
    #[serde(default)]
    confirm: bool,
}

fn parse_address(raw: &str) -> Result<IpAddr, ApiError> {
    raw.trim()
        .parse::<IpAddr>()
        .ok()
        .filter(|ip| public_address(*ip))
        .ok_or_else(|| {
            bad_request!(
                "dns.link_address_invalid",
                "{address} is not a public IP address",
                address = raw.trim().chars().take(64).collect::<String>()
            )
        })
}

/// POST /dns/link (admin).
async fn link_hosts(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<LinkReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    // Red team A-3: pointing names at an address is the owner's.
    crate::owner::require_user(&state, &user).await?;
    if req.hosts.is_empty() || req.hosts.len() > HOSTS_MAX {
        return Err(bad_request!(
            "dns.batch_size",
            "select 1-{max} records",
            max = HOSTS_MAX
        ));
    }
    let panel = {
        let mut conn = state.pg().acquire().await?;
        read_addresses(&mut conn).await?
    };
    let mut wishes: Vec<Wish> = Vec::new();
    for item in &req.hosts {
        let ips = match item.address.as_deref() {
            Some(a) => vec![parse_address(a)?],
            None => {
                let ips: Vec<IpAddr> = [&panel.public_ipv4, &panel.public_ipv6]
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a.parse().ok())
                    .collect();
                if ips.is_empty() {
                    return Err(conflict!(
                        "dns.panel_address_unset",
                        "set the panel's public IP address first"
                    ));
                }
                ips
            }
        };
        let host = norm_host(&item.host);
        if !wishes.iter().any(|w| w.host == host) {
            wishes.push(Wish {
                host,
                ips,
                proxied: item.proxied,
            });
        }
    }
    Ok(Json(link(&state, &user, wishes, req.confirm).await?))
}

// ---------------------------------------------------------------------------
// One server
// ---------------------------------------------------------------------------

struct ServerNames {
    address: Option<IpAddr>,
    hosts: Vec<String>,
    /// Connect addresses that are IP literals (nothing to link).
    skipped: Vec<String>,
}

/// The server's certificate domain and its direct entrances' connect hosts,
/// and its public address (`agent_addr` when global).
async fn server_names(state: &AppState, id: Uuid) -> Result<ServerNames, ApiError> {
    let mut conn = state.pg().acquire().await?;
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT tls_domain, host(agent_addr) FROM servers WHERE id = $1 AND deleting_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let (tls, addr) = row.ok_or_else(ApiError::not_found)?;
    let connect: Vec<String> = sqlx::query_scalar(
        "SELECT e.connect_host FROM entrances e JOIN nodes n ON n.id = e.node_id \
         WHERE n.server_id = $1 AND e.kind = 'direct' AND e.connect_host IS NOT NULL \
         ORDER BY e.id",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let (mut hosts, mut skipped) = (Vec::new(), Vec::new());
    for h in tls.into_iter().chain(connect) {
        let h = norm_host(&h);
        if is_name(&h) {
            if !hosts.contains(&h) {
                hosts.push(h);
            }
        } else if !skipped.contains(&h) {
            skipped.push(h);
        }
    }
    let address = addr
        .and_then(|a| a.parse::<IpAddr>().ok())
        .filter(|ip| public_address(*ip));
    Ok(ServerNames {
        address,
        hosts,
        skipped,
    })
}

/// GET /dns/link/server/{id} (admin): the server's address and the state of
/// its names.
async fn server_status(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    let names = server_names(&state, id).await?;
    let managed = {
        let mut conn = state.pg().acquire().await?;
        records::managed(&mut conn).await?
    };
    let (index, errors) = zone_index(&state).await?;
    let mut hosts = Vec::new();
    for h in &names.hosts {
        hosts.push(host_status(&state, &index, h, records::uses_of(&managed, h)).await);
    }
    Ok(Json(json!({
        "address": names.address.map(|a| a.to_string()),
        "hosts": hosts, "skipped": names.skipped, "errors": errors,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ServerLinkReq {
    /// The machine's new address; default = the address its agent connects from.
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    confirm: bool,
}

/// POST /dns/link/server/{id} (admin): point the server's names at its
/// address (grey cloud). After a change of IP this is the batch update.
async fn server_link(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_, id)): Path<(String, Uuid)>,
    ApiJson(req): ApiJson<ServerLinkReq>,
) -> Result<Json<Value>, ApiError> {
    user.require_admin()?;
    crate::owner::require_user(&state, &user).await?;
    let names = server_names(&state, id).await?;
    let address = match req
        .address
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        Some(a) => parse_address(a)?,
        None => names.address.ok_or_else(|| {
            conflict!(
                "dns.server_address_unknown",
                "the server's address is unknown or not public: type it"
            )
        })?,
    };
    if names.hosts.is_empty() {
        return Err(api_error!(
            UNPROCESSABLE_ENTITY,
            "dns.server_no_names",
            "the server has no certificate domain or connect domain"
        ));
    }
    let wishes = names
        .hosts
        .into_iter()
        .map(|host| Wish {
            host,
            ips: vec![address],
            proxied: Some(false),
        })
        .collect();
    let mut out = link(&state, &user, wishes, req.confirm).await?;
    out["address"] = json!(address.to_string());
    out["skipped"] = json!(names.skipped);
    Ok(Json(out))
}

pub fn routes() -> axum::Router<AppState> {
    use axum::routing::{get, post, put};
    axum::Router::new()
        .route("/{prefix}/api/v1/dns/domains", get(domains))
        .route("/{prefix}/api/v1/dns/panel-addresses", get(get_addresses))
        .route("/{prefix}/api/v1/dns/link", post(link_hosts))
        .route(
            "/{prefix}/api/v1/dns/link/server/{id}",
            get(server_status).post(server_link),
        )
        .route(
            "/{prefix}/api/v1/settings/public-addresses",
            put(put_addresses),
        )
}
