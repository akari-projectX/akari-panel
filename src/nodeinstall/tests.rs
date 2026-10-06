use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::fake_agent::PanelHarness;
use crate::testdb::http::{Client, Fingerprint, rand_ip};

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
    c.cookie = Some(crate::auth::issue_token(state, id, &role, sv).unwrap());
    c
}

fn token_of(view: &Value) -> String {
    let url = view["install"]["url"].as_str().unwrap();
    url.rsplit('/').next().unwrap().to_string()
}

async fn junk(c: &Client) -> Fingerprint {
    c.get("/install/not-a-token").await.fingerprint()
}

async fn create(admin: &Client, name: &str) -> Value {
    let r = admin
        .post(
            "/test/api/v1/nodes",
            json!({
                "name": name,
                "region": "Tokyo",
                "direct": {"connect_host": "203.0.113.9"},
                "template": {"template": "vless_reality", "port": 443},
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
    let sid: Uuid = v["server_id"].as_str().unwrap().parse().unwrap();
    let token = token_of(&v);
    assert_eq!(v["enrollment_token"], token);
    let inst = &v["install"];
    assert_eq!(
        inst["command"],
        format!("curl -fsSL '{ORIGIN}/install/{token}' | {AS_ROOT}")
    );
    assert_eq!(
        AS_ROOT, r#"sh -c '[ "$(id -u)" = 0 ] || exec sudo sh; exec sh'"#,
        "root runs it directly (no sudo needed), others through sudo"
    );
    assert!(
        inst["command_wget"]
            .as_str()
            .unwrap()
            .starts_with("wget -qO- ")
    );
    assert!(inst["pin"].is_null());
    // The form landed in the same transaction.
    let (region, addr, inbound): (Option<String>, Option<String>, Value) = sqlx::query_as(
        "SELECT n.region, e.connect_host, n.inbound FROM nodes n \
         JOIN entrances e ON e.node_id = n.id AND e.kind = 'direct' WHERE n.id = $1",
    )
    .bind(id)
    .fetch_one(st.pg())
    .await
    .unwrap();
    assert_eq!(region.as_deref(), Some("Tokyo"));
    assert_eq!(addr.as_deref(), Some("203.0.113.9"));
    assert_eq!(inbound["streamSettings"]["security"], "reality");
    // One token issuance audited, flagged as an install link.
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE target_id = $1 AND action = 'server.enroll_token' \
         AND (after->>'install_link')::bool",
    )
    .bind(sid.to_string())
    .fetch_one(st.pg())
    .await
    .unwrap();
    assert_eq!(n, 1);

    // The script: served repeatedly until enrollment, everything filled in.
    let c = Client::new(&st, rand_ip());
    for _ in 0..2 {
        let r = c.get(&format!("/install/{token}")).await;
        assert_eq!(r.status, 200);
        assert_eq!(r.headers["content-type"], "text/plain; charset=utf-8");
        assert_eq!(r.headers["cache-control"], "no-store");
        let s = String::from_utf8(r.body).unwrap();
        assert!(s.starts_with("#!/bin/sh\n"));
        assert!(!s.contains("@@"), "placeholder left");
        assert!(s.contains(&format!("BASE=\"$ORIGIN/install/{token}\"")));
        assert!(s.contains(&format!("ORIGIN='{ORIGIN}'")));
        assert!(s.contains(&format!("enrollment_token = \"{token}\"")));
        assert!(s.contains("[identity]\nca_pem = '''"));
        assert!(s.contains("NEEDS_CERT='0'"));
        assert!(s.contains("TLS_DOMAIN=''"));
        assert!(s.contains("SHA_amd64=''"), "no release uploaded");
        assert!(s.contains("ExecStart=/usr/local/bin/akari-agent"));
        // W18: the privileged updater units, verbatim, and enabled.
        assert!(s.contains(super::UNIT_UPDATE_SERVICE.trim_end()));
        assert!(s.contains(super::UNIT_UPDATE_PATH.trim_end()));
        assert!(s.contains(
            "ExecStart=/usr/local/bin/akari-agent -apply-update /var/lib/private/akari-agent"
        ));
        assert!(s.contains("PathExists=/var/lib/private/akari-agent/update/apply-request.json"));
        assert!(s.contains("systemctl enable --now akari-agent-update.path"));
        assert!(s.contains("rm -f \"$UNIT\" \"$UPDATE_SERVICE\" \"$UPDATE_PATH\""));
        // W23: the release's own units first (fallback: the copies above).
        assert!(s.contains("\"$TMP/akari-agent\" -print-unit \"$u\" >\"$TMP/$u\""));
        // The uninstall hint fits how the script ran (sudo or plain root).
        assert!(s.contains("say \"uninstall later with: sudo $UNINSTALLER\""));
        assert!(s.contains("say \"uninstall later with (as root): $UNINSTALLER\""));
    }
    // No release: the binary endpoint has nothing (canonical reject).
    let r = c
        .get(&format!("/install/{token}/agent/{}", "0".repeat(64)))
        .await;
    assert_eq!(r.fingerprint(), junk(&c).await);

    // Enrollment burns it: from now on byte-identical to junk.
    panel.enroll(&token).await.unwrap();
    for p in [
        format!("/install/{token}"),
        format!("/install/{token}/agent/{}", "0".repeat(64)),
    ] {
        assert_eq!(c.get(&p).await.fingerprint(), junk(&c).await, "{p}");
    }
    // Re-install: a fresh link for the enrolled server; enrolling with it
    // supersedes the old certificate.
    let r = admin
        .post(
            &format!("/test/api/v1/servers/{sid}/install"),
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
    assert_eq!(c.get(&format!("/install/{t2}")).await.status, 200);
    panel.enroll(&t2).await.unwrap();
    assert_eq!(
        c.get(&format!("/install/{t2}")).await.fingerprint(),
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
    assert_eq!(c.get(&format!("/install/{boot}")).await.fingerprint(), want);

    // Expired.
    let v = create(&admin, "exp").await;
    let t = token_of(&v);
    assert_eq!(c.get(&format!("/install/{t}")).await.status, 200);
    sqlx::query(
        "UPDATE server_enrollments SET expires_at = now() - interval '1 second' WHERE server_id = $1",
    )
    .bind(v["server_id"].as_str().unwrap().parse::<Uuid>().unwrap())
    .execute(st.pg())
    .await
    .unwrap();
    assert_eq!(c.get(&format!("/install/{t}")).await.fingerprint(), want);

    // Server being deleted.
    let v = create(&admin, "del").await;
    let t = token_of(&v);
    let sid = v["server_id"].as_str().unwrap();
    assert_eq!(
        admin
            .req(
                axum::http::Method::DELETE,
                &format!("/test/api/v1/servers/{sid}"),
                None
            )
            .await
            .status,
        202
    );
    assert_eq!(c.get(&format!("/install/{t}")).await.fingerprint(), want);

    // Replaced by a newer link.
    let v = create(&admin, "re").await;
    let t = token_of(&v);
    let sid = v["server_id"].as_str().unwrap();
    let r = admin
        .post(
            &format!("/test/api/v1/servers/{sid}/install"),
            json!({"origin": ORIGIN}),
        )
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(c.get(&format!("/install/{t}")).await.fingerprint(), want);
    // Wrong method, bad shapes, unknown arch.
    let t3 = r.json()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    for p in [
        format!("/install/{t3}x"),
        format!("/install/{}", &t3[..42]),
        format!("/install/{t3}/agent/amd64"),
        format!("/install/{t3}/agent/{}", "A".repeat(64)),
        format!("/install/{t3}/agent"),
    ] {
        assert_eq!(c.get(&p).await.fingerprint(), want, "{p}");
    }
    let r = c.post(&format!("/install/{t3}"), json!({})).await;
    assert_eq!(r.fingerprint(), want);
    drop(st);
    db.drop().await;
}

#[tokio::test]
async fn install_downloads_are_rate_limited_per_source() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test_with(db.pool.clone(), |c| c.limits.install_rate_per_ip = 3).await;
    let admin = admin_client(&st, &db).await;
    let t = token_of(&create(&admin, "rl").await);
    let c = Client::new(&st, rand_ip());
    let want = junk(&Client::new(&st, rand_ip())).await;
    for _ in 0..3 {
        assert_eq!(c.get(&format!("/install/{t}")).await.status, 200);
    }
    assert_eq!(c.get(&format!("/install/{t}")).await.fingerprint(), want);
    // Other sources are unaffected.
    let other = Client::new(&st, rand_ip());
    assert_eq!(other.get(&format!("/install/{t}")).await.status, 200);
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
    let s = String::from_utf8(c.get(&format!("/install/{t}")).await.body).unwrap();
    let sha = hex::encode(Sha256::digest(&bin));
    assert!(s.contains(&format!("SHA_amd64='{sha}'")));
    assert!(s.contains("VER_amd64='v1.10.0'"));
    assert!(s.contains("SHA_arm64=''"));
    let r = c.get(&format!("/install/{t}/agent/{sha}")).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.headers["content-length"], bin.len().to_string());
    assert_eq!(r.body, bin);
    // Only complete linux releases: the incomplete one is not served.
    let partial = hex::encode(Sha256::digest(b"partial"));
    assert_eq!(
        c.get(&format!("/install/{t}/agent/{partial}"))
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
            json!({"name": "a", "template": {"template": "vmess_ws", "port": 443},
                   "inbound": {"protocol": "vless"}}),
            "either template or inbound",
        ),
        (
            json!({"name": "a", "template": {"template": "vless_reality", "port": 0}}),
            "port",
        ),
        (
            json!({"name": "a", "inbound": {"tag": "x", "protocol": "vless", "streamSettings": {"network": "kcp"}}}),
            "kcp",
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
            json!({"template": {"template": "trojan_tls", "port": 8443, "domain": "n.example.com"}, "taken_ports": [443]}),
        )
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["needs_certificate"], true);
    assert_eq!(r.json()["inbound"]["protocol"], "trojan");
    let r = admin
        .post(
            "/test/api/v1/inbound-templates/render",
            json!({"template": {"template": "vmess_tcp", "port": 443}, "taken_ports": [443]}),
        )
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json()["code"], "template.port_clash");
    let r = admin.get("/test/api/v1/inbound-templates").await;
    assert_eq!(r.json()["reality_dests"][0], "www.apple.com");
    let anon = Client::new(&st, rand_ip());
    assert_eq!(anon.get("/test/api/v1/inbound-templates").await.status, 401);
    // Re-install of an unknown server.
    let r = admin
        .post(
            &format!("/test/api/v1/servers/{}/install", Uuid::new_v4()),
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
    let st = AppState::for_test(db.pool.clone()).await;
    db.domains(&st, "main", &["203.0.113.7"]).await;
    db.settings(&st, &format!("install_tls_pin = '{pin}'"))
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
            "curl -fsSL --proto '=https' -k --pinnedpubkey '{pin}' 'https://203.0.113.7/install/{t}' | {AS_ROOT}"
        )
    );
    assert!(v["install"]["command_wget"].is_null());
    let s = String::from_utf8(
        Client::new(&st, rand_ip())
            .get(&format!("/install/{t}"))
            .await
            .body,
    )
    .unwrap();
    assert!(s.contains(&format!("PIN='{pin}'")));
    assert!(s.contains("ORIGIN='https://203.0.113.7'"));
    drop(st);
    db.drop().await;
}

