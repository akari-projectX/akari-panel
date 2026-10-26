//! W26: security modules (manifest `[[security]]`): building TLS / REALITY
//! for the templates; the client-side REALITY fingerprint. Kernel-neutral.

use super::manifest;
use super::model::{Certificate, Fault, Reality, Security, Tls};

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

/// A name clients put in the TLS handshake: a DNS name, a leading `*`
/// label for a REALITY wildcard, or an IP literal (`hostname`).
fn valid_server_name(name: &str) -> bool {
    crate::hostname::is_host(name, crate::hostname::NameRules::SERVER_NAME)
}

/// REALITY short ids: 0-16 hex digits, an even number of them.
fn valid_short_id(id: &str) -> bool {
    id.len() <= 16 && id.len().is_multiple_of(2) && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// An x25519 public key as REALITY clients take it: 32 bytes, unpadded
/// base64url (43 characters).
fn valid_public_key(key: &str) -> bool {
    key.len() == 43
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}

/// The strings of the security layer that subscriptions copy into client
/// configurations. Absent or empty values are fine (clients fall back);
/// anything present must be plain (subscription injection, audit P2-1).
pub fn check(security: &Security) -> Result<(), Fault> {
    match security {
        Security::Tls(t) => {
            if t.server_name
                .as_deref()
                .is_some_and(|n| !n.is_empty() && !valid_server_name(n))
            {
                return Err(Fault::ServerName);
            }
        }
        Security::Reality(r) => {
            if r.server_names
                .iter()
                .flatten()
                .any(|n| !n.is_empty() && !valid_server_name(n))
            {
                return Err(Fault::ServerName);
            }
            if r.public_key
                .as_deref()
                .is_some_and(|k| !k.is_empty() && !valid_public_key(k))
            {
                return Err(Fault::RealityPublicKey);
            }
            if !r.short_ids.iter().all(|id| valid_short_id(id))
                || r.short_id.as_deref().is_some_and(|id| !valid_short_id(id))
            {
                return Err(Fault::RealityShortId);
            }
        }
        Security::None | Security::Other { .. } => {}
    }
    Ok(())
}
