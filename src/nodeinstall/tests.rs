use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::*;
use crate::testdb::fake_agent::PanelHarness;
use crate::testdb::http::{rand_ip, Client, Fingerprint};
use crate::testdb::TestDb;

const ORIGIN: &str = "http://127.0.0.1:8080";

#[test]
fn origins() {
    for (raw, want) in [
        ("https://panel.example.com", "https://panel.example.com"),
        (
            "https://Panel.Example.com:8443/",
            "https://panel.example.com:8443",
        ),
        ("https://203.0.113.7", "https://203.0.113.7"),
        ("https://[2001:db8::1]:443", "https://[2001:db8::1]:443"),
        ("http://127.0.0.1:8080", "http://127.0.0.1:8080"),
        ("http://myapp.test:8080", "http://myapp.test:8080"),
        ("http://localhost", "http://localhost"),
    ] {
        assert_eq!(parse_origin(raw).unwrap().as_string(), want, "{raw}");
    }
    for bad in [
        "panel.example.com",
        "http://panel.example.com",
        "http://203.0.113.7",
        "https://panel.example.com/x",
        "https://user@panel.example.com",
        "https://panel.example.com:0",
        "https://panel.example.com:99999",
        "https://pa'nel.com",
        "https://[zz::1]",
        "ftp://x.com",
    ] {
        assert!(parse_origin(bad).is_err(), "{bad}");
    }
}

#[test]
fn pins_and_fallback_urls() {
    let pin = format!("sha256//{}", STANDARD.encode([7u8; 32]));
    assert!(valid_pin(&pin));
    assert!(!valid_pin("sha256//abc"));
    assert!(!valid_pin(&STANDARD.encode([7u8; 32])));
    assert!(fallback_url_ok(crate::config::DEFAULT_FALLBACK_BINARY_URL));
    for bad in [
        "http://x.com/a-{arch}",
        "https://x.com/a",
        "https://x.com/a-{arch}'",
        "https://x.com/$(id)-{arch}",
        "https://x.com/a b-{arch}",
        "https://x.com/\"-{arch}",
    ] {
        assert!(!fallback_url_ok(bad), "{bad}");
    }
}

