//! VLESS: account {"flow","id"}; the flow is the inbound's (manifest
//! option `flow`), Vision only where the manifest's rules allow it.

use std::collections::BTreeMap;

use super::ProtocolModule;
use crate::protocols::manifest;
use crate::protocols::model::{Fault, Inbound, Protocol};

pub struct Vless;

impl ProtocolModule for Vless {
    fn id(&self) -> &'static str {
        "vless"
    }

    fn option(&self, ib: &Inbound, name: &str) -> String {
        match (&ib.protocol, name) {
            (Protocol::Vless { flow, .. }, "flow") => flow.clone().unwrap_or_default(),
            _ => String::new(),
        }
    }

    fn check(&self, ib: &Inbound) -> Result<(), Fault> {
        let Protocol::Vless { flow, encryption } = &ib.protocol else {
            return Ok(());
        };
        let spec = self.spec();
        let values = |name: &str| -> Vec<String> {
            spec.and_then(|s| s.option(name))
                .map(|o| o.values.clone())
                .unwrap_or_default()
        };
        if let Some(e) = encryption
            && !e
                .as_deref()
                .is_some_and(|e| values("encryption").iter().any(|v| v == e))
        {
            return Err(Fault::Encryption);
        }
        let flow = flow.as_deref().unwrap_or("");
        if flow.is_empty() {
            return Ok(());
        }
        if !values("flow").iter().any(|v| v == flow) {
            return Err(Fault::FlowUnsupported(flow.to_string()));
        }
        let options = BTreeMap::from([("flow".to_string(), flow.to_string())]);
        if let Some(rule) = manifest::get().violated_rule(
            self.id(),
            ib.transport.kind.id(),
            ib.security.id(),
            &options,
        ) {
            return Err(Fault::Rule(rule.to_string()));
        }
        Ok(())
    }
}
