use std::{fs, net::IpAddr, path::Path};

use anyhow::{Context, Result};
use rand::RngCore;
use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType, SerialNumber,
};
use serde::{Deserialize, Serialize};
use time::{Duration as TimeDuration, OffsetDateTime};

use crate::config::PanelConfig;

#[derive(Serialize, Deserialize)]
struct StateFile {
    route_prefix: String,
}

/// Install-time material: secret route prefix, internal CA, server cert.
pub struct Install {
    pub route_prefix: String,
    pub ca_pem: String,
    pub ca_key_pem: String,
    pub server_cert_pem: String,
    pub server_key_pem: String,
    pub jwt_secret: String,
    /// Keys derived from data/master.key (secrets at rest, mail-code and PoW
    /// MACs; masterkey.rs).
    pub keys: crate::masterkey::Keys,
}

pub fn ensure(cfg: &PanelConfig) -> Result<Install> {
    fs::create_dir_all(&cfg.data_dir).context("create data dir")?;
    let route_prefix = ensure_state(&cfg.data_dir)?;
    let jwt_secret = ensure_jwt_key(&cfg.data_dir)?;
    let keys = crate::masterkey::Keys::from_material(&ensure_master_key(&cfg.data_dir)?)?;
    let (ca_pem, ca_key_pem) = ensure_ca(&cfg.data_dir)?;
    // The server cert is ephemeral: the boot one covers the built-in names;
    // `settings::reload` re-issues it for every recorded server name.
    let (server_cert_pem, server_key_pem) =
        issue_server_cert(&ca_pem, &ca_key_pem, &crate::settings::sans(&[], ""))?;
    Ok(Install {
        route_prefix,
        ca_pem,
        ca_key_pem,
        server_cert_pem,
        server_key_pem,
        jwt_secret,
        keys,
    })
}

/// Session-signing secret (32 random bytes, hex). Stored next to the CA key
/// with 0600 permissions; rotating it (`akari secrets rotate-jwt`)
/// invalidates all sessions.
fn ensure_jwt_key(data_dir: &Path) -> Result<String> {
    let path = data_dir.join("jwt.key");
    if path.exists() {
        let existing = fs::read_to_string(&path)?;
        if existing.trim().len() >= 64 {
            return Ok(existing.trim().to_string());
        }
    }
    let secret = random_hex(32);
    write_secret(&path, secret.as_bytes())?;
    Ok(secret)
}

/// File name of the master key (v0.4 D7).
pub const MASTER_KEY: &str = "master.key";
/// Its name before v0.4 (it was introduced for TOTP secrets).
pub const LEGACY_MASTER_KEY: &str = "totp.key";

/// The master key (32 random bytes, hex, 0600) every at-rest secret and
/// MAC key is derived from (masterkey.rs). Unlike jwt.key it is never
/// regenerated over a malformed file: that would silently make every sealed
/// secret (SMTP password, alert channels, payment methods, subscription
/// links) unreadable.
///
/// D7 rename: an install that still has only `totp.key` gets it renamed to
/// `master.key` (atomic, same directory) and keeps working with identical
/// derived keys. Both present: they must hold the same key (a restored
/// backup next to a renamed file); different keys refuse to start rather
/// than guess which one the database was sealed with.
fn ensure_master_key(data_dir: &Path) -> Result<Vec<u8>> {
    let path = data_dir.join(MASTER_KEY);
    let legacy = data_dir.join(LEGACY_MASTER_KEY);
    if path.exists() {
        let key = read_master_key(&path)?;
        if legacy.exists() {
            if read_master_key(&legacy)? != key {
                anyhow::bail!(
                    "{} and {} hold different keys; keep the one the database was \
                     sealed with (the other came from a different install) and remove the other",
                    path.display(),
                    legacy.display()
                );
            }
            tracing::warn!(
                "{} is a leftover copy of {}; it can be removed",
                legacy.display(),
                path.display()
            );
        }
        return Ok(key);
    }
    if legacy.exists() {
        let key = read_master_key(&legacy)?;
        fs::rename(&legacy, &path)
            .with_context(|| format!("rename {} to {}", legacy.display(), path.display()))?;
        #[cfg(unix)]
        if let Ok(d) = fs::File::open(data_dir) {
            let _ = d.sync_all();
        }
        tracing::info!("renamed {} to {}", legacy.display(), path.display());
        return Ok(key);
    }
    let secret = random_hex(32);
    write_secret(&path, secret.as_bytes())?;
    Ok(hex::decode(secret)?)
}