/// W18: the updater units the installer ships fit the agent unit, and
/// nothing makes the agent-writable state directory executable (W^X).
#[test]
fn updater_units_fit_the_agent_unit() {
    let lines = |u: &'static str| u.lines().map(str::trim).collect::<Vec<_>>();
    let agent = lines(UNIT);
    let svc = lines(UNIT_UPDATE_SERVICE);
    let path = lines(UNIT_UPDATE_PATH);
    // DynamicUser + StateDirectory=akari-agent = /var/lib/private/akari-agent.
    for l in [
        "DynamicUser=yes",
        "StateDirectory=akari-agent",
        "ExecStart=/usr/local/bin/akari-agent -config %d/bootstrap.toml",
    ] {
        assert!(agent.contains(&l), "{l}");
    }
    for l in [
        "Type=oneshot",
        "ExecStart=/usr/local/bin/akari-agent -apply-update /var/lib/private/akari-agent",
        "StateDirectory=akari-agent-update",
        "NoNewPrivileges=yes",
        "ProtectSystem=strict",
        "ReadWritePaths=/usr/local/bin -/var/lib/private/akari-agent",
        // W23: replaces the three units on an update.
        "ReadWritePaths=/etc/systemd/system",
        // R44: nft for the relay source allowlists, in the host's network
        // namespace (no IP traffic still).
        "IPAddressDeny=any",
        "RestrictAddressFamilies=AF_UNIX AF_NETLINK",
    ] {
        assert!(svc.contains(&l), "{l}");
    }
    assert!(!svc.iter().any(|l| l.starts_with("PrivateNetwork")));
    assert!(
        svc.iter()
            .any(|l| l.starts_with("CapabilityBoundingSet=") && l.contains("CAP_NET_ADMIN"))
    );
    // R44: never the agent itself.
    assert!(!agent.iter().any(|l| l.contains("CAP_NET_ADMIN")));
    for l in [
        "PathExists=/var/lib/private/akari-agent/update/apply-request.json",
        "PathExists=/var/lib/private/akari-agent/update/source-filter-request.json",
        "Unit=akari-agent-update.service",
    ] {
        assert!(path.contains(&l), "{l}");
    }
    for u in [&agent, &svc] {
        assert!(
            !u.iter()
                .any(|l| l.starts_with("ExecPaths") || l.starts_with("NoExecPaths")),
            "no exec exceptions for the state directory"
        );
    }
    // W23: ProcSubset=pid hid /proc/stat, meminfo, loadavg, net/*: every
    // machine metric read 0.
    assert!(agent.contains(&"ProtectProc=invisible"));
    assert!(!agent.iter().any(|l| l.starts_with("ProcSubset")));
    // The updater never gets IP networking or the agent's capability to
    // bind ports (R44: CAP_NET_ADMIN for nft only, asserted above).
    assert!(!svc.iter().any(|l| l.contains("CAP_NET_BIND_SERVICE")
        || l.contains("CAP_NET_RAW")
        || l.starts_with("DynamicUser")));
}

