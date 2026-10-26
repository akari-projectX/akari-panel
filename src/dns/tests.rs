//! Route-level tests of the DNS management against the in-process
//! Cloudflare mock (`mock.rs`) and a real database.

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};

use super::mock::{GOOD_TOKEN, Mock};
use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for};

const BASE: &str = "/test/api/v1/dns";

struct Env {
    db: TestDb,
    mock: Mock,
    owner: Client,
    state: AppState,
}

async fn setup() -> Option<Env> {
    let db = TestDb::new().await?;
    let mock = Mock::new();
    let base = mock.serve().await;
    let state =
        AppState::for_test_with(db.pool.clone(), |c| c.limits.cloudflare_api_base = base).await;
    let owner_id = db.owner().await;
    let owner = client_for(&state, owner_id).await;
    Some(Env {
        db,
        mock,
        owner,
        state,
    })
}

impl Env {
    /// Add a token and return the account id.
    async fn account(&self, name: &str, token: &str) -> String {
        let r = self
            .owner
            .post(
                &format!("{BASE}/accounts"),
                json!({ "name": name, "token": token }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
        r.json()["id"].as_str().unwrap().to_string()
    }

    fn records_path(&self, account: &str, zone: &str) -> String {
        format!(
            "{BASE}/accounts/{account}/zones/{}/records",
            self.mock.zone_id(zone)
        )
    }

    async fn audits(&self, action: &str) -> Vec<Value> {
        sqlx::query_scalar("SELECT jsonb_build_object('before', before, 'after', after, 'target', target_id) FROM audit_log WHERE action = $1 ORDER BY id")
            .bind(action)
            .fetch_all(&self.db.pool)
            .await
            .unwrap()
    }

    /// The panel depends on `host` as its main domain.
    async fn make_main_domain(&self, host: &str) {
        sqlx::query("INSERT INTO site_domains (kind, domain, host, preferred) VALUES ('main', $1, $1, true)")
            .bind(host)
            .execute(&self.db.pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn tokens_are_sealed_write_only_and_owner_only() {
    let Some(env) = setup().await else { return };
    let id = env.account("main", GOOD_TOKEN).await;
    let list = env.owner.get(&format!("{BASE}/accounts")).await;
    let text = list.json().to_string();
    assert!(!text.contains(GOOD_TOKEN), "the token must never be shown");
    let acc = &list.json()["accounts"][0];
    assert_eq!(acc["token_set"], true);
    assert_eq!(acc["fingerprint"].as_str().unwrap().len(), 12);
    // Sealed at rest, and the audit says "changed".
    let blob: Vec<u8> = sqlx::query_scalar("SELECT token_enc FROM dns_accounts")
        .fetch_one(&env.db.pool)
        .await
        .unwrap();
    assert!(
        !blob
            .windows(GOOD_TOKEN.len())
            .any(|w| w == GOOD_TOKEN.as_bytes())
    );
    let audit = env.audits("dns.account.create").await;
    assert_eq!(audit[0]["after"]["token"], "changed");
    assert!(!audit[0].to_string().contains(GOOD_TOKEN));
    // Update: an empty token keeps the stored one; a stale version is 409.
    let put = |version: i64, token: Value| {
        let (owner, path) = (&env.owner, format!("{BASE}/accounts/{id}"));
        async move {
            owner
                .put(
                    &path,
                    json!({ "name": "renamed", "token": token, "version": version }),
                )
                .await
        }
    };
    let r = put(1, json!("")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["fingerprint"], acc["fingerprint"]);
    assert_eq!(put(1, json!("")).await.status, StatusCode::CONFLICT);
    let r = put(2, json!("another-token-0123456789abcdef")).await;
    assert_ne!(r.json()["fingerprint"], acc["fingerprint"]);
    assert_eq!(
        env.audits("dns.account.update").await[1]["after"]["token"],
        "changed"
    );
    // Shape and name checks.
    let bad = env
        .owner
        .post(
            &format!("{BASE}/accounts"),
            json!({ "name": "x", "token": "short" }),
        )
        .await;
    assert_eq!(bad.json()["code"], "dns.token_invalid");
    let dup = env
        .owner
        .post(
            &format!("{BASE}/accounts"),
            json!({ "name": "RENAMED", "token": GOOD_TOKEN }),
        )
        .await;
    assert_eq!(dup.json()["code"], "dns.account_name_exists");
    // A second admin may read but not write the tokens.
    let admin = client_for(&env.state, env.db.admin().await).await;
    assert_eq!(
        admin.get(&format!("{BASE}/accounts")).await.status,
        StatusCode::OK
    );
    let r = admin
        .post(
            &format!("{BASE}/accounts"),
            json!({ "name": "evil", "token": GOOD_TOKEN }),
        )
        .await;
    assert!(!r.status.is_success(), "only the owner writes tokens");
    assert_eq!(
        admin
            .req(Method::DELETE, &format!("{BASE}/accounts/{id}"), None)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let gone = env
        .owner
        .req(Method::DELETE, &format!("{BASE}/accounts/{id}"), None)
        .await;
    assert_eq!(gone.status, StatusCode::NO_CONTENT);
    assert_eq!(env.audits("dns.account.delete").await.len(), 1);
}

#[tokio::test]
async fn test_connection_and_zone_listing() {
    let Some(env) = setup().await else { return };
    let good = env.account("good", GOOD_TOKEN).await;
    let bad = env.account("bad", "wrong-token-0123456789abcdef0123").await;
    let r = env
        .owner
        .post(&format!("{BASE}/accounts/{good}/test"), json!({}))
        .await;
    let t = r.json();
    assert_eq!(
        (t["ok"].clone(), t["zones"].clone()),
        (json!(true), json!(2)),
        "{t}"
    );
    assert_eq!(
        (t["editable"].clone(), t["read_only"].clone()),
        (json!(1), json!(1))
    );
    let r = env
        .owner
        .post(&format!("{BASE}/accounts/{bad}/test"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        (r.json()["ok"].clone(), r.json()["code"].clone()),
        (json!(false), json!("dns.token_rejected"))
    );
    // One failing token does not hide the zones of the other.
    let z = env.owner.get(&format!("{BASE}/zones")).await.json();
    assert_eq!(z["zones"].as_array().unwrap().len(), 2);
    assert_eq!(z["zones"][0]["account_name"], "good");
    assert_eq!(z["errors"][0]["code"], "dns.token_rejected");
    assert_eq!(z["errors"][0]["account_name"], "bad");
}

#[tokio::test]
async fn records_list_page_filter_and_mark_dependencies() {
    let Some(env) = setup().await else { return };
    let acc = env.account("a", GOOD_TOKEN).await;
    for i in 0..7 {
        env.mock.add(
            "example.test",
            "A",
            &format!("h{i}.example.test"),
            "192.0.2.1",
            false,
        );
    }
    env.mock.add(
        "example.test",
        "TXT",
        "txt.example.test",
        "v=spf1 -all",
        false,
    );
    env.mock.add(
        "readonly.test",
        "A",
        "other.readonly.test",
        "192.0.2.9",
        false,
    );
    env.make_main_domain("h3.example.test").await;
    let path = env.records_path(&acc, "example.test");
    let p1 = env
        .owner
        .get(&format!("{path}?per_page=5&type=A"))
        .await
        .json();
    assert_eq!(p1["records"].as_array().unwrap().len(), 5);
    assert_eq!(p1["page_info"]["total_count"], 7);
    assert_eq!(p1["page_info"]["total_pages"], 2);
    let p2 = env
        .owner
        .get(&format!("{path}?per_page=5&type=A&page=2"))
        .await
        .json();
    assert_eq!(p2["records"].as_array().unwrap().len(), 2);
    let found = env.owner.get(&format!("{path}?search=h3")).await.json();
    assert_eq!(found["records"].as_array().unwrap().len(), 1);
    assert_eq!(found["records"][0]["uses"][0]["kind"], "main");
    assert_eq!(p1["records"][0]["uses"], json!([]));
    // Bad input never reaches Cloudflare.
    let before = env.mock.requests();
    for q in ["type=PTR", "search=%00"] {
        assert_eq!(
            env.owner.get(&format!("{path}?{q}")).await.status,
            StatusCode::BAD_REQUEST,
            "{q}"
        );
    }
    let bad_zone = env
        .owner
        .get(&format!(
            "{BASE}/accounts/{acc}/zones/..%2f..%2fuser/records"
        ))
        .await;
    assert_eq!(bad_zone.status, StatusCode::NOT_FOUND);
    assert_eq!(env.mock.requests(), before);
}

#[tokio::test]
async fn create_update_delete_are_audited_with_before_and_after() {
    let Some(env) = setup().await else { return };
    let acc = env.account("a", GOOD_TOKEN).await;
    let path = env.records_path(&acc, "example.test");
    let body = json!({ "type": "A", "name": "new.example.test", "content": "192.0.2.5",
                       "ttl": 300, "comment": "made by test" });
    let r = env.owner.post(&path, body.clone()).await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let id = r.json()["id"].as_str().unwrap().to_string();
    // The same record again is Cloudflare's conflict, coded.
    let dup = env.owner.post(&path, body).await;
    assert_eq!(
        (dup.status, dup.json()["code"].clone()),
        (StatusCode::CONFLICT, json!("dns.record_conflict"))
    );
    // Invalid content is refused here.
    let bad = env
        .owner
        .post(
            &path,
            json!({ "type": "A", "name": "x.example.test", "content": "nope" }),
        )
        .await;
    assert_eq!(bad.json()["code"], "dns.record_field_invalid");
    // Update: grey -> orange.
    let up = env
        .owner
        .put(
            &format!("{path}/{id}"),
            json!({ "type": "A", "name": "new.example.test", "content": "192.0.2.6", "proxied": true }),
        )
        .await;
    assert_eq!(up.status, StatusCode::OK, "{:?}", up.json());
    assert_eq!(
        (up.json()["content"].clone(), up.json()["proxied"].clone()),
        (json!("192.0.2.6"), json!(true))
    );
    let del = env
        .owner
        .req(Method::DELETE, &format!("{path}/{id}"), None)
        .await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    assert!(env.mock.records().is_empty());
    assert_eq!(
        env.audits("dns.record.create").await[0]["after"]["record"]["content"],
        "192.0.2.5"
    );
    let u = &env.audits("dns.record.update").await[0];
    assert_eq!(u["before"]["record"]["content"], "192.0.2.5");
    assert_eq!(u["after"]["record"]["content"], "192.0.2.6");
    assert_eq!(u["after"]["zone"], "example.test");
    let d = &env.audits("dns.record.delete").await[0];
    assert_eq!(d["before"]["record"]["name"], "new.example.test");
    assert!(!d.to_string().contains(GOOD_TOKEN));
    // Permission errors of Cloudflare are coded and audit nothing.
    let ro = env.records_path(&acc, "readonly.test");
    let r = env
        .owner
        .post(
            &ro,
            json!({ "type": "A", "name": "a.readonly.test", "content": "192.0.2.7" }),
        )
        .await;
    assert_eq!(r.json()["code"], "dns.permission_denied");
    assert_eq!(env.audits("dns.record.create").await.len(), 1);
}

#[tokio::test]
async fn dangerous_records_need_confirmation() {
    let Some(env) = setup().await else { return };
    let acc = env.account("a", GOOD_TOKEN).await;
    let id = env
        .mock
        .add("example.test", "A", "panel.example.test", "192.0.2.1", true);
    env.make_main_domain("panel.example.test").await;
    let path = env.records_path(&acc, "example.test");
    let r = env
        .owner
        .req(Method::DELETE, &format!("{path}/{id}"), None)
        .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::CONFLICT, json!("dns.confirm_required"))
    );
    assert_eq!(r.json()["params"]["impact"][0]["uses"][0]["kind"], "main");
    assert_eq!(env.mock.records().len(), 1);
    // Changing the address needs it too; the comment alone does not.
    let change = |content: &'static str, comment: &'static str, confirm: bool| {
        let (owner, url) = (&env.owner, format!("{path}/{id}"));
        async move {
            owner
                .put(
                    &url,
                    json!({ "type": "A", "name": "panel.example.test", "content": content,
                            "proxied": true, "comment": comment, "confirm": confirm }),
                )
                .await
        }
    };
    assert_eq!(
        change("192.0.2.2", "", false).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        change("192.0.2.1", "note", false).await.status,
        StatusCode::OK
    );
    assert_eq!(
        change("192.0.2.2", "note", true).await.status,
        StatusCode::OK
    );
    let r = env
        .owner
        .req(Method::DELETE, &format!("{path}/{id}?confirm=true"), None)
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn batch_operations_report_each_record() {
    let Some(env) = setup().await else { return };
    let acc = env.account("a", GOOD_TOKEN).await;
    let a1 = env
        .mock
        .add("example.test", "A", "a1.example.test", "192.0.2.1", false);
    let a2 = env
        .mock
        .add("example.test", "A", "a2.example.test", "192.0.2.1", false);
    let aaaa = env.mock.add(
        "example.test",
        "AAAA",
        "a3.example.test",
        "2001:db8::1",
        false,
    );
    let txt = env
        .mock
        .add("example.test", "TXT", "t.example.test", "x", false);
    let path = format!("{}/batch", env.records_path(&acc, "example.test"));
    // Orange cloud: the TXT record cannot be proxied.
    let r = env
        .owner
        .post(
            &path,
            json!({ "action": "proxied", "proxied": true, "ids": [a1, a2, txt] }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(
        (r.json()["ok"].clone(), r.json()["failed"].clone()),
        (json!(2), json!(1))
    );
    assert_eq!(r.json()["results"][2]["code"], "dns.batch_skipped");
    assert!(
        env.mock
            .records()
            .iter()
            .filter(|x| x["proxied"] == true)
            .count()
            == 2
    );
    // New IPv4 address: the AAAA record is skipped.
    let r = env
        .owner
        .post(
            &path,
            json!({ "action": "content", "content": "198.51.100.9", "ids": [a1, a2, aaaa] }),
        )
        .await;
    assert_eq!(r.json()["ok"], 2);
    assert_eq!(r.json()["results"][2]["params"]["reason"], "address_family");
    assert_eq!(env.audits("dns.record.update").await.len(), 4);
    // A record the panel uses holds the whole batch until confirmed.
    env.make_main_domain("a1.example.test").await;
    let del = json!({ "action": "delete", "ids": [a1, a2] });
    let r = env.owner.post(&path, del.clone()).await;
    assert_eq!(r.json()["code"], "dns.confirm_required");
    assert_eq!(env.mock.records().len(), 4);
    let mut confirmed = del;
    confirmed["confirm"] = json!(true);
    let r = env.owner.post(&path, confirmed).await;
    assert_eq!(r.json()["ok"], 2);
    assert_eq!(env.mock.records().len(), 2);
    assert_eq!(env.audits("dns.record.delete").await.len(), 2);
    // Size limits.
    let none = env
        .owner
        .post(&path, json!({ "action": "delete", "ids": [] }))
        .await;
    assert_eq!(none.json()["code"], "dns.batch_size");
}

#[tokio::test]
async fn rate_limits_are_retried_or_reported() {
    let Some(env) = setup().await else { return };
    let acc = env.account("a", GOOD_TOKEN).await;
    let path = env.records_path(&acc, "example.test");
    {
        let mut g = env.mock.0.lock().unwrap();
        g.throttle = 1;
        g.retry_after = 1;
    }
    let ok = env.owner.get(&path).await;
    assert_eq!(ok.status, StatusCode::OK, "a short wait is waited out");
    {
        let mut g = env.mock.0.lock().unwrap();
        g.throttle = 10;
        g.retry_after = 60;
    }
    let r = env.owner.get(&path).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        (
            r.json()["code"].clone(),
            r.json()["params"]["retry_after_secs"].clone()
        ),
        (json!("dns.rate_limited"), json!(60))
    );
}

// ---------------------------------------------------------------------------
// Linking the panel's names
// ---------------------------------------------------------------------------

const SETTINGS: &str = "/test/api/v1/settings/public-addresses";

impl Env {
    async fn set_addresses(&self, v4: &str, v6: &str) {
        let version: i64 = sqlx::query_scalar("SELECT version FROM panel_settings WHERE id = 1")
            .fetch_one(&self.db.pool)
            .await
            .unwrap();
        let r = self
            .owner
            .put(
                SETTINGS,
                json!({ "version": version, "public_ipv4": v4, "public_ipv6": v6 }),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    }

    async fn make_domain(&self, kind: &str, host: &str) {
        sqlx::query(
            "INSERT INTO site_domains (kind, domain, host, preferred) \
             VALUES ($1, $2, $2, NOT EXISTS (SELECT 1 FROM site_domains WHERE kind = $1))",
        )
        .bind(kind)
        .bind(host)
        .execute(&self.db.pool)
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn public_addresses_are_owner_only_validated_and_audited() {
    let Some(env) = setup().await else { return };
    let version: i64 = sqlx::query_scalar("SELECT version FROM panel_settings WHERE id = 1")
        .fetch_one(&env.db.pool)
        .await
        .unwrap();
    for (v4, v6) in [
        ("10.0.0.1", ""),
        ("203.0.113.5", ""),
        ("", "fe80::1"),
        ("2001:4860:4860::8888", ""),
        ("nope", ""),
    ] {
        let r = env
            .owner
            .put(
                SETTINGS,
                json!({ "version": version, "public_ipv4": v4, "public_ipv6": v6 }),
            )
            .await;
        assert_eq!(
            (r.status, r.json()["code"].clone()),
            (
                StatusCode::BAD_REQUEST,
                json!("settings.public_address_invalid")
            ),
            "{v4} {v6}"
        );
    }
    let admin = client_for(&env.state, env.db.admin().await).await;
    let r = admin
        .put(
            SETTINGS,
            json!({ "version": version, "public_ipv4": "8.8.8.8" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    env.set_addresses("8.8.8.8", "2001:4860:4860::8888").await;
    // A stale form is a conflict.
    let r = env
        .owner
        .put(SETTINGS, json!({ "version": version, "public_ipv4": "" }))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let audit = env.audits("settings.public_addresses.update").await;
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0]["after"]["public_ipv4"], "8.8.8.8");
}

#[tokio::test]
async fn domains_show_their_records_and_link_creates_updates_and_stays_grey() {
    let Some(env) = setup().await else { return };
    let acc = env.account("a", GOOD_TOKEN).await;
    env.make_domain("main", "panel.example.test").await;
    env.make_domain("node", "node.example.test").await;
    env.make_domain("sub", "sub.elsewhere.invalid").await;
    env.mock
        .add("example.test", "A", "panel.example.test", "192.0.2.1", true);
    let r = env.owner.get(&format!("{BASE}/domains")).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let hosts = r.json()["hosts"].as_array().unwrap().clone();
    let by = |h: &str| hosts.iter().find(|x| x["host"] == h).unwrap().clone();
    assert_eq!(
        by("panel.example.test")["records"][0]["content"],
        "192.0.2.1"
    );
    assert_eq!(by("panel.example.test")["records"][0]["proxied"], true);
    assert_eq!(
        by("node.example.test")["records"].as_array().unwrap().len(),
        0
    );
    assert!(by("sub.elsewhere.invalid")["zone"].is_null());
    // No address configured: refused, nothing written.
    let link = |hosts: Value, confirm: bool| {
        let owner = &env.owner;
        async move {
            owner
                .post(
                    &format!("{BASE}/link"),
                    json!({ "hosts": hosts, "confirm": confirm }),
                )
                .await
        }
    };
    let r = link(json!([{ "host": "node.example.test" }]), false).await;
    assert_eq!(r.json()["code"], "dns.panel_address_unset");
    env.set_addresses("8.8.8.8", "2001:4860:4860::8888").await;
    // The node domain is created grey (A and AAAA), even if orange was asked.
    let r = link(
        json!([{ "host": "node.example.test", "proxied": true }]),
        false,
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["ok"], 1);
    let recs: Vec<Value> = env
        .mock
        .records()
        .into_iter()
        .filter(|x| x["name"] == "node.example.test")
        .collect();
    assert_eq!(recs.len(), 2);
    assert!(recs.iter().all(|x| x["proxied"] == false));
    // Again: nothing to change.
    let r = link(json!([{ "host": "node.example.test" }]), false).await;
    assert_eq!(r.json()["results"][0]["changes"][0]["action"], "unchanged");
    // The main domain exists with another address: updating asks first.
    let r = link(
        json!([{ "host": "panel.example.test", "address": "8.8.4.4" }]),
        false,
    )
    .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::CONFLICT, json!("dns.confirm_required"))
    );
    assert!(
        env.mock
            .records()
            .iter()
            .any(|x| x["content"] == "192.0.2.1")
    );
    let r = link(
        json!([{ "host": "panel.example.test", "address": "8.8.4.4" }]),
        true,
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["results"][0]["changes"][0]["action"], "updated");
    // The orange cloud of a web name is kept.
    let kept = env
        .mock
        .records()
        .into_iter()
        .find(|x| x["name"] == "panel.example.test")
        .unwrap();
    assert_eq!(
        (kept["content"].clone(), kept["proxied"].clone()),
        (json!("8.8.4.4"), json!(true))
    );
    // A name nobody manages, and an IP literal, fail on their own.
    let r = link(
        json!([{ "host": "sub.elsewhere.invalid" }, { "host": "8.8.8.8" }]),
        false,
    )
    .await;
    let codes: Vec<Value> = r.json()["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["code"].clone())
        .collect();
    assert_eq!(
        codes,
        vec![json!("dns.link_no_zone"), json!("dns.link_not_a_name")]
    );
    // Writes were audited like the records API's.
    assert_eq!(env.audits("dns.record.create").await.len(), 2);
    assert_eq!(env.audits("dns.record.update").await.len(), 1);
    let _ = acc;
}

#[tokio::test]
async fn a_server_links_its_certificate_domain_and_direct_hosts() {
    let Some(env) = setup().await else { return };
    env.account("a", GOOD_TOKEN).await;
    let node = env.db.node().await;
    let server = env.db.server_of(node).await;
    sqlx::query("UPDATE servers SET tls_domain = 'hk.example.test', agent_addr = '8.8.4.4'::inet WHERE id = $1")
        .bind(server)
        .execute(&env.db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE entrances SET connect_host = 'direct.example.test' WHERE node_id = $1 AND kind = 'direct'")
        .bind(node)
        .execute(&env.db.pool)
        .await
        .unwrap();
    let status = env.owner.get(&format!("{BASE}/link/server/{server}")).await;
    assert_eq!(status.status, StatusCode::OK, "{:?}", status.json());
    assert_eq!(status.json()["address"], "8.8.4.4");
    assert_eq!(status.json()["hosts"].as_array().unwrap().len(), 2);
    let r = env
        .owner
        .post(&format!("{BASE}/link/server/{server}"), json!({}))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["ok"], 2);
    let recs = env.mock.records();
    assert_eq!(recs.len(), 2);
    assert!(
        recs.iter()
            .all(|x| x["content"] == "8.8.4.4" && x["proxied"] == false)
    );
    // The machine moved: the same call with the new address updates both
    // (they are in use by the panel, so it asks first).
    let r = env
        .owner
        .post(
            &format!("{BASE}/link/server/{server}"),
            json!({ "address": "8.8.8.8" }),
        )
        .await;
    assert_eq!(r.json()["code"], "dns.confirm_required");
    let r = env
        .owner
        .post(
            &format!("{BASE}/link/server/{server}"),
            json!({ "address": "8.8.8.8", "confirm": true }),
        )
        .await;
    assert_eq!(r.json()["ok"], 2);
    assert!(env.mock.records().iter().all(|x| x["content"] == "8.8.8.8"));
    // A private address is refused; an unknown server is 404.
    let r = env
        .owner
        .post(
            &format!("{BASE}/link/server/{server}"),
            json!({ "address": "10.0.0.1" }),
        )
        .await;
    assert_eq!(r.json()["code"], "dns.link_address_invalid");
    let r = env
        .owner
        .get(&format!("{BASE}/link/server/{}", uuid::Uuid::new_v4()))
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}
