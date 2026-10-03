//! VMess: account {"id"} (alterId 0, security auto).

use super::ProtocolModule;

pub struct Vmess;

impl ProtocolModule for Vmess {
    fn id(&self) -> &'static str {
        "vmess"
    }
}
