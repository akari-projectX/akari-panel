//! W8: the protocol/transport matrix of panel-managed inbounds — what the
//! panel issues credentials for, how an account is generated for (and kept
//! fitting) its inbound, and the per-inbound validation rules. The support
//! matrix (templates, subscriptions, clients) is in docs/DEPLOY.md §3c.
//!
//! Accounts (`node_users.credentials[].account`, sent verbatim to the agent
//! as `account_json`, which decodes them strictly — akari-agent
//! `protocols.go`):
//!
//! | protocol    | account                       | from the inbound            |
//! |-------------|-------------------------------|-----------------------------|
//! | vless       | `{"id","flow"}`               | flow = `settings.flow`      |
//! | vmess       | `{"id"}`                      |                             |
//! | trojan      | `{"password"}` (64 hex)       |                             |
//! | shadowsocks | `{"password"}` (base64 key)   | key length by `settings.method` |
//! | hysteria    | `{"auth"}` (64 hex)           |                             |
//!
//! The agent re-checks everything that matters for safety after xray's own
//! parse (method/key lengths, protocol of the inbound, Shadowsocks shrink
//! rule); these checks give the admin the error early and keep
//! subscriptions renderable.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use uuid::Uuid;

/// Protocols the panel issues credentials for.
pub const MANAGED: [&str; 5] = ["vless", "vmess", "trojan", "shadowsocks", "hysteria"];

/// The only VLESS flow (besides none) xray v26 supports.
pub const VISION: &str = "xtls-rprx-vision";

/// Multi-user Shadowsocks 2022 methods of the agent's xray and their key
/// length. xray's multi-user server only implements the AES methods.
pub const SS_METHODS: [(&str, usize); 2] = [
    ("2022-blake3-aes-128-gcm", 16),
    ("2022-blake3-aes-256-gcm", 32),
];

/// XHTTP modes (xray `xhttpSettings.mode`).
pub const XHTTP_MODES: [&str; 4] = ["auto", "packet-up", "stream-up", "stream-one"];

pub fn ss_key_len(method: &str) -> Option<usize> {
    SS_METHODS
        .iter()
        .find(|(m, _)| *m == method)
        .map(|(_, n)| *n)
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    rand::rng().fill_bytes(&mut b);
    b
}

/// A fresh Shadowsocks 2022 key for `method` (standard base64).
pub fn new_ss_key(method: &str) -> Option<String> {
    ss_key_len(method).map(|n| STANDARD.encode(random_bytes(n)))
}

fn str_at<'a>(v: &'a Value, ptr: &str) -> Option<&'a str> {
    v.pointer(ptr).and_then(Value::as_str)
}

pub fn protocol(inbound: &Value) -> &str {
    str_at(inbound, "/protocol").unwrap_or("")
}

/// `streamSettings.network` normalized ("tcp" default; raw = tcp,
/// splithttp = xhttp).
pub fn network(inbound: &Value) -> String {
    let n = str_at(inbound, "/streamSettings/network")
        .unwrap_or("tcp")
        .trim()
        .to_ascii_lowercase();
    match n.as_str() {
        "" | "raw" => "tcp".into(),
        "splithttp" => "xhttp".into(),
        "websocket" => "ws".into(),
        _ => n,
    }
}

/// `streamSettings.security` ("none" default).
pub fn security(inbound: &Value) -> String {
    let s = str_at(inbound, "/streamSettings/security")
        .unwrap_or("none")
        .trim()
        .to_ascii_lowercase();
    if s.is_empty() {
        "none".into()
    } else {
        s
    }
}

/// The VLESS flow the inbound's users get: `settings.flow` ("" = none).
pub fn vless_flow(inbound: &Value) -> &str {
    str_at(inbound, "/settings/flow").unwrap_or("")
}

/// Does the panel issue credentials for this inbound? vless/vmess/trojan
/// always (as before W8: stored configurations keep their users even if a
/// newer check would flag them); the W8 protocols only in their managed
/// form (multi-user Shadowsocks 2022 with a `clients` list, a valid
/// Hysteria 2 inbound), so a legacy hand-written shadowsocks inbound is
/// not suddenly given users the agent would refuse.
pub fn issuable(inbound: &Value) -> bool {
    match protocol(inbound) {
        "vless" | "vmess" | "trojan" => true,
        "shadowsocks" | "hysteria" => check_inbound(inbound).is_ok(),
        _ => false,
    }
}

