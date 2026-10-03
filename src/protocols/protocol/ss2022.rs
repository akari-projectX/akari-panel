//! Shadowsocks 2022, multi-user: account {"password"} = a user key of the
//! method's key length (manifest option `method` / `key_len`); the inbound
//! holds the server PSK of the same length and an empty user list.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use super::{ProtocolModule, security_allowed};
use crate::protocols::model::{Fault, Inbound, Protocol, Users};

pub struct Ss2022;

impl ProtocolModule for Ss2022 {
    fn id(&self) -> &'static str {
        "ss2022"
    }

    fn issue_only_when_valid(&self) -> bool {
        true
    }

    fn option(&self, ib: &Inbound, name: &str) -> String {
        match (&ib.protocol, name) {
            (Protocol::Ss2022 { method, .. }, "method") => method.clone().unwrap_or_default(),
            _ => String::new(),
        }
    }

    fn generate_account(&self, ib: &Inbound) -> Result<Value, String> {
        super::generate(self, ib).map_err(|_| {
            format!(
                "shadowsocks method {:?} is not a multi-user 2022 method",
                self.option(ib, "method")
            )
        })
    }

    fn check(&self, ib: &Inbound) -> Result<(), Fault> {
        let Protocol::Ss2022 {
            method,
            psk,
            l4,
            users,
        } = &ib.protocol
        else {
            return Ok(());
        };
        let spec = self.spec();
        let method = method.as_deref().unwrap_or("");
        let Some(n) = spec
            .and_then(|s| s.option("method"))
            .and_then(|o| o.key_len_of(method))
        else {
            return Err(Fault::MethodUnsupported);
        };
        if !psk
            .as_deref()
            .and_then(|k| STANDARD.decode(k).ok())
            .is_some_and(|k| k.len() == n)
        {
            return Err(Fault::Psk {
                len: n,
                method: method.to_string(),
            });
        }
        if *users != Users::Empty {
            return Err(Fault::InlineUsers);
        }
        if let Some(l4) = l4 {
            let values = spec
                .and_then(|s| s.option("network"))
                .map(|o| o.values.as_slice())
                .unwrap_or_default();
            let ok = l4.as_deref().is_some_and(|s| {
                !s.trim().is_empty()
                    && s.split(',').all(|p| {
                        let p = p.trim().to_ascii_lowercase();
                        values.contains(&p)
                    })
            });
            if !ok {
                return Err(Fault::L4);
            }
        }
        if !security_allowed(spec, &ib.security) {
            return Err(Fault::SecurityNotAllowed { protocol: "ss2022" });
        }
        Ok(())
    }
}
