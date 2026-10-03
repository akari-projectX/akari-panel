//! W26: the protocol capability manifest (`proto/protocols.toml`) as the
//! panel sees it. build.rs parses and validates the file (a broken manifest
//! fails the build) and emits it as construction code plus `const` tables;
//! nothing here can fail at runtime. Schema and validation rules:
//! `manifest_def.rs`. Generated artifacts: `generate.rs`.

use std::collections::BTreeMap;
use std::sync::LazyLock;

pub use super::manifest_def::{
    Credential, Field, Format, Kernel, Manifest, Protocol, Rule, Scenario, Security, Transport,
    Unsupported,
};

#[allow(clippy::all, clippy::pedantic)]
mod generated {
    use super::super::manifest_def::*;
    include!(concat!(env!("OUT_DIR"), "/protocols_manifest.rs"));
}

pub use generated::*;

static MANIFEST: LazyLock<Manifest> = LazyLock::new(generated::build);

/// The manifest compiled into this binary.
pub fn get() -> &'static Manifest {
    &MANIFEST
}

/// The source text (for the consistency test and the generators).
pub const SOURCE: &str = include_str!("../../proto/protocols.toml");

impl Manifest {
    pub fn protocol(&self, id: &str) -> Option<&Protocol> {
        self.protocol.iter().find(|p| p.id == id)
    }

    /// The protocol an agent-contract (wire) name stands for.
    pub fn protocol_by_wire(&self, wire: &str) -> Option<&Protocol> {
        self.protocol.iter().find(|p| p.wire == wire)
    }

    pub fn transport(&self, id: &str) -> Option<&Transport> {
        self.transport.iter().find(|t| t.id == id)
    }

    pub fn security(&self, id: &str) -> Option<&Security> {
        self.security.iter().find(|s| s.id == id)
    }

    pub fn format(&self, id: &str) -> Option<&Format> {
        self.format.iter().find(|f| f.id == id)
    }

    pub fn rule(&self, id: &str) -> Option<&Rule> {
        self.rule.iter().find(|r| r.id == id)
    }

    /// Why `format` cannot carry this combination, if it cannot.
    pub fn unsupported_in(
        &self,
        format: &str,
        protocol: &str,
        transport: &str,
        security: &str,
    ) -> Option<&str> {
        self.format(format)?
            .unsupported
            .iter()
            .find(|u| u.matches(protocol, transport, security))
            .map(|u| u.reason.as_str())
    }

    /// The first non-template rule this combination breaks.
    pub fn violated_rule(
        &self,
        protocol: &str,
        transport: &str,
        security: &str,
        options: &BTreeMap<String, String>,
    ) -> Option<&str> {
        super::manifest_def::violated_rule(self, protocol, transport, security, options, false)
    }

    /// The first rule (template-only rules included) this combination
    /// breaks.
    pub fn violated_template_rule(
        &self,
        protocol: &str,
        transport: &str,
        security: &str,
        options: &BTreeMap<String, String>,
    ) -> Option<&str> {
        super::manifest_def::violated_rule(self, protocol, transport, security, options, true)
    }
}

impl Rule {
    /// Does the rule select on a protocol option (`option.<name>`)? Such
    /// rules are the protocol module's to check.
    pub fn has_option_key(&self) -> bool {
        self.when
            .keys()
            .chain(self.require.keys())
            .any(|k| k.starts_with("option."))
    }
}

impl Protocol {
    pub fn option(&self, name: &str) -> Option<&Field> {
        self.option.iter().find(|o| o.name == name)
    }

    pub fn accepts(&self, transport: &str, security: &str) -> bool {
        self.transports.iter().any(|t| t == transport)
            && self.security.iter().any(|s| s == security)
    }
}

impl Field {
    /// Key length (bytes) of an enum value carrying `key_len`.
    pub fn key_len_of(&self, value: &str) -> Option<usize> {
        let i = self.values.iter().position(|v| v == value)?;
        self.key_len.get(i).map(|n| *n as usize)
    }
}

