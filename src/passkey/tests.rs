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
