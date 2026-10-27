//! An in-process Cloudflare API for tests: token check, zones and records
//! with real paging, duplicate and permission errors, and scripted 429s.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};

/// The only token the mock accepts.
pub const GOOD_TOKEN: &str = "mock-token-0123456789abcdef0123456789";
/// A zone the token may read but not edit.
pub const READONLY_ZONE: &str = "readonly.test";

#[derive(Default)]
pub struct Inner {
    pub zones: Vec<(String, String)>,
    pub records: Vec<Value>,
    pub next: u64,
    /// Answer this many requests with 429 before serving.
    pub throttle: u32,
    pub retry_after: u64,
    pub requests: Vec<String>,
}

#[derive(Clone, Default)]
pub struct Mock(pub Arc<Mutex<Inner>>);

/// A 32-hex id from a counter.
fn id_of(prefix: &str, n: u64) -> String {
    format!("{prefix}{n:0>width$x}", width = 32 - prefix.len())
}

impl Mock {
    /// Zones `example.test` and `readonly.test`.
    pub fn new() -> Self {
        let m = Mock::default();
        {
            let mut g = m.0.lock().unwrap();
            g.zones = vec![
                (id_of("a", 1), "example.test".into()),
                (id_of("b", 2), READONLY_ZONE.into()),
            ];
        }
        m
    }

    pub fn zone_id(&self, name: &str) -> String {
        let g = self.0.lock().unwrap();
        g.zones.iter().find(|z| z.1 == name).unwrap().0.clone()
    }

    pub fn add(&self, zone: &str, kind: &str, name: &str, content: &str, proxied: bool) -> String {
        let mut g = self.0.lock().unwrap();
        g.next += 1;
        let id = id_of("c", g.next);
        let zone_id = g.zones.iter().find(|z| z.1 == zone).unwrap().0.clone();
        g.records.push(json!({
            "id": id, "zone_id": zone_id, "zone_name": zone, "type": kind, "name": name,
            "content": content, "proxied": proxied, "proxiable": true,
            "ttl": 1, "comment": null,
        }));
        id
    }

    pub fn records(&self) -> Vec<Value> {
        self.0.lock().unwrap().records.clone()
    }

    pub fn requests(&self) -> usize {
        self.0.lock().unwrap().requests.len()
    }

