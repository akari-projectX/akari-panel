//! W27 passkeys: a software authenticator (ES256, "none" attestation) drives
//! the real webauthn-rs ceremonies through `web::router` on a real database.

use axum::http::{Method, StatusCode};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, KeyPair};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

// ---------------------------------------------------------------------------
// Minimal CBOR (only what an authenticator emits here)
// ---------------------------------------------------------------------------

enum Cbor {
    Int(i64),
    Bytes(Vec<u8>),
    Text(&'static str),
    Map(Vec<(Cbor, Cbor)>),
}

fn head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    match n {
        0..=23 => out.push(m | n as u8),
        24..=0xff => out.extend([m | 24, n as u8]),
        0x100..=0xffff => {
            out.push(m | 25);
            out.extend((n as u16).to_be_bytes());
        }
        _ => {
            out.push(m | 26);
            out.extend((n as u32).to_be_bytes());
        }
    }
}

fn cbor(v: &Cbor, out: &mut Vec<u8>) {
    match v {
        Cbor::Int(i) if *i >= 0 => head(out, 0, *i as u64),
        Cbor::Int(i) => head(out, 1, (-1 - *i) as u64),
        Cbor::Bytes(b) => {
            head(out, 2, b.len() as u64);
            out.extend(b);
        }
        Cbor::Text(t) => {
            head(out, 3, t.len() as u64);
            out.extend(t.as_bytes());
        }
        Cbor::Map(kv) => {
            head(out, 5, kv.len() as u64);
            for (k, v) in kv {
                cbor(k, out);
                cbor(v, out);
            }
        }
    }
}

fn enc(v: Cbor) -> Vec<u8> {
    let mut out = Vec::new();
    cbor(&v, &mut out);
    out
}

// ---------------------------------------------------------------------------
// Software authenticator
// ---------------------------------------------------------------------------

/// One resident ES256 credential.
struct SoftKey {
    key: EcdsaKeyPair,
    cred_id: Vec<u8>,
    user: Option<Uuid>,
    counter: u32,
}

const UP: u8 = 0x01;
const UV: u8 = 0x04;
const AT: u8 = 0x40;