fn read_master_key(path: &Path) -> Result<Vec<u8>> {
    let existing = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    hex::decode(existing.trim())
        .ok()
        .filter(|k| k.len() == 32)
        .with_context(|| format!("{} is not 32 bytes of hex", path.display()))
}

fn random_hex(n: usize) -> String {
    let mut key = vec![0u8; n];
    rand::rng().fill_bytes(&mut key);
    hex::encode(key)
}

/// `akari secrets rotate-jwt`: a new jwt.key. Running panels keep the old
/// key until restarted; the caller also bumps every session_ver so existing
/// sessions die at once on every instance.
pub fn rotate_jwt_key(data_dir: &Path) -> Result<()> {
    fs::create_dir_all(data_dir).context("create data dir")?;
    write_secret(&data_dir.join("jwt.key"), random_hex(32).as_bytes())
}

fn new_prefix() -> String {
    random_hex(12)
}

fn ensure_state(data_dir: &Path) -> Result<String> {
    let path = data_dir.join("state.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(serde_json::from_str::<StateFile>(&s)?.route_prefix),
        Err(_) => {
            let st = StateFile {
                route_prefix: new_prefix(),
            };
            write_secret(&path, &serde_json::to_vec_pretty(&st)?)?;
            Ok(st.route_prefix)
        }
    }
}

fn ensure_ca(data_dir: &Path) -> Result<(String, String)> {
    let cert_path = data_dir.join("ca.pem");
    let key_path = data_dir.join("ca.key.pem");
    if cert_path.exists() && key_path.exists() {
        return Ok((
            fs::read_to_string(&cert_path)?,
            fs::read_to_string(&key_path)?,
        ));
    }

    let key = KeyPair::generate()?;
    let mut params = CertificateParams::default();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "Akari Internal CA");
    params.distinguished_name = dn;
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.not_before = OffsetDateTime::now_utc() - TimeDuration::hours(1);
    params.not_after = OffsetDateTime::now_utc() + TimeDuration::days(365 * 10);

    let ca_key_pem = key.serialize_pem();
    let ca = CertifiedIssuer::self_signed(params, key)?;
    let ca_pem = ca.pem();
    write_secret(&key_path, ca_key_pem.as_bytes())?;
    fs::write(&cert_path, &ca_pem)?;
    Ok((ca_pem, ca_key_pem))
}

/// The gRPC server certificate for `names` (IPs become IP SANs), signed
/// by the panel CA. Re-issued at boot and whenever the gRPC server name set
/// changes (settings.rs, R22).
pub fn issue_server_cert(
    ca_pem: &str,
    ca_key_pem: &str,
    names: &[String],
) -> Result<(String, String)> {
    let key = KeyPair::generate()?;
    let mut params = CertificateParams::default();
    params.subject_alt_names = names.iter().map(|n| san(n)).collect::<Result<Vec<_>>>()?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "akari");
    params.distinguished_name = dn;
    // Server identity only: an agent (or anyone holding this key) must not
    // be able to use it as a client certificate, and vice versa.
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before = OffsetDateTime::now_utc() - TimeDuration::hours(1);
    params.not_after = OffsetDateTime::now_utc() + TimeDuration::days(365 * 2);

    let issuer_key = KeyPair::from_pem(ca_key_pem)?;
    let issuer = Issuer::from_ca_cert_pem(ca_pem, issuer_key)?;
    let cert = params.signed_by(&key, &issuer)?;
    Ok((cert.pem(), key.serialize_pem()))
}

/// A fresh certificate serial: 16 random bytes, positive and minimal as a
/// DER INTEGER (top byte 0x40..=0x7f): no sign padding, no leading zero
/// byte. `normalize_serial` would cope either way; this keeps every
/// representation identical.
pub fn new_serial() -> [u8; 16] {
    let mut serial_bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut serial_bytes);
    serial_bytes[0] = (serial_bytes[0] & 0x3f) | 0x40;
    serial_bytes
}

/// Certificate serial as stored in nodes.cert_serial / revoked_certs and
/// looked up by identify_node: lowercase hex of the serial's magnitude
/// without leading zero bytes (what x509 parsers return as the integer).
/// Every producer and consumer of a serial string goes through this.
pub fn normalize_serial(bytes: &[u8]) -> String {
    let start = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len());
    hex::encode(&bytes[start..])
}

