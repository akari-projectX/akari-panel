//! Update check against a fake GitHub release server (loopback http, the
//! only plain-http target the policy allows), on a real database.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{StatusCode, Uri};
use axum::response::Response;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::client_for;
use crate::updates::testkit::Signer;

#[derive(Clone)]
enum Served {
    Body(Vec<u8>),
    /// No Content-Length (chunked), so only the streaming limit stops it.
    Chunked(Vec<u8>),
    Redirect(String),
    Status(u16),
}

#[derive(Clone)]
struct Fake {
    base: String,
    files: Arc<Mutex<HashMap<String, Served>>>,
}

impl Fake {
    async fn start() -> Self {
        let files: Arc<Mutex<HashMap<String, Served>>> = Arc::default();
        let f = files.clone();
        let app = axum::Router::new().fallback(move |uri: Uri| {
            let f = f.clone();
            async move {
                let got = f.lock().unwrap().get(uri.path()).cloned();
                match got {
                    Some(Served::Body(b)) => Response::new(Body::from(b)),
                    Some(Served::Chunked(b)) => {
                        let parts: Vec<Result<Bytes, std::io::Error>> = b
                            .chunks(1000)
                            .map(|c| Ok(Bytes::copy_from_slice(c)))
                            .collect();
                        Response::new(Body::from_stream(tokio_stream::iter(parts)))
                    }
                    Some(Served::Redirect(to)) => Response::builder()
                        .status(302)
                        .header("location", to)
                        .body(Body::empty())
                        .unwrap(),
                    Some(Served::Status(s)) => {
                        Response::builder().status(s).body(Body::empty()).unwrap()
                    }
                    None => Response::builder().status(404).body(Body::empty()).unwrap(),
                }
            }
        });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move {
            let _ = axum::serve(l, app).await;
        });
        Self { base, files }
    }

    fn source(&self) -> String {
        format!(
            "{}/repos/akari-projectX/akari-agent/releases/latest",
            self.base
        )
    }

    fn set(&self, path: &str, s: Served) {
        self.files.lock().unwrap().insert(path.to_string(), s);
    }

    fn body(&self, path: &str) -> Vec<u8> {
        match self.files.lock().unwrap().get(path) {
            Some(Served::Body(b)) => b.clone(),
            _ => panic!("{path} not a body"),
        }
    }
}

/// One platform of a fake release.
struct Plat {
    arch: &'static str,
    bin: Vec<u8>,
    manifest: String,
    sig: Value,
}

fn plat(signer: &Signer, version: &str, arch: &'static str, bin: Vec<u8>) -> Plat {
    let r = signer.release_for(version, arch, &bin, false);
    Plat {
        arch,
        bin,
        manifest: r.manifest,
        sig: serde_json::to_value(&r.sig).unwrap(),
    }
}

fn bins(version: &str) -> [Vec<u8>; 2] {
    let seed = Sha256::digest(version.as_bytes());
    // Two chunks for amd64 (the 1 MiB row boundary), one for arm64.
    let a: Vec<u8> = (0..crate::updates::CHUNK + 4321)
        .map(|i| seed[i % 32] ^ (i as u8))
        .collect();
    let b: Vec<u8> = (0..70_000)
        .map(|i| seed[(i + 7) % 32] ^ (i as u8))
        .collect();
    [a, b]
}

fn signed(signer: &Signer, version: &str) -> Vec<Plat> {
    let [a, b] = bins(version);
    vec![
        plat(signer, version, "amd64", a),
        plat(signer, version, "arm64", b),
    ]
}