impl SoftKey {
    fn new() -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng)
            .unwrap();
        Self {
            key,
            cred_id: Uuid::new_v4().as_bytes().repeat(2),
            user: None,
            counter: 0,
        }
    }

    fn cose_key(&self) -> Vec<u8> {
        let pk = self.key.public_key().as_ref(); // 0x04 || x || y
        enc(Cbor::Map(vec![
            (Cbor::Int(1), Cbor::Int(2)),  // kty: EC2
            (Cbor::Int(3), Cbor::Int(-7)), // alg: ES256
            (Cbor::Int(-1), Cbor::Int(1)), // crv: P-256
            (Cbor::Int(-2), Cbor::Bytes(pk[1..33].to_vec())),
            (Cbor::Int(-3), Cbor::Bytes(pk[33..65].to_vec())),
        ]))
    }

    fn client_data(kind: &str, challenge: &str, origin: &str) -> Vec<u8> {
        json!({ "type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false })
            .to_string()
            .into_bytes()
    }

    /// navigator.credentials.create() for these options.
    fn create(&mut self, options: &Value, rp_id: &str, origin: &str) -> Value {
        let pk = &options["publicKey"];
        let challenge = pk["challenge"].as_str().unwrap();
        let user = B64.decode(pk["user"]["id"].as_str().unwrap()).unwrap();
        self.user = Some(Uuid::from_slice(&user).unwrap());
        let cdj = Self::client_data("webauthn.create", challenge, origin);
        let mut auth = Sha256::digest(rp_id.as_bytes()).to_vec();
        auth.push(UP | UV | AT);
        auth.extend(self.counter.to_be_bytes());
        auth.extend([0u8; 16]); // AAGUID
        auth.extend((self.cred_id.len() as u16).to_be_bytes());
        auth.extend(&self.cred_id);
        auth.extend(self.cose_key());
        let att = enc(Cbor::Map(vec![
            (Cbor::Text("fmt"), Cbor::Text("none")),
            (Cbor::Text("attStmt"), Cbor::Map(vec![])),
            (Cbor::Text("authData"), Cbor::Bytes(auth)),
        ]));
        json!({
            "id": B64.encode(&self.cred_id),
            "rawId": B64.encode(&self.cred_id),
            "type": "public-key",
            "response": {
                "attestationObject": B64.encode(att),
                "clientDataJSON": B64.encode(cdj),
            },
            "extensions": {},
        })
    }

    /// navigator.credentials.get() (discoverable: the authenticator names
    /// the user).
    fn get(&mut self, options: &Value, rp_id: &str, origin: &str) -> Value {
        let challenge = options["publicKey"]["challenge"].as_str().unwrap();
        self.counter += 1;
        let cdj = Self::client_data("webauthn.get", challenge, origin);
        let mut auth = Sha256::digest(rp_id.as_bytes()).to_vec();
        auth.push(UP | UV);
        auth.extend(self.counter.to_be_bytes());
        let mut signed = auth.clone();
        signed.extend(Sha256::digest(&cdj));
        let sig = self.key.sign(&SystemRandom::new(), &signed).unwrap();
        json!({
            "id": B64.encode(&self.cred_id),
            "rawId": B64.encode(&self.cred_id),
            "type": "public-key",
            "response": {
                "authenticatorData": B64.encode(auth),
                "clientDataJSON": B64.encode(cdj),
                "signature": B64.encode(sig.as_ref()),
                "userHandle": B64.encode(self.user.unwrap().as_bytes()),
            },
            "extensions": {},
        })
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RP: &str = "panel.example";
const ORIGIN: &str = "https://panel.example";

async fn state_with_domain(db: &TestDb, main: &str) -> AppState {
    let st = AppState::for_test(db.pool.clone()).await;
    db.domains(&st, "main", &[main]).await;
    st
}

async fn account(db: &TestDb, role: &str, pw: &str) -> (Uuid, String) {
    let id = if role == "admin" {
        db.admin().await
    } else {
        db.user().await
    };
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(id)
        .bind(crate::auth::hash_password(pw).unwrap())
        .execute(&db.pool)
        .await
        .unwrap();
    (id, crate::testdb::test_email(id))
}

/// Register `key` for the signed-in client; returns the passkey id.
async fn bind(c: &Client, key: &mut SoftKey, name: &str, disable_password: bool) -> Value {
    let r = c.post("/test/api/v1/me/passkeys/options", json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.headers["cache-control"], "no-store");
    let o = r.json();
    let sel = &o["options"]["publicKey"]["authenticatorSelection"];
    assert_eq!(
        (sel["residentKey"].clone(), sel["userVerification"].clone()),
        (json!("required"), json!("required"))
    );
    let cred = key.create(&o["options"], RP, ORIGIN);
    let r = c
        .post(
            "/test/api/v1/me/passkeys",
            json!({ "state": o["state"], "credential": cred, "name": name,
                    "disable_password": disable_password }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    r.json()
}

async fn passkey_login(c: &Client, key: &mut SoftKey) -> crate::testdb::http::Resp {
    let r = c.post("/test/auth/passkey/options", json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let o = r.json();
    assert!(o["options"].get("mediation").is_none());
    let cred = key.get(&o["options"], RP, ORIGIN);
    c.post(
        "/test/auth/passkey/login",
        json!({ "state": o["state"], "credential": cred }),
    )
    .await
}

fn login_body(email: &str, pw: &str) -> Value {
    json!({ "email": email, "password": pw })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn localhost_accepts_its_http_origin_too() {
    let rp = Rp::of("https://localhost:8096", "A".into()).unwrap();
    assert_eq!(
        rp.localhost_http().map(|u| u.to_string()),
        Some("http://localhost:8096/".into())
    );
    assert!(rp.webauthn().is_ok());
    let sub = Rp::of("https://e2e.localhost", "A".into()).unwrap();
    assert_eq!(
        sub.localhost_http().map(|u| u.to_string()),
        Some("http://e2e.localhost/".into())
    );
    let other = Rp::of("https://panel.example", "A".into()).unwrap();
    assert!(other.localhost_http().is_none());
    let plain = Rp::of("http://localhost:8080", "A".into()).unwrap();
    assert!(plain.localhost_http().is_none());
}

#[test]
fn relying_party_needs_an_https_domain() {
    let rp = Rp::of("https://Panel.Example:8443", "A".into()).unwrap();
    assert_eq!(rp.id, "panel.example");
    assert_eq!(rp.origin.as_str(), "https://panel.example:8443/");
    assert!(Rp::of("http://localhost:8080", "A".into()).is_some());
    for bad in [
        "http://panel.example",
        "https://127.0.0.1",
        "https://[::1]",
        "https://intranet",
        "not a url",
    ] {
        assert!(Rp::of(bad, "A".into()).is_none(), "{bad}");
    }
}

#[test]
fn policy_decisions() {
    let mut s = settings_placeholder();
    let d = |s: &crate::botguard::Settings, role, own, has, avail| decide(s, role, own, has, avail);
    // Nothing on: the password always works, no prompt.
    assert_eq!(
        d(&s, "user", false, true, true),
        LoginPolicy {
            password_refused: false,
            prompt: false
        }
    );
    // The account's own choice needs a current passkey.
    assert!(d(&s, "user", true, true, true).password_refused);
    assert!(!d(&s, "user", true, false, true).password_refused);
    // Role policies.
    s.passkey_only_admins = true;
    assert!(d(&s, "admin", false, true, true).password_refused);
    assert!(
        !d(&s, "admin", false, false, true).password_refused,
        "no passkey yet: password"
    );
    assert!(!d(&s, "user", false, true, true).password_refused);
    s.passkey_only_users = true;
    assert!(d(&s, "user", false, true, true).password_refused);
    // Prompt only without a passkey.
    s.passkey_prompt = true;
    assert!(d(&s, "user", false, false, true).prompt);
    assert!(!d(&s, "user", false, true, true).prompt);
    // Passkeys unavailable (no main domain): nothing applies.
    assert_eq!(
        d(&s, "admin", true, true, false),
        LoginPolicy {
            password_refused: false,
            prompt: false
        }
    );
}

/// Bind → passkey login → passkey-only (own choice) → rename/delete →
/// the password is back; counters move; everything audited; another
/// account's passkey cannot be touched.
#[tokio::test]
async fn register_login_and_manage() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state_with_domain(&db, RP).await;
    let (id, email) = account(&db, "user", "user-password-1").await;
    let mut c = Client::new(&st, rand_ip());
    let r = c.login(&email, "user-password-1").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["passkey_prompt"], false);
    let o = c.get("/test/auth/options").await.json();
    assert_eq!(o["passkey"], true);

    let mut key = SoftKey::new();
    let added = bind(&c, &mut key, "  My phone ", false).await;
    assert_eq!(added["name"], "My phone");
    // The same authenticator again: excluded by the browser, refused here.
    let mut again = SoftKey {
        key: SoftKey::new().key,
        cred_id: key.cred_id.clone(),
        user: None,
        counter: 0,
    };
    let r = c.post("/test/api/v1/me/passkeys/options", json!({})).await;
    let o = r.json();
    assert_eq!(
        o["options"]["publicKey"]["excludeCredentials"][0]["id"],
        json!(B64.encode(&key.cred_id))
    );
    let cred = again.create(&o["options"], RP, ORIGIN);
    let r = c
        .post(
            "/test/api/v1/me/passkeys",
            json!({ "state": o["state"], "credential": cred, "name": "dup" }),
        )
        .await;
    // webauthn-rs refuses an excluded credential.
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("account.passkey_failed"))
    );
    // A replayed state: refused.
    let r = c
        .post(
            "/test/api/v1/me/passkeys",
            json!({ "state": o["state"], "credential": cred, "name": "dup" }),
        )
        .await;
    assert_eq!(r.json()["code"], "account.passkey_failed");
    // Another account presenting the same credential id: one row per
    // (RP ID, credential id).
    let mut other = Client::new(&st, rand_ip());
    let (_, other_email) = account(&db, "user", "user-password-2").await;
    other.login(&other_email, "user-password-2").await;
    let o = other
        .post("/test/api/v1/me/passkeys/options", json!({}))
        .await
        .json();
    let cred = again.create(&o["options"], RP, ORIGIN);
    let r = other
        .post(
            "/test/api/v1/me/passkeys",
            json!({ "state": o["state"], "credential": cred, "name": "dup" }),
        )
        .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::CONFLICT, json!("account.passkey_exists"))
    );

    // Passkey login (another client, no address sent).
    let anon = Client::new(&st, rand_ip());
    let r = passkey_login(&anon, &mut key).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["email"], email);
    assert!(r.session_cookie().is_some());
    let counter: i64 = sqlx::query_scalar(
        "SELECT (passkey->'cred'->>'counter')::bigint FROM webauthn_credentials WHERE user_id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(counter, 1);
    // A replayed assertion (same challenge state) and a stale counter: 401.
    let r = anon
        .post("/test/auth/passkey/options", json!({}))
        .await
        .json();
    let cred = key.get(&r["options"], RP, ORIGIN);
    let ok = anon
        .post(
            "/test/auth/passkey/login",
            json!({ "state": r["state"], "credential": cred.clone() }),
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);
    let replay = anon
        .post(
            "/test/auth/passkey/login",
            json!({ "state": r["state"], "credential": cred }),
        )
        .await;
    assert_eq!(replay.status, StatusCode::UNAUTHORIZED);
    key.counter = 0; // a cloned authenticator
    let r = passkey_login(&anon, &mut key).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    key.counter = 10;
    // Someone else's key for this account's handle: 401.
    let mut stranger = SoftKey::new();
    stranger.user = Some(id);
    assert_eq!(
        passkey_login(&anon, &mut stranger).await.status,
        StatusCode::UNAUTHORIZED
    );

    // Own choice: password off → the right password is refused (403, coded),
    // the wrong one stays the uniform 401.
    let r = c
        .put(
            "/test/api/v1/me/password-login",
            json!({ "enabled": false }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(
        (
            r.json()["password_login"].clone(),
            r.json()["password_login_disabled"].clone()
        ),
        (json!(false), json!(true))
    );
    let probe = Client::new(&st, rand_ip());
    let r = probe
        .post("/test/auth/login", login_body(&email, "user-password-1"))
        .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::FORBIDDEN, json!("auth.passkey_required"))
    );
    let r = probe
        .post("/test/auth/login", login_body(&email, "wrong-password"))
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // List, rename, delete; the last current passkey gone = password back.
    let v = c.get("/test/api/v1/me/passkeys").await.json();
    assert_eq!(v["passkeys"].as_array().unwrap().len(), 1);
    assert_eq!(v["passkeys"][0]["current"], true);
    assert!(v["passkeys"][0]["last_used_at"].is_string());
    assert!(!v.to_string().contains("cred_id") && !v.to_string().contains("\"cred\""));
    let pid = v["passkeys"][0]["id"].as_str().unwrap().to_string();
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/me/passkeys/{pid}"),
            Some(json!({ "name": "\u{7}" })),
        )
        .await;
    assert_eq!(r.json()["code"], "account.passkey_name_invalid");
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/me/passkeys/{pid}"),
            Some(json!({ "name": "Laptop" })),
        )
        .await;
    assert_eq!(r.json()["name"], "Laptop");
    // Another account cannot see or touch it: the canonical rejection.
    let other = client_for(&st, db.user().await).await;
    let canonical = other.get("/test/no-such-route").await;
    let r = other
        .req(
            Method::DELETE,
            &format!("/test/api/v1/me/passkeys/{pid}"),
            None,
        )
        .await;
    assert_eq!(r.fingerprint(), canonical.fingerprint());
    let r = other
        .req(
            Method::PATCH,
            &format!("/test/api/v1/me/passkeys/{pid}"),
            Some(json!({ "name": "x" })),
        )
        .await;
    assert_eq!(r.fingerprint(), canonical.fingerprint());
    let r = c
        .req(
            Method::DELETE,
            &format!("/test/api/v1/me/passkeys/{pid}"),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let v = c.get("/test/api/v1/me/passkeys").await.json();
    assert_eq!(
        v["password_login"], true,
        "no passkey: the password works again"
    );
    assert_eq!(
        probe
            .post("/test/auth/login", login_body(&email, "user-password-1"))
            .await
            .status,
        StatusCode::OK
    );
    // Switching the password off without a passkey: refused.
    let r = c
        .put(
            "/test/api/v1/me/password-login",
            json!({ "enabled": false }),
        )
        .await;
    assert_eq!(r.json()["code"], "account.passkey_required");

    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE target_id = $1 AND action LIKE 'user.%' ORDER BY id",
    )
    .bind(id.to_string())
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        actions,
        [
            "user.passkey.add",
            "user.password_login.set",
            "user.passkey.rename",
            "user.passkey.delete"
        ]
    );
    db.drop().await;
}

