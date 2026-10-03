//! W11: xboard-style node fields of the admin node form — validation and
//! normalization for `api::UpdateNodeReq`/`CreateNodeReq` (display name,
//! sort, visibility, tags, traffic multiplier, per-inbound connect
//! address/port) and node-group membership edited from the node form.
//!
//! None of the fields changes what an agent runs (no version bump); group
//! membership does change access and goes through
//! `entitle::apply_reconcile` (bumps exactly the affected node).

use crate::auth::{bad_request, conflict};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::audit::Actor;
use crate::auth::ApiError;
use crate::entitle::{self, Outcome, Scope};

pub const MAX_TAGS: usize = 8;
pub const MAX_TAG_CHARS: usize = 24;
pub const MAX_DISPLAY_CHARS: usize = 64;
pub const SORT_LIMIT: i32 = 1_000_000;
/// Multiplier bounds (x): 0 = free node, at most 100x.
pub const MAX_RATE: f64 = 100.0;
pub const MAX_OVERRIDES: usize = 64;

fn printable(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

/// "" / whitespace = cleared (None).
pub fn display_name(v: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(v) = v.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if v.chars().count() > MAX_DISPLAY_CHARS || !printable(v) {
        return Err(bad_request!(
            "node.display_name_invalid",
            "display_name must be at most {max_display_chars} printable characters",
            max_display_chars = MAX_DISPLAY_CHARS
        ));
    }
    Ok(Some(v.to_string()))
}

pub fn sort(v: i32) -> Result<i32, ApiError> {
    if !(-SORT_LIMIT..=SORT_LIMIT).contains(&v) {
        return Err(bad_request!(
            "node.sort_range",
            "sort must be between -{sort_limit} and {sort_limit}",
            sort_limit = SORT_LIMIT
        ));
    }
    Ok(v)
}

/// Trimmed, non-empty, deduplicated (first wins), order kept.
pub fn tags(v: &[String]) -> Result<Vec<String>, ApiError> {
    let mut out: Vec<String> = Vec::new();
    for t in v {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        if t.chars().count() > MAX_TAG_CHARS || !printable(t) || t.contains('|') {
            return Err(bad_request!(
                "node.tag_invalid",
                "each tag must be at most {max_tag_chars} printable characters without '|'",
                max_tag_chars = MAX_TAG_CHARS
            ));
        }
        if !out.iter().any(|o| o == t) {
            out.push(t.to_string());
        }
    }
    if out.len() > MAX_TAGS {
        return Err(bad_request!(
            "node.too_many_tags",
            "at most {max_tags} tags",
            max_tags = MAX_TAGS
        ));
    }
    Ok(out)
}

/// The multiplier as an exact integer permille: 0..=100 with at most three
/// decimals (0.5 -> 500, 1.25 -> 1250); anything finer is refused rather
/// than rounded.
pub fn rate_permille(x: f64) -> Result<i32, ApiError> {
    let bad = || {
        bad_request!(
            "node.rate_invalid",
            "traffic_rate must be 0..=100 with at most 3 decimals"
        )
    };
    if !x.is_finite() || !(0.0..=MAX_RATE).contains(&x) {
        return Err(bad());
    }
    let p = (x * 1000.0).round();
    if ((x * 1000.0) - p).abs() > 1e-6 {
        return Err(bad());
    }
    Ok(p as i32)
}

/// One inbound's client-facing override.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Connect {
    pub host: Option<String>,
    pub port: Option<u16>,
}

/// The override stored for `tag` (empty when none / malformed).
pub fn connect_for(overrides: &Value, tag: &str) -> Connect {
    let Some(o) = overrides.get(tag) else {
        return Connect::default();
    };
    Connect {
        host: o
            .get("host")
            .and_then(Value::as_str)
            .filter(|h| !h.is_empty())
            .map(String::from),
        port: o
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p > 0),
    }
}

