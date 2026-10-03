//! W26: the xray kernel adapter — the only place that knows xray's inbound
//! JSON. It renders the kernel-neutral model (`model::Inbound`) into the
//! inbound JSON the agent runs (stored in `nodes.xray_inbounds`, sent
//! verbatim as `ConfigSnapshot.inbounds_json`), parses stored JSON back
//! into the model (subscriptions, validation, credentials), explains
//! validation faults in xray's terms, and holds the checks that are about
//! xray's decoder itself (Go JSON key folding, binding of the `hysteria`
//! network, port binding).
//!
//! A second kernel (sing-box, research/singbox-spike) would be a sibling
//! of this module: render + parse + explain for its configuration; the
//! model, the protocol/transport/security modules, the validation order and
//! the subscription renderers stay as they are.

use serde_json::{Map, Value, json};

use super::manifest;
use super::model::{
    Certificate, Fault, Inbound, Protocol, Raw, Reality, Security, Tls, Transport, TransportFields,
    TransportKind, Users,
};

/// Where the agent finds the node's TLS certificate: the installer's
/// drop-in (`LoadCredential=tls:/etc/akari-agent/tls`) hands the files to
/// the agent as systemd credentials; with 节点域名 the agent (protocol 6)
/// serves its own ACME certificate for these entries instead.
pub const TLS_CERT_FILE: &str = "/run/credentials/akari-agent.service/tls_fullchain.pem";
pub const TLS_KEY_FILE: &str = "/run/credentials/akari-agent.service/tls_privkey.pem";

/// xray's network name of Hysteria 2's own (QUIC) transport.
const HYSTERIA_NETWORK: &str = "hysteria";

fn str_at<'a>(v: &'a Value, ptr: &str) -> Option<&'a str> {
    v.pointer(ptr).and_then(Value::as_str)
}

fn raw(v: Option<&Value>) -> Raw {
    v.map(|v| v.as_str().map(String::from))
}

/// The inbound's xray protocol name.
pub fn protocol(inbound: &Value) -> &str {
    str_at(inbound, "/protocol").unwrap_or("")
}

/// `streamSettings.network` normalized ("tcp" default; raw = tcp,
/// splithttp = xhttp, websocket = ws).
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
    if s.is_empty() { "none".into() } else { s }
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
        HYSTERIA_NETWORK => ss.get("hysteriaSettings"),
        _ => None,
    }
}

/// The model of a stored inbound, as its own protocol.
pub fn parse(inbound: &Value) -> Inbound {
    parse_as(inbound, protocol(inbound))
}