    /// Serve on a loopback port; returns the API base the panel is given.
    pub async fn serve(&self) -> String {
        let app = axum::Router::new()
            .route("/client/v4/zones", get(zones))
            .route(
                "/client/v4/zones/{zone}/dns_records",
                get(list).post(create),
            )
            .route(
                "/client/v4/zones/{zone}/dns_records/{id}",
                get(one).patch(patch).delete(remove),
            )
            .with_state(self.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://127.0.0.1:{port}/client/v4")
    }
}

fn envelope(result: &Value, info: Option<Value>) -> Response {
    let mut v = json!({ "success": true, "errors": [], "messages": [], "result": result });
    if let Some(i) = info {
        v["result_info"] = i;
    }
    axum::Json(v).into_response()
}

fn failure(status: StatusCode, code: i64, message: &str) -> Response {
    (
        status,
        axum::Json(
            json!({ "success": false, "errors": [{ "code": code, "message": message }],
                           "result": null }),
        ),
    )
        .into_response()
}

/// Token and throttle gate; `Some` is the answer to send instead.
fn gate(m: &Mock, headers: &HeaderMap, what: &str) -> Option<Response> {
    let mut g = m.0.lock().unwrap();
    g.requests.push(what.to_string());
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if bearer != Some(GOOD_TOKEN) {
        return Some(failure(
            StatusCode::UNAUTHORIZED,
            9109,
            "Invalid access token",
        ));
    }
    if g.throttle > 0 {
        g.throttle -= 1;
        let mut res = failure(StatusCode::TOO_MANY_REQUESTS, 971, "rate limited");
        res.headers_mut().insert(
            header::RETRY_AFTER,
            g.retry_after.to_string().parse().unwrap(),
        );
        return Some(res);
    }
    None
}

fn paging(q: &HashMap<String, String>) -> (usize, usize) {
    let get = |k: &str, d: usize| q.get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    (get("page", 1).max(1), get("per_page", 20).clamp(1, 100))
}

fn page_of(items: Vec<Value>, page: usize, per_page: usize) -> Response {
    let total = items.len();
    let from = (page - 1) * per_page;
    let slice: Vec<Value> = items.into_iter().skip(from).take(per_page).collect();
    envelope(
        &Value::Array(slice),
        Some(
            json!({ "page": page, "per_page": per_page, "total_count": total,
                     "total_pages": total.div_ceil(per_page).max(1) }),
        ),
    )
}

async fn zones(
    State(m): State<Mock>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Some(r) = gate(&m, &headers, "zones") {
        return r;
    }
    let (page, per_page) = paging(&q);
    let items =
        m.0.lock()
            .unwrap()
            .zones
            .iter()
            .map(|(id, name)| {
                let perms: Vec<&str> = if name == READONLY_ZONE {
                    vec!["#zone:read", "#dns_records:read"]
                } else {
                    vec!["#zone:read", "#dns_records:read", "#dns_records:edit"]
                };
                json!({ "id": id, "name": name, "status": "active", "paused": false,
                    "permissions": perms })
            })
            .collect();
    page_of(items, page, per_page)
}

fn zone_name(m: &Mock, zone: &str) -> Option<String> {
    m.0.lock()
        .unwrap()
        .zones
        .iter()
        .find(|z| z.0 == zone)
        .map(|z| z.1.clone())
}

async fn list(
    State(m): State<Mock>,
    headers: HeaderMap,
    Path(zone): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Some(r) = gate(&m, &headers, "list") {
        return r;
    }
    let Some(name) = zone_name(&m, &zone) else {
        return failure(StatusCode::NOT_FOUND, 7003, "no such zone");
    };
    let (page, per_page) = paging(&q);
    let items: Vec<Value> = m
        .records()
        .into_iter()
        .filter(|r| r["zone_name"] == name)
        .filter(|r| q.get("type").is_none_or(|t| r["type"] == *t))
        .filter(|r| {
            q.get("search").is_none_or(|s| {
                r["name"].as_str().unwrap_or_default().contains(s.as_str())
                    || r["content"]
                        .as_str()
                        .unwrap_or_default()
                        .contains(s.as_str())
            })
        })
        .collect();
    page_of(items, page, per_page)
}

async fn one(
    State(m): State<Mock>,
    headers: HeaderMap,
    Path((zone, id)): Path<(String, String)>,
) -> Response {
    if let Some(r) = gate(&m, &headers, "get") {
        return r;
    }
    match m
        .records()
        .into_iter()
        .find(|r| r["id"] == id && r["zone_id"] == zone)
    {
        Some(r) => envelope(&r, None),
        None => failure(StatusCode::NOT_FOUND, 81044, "Record does not exist."),
    }
}

async fn create(
    State(m): State<Mock>,
    headers: HeaderMap,
    Path(zone): Path<String>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    if let Some(r) = gate(&m, &headers, "create") {
        return r;
    }
    let Some(name) = zone_name(&m, &zone) else {
        return failure(StatusCode::NOT_FOUND, 7003, "no such zone");
    };
    if name == READONLY_ZONE {
        return failure(StatusCode::FORBIDDEN, 10000, "Authentication error");
    }
    let dup = m.records().iter().any(|r| {
        r["zone_name"] == name
            && r["type"] == body["type"]
            && r["name"] == body["name"]
            && r["content"] == body["content"]
    });
    if dup {
        return failure(
            StatusCode::BAD_REQUEST,
            81058,
            "A record with those settings already exists.",
        );
    }
    let mut rec = body;
    let mut g = m.0.lock().unwrap();
    g.next += 1;
    rec["id"] = json!(id_of("c", g.next));
    rec["zone_id"] = json!(zone);
    rec["zone_name"] = json!(name);
    rec["proxiable"] = json!(true);
    g.records.push(rec.clone());
    envelope(&rec, None)
}

async fn patch(
    State(m): State<Mock>,
    headers: HeaderMap,
    Path((zone, id)): Path<(String, String)>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    if let Some(r) = gate(&m, &headers, "patch") {
        return r;
    }
    if zone_name(&m, &zone).as_deref() == Some(READONLY_ZONE) {
        return failure(StatusCode::FORBIDDEN, 10000, "Authentication error");
    }
    let mut g = m.0.lock().unwrap();
    match g
        .records
        .iter_mut()
        .find(|r| r["id"] == id && r["zone_id"] == zone)
    {
        Some(r) => {
            for (k, v) in body.as_object().unwrap() {
                r[k] = v.clone();
            }
            envelope(&r.clone(), None)
        }
        None => failure(StatusCode::NOT_FOUND, 81044, "Record does not exist."),
    }
}

async fn remove(
    State(m): State<Mock>,
    headers: HeaderMap,
    Path((zone, id)): Path<(String, String)>,
) -> Response {
    if let Some(r) = gate(&m, &headers, "delete") {
        return r;
    }
    if zone_name(&m, &zone).as_deref() == Some(READONLY_ZONE) {
        return failure(StatusCode::FORBIDDEN, 10000, "Authentication error");
    }
    let mut g = m.0.lock().unwrap();
    let before = g.records.len();
    g.records
        .retain(|r| !(r["id"] == id && r["zone_id"] == zone));
    if g.records.len() == before {
        return failure(StatusCode::NOT_FOUND, 81044, "Record does not exist.");
    }
    envelope(&json!({ "id": id }), None)
}
