//! W26: security modules (manifest `[[security]]`): building TLS / REALITY
//! for the templates; the client-side REALITY fingerprint. Kernel-neutral.

use super::manifest;
use super::model::{Certificate, Reality, Security, Tls};

/// uTLS fingerprints a client library accepts for REALITY (manifest
/// security `reality`, field `fingerprint`).
pub const FINGERPRINTS: [&str; 10] = manifest::SECURITY_REALITY_FINGERPRINT;

/// The fingerprint subscriptions use when the inbound names none (or one
/// not on the list): the manifest default.
pub fn default_fingerprint() -> &'static str {
    manifest::get()
        .security("reality")
        .and_then(|s| s.field.iter().find(|f| f.name == "fingerprint"))
        .and_then(|f| f.default.as_deref())
        .unwrap_or(FINGERPRINTS[0])
}

/// The inbound's fingerprint hint when it is on the list, else the default.
pub fn client_fingerprint(hint: Option<&str>) -> &'static str {
    match hint.and_then(|h| FINGERPRINTS.iter().find(|f| **f == h)) {
        Some(f) => f,
        None => default_fingerprint(),
    }
}

/// TLS with the node's certificate for `server_name`.
pub fn tls(server_name: &str, alpn: Vec<String>) -> Security {
    Security::Tls(Tls {
        server_name: Some(server_name.to_string()),
        alpn,
        certificate: Some(Certificate::Node),
    })
}

/// REALITY borrowing `dest` (host:port) for `sni`, with a server key pair
/// and one short id; the client side (public key, short id, fingerprint)
/// is kept for subscriptions.
pub fn reality(
    dest: String,
    sni: String,
    private_key: String,
    public_key: String,
    short_id: String,
    fingerprint: &str,
) -> Security {
    Security::Reality(Reality {
        dest: Some(dest),
        server_names: vec![Some(sni)],
        private_key: Some(private_key),
        short_ids: vec![short_id.clone()],
        public_key: Some(public_key),
        short_id: Some(short_id),
        fingerprint: Some(fingerprint.to_string()),
    })
}