/// The model of a stored inbound read as protocol `wire` (a credential's
/// protocol: subscriptions render what the credential is for).
pub fn parse_as(inbound: &Value, wire: &str) -> Inbound {
    let id = manifest::get()
        .protocol_by_wire(wire)
        .map(|p| p.id.as_str());
    let settings = |k: &str| inbound.get("settings").and_then(|s| s.get(k));
    let protocol = match id {
        Some("vless") => Protocol::Vless {
            flow: settings("flow").and_then(Value::as_str).map(String::from),
            encryption: raw(settings("decryption")),
        },
        Some("vmess") => Protocol::Vmess,
        Some("trojan") => Protocol::Trojan,
        Some("ss2022") => Protocol::Ss2022 {
            method: settings("method").and_then(Value::as_str).map(String::from),
            psk: settings("password")
                .and_then(Value::as_str)
                .map(String::from),
            l4: raw(settings("network")),
            users: if settings("clients")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
            {
                Users::Empty
            } else {
                Users::Other
            },
        },
        Some("hysteria2") => Protocol::Hysteria2 {
            version: settings("version").and_then(Value::as_i64),
        },
        _ => Protocol::Unmanaged {
            name: wire.to_string(),
        },
    };
    let net = network(inbound);
    let kind = match (id, net.as_str()) {
        (Some("ss2022"), "tcp") | (Some("hysteria2"), HYSTERIA_NETWORK) => TransportKind::Native,
        (_, "tcp") => TransportKind::Tcp,
        (_, "ws") => TransportKind::Ws,
        (_, "httpupgrade") => TransportKind::HttpUpgrade,
        (_, "xhttp") => TransportKind::Xhttp,
        (_, "grpc") => TransportKind::Grpc,
        (_, other) => TransportKind::Other(other.to_string()),
    };
    // Hysteria 2's transport settings are read whatever the network says
    // (its checks report a wrong network first).
    let ts = if id == Some("hysteria2") {
        transport_settings(inbound, HYSTERIA_NETWORK)
    } else {
        transport_settings(inbound, &net)
    };
    let fields = ts.map(|ts| TransportFields {
        path: raw(ts.get("path")),
        host: raw(ts
            .get("host")
            .or_else(|| ts.get("headers").and_then(|h| h.get("Host")))),
        mode: raw(ts.get("mode")),
        service_name: raw(ts.get("serviceName")),
        version: ts.get("version").and_then(Value::as_i64),
        shared_auth: ts.get("auth").and_then(Value::as_str).map(String::from),
    });
    let stream = |k: &str| inbound.get("streamSettings").and_then(|s| s.get(k));
    let sec = security(inbound);
    let security = match sec.as_str() {
        "none" => Security::None,
        "tls" => {
            let ts = stream("tlsSettings");
            Security::Tls(Tls {
                server_name: ts
                    .and_then(|t| t.get("serverName"))
                    .and_then(Value::as_str)
                    .map(String::from),
                alpn: ts
                    .and_then(|t| t.get("alpn"))
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                certificate: ts
                    .and_then(|t| t.get("certificates"))
                    .and_then(Value::as_array)
                    .is_some_and(|c| {
                        c.iter().any(|c| {
                            c.get("certificateFile").and_then(Value::as_str) == Some(TLS_CERT_FILE)
                        })
                    })
                    .then_some(Certificate::Node),
            })
        }
        "reality" => {
            let rs = stream("realitySettings");
            let s = |k: &str| {
                rs.and_then(|r| r.get(k))
                    .and_then(Value::as_str)
                    .map(String::from)
            };
            Security::Reality(Reality {
                dest: s("dest"),
                server_names: rs
                    .and_then(|r| r.get("serverNames"))
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default(),
                private_key: s("privateKey"),
                short_ids: rs
                    .and_then(|r| r.get("shortIds"))
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                public_key: s("publicKey"),
                short_id: s("shortId"),
                fingerprint: s("fingerprint"),
            })
        }
        other => Security::Other {
            name: other.to_string(),
        },
    };
    Inbound {
        tag: inbound.get("tag").and_then(Value::as_str).map(String::from),
        port: inbound.get("port").map(Value::as_u64),
        protocol,
        transport: Transport { kind, fields },
        security,
    }
}

fn put_raw(obj: &mut Map<String, Value>, key: &str, v: &Raw) {
    if let Some(v) = v {
        obj.insert(key.into(), v.as_deref().map_or(Value::Null, |s| json!(s)));
    }
}

