//! Hysteria 2 (QUIC, the node's certificate): account {"auth"}. The
//! inbound and its transport declare version 2 and no shared password.

use super::{ProtocolModule, security_allowed};
use crate::protocols::model::{Fault, Inbound, Protocol};

/// The protocol (and transport) version Hysteria 2 declares.
pub const VERSION: i64 = 2;

pub struct Hysteria2;

impl ProtocolModule for Hysteria2 {
    fn id(&self) -> &'static str {
        "hysteria2"
    }

    fn issue_only_when_valid(&self) -> bool {
        true
    }

    fn check(&self, ib: &Inbound) -> Result<(), Fault> {
        let Protocol::Hysteria2 { version } = &ib.protocol else {
            return Ok(());
        };
        if *version != Some(VERSION) {
            return Err(Fault::ProtocolVersion);
        }
        if !security_allowed(self.spec(), &ib.security) {
            return Err(Fault::SecurityNotAllowed {
                protocol: "hysteria2",
            });
        }
        let fields = ib.transport.fields.as_ref();
        if fields.and_then(|f| f.version) != Some(VERSION) {
            return Err(Fault::TransportVersion);
        }
        if fields
            .and_then(|f| f.shared_auth.as_deref())
            .is_some_and(|a| !a.is_empty())
        {
            return Err(Fault::SharedAuth);
        }
        Ok(())
    }
}
