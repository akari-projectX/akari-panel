//! Second factor (M1-6): TOTP per RFC 6238 (HMAC-SHA-1, 6 digits, 30 s
//! steps, ±1 step accepted), single-use recovery codes, and the at-rest
//! protection of both.
//!
//! Key material: `data/totp.key` (32 random bytes, hex, 0600; see
//! install.rs). Two independent keys are derived from it with HMAC-SHA-256
//! and fixed labels: an AES-256-GCM key for the TOTP secrets (associated
//! data = user id, so a ciphertext moved to another account's row does not
//! open) and an HMAC key for recovery-code hashes. Losing the file makes
//! every enrolled secret unreadable: affected accounts are recovered with
//! `akari admin reset-2fa <login>`.
//!
//! Replay protection lives in the database (`user_totp.last_step`, a
//! conditional UPDATE), never in process memory, so it holds across panel
//! instances. Time comes from the database clock for the same reason.

use data_encoding::BASE32_NOPAD;
use rand::RngCore;
use ring::{aead, hmac};
use subtle::ConstantTimeEq;
use uuid::Uuid;

pub const STEP_SECS: i64 = 30;
/// Steps accepted on either side of the current one (clock skew, typing).
pub const WINDOW: i64 = 1;
const DIGITS_MOD: u32 = 1_000_000;
/// 160-bit secrets (RFC 4226 recommends ≥ 128, SHA-1 block-friendly 160).
pub const SECRET_BYTES: usize = 20;
pub const RECOVERY_CODES: usize = 10;
/// Recovery code length in base32 characters (60 bits).
const RECOVERY_LEN: usize = 12;
const RECOVERY_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
pub const ISSUER: &str = "Akari";

/// RFC 4226 HOTP value before the decimal reduction (dynamic truncation).
fn hotp_truncated(key: &[u8], counter: u64) -> u32 {
    let k = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, key);
    let tag = hmac::sign(&k, &counter.to_be_bytes());
    let h = tag.as_ref();
    // SHA-1: 20 bytes, so the offset (low nibble of the last byte) + 3 is
    // always in range.
    let off = usize::from(h[h.len() - 1] & 0x0f);
    u32::from_be_bytes([h[off] & 0x7f, h[off + 1], h[off + 2], h[off + 3]])
}

/// The 6-digit code for a time step.
pub fn code_at(key: &[u8], step: i64) -> String {
    format!(
        "{:06}",
        hotp_truncated(key, step.max(0) as u64) % DIGITS_MOD
    )
}

/// The time step containing a unix time.
pub fn step_of(unix_secs: i64) -> i64 {
    unix_secs.div_euclid(STEP_SECS)
}

/// The step a submitted code is valid for: within ±WINDOW of `now_step` and
/// strictly after `last_step` (already-used steps, and older ones, are
/// replays). All candidate steps are always computed and compared in
/// constant time; `None` for anything else, including malformed input.
pub fn verify(key: &[u8], code: &str, now_step: i64, last_step: Option<i64>) -> Option<i64> {
    let well_formed = code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit());
    let mut found = None;
    for step in (now_step - WINDOW)..=(now_step + WINDOW) {
        let expected = code_at(key, step);
        let eq: bool = expected.as_bytes().ct_eq(code.as_bytes()).into();
        let fresh = step >= 0 && last_step.is_none_or(|l| step > l);
        if eq && well_formed && fresh {
            found = Some(found.map_or(step, |f: i64| f.max(step)));
        }
    }
    found
}

/// A fresh random TOTP secret.
pub fn generate_secret() -> Vec<u8> {
    let mut s = vec![0u8; SECRET_BYTES];
    rand::rng().fill_bytes(&mut s);
    s
}

pub fn base32(secret: &[u8]) -> String {
    BASE32_NOPAD.encode(secret)
}

/// Percent-encoding for an otpauth label / query value (RFC 3986
/// unreserved characters pass through).
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Key URI for authenticator apps (Google Authenticator key-uri format).
pub fn otpauth_uri(login: &str, secret: &[u8]) -> String {
    format!(
        "otpauth://totp/{issuer}:{label}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits=6&period={STEP_SECS}",
        issuer = pct(ISSUER),
        label = pct(login),
        secret = base32(secret),
    )
}

