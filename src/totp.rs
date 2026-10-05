//! The master key (`data/master.key`, v0.4 D7; `data/totp.key` before) and
//! the keys derived from it.
//!
//! Key material: 32 random bytes, hex, 0600 (install.rs `ensure_master_key`;
//! an install that still has only `totp.key` gets it renamed once). Every
//! key below is HMAC-SHA-256(material, label) with a fixed label. The labels
//! are part of the stored data's format: changing one makes everything
//! sealed under it unreadable, so they stay byte-identical even where the
//! name is historical (`akari/totp-secret-aead/v1` now seals the SMTP
//! password and the alert channel secrets; TOTP itself is gone).
//! `tests::derived_keys_are_unchanged` pins every one of them.
//!
//! (The module keeps its name and `AppState::totp()` its accessor name while
//! other v0.4 work that uses them is in flight; renaming both is a
//! mechanical follow-up.)

use rand::RngCore;
use ring::{aead, hmac};
use uuid::Uuid;

/// Keys derived from the master key.
pub struct Keys {
    /// Generic secrets at rest (label `akari/totp-secret-aead/v1`): the SMTP
    /// password (AAD `mail::SMTP_AAD`), the Telegram bot token and webhook
    /// secret (AADs in alerts/mod.rs).
    aead: aead::LessSafeKey,
    /// W15: email verification codes (signup::codes).
    mail: hmac::Key,
    /// W20: subscription tokens at rest (`users.sub_token_enc`, AAD = user
    /// id). A key of its own: a token blob never opens as a generic
    /// secret (SMTP password, …) and vice versa.
    sub: aead::LessSafeKey,
    /// W24/R40: payment method secrets at rest (`payment_methods.secrets_enc`,
    /// AAD = method id). A key of its own label.
    pay: aead::LessSafeKey,
    /// W24: registration proof-of-work challenges (stateless, HMAC-bound).
    pow: hmac::Key,
    /// v0.4 D1: public form tokens (`botguard`, minimum submit time).
    form: hmac::Key,
}

const SEAL_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;

impl Keys {
    pub fn from_material(material: &[u8]) -> anyhow::Result<Self> {
        if material.len() < 32 {
            anyhow::bail!("master key material must be at least 32 bytes");
        }
        let root = hmac::Key::new(hmac::HMAC_SHA256, material);
        let enc = hmac::sign(&root, b"akari/totp-secret-aead/v1");
        let mail = hmac::sign(&root, b"akari/mail-code-hmac/v1");
        let sub = hmac::sign(&root, b"akari/sub-token-aead/v1");
        let pay = hmac::sign(&root, b"akari/payment-secrets-aead/v1");
        let pow = hmac::sign(&root, b"akari/signup-pow-hmac/v1");
        let form = hmac::sign(&root, b"akari/form-token-hmac/v1");
        let aead_key = |k: &[u8]| {
            aead::UnboundKey::new(&aead::AES_256_GCM, k)
                .map(aead::LessSafeKey::new)
                .map_err(|_| anyhow::anyhow!("aead key"))
        };
        Ok(Self {
            aead: aead_key(enc.as_ref())?,
            mail: hmac::Key::new(hmac::HMAC_SHA256, mail.as_ref()),
            sub: aead_key(sub.as_ref())?,
            pay: aead_key(pay.as_ref())?,
            pow: hmac::Key::new(hmac::HMAC_SHA256, pow.as_ref()),
            form: hmac::Key::new(hmac::HMAC_SHA256, form.as_ref()),
        })
    }

    /// Encrypt a secret bound to `aad` (random 96-bit nonce).
    pub fn seal(&self, aad: Uuid, secret: &[u8]) -> anyhow::Result<Vec<u8>> {
        seal_with(&self.aead, aad, secret)
    }

    /// Decrypt a sealed secret; `None` if it is not bound to `aad` or was
    /// altered (or the master key changed).
    pub fn open(&self, aad: Uuid, blob: &[u8]) -> Option<Vec<u8>> {
        open_with(&self.aead, aad, blob)
    }

    /// W20: the stored form of `user`'s subscription token
    /// (`users.sub_token_enc`; same layout as `seal`, own key).
    pub fn seal_sub_token(&self, user: Uuid, token: &str) -> anyhow::Result<Vec<u8>> {
        seal_with(&self.sub, user, token.as_bytes())
    }

    /// W20: `user`'s subscription token from its stored form; `None` if the
    /// blob is not `user`'s, was altered, or the master key changed.
    pub fn open_sub_token(&self, user: Uuid, blob: &[u8]) -> Option<String> {
        String::from_utf8(open_with(&self.sub, user, blob)?).ok()
    }

    /// R40: the stored form of a payment method's secrets (same layout as
    /// `seal`, own key, AAD = method id).
    pub fn seal_payment_secrets(&self, method: Uuid, plain: &[u8]) -> anyhow::Result<Vec<u8>> {
        seal_with(&self.pay, method, plain)
    }

    /// R40: a payment method's secrets; `None` if the blob is not this
    /// method's, was altered, or the master key changed.
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