impl Unsupported {
    pub fn matches(&self, protocol: &str, transport: &str, security: &str) -> bool {
        let has = |l: &[String], v: &str| l.is_empty() || l.iter().any(|x| x == v);
        has(&self.protocol, protocol)
            && !self.protocol_not.iter().any(|x| x == protocol)
            && has(&self.transport, transport)
            && has(&self.security, security)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The build-time copy is the file: the runtime parser (shared with
    /// build.rs and the fuzz target) gives the same manifest.
    #[test]
    fn compiled_manifest_is_the_source() {
        let parsed = super::super::manifest_def::parse(SOURCE).unwrap();
        assert_eq!(&parsed, get());
        assert_eq!(get().schema, 1);
    }

    /// Mistakes the validator must refuse (a few of each kind).
    #[test]
    fn validator_refuses_broken_manifests() {
        let parse = super::super::manifest_def::parse;
        let edit = |from: &str, to: &str| {
            assert!(
                SOURCE.contains(from),
                "fixture text {from:?} not in the manifest"
            );
            SOURCE.replacen(from, to, 1)
        };
        for (from, to) in [
            ("schema = 1", "schema = 2"),
            ("id = \"xray\"", "id = \"singbox\""),
            (
                "transports = [\"tcp\", \"ws\"",
                "transports = [\"tcp\", \"kcp\"",
            ),
            (
                "security = [\"none\", \"tls\", \"reality\"]",
                "security = [\"none\", \"xtls\"]",
            ),
            ("wire = \"vmess\"", "wire = \"vless\""),
            ("kind = \"uuid\"", "kind = \"guid\""),
            ("key_len = [16, 32]", "key_len = [16]"),
            ("default = \"auto\"", "default = \"fast\""),
            ("l4 = \"option:network\"", "l4 = \"option:method\""),
            (
                "require = { protocol = [\"vless\"] }",
                "require = { protocol = [\"socks\"] }",
            ),
            (
                "when = { security = [\"reality\"] }",
                "when = { colour = [\"red\"] }",
            ),
            ("name = \"VMess-WS\"", "name = \"VLESS-WS-TLS\""),
            (
                "name = \"VMess-TCP\"\nprotocol = \"vmess\"\ntransport = \"tcp\"\nsecurity = \"none\"",
                "name = \"VMess-TCP\"\nprotocol = \"vmess\"\ntransport = \"tcp\"\nsecurity = \"reality\"",
            ),
            (
                "name = \"VLESS-WS-TLS\"\nprotocol = \"vless\"\ntransport = \"ws\"\nsecurity = \"tls\"",
                "name = \"VLESS-WS-TLS\"\nprotocol = \"vless\"\ntransport = \"ws\"\nsecurity = \"reality\"",
            ),
            (
                "reason = \"sing-box has no xhttp transport\"",
                "reason = \"\"",
            ),
            (
                "label = \"VLESS\"\n",
                "label = \"VLESS\"\nunknown_key = 1\n",
            ),
        ] {
            assert!(
                parse(&edit(from, to)).is_err(),
                "accepted: {from:?} -> {to:?}"
            );
        }
    }

    #[test]
    fn lookups() {
        let m = get();
        assert_eq!(
            m.protocol_by_wire("shadowsocks").map(|p| p.id.as_str()),
            Some("ss2022")
        );
        assert_eq!(
            m.protocol_by_wire("hysteria").map(|p| p.id.as_str()),
            Some("hysteria2")
        );
        assert_eq!(
            WIRE,
            ["vless", "vmess", "trojan", "shadowsocks", "hysteria"]
        );
        let ss = m.protocol("ss2022").unwrap().option("method").unwrap();
        assert_eq!(ss.key_len_of("2022-blake3-aes-256-gcm"), Some(32));
        assert_eq!(
            m.unsupported_in("clash", "vmess", "xhttp", "none"),
            Some("mihomo supports xhttp only for vless")
        );
        assert_eq!(m.unsupported_in("clash", "vless", "xhttp", "reality"), None);
        let flow = BTreeMap::from([("flow".to_string(), "xtls-rprx-vision".to_string())]);
        assert_eq!(m.violated_rule("vless", "ws", "tls", &flow), Some("vision"));
        assert_eq!(
            m.violated_rule("vless", "grpc", "none", &BTreeMap::new()),
            None
        );
        assert_eq!(
            m.violated_template_rule("vless", "grpc", "none", &BTreeMap::new()),
            Some("grpc_tls")
        );
    }
}