/// Ten fresh recovery codes, formatted `xxxx-xxxx-xxxx` for display.
pub fn generate_recovery_codes() -> Vec<String> {
    (0..RECOVERY_CODES)
        .map(|_| {
            let mut bytes = [0u8; RECOVERY_LEN];
            rand::rng().fill_bytes(&mut bytes);
            // 256 is a multiple of 32: masking keeps the choice uniform.
            let chars: Vec<char> = bytes
                .iter()
                .map(|b| char::from(RECOVERY_ALPHABET[usize::from(b & 31)]))
                .collect();
            let s: String = chars.iter().collect();
            format!("{}-{}-{}", &s[0..4], &s[4..8], &s[8..12])
        })
        .collect()
}

/// Canonical form of a typed recovery code (case, dashes and spaces are
/// ignored); `None` if it cannot be one.
pub fn normalize_recovery(input: &str) -> Option<String> {
    let s: String = input
        .chars()
        .filter(|c| !matches!(c, '-' | ' '))
        .map(|c| c.to_ascii_lowercase())
        .collect();
    (s.len() == RECOVERY_LEN && s.bytes().all(|b| RECOVERY_ALPHABET.contains(&b))).then_some(s)
}

/// Keys derived from data/totp.key.
pub struct Keys {
    aead: aead::LessSafeKey,
    recovery: hmac::Key,
    /// W15: email verification codes (signup::codes).
    mail: hmac::Key,
    /// W20: subscription tokens at rest (`users.sub_token_enc`, AAD = user
    /// id). A key of its own: a token blob never opens as a TOTP secret or
    /// SMTP password and vice versa.
    sub: aead::LessSafeKey,
    /// W24/R40: payment method secrets at rest (`payment_methods.secrets_enc`,
    /// AAD = method id). A key of its own label.
    pay: aead::LessSafeKey,
    /// W24: registration proof-of-work challenges (stateless, HMAC-bound).
    pow: hmac::Key,
}

const SEAL_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;

impl Keys {
    pub fn from_material(material: &[u8]) -> anyhow::Result<Self> {
        if material.len() < 32 {
            anyhow::bail!("totp key material must be at least 32 bytes");
        }
        let root = hmac::Key::new(hmac::HMAC_SHA256, material);
        let enc = hmac::sign(&root, b"akari/totp-secret-aead/v1");
        let rec = hmac::sign(&root, b"akari/recovery-code-hmac/v1");
        let mail = hmac::sign(&root, b"akari/mail-code-hmac/v1");
        let sub = hmac::sign(&root, b"akari/sub-token-aead/v1");
        let pay = hmac::sign(&root, b"akari/payment-secrets-aead/v1");
        let pow = hmac::sign(&root, b"akari/signup-pow-hmac/v1");
        let aead_key = |k: &[u8]| {
            aead::UnboundKey::new(&aead::AES_256_GCM, k)
                .map(aead::LessSafeKey::new)
                .map_err(|_| anyhow::anyhow!("totp aead key"))
        };
        Ok(Self {
            aead: aead_key(enc.as_ref())?,
            recovery: hmac::Key::new(hmac::HMAC_SHA256, rec.as_ref()),
            mail: hmac::Key::new(hmac::HMAC_SHA256, mail.as_ref()),
            sub: aead_key(sub.as_ref())?,
            pay: aead_key(pay.as_ref())?,
            pow: hmac::Key::new(hmac::HMAC_SHA256, pow.as_ref()),
        })
    }

    /// Encrypt a TOTP secret for `user` (random 96-bit nonce).
    pub fn seal(&self, user: Uuid, secret: &[u8]) -> anyhow::Result<Vec<u8>> {
        seal_with(&self.aead, user, secret)
    }

    /// Decrypt a sealed secret; `None` if it is not `user`'s or was altered
    /// (or the key file changed).
    pub fn open(&self, user: Uuid, blob: &[u8]) -> Option<Vec<u8>> {
        open_with(&self.aead, user, blob)
    }

    /// W20: the stored form of `user`'s subscription token
    /// (`users.sub_token_enc`; same layout as `seal`, own key).
    pub fn seal_sub_token(&self, user: Uuid, token: &str) -> anyhow::Result<Vec<u8>> {
        seal_with(&self.sub, user, token.as_bytes())
    }