/// Why a CSR was refused (shown to the agent; carries no token
/// information).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CsrError {
    #[error("malformed certificate signing request")]
    Malformed,
    #[error("the key must be ECDSA P-256 signed with ecdsa-with-SHA256")]
    KeyType,
    #[error("the request must carry no attributes or extensions (no SANs)")]
    Attributes,
    #[error("the request's signature does not verify")]
    Signature,
}

/// Largest CSR accepted (a P-256 CSR is ~250 bytes).
pub const MAX_CSR_LEN: usize = 4096;

/// The public key of a checked CSR.
pub struct CsrKey(rcgen::PublicKey);

/// Strict CSR check (M1-8): DER PKCS#10, version 1, an ECDSA P-256 key,
/// signed with ecdsa-with-SHA256 by that key (proof of possession), and NO
/// attributes at all (no extensionRequest: no SANs, no key usages, no
/// challenge password). The subject is ignored: the panel decides every
/// field of the certificate.
///
/// P-256 (not Ed25519): supported for TLS 1.3 client authentication by
/// both rustls/webpki (panel) and Go crypto/tls (agent), by rcgen for
/// signing, and by hardware keystores (TPM 2.0, PKCS#11) should agent keys
/// move there.
pub fn check_csr(der: &[u8]) -> Result<CsrKey, CsrError> {
    use x509_parser::certification_request::X509CertificationRequest;
    use x509_parser::oid_registry::{
        OID_EC_P256, OID_KEY_TYPE_EC_PUBLIC_KEY, OID_SIG_ECDSA_WITH_SHA256,
    };
    use x509_parser::prelude::FromDer;
    if der.is_empty() || der.len() > MAX_CSR_LEN {
        return Err(CsrError::Malformed);
    }
    let (rest, csr) = X509CertificationRequest::from_der(der).map_err(|_| CsrError::Malformed)?;
    if !rest.is_empty() {
        return Err(CsrError::Malformed);
    }
    let info = &csr.certification_request_info;
    if info.version.0 != 0 {
        return Err(CsrError::Malformed);
    }
    let spki = &info.subject_pki;
    let curve = spki
        .algorithm
        .parameters
        .as_ref()
        .and_then(|p| p.as_oid().ok());
    if spki.algorithm.algorithm != OID_KEY_TYPE_EC_PUBLIC_KEY
        || curve.as_ref() != Some(&OID_EC_P256)
        || csr.signature_algorithm.algorithm != OID_SIG_ECDSA_WITH_SHA256
        // Uncompressed point: 0x04 || X || Y.
        || spki.subject_public_key.data.len() != 65
        || spki.subject_public_key.data.first() != Some(&0x04)
    {
        return Err(CsrError::KeyType);
    }
    if !info.attributes().is_empty() {
        return Err(CsrError::Attributes);
    }
    csr.verify_signature().map_err(|_| CsrError::Signature)?;
    // rcgen re-verifies and extracts the key in the form it signs with.
    let parsed =
        rcgen::CertificateSigningRequestParams::from_der(&der.into()).map_err(|e| match e {
            rcgen::Error::InvalidCertificationRequestSignature => CsrError::Signature,
            _ => CsrError::Malformed,
        })?;
    if parsed.public_key.algorithm() != &rcgen::PKCS_ECDSA_P256_SHA256 {
        return Err(CsrError::KeyType);
    }
    Ok(CsrKey(parsed.public_key))
}

/// A certificate issued to a node.
#[derive(Debug, Clone)]
pub struct IssuedCert {
    pub cert_pem: String,
    /// Normalized (`normalize_serial`).
    pub serial: String,
    pub not_after: chrono::DateTime<chrono::Utc>,
}

/// How far back not_before is set (clock skew between panel and node):
/// 5 minutes, at most a quarter of the validity (short test validities).
fn backdate(validity_secs: u64) -> TimeDuration {
    TimeDuration::seconds((validity_secs / 4).min(300) as i64)
}

/// Sign a node's client certificate for a checked CSR key: subject
/// CN=agent-<node id>, ClientAuth only, a fresh serial, valid for
/// `validity_secs` from now.
pub fn sign_agent_csr(
    ca_pem: &str,
    ca_key_pem: &str,
    node_id: &str,
    key: &CsrKey,
    validity_secs: u64,
) -> Result<IssuedCert> {
    sign_agent_key(
        ca_pem,
        ca_key_pem,
        node_id,
        &key.0,
        &new_serial(),
        validity_secs,
    )
}