    /// v0.4 D1: MAC of a public form token (`botguard`).
    pub fn form_mac(&self, payload: &[u8]) -> [u8; 32] {
        let tag = hmac::sign(&self.form, payload);
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
}

/// `0x01 ‖ nonce ‖ AES-256-GCM(plaintext)` with AAD = a row id (random
/// 96-bit nonce).
fn seal_with(key: &aead::LessSafeKey, aad: Uuid, plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce);
    let mut buf = plaintext.to_vec();
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(aad.as_bytes()),
        &mut buf,
    )
    .map_err(|_| anyhow::anyhow!("encryption failed"))?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + buf.len());
    out.push(SEAL_VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    Ok(out)
}

fn open_with(key: &aead::LessSafeKey, aad: Uuid, blob: &[u8]) -> Option<Vec<u8>> {
    let (&version, rest) = blob.split_first()?;
    if version != SEAL_VERSION || rest.len() < NONCE_LEN {
        return None;
    }
    let (nonce, ct) = rest.split_at(NONCE_LEN);
    let nonce = aead::Nonce::try_assume_unique_for_key(nonce).ok()?;
    let mut buf = ct.to_vec();
    let pt = key
        .open_in_place(nonce, aead::Aad::from(aad.as_bytes()), &mut buf)
        .ok()?;
    Some(pt.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_keys() -> Keys {
        Keys::from_material(&(0u8..32).collect::<Vec<u8>>()).unwrap()
    }

    const AAD: Uuid = Uuid::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);

    /// D7 (v0.4): totp.key became master.key and TOTP went away; every key
    /// still in use must derive exactly as before, or data sealed by v0.3
    /// (SMTP password, alert channel secrets, subscription tokens, payment
    /// secrets) and outstanding mail codes / PoW challenges stop working.
    /// The vectors were produced by the pre-rename code (v0.3.2 totp.rs)
    /// from material 00..1f with a fixed nonce 09×12.
    #[test]
    fn derived_keys_are_unchanged() {
        let keys = fixed_keys();
        let blob = |h: &str| hex::decode(h).unwrap();
        // akari/totp-secret-aead/v1 (SMTP password, Telegram, webhook).
        assert_eq!(
            keys.open(
                AAD,
                &blob(
                    "0109090909090909090909090963a7b50f8894f6c5b498e422aa06b44a4511315e98cdd3e34b1dc4754d"
                )
            )
            .as_deref(),
            Some(&b"smtp-password"[..])
        );
        // akari/sub-token-aead/v1.
        assert_eq!(
            keys.open_sub_token(
                AAD,
                &blob(
                    "01090909090909090909090909c80601da310b5437b971fdf1406dc0d84f16b44913972a9b74"
                )
            )
            .as_deref(),
            Some("sub-token")
        );
        // akari/payment-secrets-aead/v1.
        assert_eq!(
            keys.open_payment_secrets(
                AAD,
                &blob("01090909090909090909090909fc3e94d0704f8439d2baad4df20a77da2157273e7ef7f7")
            )
            .as_deref(),
            Some(&b"{\"k\":1}"[..])
        );
        // akari/mail-code-hmac/v1.
        assert_eq!(
            keys.mail_code_hash("register", "a@b.c", "a@b.c", "123456"),
            "3406b75866c59e0051be4488f7e4ac9a55ee94b02c9becf86a32301a592b251d"
        );
        // akari/signup-pow-hmac/v1.
        assert_eq!(
            hex::encode(keys.pow_mac(b"challenge")),
            "aa9df01256e2651fee8b9e586bf1ca98fcdeee1c797b06b1a7cb85f601e8776b"
        );
        // akari/form-token-hmac/v1 (v0.4): pinned from its introduction.
        assert_eq!(
            hex::encode(keys.form_mac(b"form")),
            "535b240603c1c393a44ba5252f121038c4d665df5f13ab6c6ad30a628830baf1",
        );
    }

    #[test]
    fn seal_open_binds_aad_and_detects_tampering() {
        let keys = Keys::from_material(&[7u8; 32]).unwrap();
        let (u, v) = (Uuid::new_v4(), Uuid::new_v4());
        let secret = b"0123456789abcdefghij".to_vec();
        let blob = keys.seal(u, &secret).unwrap();
        assert_eq!(keys.open(u, &blob).as_deref(), Some(secret.as_slice()));
        assert!(!blob.windows(secret.len()).any(|w| w == secret.as_slice()));
        assert_eq!(keys.open(v, &blob), None, "other row");
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
    /// tamper-evident, and never interchangeable with generic secrets.
    #[test]
    fn sub_token_seal_is_separate_and_user_bound() {
        let keys = Keys::from_material(&[7u8; 32]).unwrap();
        let (u, v) = (Uuid::new_v4(), Uuid::new_v4());
        let token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
        let blob = keys.seal_sub_token(u, token).unwrap();
        assert_eq!(keys.open_sub_token(u, &blob).as_deref(), Some(token));
        assert!(!blob.windows(token.len()).any(|w| w == token.as_bytes()));
        assert_eq!(keys.open_sub_token(v, &blob), None, "other user's row");
        assert_eq!(keys.open(u, &blob), None, "not a generic secret");
        let generic = keys.seal(u, token.as_bytes()).unwrap();
        assert_eq!(
            keys.open_sub_token(u, &generic),
            None,
            "generic blob is not a token"
        );
        let mut bad = blob.clone();
        bad[5] ^= 1;
        assert_eq!(keys.open_sub_token(u, &bad), None, "tampered");
        let other = Keys::from_material(&[8u8; 32]).unwrap();
        assert_eq!(other.open_sub_token(u, &blob), None, "other key file");
    }
}
