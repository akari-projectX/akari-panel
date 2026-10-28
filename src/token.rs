//! How issued tokens are stored: only their SHA-256, never the token. One
//! definition for enrollment, install-link, password-reset and
//! subscription tokens (audit 2026-10, panel-core P3-6c).

use sha2::{Digest, Sha256};

/// SHA-256 of `token` as raw bytes (the `bytea` columns).
pub fn digest(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// SHA-256 of `token` as lower-case hex (the `text` columns).
pub fn digest_hex(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_and_bytes_are_the_same_digest() {
        assert_eq!(hex::encode(digest("abc")), digest_hex("abc"));
        assert_eq!(
            digest_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