/// The login prompt (bind + switch the password off in one step), the
/// admin role policy with its risk warnings, admin and CLI reset.
#[tokio::test]
async fn prompt_role_policy_and_reset() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state_with_domain(&db, RP).await;
    let (admin, admin_email) = account(&db, "admin", "admin-password-1").await;
    // R47: the sign-in policies are the owner's.
    sqlx::query("UPDATE users SET is_owner = true WHERE id = $1")
        .bind(admin)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut a = Client::new(&st, rand_ip());
    a.login(&admin_email, "admin-password-1").await;
    let v = a.get("/test/api/v1/settings/auth").await.json();
    let body = |admins: bool, prompt: bool, version: &Value| {
        json!({ "version": version, "turnstile_site_key": null, "turnstile_login": false,
                "turnstile_register": false, "turnstile_reset": false, "honeypot": true,
                "min_submit_secs": 0, "passkey_only_admins": admins, "passkey_only_users": false,
                "passkey_prompt": prompt })
    };
    let r = a
        .put(
            "/test/api/v1/settings/auth",
            body(true, true, &v["version"]),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert!(
        r.json()["warnings"][0]
            .as_str()
            .unwrap()
            .contains("还没有通行密钥"),
        "{:?}",
        r.json()
    );

    // An admin without a passkey: the password works, with the prompt.
    let probe = Client::new(&st, rand_ip());
    let r = probe
        .post(
            "/test/auth/login",
            login_body(&admin_email, "admin-password-1"),
        )
        .await;
    assert_eq!(
        (r.status, r.json()["passkey_prompt"].clone()),
        (StatusCode::OK, json!(true))
    );
    // Binding from the prompt switches the password off at once.
    let mut key = SoftKey::new();
    bind(&a, &mut key, "YubiKey", true).await;
    let r = probe
        .post(
            "/test/auth/login",
            login_body(&admin_email, "admin-password-1"),
        )
        .await;
    assert_eq!(r.json()["code"], "auth.passkey_required");
    // Admin logins are always audited, with the method.
    assert_eq!(passkey_login(&probe, &mut key).await.status, StatusCode::OK);
    let m: String = sqlx::query_scalar(
        "SELECT after->>'method' FROM audit_log WHERE action = 'auth.login' \
         AND target_id = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(admin.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(m, "passkey");
    let v = a.get("/test/api/v1/settings/auth").await.json();
    assert!(
        v["warnings"][0]
            .as_str()
            .unwrap()
            .contains("只有一个通行密钥"),
        "{v:?}"
    );
    // The role policy alone (own switch back on) still refuses the password.
    let r = a
        .put("/test/api/v1/me/password-login", json!({ "enabled": true }))
        .await;
    assert_eq!(
        r.json()["password_login"],
        false,
        "the admin policy applies"
    );
    assert_eq!(
        probe
            .post(
                "/test/auth/login",
                login_body(&admin_email, "admin-password-1")
            )
            .await
            .json()["code"],
        "auth.passkey_required"
    );

    // Admin reset of a user; CLI reset of the admin.
    let (uid, uemail) = account(&db, "user", "user-password-1").await;
    let mut u = Client::new(&st, rand_ip());
    u.login(&uemail, "user-password-1").await;
    let mut ukey = SoftKey::new();
    bind(&u, &mut ukey, "phone", true).await;
    let v = a
        .get(&format!("/test/api/v1/users/{uid}/passkeys"))
        .await
        .json();
    assert_eq!(
        (
            v["passkeys"].as_array().unwrap().len(),
            v["password_login"].clone()
        ),
        (1, json!(false))
    );
    let r = a
        .post(
            &format!("/test/api/v1/users/{uid}/login-method/reset"),
            json!({}),
        )
        .await;
    assert_eq!(r.json()["deleted_passkeys"], 1);
    assert_eq!(
        probe
            .post("/test/auth/login", login_body(&uemail, "user-password-1"))
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        passkey_login(&probe, &mut ukey).await.status,
        StatusCode::UNAUTHORIZED
    );
    let canonical = a.get("/test/no-such-route").await;
    let r = a
        .post(
            &format!("/test/api/v1/users/{}/login-method/reset", Uuid::new_v4()),
            json!({}),
        )
        .await;
    assert_eq!(r.fingerprint(), canonical.fingerprint());
    // The admin's reset ended the account's sessions (audit batch 2).
    assert_eq!(
        u.get("/test/api/v1/me").await.status,
        StatusCode::UNAUTHORIZED
    );
    let u = client_for(&st, uid).await;
    assert_eq!(
        u.get(&format!("/test/api/v1/users/{uid}/passkeys"))
            .await
            .status,
        StatusCode::FORBIDDEN
    );

    assert_eq!(
        cli_reset_login(&db.pool, &admin_email.to_uppercase())
            .await
            .unwrap(),
        1
    );
    assert!(
        cli_reset_login(&db.pool, "nobody@test.invalid")
            .await
            .is_err()
    );
    assert_eq!(
        probe
            .post(
                "/test/auth/login",
                login_body(&admin_email, "admin-password-1")
            )
            .await
            .status,
        StatusCode::OK
    );
    let (who, after): (String, Value) = sqlx::query_as(
        "SELECT actor_label, after FROM audit_log WHERE action = 'user.login_method.reset' \
         AND target_id = $1",
    )
    .bind(admin.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        (who.as_str(), after["password_login_disabled"].clone()),
        ("cli", json!(false))
    );
    db.drop().await;
}

/// D8 domain change: passkeys belong to the old RP ID — kept, shown as not
/// current, useless for login, and they no longer make an account
/// passkey-only. Without an https main domain passkeys are unavailable.
#[tokio::test]
async fn main_domain_change_and_unavailable() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state_with_domain(&db, RP).await;
    let (_, email) = account(&db, "user", "user-password-1").await;
    let mut c = Client::new(&st, rand_ip());
    c.login(&email, "user-password-1").await;
    let mut key = SoftKey::new();
    bind(&c, &mut key, "phone", true).await;
    let probe = Client::new(&st, rand_ip());
    assert_eq!(
        probe
            .post("/test/auth/login", login_body(&email, "user-password-1"))
            .await
            .status,
        StatusCode::FORBIDDEN
    );

    db.domains(&st, "main", &["new.example"]).await;
    let v = c.get("/test/api/v1/me/passkeys").await.json();
    assert_eq!(
        (v["rp_id"].clone(), v["passkeys"][0]["current"].clone()),
        (json!("new.example"), json!(false))
    );
    assert_eq!(v["password_login"], true);
    assert_eq!(
        probe
            .post("/test/auth/login", login_body(&email, "user-password-1"))
            .await
            .status,
        StatusCode::OK
    );
    // The browser would sign for the old RP ID / origin: refused.
    assert_eq!(
        passkey_login(&probe, &mut key).await.status,
        StatusCode::UNAUTHORIZED
    );

    // An IP main domain: no passkeys; public endpoints are the canonical
    // rejection, account endpoints a coded 409.
    db.domains(&st, "main", &["127.0.0.1:8080"]).await;
    let canonical = probe.get("/test/no-such-route").await;
    for p in ["/test/auth/passkey/options", "/test/auth/passkey/login"] {
        let r = probe.post(p, json!({})).await;
        assert_eq!(r.fingerprint(), canonical.fingerprint(), "{p}");
    }
    assert_eq!(
        probe.get("/test/auth/options").await.json()["passkey"],
        false
    );
    let r = c.post("/test/api/v1/me/passkeys/options", json!({})).await;
    assert_eq!(r.json()["code"], "account.passkey_unavailable");
    db.drop().await;
}