/// A hostname, IPv4 or IPv6 literal (no scheme, path, port, spaces).
fn valid_host(h: &str) -> bool {
    if h.is_empty() || h.len() > 253 {
        return false;
    }
    if h.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    h.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// Normalize `{"<tag>": {"host": "...", "port": n}}`: keys must name an
/// inbound of the node, each entry needs a host or a port, empty strings /
/// nulls drop the key, an entry with neither is dropped.
pub fn connect_overrides(v: &Value, inbounds: &Value) -> Result<Value, ApiError> {
    let bad = |m: String| {
        bad_request!(
            "node.connect_override_invalid",
            "connect_overrides: {m}",
            m = m
        )
    };
    let Some(obj) = v.as_object() else {
        return Err(bad("must be an object keyed by inbound tag".into()));
    };
    if obj.len() > MAX_OVERRIDES {
        return Err(bad(format!("at most {MAX_OVERRIDES} entries")));
    }
    let tags: Vec<&str> = inbounds
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| i.get("tag").and_then(Value::as_str))
        .collect();
    let mut out = Map::new();
    for (tag, e) in obj {
        if !tags.contains(&tag.as_str()) {
            return Err(bad(format!("no inbound tagged {tag:?} on this node")));
        }
        let Some(e) = e.as_object() else {
            return Err(bad(format!("{tag}: must be an object {{host, port}}")));
        };
        if let Some(k) = e.keys().find(|k| *k != "host" && *k != "port") {
            return Err(bad(format!("{tag}: unknown field {k:?}")));
        }
        let mut entry = Map::new();
        match e.get("host") {
            None | Some(Value::Null) => {}
            Some(Value::String(h)) if h.trim().is_empty() => {}
            Some(Value::String(h)) => {
                let h = h.trim().trim_start_matches('[').trim_end_matches(']');
                if !valid_host(h) {
                    return Err(bad(format!("{tag}: host must be a hostname or IP address")));
                }
                entry.insert("host".into(), json!(h));
            }
            Some(_) => return Err(bad(format!("{tag}: host must be a string"))),
        }
        match e.get("port") {
            None | Some(Value::Null) => {}
            Some(p) => match p
                .as_u64()
                .and_then(|p| u16::try_from(p).ok())
                .filter(|p| *p > 0)
            {
                Some(p) => {
                    entry.insert("port".into(), json!(p));
                }
                None => return Err(bad(format!("{tag}: port must be 1..=65535"))),
            },
        }
        if !entry.is_empty() {
            out.insert(tag.clone(), Value::Object(entry));
        }
    }
    Ok(Value::Object(out))
}

/// Set the node's group membership (the complete list) from the node form:
/// `entitle::lock` -> node row -> membership -> reconcile of this node
/// (plan users of added groups gain access, of removed groups lose it;
/// bumps the node only when its user set changed) -> audit
/// `node.groups.set`, all in the caller's transaction.
pub async fn apply_set_node_groups(
    conn: &mut PgConnection,
    actor: &Actor,
    node: Uuid,
    group_ids: &[Uuid],
) -> Result<Outcome, ApiError> {
    let mut groups: Vec<Uuid> = group_ids.to_vec();
    groups.sort();
    groups.dedup();
    entitle::lock(conn).await?;
    let deleting: Option<bool> =
        sqlx::query_scalar("SELECT deleting_at IS NOT NULL FROM nodes WHERE id = $1 FOR UPDATE")
            .bind(node)
            .fetch_optional(&mut *conn)
            .await?;
    match deleting {
        None => return Err(ApiError::not_found()),
        Some(true) => return Err(conflict!("node.deleting", "node is being deleted")),
        Some(false) => {}
    }
    let found: i64 = sqlx::query_scalar("SELECT count(*) FROM node_groups WHERE id = ANY($1)")
        .bind(&groups)
        .fetch_one(&mut *conn)
        .await?;
    if found != groups.len() as i64 {
        return Err(bad_request!("group.unknown", "unknown group id"));
    }
    let old: Vec<Uuid> = sqlx::query_scalar(
        "SELECT group_id FROM node_group_members WHERE node_id = $1 ORDER BY group_id",
    )
    .bind(node)
    .fetch_all(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM node_group_members WHERE node_id = $1 AND NOT group_id = ANY($2)")
        .bind(node)
        .bind(&groups)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO node_group_members (group_id, node_id) SELECT unnest($2::uuid[]), $1 \
         ON CONFLICT DO NOTHING",
    )
    .bind(node)
    .bind(&groups)
    .execute(&mut *conn)
    .await?;
    let outcome = if old != groups {
        entitle::apply_reconcile(conn, Scope::Nodes(&[node])).await?
    } else {
        Outcome::default()
    };
    crate::audit::record(
        conn,
        actor,
        "node.groups.set",
        "node",
        Some(node.to_string()),
        Some(json!({ "group_ids": old })),
        Some(json!({ "group_ids": groups, "entitlement": outcome.summary() })),
    )
    .await?;
    Ok(outcome)
}