    /// W20: `user`'s subscription token from its stored form; `None` if the
    /// blob is not `user`'s, was altered, or data/totp.key changed.
    pub fn open_sub_token(&self, user: Uuid, blob: &[u8]) -> Option<String> {
        String::from_utf8(open_with(&self.sub, user, blob)?).ok()
    }

    /// R40: the stored form of a payment method's secrets (same layout as
    /// `seal`, own key, AAD = method id).
    pub fn seal_payment_secrets(&self, method: Uuid, plain: &[u8]) -> anyhow::Result<Vec<u8>> {
        seal_with(&self.pay, method, plain)
    }

    /// R40: a payment method's secrets; `None` if the blob is not this
    /// method's, was altered, or data/totp.key changed.
    pub fn open_payment_secrets(&self, method: Uuid, blob: &[u8]) -> Option<Vec<u8>> {
        open_with(&self.pay, method, blob)
    }

    /// W24: MAC of a registration proof-of-work challenge.
    pub fn pow_mac(&self, challenge: &[u8]) -> [u8; 32] {
        let tag = hmac::sign(&self.pow, challenge);
        let mut out = [0u8; 32];
        out.copy_from_slice(tag.as_ref());
        out
    }

    /// Stored form of an email verification code (W15): HMAC over the
    /// purpose, subject and address it was issued for, so a database dump
    /// does not reveal codes (a 6-digit space is trivial to search without
    /// the key) and a code cannot be moved between purposes or addresses.
    pub fn mail_code_hash(&self, purpose: &str, subject: &str, email: &str, code: &str) -> String {
        let mut ctx = hmac::Context::with_key(&self.mail);
        for part in [purpose, subject, email, code] {
            ctx.update(&(part.len() as u64).to_be_bytes());
            ctx.update(part.as_bytes());
        }
        hex::encode(ctx.sign().as_ref())
    }

    /// Stored form of a (normalized) recovery code.
    pub fn recovery_hash(&self, user: Uuid, normalized: &str) -> String {
        let mut ctx = hmac::Context::with_key(&self.recovery);
        ctx.update(user.as_bytes());
        ctx.update(normalized.as_bytes());
        hex::encode(ctx.sign().as_ref())
    }
}

/// `0x01 ‖ nonce ‖ AES-256-GCM(plaintext)` with AAD = user id (random
/// 96-bit nonce).
fn seal_with(key: &aead::LessSafeKey, user: Uuid, plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce);
    let mut buf = plaintext.to_vec();
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(user.as_bytes()),
        &mut buf,
    )
    .map_err(|_| anyhow::anyhow!("encryption failed"))?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + buf.len());
    out.push(SEAL_VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    Ok(out)
}

fn open_with(key: &aead::LessSafeKey, user: Uuid, blob: &[u8]) -> Option<Vec<u8>> {
    let (&version, rest) = blob.split_first()?;
    if version != SEAL_VERSION || rest.len() < NONCE_LEN {
        return None;
    }
    let (nonce, ct) = rest.split_at(NONCE_LEN);
    let nonce = aead::Nonce::try_assume_unique_for_key(nonce).ok()?;
    let mut buf = ct.to_vec();
    let pt = key
        .open_in_place(nonce, aead::Aad::from(user.as_bytes()), &mut buf)
        .ok()?;
    Some(pt.to_vec())
}

/// A verified second factor, still to be committed (replay-checked
/// UPDATE in the login transaction).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Proof {
    /// TOTP code valid for this step.
    Totp(i64),
    /// Unused recovery code with this stored hash.
    Recovery(String),
}

impl Proof {
    pub fn method(&self) -> &'static str {
        match self {
            Proof::Totp(_) => "totp",
            Proof::Recovery(_) => "recovery_code",
        }
    }
}

/// Fixed key used when an account has no (readable) secret, so the work
/// done for a login does not depend on the account's 2FA state.
const DUMMY_KEY: [u8; SECRET_BYTES] = [0x5a; SECRET_BYTES];