#[test]
fn spki_pin_matches_openssl_form() {
    // The pin is SHA-256 over the DER SubjectPublicKeyInfo (what
    // `openssl x509 -pubkey | openssl pkey -pubin -outform der | sha256` gives).
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["x.test".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let want = format!(
        "sha256//{}",
        STANDARD.encode(Sha256::digest(
            rcgen::PublicKeyData::subject_public_key_info(&key)
        ))
    );
    assert_eq!(spki_pin(cert.der()).unwrap(), want);
}

async fn admin_client(state: &AppState, db: &TestDb) -> Client {
    let id = db.admin().await;
    let (role, sv): (String, i64) =
        sqlx::query_as("SELECT role, session_ver FROM users WHERE id = $1")
            .bind(id)
            .fetch_one(state.pg())
            .await
            .unwrap();
    let mut c = Client::new(state, rand_ip());
    c.cookie =
        Some(crate::auth::issue_token(state, id, &role, sv, crate::auth::Stage::Full).unwrap());
    c
}

fn token_of(view: &Value) -> String {
    let url = view["install"]["url"].as_str().unwrap();
    url.rsplit('/').next().unwrap().to_string()
}

async fn junk(c: &Client) -> Fingerprint {
    c.get("/test/install/not-a-token").await.fingerprint()
}

async fn create(admin: &Client, name: &str) -> Value {
    let r = admin
        .post(
            "/test/api/v1/nodes",
            json!({
                "name": name,
                "region": "Tokyo",
                "server_addr": "203.0.113.9",
                "templates": [{"template": "vless_reality", "port": 443}],
                "install": {"origin": ORIGIN},
            }),
        )
        .await;
    assert_eq!(r.status, 201, "{}", String::from_utf8_lossy(&r.body));
    r.json()
}

#[tokio::test]
async fn install_link_lifecycle() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    // HTTP through a state with prefix "test"; enrollment over gRPC through
    // the harness (same database).
    let panel = PanelHarness::start(&db).await;
    let st = AppState::for_test(db.pool.clone()).await;
    let admin = admin_client(&st, &db).await;
    let v = create(&admin, "tokyo-1").await;
    let id: Uuid = v["id"].as_str().unwrap().parse().unwrap();
    let token = token_of(&v);
    assert_eq!(v["enrollment_token"], token);
    let inst = &v["install"];
    assert_eq!(
        inst["command"],
        format!("curl -fsSL '{ORIGIN}/test/install/{token}' | sudo sh")
    );
    assert!(inst["command_wget"]
        .as_str()
        .unwrap()
        .starts_with("wget -qO- "));
    assert!(inst["pin"].is_null());
    // The form landed in the same transaction.
    let (region, addr, inbounds): (Option<String>, Option<String>, Value) =
        sqlx::query_as("SELECT region, server_addr, xray_inbounds FROM nodes WHERE id = $1")
            .bind(id)
            .fetch_one(st.pg())
            .await
            .unwrap();
    assert_eq!(region.as_deref(), Some("Tokyo"));
    assert_eq!(addr.as_deref(), Some("203.0.113.9"));
    assert_eq!(inbounds[0]["streamSettings"]["security"], "reality");
    // One token issuance audited, flagged as an install link.
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE target_id = $1 AND action = 'node.enroll_token' \
         AND (after->>'install_link')::bool",
    )
    .bind(id.to_string())
    .fetch_one(st.pg())
    .await
    .unwrap();
    assert_eq!(n, 1);

    // The script: served repeatedly until enrollment, everything filled in.
    let c = Client::new(&st, rand_ip());
    for _ in 0..2 {
        let r = c.get(&format!("/test/install/{token}")).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.headers["content-type"], "text/plain; charset=utf-8");
        assert_eq!(r.headers["cache-control"], "no-store");
        let s = String::from_utf8(r.body).unwrap();
        assert!(s.starts_with("#!/bin/sh\n"));
        assert!(!s.contains("@@"), "placeholder left");
        assert!(s.contains(&format!("BASE=\"$ORIGIN/$PREFIX/install/{token}\"")));
        assert!(s.contains(&format!("ORIGIN='{ORIGIN}'")));
        assert!(s.contains(&format!("enrollment_token = \"{token}\"")));
        assert!(s.contains("[identity]\nca_pem = '''"));
        assert!(s.contains("NEEDS_CERT='0'"));
        assert!(s.contains("SHA_amd64=''"), "no release uploaded");
        assert!(s.contains("ExecStart=/usr/local/bin/akari-agent"));
    }
    // No release: the binary endpoint has nothing (canonical reject).
    let r = c
        .get(&format!("/test/install/{token}/agent/{}", "0".repeat(64)))
        .await;
    assert_eq!(r.fingerprint(), junk(&c).await);

    // Enrollment burns it: from now on byte-identical to junk.
    panel.enroll(&token).await.unwrap();
    for p in [
        format!("/test/install/{token}"),
        format!("/test/install/{token}/agent/{}", "0".repeat(64)),
    ] {
        assert_eq!(c.get(&p).await.fingerprint(), junk(&c).await, "{p}");
    }
    // Re-install: a fresh link for the enrolled node; enrolling with it
    // supersedes the old certificate.
    let r = admin
        .post(
            &format!("/test/api/v1/nodes/{id}/install"),
            json!({"origin": ORIGIN}),
        )
        .await;
    assert_eq!(r.status, 200);
    let t2 = r.json()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    assert_ne!(t2, token);
    assert_eq!(c.get(&format!("/test/install/{t2}")).await.status, 200);
    panel.enroll(&t2).await.unwrap();
    assert_eq!(
        c.get(&format!("/test/install/{t2}")).await.fingerprint(),
        junk(&c).await
    );
    drop(st);
    drop(panel);
    db.drop().await;
}

