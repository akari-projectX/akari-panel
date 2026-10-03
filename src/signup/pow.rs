//! W24: the built-in proof of work of registration WITHOUT email
//! verification. Invisible to people (the portal solves it in the
//! background, well under a second on a phone), it makes every scripted
//! registration attempt cost CPU — together with the per-address and
//! per-client rate limits. No third-party captcha (CSP `'self'`, no CDN).
//!
//! Challenge (stateless): `v1.<unix secs>.<16 random bytes hex>.<mac>`,
//! mac = first 16 bytes of HMAC-SHA256 (`totp::Keys::pow_mac`, key from
//! data/totp.key) over everything before it. A solution is a nonce (1–32
//! ASCII alphanumerics) such that SHA-256(challenge ‖ ":" ‖ nonce) starts
//! with `BITS` zero bits. Valid for `TTL_SECS`; single use (Valkey
//! `SET NX`, all instances; fail closed).

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Leading zero bits required in production (~2^18 hashes ≈ 0.1–1 s in a
/// browser, sub-second in the smoke's Python).
pub const PROD_BITS: u32 = 18;
/// What the endpoints require (unit tests of this crate use a cheaper
/// difficulty; `difficulty_counts_leading_bits` solves the real one).
pub const BITS: u32 = if cfg!(test) { 10 } else { PROD_BITS };
/// Challenge lifetime.
pub const TTL_SECS: i64 = 600;
const PREFIX: &str = "v1";

fn mac_hex(keys: &crate::totp::Keys, body: &str) -> String {
    hex::encode(&keys.pow_mac(body.as_bytes())[..16])
}

/// A fresh challenge issued at `now` (unix seconds).
pub fn issue(keys: &crate::totp::Keys, now: i64) -> String {
    let body = format!("{PREFIX}.{now}.{}", hex::encode(rand::random::<[u8; 16]>()));
    let mac = mac_hex(keys, &body);
    format!("{body}.{mac}")
}

/// Leading zero bits of a digest.
pub fn leading_zero_bits(d: &[u8]) -> u32 {
    let mut n = 0;
    for &b in d {
        if b == 0 {
            n += 8;
        } else {
            n += b.leading_zeros();
            break;
        }
    }
    n
}

/// Why a solution was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Malformed, forged or expired challenge, or a bad nonce.
    Invalid,
}

/// Check a solution (pure: no single-use check). `now` = unix seconds.
pub fn check(
    keys: &crate::totp::Keys,
    challenge: &str,
    nonce: &str,
    now: i64,
    bits: u32,
) -> Result<(), Refused> {
    if challenge.len() > 128
        || nonce.is_empty()
        || nonce.len() > 32
        || !nonce.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err(Refused::Invalid);
    }
    let Some((body, mac)) = challenge.rsplit_once('.') else {
        return Err(Refused::Invalid);
    };
    let want = mac_hex(keys, body);
    if !bool::from(want.as_bytes().ct_eq(mac.as_bytes())) {
        return Err(Refused::Invalid);
    }
    let mut parts = body.split('.');
    let (Some(PREFIX), Some(ts), Some(_), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Refused::Invalid);
    };
    let ts: i64 = ts.parse().map_err(|_| Refused::Invalid)?;
    if now < ts - 60 || now > ts + TTL_SECS {
        return Err(Refused::Invalid);
    }
    let d = Sha256::digest(format!("{challenge}:{nonce}").as_bytes());
    if leading_zero_bits(&d) < bits {
        return Err(Refused::Invalid);
    }
    Ok(())
}

/// Find a nonce (tests, smoke helpers): decimal counter.
pub fn solve(challenge: &str, bits: u32) -> String {
    (0u64..)
        .map(|i| i.to_string())
        .find(|n| leading_zero_bits(&Sha256::digest(format!("{challenge}:{n}").as_bytes())) >= bits)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> crate::totp::Keys {
        crate::totp::Keys::from_material(&[7; 32]).unwrap()
    }

    #[test]
    fn issue_solve_check() {
        let k = keys();
        let now = 1_800_000_000;
        let c = issue(&k, now);
        let n = solve(&c, 8);
        assert_eq!(check(&k, &c, &n, now, 8), Ok(()));
        assert_eq!(check(&k, &c, &n, now + TTL_SECS, 8), Ok(()));
        // Expired / from the future.
        assert!(check(&k, &c, &n, now + TTL_SECS + 1, 8).is_err());
        assert!(check(&k, &c, &n, now - 61, 8).is_err());
        // Another key, a forged mac, a tampered timestamp.
        let other = crate::totp::Keys::from_material(&[8; 32]).unwrap();
        assert!(check(&other, &c, &n, now, 8).is_err());
        let forged = format!("{}.{}", c.rsplit_once('.').unwrap().0, "00".repeat(16));
        assert!(check(&k, &forged, &n, now, 8).is_err());
        let tampered = c.replacen(&now.to_string(), &(now + 5).to_string(), 1);
        assert!(check(&k, &tampered, &n, now, 8).is_err());
        // Bad nonces.
        for bad in ["", "a b", "ä", &"1".repeat(33)] {
            assert!(check(&k, &c, bad, now, 8).is_err(), "{bad:?}");
        }
        assert!(check(&k, "garbage", "1", now, 0).is_err());
        assert!(check(&k, &"x".repeat(200), "1", now, 0).is_err());
    }

    #[test]
    fn difficulty_counts_leading_bits() {
        assert_eq!(leading_zero_bits(&[0, 0, 0x10]), 19);
        assert_eq!(leading_zero_bits(&[0x80]), 0);
        assert_eq!(leading_zero_bits(&[0, 1]), 15);
        assert_eq!(leading_zero_bits(&[0, 0]), 16);
        // A nonce for 8 bits rarely meets 18; one that meets 18 meets 8.
        let k = keys();
        let c = issue(&k, 100);
        let n = solve(&c, PROD_BITS);
        assert_eq!(check(&k, &c, &n, 100, PROD_BITS), Ok(()));
    }
}