/// Publishes `plats` as the source's latest release (SHA256SUMS over every
/// file, assets under /dl/).
fn publish(fake: &Fake, version: &str, plats: &[Plat]) {
    let mut assets = Vec::new();
    let mut sums = String::new();
    for p in plats {
        let name = format!("akari-agent-linux-{}", p.arch);
        let sig = serde_json::to_vec(&p.sig).unwrap();
        for (n, b) in [
            (name.clone(), p.bin.clone()),
            (
                format!("{name}.manifest.json"),
                p.manifest.clone().into_bytes(),
            ),
            (format!("{name}.manifest.sig"), sig),
        ] {
            sums.push_str(&format!("{}  {n}\n", hex::encode(Sha256::digest(&b))));
            assets.push(json!({
                "name": n, "size": b.len(),
                "browser_download_url": format!("{}/dl/{version}/{n}", fake.base),
            }));
            fake.set(&format!("/dl/{version}/{n}"), Served::Body(b));
        }
    }
    assets.push(json!({
        "name": "SHA256SUMS", "size": sums.len(),
        "browser_download_url": format!("{}/dl/{version}/SHA256SUMS", fake.base),
    }));
    fake.set(
        &format!("/dl/{version}/SHA256SUMS"),
        Served::Body(sums.into_bytes()),
    );
    let rel = json!({
        "url": "ignored", "id": 1, "tag_name": version, "name": version,
        "draft": false, "prerelease": false, "assets": assets,
    });
    fake.set(
        "/repos/akari-projectX/akari-agent/releases/latest",
        Served::Body(serde_json::to_vec(&rel).unwrap()),
    );
}

fn release_json(fake: &Fake) -> Value {
    serde_json::from_slice(&fake.body("/repos/akari-projectX/akari-agent/releases/latest")).unwrap()
}

fn set_release_json(fake: &Fake, v: &Value) {
    fake.set(
        "/repos/akari-projectX/akari-agent/releases/latest",
        Served::Body(serde_json::to_vec(v).unwrap()),
    );
}

async fn setup(signer: &Signer) -> Option<(TestDb, AppState, Fake)> {
    let db = TestDb::new().await?;
    let line = signer.config_line();
    let state = AppState::for_test(db.pool.clone()).await;
    db.settings(&state, &format!("extra_release_keys = ARRAY['{line}']"))
        .await;
    let fake = Fake::start().await;
    sqlx::query("UPDATE agent_update_settings SET source_url = $1")
        .bind(fake.source())
        .execute(&db.pool)
        .await
        .unwrap();
    Some((db, state, fake))
}