#[tokio::test]
async fn only_live_install_links_are_served() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    let admin = admin_client(&st, &db).await;
    let c = Client::new(&st, rand_ip());
    let want = junk(&c).await;

    // A bootstrap (CLI / "enrollment token") token is not an install link.
    let r = admin
        .post("/test/api/v1/nodes", json!({"name": "boot"}))
        .await;
    assert_eq!(r.status, 201);
    assert!(r.json().get("install").is_none());
    let boot = r.json()["enrollment_token"].as_str().unwrap().to_string();
    assert_eq!(
        c.get(&format!("/test/install/{boot}")).await.fingerprint(),
        want
    );

    // Expired.
    let v = create(&admin, "exp").await;
    let t = token_of(&v);
    assert_eq!(c.get(&format!("/test/install/{t}")).await.status, 200);
    sqlx::query(
        "UPDATE node_enrollments SET expires_at = now() - interval '1 second' WHERE node_id = $1",
    )
    .bind(v["id"].as_str().unwrap().parse::<Uuid>().unwrap())
    .execute(st.pg())
    .await
    .unwrap();
    assert_eq!(
        c.get(&format!("/test/install/{t}")).await.fingerprint(),
        want
    );

    // Node being deleted.
    let v = create(&admin, "del").await;
    let t = token_of(&v);
    let id = v["id"].as_str().unwrap();
    assert_eq!(
        admin
            .req(
                axum::http::Method::DELETE,
                &format!("/test/api/v1/nodes/{id}"),
                None
            )
            .await
            .status,
        202
    );
    assert_eq!(
        c.get(&format!("/test/install/{t}")).await.fingerprint(),
        want
    );

    // Replaced by a newer link.
    let v = create(&admin, "re").await;
    let t = token_of(&v);
    let id = v["id"].as_str().unwrap();
    let r = admin
        .post(
            &format!("/test/api/v1/nodes/{id}/install"),
            json!({"origin": ORIGIN}),
        )
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        c.get(&format!("/test/install/{t}")).await.fingerprint(),
        want
    );
    // Wrong method, bad shapes, unknown arch.
    let t3 = r.json()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    for p in [
        format!("/test/install/{t3}x"),
        format!("/test/install/{}", &t3[..42]),
        format!("/test/install/{t3}/agent/amd64"),
        format!("/test/install/{t3}/agent/{}", "A".repeat(64)),
        format!("/test/install/{t3}/agent"),
    ] {
        assert_eq!(c.get(&p).await.fingerprint(), want, "{p}");
    }
    let r = c.post(&format!("/test/install/{t3}"), json!({})).await;
    assert_eq!(r.fingerprint(), want);
    drop(st);
    db.drop().await;
}

#[tokio::test]
async fn install_downloads_are_rate_limited_per_source() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test_with(db.pool.clone(), |c| c.install.rate_per_ip = 3).await;
    let admin = admin_client(&st, &db).await;
    let t = token_of(&create(&admin, "rl").await);
    let c = Client::new(&st, rand_ip());
    let want = junk(&Client::new(&st, rand_ip())).await;
    for _ in 0..3 {
        assert_eq!(c.get(&format!("/test/install/{t}")).await.status, 200);
    }
    assert_eq!(
        c.get(&format!("/test/install/{t}")).await.fingerprint(),
        want
    );
    // Other sources are unaffected.
    let other = Client::new(&st, rand_ip());
    assert_eq!(other.get(&format!("/test/install/{t}")).await.status, 200);
    drop(st);
    db.drop().await;
}

#[tokio::test]
async fn newest_release_is_served_and_pinned_in_the_script() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    let admin = admin_client(&st, &db).await;
    // Two complete releases for amd64 (the newer one wins), a rollback and
    // an incomplete one that must be ignored. 2.5 chunks of payload.
    let bin: Vec<u8> = (0..(CHUNK_FOR_TEST * 5 / 2))
        .map(|i| (i % 251) as u8)
        .collect();
    for (ver, rollback, complete, data) in [
        ("v1.2.0", false, true, b"old".to_vec()),
        ("v1.10.0", false, true, bin.clone()),
        ("v9.0.0", true, true, b"rb".to_vec()),
        ("v9.9.9", false, false, b"partial".to_vec()),
    ] {
        let id = Uuid::new_v4();
        let sha = hex::encode(Sha256::digest(&data));
        sqlx::query(
            "INSERT INTO agent_releases (id, version, os, arch, sha256, size, manifest, \
             signatures, key_id, min_panel_protocol, rollback, complete_at) \
             VALUES ($1, $2, 'linux', 'amd64', $3, $4, '\\x00', '[]', 'k', 3, $5, \
             CASE WHEN $6 THEN now() END)",
        )
        .bind(id)
        .bind(ver)
        .bind(&sha)
        .bind(data.len() as i64)
        .bind(rollback)
        .bind(complete)
        .execute(st.pg())
        .await
        .unwrap();
        for (i, c) in data.chunks(CHUNK_FOR_TEST).enumerate() {
            sqlx::query(
                "INSERT INTO agent_release_chunks (release_id, idx, data) VALUES ($1, $2, $3)",
            )
            .bind(id)
            .bind(i as i32)
            .bind(c)
            .execute(st.pg())
            .await
            .unwrap();
        }
    }
    let v = create(&admin, "rel").await;
    assert_eq!(v["install"]["releases"]["amd64"]["version"], "v1.10.0");
    let t = token_of(&v);
    let c = Client::new(&st, rand_ip());
    let s = String::from_utf8(c.get(&format!("/test/install/{t}")).await.body).unwrap();
    let sha = hex::encode(Sha256::digest(&bin));
    assert!(s.contains(&format!("SHA_amd64='{sha}'")));
    assert!(s.contains("VER_amd64='v1.10.0'"));
    assert!(s.contains("SHA_arm64=''"));
    let r = c.get(&format!("/test/install/{t}/agent/{sha}")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.headers["content-length"], bin.len().to_string());
    assert_eq!(r.body, bin);
    // Only complete linux releases: the incomplete one is not served.
    let partial = hex::encode(Sha256::digest(b"partial"));
    assert_eq!(
        c.get(&format!("/test/install/{t}/agent/{partial}"))
            .await
            .fingerprint(),
        junk(&c).await
    );
    drop(st);
    db.drop().await;
}

