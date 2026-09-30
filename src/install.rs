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
}

pub fn ensure(cfg: &PanelConfig) -> Result<Install> {
    fs::create_dir_all(&cfg.data_dir).context("create data dir")?;
    let route_prefix = ensure_state(&cfg.data_dir)?;
    let jwt_secret = ensure_jwt_key(&cfg.data_dir)?;
    let (ca_pem, ca_key_pem) = ensure_ca(&cfg.data_dir)?;
    // The server cert is ephemeral: regenerated at every boot so SAN changes
    // in config take effect without any certificate management.
    let (server_cert_pem, server_key_pem) =
        issue_server_cert(&ca_pem, &ca_key_pem, &cfg.web.advertised_names)?;
    Ok(Install {
        route_prefix,
        ca_pem,
        ca_key_pem,
        server_cert_pem,
        server_key_pem,
        jwt_secret,
    })
}

/// Session-signing secret (32 random bytes, hex). Stored next to the CA key
/// with 0600 permissions; rotating it invalidates all sessions.
fn ensure_jwt_key(data_dir: &Path) -> Result<String> {
    let path = data_dir.join("jwt.key");
    if path.exists() {
        let existing = fs::read_to_string(&path)?;
        if existing.trim().len() >= 64 {
            return Ok(existing.trim().to_string());
        }
    }
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    let secret = hex::encode(key);
    write_secret(&path, secret.as_bytes())?;
    Ok(secret)
}

fn ensure_state(data_dir: &Path) -> Result<String> {
    let path = data_dir.join("state.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(serde_json::from_str::<StateFile>(&s)?.route_prefix),
        Err(_) => {
            let mut b = [0u8; 12];
            rand::rng().fill_bytes(&mut b);
            let st = StateFile {
                route_prefix: hex::encode(b),
            };
            fs::write(&path, serde_json::to_vec_pretty(&st)?)?;
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

fn issue_server_cert(ca_pem: &str, ca_key_pem: &str, names: &[String]) -> Result<(String, String)> {
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

/// Issues the agent client certificate that identifies a node.
/// v1: the panel generates the key and writes it into the bootstrap file;
/// CSR-based enrollment (key never leaves the agent) is a planned upgrade.
pub fn issue_agent_cert(
    ca_pem: &str,
    ca_key_pem: &str,
    agent_id: &str,
) -> Result<(String, String, String)> {
    let mut serial_bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut serial_bytes);
    // Positive and minimal as a DER INTEGER (top byte 0x40..=0x7f): no
    // sign padding, no leading zero byte. `normalize_serial` would cope
    // either way; this keeps every representation identical.
    serial_bytes[0] = (serial_bytes[0] & 0x3f) | 0x40;
    issue_agent_cert_with_serial(ca_pem, ca_key_pem, agent_id, &serial_bytes)
}

/// Certificate serial as stored in nodes.cert_serial / revoked_certs and
/// looked up by identify_node: lowercase hex of the serial's magnitude
/// without leading zero bytes (what x509 parsers return as the integer).
/// Every producer and consumer of a serial string goes through this.
pub fn normalize_serial(bytes: &[u8]) -> String {
    let start = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len());
    hex::encode(&bytes[start..])
}

fn issue_agent_cert_with_serial(
    ca_pem: &str,
    ca_key_pem: &str,
    agent_id: &str,
    serial_bytes: &[u8],
) -> Result<(String, String, String)> {
    let key = KeyPair::generate()?;
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, format!("agent-{agent_id}"));
    params.distinguished_name = dn;
    params.serial_number = Some(SerialNumber::from_slice(serial_bytes));
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    params.not_before = OffsetDateTime::now_utc() - TimeDuration::hours(1);
    params.not_after = OffsetDateTime::now_utc() + TimeDuration::days(365 * 2);

    let issuer_key = KeyPair::from_pem(ca_key_pem)?;
    let issuer = Issuer::from_ca_cert_pem(ca_pem, issuer_key)?;
    let cert = params.signed_by(&key, &issuer)?;
    Ok((
        cert.pem(),
        key.serialize_pem(),
        normalize_serial(serial_bytes),
    ))
}

fn san(name: &str) -> Result<SanType> {
    match name.parse::<IpAddr>() {
        Ok(ip) => Ok(SanType::IpAddress(ip)),
        Err(_) => Ok(SanType::DnsName(name.try_into()?)),
    }
}

#[cfg(unix)]
fn write_secret(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::write(path, bytes)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_secret(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use x509_parser::prelude::{parse_x509_pem, FromDer, X509Certificate};

    fn test_ca() -> (String, String) {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
        let key_pem = key.serialize_pem();
        let ca = CertifiedIssuer::self_signed(params, key).unwrap();
        (ca.pem(), key_pem)
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