/// W10: a node with a TLS domain: TLS templates take it, the script knows
/// the agent obtains the certificate itself (firewall + note), and the
/// create is one transaction with the domain.
#[tokio::test]
async fn tls_domain_flows_into_templates_and_script() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    let admin = admin_client(&st, &db).await;
    let r = admin
        .post(
            "/test/api/v1/nodes",
            json!({
                "name": "hk-tls",
                "tls_domain": "HK1.Example.com",
                "template": {"template": "vless_ws_tls", "port": 443},
                "install": {"origin": ORIGIN},
            }),
        )
        .await;
    assert_eq!(r.status, 201, "{}", String::from_utf8_lossy(&r.body));
    let v: Value = r.json();
    let id: Uuid = v["id"].as_str().unwrap().parse().unwrap();
    let sid: Uuid = v["server_id"].as_str().unwrap().parse().unwrap();
    let (domain, inbound, cv): (Option<String>, Value, i64) = sqlx::query_as(
        "SELECT s.tls_domain, n.inbound, s.config_version FROM nodes n \
         JOIN servers s ON s.id = n.server_id WHERE n.id = $1",
    )
    .bind(id)
    .fetch_one(st.pg())
    .await
    .unwrap();
    assert_eq!(domain.as_deref(), Some("hk1.example.com"));
    assert!(cv >= 1);
    assert_eq!(
        inbound["streamSettings"]["tlsSettings"]["serverName"],
        "hk1.example.com"
    );
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE target_id = $1 AND action = 'server.update' \
         AND after->>'tls_domain' = 'hk1.example.com'",
    )
    .bind(sid.to_string())
    .fetch_one(st.pg())
    .await
    .unwrap();
    assert_eq!(n, 1, "the domain is audited");
    let token = token_of(&v);
    let s = String::from_utf8(
        Client::new(&st, rand_ip())
            .get(&format!("/install/{token}"))
            .await
            .body,
    )
    .unwrap();
    assert!(s.contains("NEEDS_CERT='1'") && s.contains("TLS_DOMAIN='hk1.example.com'"));
    // A different certificate name than the node's is refused.
    let r = admin
        .post(
            "/test/api/v1/nodes",
            json!({
                "name": "hk-bad",
                "tls_domain": "hk2.example.com",
                "template": {"template": "trojan_tls", "port": 443, "domain": "other.example.com"},
            }),
        )
        .await;
    assert_eq!(r.status, 400);
    let r = admin
        .post(
            "/test/api/v1/nodes",
            json!({"name": "hk-bad2", "tls_domain": "203.0.113.1"}),
        )
        .await;
    assert_eq!(r.status, 400);
    // W18: an agent older than protocol 6 ignores the node domain and
    // fails the whole snapshot without certificate files: neither the
    // inbounds nor a domain change is accepted for it (nothing changes).
    sqlx::query("UPDATE servers SET agent_protocol = 5 WHERE id = $1")
        .bind(sid)
        .execute(st.pg())
        .await
        .unwrap();
    let path = format!("/test/api/v1/servers/{sid}");
    let r = admin
        .req(
            axum::http::Method::PUT,
            &format!("/test/api/v1/nodes/{id}/inbound"),
            Some(json!({"inbound": inbound})),
        )
        .await;
    assert_eq!(r.status, 400);
    assert!(String::from_utf8_lossy(&r.body).contains("agent 版本过旧"));
    let r = admin
        .req(
            axum::http::Method::PATCH,
            &path,
            Some(json!({"tls_domain": "hk9.example.com"})),
        )
        .await;
    assert_eq!(r.status, 400);
    let (domain2, cv2): (Option<String>, i64) =
        sqlx::query_as("SELECT tls_domain, config_version FROM servers WHERE id = $1")
            .bind(sid)
            .fetch_one(st.pg())
            .await
            .unwrap();
    assert_eq!((domain2.as_deref(), cv2), (Some("hk1.example.com"), cv));
    // Clearing the domain (certificates by hand) is fine; so is the same
    // change once the agent speaks protocol 6.
    let r = admin
        .req(
            axum::http::Method::PATCH,
            &path,
            Some(json!({"tls_domain": null})),
        )
        .await;
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    sqlx::query("UPDATE servers SET agent_protocol = 6 WHERE id = $1")
        .bind(sid)
        .execute(st.pg())
        .await
        .unwrap();
    let r = admin
        .req(
            axum::http::Method::PATCH,
            &path,
            Some(json!({"tls_domain": "hk1.example.com"})),
        )
        .await;
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    db.drop().await;
}

