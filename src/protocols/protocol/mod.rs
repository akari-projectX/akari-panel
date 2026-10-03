//! W26: protocol modules (manifest `[[protocol]]`), one per managed
//! protocol, behind [`ProtocolModule`]: the protocol-stage checks of an
//! inbound, and the per-user account (generated from the manifest's
//! credential spec, refit when the inbound changes). Kernel-neutral: they
//! see the model (`model::Inbound`), never kernel JSON.
//!
//! Adding a protocol: a `[[protocol]]` in proto/protocols.toml, a module
//! here registered in `MODULES` (`modules_match_the_manifest`), the kernel
//! adapter's parse/render/explain arms (`xray.rs`), the subscription
//! renderers (`sub/`), and the agent's module (akari-agent `proto_*.go`).

mod hysteria2;
mod ss2022;
mod trojan;
mod vless;
mod vmess;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};

use super::manifest::{self, Protocol as Spec};
use super::model::{Fault, Inbound, Security};

pub trait ProtocolModule: Sync {
    /// Manifest protocol id.
    fn id(&self) -> &'static str;

    fn spec(&self) -> Option<&'static Spec> {
        manifest::get().protocol(self.id())
    }

    /// Protocol-stage checks (after the transport, combination and
    /// transport-field checks).
    fn check(&self, _ib: &Inbound) -> Result<(), Fault> {
        Ok(())
    }

    /// Issue credentials only for inbounds that pass validation (protocols
    /// whose stored hand-written form may predate the panel managing them).
    fn issue_only_when_valid(&self) -> bool {
        false
    }

    /// The value of an inbound option of this protocol ("" when unset).
    fn option(&self, _ib: &Inbound, _name: &str) -> String {
        String::new()
    }

    /// A new account for an inbound of this protocol.
    fn generate_account(&self, ib: &Inbound) -> Result<Value, String> {
        generate(self, ib).map_err(|e| e.to_string())
    }

    /// The account adjusted to its inbound, or None if it already fits.
    fn refit_account(&self, ib: &Inbound, account: &Value) -> Option<Value> {
        refit(self, ib, account)
    }
}

/// The registry, in manifest order.
pub static MODULES: [&dyn ProtocolModule; 5] = [
    &vless::Vless,
    &vmess::Vmess,
    &trojan::Trojan,
    &ss2022::Ss2022,
    &hysteria2::Hysteria2,
];

pub fn module(id: &str) -> Option<&'static dyn ProtocolModule> {
    MODULES.iter().copied().find(|m| m.id() == id)
}

/// The module of a model protocol; never one for an unmanaged protocol,
/// even one whose kernel name spells a manifest id ("ss2022").
pub fn module_for(p: &crate::protocols::model::Protocol) -> Option<&'static dyn ProtocolModule> {
    if p.is_managed() { module(p.id()) } else { None }
}

/// Why the manifest's credential spec could not produce an account.
#[derive(Debug)]
pub enum CredentialError {
    /// The option value carries no key length (e.g. a method without a
    /// multi-user form).
    NoKeyLen { option: String, value: String },
    /// The module has no manifest entry.
    NoSpec(&'static str),
}

impl std::fmt::Display for CredentialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CredentialError::NoKeyLen { option, value } => {
                write!(f, "{option} {value:?} has no key length")
            }
            CredentialError::NoSpec(id) => write!(f, "protocol {id} is not in the manifest"),
        }
    }
}

fn key_len(spec: &Spec, option: &str, value: &str) -> Option<usize> {
    spec.option(option)?.key_len_of(value)
}

/// An account from the manifest's credential spec (keys in manifest
/// order; serialized sorted). Randomness: `entropy`.
pub fn generate<M: ProtocolModule + ?Sized>(m: &M, ib: &Inbound) -> Result<Value, CredentialError> {
    let spec = m.spec().ok_or(CredentialError::NoSpec(m.id()))?;
    let mut acc = Map::new();
    for c in &spec.credential {
        let v = match c.kind.as_str() {
            "uuid" => crate::entropy::uuid_v4().to_string(),
            "hex" => hex::encode(crate::entropy::bytes(c.bytes.unwrap_or(32) as usize)),
            "base64_key" => {
                let from = c.key_len_from.as_deref().unwrap_or("");
                let value = m.option(ib, from);
                let n = key_len(spec, from, &value).ok_or(CredentialError::NoKeyLen {
                    option: from.to_string(),
                    value,
                })?;
                STANDARD.encode(crate::entropy::bytes(n))
            }
            // "option": the inbound's value
            _ => m.option(ib, c.from.as_deref().unwrap_or("")),
        };
        acc.insert(c.field.clone(), json!(v));
    }
    Ok(Value::Object(acc))
}

/// The account refit to its inbound per the manifest: `option` keys follow
/// the inbound; a `base64_key` of the wrong length (for the inbound's
/// option value) is replaced by a fresh account. None = it fits (or the
/// option value has no key length: nothing to fit to).
pub fn refit<M: ProtocolModule + ?Sized>(m: &M, ib: &Inbound, account: &Value) -> Option<Value> {
    let spec = m.spec()?;
    let mut out = account.clone();
    let mut changed = false;
    for c in &spec.credential {
        match c.kind.as_str() {
            "option" => {
                let want = m.option(ib, c.from.as_deref().unwrap_or(""));
                let have = account.get(&c.field).and_then(Value::as_str).unwrap_or("");
                if have != want {
                    out[c.field.as_str()] = json!(want);
                    changed = true;
                }
            }
            "base64_key" => {
                let from = c.key_len_from.as_deref().unwrap_or("");
                let n = key_len(spec, from, &m.option(ib, from))?;
                let fits = account
                    .get(&c.field)
                    .and_then(Value::as_str)
                    .and_then(|k| STANDARD.decode(k).ok())
                    .is_some_and(|k| k.len() == n);
                if !fits {
                    return generate(m, ib).ok();
                }
            }
            _ => {}
        }
    }
    changed.then_some(out)
}

/// The security layer is one the protocol takes (manifest `security`).
pub fn security_allowed(spec: Option<&Spec>, sec: &Security) -> bool {
    spec.is_some_and(|s| s.security.iter().any(|x| x == sec.id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modules_match_the_manifest() {
        let m = manifest::get();
        assert_eq!(MODULES.len(), m.protocol.len());
        for (module, spec) in MODULES.iter().zip(&m.protocol) {
            assert_eq!(module.id(), spec.id);
            assert!(module.spec().is_some());
        }
    }
}