fn agent_params(node_id: &str, serial_bytes: &[u8], validity_secs: u64) -> CertificateParams {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, format!("agent-{node_id}"));
    params.distinguished_name = dn;
    params.serial_number = Some(SerialNumber::from_slice(serial_bytes));
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    let now = OffsetDateTime::now_utc();
    params.not_before = now - backdate(validity_secs);
    params.not_after = now + TimeDuration::seconds(validity_secs.min(i64::MAX as u64) as i64);
    params
}

fn sign_agent_key(
    ca_pem: &str,
    ca_key_pem: &str,
    node_id: &str,
    key: &impl rcgen::PublicKeyData,
    serial_bytes: &[u8],
    validity_secs: u64,
) -> Result<IssuedCert> {
    let params = agent_params(node_id, serial_bytes, validity_secs);
    let not_after = chrono::DateTime::from_timestamp(params.not_after.unix_timestamp(), 0)
        .context("certificate expiry out of range")?;
    let issuer_key = KeyPair::from_pem(ca_key_pem)?;
    let issuer = Issuer::from_ca_cert_pem(ca_pem, issuer_key)?;
    let cert = params.signed_by(key, &issuer)?;
    Ok(IssuedCert {
        cert_pem: cert.pem(),
        serial: normalize_serial(serial_bytes),
        not_after,
    })
}

/// Test helper: what a v1 (pre-M1c) `node add` did — the panel generated
/// the key. Returns (cert, key, serial).
#[cfg(test)]
pub fn issue_agent_cert(
    ca_pem: &str,
    ca_key_pem: &str,
    agent_id: &str,
) -> Result<(String, String, String)> {
    issue_agent_cert_with_serial(ca_pem, ca_key_pem, agent_id, &new_serial())
}

#[cfg(test)]
fn issue_agent_cert_with_serial(
    ca_pem: &str,
    ca_key_pem: &str,
    agent_id: &str,
    serial_bytes: &[u8],
) -> Result<(String, String, String)> {
    let key = KeyPair::generate()?;
    let c = sign_agent_key(
        ca_pem,
        ca_key_pem,
        agent_id,
        &key,
        serial_bytes,
        2 * 365 * 86400,
    )?;
    Ok((c.cert_pem, key.serialize_pem(), c.serial))
}

fn san(name: &str) -> Result<SanType> {
    match name.parse::<IpAddr>() {
        Ok(ip) => Ok(SanType::IpAddress(ip)),
        Err(_) => Ok(SanType::DnsName(name.try_into()?)),
    }
}