/// The xray inbound for a model (the templates' output).
pub fn render(ib: &Inbound) -> Value {
    // An unmanaged protocol keeps its own name (even one that happens to
    // spell a manifest id, e.g. "ss2022": fuzz `inbound_model`).
    let wire = match &ib.protocol {
        Protocol::Unmanaged { name } => name.as_str(),
        p => manifest::get()
            .protocol(p.id())
            .map(|p| p.wire.as_str())
            .unwrap_or(p.id()),
    };
    let mut settings = Map::new();
    match &ib.protocol {
        Protocol::Vless { flow, encryption } => {
            settings.insert("clients".into(), json!([]));
            put_raw(&mut settings, "decryption", encryption);
            if let Some(f) = flow {
                settings.insert("flow".into(), json!(f));
            }
        }
        Protocol::Vmess | Protocol::Trojan => {
            settings.insert("clients".into(), json!([]));
        }
        Protocol::Ss2022 {
            method, psk, l4, ..
        } => {
            settings.insert("method".into(), json!(method));
            settings.insert("password".into(), json!(psk));
            settings.insert("clients".into(), json!([]));
            put_raw(&mut settings, "network", l4);
        }
        Protocol::Hysteria2 { version } => {
            settings.insert("version".into(), json!(version));
            settings.insert("clients".into(), json!([]));
        }
        Protocol::Unmanaged { .. } => {}
    }
    let mut out = json!({ "protocol": wire, "settings": settings });
    if let Some(t) = &ib.tag {
        out["tag"] = json!(t);
    }
    if let Some(Some(p)) = ib.port {
        out["port"] = json!(p);
    }
    let mut stream = Map::new();
    let f = ib.transport.fields.clone().unwrap_or_default();
    let mut ts = Map::new();
    put_raw(&mut ts, "path", &f.path);
    let (network, key) = match &ib.transport.kind {
        TransportKind::Native if matches!(ib.protocol, Protocol::Ss2022 { .. }) => (None, None),
        TransportKind::Native => {
            if let Some(v) = f.version {
                ts.insert("version".into(), json!(v));
            }
            (Some(HYSTERIA_NETWORK), Some("hysteriaSettings"))
        }
        TransportKind::Tcp => (Some("tcp"), None),
        TransportKind::Ws => {
            if let Some(Some(h)) = &f.host {
                ts.insert("headers".into(), json!({ "Host": h }));
            }
            (Some("ws"), Some("wsSettings"))
        }
        TransportKind::HttpUpgrade => {
            put_raw(&mut ts, "host", &f.host);
            (Some("httpupgrade"), Some("httpupgradeSettings"))
        }
        TransportKind::Xhttp => {
            put_raw(&mut ts, "host", &f.host);
            put_raw(&mut ts, "mode", &f.mode);
            (Some("xhttp"), Some("xhttpSettings"))
        }
        TransportKind::Grpc => {
            put_raw(&mut ts, "serviceName", &f.service_name);
            (Some("grpc"), Some("grpcSettings"))
        }
        TransportKind::Other(n) => (Some(n.as_str()), None),
    };
    if let Some(n) = network {
        stream.insert("network".into(), json!(n));
    }
    if let Some(k) = key {
        stream.insert(k.into(), Value::Object(ts));
    }
    match &ib.security {
        Security::None => {}
        Security::Tls(t) => {
            stream.insert("security".into(), json!("tls"));
            let mut tls = json!({ "serverName": t.server_name, "alpn": t.alpn });
            if t.certificate.is_some() {
                tls["certificates"] =
                    json!([{ "certificateFile": TLS_CERT_FILE, "keyFile": TLS_KEY_FILE }]);
            }
            stream.insert("tlsSettings".into(), tls);
        }
        Security::Reality(r) => {
            stream.insert("security".into(), json!("reality"));
            stream.insert(
                "realitySettings".into(),
                json!({
                    "dest": r.dest,
                    "serverNames": r.server_names,
                    "privateKey": r.private_key,
                    "shortIds": r.short_ids,
                    // Panel-only (subscriptions): ignored by xray.
                    "publicKey": r.public_key,
                    "shortId": r.short_id,
                    "fingerprint": r.fingerprint,
                }),
            );
        }
        Security::Other { name } => {
            stream.insert("security".into(), json!(name));
        }
    }
    if !stream.is_empty() {
        out["streamSettings"] = Value::Object(stream);
    }
    out
}