/// Answer a re-authentication challenge with `key`.
async fn reauth_proof(c: &Client, key: &mut SoftKey) -> Value {
    let r = c.post("/test/api/v1/me/reauth/options", json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.headers["cache-control"], "no-store");
    let o = r.json();
    let cred = key.get(&o["options"], RP, ORIGIN);
    json!({ "state": o["state"], "credential": cred })
}

/// The holder's confirmation for deleting the account: a passkey-only
/// account must answer a challenge of its own passkeys (the password is
/// refused); the challenge is single use and bound to the account.
#[tokio::test]
async fn reauth_confirms_account_deletion() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state_with_domain(&db, RP).await;
    let (id, email) = account(&db, "user", "user-password-1").await;
    let mut c = Client::new(&st, rand_ip());
    c.login(&email, "user-password-1").await;
    // No passkey yet: nothing to challenge.
    let r = c.post("/test/api/v1/me/reauth/options", json!({})).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::CONFLICT, json!("account.passkey_none"))
    );
    let mut key = SoftKey::new();
    bind(&c, &mut key, "Phone", false).await;
    let o = c
        .post("/test/api/v1/me/reauth/options", json!({}))
        .await
        .json();
    assert_eq!(
        o["options"]["publicKey"]["allowCredentials"][0]["id"],
        json!(B64.encode(&key.cred_id))
    );

    // Passkey only: the right password no longer confirms.
    let r = c
        .put(
            "/test/api/v1/me/password-login",
            json!({ "enabled": false }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let del = |body: Value| {
        let c = &c;
        async move { c.post("/test/api/v1/me/delete", body).await }
    };
    let r = del(json!({ "confirm": true, "password": "user-password-1" })).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (
            StatusCode::BAD_REQUEST,
            json!("account.passkey_confirm_required")
        )
    );
    assert_eq!(
        del(json!({ "confirm": true })).await.json()["code"],
        "account.passkey_confirm_required"
    );

    // Another account's challenge (or another account answering this one)
    // proves nothing.
    let (_, other_email) = account(&db, "user", "user-password-2").await;
    let mut other = Client::new(&st, rand_ip());
    other.login(&other_email, "user-password-2").await;
    let mut other_key = SoftKey::new();
    bind(&other, &mut other_key, "Other", false).await;
    let foreign = reauth_proof(&other, &mut other_key).await;
    let r = del(json!({ "confirm": true, "passkey": foreign })).await;
    assert_eq!(r.json()["code"], "account.passkey_failed");
    // A forged signature: refused, and the challenge is spent.
    let mut proof = reauth_proof(&c, &mut key).await;
    proof["credential"]["response"]["signature"] = json!(B64.encode([0u8; 70]));
    let r = del(json!({ "confirm": true, "passkey": proof.clone() })).await;
    assert_eq!(r.json()["code"], "account.passkey_failed");
    let mut good = reauth_proof(&c, &mut key).await;
    good["state"] = proof["state"].clone();
    assert_eq!(
        del(json!({ "confirm": true, "passkey": good }))
            .await
            .json()["code"],
        "account.passkey_failed"
    );
    let still: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(still);

    // The account's own passkey: deleted.
    let proof = reauth_proof(&c, &mut key).await;
    let r = del(json!({ "confirm": true, "passkey": proof.clone() })).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{:?}", r.json());
    let gone: bool = sqlx::query_scalar("SELECT NOT EXISTS (SELECT 1 FROM users WHERE id = $1)")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(gone);
    db.drop().await;
}

/// Without a main domain there is no passkey: the options are refused and
/// a proof never verifies.
#[tokio::test]
async fn reauth_without_passkeys_available() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    let (id, _) = account(&db, "user", "user-password-1").await;
    let c = client_for(&st, id).await;
    let r = c.post("/test/api/v1/me/reauth/options", json!({})).await;
    assert_eq!(r.json()["code"], "account.passkey_unavailable");
    let mut key = SoftKey::new();
    key.user = Some(id);
    let cred = key.get(
        &json!({ "publicKey": { "challenge": B64.encode([1u8; 32]) } }),
        RP,
        ORIGIN,
    );
    let proof: PasskeyProof =
        serde_json::from_value(json!({ "state": "0".repeat(64), "credential": cred })).unwrap();
    assert!(!verify_reauth(&st, id, &proof).await.unwrap());
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Passkey centre (related origins)
// ---------------------------------------------------------------------------

const CENTRE: &str = "passkey.example.org";

fn on_host(c: &mut Client, host: &str) {
    c.headers.retain(|(k, _)| !k.eq_ignore_ascii_case("host"));
    c.headers.push(("host".into(), host.into()));
}

/// A password nobody could have guessed (CodeQL: no literal passwords).
fn random_pw() -> String {
    format!("pw-{}", Uuid::new_v4().simple())
}