/// The subscription / portal name of a node: display name (else name),
/// then its tags: "香港 01 | IPLC | 0.5x".
pub fn public_name(name: &str, display: Option<&str>, tags: &[String]) -> String {
    let mut s = display
        .filter(|d| !d.is_empty())
        .unwrap_or(name)
        .to_string();
    for t in tags {
        s.push_str(" | ");
        s.push_str(t);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_is_exact_permille() {
        assert_eq!(rate_permille(1.0).unwrap(), 1000);
        assert_eq!(rate_permille(0.5).unwrap(), 500);
        assert_eq!(rate_permille(0.1).unwrap(), 100);
        assert_eq!(rate_permille(1.255).unwrap(), 1255);
        assert_eq!(rate_permille(0.0).unwrap(), 0);
        assert_eq!(rate_permille(100.0).unwrap(), 100_000);
        for bad in [-0.1, 100.001, 0.0005, 1.2345, f64::NAN, f64::INFINITY] {
            assert!(rate_permille(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn tags_and_names() {
        assert_eq!(
            tags(&[" 香港 ".into(), "".into(), "0.5x".into(), "香港".into()]).unwrap(),
            vec!["香港".to_string(), "0.5x".to_string()]
        );
        assert!(tags(&["a|b".into()]).is_err());
        assert!(tags(&["x".repeat(25)]).is_err());
        assert!(tags(&(0..9).map(|i| i.to_string()).collect::<Vec<_>>()).is_err());
        assert!(tags(&["a\nb".into()]).is_err());
        assert_eq!(display_name(Some("  ")).unwrap(), None);
        assert_eq!(display_name(Some(" 东京 ")).unwrap(), Some("东京".into()));
        assert!(display_name(Some(&"x".repeat(65))).is_err());
        assert_eq!(public_name("hk-1", None, &[]), "hk-1");
        assert_eq!(
            public_name("hk-1", Some("香港 01"), &["IPLC".into(), "0.5x".into()]),
            "香港 01 | IPLC | 0.5x"
        );
        assert!(sort(1_000_001).is_err());
        assert_eq!(sort(-5).unwrap(), -5);
    }

    #[test]
    fn overrides_validate_and_normalize() {
        let ib = json!([{"tag": "a", "port": 443}, {"tag": "b", "port": 8443}]);
        let v = connect_overrides(
            &json!({"a": {"host": " relay.example.com ", "port": 30443}, "b": {"host": "", "port": null}}),
            &ib,
        )
        .unwrap();
        assert_eq!(
            v,
            json!({"a": {"host": "relay.example.com", "port": 30443}})
        );
        assert_eq!(
            connect_overrides(&json!({"b": {"host": "[2001:db8::1]"}}), &ib).unwrap(),
            json!({"b": {"host": "2001:db8::1"}})
        );
        for bad in [
            json!([]),
            json!({"zz": {"port": 1}}),
            json!({"a": {"port": 0}}),
            json!({"a": {"port": 70000}}),
            json!({"a": {"host": "https://x"}}),
            json!({"a": {"host": "a b"}}),
            json!({"a": {"hostname": "x"}}),
            json!({"a": "x"}),
        ] {
            assert!(connect_overrides(&bad, &ib).is_err(), "{bad}");
        }
        let c = connect_for(&json!({"a": {"host": "h", "port": 1}}), "a");
        assert_eq!(
            c,
            Connect {
                host: Some("h".into()),
                port: Some(1)
            }
        );
        assert_eq!(connect_for(&json!({}), "a"), Connect::default());
    }

    /// Through the router: POST /nodes and PATCH /nodes/{id} take the W11
    /// fields (validated, audited, no bump), group_ids reconcile access.
    #[tokio::test]
    async fn node_form_fields_over_http() {
        use axum::http::{Method, StatusCode};

        use crate::testdb::TestDb;
        use crate::testdb::http::{Client, rand_ip};
        let Some(db) = TestDb::new().await else {
            return;
        };
        let state = crate::state::AppState::for_test(db.pool.clone()).await;
        let admin = db.admin().await;
        let mut c = Client::new(&state, rand_ip());
        let sv: i64 = sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
            .bind(admin)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        c.cookie = Some(
            crate::auth::issue_token(&state, admin, "admin", sv, crate::auth::Stage::Full).unwrap(),
        );
        let g = c
            .post("/test/api/v1/node-groups", json!({"name": "hk"}))
            .await
            .json()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let r = c
            .post(
                "/test/api/v1/nodes",
                json!({
                    "name": "w11-a", "server_addr": "1.2.3.4",
                    "inbounds": [{"tag": "in-a", "protocol": "vless", "port": 443,
                                  "settings": {"clients": [], "decryption": "none"}}],
                    "display_name": "香港 01", "sort": 5, "visible": false,
                    "tags": ["IPLC", " 0.5x "], "traffic_rate": 0.5,
                    "connect_overrides": {"in-a": {"port": 30443}},
                    "group_ids": [g]
                }),
            )
            .await;
        assert_eq!(
            r.status,
            StatusCode::CREATED,
            "{}",
            String::from_utf8_lossy(&r.body)
        );
        let id = r.json()["id"].as_str().unwrap().to_string();
        let list = c.get("/test/api/v1/nodes").await.json();
        let n = list
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == id.as_str())
            .unwrap()
            .clone();
        assert_eq!(n["display_name"], "香港 01");
        assert_eq!(n["sort"], 5);
        assert_eq!(n["visible"], false);
        assert_eq!(n["tags"], json!(["IPLC", "0.5x"]));
        assert_eq!(n["traffic_rate_permille"], 500);
        assert_eq!(n["traffic_rate"], 0.5);
        assert_eq!(n["connect_overrides"], json!({"in-a": {"port": 30443}}));
        assert_eq!(n["group_ids"], json!([g]));

        // PATCH: only the multiplier; config untouched.
        let before: (i64, i64) =
            sqlx::query_as("SELECT config_version, user_version FROM nodes WHERE id = $1::uuid")
                .bind(&id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        let path = format!("/test/api/v1/nodes/{id}");
        let r = c
            .req(
                Method::PATCH,
                &path,
                Some(json!({"traffic_rate": 2, "display_name": null})),
            )
            .await;
        assert_eq!(
            r.status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&r.body)
        );
        assert_eq!(r.json()["traffic_rate_permille"], 2000);
        assert!(r.json()["display_name"].is_null());
        let after: (i64, i64) =
            sqlx::query_as("SELECT config_version, user_version FROM nodes WHERE id = $1::uuid")
                .bind(&id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(before, after, "display fields never bump");
        // W11: replacing the inbounds drops overrides of removed tags.
        let r = c
            .req(
                Method::PUT,
                &format!("{path}/inbounds"),
                Some(
                    json!({"inbounds": [{"tag": "in-b", "protocol": "vless", "port": 8443,
                    "settings": {"clients": [], "decryption": "none"}}]}),
                ),
            )
            .await;
        assert_eq!(
            r.status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&r.body)
        );
        let ov: serde_json::Value =
            sqlx::query_scalar("SELECT connect_overrides FROM nodes WHERE id = $1::uuid")
                .bind(&id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(ov, json!({}), "stale override of a removed inbound");
        // group_ids alone; [] clears.
        let r = c
            .req(Method::PATCH, &path, Some(json!({"group_ids": []})))
            .await;
        assert_eq!(r.status, StatusCode::OK);
        assert_eq!(r.json()["group_ids"], json!([]));
        // Refusals.
        for bad in [
            json!({"traffic_rate": 0.0001}),
            json!({"traffic_rate": 101}),
            json!({"tags": ["a|b"]}),
            json!({"connect_overrides": {"nope": {"port": 1}}}),
            json!({"connect_overrides": {"in-a": {"port": 0}}}),
            json!({"sort": null}),
            json!({"group_ids": [uuid::Uuid::new_v4()]}),
            json!({"group_ids": null}),
            json!({}),
        ] {
            let r = c.req(Method::PATCH, &path, Some(bad.clone())).await;
            assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
        }
        let audits: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_log WHERE target_id = $1 AND action IN ('node.update', 'node.groups.set')",
        )
        .bind(&id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(
            audits, 4,
            "create: update + groups; patch: update; patch: groups"
        );
        db.drop().await;
    }
}