/// Chunk size used by the fixtures (any size works for the reader).
const CHUNK_FOR_TEST: usize = 1 << 16;

#[tokio::test]
async fn create_and_install_validation() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    let admin = admin_client(&st, &db).await;
    for (body, what) in [
        (json!({"name": "a", "install": {}}), "origin is required"),
        (
            json!({"name": "a", "install": {"origin": "https://x.com/p"}}),
            "origin",
        ),
        (
            json!({"name": "a", "install": {"origin": "http://x.com"}}),
            "https",
        ),
        (
            json!({"name": "a", "templates": [], "inbounds": []}),
            "either templates or inbounds",
        ),
        (
            json!({"name": "a", "templates": [{"template": "vless_reality", "port": 443}, {"template": "vmess_ws", "port": 443}]}),
            "port 443",
        ),
        (
            json!({"name": "a", "inbounds": [{"tag": "x", "protocol": "vless", "streamSettings": {"network": "grpc"}}]}),
            "grpc",
        ),
        (json!({"name": "a", "region": "x".repeat(65)}), "region"),
    ] {
        let r = admin.post("/test/api/v1/nodes", body.clone()).await;
        assert_eq!(r.status, 400, "{body}");
        assert!(
            String::from_utf8_lossy(&r.body).contains(what),
            "{body}: {}",
            String::from_utf8_lossy(&r.body)
        );
    }
    // Nothing half-created.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM nodes")
        .fetch_one(st.pg())
        .await
        .unwrap();
    assert_eq!(n, 0);
    // Templates endpoint: render + catalog; non-admins refused.
    let r = admin
        .post(
            "/test/api/v1/inbound-templates/render",
            json!({"templates": [{"template": "trojan_tls", "port": 8443, "domain": "n.example.com"}], "taken_ports": [443]}),
        )
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["needs_certificate"], true);
    assert_eq!(r.json()["inbounds"][0]["protocol"], "trojan");
    let r = admin.get("/test/api/v1/inbound-templates").await;
    assert_eq!(r.json()["reality_dests"][0], "www.apple.com");
    let anon = Client::new(&st, rand_ip());
    assert_eq!(anon.get("/test/api/v1/inbound-templates").await.status, 401);
    // Re-install of an unknown node.
    let r = admin
        .post(
            &format!("/test/api/v1/nodes/{}/install", Uuid::new_v4()),
            json!({"origin": ORIGIN}),
        )
        .await;
    assert_eq!(r.status, 404);
    drop(st);
    db.drop().await;
}

#[tokio::test]
async fn configured_public_url_and_pin_win() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let pin = format!("sha256//{}", STANDARD.encode([9u8; 32]));
    let p2 = pin.clone();
    let st = AppState::for_test_with(db.pool.clone(), move |c| {
        c.install.public_url = "https://203.0.113.7".into();
        c.install.tls_pin = p2;
    })
    .await;
    let admin = admin_client(&st, &db).await;
    let r = admin
        .post(
            "/test/api/v1/nodes",
            json!({"name": "pinned", "install": {"origin": "http://ignored.test"}}),
        )
        .await;
    assert_eq!(r.status, 201);
    let v = r.json();
    let t = token_of(&v);
    assert_eq!(
        v["install"]["command"],
        format!(
            "curl -fsSL --proto '=https' -k --pinnedpubkey '{pin}' 'https://203.0.113.7/test/install/{t}' | sudo sh"
        )
    );
    assert!(v["install"]["command_wget"].is_null());
    let s = String::from_utf8(
        Client::new(&st, rand_ip())
            .get(&format!("/test/install/{t}"))
            .await
            .body,
    )
    .unwrap();
    assert!(s.contains(&format!("PIN='{pin}'")));
    assert!(s.contains("ORIGIN='https://203.0.113.7'"));
    drop(st);
    db.drop().await;
}