/// A passkey login from `host`, the authenticator signing for `rp` at
/// `origin`; the status of the login.
async fn centre_login(
    st: &AppState,
    key: &mut SoftKey,
    host: &str,
    origin: &str,
    rp: &str,
) -> StatusCode {
    let mut p = Client::new(st, rand_ip());
    on_host(&mut p, host);
    let opts = p.get("/test/auth/options").await;
    assert_eq!(opts.status, StatusCode::OK, "{host}");
    assert_eq!(opts.json()["passkey_rp"], CENTRE);
    let r = p.post("/test/auth/passkey/options", json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let o = r.json();
    let cred = key.get(&o["options"], rp, origin);
    p.post(
        "/test/auth/passkey/login",
        json!({ "state": o["state"], "credential": cred }),
    )
    .await
    .status
}

#[test]
fn registrable_labels_ignore_subdomains_and_suffixes() {
    use crate::settings::registrable_label as l;
    assert_eq!(l("akari.cc"), "akari");
    assert_eq!(l("a.b.akari.com"), "akari");
    assert_eq!(l("shop.example.co.uk"), "example");
    assert_eq!(l("mwny.net"), "mwny");
    assert_eq!(l("localhost"), "localhost");
}

#[tokio::test]
async fn centre_serves_the_related_origins_and_nothing_else() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    db.domains(
        &st,
        "main",
        &["panel.example", "other.net:8443", "203.0.113.9"],
    )
    .await;
    db.domains(&st, "sub", &["sub.example"]).await;
    db.passkey_domain(&st, Some(CENTRE)).await;

    let mut c = Client::new(&st, rand_ip());
    on_host(&mut c, CENTRE);
    let r = c.get("/.well-known/webauthn").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers["content-type"], "application/json");
    assert_eq!(r.headers["cache-control"], "public, max-age=300");
    // The https main domains only: no IP literal, no subscription domain.
    assert_eq!(
        r.json(),
        json!({ "origins": ["https://panel.example", "https://other.net:8443"] })
    );

    // Everything else on the centre is the canonical rejection.
    let canonical = Client::new(&st, rand_ip()).get("/no-such-route").await;
    for (method, path) in [
        (Method::GET, "/"),
        (Method::GET, "/test/app"),
        (Method::GET, "/test/healthz"),
        (Method::GET, "/.well-known/webauthn/x"),
        (Method::POST, "/.well-known/webauthn"),
        (Method::GET, "/auth/options"),
    ] {
        let r = c.req(method.clone(), path, None).await;
        assert_eq!(r.fingerprint(), canonical.fingerprint(), "{method} {path}");
    }

    // A main domain does not serve the file.
    let mut m = Client::new(&st, rand_ip());
    on_host(&mut m, "panel.example");
    assert_eq!(
        m.get("/.well-known/webauthn").await.fingerprint(),
        canonical.fingerprint()
    );
    db.drop().await;
}