/// The admin-facing reason for a fault, in terms of xray's inbound JSON.
pub fn explain(f: &Fault) -> String {
    let vision = super::VISION;
    match f {
        Fault::DuplicateKey(key) => format!(
            "duplicate key {key:?} (keys differing only in letter case are one key to xray)"
        ),
        Fault::ForeignNativeTransport => {
            "the hysteria transport is only for the hysteria protocol".into()
        }
        Fault::Port => "port must be a number 1-65535 (subscriptions advertise it)".into(),
        Fault::SecurityUnknown(s) => {
            format!("security {s:?} is not supported (none, tls, reality)")
        }
        Fault::TransportUnsupported(n) => {
            format!("transport {n:?} is not supported (tcp/raw, ws, httpupgrade, xhttp, grpc)")
        }
        Fault::NativeTransportRequired { protocol: "ss2022" } => {
            "shadowsocks runs on its own transport (no streamSettings.network)".into()
        }
        Fault::NativeTransportRequired { .. } => {
            "hysteria needs streamSettings.network \"hysteria\"".into()
        }
        Fault::Rule(id) => match id.as_str() {
            "reality_protocol" => "REALITY is only supported with vless".into(),
            "reality_transport" => "REALITY works with tcp/raw, xhttp or grpc".into(),
            "vision" => {
                format!("flow {vision} needs streamSettings.network tcp/raw with tls or reality")
            }
            other => manifest::get()
                .rule(other)
                .map(|r| r.doc.clone())
                .unwrap_or_else(|| format!("rule {other}")),
        },
        Fault::Path => "transport path must start with / and hold no spaces, quotes or #".into(),
        Fault::Host => "transport host must be a domain name".into(),
        Fault::Mode => format!(
            "xhttp mode must be one of {}",
            super::transport::XHTTP_MODES.join(", ")
        ),
        Fault::ServiceName => "grpc serviceName: letters, digits and -_./ only (<= 128)".into(),
        Fault::Encryption => {
            "vless settings.decryption must be \"none\" (VLESS encryption is not in subscriptions)"
                .into()
        }
        Fault::FlowUnsupported(other) => {
            format!("vless flow {other:?} is not supported (\"\" or {vision})")
        }
        Fault::MethodUnsupported => format!(
            "shadowsocks method must be a multi-user 2022 method: {} (2022-blake3-chacha20-poly1305 \
             has no multi-user server in xray; legacy methods have no per-user keys)",
            super::SS_METHODS.map(|(m, _)| m).join(", ")
        ),
        Fault::Psk { len, method } => {
            format!("shadowsocks settings.password must be a base64 {len}-byte key for {method}")
        }
        Fault::InlineUsers => {
            "shadowsocks settings.clients must be [] (users are managed by the panel)".into()
        }
        Fault::L4 => "shadowsocks settings.network must be tcp, udp or tcp,udp".into(),
        Fault::SecurityNotAllowed { protocol: "ss2022" } => {
            "shadowsocks takes no tls/reality".into()
        }
        Fault::SecurityNotAllowed { .. } => {
            "hysteria needs security \"tls\" (the node's certificate)".into()
        }
        Fault::ProtocolVersion => "hysteria settings.version must be 2".into(),
        Fault::TransportVersion => "streamSettings.hysteriaSettings.version must be 2".into(),
        Fault::SharedAuth => {
            "hysteriaSettings.auth must not be set (per-user auth is managed by the panel)".into()
        }
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

/// Validation of one stored/submitted inbound: xray's decoder rules first
/// (W14: xray decodes keys case-insensitively, so `tag` and `TAG` are one
/// field to it but two to literal-key checks; the `hysteria` network
/// belongs to Hysteria), then the kernel-neutral checks on the model.
pub fn check(inbound: &Value) -> Result<(), Fault> {
    if let Some(key) = case_fold_duplicate(inbound) {
        return Err(Fault::DuplicateKey(key));
    }
    let id = manifest::get()
        .protocol_by_wire(protocol(inbound))
        .map(|p| p.id.as_str());
    if network(inbound) == HYSTERIA_NETWORK && id != Some("hysteria2") {
        return Err(Fault::ForeignNativeTransport);
    }
    super::validate::check(&parse(inbound))
}

/// Which L4 protocols the inbound listens on: (tcp, udp). Managed
/// protocols: the manifest's `l4`; xray's dokodemo-door/tunnel: their
/// `settings.network`.
pub fn l4(inbound: &Value) -> (bool, bool) {
    let list = |n: &str| {
        let has = |x: &str| n.split(',').any(|p| p.trim().eq_ignore_ascii_case(x));
        (has("tcp"), has("udp"))
    };
    let proto = protocol(inbound);
    match manifest::get().protocol_by_wire(proto) {
        Some(p) => match p.l4.as_str() {
            "udp" => (false, true),
            "tcp" => (true, false),
            l4 => {
                let opt = l4.strip_prefix("option:").unwrap_or("");
                let default = p
                    .option(opt)
                    .and_then(|o| o.default.as_deref())
                    .unwrap_or("");
                list(str_at(inbound, &format!("/settings/{opt}")).unwrap_or(default))
            }
        },
        None if matches!(proto, "dokodemo-door" | "tunnel") => {
            list(str_at(inbound, "/settings/network").unwrap_or("tcp"))
        }
        None => (true, false),
    }
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

/// Does any inbound read the node's TLS certificate files?
pub fn needs_certificate(inbounds: &Value) -> bool {
    inbounds.as_array().is_some_and(|a| {
        a.iter().any(|i| {
            i.pointer("/streamSettings/tlsSettings/certificates")
                .and_then(Value::as_array)
                .is_some_and(|c| {
                    c.iter().any(|c| {
                        c.get("certificateFile").and_then(Value::as_str) == Some(TLS_CERT_FILE)
                    })
                })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The adapter's parse inverts its render on everything the templates
    /// produce (the model loses nothing a template sets), and validation
    /// of the model accepts it.
    #[test]
    fn parse_inverts_render_for_template_inbounds() {
        let specs: Vec<crate::nodetpl::InboundSpec> = serde_json::from_value(json!([
            {"template": "vless_reality", "port": 443},
            {"template": "vless_reality", "port": 444, "vision": false},
            {"template": "vless_reality_xhttp", "port": 445, "mode": "packet-up"},
            {"template": "vless_tls_vision", "port": 446},
            {"template": "vless_ws_tls", "port": 447},
            {"template": "vmess_ws", "port": 448},
            {"template": "vmess_ws", "port": 449, "tls": true},
            {"template": "vmess_tcp", "port": 450},
            {"template": "trojan_tls", "port": 451},
            {"template": "transport", "port": 452, "protocol": "vless", "network": "httpupgrade", "host": "h.example.com"},
            {"template": "transport", "port": 453, "protocol": "vmess", "network": "xhttp", "host": "h.example.com", "tls": true},
            {"template": "transport", "port": 454, "protocol": "trojan", "network": "grpc", "tls": true},
            {"template": "transport", "port": 455, "protocol": "vless", "network": "ws", "host": "h.example.com"},
            {"template": "shadowsocks_2022", "port": 456},
            {"template": "hysteria2", "port": 443},
        ]))
        .unwrap();
        for s in &specs {
            let model = crate::nodetpl::build_one(s, Some("node.example.com")).unwrap();
            let json = render(&model);
            assert_eq!(parse(&json), model, "{json}");
            assert_eq!(render(&parse(&json)), json);
            assert_eq!(check(&json), Ok(()), "{json}");
        }
    }

    /// CI: the kernel-neutral layer (model, protocol/transport/security
    /// modules, validation, subscription proxies) names no xray field, and
    /// neither does the model's serialized form.
    #[test]
    fn model_has_no_kernel_field_names() {
        const XRAY: &[&str] = &[
            "streamSettings",
            "Settings\"",
            "realitySettings",
            "tlsSettings",
            "wsSettings",
            "httpupgradeSettings",
            "xhttpSettings",
            "splithttp",
            "grpcSettings",
            "hysteriaSettings",
            "serverNames",
            "shortIds",
            "privateKey",
            "publicKey",
            "shortId",
            "serviceName",
            "serverName",
            "certificateFile",
            "keyFile",
            "decryption",
            "clients",
            "dokodemo",
            "\"hysteria\"",
            "\"shadowsocks\"",
            "/run/credentials",
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let neutral = [
            "src/protocols/model.rs",
            "src/protocols/validate.rs",
            "src/protocols/transport.rs",
            "src/protocols/security.rs",
            "src/protocols/protocol/mod.rs",
            "src/protocols/protocol/vless.rs",
            "src/protocols/protocol/vmess.rs",
            "src/protocols/protocol/trojan.rs",
            "src/protocols/protocol/ss2022.rs",
            "src/protocols/protocol/hysteria2.rs",
            "src/sub/proxy.rs",
        ];
        for f in neutral {
            let src = std::fs::read_to_string(root.join(f)).unwrap();
            // Only code: doc comments may name what they replace.
            let code: String = src
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            for x in XRAY {
                assert!(!code.contains(x), "{f} names the xray field {x}");
            }
        }
        let model = crate::nodetpl::build_one(
            &serde_json::from_value(json!({"template": "vless_reality", "port": 443})).unwrap(),
            None,
        )
        .unwrap();
        let ser = serde_json::to_string(&model).unwrap();
        for x in XRAY {
            assert!(!ser.contains(x), "serialized model names {x}: {ser}");
        }
    }
}
