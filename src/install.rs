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
    let key = KeyPair::generate()?;
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, format!("agent-{agent_id}"));
    params.distinguished_name = dn;
    let mut serial_bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut serial_bytes);
    params.serial_number = Some(SerialNumber::from_slice(&serial_bytes));
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    params.not_before = OffsetDateTime::now_utc() - TimeDuration::hours(1);
    params.not_after = OffsetDateTime::now_utc() + TimeDuration::days(365 * 2);

    let issuer_key = KeyPair::from_pem(ca_key_pem)?;
    let issuer = Issuer::from_ca_cert_pem(ca_pem, issuer_key)?;
    let cert = params.signed_by(&key, &issuer)?;
    Ok((cert.pem(), key.serialize_pem(), hex::encode(serial_bytes)))
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