#[tokio::test]
async fn one_passkey_works_on_every_main_domain() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    db.domains(&st, "main", &["panel.example", "other.net"])
        .await;
    db.passkey_domain(&st, Some(CENTRE)).await;
    let pw = random_pw();
    let (_, email) = account(&db, "user", &pw).await;

    // Bound once, on the first main domain: the RP ID is the centre's.
    let mut c = Client::new(&st, rand_ip());
    on_host(&mut c, "panel.example");
    c.login(&email, &pw).await;
    let mut key = SoftKey::new();
    let r = c.post("/test/api/v1/me/passkeys/options", json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let o = r.json();
    let cred = key.create(&o["options"], CENTRE, "https://panel.example");
    let r = c
        .post(
            "/test/api/v1/me/passkeys",
            json!({ "state": o["state"], "credential": cred, "name": "phone" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let v = c.get("/test/api/v1/me/passkeys").await.json();
    assert_eq!(v["rp_id"], CENTRE);
    assert_eq!(v["passkeys"][0]["current"], true);

    // Every main domain and the centre's own origin sign in with it.
    assert_eq!(
        centre_login(
            &st,
            &mut key,
            "panel.example",
            "https://panel.example",
            CENTRE
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        centre_login(&st, &mut key, "other.net", "https://other.net", CENTRE).await,
        StatusCode::OK
    );
    assert_eq!(
        centre_login(
            &st,
            &mut key,
            "other.net",
            "https://passkey.example.org",
            CENTRE
        )
        .await,
        StatusCode::OK
    );
    // A domain that is not a main domain (nor a subdomain of one), and an
    // authenticator that signed for another RP ID, are refused.
    assert_eq!(
        centre_login(&st, &mut key, "other.net", "https://evil.example", CENTRE).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        centre_login(
            &st,
            &mut key,
            "other.net",
            "https://sub.panel.example",
            CENTRE
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        centre_login(&st, &mut key, "other.net", "https://other.net", "other.net").await,
        StatusCode::UNAUTHORIZED
    );

    // A main domain added later is in the list at once; one removed is out.
    db.domains(&st, "main", &["panel.example", "new.example"])
        .await;
    assert_eq!(
        centre_login(&st, &mut key, "new.example", "https://new.example", CENTRE).await,
        StatusCode::OK
    );
    // (The browser on the removed domain never gets here: its host is
    // refused; an authenticator still signing for it is out of the list.)
    assert_eq!(
        centre_login(&st, &mut key, "panel.example", "https://other.net", CENTRE).await,
        StatusCode::UNAUTHORIZED
    );

    // Without a centre the preferred main domain is the RP again; the
    // centre's credentials are no longer current.
    db.passkey_domain(&st, None).await;
    let v = c.get("/test/api/v1/me/passkeys").await.json();
    assert_eq!(
        (v["rp_id"].clone(), v["passkeys"][0]["current"].clone()),
        (json!("panel.example"), json!(false))
    );
    db.drop().await;
}

#[tokio::test]
async fn the_centre_is_a_domain_of_its_own() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    db.domains(&st, "main", &["panel.example"]).await;
    db.domains(&st, "sub", &["sub.example"]).await;
    db.domains(&st, "node", &["grpc.example"]).await;
    let actor = crate::audit::Actor::cli();
    let version = |db: &TestDb| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT version FROM panel_settings WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };

    // The value: a DNS name, never an IP literal.
    use crate::settings::passkey_domain_value as value;
    assert_eq!(value(None).unwrap(), None);
    assert_eq!(value(Some("  ")).unwrap(), None);
    assert_eq!(
        value(Some("Passkey.Example.ORG")).unwrap().as_deref(),
        Some(CENTRE)
    );
    for bad in ["203.0.113.9", "nodots", "https://x.example", "a b.example"] {
        assert!(value(Some(bad)).is_err(), "{bad}");
    }

    // No host of another kind may be the centre.
    for taken in ["panel.example", "sub.example", "grpc.example"] {
        let mut tx = db.pool.begin().await.unwrap();
        let err = crate::settings::apply_update_passkey_domain(
            &mut tx,
            &actor,
            version(&db).await,
            Some(taken.into()),
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert_eq!(err.code(), "settings.passkey_domain_clash", "{taken}");
    }
    let mut tx = db.pool.begin().await.unwrap();
    crate::settings::apply_update_passkey_domain(
        &mut tx,
        &actor,
        version(&db).await,
        Some(CENTRE.into()),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    // ... and the other way round: a list may not take the centre's host.
    for kind in [
        crate::settings::DomainKind::Main,
        crate::settings::DomainKind::Sub,
        crate::settings::DomainKind::Node,
    ] {
        let mut new = crate::settings::Values::default();
        new.prefer(kind, CENTRE.to_string());
        let mut tx = db.pool.begin().await.unwrap();
        let err = crate::settings::apply_update(&mut tx, &actor, version(&db).await, &new)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert_eq!(err.code(), "settings.passkey_domain_clash", "{kind:?}");
    }

    // Stale form: 409.
    let mut tx = db.pool.begin().await.unwrap();
    let err = crate::settings::apply_update_passkey_domain(&mut tx, &actor, 0, None)
        .await
        .unwrap_err();
    tx.rollback().await.unwrap();
    assert_eq!(err.code(), "settings.version_conflict");

    // Audited, and the view tells the admin what browsers are told.
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'settings.passkey_domain.update'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(n, 1);
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Registering with a passkey; binding the address afterwards
// ---------------------------------------------------------------------------

async fn signup_set(db: &TestDb, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE signup_settings SET {sql} WHERE id = 1"
    )))
    .execute(&db.pool)
    .await
    .unwrap();
}

async fn pow_for(c: &Client) -> Value {
    let r = c.get("/test/auth/register/challenge").await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let j = r.json();
    let ch = j["challenge"].as_str().unwrap();
    let nonce = crate::signup::pow::solve(ch, j["bits"].as_u64().unwrap() as u32);
    json!({ "challenge": ch, "nonce": nonce })
}

/// Register with `key`: options + finish; the finish answer. On success the
/// client keeps the session.
async fn passkey_signup(
    c: &mut Client,
    key: &mut SoftKey,
    extra: Value,
) -> crate::testdb::http::Resp {
    let mut body = json!({ "pow": pow_for(c).await });
    if let Value::Object(m) = extra {
        body.as_object_mut().unwrap().extend(m);
    }
    let r = c.post("/test/auth/register/passkey/options", body).await;
    if r.status != StatusCode::OK {
        return r;
    }
    let o = r.json();
    let sel = &o["options"]["publicKey"]["authenticatorSelection"];
    assert_eq!(sel["residentKey"], "required");
    let cred = key.create(&o["options"], RP, ORIGIN);
    let r = c
        .post(
            "/test/auth/register/passkey",
            json!({ "state": o["state"], "credential": cred, "name": "laptop" }),
        )
        .await;
    if let Some(cookie) = r.session_cookie() {
        c.cookie = Some(cookie);
    }
    r
}

#[tokio::test]
async fn registering_with_a_passkey_then_binding_the_address() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state_with_domain(&db, RP).await;
    let first_pw = random_pw();
    let mut c = Client::new(&st, rand_ip());
    let canonical = c.get("/test/no-such-route").await;

    // Off by default (and while registration itself is off): the canonical
    // rejection, before any body is read.
    for sql in [
        "passkey_register = true",
        "register_enabled = true, passkey_register = false",
    ] {
        signup_set(&db, sql).await;
        for p in [
            "/test/auth/register/passkey/options",
            "/test/auth/register/passkey",
        ] {
            let r = c.post(p, json!({})).await;
            assert_eq!(r.fingerprint(), canonical.fingerprint(), "{sql} {p}");
        }
    }
    signup_set(
        &db,
        "register_enabled = true, passkey_register = true, email_verify = false",
    )
    .await;
    let opts = c.get("/test/auth/options").await.json();
    assert_eq!(opts["passkey_register"], true);

    // A request without a solved challenge is refused.
    let r = c
        .post(
            "/test/auth/register/passkey/options",
            json!({ "pow": { "challenge": "x", "nonce": "1" } }),
        )
        .await;
    assert_eq!(r.json()["code"], "signup.challenge_invalid");

    let mut key = SoftKey::new();
    let r = passkey_signup(&mut c, &mut key, json!({ "locale": "en" })).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["email_pending"], true);
    let id: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();
    let (email, pending, method, verified, has_pw, locale): (
        String,
        bool,
        String,
        bool,
        bool,
        String,
    ) = sqlx::query_as(
        "SELECT email, email_pending, signup_method, email_verified_at IS NOT NULL, \
             password_hash IS NOT NULL, locale FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(email, format!("pending-{id}@pending.invalid"));
    assert_eq!(
        (pending, method.as_str(), verified, has_pw, locale.as_str()),
        (true, "passkey", false, false, "en")
    );
    let (n, rp): (i64, String) =
        sqlx::query_as("SELECT count(*), min(rp_id) FROM webauthn_credentials WHERE user_id = $1")
            .bind(id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!((n, rp.as_str()), (1, RP));
    // The audit row names the method; the sign-up has no password.
    let audit: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE action = 'user.register' AND target_id = $1",
    )
    .bind(id.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audit["signup_method"], "passkey");

    // Pending: GET /me (no email shown, no subscription) and the binding
    // endpoints only.
    let me = c.get("/test/api/v1/me").await;
    assert_eq!(me.status, StatusCode::OK, "{:?}", me.json());
    assert_eq!(me.json()["email_pending"], true);
    assert_eq!(me.json()["email"], "");
    assert!(me.json()["sub_url"].is_null());
    for p in [
        "/test/api/v1/me/passkeys",
        "/test/api/v1/me/plan",
        "/test/api/v1/me/nodes",
        "/test/api/v1/me/tickets",
        "/test/api/v1/me/shop",
        "/test/api/v1/me/orders",
    ] {
        let r = c.get(p).await;
        assert_eq!(
            (r.status, r.json()["code"].clone()),
            (StatusCode::FORBIDDEN, json!("account.email_required")),
            "{p}"
        );
    }
    // The second registration with the same credential is refused.
    // Another account's address: the generic refusal.
    let other = format!(
        "taken{}@example.com",
        &Uuid::new_v4().simple().to_string()[..8]
    );
    sqlx::query("INSERT INTO users (id, email) VALUES ($1, $2)")
        .bind(Uuid::new_v4())
        .bind(&other)
        .execute(&db.pool)
        .await
        .unwrap();
    let r = c
        .post("/test/api/v1/me/email/bind", json!({ "email": other }))
        .await;
    assert_eq!(r.json()["code"], "signup.unavailable");
    // The code step does not exist while the site does not verify.
    let r = c
        .post(
            "/test/api/v1/me/email/bind/code",
            json!({ "email": "a@example.com" }),
        )
        .await;
    assert_eq!(r.json()["code"], "account.bind_no_code");

    // Bind (optional password in the same step).
    let mine = format!(
        "mine{}@example.com",
        &Uuid::new_v4().simple().to_string()[..8]
    );
    let r = c
        .post(
            "/test/api/v1/me/email/bind",
            json!({ "email": mine, "password": first_pw }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["password_set"], true);
    c.cookie = r.session_cookie();
    let (email, pending, verified): (String, bool, bool) = sqlx::query_as(
        "SELECT email, email_pending, email_verified_at IS NOT NULL FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        (email.as_str(), pending, verified),
        (mine.as_str(), false, false)
    );
    // Everything works now; the binding endpoints do not.
    assert_eq!(
        c.get("/test/api/v1/me/passkeys").await.status,
        StatusCode::OK
    );
    let r = c
        .post(
            "/test/api/v1/me/email/bind",
            json!({ "email": "z@example.com" }),
        )
        .await;
    assert_eq!(r.json()["code"], "account.email_bound");
    // The address is the login name; the password set while binding works.
    let mut p = Client::new(&st, rand_ip());
    assert_eq!(p.login(&mine, &first_pw).await.status, StatusCode::OK);
    // And the passkey signs in (a second device would too).
    assert_eq!(passkey_login(&p, &mut key).await.status, StatusCode::OK);
    db.drop().await;
}

#[tokio::test]
async fn binding_with_a_mailed_code_and_a_first_password_by_passkey() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (first_pw, second_pw) = (random_pw(), random_pw());
    let st = state_with_domain(&db, RP).await;
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', port = 1025, \
         security = 'none', from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    signup_set(
        &db,
        "register_enabled = true, passkey_register = true, email_verify = true",
    )
    .await;
    let mut c = Client::new(&st, rand_ip());
    let mut key = SoftKey::new();
    let r = passkey_signup(&mut c, &mut key, json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let id: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();

    let mine = format!(
        "mine{}@example.com",
        &Uuid::new_v4().simple().to_string()[..8]
    );
    let r = c
        .post("/test/api/v1/me/email/bind/code", json!({ "email": mine }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    // The code mail (the spawned work may lag).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let body = loop {
        let b: Option<String> = sqlx::query_scalar(
            "SELECT body_text FROM mail_outbox WHERE kind = 'email_code' AND to_addr = $1",
        )
        .bind(&mine)
        .fetch_optional(&db.pool)
        .await
        .unwrap();
        if let Some(b) = b {
            break b;
        }
        assert!(std::time::Instant::now() < deadline, "no code mail");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    let code: String = body
        .split(|ch: char| !ch.is_ascii_digit())
        .find(|w| w.len() == 6)
        .unwrap()
        .to_string();
    // A wrong code is the one generic refusal; the account stays pending.
    let r = c
        .post("/test/api/v1/me/email/bind", json!({ "code": "000000" }))
        .await;
    assert_eq!(r.json()["code"], "signup.invalid_code");
    let r = c
        .post("/test/api/v1/me/email/bind", json!({ "code": code }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["email_verified"], true);
    let (email, pending, verified): (String, bool, bool) = sqlx::query_as(
        "SELECT email, email_pending, email_verified_at IS NOT NULL FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        (email.as_str(), pending, verified),
        (mine.as_str(), false, true)
    );

    // No password yet: the first one needs a passkey proof, not a guess.
    let r = c
        .post(
            "/test/api/v1/me/password",
            json!({ "new_password": first_pw }),
        )
        .await;
    assert_eq!(r.json()["code"], "account.passkey_confirm_required");
    let proof = reauth_proof(&c, &mut key).await;
    let r = c
        .post(
            "/test/api/v1/me/password",
            json!({ "new_password": first_pw, "passkey": proof }),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{:?}", r.json());
    // The password change ends the other sessions; this one continues.
    c.cookie = r.session_cookie();
    let mut p = Client::new(&st, rand_ip());
    assert_eq!(p.login(&mine, &first_pw).await.status, StatusCode::OK);
    // With a password the ordinary rule is back: the current one.
    let r = c
        .post(
            "/test/api/v1/me/password",
            json!({ "new_password": second_pw }),
        )
        .await;
    assert_eq!(r.json()["code"], "account.password_required");
    db.drop().await;
}

#[tokio::test]
async fn passkey_signup_gates_and_purge() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state_with_domain(&db, RP).await;
    signup_set(
        &db,
        "register_enabled = true, passkey_register = true, invite_required = true",
    )
    .await;
    let mut c = Client::new(&st, rand_ip());
    let mut key = SoftKey::new();
    // The invite code is required, and must exist.
    let r = passkey_signup(&mut c, &mut key, json!({})).await;
    assert_eq!(r.json()["code"], "signup.invite_required");
    let r = passkey_signup(&mut c, &mut key, json!({ "invite_code": "abcdefgh" })).await;
    assert_eq!(r.json()["code"], "signup.invalid_invite");
    // A filled honeypot gets the generic refusal and nothing is created.
    signup_set(&db, "invite_required = false").await;
    sqlx::query("UPDATE auth_settings SET honeypot = true")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = passkey_signup(
        &mut c,
        &mut key,
        json!({ "guard": { "form_token": "x", "website": "http://spam.example" } }),
    )
    .await;
    assert_eq!(r.json()["code"], "signup.unavailable");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email_pending")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    sqlx::query("UPDATE auth_settings SET honeypot = false")
        .execute(&db.pool)
        .await
        .unwrap();

    // Passkeys must work for the switch to be turned on (admin API).
    let r = passkey_signup(&mut c, &mut key, json!({})).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let id: Uuid = r.json()["id"].as_str().unwrap().parse().unwrap();

    // Pending accounts older than the limit are deleted (with their
    // passkeys); fresh ones stay. Audited as `system`.
    let fresh = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, email, role, signup_method, email_pending) \
         VALUES ($1, $2, 'user', 'passkey', true)",
    )
    .bind(fresh)
    .bind(crate::signup::passkey_register::pending_email(fresh))
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET created_at = now() - interval '25 hours' WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        crate::signup::passkey_register::purge_pending(&db.pool)
            .await
            .unwrap(),
        1
    );
    let left: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email_pending")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(left, vec![fresh]);
    let creds: i64 =
        sqlx::query_scalar("SELECT count(*) FROM webauthn_credentials WHERE user_id = $1")
            .bind(id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(creds, 0);
    assert_eq!(
        crate::signup::passkey_register::purge_pending(&db.pool)
            .await
            .unwrap(),
        0
    );
    db.drop().await;
}

async fn notices(db: &TestDb, to: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT body_text FROM mail_outbox WHERE kind = 'security_notice' AND to_addr = $1 \
         ORDER BY id",
    )
    .bind(to)
    .fetch_all(&db.pool)
    .await
    .unwrap()
}

/// Audit batch 2, P2-1: no extra step, but the account's VERIFIED address is
/// told (time and client address, no secrets) when a passkey is added or
/// deleted, the password sign-in is switched off / on, the password
/// changes, or an administrator resets the login method; an unverified
/// address is told nothing.
#[tokio::test]
async fn sign_in_changes_are_mailed_to_the_verified_address() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state_with_domain(&db, RP).await;
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', port = 1025, \
         security = 'none', from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let (pw1, pw2, pw3) = (random_pw(), random_pw(), random_pw());
    let (id, email) = account(&db, "user", &pw1).await;
    let (loose, loose_email) = account(&db, "user", &pw2).await;
    sqlx::query("UPDATE users SET email_verified_at = now(), locale = 'en' WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut c = Client::new(&st, rand_ip());
    assert_eq!(c.login(&email, &pw1).await.status, StatusCode::OK);
    let mut key = SoftKey::new();
    let added = bind(&c, &mut key, "phone", true).await;
    let got = notices(&db, &email).await;
    assert_eq!(got.len(), 2, "{got:?}");
    assert!(got[0].contains("passkey was added"), "{}", got[0]);
    assert!(
        got[1].contains("Password sign-in was switched off"),
        "{}",
        got[1]
    );
    let ip = c.ip.to_string();
    for g in &got {
        assert!(g.contains(&ip) && g.contains("UTC"), "{g}");
        assert!(!g.contains(&pw1));
    }
    // Back on, delete the passkey, change the password.
    let r = c
        .put("/test/api/v1/me/password-login", json!({ "enabled": true }))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let r = c
        .req(
            axum::http::Method::DELETE,
            &format!("/test/api/v1/me/passkeys/{}", added["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = c
        .post(
            "/test/api/v1/me/password",
            json!({ "current_password": pw1, "new_password": pw3 }),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{:?}", r.json());
    let got = notices(&db, &email).await;
    assert_eq!(got.len(), 5, "{got:?}");
    assert!(got[2].contains("switched back on"));
    assert!(got[3].contains("passkey was removed"));
    assert!(got[4].contains("password of your account was changed"));
    assert!(!got.iter().any(|g| g.contains(&pw3)));

    // The administrator's reset: told too (no admin address in the mail),
    // and every session of the account ends.
    let before: i64 = sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    super::apply_reset_login(&mut tx, &Actor::cli(), id)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let after: i64 = sqlx::query_scalar("SELECT session_ver FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(after, before + 1, "login-method reset ends the sessions");
    assert_eq!(
        c.get("/test/api/v1/me").await.status,
        StatusCode::UNAUTHORIZED
    );
    let got = notices(&db, &email).await;
    assert_eq!(got.len(), 6);
    assert!(got[5].contains("administrator reset your sign-in method"));
    assert!(got[5].contains("done by an administrator"));

    // An address nobody verified gets nothing.
    let mut u = Client::new(&st, rand_ip());
    u.login(&loose_email, &pw2).await;
    let mut k2 = SoftKey::new();
    bind(&u, &mut k2, "tablet", false).await;
    assert!(notices(&db, &loose_email).await.is_empty());
    let _ = loose;
    db.drop().await;
}

// ---------------------------------------------------------------------------
// Passkey-only fallback: password + a code mailed to the verified address
// ---------------------------------------------------------------------------

async fn mail_on(db: &TestDb) {
    sqlx::query(
        "UPDATE mail_settings SET enabled = true, host = '127.0.0.1', port = 1025, \
         security = 'none', from_addr = 'noreply@example.com' WHERE id = 1",
    )
    .execute(&db.pool)
    .await
    .unwrap();
}

/// The newest sign-in code mailed to `to`.
async fn login_code(db: &TestDb, to: &str) -> Option<String> {
    let body: Option<String> = sqlx::query_scalar(
        "SELECT body_text FROM mail_outbox WHERE kind = 'login_code' AND to_addr = $1 \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(to)
    .fetch_optional(&db.pool)
    .await
    .unwrap();
    let body = body?;
    let digits: Vec<char> = body.chars().collect();
    digits
        .windows(6)
        .find(|w| w.iter().all(char::is_ascii_digit))
        .map(|w| w.iter().collect())
}

fn fallback_body(email: &str, pw: &str, code: &str) -> Value {
    json!({ "email": email, "password": pw, "fallback_code": code })
}

/// A passkey-only account whose passkeys are unusable signs in with the
/// password plus the code mailed to its verified address: the code is
/// single use, five wrong tries burn it, a wrong password gets nothing, and
/// a success is audited and mailed as a security notice.
#[tokio::test]
async fn password_and_mailed_code_replace_an_unusable_passkey() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state_with_domain(&db, RP).await;
    mail_on(&db).await;
    let pw = random_pw();
    let (id, email) = account(&db, "user", &pw).await;
    sqlx::query("UPDATE users SET email_verified_at = now(), locale = 'en' WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut c = Client::new(&st, rand_ip());
    assert_eq!(c.login(&email, &pw).await.status, StatusCode::OK);
    let mut key = SoftKey::new();
    bind(&c, &mut key, "phone", true).await;

    let probe = Client::new(&st, rand_ip());
    let r = probe
        .post("/test/auth/login", login_body(&email, &pw))
        .await;
    assert_eq!(r.json()["code"], "auth.passkey_required");
    // No code request without the right password: the login's 401, no mail.
    let r = probe
        .post(
            "/test/auth/login/fallback/code",
            login_body(&email, "wrong-password-1"),
        )
        .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::UNAUTHORIZED, json!("auth.unauthorized"))
    );
    assert!(login_code(&db, &email).await.is_none());
    // Without a code the password alone is still refused.
    let r = probe
        .post("/test/auth/login", fallback_body(&email, &pw, "000000"))
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "no code was issued yet");

    let r = probe
        .post("/test/auth/login/fallback/code", login_body(&email, &pw))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let code = login_code(&db, &email).await.expect("the code mail");
    // A wrong code and a wrong password with the right code: 401.
    let wrong = if code == "999999" { "000000" } else { "999999" };
    let r = probe
        .post("/test/auth/login", fallback_body(&email, &pw, wrong))
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = probe
        .post(
            "/test/auth/login",
            fallback_body(&email, "wrong-password-1", &code),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // The right pair signs in once.
    let r = probe
        .post("/test/auth/login", fallback_body(&email, &pw, &code))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert!(r.headers.contains_key("set-cookie"));
    let r = probe
        .post("/test/auth/login", fallback_body(&email, &pw, &code))
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "single use");
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'user.login.passkey_fallback' \
         AND target_id = $1",
    )
    .bind(id.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(audited, 1);
    let notice = notices(&db, &email).await;
    let last = notice.last().expect("the security notice");
    assert!(last.contains("emailed code"), "{last}");
    assert!(last.contains(&probe.ip.to_string()), "{last}");
    assert!(!notice.iter().any(|n| n.contains(&code)));

    // Five wrong tries burn a fresh code.
    let r = probe
        .post("/test/auth/login/fallback/code", login_body(&email, &pw))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let code = login_code(&db, &email).await.unwrap();
    let wrong = if code == "999999" { "000000" } else { "999999" };
    for _ in 0..5 {
        let r = probe
            .post("/test/auth/login", fallback_body(&email, &pw, wrong))
            .await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    }
    let r = probe
        .post("/test/auth/login", fallback_body(&email, &pw, &code))
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "burnt after five tries");
    db.drop().await;
}

/// The code request only answers differently after a correct password:
/// an account whose password works needs no fallback; one without a
/// verified address (or with mail off) is pointed at the operator's reset.
#[tokio::test]
async fn fallback_code_is_refused_without_need_or_a_verified_address() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = state_with_domain(&db, RP).await;
    mail_on(&db).await;
    let pw = random_pw();
    let (id, email) = account(&db, "user", &pw).await;
    let probe = Client::new(&st, rand_ip());
    let r = probe
        .post("/test/auth/login/fallback/code", login_body(&email, &pw))
        .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("auth.fallback_unneeded"))
    );

    let mut c = Client::new(&st, rand_ip());
    assert_eq!(c.login(&email, &pw).await.status, StatusCode::OK);
    let mut key = SoftKey::new();
    bind(&c, &mut key, "phone", true).await;
    // Passkey-only, address not verified.
    let r = probe
        .post("/test/auth/login/fallback/code", login_body(&email, &pw))
        .await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (StatusCode::CONFLICT, json!("auth.fallback_unavailable"))
    );
    // Verified, but mail sending is off.
    sqlx::query("UPDATE users SET email_verified_at = now() WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE mail_settings SET enabled = false WHERE id = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = probe
        .post("/test/auth/login/fallback/code", login_body(&email, &pw))
        .await;
    assert_eq!(r.json()["code"], "auth.fallback_unavailable");
    let sent: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mail_outbox WHERE kind = 'login_code'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(sent, 0);
    db.drop().await;
}

/// An account without a password keeps its last passkey (audit auth P3-4):
/// deleting it would leave nothing to sign in with. With another passkey,
/// or a password, deleting is fine.
#[tokio::test]
async fn the_last_passkey_of_a_passwordless_account_stays() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let st = AppState::for_test(db.pool.clone()).await;
    let u = db.user().await;
    sqlx::query("UPDATE users SET password_hash = NULL WHERE id = $1")
        .bind(u)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut ids = Vec::new();
    for n in 0..2u8 {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO webauthn_credentials (user_id, rp_id, cred_id, passkey, name) \
             VALUES ($1, 'panel.example', $2, '{}'::jsonb, 'key') RETURNING id",
        )
        .bind(u)
        .bind(vec![n; 32])
        .fetch_one(&db.pool)
        .await
        .unwrap();
        ids.push(id);
    }
    let c = client_for(&st, u).await;
    let del = |id: Uuid| {
        let c = &c;
        async move {
            c.req(
                Method::DELETE,
                &format!("/test/api/v1/me/passkeys/{id}"),
                None,
            )
            .await
        }
    };
    assert_eq!(del(ids[0]).await.status, StatusCode::NO_CONTENT);
    let r = del(ids[1]).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{:?}", r.json());
    assert_eq!(r.json()["code"], "account.passkey_last");
    let left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM webauthn_credentials WHERE user_id = $1")
            .bind(u)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(left, 1);
    db.drop().await;
}