/// A new account for `inbound` (its protocol and settings decide the shape).
pub fn generate_account(inbound: &Value) -> Result<Value, String> {
    match protocol(inbound) {
        "vless" => Ok(json!({ "id": Uuid::new_v4().to_string(), "flow": vless_flow(inbound) })),
        "vmess" => Ok(json!({ "id": Uuid::new_v4().to_string() })),
        "trojan" => Ok(json!({ "password": hex::encode(random_bytes(32)) })),
        "shadowsocks" => {
            let method = str_at(inbound, "/settings/method").unwrap_or("");
            new_ss_key(method)
                .map(|k| json!({ "password": k }))
                .ok_or_else(|| {
                    format!("shadowsocks method {method:?} is not a multi-user 2022 method")
                })
        }
        "hysteria" => Ok(json!({ "auth": hex::encode(random_bytes(32)) })),
        other => Err(format!(
            "unsupported protocol {other:?} ({})",
            MANAGED.join(", ")
        )),
    }
}

/// The account adjusted to the inbound it is for, or None if it already
/// fits: a VLESS flow follows `settings.flow` (the id is kept); a
/// Shadowsocks key of the wrong length for the method is replaced (the
/// user must refresh the subscription). Used when inbounds change, so a
/// kept credential never makes the agent's apply fail.
pub fn refit_account(inbound: &Value, account: &Value) -> Option<Value> {
    match protocol(inbound) {
        "vless" => {
            let want = vless_flow(inbound);
            let have = account.get("flow").and_then(Value::as_str).unwrap_or("");
            (have != want).then(|| {
                let mut a = account.clone();
                a["flow"] = json!(want);
                a
            })
        }
        "shadowsocks" => {
            let method = str_at(inbound, "/settings/method").unwrap_or("");
            let n = ss_key_len(method)?;
            let fits = account
                .get("password")
                .and_then(Value::as_str)
                .and_then(|k| STANDARD.decode(k).ok())
                .is_some_and(|k| k.len() == n);
            if fits {
                None
            } else {
                new_ss_key(method).map(|k| json!({ "password": k }))
            }
        }
        _ => None,
    }
}

/// Paths of HTTP-based transports: start with '/', printable ASCII without
/// space, quotes, backslash or '#' (subscriptions embed them in URLs/YAML).
pub fn valid_path(p: &str) -> bool {
    p.starts_with('/')
        && p.len() <= 256
        && p.bytes()
            .all(|b| b.is_ascii_graphic() && !b"\"'\\#`<>{}|^".contains(&b))
}

/// Host header values: a DNS-ish name (optionally :port).
fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-.:[]".contains(&b))
}

/// gRPC service names: xray serviceName (may hold '/' for custom paths).
fn valid_service_name(s: &str) -> bool {
    s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b))
}

/// Settings object of a transport (the xhttp settings have two key names).
fn transport_settings<'a>(inbound: &'a Value, net: &str) -> Option<&'a Value> {
    let ss = inbound.get("streamSettings")?;
    match net {
        "ws" => ss.get("wsSettings"),
        "httpupgrade" => ss.get("httpupgradeSettings"),
        "xhttp" => ss
            .get("xhttpSettings")
            .or_else(|| ss.get("splithttpSettings")),
        "grpc" => ss.get("grpcSettings"),
        "hysteria" => ss.get("hysteriaSettings"),
        _ => None,
    }
}

/// Which L4 protocols the inbound listens on: (tcp, udp).
pub fn l4(inbound: &Value) -> (bool, bool) {
    match protocol(inbound) {
        "hysteria" => (false, true),
        "shadowsocks" => {
            let n = str_at(inbound, "/settings/network").unwrap_or("tcp,udp");
            let has = |x: &str| n.split(',').any(|p| p.trim().eq_ignore_ascii_case(x));
            (has("tcp"), has("udp"))
        }
        "dokodemo-door" | "tunnel" => {
            let n = str_at(inbound, "/settings/network").unwrap_or("tcp");
            let has = |x: &str| n.split(',').any(|p| p.trim().eq_ignore_ascii_case(x));
            (has("tcp"), has("udp"))
        }
        _ => (true, false),
    }
}

/// Go encoding/json's key folding: ASCII case-insensitive, plus the two
/// non-ASCII runes that fold onto ASCII letters (U+017F long s, U+212A
/// Kelvin sign), so no key can alias another one in xray's eyes.
pub fn fold_json_key(key: &str) -> String {
    key.chars()
        .map(|c| match c {
            '\u{17f}' => 's',
            '\u{212a}' => 'k',
            c => c.to_ascii_lowercase(),
        })
        .collect()
}