/// Write a secret file atomically: a fresh 0600 temp file in the same
/// directory (never readable by others, not even briefly), fsync, rename
/// over the target. A crash leaves the old or the new content, never a
/// truncated key.
pub(crate) fn write_secret(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .context("secret path has no file name")?;
    let tmp = dir.join(format!(".{name}.{}.tmp", random_hex(6)));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut f = opts
            .open(&tmp)
            .with_context(|| format!("create {}", tmp.display()))?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path).with_context(|| format!("replace {}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use x509_parser::prelude::{FromDer, X509Certificate, parse_x509_pem};

    fn test_ca() -> (String, String) {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
        let key_pem = key.serialize_pem();
        let ca = CertifiedIssuer::self_signed(params, key).unwrap();
        (ca.pem(), key_pem)
    }

    #[cfg(unix)]
    #[test]
    fn state_json_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("akari-state-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let prefix = ensure_state(&dir).unwrap();
        let mode = fs::metadata(dir.join("state.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(ensure_state(&dir).unwrap(), prefix);
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn secrets_are_0600_and_rotate() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("akari-secrets-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mode = |f: &str| fs::metadata(dir.join(f)).unwrap().permissions().mode() & 0o777;
        let jwt = ensure_jwt_key(&dir).unwrap();
        let master = ensure_master_key(&dir).unwrap();
        let prefix = ensure_state(&dir).unwrap();
        assert_eq!(
            (mode("jwt.key"), mode(MASTER_KEY), mode("state.json")),
            (0o600, 0o600, 0o600)
        );
        assert_eq!(master.len(), 32);
        assert_eq!(ensure_master_key(&dir).unwrap(), master, "stable");
        rotate_jwt_key(&dir).unwrap();
        let jwt2 = ensure_jwt_key(&dir).unwrap();
        assert_ne!(jwt, jwt2);
        assert_eq!(jwt2.len(), 64);
        assert_eq!(ensure_state(&dir).unwrap(), prefix, "stable");
        assert_eq!((mode("jwt.key"), mode("state.json")), (0o600, 0o600));
        // No temp files left behind.
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
        // A corrupt master key is an error, never silently replaced.
        fs::write(dir.join(MASTER_KEY), "junk").unwrap();
        assert!(ensure_master_key(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    /// D7: totp.key → master.key, once, keeping the key (and so every
    /// derived key) identical; conflicting copies refuse to start.
    #[cfg(unix)]
    #[test]
    fn legacy_totp_key_is_renamed_once() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("akari-master-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let hexkey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        write_secret(
            &dir.join(LEGACY_MASTER_KEY),
            format!("{hexkey}\n").as_bytes(),
        )
        .unwrap();
        let key = ensure_master_key(&dir).unwrap();
        assert_eq!(hex::encode(&key), hexkey);
        assert!(!dir.join(LEGACY_MASTER_KEY).exists(), "renamed, not copied");
        let mode = fs::metadata(dir.join(MASTER_KEY))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "permissions kept");
        assert_eq!(
            ensure_master_key(&dir).unwrap(),
            key,
            "stable after the rename"
        );
        // A leftover identical copy is tolerated…
        write_secret(&dir.join(LEGACY_MASTER_KEY), hexkey.as_bytes()).unwrap();
        assert_eq!(ensure_master_key(&dir).unwrap(), key);
        // …a different one is refused, and nothing is overwritten.
        let other = "ff".repeat(32);
        write_secret(&dir.join(LEGACY_MASTER_KEY), other.as_bytes()).unwrap();
        assert!(ensure_master_key(&dir).is_err());
        assert_eq!(
            fs::read_to_string(dir.join(LEGACY_MASTER_KEY)).unwrap(),
            other,
            "untouched"
        );
        assert_eq!(read_master_key(&dir.join(MASTER_KEY)).unwrap(), key);
        // A corrupt legacy file is not renamed.
        fs::remove_file(dir.join(MASTER_KEY)).unwrap();
        fs::write(dir.join(LEGACY_MASTER_KEY), "junk").unwrap();
        assert!(ensure_master_key(&dir).is_err());
        assert!(!dir.join(MASTER_KEY).exists());
        fs::remove_dir_all(&dir).ok();
    }

    /// (server_auth, client_auth, any)
    fn eku(pem: &str) -> (bool, bool, bool) {
        let (_, p) = parse_x509_pem(pem.as_bytes()).unwrap();
        let (_, cert) = X509Certificate::from_der(&p.contents).unwrap();
        let e = cert.extended_key_usage().unwrap().unwrap().value;
        (e.server_auth, e.client_auth, e.any)
    }

    /// R8: the server certificate is ServerAuth only; agent certificates are
    /// ClientAuth only.
    #[test]
    fn certificate_ekus_are_exclusive() {
        let (ca, ca_key) = test_ca();
        let (server, _) = issue_server_cert(&ca, &ca_key, &["localhost".into()]).unwrap();
        assert_eq!(eku(&server), (true, false, false));
        let (agent, _, _) = issue_agent_cert(&ca, &ca_key, "n1").unwrap();
        assert_eq!(eku(&agent), (false, true, false));
    }

    fn csr(key: &KeyPair, f: impl FnOnce(&mut CertificateParams)) -> Vec<u8> {
        let mut params = CertificateParams::default();
        f(&mut params);
        params.serialize_request(key).unwrap().der().to_vec()
    }

    /// M1-8: only a plain P-256 CSR signed by its own key is accepted; the
    /// panel decides the certificate (CN, EKU, serial, validity).
    #[test]
    fn csr_rules() {
        let (ca, ca_key) = test_ca();
        let key = KeyPair::generate().unwrap(); // P-256
        let good = csr(&key, |p| {
            p.distinguished_name.push(DnType::CommonName, "agent-evil")
        });
        let k = check_csr(&good).unwrap();
        let issued = sign_agent_csr(&ca, &ca_key, "n1", &k, 90 * 86400).unwrap();
        let (_, pem) = parse_x509_pem(issued.cert_pem.as_bytes()).unwrap();
        let (_, cert) = X509Certificate::from_der(&pem.contents).unwrap();
        assert_eq!(
            cert.subject()
                .iter_common_name()
                .next()
                .unwrap()
                .as_str()
                .unwrap(),
            "agent-n1",
            "the CSR's subject is ignored"
        );
        assert_eq!(eku(&issued.cert_pem), (false, true, false));
        assert!(cert.subject_alternative_name().unwrap().is_none());
        assert_eq!(parsed_serial(&issued.cert_pem), issued.serial);
        let top = u8::from_str_radix(&issued.serial[..2], 16).unwrap();
        assert!((0x40..=0x7f).contains(&top));
        assert_eq!(
            cert.public_key().raw,
            x509_parser::certification_request::X509CertificationRequest::from_der(&good)
                .unwrap()
                .1
                .certification_request_info
                .subject_pki
                .raw,
            "the certificate carries the CSR's key"
        );
        let life = cert.validity().not_after.timestamp() - chrono::Utc::now().timestamp();
        assert!((90 * 86400 - 60..=90 * 86400).contains(&life), "{life}");
        assert_eq!(
            issued.not_after.timestamp(),
            cert.validity().not_after.timestamp()
        );

        // SANs / any extension request: refused.
        let sans = csr(&key, |p| {
            p.subject_alt_names = vec![SanType::DnsName("evil.example".try_into().unwrap())]
        });
        assert_eq!(check_csr(&sans).err(), Some(CsrError::Attributes));
        let ku = csr(&key, |p| p.key_usages = vec![KeyUsagePurpose::KeyCertSign]);
        assert_eq!(check_csr(&ku).err(), Some(CsrError::Attributes));
        let ca_req = csr(&key, |p| {
            p.is_ca = IsCa::Ca(BasicConstraints::Unconstrained)
        });
        assert_eq!(check_csr(&ca_req).err(), Some(CsrError::Attributes));
        // Other key types: refused.
        for alg in [&rcgen::PKCS_ED25519, &rcgen::PKCS_ECDSA_P384_SHA384] {
            let other = KeyPair::generate_for(alg).unwrap();
            assert_eq!(
                check_csr(&csr(&other, |_| {})).err(),
                Some(CsrError::KeyType)
            );
        }
        // Broken signature (possession not proven), garbage, trailing data.
        let mut bad_sig = good.clone();
        let n = bad_sig.len();
        bad_sig[n - 5] ^= 0x01;
        assert!(check_csr(&bad_sig).is_err());
        assert_eq!(check_csr(b"junk").err(), Some(CsrError::Malformed));
        assert_eq!(check_csr(&[]).err(), Some(CsrError::Malformed));
        let mut trailing = good.clone();
        trailing.push(0);
        assert_eq!(check_csr(&trailing).err(), Some(CsrError::Malformed));
        assert_eq!(
            check_csr(&vec![0u8; MAX_CSR_LEN + 1]).err(),
            Some(CsrError::Malformed)
        );
    }

    /// Short validities (tests, smoke) are backdated proportionally.
    #[test]
    fn short_validity_backdate() {
        assert_eq!(backdate(90 * 86400), TimeDuration::seconds(300));
        assert_eq!(backdate(60), TimeDuration::seconds(15));
    }

    fn parsed_serial(pem: &str) -> String {
        let (_, p) = parse_x509_pem(pem.as_bytes()).unwrap();
        let (_, cert) = X509Certificate::from_der(&p.contents).unwrap();
        // Both views the identify path could use agree after normalization.
        assert_eq!(
            normalize_serial(cert.raw_serial()),
            normalize_serial(&cert.serial.to_bytes_be())
        );
        normalize_serial(cert.raw_serial())
    }

    /// R12 P2: the stored serial is what identification computes from the
    /// presented certificate, including serials with a leading zero byte
    /// (1/256 of the old random serials) and a set top bit.
    #[test]
    fn stored_serial_matches_identified_serial() {
        let (ca, ca_key) = test_ca();
        let mut leading_zero = [0x5au8; 16];
        leading_zero[0] = 0;
        let mut high_bit = [0x11u8; 16];
        high_bit[0] = 0x80;
        for bytes in [leading_zero, high_bit, [0x42u8; 16]] {
            let (pem, _, stored) = issue_agent_cert_with_serial(&ca, &ca_key, "n", &bytes).unwrap();
            assert_eq!(parsed_serial(&pem), stored, "{bytes:02x?}");
        }
        assert_eq!(normalize_serial(&[0, 0, 0xab, 0]), "ab00");
        for _ in 0..64 {
            let (pem, _, stored) = issue_agent_cert(&ca, &ca_key, "n").unwrap();
            assert_eq!(stored.len(), 32, "fresh serials are 16 significant bytes");
            assert_eq!(parsed_serial(&pem), stored);
        }
    }
}