/// W10: the TLS domain pre-flight answers (warn-only) with what the domain
/// resolves to and what the node is known by.
#[tokio::test]
async fn tls_domain_check_compares_with_the_node() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    let admin = admin_client(&st, &db).await;
    let v = create(&admin, "dns-1").await;
    let id: Uuid = v["id"].as_str().unwrap().parse().unwrap();
    sqlx::query("UPDATE servers SET agent_addr = '198.51.100.7' WHERE id = $1")
        .bind(v["server_id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(st.pg())
        .await
        .unwrap();
    let nodes: Value = admin.get("/test/api/v1/nodes").await.json();
    let n = nodes
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == id.to_string())
        .unwrap();
    assert_eq!(
        n["agent_addr"], "198.51.100.7",
        "a bare address, no netmask"
    );
    // RFC 6761: .invalid never resolves.
    let r = admin
        .post(
            "/test/api/v1/inbound-templates/check-domain",
            json!({"domain": "Node.Invalid", "node_id": id}),
        )
        .await;
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    let c: Value = r.json();
    assert_eq!(c["domain"], "node.invalid");
    assert!(c["error"].is_string(), "{c}");
    assert!(c["matches"].is_null());
    assert_eq!(c["expected"], json!(["198.51.100.7", "203.0.113.9"]));
    // Wizard (no node yet): the typed address is what it is compared with.
    let r = admin
        .post(
            "/test/api/v1/inbound-templates/check-domain",
            json!({"domain": "node.invalid", "connect_host": "192.0.2.1"}),
        )
        .await;
    let c: Value = r.json();
    assert_eq!(c["expected"], json!(["192.0.2.1"]));
    for bad in [
        json!({"domain": "1.2.3.4"}),
        json!({"domain": "x.example.com", "nope": 1}),
    ] {
        let r = admin
            .post("/test/api/v1/inbound-templates/check-domain", bad)
            .await;
        assert_eq!(r.status, 400);
    }
    db.drop().await;
}