/// The first key (as written) of an object anywhere in `v` that collides
/// with another key of the same object under `fold_json_key`. Iterative,
/// so hostile nesting depth cannot overflow the stack.
pub fn case_fold_duplicate(v: &Value) -> Option<String> {
    let mut stack = vec![v];
    while let Some(v) = stack.pop() {
        match v {
            Value::Object(map) => {
                let mut seen = std::collections::HashSet::with_capacity(map.len());
                for (k, child) in map {
                    if !seen.insert(fold_json_key(k)) {
                        return Some(k.clone());
                    }
                    stack.push(child);
                }
            }
            Value::Array(items) => stack.extend(items),
            _ => {}
        }
    }
    None
}

/// Protocol/transport rules for one inbound (Err = the admin-facing
/// reason, without the tag). Only panel-managed protocols are checked
/// beyond the transport-independent rules in `api::validate_inbounds`;
/// absent optional fields are left to xray's defaults.
pub fn check_inbound(inbound: &Value) -> Result<(), String> {
    // W14: xray decodes JSON keys case-insensitively (Go encoding/json),
    // so `tag` and `TAG` in one object are one field to xray but two to
    // the panel's literal-key checks: whichever xray picks could bypass
    // them (W13 found an SS2022 downgrade that way on the agent side).
    if let Some(key) = case_fold_duplicate(inbound) {
        return Err(format!(
            "duplicate key {key:?} (keys differing only in letter case are one key to xray)"
        ));
    }
    let proto = protocol(inbound);
    let net = network(inbound);
    if net == "hysteria" && proto != "hysteria" {
        return Err("the hysteria transport is only for the hysteria protocol".into());
    }
    if !MANAGED.contains(&proto) {
        return Ok(());
    }
    if let Some(p) = inbound.get("port") {
        if p.as_u64().filter(|p| (1..=65535).contains(p)).is_none() {
            return Err("port must be a number 1-65535 (subscriptions advertise it)".into());
        }
    }
    let sec = security(inbound);
    match sec.as_str() {
        "none" | "tls" | "reality" => {}
        other => {
            return Err(format!(
                "security {other:?} is not supported (none, tls, reality)"
            ))
        }
    }
    match (proto, net.as_str()) {
        ("shadowsocks", "tcp") | ("hysteria", "hysteria") => {}
        ("shadowsocks", _) => {
            return Err("shadowsocks runs on its own transport (no streamSettings.network)".into())
        }
        ("hysteria", _) => return Err("hysteria needs streamSettings.network \"hysteria\"".into()),
        (_, "tcp" | "ws" | "httpupgrade" | "xhttp" | "grpc") => {}
        (_, other) => {
            return Err(format!(
                "transport {other:?} is not supported (tcp/raw, ws, httpupgrade, xhttp, grpc)"
            ))
        }
    }
    if sec == "reality" {
        if proto != "vless" {
            return Err("REALITY is only supported with vless".into());
        }
        if !matches!(net.as_str(), "tcp" | "xhttp" | "grpc") {
            return Err("REALITY works with tcp/raw, xhttp or grpc".into());
        }
    }
    if let Some(ts) = transport_settings(inbound, &net) {
        if let Some(p) = ts.get("path") {
            if !p.as_str().is_some_and(valid_path) {
                return Err(
                    "transport path must start with / and hold no spaces, quotes or #".into(),
                );
            }
        }
        let host = ts
            .get("host")
            .or_else(|| ts.pointer("/headers/Host"))
            .and_then(Value::as_str);
        if let Some(h) = host {
            if !h.is_empty() && !valid_host(h) {
                return Err("transport host must be a domain name".into());
            }
        }
        if net == "xhttp" {
            if let Some(m) = ts.get("mode") {
                if !m
                    .as_str()
                    .is_some_and(|m| m.is_empty() || XHTTP_MODES.contains(&m))
                {
                    return Err(format!(
                        "xhttp mode must be one of {}",
                        XHTTP_MODES.join(", ")
                    ));
                }
            }
        }
        if net == "grpc" {
            if let Some(s) = ts.get("serviceName") {
                if !s.as_str().is_some_and(valid_service_name) {
                    return Err("grpc serviceName: letters, digits and -_./ only (<= 128)".into());
                }
            }
        }
    }
    match proto {
        "vless" => {
            if let Some(d) = inbound.pointer("/settings/decryption") {
                if d.as_str() != Some("none") {
                    return Err("vless settings.decryption must be \"none\" (VLESS encryption is not in subscriptions)".into());
                }
            }
            match vless_flow(inbound) {
                "" => {}
                VISION => {
                    if net != "tcp" || !matches!(sec.as_str(), "tls" | "reality") {
                        return Err(format!(
                            "flow {VISION} needs streamSettings.network tcp/raw with tls or reality"
                        ));
                    }
                }
                other => {
                    return Err(format!(
                        "vless flow {other:?} is not supported (\"\" or {VISION})"
                    ))
                }
            }
        }
        "shadowsocks" => {
            let method = str_at(inbound, "/settings/method").unwrap_or("");
            let Some(n) = ss_key_len(method) else {
                return Err(format!(
                    "shadowsocks method must be a multi-user 2022 method: {} (2022-blake3-chacha20-poly1305 \
                     has no multi-user server in xray; legacy methods have no per-user keys)",
                    SS_METHODS.map(|(m, _)| m).join(", ")
                ));
            };
            let psk_ok = str_at(inbound, "/settings/password")
                .and_then(|k| STANDARD.decode(k).ok())
                .is_some_and(|k| k.len() == n);
            if !psk_ok {
                return Err(format!(
                    "shadowsocks settings.password must be a base64 {n}-byte key for {method}"
                ));
            }
            if !inbound
                .pointer("/settings/clients")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
            {
                return Err(
                    "shadowsocks settings.clients must be [] (users are managed by the panel)"
                        .into(),
                );
            }
            if let Some(nw) = inbound.pointer("/settings/network") {
                let ok = nw.as_str().is_some_and(|s| {
                    !s.trim().is_empty()
                        && s.split(',').all(|p| {
                            matches!(p.trim().to_ascii_lowercase().as_str(), "tcp" | "udp")
                        })
                });
                if !ok {
                    return Err("shadowsocks settings.network must be tcp, udp or tcp,udp".into());
                }
            }
            if sec != "none" {
                return Err("shadowsocks takes no tls/reality".into());
            }
        }
        "hysteria" => {
            if inbound.pointer("/settings/version").and_then(Value::as_i64) != Some(2) {
                return Err("hysteria settings.version must be 2".into());
            }
            if sec != "tls" {
                return Err("hysteria needs security \"tls\" (the node's certificate)".into());
            }
            let hs = transport_settings(inbound, "hysteria");
            if hs.and_then(|h| h.get("version")).and_then(Value::as_i64) != Some(2) {
                return Err("streamSettings.hysteriaSettings.version must be 2".into());
            }
            if hs
                .and_then(|h| h.get("auth"))
                .and_then(Value::as_str)
                .is_some_and(|a| !a.is_empty())
            {
                return Err(
                    "hysteriaSettings.auth must not be set (per-user auth is managed by the panel)"
                        .into(),
                );
            }
        }
        _ => {}
    }
    Ok(())
}