async fn count(db: &TestDb, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn audits(db: &TestDb, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = $1")
        .bind(action)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

async fn nothing_stored(db: &TestDb) {
    assert_eq!(count(db, "SELECT count(*) FROM agent_releases").await, 0);
    assert_eq!(
        count(db, "SELECT count(*) FROM agent_release_chunks").await,
        0
    );
    assert_eq!(audits(db, "agent_release.create").await, 0);
    assert_eq!(audits(db, "agent_release.upload").await, 0);
}

fn admin() -> Actor {
    Actor::system()
}

/// Every stored column of the releases, and the binary from the chunks.
async fn stored_rows(db: &TestDb) -> Vec<Value> {
    type R = (
        String,
        String,
        String,
        String,
        i64,
        Vec<u8>,
        Value,
        String,
        i32,
        bool,
        bool,
        Vec<u8>,
    );
    let rows: Vec<R> =
        sqlx::query_as(
            "SELECT r.version, r.os, r.arch, r.sha256, r.size, r.manifest, r.signatures, r.key_id, \
             r.min_panel_protocol, r.rollback, r.complete_at IS NOT NULL, \
             (SELECT string_agg(data, ''::bytea ORDER BY idx) FROM agent_release_chunks c WHERE c.release_id = r.id) \
             FROM agent_releases r ORDER BY r.arch",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap();
    rows.into_iter()
        .map(|r| {
            json!({
                "version": r.0, "os": r.1, "arch": r.2, "sha256": r.3, "size": r.4,
                "manifest": hex::encode(&r.5), "signatures": r.6, "key_id": r.7,
                "min_panel_protocol": r.8, "rollback": r.9, "complete": r.10,
                "binary": hex::encode(Sha256::digest(&r.11)), "binary_len": r.11.len(),
            })
        })
        .collect()
}

/// Both platforms fetched, verified and stored exactly as the manual
/// upload stores them (byte-identical rows); a second check is a no-op;
/// asset redirects within the source host are followed.
#[tokio::test]
async fn check_stores_like_a_manual_upload() {
    let signer = Signer::new();
    let Some((db, state, fake)) = setup(&signer).await else {
        return;
    };
    let plats = signed(&signer, "v1.2.0");
    publish(&fake, "v1.2.0", &plats);
    // The binary of amd64 sits behind a (relative) redirect, as on GitHub.
    let body = fake.body("/dl/v1.2.0/akari-agent-linux-amd64");
    fake.set("/blob/amd64", Served::Body(body));
    fake.set(
        "/dl/v1.2.0/akari-agent-linux-amd64",
        Served::Redirect("/blob/amd64".into()),
    );
    let out = check_now(&state, &admin()).await.unwrap();
    assert_eq!(
        out,
        Outcome {
            result: "stored",
            version: "v1.2.0".into(),
            stored: vec!["linux/amd64".into(), "linux/arm64".into()],
        }
    );
    let rows = stored_rows(&db).await;
    assert_eq!(rows.len(), 2);
    for (row, p) in rows.iter().zip(&plats) {
        assert_eq!(
            row["manifest"],
            hex::encode(p.manifest.as_bytes()),
            "verbatim manifest"
        );
        assert_eq!(row["binary"], hex::encode(Sha256::digest(&p.bin)));
        assert_eq!(row["complete"], true);
    }
    assert_eq!(audits(&db, "agent_release.create").await, 2);
    assert_eq!(audits(&db, "agent_release.upload").await, 2);
    assert_eq!(audits(&db, "agent_update.check").await, 1);

    // The same files through the manual upload API, into another database.
    let manual = TestDb::new().await.unwrap();
    let mstate = AppState::for_test(manual.pool.clone()).await;
    manual
        .settings(
            &mstate,
            &format!("extra_release_keys = ARRAY['{}']", signer.config_line()),
        )
        .await;
    let c = client_for(&mstate, manual.admin().await).await;
    for p in &plats {
        let r = c
            .post(
                "/test/api/v1/agent-releases",
                json!({ "manifest": p.manifest, "sig": p.sig }),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED);
        let id = r.json()["id"].as_str().unwrap().to_string();
        let r = c
            .put_raw(
                &format!("/test/api/v1/agent-releases/{id}/binary"),
                p.bin.clone(),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK);
    }
    assert_eq!(stored_rows(&manual).await, rows, "check == manual upload");
    manual.drop().await;

    // Up to date: nothing fetched beyond the metadata, nothing stored.
    fake.set("/dl/v1.2.0/SHA256SUMS", Served::Status(500));
    let out = check_now(&state, &admin()).await.unwrap();
    assert_eq!(out.result, "up_to_date");
    assert!(out.stored.is_empty());
    assert_eq!(count(&db, "SELECT count(*) FROM agent_releases").await, 2);
    let st = status(&state).await.unwrap();
    let last = st.last_check.unwrap();
    assert!(last.ok);
    assert_eq!(last.result, "up_to_date");
    assert_eq!(st.latest.unwrap().platforms, ["linux/amd64", "linux/arm64"]);
    assert!(!st.checking);
    db.drop().await;
}

/// A platform half-stored by hand (manifest without binary) is completed
/// with the same digest; another digest for the version is refused.
#[tokio::test]
async fn check_completes_a_pending_manual_release() {
    let signer = Signer::new();
    let Some((db, state, fake)) = setup(&signer).await else {
        return;
    };
    let plats = signed(&signer, "v1.3.0");
    publish(&fake, "v1.3.0", &plats);
    let mut tx = state.pg().begin().await.unwrap();
    let req = signer.release_for("v1.3.0", "arm64", &plats[1].bin, false);
    crate::updates::apply_create_release(
        &mut tx,
        &admin(),
        std::slice::from_ref(&signer.key),
        &req,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let out = check_now(&state, &admin()).await.unwrap();
    assert_eq!(out.stored, ["linux/amd64", "linux/arm64"]);
    assert_eq!(audits(&db, "agent_release.create").await, 2);
    assert_eq!(audits(&db, "agent_release.upload").await, 2);

    // Same version, other digest (a pending row for amd64 of v1.4.0).
    let plats = signed(&signer, "v1.4.0");
    publish(&fake, "v1.4.0", &plats);
    let mut tx = state.pg().begin().await.unwrap();
    let req = signer.release_for("v1.4.0", "amd64", b"something else", false);
    crate::updates::apply_create_release(
        &mut tx,
        &admin(),
        std::slice::from_ref(&signer.key),
        &req,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let e = check_now(&state, &admin()).await.unwrap_err();
    assert_eq!(e.code(), "release.exists");
    db.drop().await;
}

/// Each refusal: coded error, NOTHING stored (both platforms roll back),
/// the outcome recorded and audited.
#[tokio::test]
async fn refusals_store_nothing() {
    let signer = Signer::new();
    let Some((db, state, fake)) = setup(&signer).await else {
        return;
    };
    let other = Signer::new();
    type Case = (&'static str, Box<dyn Fn(&Fake)>);
    let cases: Vec<Case> = vec![
        // Signed by a key the panel does not trust (arm64 only: amd64,
        // verified first, must roll back too).
        ("release.signature_invalid", {
            let mut p = signed(&signer, "v2.0.0");
            p[1] = plat(&other, "v2.0.0", "arm64", p[1].bin.clone());
            Box::new(move |f| publish(f, "v2.0.0", &p))
        }),
        // The arm64 file carries an amd64 manifest.
        ("agent_update.platform_mismatch", {
            let [a, b] = bins("v2.0.0");
            let mut wrong = plat(&signer, "v2.0.0", "amd64", b);
            wrong.arch = "arm64";
            let p = vec![plat(&signer, "v2.0.0", "amd64", a), wrong];
            Box::new(move |f| publish(f, "v2.0.0", &p))
        }),
        // A manifest for another version than the tag.
        ("agent_update.version_mismatch", {
            let [a, b] = bins("v2.0.0");
            let p = vec![
                plat(&signer, "v2.0.0", "amd64", a),
                plat(&signer, "v2.0.1", "arm64", b),
            ];
            Box::new(move |f| publish(f, "v2.0.0", &p))
        }),
        // A signed rollback manifest (manual uploads only).
        ("agent_update.rollback_refused", {
            let [a, b] = bins("v2.0.0");
            let r = signer.release_for("v2.0.0", "arm64", &b, true);
            let p = vec![
                plat(&signer, "v2.0.0", "amd64", a),
                Plat {
                    arch: "arm64",
                    bin: b,
                    manifest: r.manifest,
                    sig: serde_json::to_value(&r.sig).unwrap(),
                },
            ];
            Box::new(move |f| publish(f, "v2.0.0", &p))
        }),
        // The binary does not match its manifest (SHA256SUMS lists what is
        // served, so only the manifest comparison catches it).
        ("agent_update.checksum_mismatch", {
            let mut p = signed(&signer, "v2.0.0");
            p[1].bin[3] ^= 1;
            Box::new(move |f| publish(f, "v2.0.0", &p))
        }),
        // SHA256SUMS lists a different binary than the one served: the
        // manifest and the sums agree, the download does not.
        ("release.binary_mismatch", {
            let p = signed(&signer, "v2.0.0");
            Box::new(move |f| {
                publish(f, "v2.0.0", &p);
                let mut b = f.body("/dl/v2.0.0/akari-agent-linux-arm64");
                b[10] ^= 1;
                f.set("/dl/v2.0.0/akari-agent-linux-arm64", Served::Body(b));
            })
        }),
        // A binary larger than the signed size, without Content-Length.
        ("release.binary_too_large", {
            let p = signed(&signer, "v2.0.0");
            Box::new(move |f| {
                publish(f, "v2.0.0", &p);
                let mut b = f.body("/dl/v2.0.0/akari-agent-linux-arm64");
                b.extend_from_slice(&[0; 5000]);
                f.set("/dl/v2.0.0/akari-agent-linux-arm64", Served::Chunked(b));
            })
        }),
        // Content-Length says it does not match before any byte is stored.
        ("agent_update.size_mismatch", {
            let p = signed(&signer, "v2.0.0");
            Box::new(move |f| {
                publish(f, "v2.0.0", &p);
                let mut b = f.body("/dl/v2.0.0/akari-agent-linux-arm64");
                b.push(0);
                f.set("/dl/v2.0.0/akari-agent-linux-arm64", Served::Body(b));
            })
        }),
        // An oversize release document.
        ("agent_update.too_large", {
            Box::new(|f| {
                set_release_json(
                    f,
                    &json!({ "tag_name": "v2.0.0", "body": "x".repeat(META_MAX) }),
                )
            })
        }),
        // A missing platform.
        ("agent_update.asset_missing", {
            let p = signed(&signer, "v2.0.0");
            Box::new(move |f| publish(f, "v2.0.0", &p[..1]))
        }),
        // A file outside the source host (localhost is not 127.0.0.1).
        ("agent_update.host_not_allowed", {
            let p = signed(&signer, "v2.0.0");
            Box::new(move |f| {
                publish(f, "v2.0.0", &p);
                let mut v = release_json(f);
                let port = f.base.rsplit(':').next().unwrap().to_string();
                for a in v["assets"].as_array_mut().unwrap() {
                    let u = a["browser_download_url"]
                        .as_str()
                        .unwrap()
                        .replace(&format!("127.0.0.1:{port}"), &format!("localhost:{port}"));
                    a["browser_download_url"] = json!(u);
                }
                set_release_json(f, &v);
            })
        }),
        // A redirect off the source host.
        ("agent_update.host_not_allowed", {
            let p = signed(&signer, "v2.0.0");
            Box::new(move |f| {
                publish(f, "v2.0.0", &p);
                f.set(
                    "/dl/v2.0.0/akari-agent-linux-amd64",
                    Served::Redirect("https://evil.example/x".into()),
                );
            })
        }),
        (
            "agent_update.http_status",
            Box::new(|f| {
                f.set(
                    "/repos/akari-projectX/akari-agent/releases/latest",
                    Served::Status(403),
                )
            }),
        ),
        ("agent_update.prerelease", {
            let p = signed(&signer, "v2.0.0");
            Box::new(move |f| {
                publish(f, "v2.0.0", &p);
                let mut v = release_json(f);
                v["prerelease"] = json!(true);
                set_release_json(f, &v);
            })
        }),
        (
            "agent_update.release_invalid",
            Box::new(|f| set_release_json(f, &json!({ "tag_name": "latest", "assets": [] }))),
        ),
        ("agent_update.checksum_missing", {
            let p = signed(&signer, "v2.0.0");
            Box::new(move |f| {
                publish(f, "v2.0.0", &p);
                f.set("/dl/v2.0.0/SHA256SUMS", Served::Body(b"".to_vec()));
            })
        }),
        ("agent_update.checksums_invalid", {
            let p = signed(&signer, "v2.0.0");
            Box::new(move |f| {
                publish(f, "v2.0.0", &p);
                f.set(
                    "/dl/v2.0.0/SHA256SUMS",
                    Served::Body(b"nonsense\n".to_vec()),
                );
            })
        }),
    ];
    for (want, prepare) in &cases {
        fake.files.lock().unwrap().clear();
        prepare(&fake);
        let e = check_now(&state, &admin()).await.unwrap_err();
        assert_eq!(e.code(), *want, "{}", e.message());
        nothing_stored(&db).await;
        let st = status(&state).await.unwrap();
        let last = st.last_check.unwrap();
        assert!(!last.ok);
        assert_eq!(last.result, "failed");
        assert_eq!(last.code.as_deref(), Some(*want));
        assert!(!st.checking);
    }
    assert_eq!(audits(&db, "agent_update.check").await, cases.len() as i64);
    db.drop().await;
}

/// No downgrade: the source's latest older than a stored release is
/// refused; an untrusted signer = refused.
#[tokio::test]
async fn downgrade_and_untrusted_key() {
    let signer = Signer::new();
    let Some((db, state, fake)) = setup(&signer).await else {
        return;
    };
    publish(&fake, "v3.1.0", &signed(&signer, "v3.1.0"));
    check_now(&state, &admin()).await.unwrap();
    publish(&fake, "v3.0.9", &signed(&signer, "v3.0.9"));
    let e = check_now(&state, &admin()).await.unwrap_err();
    assert_eq!(e.code(), "agent_update.downgrade");
    assert_eq!(e.params()["have"], "v3.1.0");
    assert_eq!(count(&db, "SELECT count(*) FROM agent_releases").await, 2);

    // Signed by a key the panel does not trust (only the compiled-in
    // official keys, W25): refused, nothing stored.
    db.settings(&state, "extra_release_keys = NULL").await;
    publish(&fake, "v3.2.0", &signed(&signer, "v3.2.0"));
    assert!(check_now(&state, &admin()).await.is_err());
    assert_eq!(count(&db, "SELECT count(*) FROM agent_releases").await, 2);
    db.drop().await;
}

/// The API: status (badge), settings (validation, optimistic version,
/// audit), POST check (202, then the outcome), one check at a time.
#[tokio::test]
async fn api_status_settings_and_check() {
    let signer = Signer::new();
    let Some((db, state, fake)) = setup(&signer).await else {
        return;
    };
    let c = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;
    assert_eq!(
        user.get("/test/api/v1/agent-updates").await.status,
        StatusCode::FORBIDDEN
    );
    let st = c.get("/test/api/v1/agent-updates").await.json();
    assert_eq!(st["default_source_url"], DEFAULT_SOURCE);
    assert_eq!(st["source_url"], fake.source());
    assert_eq!(st["auto_check"], false);
    assert_eq!(st["keys_configured"], true);
    assert!(st["latest"].is_null() && st["update_available"].is_null());
    let v = st["version"].as_i64().unwrap();

    for bad in [
        "ftp://example.com/x",
        "http://example.com/releases/latest",
        "https://user:pw@example.com/x",
        "https://example.com/x#frag",
        "not a url",
    ] {
        let r = c
            .put(
                "/test/api/v1/agent-updates/settings",
                json!({ "version": v, "source_url": bad, "auto_check": false }),
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(r.json()["code"], "agent_update.source_invalid", "{bad}");
    }
    let r = c
        .put(
            "/test/api/v1/agent-updates/settings",
            json!({ "version": v, "source_url": fake.source(), "auto_check": true }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["auto_check"], true);
    assert_eq!(audits(&db, "agent_update.settings.update").await, 1);
    let r = c
        .put(
            "/test/api/v1/agent-updates/settings",
            json!({ "version": v, "source_url": null, "auto_check": false }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "settings.version_conflict");
    let r = c
        .put(
            "/test/api/v1/agent-updates/settings",
            json!({ "version": v, "source_url": fake.source(), "auto_check": false, "x": 1 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // An outdated node (protocol 3, linux/amd64, v1.0.0) and one that
    // cannot update (protocol 2).
    let n1 = db.node().await;
    let n2 = db.node().await;
    sqlx::query(
        "UPDATE nodes SET agent_version = 'v1.0.0', agent_os = 'linux', agent_arch = 'amd64', \
         agent_protocol = CASE WHEN id = $1 THEN 3 ELSE 2 END WHERE id IN ($1, $2)",
    )
    .bind(n1)
    .bind(n2)
    .execute(&db.pool)
    .await
    .unwrap();

    publish(&fake, "v1.5.0", &signed(&signer, "v1.5.0"));
    // One check at a time (any instance): the lock held elsewhere = 409.
    let held = begin_locked(&db.pool).await.unwrap().unwrap();
    let r = c.post("/test/api/v1/agent-updates/check", json!({})).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "agent_update.check_running");
    assert_eq!(
        check_now(&state, &admin()).await.unwrap_err().code(),
        "agent_update.check_running"
    );
    drop(held);
    let r = c.post("/test/api/v1/agent-updates/check", json!({})).await;
    assert_eq!(r.status, StatusCode::ACCEPTED, "{:?}", r.json());
    let mut st = Value::Null;
    for _ in 0..200 {
        st = c.get("/test/api/v1/agent-updates").await.json();
        if !st["last_check"].is_null() && st["checking"] == false {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(st["last_check"]["ok"], true, "{st}");
    assert_eq!(st["last_check"]["version"], "v1.5.0");
    assert_eq!(st["latest"]["version"], "v1.5.0");
    assert_eq!(st["outdated_nodes"], 1);
    assert_eq!(st["update_available"], "v1.5.0");
    let actor: String =
        sqlx::query_scalar("SELECT actor_label FROM audit_log WHERE action = 'agent_update.check'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_ne!(actor, crate::audit::SYSTEM);
    // The node on the new version: no badge.
    sqlx::query("UPDATE nodes SET agent_version = 'v1.5.0' WHERE id = $1")
        .bind(n1)
        .execute(&db.pool)
        .await
        .unwrap();
    let st = c.get("/test/api/v1/agent-updates").await.json();
    assert_eq!(st["outdated_nodes"], 0);
    assert!(st["update_available"].is_null());
    db.drop().await;
}

/// The auto check: off = nothing; on = one instance claims the 6-hour slot
/// and checks as `system`; the next tick is not due.
#[tokio::test]
async fn auto_check_claims_one_slot() {
    let signer = Signer::new();
    let Some((db, state, fake)) = setup(&signer).await else {
        return;
    };
    publish(&fake, "v4.0.0", &signed(&signer, "v4.0.0"));
    assert!(auto_tick(&state).await.unwrap().is_none());
    sqlx::query("UPDATE agent_update_settings SET auto_check = TRUE")
        .execute(&db.pool)
        .await
        .unwrap();
    let ran = auto_tick(&state).await.unwrap().unwrap().unwrap();
    assert_eq!(ran.result, "stored");
    assert!(
        auto_tick(&state).await.unwrap().is_none(),
        "claimed for 6 h"
    );
    let due: bool = sqlx::query_scalar(
        "SELECT next_auto_check_at > now() + interval '5 hours' FROM agent_update_settings",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(due);
    let actor: String =
        sqlx::query_scalar("SELECT actor_label FROM audit_log WHERE action = 'agent_update.check'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(actor, crate::audit::SYSTEM);
    // Due again but another instance is checking: skipped, not failed.
    sqlx::query("UPDATE agent_update_settings SET next_auto_check_at = now()")
        .execute(&db.pool)
        .await
        .unwrap();
    let held = begin_locked(&db.pool).await.unwrap().unwrap();
    assert!(auto_tick(&state).await.unwrap().is_none());
    drop(held);
    db.drop().await;
}

#[test]
fn url_policy() {
    for ok in [
        "https://api.github.com/repos/a/b/releases/latest",
        "https://mirror.example:8443/x?y=1",
        "http://127.0.0.1:9/x",
        "http://[::1]:9/x",
        "http://localhost/x",
    ] {
        assert!(target(ok).is_ok(), "{ok}");
    }
    for bad in [
        "http://example.com/x",
        "http://10.0.0.1/x",
        "ftp://example.com/x",
        "https://a@example.com/x",
        "https://example.com/x#y",
        "//example.com/x",
        "/relative",
        "https:///x",
    ] {
        assert!(target(bad).is_err(), "{bad}");
    }
    assert_eq!(
        allowed_hosts(DEFAULT_SOURCE).unwrap(),
        [
            "api.github.com",
            "github.com",
            "objects.githubusercontent.com",
            "release-assets.githubusercontent.com"
        ]
    );
    assert_eq!(
        allowed_hosts("https://Mirror.Example/x").unwrap(),
        ["mirror.example"]
    );
}

#[test]
fn sums_parse() {
    let h = "ab".repeat(32);
    let m = parse_sums(format!("{h}  a\n{} *b\n\n", "CD".repeat(32)).as_bytes()).unwrap();
    assert_eq!(m["a"], h);
    assert_eq!(m["b"], "cd".repeat(32));
    for bad in [
        format!("{h} a"),
        format!("{h}  "),
        format!("{}  a", "zz".repeat(32)),
        format!("{h}  a\n{h}  a"),
        "short  a".to_string(),
    ] {
        assert!(parse_sums(bad.as_bytes()).is_err(), "{bad}");
    }
}

#[test]
fn newest_is_semver() {
    let v = |s: &[&str]| newest(s.iter().map(|x| x.to_string()));
    assert_eq!(
        v(&["v1.9.0", "v1.10.0", "v1.10.0-rc.1", "dev"]).as_deref(),
        Some("v1.10.0")
    );
    assert_eq!(v(&[]), None);
    let _ = Uuid::nil();
}
