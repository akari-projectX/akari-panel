//! Real-database tests of the remote rule-sets: the save path downloads
//! and validates (refusing a bad first add, nothing saved), the hosted
//! sing-box copy (public path, ETag/304, canonical rejection for unknown
//! ids), sing-box profiles referencing it, the check endpoint (admin only,
//! nothing stored), the daily refresh (conditional requests, keep the last
//! good copy, broken lists, links saved before the feature, pruning) and
//! the SSRF guard on redirects. A local fixture server stands in for the
//! list host (plain http to 127.0.0.1 under the test switch).

use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::sub::{generate_token, hash_token};
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

const CLAUDE_YAML: &str = "payload:\n  - DOMAIN-SUFFIX,claude.ai\n  - DOMAIN-SUFFIX,anthropic.com\n  - DOMAIN-KEYWORD,claude\n  - IP-CIDR,160.79.104.0/23,no-resolve\n  - PROCESS-NAME,Claude.exe\n";

/// What the fixture answers: (status line, extra headers, body).
type Answer = (String, Vec<(String, String)>, String);

struct Fixture {
    port: u16,
    answer: Arc<Mutex<Answer>>,
    /// Request heads seen.
    seen: Arc<Mutex<Vec<String>>>,
}

impl Fixture {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let answer: Arc<Mutex<Answer>> = Arc::new(Mutex::new(ok(CLAUDE_YAML, Some("\"v1\""))));
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let (a, s) = (answer.clone(), seen.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let (a, s) = (a.clone(), s.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&buf).to_string();
                    s.lock().unwrap().push(head.clone());
                    let (status, headers, body) = a.lock().unwrap().clone();
                    // A conditional request matching the ETag gets a 304.
                    let etag = headers
                        .iter()
                        .find(|(k, _)| k == "ETag")
                        .map(|(_, v)| v.clone());
                    let not_modified = etag.is_some_and(|e| {
                        head.lines()
                            .any(|l| l.eq_ignore_ascii_case(&format!("if-none-match: {e}")))
                    });
                    let mut out = if not_modified {
                        "HTTP/1.1 304 Not Modified\r\n".to_string()
                    } else {
                        format!("HTTP/1.1 {status}\r\n")
                    };
                    for (k, v) in &headers {
                        out.push_str(&format!("{k}: {v}\r\n"));
                    }
                    let body = if not_modified { String::new() } else { body };
                    if !headers.iter().any(|(k, _)| k == "Content-Length") {
                        out.push_str(&format!("Content-Length: {}\r\n", body.len()));
                    }
                    out.push_str("Connection: close\r\n\r\n");
                    out.push_str(&body);
                    let _ = sock.write_all(out.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        Self { port, answer, seen }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn set(&self, a: Answer) {
        *self.answer.lock().unwrap() = a;
    }

    fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

fn ok(body: &str, etag: Option<&str>) -> Answer {
    let mut h = vec![("Content-Type".to_string(), "text/plain".to_string())];
    if let Some(e) = etag {
        h.push(("ETag".into(), e.into()));
    }
    ("200 OK".into(), h, body.into())
}

fn status(line: &str, headers: &[(&str, &str)]) -> Answer {
    (
        line.into(),
        headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        String::new(),
    )
}

async fn setup() -> Option<(TestDb, AppState, Client)> {
    let db = TestDb::new().await?;
    let state =
        AppState::for_test_with(db.pool.clone(), |c| c.limits.rule_set_fetch_loopback = true).await;
    let admin = client_for(&state, db.admin().await).await;
    Some((db, state, admin))
}

async fn version(admin: &Client) -> i64 {
    admin.get("/test/api/v1/settings").await.json()["version"]
        .as_i64()
        .unwrap()
}

/// PUT /settings/subscription with `items` as the AI service's items.
async fn save(admin: &Client, items: Value) -> crate::testdb::http::Resp {
    let v = version(admin).await;
    admin
        .put(
            "/test/api/v1/settings/subscription",
            json!({"version": v, "routing": {"services": [
                {"key": "ai", "name": "AI", "items": items}
            ]}}),
        )
        .await
}

async fn rows(db: &TestDb) -> Vec<(String, Option<String>, Option<String>, Option<i32>)> {
    sqlx::query_as("SELECT url, body, last_error, kept FROM sub_rule_sets ORDER BY url")
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

/// Make every stored list due for the refresh.
async fn make_due(db: &TestDb) {
    sqlx::query("UPDATE sub_rule_sets SET checked_at = now() - interval '2 days'")
        .execute(&db.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn save_downloads_hosts_and_profiles_reference_the_copy() {
    let Some((db, state, admin)) = setup().await else {
        return;
    };
    db.domains(&state, "sub", &["sub.example.com"]).await;
    let fx = Fixture::start().await;
    let url = fx.url("/Claude.yaml");
    let r = save(&admin, json!([{"type": "rule_set", "value": url}])).await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let stored = rows(&db).await;
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].0, url);
    assert_eq!(stored[0].3, Some(4), "kept rules (PROCESS-NAME skipped)");
    assert!(stored[0].2.is_none());

    // The hosted copy: public, cached, ETag / 304.
    let id = id_of(&url);
    let public = Client::new(&state, rand_ip());
    let r = public.get(&format!("/sub/rules/{id}.json")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.json(),
        json!({"version": 3, "rules": [
            {"domain_suffix": ["claude.ai", "anthropic.com"], "domain_keyword": ["claude"]},
            {"ip_cidr": ["160.79.104.0/23"]}
        ]})
    );
    assert_eq!(r.headers["cache-control"], "public, max-age=3600");
    assert_eq!(r.headers["content-type"], "application/json; charset=utf-8");
    let etag = r.headers["etag"].to_str().unwrap().to_string();
    let mut cond = Client::new(&state, rand_ip());
    cond.headers.push(("If-None-Match".into(), etag.clone()));
    let r = cond.get(&format!("/sub/rules/{id}.json")).await;
    assert_eq!(r.status, StatusCode::NOT_MODIFIED);
    assert_eq!(r.headers["etag"].to_str().unwrap(), etag);

    // Unknown, malformed, under the admin prefix, internal name: the
    // canonical rejection, byte for byte.
    let junk = public.get("/definitely-not-here").await.fingerprint();
    assert_eq!(junk.0, StatusCode::NOT_FOUND);
    for path in [
        format!("/sub/rules/{}.json", "0".repeat(32)),
        format!("/sub/rules/{id}"),
        format!("/sub/rules/{}.json", id.to_uppercase()),
        "/sub/rules/../x.json".into(),
        format!("/sub/rules/{id}.json/x"),
        format!("/test/sub-rules/{id}.json"),
        format!("/_/sub-rules/{id}.json"),
    ] {
        assert_eq!(public.get(&path).await.fingerprint(), junk, "{path}");
    }

    // A user's sing-box profile references the hosted copy on the user's
    // subscription origin; Clash keeps the original link.
    let u = db.user().await;
    let token = generate_token();
    sqlx::query("UPDATE users SET sub_token_hash = $2 WHERE id = $1")
        .bind(u)
        .bind(hash_token(&token))
        .execute(&db.pool)
        .await
        .unwrap();
    let mut sub = Client::new(&state, rand_ip());
    sub.headers.push(("Host".into(), "sub.example.com".into()));
    let r = sub.get(&format!("/sub/{token}?format=sing-box")).await;
    assert_eq!(r.status, StatusCode::OK);
    let profile: Value = serde_json::from_slice(&r.body).unwrap();
    let tag = routing::remote_name(&url);
    let rs = profile["route"]["rule_set"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["tag"] == tag)
        .cloned()
        .expect("the hosted rule set");
    assert_eq!(
        rs,
        json!({"type": "remote", "tag": tag, "format": "source",
               "url": format!("https://sub.example.com/sub/rules/{id}.json"),
               "update_interval": "1d"})
    );
    assert!(
        profile["route"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["rule_set"] == json!([tag]))
    );
    let r = sub.get(&format!("/sub/{token}?format=clash")).await;
    let clash = String::from_utf8_lossy(&r.body);
    assert!(clash.contains(&format!("url: \"{url}\"")), "{clash}");

    // The catalog shows the copy's state.
    let c = admin
        .get("/test/api/v1/settings/subscription/catalog")
        .await
        .json();
    assert_eq!(c["rule_sets"][0]["url"], url);
    assert_eq!(c["rule_sets"][0]["counts"]["unsupported"], 1);
    assert_eq!(
        c["rule_sets"][0]["counts"]["unsupported_types"]["PROCESS-NAME"],
        1
    );

    // Saving again does not download again; dropping the link drops the copy.
    let before = fx.requests().len();
    let r = save(
        &admin,
        json!([{"type": "rule_set", "value": url}, {"type": "domain", "value": "x.example"}]),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        fx.requests().len(),
        before,
        "held copies are not re-downloaded"
    );
    let r = save(&admin, json!([{"type": "domain", "value": "x.example"}])).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(rows(&db).await.is_empty(), "pruned with the link");
    assert_eq!(
        public
            .get(&format!("/sub/rules/{id}.json"))
            .await
            .fingerprint(),
        junk
    );
    db.drop().await;
}

#[tokio::test]
async fn a_bad_first_add_refuses_the_save() {
    let Some((db, state, admin)) = setup().await else {
        return;
    };
    let fx = Fixture::start().await;
    let v = version(&admin).await;
    let html = "<!DOCTYPE html>\n<html><head><title>Not Found</title></head>\n<body>\nnope\n</body></html>\n";
    for (answer, path, code) in [
        (
            status("404 Not Found", &[]),
            "/a.list",
            "settings.sub_rule_set_fetch_failed",
        ),
        (ok(html, None), "/b.list", "settings.sub_rule_set_invalid"),
        (
            ok("# nothing\n", None),
            "/c.list",
            "settings.sub_rule_set_invalid",
        ),
        (
            status("200 OK", &[("Content-Length", "6000000")]),
            "/d.list",
            "settings.sub_rule_set_too_large",
        ),
        (
            status("302 Found", &[("Location", "https://10.0.0.1/x.list")]),
            "/e.list",
            "settings.sub_rule_set_blocked",
        ),
        (
            status("302 Found", &[("Location", "http://127.0.0.1:1/x.list")]),
            "/f.list",
            "settings.sub_rule_set_fetch_failed",
        ),
        (
            status(
                "200 OK",
                &[("Content-Encoding", "gzip"), ("Content-Length", "3")],
            ),
            "/g.list",
            "settings.sub_rule_set_fetch_failed",
        ),
    ] {
        fx.set(answer);
        let url = fx.url(path);
        let r = save(&admin, json!([{"type": "rule_set", "value": url}])).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{path}");
        assert_eq!(r.json()["code"], code, "{path}: {:?}", r.json());
        assert_eq!(r.json()["params"]["url"], url);
    }
    // https to a private address: refused before any connection.
    let r = save(
        &admin,
        json!([{"type": "rule_set", "value": "https://169.254.169.254/latest/a.list"}]),
    )
    .await;
    assert_eq!(r.json()["code"], "settings.sub_rule_set_blocked");
    // Too many links.
    let many: Vec<Value> = (0..=routing::MAX_RULE_SETS)
        .map(|i| json!({"type": "rule_set", "value": format!("https://r.example/{i}.list")}))
        .collect();
    let r = save(&admin, json!(many)).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "settings.sub_rule_sets_too_many");
    // Nothing was saved or stored.
    assert_eq!(version(&admin).await, v);
    assert!(rows(&db).await.is_empty());
    assert!(
        state
            .settings()
            .get()
            .sub_routing
            .config
            .rule_set_urls()
            .is_empty()
    );
    db.drop().await;
}

#[tokio::test]
async fn without_the_test_switch_loopback_is_refused() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let fx = Fixture::start().await;
    let r = save(
        &admin,
        json!([{"type": "rule_set", "value": fx.url("/a.list")}]),
    )
    .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.json()["code"], "settings.sub_rule_set_fetch_failed");
    assert!(fx.requests().is_empty(), "no connection was made");
    db.drop().await;
}

#[tokio::test]
async fn check_endpoint_is_admin_only_and_stores_nothing() {
    let Some((db, state, admin)) = setup().await else {
        return;
    };
    let fx = Fixture::start().await;
    let url = fx.url("/Claude.yaml?raw=1");
    let audits = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit_log")
            .fetch_one(&db.pool)
            .await
            .unwrap()
    };
    let audits0 = audits().await;
    let r = admin
        .post(
            "/test/api/v1/settings/subscription/rule-set/check",
            json!({"url": url}),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let v = r.json();
    assert_eq!(v["id"], id_of(&url));
    assert_eq!(v["clash_format"], "yaml");
    assert_eq!(v["kept"], 4);
    assert_eq!(v["counts"]["total"], 5);
    assert_eq!(
        v["sample"][0],
        json!({"type": "domain_suffix", "value": "claude.ai"})
    );
    assert_eq!(v["stored"], Value::Null);
    assert!(rows(&db).await.is_empty(), "a check stores nothing");
    assert_eq!(audits().await, audits0, "a check is not audited");
    for (body, code) in [
        (
            json!({"url": "ftp://x.example/a"}),
            "settings.sub_rule_set_link_invalid",
        ),
        (
            json!({"url": "https://x.example/a#b"}),
            "settings.sub_rule_set_link_invalid",
        ),
    ] {
        let r = admin
            .post("/test/api/v1/settings/subscription/rule-set/check", body)
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        assert_eq!(r.json()["code"], code);
    }
    let r = admin
        .post(
            "/test/api/v1/settings/subscription/rule-set/check",
            json!({"url": url, "extra": 1}),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let user = client_for(&state, db.user().await).await;
    let r = user
        .post(
            "/test/api/v1/settings/subscription/rule-set/check",
            json!({"url": url}),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    db.drop().await;
}

#[tokio::test]
async fn refresh_is_conditional_and_keeps_the_last_good_copy() {
    let Some((db, state, admin)) = setup().await else {
        return;
    };
    let fx = Fixture::start().await;
    let url = fx.url("/Claude.yaml");
    assert_eq!(
        save(&admin, json!([{"type": "rule_set", "value": url}]))
            .await
            .status,
        StatusCode::OK
    );
    let body0 = rows(&db).await[0].1.clone().unwrap();
    // Nothing due yet.
    let r = round(&state).await.unwrap().unwrap();
    assert_eq!((r.checked, r.failed, r.broken), (0, 0, 0));

    // Due: a conditional request, 304 = unchanged.
    make_due(&db).await;
    let r = round(&state).await.unwrap().unwrap();
    assert_eq!((r.checked, r.failed), (1, 0));
    let last = fx.requests().pop().unwrap();
    assert!(
        last.lines()
            .any(|l| l.eq_ignore_ascii_case("if-none-match: \"v1\"")),
        "{last}"
    );
    let fresh: bool = sqlx::query_scalar(
        "SELECT fetched_at > now() - interval '1 minute' AND checked_at > now() - interval '1 minute' FROM sub_rule_sets",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(fresh);

    // The host breaks: the last good copy stays, the error is recorded and
    // retried after an hour (not before).
    fx.set(status("500 Internal Server Error", &[]));
    make_due(&db).await;
    let r = round(&state).await.unwrap().unwrap();
    assert_eq!((r.checked, r.failed, r.broken), (1, 1, 0));
    let row = rows(&db).await.remove(0);
    assert_eq!(row.1.as_deref(), Some(body0.as_str()));
    assert_eq!(row.2.as_deref(), Some("HTTP 500"));
    let public = Client::new(&state, rand_ip());
    assert_eq!(
        public
            .get(&format!("/sub/rules/{}.json", id_of(&url)))
            .await
            .status,
        StatusCode::OK
    );
    let r = round(&state).await.unwrap().unwrap();
    assert_eq!(r.checked, 0, "a failing list is retried hourly");
    sqlx::query(
        "UPDATE sub_rule_sets SET checked_at = now() - interval '2 hours', \
         failing_since = now() - interval '3 days'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let r = round(&state).await.unwrap().unwrap();
    assert_eq!((r.checked, r.failed, r.broken), (1, 1, 1));
    let since_kept: bool =
        sqlx::query_scalar("SELECT failing_since < now() - interval '2 days' FROM sub_rule_sets")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(since_kept, "failing_since is the first failure");

    // New content: replaced, the error cleared.
    fx.set(ok("DOMAIN,new.example\n", Some("\"v2\"")));
    make_due(&db).await;
    let r = round(&state).await.unwrap().unwrap();
    assert_eq!((r.checked, r.failed, r.broken), (1, 0, 0));
    let row = rows(&db).await.remove(0);
    assert!(row.2.is_none());
    assert_eq!(
        serde_json::from_str::<Value>(row.1.as_deref().unwrap()).unwrap(),
        json!({"version": 3, "rules": [{"domain": ["new.example"]}]})
    );
    db.drop().await;
}

#[tokio::test]
async fn refresh_picks_up_links_saved_before_and_prunes_dropped_ones() {
    let Some((db, state, _admin)) = setup().await else {
        return;
    };
    let fx = Fixture::start().await;
    let url = fx.url("/Old.list");
    // A routing saved before this feature (no copy), and a stale copy of a
    // link no longer named.
    db.settings(
        &state,
        &format!(
            "sub_routing = '{}'::jsonb",
            json!({"block": [{"type": "rule_set", "value": url}],
                   "services": [{"key": "rule_set", "name": "rule_set",
                                 "items": [{"type": "domain", "value": "rule_set.example"}]}]})
        ),
    )
    .await;
    sqlx::query(
        "INSERT INTO sub_rule_sets (id, url, body, etag, counts, kept, fetched_at) \
         VALUES ($1, 'https://gone.example/x.list', '{}', 'e', '{}', 0, now())",
    )
    .bind(id_of("https://gone.example/x.list"))
    .execute(&db.pool)
    .await
    .unwrap();
    let r = round(&state).await.unwrap().unwrap();
    assert_eq!((r.pruned, r.checked, r.failed), (1, 1, 0));
    let stored = rows(&db).await;
    assert_eq!(stored.len(), 1, "only links of the routing (items only)");
    assert_eq!(stored[0].0, url);
    assert!(stored[0].1.is_some());

    // A failure on a link without any copy: recorded, nothing hosted, and
    // the profile leaves the list out.
    let url2 = fx.url("/Broken.list");
    db.settings(
        &state,
        &format!(
            "sub_routing = '{}'::jsonb",
            json!({"direct": [{"type": "rule_set", "value": url2}]})
        ),
    )
    .await;
    fx.set(status("404 Not Found", &[]));
    let r = round(&state).await.unwrap().unwrap();
    assert_eq!((r.pruned, r.checked, r.failed), (1, 1, 1));
    let stored = rows(&db).await;
    assert_eq!(
        (
            stored[0].0.as_str(),
            stored[0].1.is_none(),
            stored[0].2.as_deref()
        ),
        (url2.as_str(), true, Some("HTTP 404"))
    );
    let routing = state.settings().get().sub_routing.clone();
    assert_eq!(
        hosted(&state, &routing, Some("https://s.example/sub")).await,
        Hosted::default()
    );
    db.drop().await;
}

/// Two instances: one round at a time (the advisory try-lock).
#[tokio::test]
async fn one_round_at_a_time() {
    let Some((db, state, _admin)) = setup().await else {
        return;
    };
    let mut held = db.pool.begin().await.unwrap();
    let won: bool = sqlx::query_scalar(LOCK_SQL)
        .fetch_one(&mut *held)
        .await
        .unwrap();
    assert!(won);
    assert_eq!(round(&state).await.unwrap(), None);
    held.rollback().await.unwrap();
    assert!(round(&state).await.unwrap().is_some());
    db.drop().await;
}