/// Port clashes among inbounds (same port, overlapping L4, overlapping
/// listen address): xray would fail to bind and the whole apply fails.
pub fn port_clash(inbounds: &[Value]) -> Option<String> {
    let listen = |i: &Value| -> String {
        let l = str_at(i, "/listen").unwrap_or("").trim().to_string();
        if l == "0.0.0.0" || l == "::" {
            String::new()
        } else {
            l
        }
    };
    for (a_i, a) in inbounds.iter().enumerate() {
        let Some(pa) = a.get("port").and_then(Value::as_u64) else {
            continue;
        };
        for b in &inbounds[a_i + 1..] {
            if b.get("port").and_then(Value::as_u64) != Some(pa) {
                continue;
            }
            let ((at, au), (bt, bu)) = (l4(a), l4(b));
            let (la, lb) = (listen(a), listen(b));
            if ((at && bt) || (au && bu)) && (la.is_empty() || lb.is_empty() || la == lb) {
                return Some(format!("port {pa} is used by more than one inbound"));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(check_inbound(&ss(downgraded))
            .unwrap_err()
            .contains("duplicate key"));
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
        assert!(generate_account(
            &json!({"protocol": "shadowsocks", "settings": {"method": "aes-128-gcm"}})
        )
        .is_err());
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
