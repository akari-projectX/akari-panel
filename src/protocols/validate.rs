//! W26: kernel-neutral validation of a (parsed) inbound, in a fixed order:
//! port → security layer → transport (the protocol's manifest list) →
//! combination rules (manifest `[[rule]]` without option keys, in manifest
//! order) → transport fields → the protocol module's own checks (option
//! rules included). The first fault wins; the kernel adapter explains it.

use std::collections::BTreeMap;

use super::manifest;
use super::model::{Fault, Inbound, Security};
use super::protocol::{module, module_for};

pub fn check(ib: &Inbound) -> Result<(), Fault> {
    if !ib.protocol.is_managed() {
        return Ok(());
    }
    let m = manifest::get();
    let id = ib.protocol.id();
    let spec = m.protocol(id);
    if let Some(p) = &ib.port
        && p.filter(|p| (1..=65535).contains(p)).is_none()
    {
        return Err(Fault::Port);
    }
    if let Security::Other { name } = &ib.security {
        return Err(Fault::SecurityUnknown(name.clone()));
    }
    let t = ib.transport.kind.id();
    if !spec.is_some_and(|s| s.transports.iter().any(|x| x == t)) {
        return Err(match spec {
            Some(s) if s.transports.iter().all(|x| x == "native") => {
                Fault::NativeTransportRequired {
                    protocol: module(id).map(|m| m.id()).unwrap_or("?"),
                }
            }
            _ => Fault::TransportUnsupported(t.to_string()),
        });
    }
    let none = BTreeMap::new();
    if let Some(r) = m
        .rule
        .iter()
        .filter(|r| !r.template_only && !r.has_option_key())
        .find(|r| {
            super::manifest_def::selects(&r.when, id, t, ib.security.id(), &none)
                && !super::manifest_def::selects(&r.require, id, t, ib.security.id(), &none)
        })
    {
        return Err(Fault::Rule(r.id.clone()));
    }
    super::transport::check(&ib.transport)?;
    match module_for(&ib.protocol) {
        Some(m) => m.check(ib),
        None => Ok(()),
    }
}
