//! W8: the protocol/transport matrix of panel-managed inbounds — what the
//! panel issues credentials for, how an account is generated for (and kept
//! fitting) its inbound, and the per-inbound validation rules.
//!
//! W26 (R41): the matrix is `proto/protocols.toml` (`manifest`); the code
//! is layered:
//!
//! - `model`: the kernel-neutral inbound (no kernel field names);
//! - `protocol/` (one module per protocol), `transport`, `security`:
//!   compose a model (templates), check one (`validate`), issue/refit
//!   per-user accounts from the manifest's credential spec;
//! - `xray`: the xray kernel adapter (render the model as xray inbound
//!   JSON, parse stored JSON into the model, explain faults, xray-decoder
//!   rules). Subscriptions (`sub/`) render from the model.
//!
//! This file is the stable API the rest of the panel calls (stored
//! inbounds are xray JSON). The support matrix in docs/DEPLOY.md §3d is
//! generated from the manifest (`generate`).
//!
//! Accounts (`entrance_users.account`, sent verbatim to the agent
//! as `account_json`, which decodes them strictly — akari-agent
//! `proto_*.go`):
//!
//! | protocol    | account                       | from the inbound            |
//! |-------------|-------------------------------|-----------------------------|
//! | vless       | `{"id","flow"}`               | flow = the inbound's flow   |
//! | vmess       | `{"id"}`                      |                             |
//! | trojan      | `{"password"}` (64 hex)       |                             |
//! | shadowsocks | `{"password"}` (base64 key)   | key length by the method    |
//! | hysteria    | `{"auth"}` (64 hex)           |                             |
//!
//! The agent re-checks everything that matters for safety after xray's own
//! parse (method/key lengths, protocol of the inbound, Shadowsocks shrink
//! rule); these checks give the admin the error early and keep
//! subscriptions renderable.

pub mod generate;
pub mod manifest;
pub mod manifest_def;
#[cfg(test)]
mod manifest_tests;
pub mod model;
pub mod protocol;
pub mod security;
pub mod transport;
pub mod validate;
pub mod xray;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

pub use transport::{XHTTP_MODES, valid_path};
pub use xray::{case_fold_duplicate, fold_json_key, l4, network, port_clash, protocol, security};

/// Protocols the panel issues credentials for (wire names, manifest order).
pub const MANAGED: [&str; 5] = manifest::WIRE;

/// The only VLESS flow (besides none) xray v26 supports.
pub const VISION: &str = "xtls-rprx-vision";

/// Multi-user Shadowsocks 2022 methods of the agent's xray and their key
/// length. xray's multi-user server only implements the AES methods.
pub const SS_METHODS: [(&str, usize); 2] = manifest::PROTOCOL_SS2022_METHOD_KEY_LEN;

pub fn ss_key_len(method: &str) -> Option<usize> {
    SS_METHODS
        .iter()
        .find(|(m, _)| *m == method)
        .map(|(_, n)| *n)
}

/// A fresh Shadowsocks 2022 key for `method` (standard base64).
pub fn new_ss_key(method: &str) -> Option<String> {
    ss_key_len(method).map(|n| STANDARD.encode(crate::entropy::bytes(n)))
}