/// Check a submitted code against an account's enrolled factor: a 6-digit
/// TOTP code (not a replay) or one of its unused recovery codes. Does the
/// same work whether or not a secret is present.
pub fn check(
    keys: &Keys,
    user: Uuid,
    secret_enc: Option<&[u8]>,
    last_step: Option<i64>,
    unused_recovery: &[String],
    code: &str,
    now_step: i64,
) -> Option<Proof> {
    let secret = secret_enc.and_then(|b| keys.open(user, b));
    let key = secret.as_deref().unwrap_or(&DUMMY_KEY);
    let totp = verify(key, code.trim(), now_step, last_step);
    let candidate = normalize_recovery(code).unwrap_or_default();
    let want = keys.recovery_hash(user, &candidate);
    let mut recovery = None;
    for h in unused_recovery {
        if bool::from(h.as_bytes().ct_eq(want.as_bytes())) {
            recovery = Some(h.clone());
        }
    }
    secret.as_ref()?;
    match (totp, recovery) {
        (Some(step), _) => Some(Proof::Totp(step)),
        (None, Some(h)) if !candidate.is_empty() => Some(Proof::Recovery(h)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC_KEY: &[u8] = b"12345678901234567890";

    /// RFC 6238 Appendix B (SHA-1 column), 8-digit values; our 6-digit codes
    /// are the same truncation mod 10^6.
    #[test]
    fn rfc6238_vectors() {
        for (t, eight) in [
            (59i64, 94287082u32),
            (1111111109, 7081804),
            (1111111111, 14050471),
            (1234567890, 89005924),
            (2000000000, 69279037),
            (20000000000, 65353130),
        ] {
            let step = step_of(t);
            assert_eq!(
                hotp_truncated(RFC_KEY, step as u64) % 100_000_000,
                eight,
                "t={t}"
            );
            assert_eq!(code_at(RFC_KEY, step), format!("{:06}", eight % 1_000_000));
        }
        // RFC 4226 Appendix D HOTP values (counter 0..2).
        assert_eq!(code_at(RFC_KEY, 0), "755224");
        assert_eq!(code_at(RFC_KEY, 1), "287082");
        assert_eq!(code_at(RFC_KEY, 2), "359152");
    }

    #[test]
    fn window_is_plus_minus_one_step() {
        let now = step_of(1_700_000_000);
        for d in -1..=1 {
            let c = code_at(RFC_KEY, now + d);
            assert_eq!(verify(RFC_KEY, &c, now, None), Some(now + d), "d={d}");
        }
        for d in [-3, -2, 2, 3] {
            let c = code_at(RFC_KEY, now + d);
            // A collision with a window code would make this flaky; these
            // particular steps do not collide.
            assert_eq!(verify(RFC_KEY, &c, now, None), None, "d={d}");
        }
    }

    #[test]
    fn replays_and_older_steps_rejected() {
        let now = step_of(1_700_000_000);
        let c = code_at(RFC_KEY, now);
        assert_eq!(verify(RFC_KEY, &c, now, Some(now - 1)), Some(now));
        assert_eq!(verify(RFC_KEY, &c, now, Some(now)), None, "same step");
        let prev = code_at(RFC_KEY, now - 1);
        assert_eq!(verify(RFC_KEY, &prev, now, Some(now)), None, "older step");
        let next = code_at(RFC_KEY, now + 1);
        assert_eq!(verify(RFC_KEY, &next, now, Some(now)), Some(now + 1));
    }

    #[test]
    fn malformed_codes_rejected() {
        let now = step_of(1_700_000_000);
        let c = code_at(RFC_KEY, now);
        for bad in ["", "12345", "1234567", "abcdef", " 12345", &format!("{c}0")] {
            assert_eq!(verify(RFC_KEY, bad, now, None), None, "{bad:?}");
        }
    }

    #[test]
    fn seal_open_binds_user_and_detects_tampering() {
        let keys = Keys::from_material(&[7u8; 32]).unwrap();
        let (u, v) = (Uuid::new_v4(), Uuid::new_v4());
        let secret = generate_secret();
        let blob = keys.seal(u, &secret).unwrap();
        assert_eq!(keys.open(u, &blob).as_deref(), Some(secret.as_slice()));
        assert!(!blob.windows(secret.len()).any(|w| w == secret.as_slice()));
        assert_eq!(keys.open(v, &blob), None, "other user's row");
        let mut bad = blob.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert_eq!(keys.open(u, &bad), None, "tampered");
        assert_eq!(keys.open(u, &blob[..5]), None, "truncated");
        let other = Keys::from_material(&[8u8; 32]).unwrap();
        assert_eq!(other.open(u, &blob), None, "other key file");
        assert!(Keys::from_material(&[1u8; 16]).is_err());
        assert_ne!(keys.seal(u, &secret).unwrap(), blob, "fresh nonce");
    }

    /// W20: subscription tokens use their own derived key: user-bound,
    /// tamper-evident, and never interchangeable with TOTP/SMTP blobs.
    #[test]
    fn sub_token_seal_is_separate_and_user_bound() {
        let keys = Keys::from_material(&[7u8; 32]).unwrap();
        let (u, v) = (Uuid::new_v4(), Uuid::new_v4());
        let token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
        let blob = keys.seal_sub_token(u, token).unwrap();
        assert_eq!(keys.open_sub_token(u, &blob).as_deref(), Some(token));
        assert!(!blob.windows(token.len()).any(|w| w == token.as_bytes()));
        assert_eq!(keys.open_sub_token(v, &blob), None, "other user's row");
        assert_eq!(keys.open(u, &blob), None, "not a TOTP blob");
        let totp = keys.seal(u, token.as_bytes()).unwrap();
        assert_eq!(
            keys.open_sub_token(u, &totp),
            None,
            "TOTP blob is not a token"
        );
        let mut bad = blob.clone();
        bad[5] ^= 1;
        assert_eq!(keys.open_sub_token(u, &bad), None, "tampered");
        let other = Keys::from_material(&[8u8; 32]).unwrap();
        assert_eq!(other.open_sub_token(u, &blob), None, "other key file");
    }

    #[test]
    fn recovery_codes_format_and_hash() {
        let codes = generate_recovery_codes();
        assert_eq!(codes.len(), RECOVERY_CODES);
        let uniq: std::collections::HashSet<_> = codes.iter().collect();
        assert_eq!(uniq.len(), RECOVERY_CODES);
        for c in &codes {
            assert_eq!(c.len(), 14);
            let n = normalize_recovery(c).unwrap();
            assert_eq!(
                normalize_recovery(&c.to_uppercase().replace('-', " ")),
                Some(n)
            );
        }
        assert_eq!(normalize_recovery("123456"), None);
        assert_eq!(
            normalize_recovery("abcd-efgh-ijk1"),
            None,
            "1 not in alphabet"
        );
        let keys = Keys::from_material(&[7u8; 32]).unwrap();
        let u = Uuid::new_v4();
        let h = keys.recovery_hash(u, "abcdefghijkl");
        assert_eq!(h.len(), 64);
        assert_ne!(h, keys.recovery_hash(Uuid::new_v4(), "abcdefghijkl"));
    }

    #[test]
    fn check_accepts_totp_or_unused_recovery_only_with_a_secret() {
        let keys = Keys::from_material(&[7u8; 32]).unwrap();
        let u = Uuid::new_v4();
        let secret = generate_secret();
        let blob = keys.seal(u, &secret).unwrap();
        let now = step_of(1_700_000_000);
        let codes = generate_recovery_codes();
        let hashes: Vec<String> = codes
            .iter()
            .map(|c| keys.recovery_hash(u, &normalize_recovery(c).unwrap()))
            .collect();
        let code = code_at(&secret, now);
        assert_eq!(
            check(&keys, u, Some(&blob), None, &hashes, &code, now),
            Some(Proof::Totp(now))
        );
        assert_eq!(
            check(&keys, u, Some(&blob), Some(now), &hashes, &code, now),
            None,
            "replay"
        );
        assert_eq!(
            check(&keys, u, Some(&blob), None, &hashes, &codes[3], now),
            Some(Proof::Recovery(hashes[3].clone()))
        );
        assert_eq!(
            check(&keys, u, Some(&blob), None, &hashes[..3], &codes[3], now),
            None,
            "used code no longer listed"
        );
        assert_eq!(check(&keys, u, None, None, &hashes, &code, now), None);
        assert_eq!(
            check(&keys, u, Some(&blob), None, &hashes, "", now),
            None,
            "empty"
        );
        // Dummy key: no secret means nothing verifies, even its own codes.
        let dummy_code = code_at(&DUMMY_KEY, now);
        assert_eq!(check(&keys, u, None, None, &[], &dummy_code, now), None);
    }

    #[test]
    fn otpauth_uri_shape() {
        let uri = otpauth_uri("root admin", RFC_KEY);
        assert_eq!(
            uri,
            "otpauth://totp/Akari:root%20admin?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Akari&algorithm=SHA1&digits=6&period=30"
        );
    }
}