/// W32: the script's OpenRC path and BBR + fq switch, and what the
/// uninstaller undoes (the smoke runs both on real containers).
#[test]
fn openrc_and_bbr_in_the_script() {
    for l in [
        // OpenRC: the release's scripts, never a copy of ours.
        r#""$TMP/akari-agent" -print-unit "$u" >"$TMP/rc.$u""#,
        "for u in akari-agent akari-agent-update; do",
        "has no OpenRC support",
        r#"rc-update add akari-agent default"#,
        r#"rc-update add akari-agent-update default"#,
        // BBR + fq: opt-out, own drop-in, previous values recorded.
        "BBR=${AKARI_BBR:-1}",
        "--no-bbr) BBR=0 ;;",
        "# akari-previous: net.core.default_qdisc=$qd net.ipv4.tcp_congestion_control=$cc",
        "net.ipv4.tcp_congestion_control = bbr",
        "net.core.default_qdisc = fq",
        "bbr_remove",
    ] {
        assert!(SCRIPT.contains(l), "script lacks {l}");
    }
    for l in [
        "BBR_CONF=/etc/sysctl.d/90-akari-bbr.conf",
        "BBR_MOD=/etc/modules-load.d/akari-bbr.conf",
        "RC_AGENT=/etc/init.d/akari-agent",
        "RC_UPDATE=/etc/init.d/akari-agent-update",
        r#"umount "$RC_STATE""#,
        "deluser akari-agent",
    ] {
        assert!(UNINSTALL_FN.contains(l), "uninstall lacks {l}");
    }
    // The uninstaller restores only the two settings we change, and only
    // plain values (the drop-in is root's, but still).
    assert!(UNINSTALL_FN.contains("net.core.default_qdisc) ours=fq ;;"));
    assert!(UNINSTALL_FN.contains("net.ipv4.tcp_congestion_control) ours=bbr ;;"));
    assert!(UNINSTALL_FN.contains("'' | *[!a-z0-9_]*) continue ;;"));
}