/// The VLESS flow the inbound's users get: `settings.flow` ("" = none).
pub fn vless_flow(inbound: &Value) -> &str {
    inbound
        .pointer("/settings/flow")
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// Does the panel issue credentials for this inbound? vless/vmess/trojan
/// always (as before W8: stored configurations keep their users even if a
/// newer check would flag them); the W8 protocols only in their managed
/// form (multi-user Shadowsocks 2022 with a `clients` list, a valid
/// Hysteria 2 inbound), so a legacy hand-written shadowsocks inbound is
/// not suddenly given users the agent would refuse.
pub fn issuable(inbound: &Value) -> bool {
    let ib = xray::parse(inbound);
    match protocol::module_for(&ib.protocol) {
        Some(m) if m.issue_only_when_valid() => check_inbound(inbound).is_ok(),
        Some(_) => true,
        None => false,
    }
}

/// A new account for `inbound` (its protocol and settings decide the shape).
pub fn generate_account(inbound: &Value) -> Result<Value, String> {
    let ib = xray::parse(inbound);
    match protocol::module_for(&ib.protocol) {
        Some(m) => m.generate_account(&ib),
        None => Err(format!(
            "unsupported protocol {:?} ({})",
            ib.protocol.id(),
            MANAGED.join(", ")
        )),
    }
}

/// The account adjusted to the inbound it is for, or None if it already
/// fits: a VLESS flow follows the inbound (the id is kept); a Shadowsocks
/// key of the wrong length for the method is replaced (the user must
/// refresh the subscription). Used when inbounds change, so a kept
/// credential never makes the agent's apply fail.
pub fn refit_account(inbound: &Value, account: &Value) -> Option<Value> {
    let ib = xray::parse(inbound);
    protocol::module_for(&ib.protocol)?.refit_account(&ib, account)
}

/// Protocol/transport rules for one inbound (Err = the admin-facing
/// reason, without the tag). Only panel-managed protocols are checked
/// beyond the transport-independent rules in `api::validate_inbounds`;
/// absent optional fields are left to xray's defaults.
pub fn check_inbound(inbound: &Value) -> Result<(), String> {
    xray::check(inbound).map_err(|f| xray::explain(&f))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// W14: keys equal under Go's case folding alias each other in xray,
    /// at any depth (the SS2022 `method`/`METHOD` downgrade W13 found on
    /// the agent side, a second `tag`, a shadow `security`).
    #[test]
    fn case_folded_duplicate_keys_are_refused_at_any_depth() {
        let ss = |settings: Value| json!({"tag": "ss", "port": 8388, "protocol": "shadowsocks", "settings": settings});
        let base = json!({"method": "2022-blake3-aes-128-gcm",
                          "password": "AAAAAAAAAAAAAAAAAAAAAA==", "clients": []});
        assert_eq!(check_inbound(&ss(base.clone())), Ok(()));
        let mut downgraded = base.clone();
        downgraded["METHOD"] = json!("aes-128-gcm");
        assert!(
            check_inbound(&ss(downgraded))
                .unwrap_err()
                .contains("duplicate key")
        );
        let refused = [
            json!({"tag": "a", "TAG": "b", "protocol": "vless"}),
            json!({"tag": "a", "protocol": "vless", "Protocol": "dokodemo-door"}),
            json!({"tag": "a", "protocol": "vless",
                   "streamSettings": {"security": "reality", "Security": "none"}}),
            // deep inside an array
            json!({"tag": "a", "protocol": "trojan",
                   "streamSettings": {"tlsSettings": {"certificates": [
                       {"certificateFile": "/a", "CERTIFICATEFILE": "/b"}]}}}),
            // non-ASCII runes Go folds onto ASCII: U+017F (s), U+212A (k)
            json!({"tag": "a", "protocol": "vless", "\u{17f}ettings": {}, "settings": {}}),
            json!({"tag": "a", "protocol": "vless",
                   "streamSettings": {"\u{212a}cpSettings": {}, "kcpSettings": {}}}),
            // unmanaged protocols too (the rule is about xray's decoder)
            json!({"tag": "a", "protocol": "dokodemo-door", "Settings": {}, "settings": {}}),
        ];
        for v in refused {
            let e = check_inbound(&v).unwrap_err();
            assert!(e.contains("duplicate key"), "{v}: {e}");
        }
        // Same name in different objects, and distinct keys, are fine.
        assert_eq!(
            case_fold_duplicate(&json!({"host": "a", "headers": {"Host": "a"}, "Hosts": 1})),
            None
        );
        // Found below deep nesting (iterative walk).
        let mut deep = json!({"x": 1, "X": 2});
        for _ in 0..300 {
            deep = json!([{ "k": deep }]);
        }
        assert!(case_fold_duplicate(&deep).is_some());
    }

    /// W26 (fuzz `inbound_model`): an unmanaged kernel protocol whose name
    /// spells a manifest id is still unmanaged: no credentials, kept name.
    #[test]
    fn unmanaged_names_never_match_manifest_ids() {
        for name in ["ss2022", "hysteria2"] {
            let ib = json!({"tag": "x", "protocol": name, "port": 1});
            assert!(!issuable(&ib), "{name}");
            assert_eq!(
                generate_account(&ib).unwrap_err(),
                format!("unsupported protocol {name:?} ({})", MANAGED.join(", "))
            );
            assert_eq!(refit_account(&ib, &json!({"password": "x"})), None);
            assert_eq!(check_inbound(&ib), Ok(()));
            assert_eq!(xray::render(&xray::parse(&ib))["protocol"], name);
        }
    }

    #[test]
    fn accounts_follow_the_inbound() {
        let vision = json!({"protocol": "vless", "settings": {"flow": VISION}});
        assert_eq!(generate_account(&vision).unwrap()["flow"], VISION);
        assert_eq!(
            generate_account(&json!({"protocol": "vless"})).unwrap()["flow"],
            ""
        );
        for (m, n) in SS_METHODS {
            let a =
                generate_account(&json!({"protocol": "shadowsocks", "settings": {"method": m}}))
                    .unwrap();
            assert_eq!(
                STANDARD
                    .decode(a["password"].as_str().unwrap())
                    .unwrap()
                    .len(),
                n
            );
        }
        assert!(
            generate_account(
                &json!({"protocol": "shadowsocks", "settings": {"method": "aes-128-gcm"}})
            )
            .is_err()
        );
        assert_eq!(
            generate_account(&json!({"protocol": "hysteria"})).unwrap()["auth"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        assert_eq!(
            generate_account(&json!({"protocol": "trojan"})).unwrap()["password"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        assert!(generate_account(&json!({"protocol": "socks"})).is_err());
    }

    #[test]
    fn refit_keeps_fitting_accounts() {
        let vision = json!({"protocol": "vless", "settings": {"flow": VISION}});
        let a = json!({"id": "x", "flow": ""});
        assert_eq!(
            refit_account(&vision, &a),
            Some(json!({"id": "x", "flow": VISION}))
        );
        assert_eq!(
            refit_account(&vision, &json!({"id": "x", "flow": VISION})),
            None
        );
        let plain = json!({"protocol": "vless"});
        assert_eq!(
            refit_account(&plain, &json!({"id": "x", "flow": VISION})),
            Some(a.clone())
        );
        let s128 =
            json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm"}});
        let s256 =
            json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-256-gcm"}});
        let k = generate_account(&s128).unwrap();
        assert_eq!(refit_account(&s128, &k), None);
        let r = refit_account(&s256, &k).unwrap();
        assert_eq!(
            STANDARD
                .decode(r["password"].as_str().unwrap())
                .unwrap()
                .len(),
            32
        );
        assert_eq!(
            refit_account(&json!({"protocol": "vmess"}), &json!({"id": "y"})),
            None
        );
    }

    fn ss(method: &str, psk: &str) -> Value {
        json!({"tag": "s", "port": 8388, "protocol": "shadowsocks",
               "settings": {"method": method, "password": psk, "clients": [], "network": "tcp,udp"}})
    }

    #[test]
    fn validation_matrix() {
        let k16 = STANDARD.encode([1u8; 16]);
        let k32 = STANDARD.encode([1u8; 32]);
        let hy = |extra: Value| {
            let mut v = json!({"tag": "h", "port": 443, "protocol": "hysteria", "settings": {"version": 2, "clients": []},
                "streamSettings": {"network": "hysteria", "security": "tls", "hysteriaSettings": {"version": 2}}});
            if let Some(o) = extra.as_object() {
                for (k, val) in o {
                    v["streamSettings"]["hysteriaSettings"][k] = val.clone();
                }
            }
            v
        };
        let good = [
            json!({"protocol": "vless"}),
            json!({"protocol": "vless", "port": 443, "settings": {"decryption": "none", "flow": VISION},
                   "streamSettings": {"network": "raw", "security": "reality"}}),
            json!({"protocol": "vless", "settings": {"flow": VISION}, "streamSettings": {"network": "tcp", "security": "tls"}}),
            json!({"protocol": "vless", "streamSettings": {"network": "xhttp", "security": "reality",
                   "xhttpSettings": {"path": "/x", "mode": "stream-one"}}}),
            json!({"protocol": "vless", "streamSettings": {"network": "grpc", "security": "reality",
                   "grpcSettings": {"serviceName": "svc"}}}),
            json!({"protocol": "vmess", "streamSettings": {"network": "httpupgrade",
                   "httpupgradeSettings": {"path": "/u?ed=2048", "host": "cdn.example.com"}}}),
            json!({"protocol": "trojan", "streamSettings": {"network": "ws", "security": "tls",
                   "wsSettings": {"path": "/t", "headers": {"Host": "a.example.com"}}}}),
            json!({"protocol": "vless", "streamSettings": {"network": "splithttp", "splithttpSettings": {"path": "/s"}}}),
            ss("2022-blake3-aes-128-gcm", &k16),
            ss("2022-blake3-aes-256-gcm", &k32),
            hy(json!({})),
            json!({"protocol": "dokodemo-door", "streamSettings": {"network": "kcp"}}),
        ];
        for g in good {
            assert_eq!(check_inbound(&g), Ok(()), "{g}");
        }
        let bad = [
            json!({"protocol": "vless", "port": 0}),
            json!({"protocol": "vless", "port": "443"}),
            json!({"protocol": "vless", "port": 70000}),
            json!({"protocol": "vless", "settings": {"flow": VISION}, "streamSettings": {"network": "ws", "security": "tls"}}),
            json!({"protocol": "vless", "settings": {"flow": VISION}}),
            json!({"protocol": "vless", "settings": {"flow": "xtls-rprx-direct"}}),
            json!({"protocol": "vless", "settings": {"decryption": "mlkem768x25519plus.native.0rtt.x"}}),
            json!({"protocol": "vmess", "streamSettings": {"security": "reality"}}),
            json!({"protocol": "vless", "streamSettings": {"network": "ws", "security": "reality"}}),
            json!({"protocol": "vless", "streamSettings": {"network": "kcp"}}),
            json!({"protocol": "vless", "streamSettings": {"security": "xtls"}}),
            json!({"protocol": "vless", "streamSettings": {"network": "ws", "wsSettings": {"path": "ws"}}}),
            json!({"protocol": "vless", "streamSettings": {"network": "ws", "wsSettings": {"path": "/a b"}}}),
            json!({"protocol": "vless", "streamSettings": {"network": "xhttp", "xhttpSettings": {"mode": "fast"}}}),
            json!({"protocol": "vless", "streamSettings": {"network": "grpc", "grpcSettings": {"serviceName": "a b"}}}),
            json!({"protocol": "vless", "streamSettings": {"network": "httpupgrade", "httpupgradeSettings": {"host": "a b"}}}),
            json!({"protocol": "vless", "streamSettings": {"network": "hysteria"}}),
            ss("2022-blake3-chacha20-poly1305", &k32),
            ss("aes-128-gcm", "pw"),
            ss("2022-blake3-aes-128-gcm", &k32),
            ss("2022-blake3-aes-256-gcm", "%%%"),
            json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm", "password": k16}}),
            json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm", "password": k16,
                   "clients": [{"password": k16}]}}),
            json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm", "password": k16,
                   "clients": [], "network": "quic"}}),
            json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm", "password": k16,
                   "clients": []}, "streamSettings": {"network": "ws"}}),
            hy(json!({"auth": "shared-secret"})),
            hy(json!({"version": 1})),
            json!({"protocol": "hysteria", "settings": {"version": 2}, "streamSettings": {"network": "hysteria",
                   "hysteriaSettings": {"version": 2}}}),
            json!({"protocol": "hysteria", "settings": {"version": 2}, "streamSettings": {"network": "tcp", "security": "tls"}}),
        ];
        for b in bad {
            assert!(check_inbound(&b).is_err(), "{b}");
        }
    }

    #[test]
    fn port_clashes() {
        let v = |port: u16, proto: &str| json!({"port": port, "protocol": proto});
        assert!(port_clash(&[v(443, "vless"), v(443, "trojan")]).is_some());
        // Hysteria (UDP) may share the TCP port of a TLS inbound.
        assert!(port_clash(&[v(443, "vless"), v(443, "hysteria")]).is_none());
        let ss_udp =
            json!({"port": 443, "protocol": "shadowsocks", "settings": {"network": "tcp,udp"}});
        assert!(port_clash(&[ss_udp.clone(), v(443, "hysteria")]).is_some());
        assert!(port_clash(&[ss_udp, v(443, "vless")]).is_some());
        let a = json!({"port": 1, "protocol": "vless", "listen": "127.0.0.1"});
        let b = json!({"port": 1, "protocol": "vless", "listen": "127.0.0.2"});
        assert!(port_clash(&[a.clone(), b]).is_none());
        assert!(port_clash(&[a, v(1, "vmess")]).is_some());
        assert!(port_clash(&[v(1, "vless"), v(2, "vless")]).is_none());
    }
}
