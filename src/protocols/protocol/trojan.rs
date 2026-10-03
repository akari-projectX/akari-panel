//! Trojan: account {"password"} (random hex).

use super::ProtocolModule;

pub struct Trojan;

impl ProtocolModule for Trojan {
    fn id(&self) -> &'static str {
        "trojan"
    }
}
