//! W26 P2: the manifest describes the code. Table-driven over every
//! protocol x transport x security (x enum option value) of
//! `proto/protocols.toml`: the panel's validation accepts exactly the
//! combinations the manifest calls legal, issues credentials of the
//! manifest's shape, and each subscription format carries exactly what the
//! manifest says it supports.

use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

use super::manifest::{self, Manifest};

/// An xray inbound for a combination (test-side mapping of the neutral
/// names; `None` = the combination has no xray form distinct from another
/// one: Shadowsocks over "tcp" IS its native transport in xray).
fn xray_inbound(
    m: &Manifest,
    protocol: &str,
    transport: &str,
    security: &str,
    options: &BTreeMap<String, String>,
) -> Option<Value> {
    let p = m.protocol(protocol)?;
    let opt = |name: &str| -> String {
        options
            .get(name)
            .cloned()
            .or_else(|| p.option(name).and_then(|o| o.default.clone()))
            .unwrap_or_default()
    };
    let mut ib = json!({"tag": "t", "port": 443, "protocol": p.wire});
    ib["settings"] = match protocol {
        "vless" => json!({"clients": [], "decryption": "none", "flow": opt("flow")}),
        "ss2022" => {
            let method = opt("method");
            let n = p.option("method")?.key_len_of(&method)?;
            json!({"method": method, "password": STANDARD.encode(vec![7u8; n]),
                   "clients": [], "network": opt("network")})
        }
        "hysteria2" => json!({"version": 2, "clients": []}),
        _ => json!({"clients": []}),
    };
    let mut ss = serde_json::Map::new();
    match (protocol, transport) {
        ("ss2022", "native") => {}
        ("ss2022", "tcp") => return None,
        ("hysteria2", "native") | (_, "native") => {
            ss.insert("network".into(), json!("hysteria"));
            ss.insert("hysteriaSettings".into(), json!({"version": 2}));
        }
        (_, "tcp") => {
            ss.insert("network".into(), json!("tcp"));
        }
        (_, "ws") => {
            ss.insert("network".into(), json!("ws"));
            ss.insert(
                "wsSettings".into(),
                json!({"path": "/w", "headers": {"Host": "h.example.com"}}),
            );
        }
        (_, "httpupgrade") => {
            ss.insert("network".into(), json!("httpupgrade"));
            ss.insert(
                "httpupgradeSettings".into(),
                json!({"path": "/u", "host": "h.example.com"}),
            );
        }
        (_, "xhttp") => {
            ss.insert("network".into(), json!("xhttp"));
            ss.insert(
                "xhttpSettings".into(),
                json!({"path": "/x", "mode": "auto"}),
            );
        }
        (_, "grpc") => {
            ss.insert("network".into(), json!("grpc"));
            ss.insert("grpcSettings".into(), json!({"serviceName": "svc"}));
        }
        (_, other) => panic!("transport {other} has no test mapping: extend xray_inbound"),
    }
    match security {
        "none" => {}
        "tls" => {
            ss.insert("security".into(), json!("tls"));
            ss.insert("tlsSettings".into(), json!({"serverName": "n.example.com"}));
        }
        "reality" => {
            ss.insert("security".into(), json!("reality"));
            ss.insert(
                "realitySettings".into(),
                json!({"dest": "www.apple.com:443", "serverNames": ["www.apple.com"], "privateKey": "K",
                       "shortIds": ["ab"], "publicKey": "P", "shortId": "ab", "fingerprint": "chrome"}),
            );
        }
        other => panic!("security {other} has no test mapping: extend xray_inbound"),
    }
    if !ss.is_empty() {
        ib["streamSettings"] = Value::Object(ss);
    }
    Some(ib)
}

/// Every combination with each enum option of the protocol at each value
/// (the others at their default).
fn combinations(m: &Manifest) -> Vec<(String, String, String, BTreeMap<String, String>)> {
    let mut out = Vec::new();
    for p in &m.protocol {
        let mut option_sets = vec![BTreeMap::new()];
        for o in p.option.iter().filter(|o| o.kind == "enum") {
            for v in &o.values {
                option_sets.push(BTreeMap::from([(o.name.clone(), v.clone())]));
            }
        }
        for t in &m.transport {
            for s in &m.security {
                for opts in &option_sets {
                    out.push((p.id.clone(), t.id.clone(), s.id.clone(), opts.clone()));
                }
            }
        }
    }
    out
}

fn legal(m: &Manifest, p: &str, t: &str, s: &str, opts: &BTreeMap<String, String>) -> bool {
    m.protocol(p).is_some_and(|proto| proto.accepts(t, s))
        && m.violated_rule(p, t, s, opts).is_none()
}

#[test]
fn validation_accepts_exactly_the_legal_combinations() {
    let m = manifest::get();
    let mut checked = 0;
    for (p, t, s, opts) in combinations(m) {
        let Some(ib) = xray_inbound(m, &p, &t, &s, &opts) else {
            continue;
        };
        let want = legal(m, &p, &t, &s, &opts);
        let got = super::check_inbound(&ib);
        assert_eq!(
            got.is_ok(),
            want,
            "{p}/{t}/{s} {opts:?}: manifest legal={want}, check_inbound={got:?}\n{ib}"
        );
        // The panel issues credentials for every legal managed inbound.
        assert_eq!(
            super::issuable(&ib),
            want || !matches!(p.as_str(), "ss2022" | "hysteria2"),
            "{p}/{t}/{s}"
        );
        checked += 1;
    }
    assert!(checked > 100, "only {checked} combinations checked");
}

/// Accounts have exactly the manifest's credential keys and kinds.
#[test]
fn accounts_have_the_manifest_shape() {
    let m = manifest::get();
    for (p, t, s, opts) in combinations(m) {
        if !legal(m, &p, &t, &s, &opts) {
            continue;
        }
        let ib = xray_inbound(m, &p, &t, &s, &opts).unwrap();
        let proto = m.protocol(&p).unwrap();
        let acc = super::generate_account(&ib).unwrap();
        let keys: Vec<&str> = acc
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let want: Vec<&str> = proto.credential.iter().map(|c| c.field.as_str()).collect();
        assert_eq!(keys, want, "{p}: account keys");
        for c in &proto.credential {
            let v = acc[&c.field].as_str().unwrap();
            match c.kind.as_str() {
                "uuid" => assert!(uuid::Uuid::parse_str(v).is_ok(), "{p}.{}", c.field),
                "hex" => {
                    assert_eq!(v.len(), 2 * c.bytes.unwrap() as usize, "{p}.{}", c.field);
                    assert!(hex::decode(v).is_ok());
                }
                "base64_key" => {
                    let from = c.key_len_from.as_deref().unwrap();
                    let method = ib["settings"][from].as_str().unwrap();
                    let n = proto.option(from).unwrap().key_len_of(method).unwrap();
                    assert_eq!(STANDARD.decode(v).unwrap().len(), n, "{p}.{}", c.field);
                }
                "option" => {
                    let from = c.from.as_deref().unwrap();
                    assert_eq!(
                        v,
                        ib["settings"][from].as_str().unwrap_or(""),
                        "{p}.{}",
                        c.field
                    );
                }
                k => panic!("credential kind {k} not covered"),
            }
            if let Some(n) = c.min_len {
                assert!(v.len() >= n as usize);
            }
        }
    }
}

/// Each format carries a legal combination iff the manifest does not list
/// it as unsupported; the reason logged is the manifest's.
#[test]
fn subscription_formats_follow_the_manifest() {
    let m = manifest::get();
    let mut rows = Vec::new();
    let mut expect: Vec<(String, String, String, String)> = Vec::new();
    for (i, (p, t, s, opts)) in combinations(m).into_iter().enumerate() {
        if !legal(m, &p, &t, &s, &opts) {
            continue;
        }
        let mut ib = xray_inbound(m, &p, &t, &s, &opts).unwrap();
        let tag = format!("c{i}");
        ib["port"] = json!(1000 + i);
        rows.push(crate::sub::NodeRow {
            tags: vec![],
            entrance: format!("N {tag}"),
            name_rate_permille: None,
            account: super::generate_account(&ib).unwrap(),
            protocol: m.protocol(&p).unwrap().wire.clone(),
            inbound: ib,
            server: Some("n.example.com".into()),
            port: None,
        });
        expect.push((tag, p, t, s));
    }
    for f in &m.format {
        let (_, body) = crate::sub::render_for(
            Some(&format!("format={}", f.id)),
            "",
            &rows,
            &crate::sub::routing::Routing::default(),
        );
        let text = if f.id == "links" {
            String::from_utf8(STANDARD.decode(body.trim_end()).unwrap()).unwrap()
        } else {
            body
        };
        // vmess links carry the name inside base64 JSON: decode them.
        let text = text
            .lines()
            .map(|l| match l.strip_prefix("vmess://") {
                Some(b) => String::from_utf8(STANDARD.decode(b).unwrap()).unwrap(),
                None => l.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n");
        for (tag, p, t, s) in &expect {
            let present = text.contains(&format!("N {tag}\""))
                || text.contains(&format!("N%20{tag}\n"))
                || text.ends_with(&format!("N%20{tag}"));
            let want = m.unsupported_in(&f.id, p, t, s).is_none();
            assert_eq!(present, want, "format {} {p}/{t}/{s}", f.id);
        }
    }
}

/// The scenarios the agent's canary runs are valid panel inbounds that get
/// credentials.
#[test]
fn scenarios_are_valid_inbounds() {
    let m = manifest::get();
    assert!(!m.scenario.is_empty());
    for sc in &m.scenario {
        let ib = xray_inbound(m, &sc.protocol, &sc.transport, &sc.security, &sc.options).unwrap();
        assert_eq!(super::check_inbound(&ib), Ok(()), "{}", sc.name);
        assert!(super::issuable(&ib), "{}", sc.name);
    }
}

/// Field-level enum values the panel validates come from the manifest.
#[test]
fn enum_fields_match_validation() {
    let m = manifest::get();
    let xhttp = m
        .transport("xhttp")
        .unwrap()
        .field
        .iter()
        .find(|f| f.name == "mode")
        .unwrap();
    for mode in xhttp.values.iter().map(String::as_str).chain(["fast"]) {
        let ib = json!({"protocol": "vless", "streamSettings": {"network": "xhttp", "xhttpSettings": {"mode": mode}}});
        assert_eq!(
            super::check_inbound(&ib).is_ok(),
            xhttp.values.iter().any(|v| v == mode),
            "{mode}"
        );
    }
    let ss = m.protocol("ss2022").unwrap();
    let methods = ss.option("method").unwrap();
    for method in methods
        .values
        .iter()
        .map(String::as_str)
        .chain(["2022-blake3-chacha20-poly1305", "aes-128-gcm"])
    {
        let n = methods.key_len_of(method).unwrap_or(32);
        let ib = json!({"protocol": "shadowsocks", "settings": {"method": method,
            "password": STANDARD.encode(vec![1u8; n]), "clients": []}});
        assert_eq!(
            super::check_inbound(&ib).is_ok(),
            methods.key_len_of(method).is_some(),
            "{method}"
        );
    }
    let flows = &m.protocol("vless").unwrap().option("flow").unwrap().values;
    assert!(flows.iter().any(|f| f == super::VISION));
    for nw in ["tcp", "udp", "tcp,udp", "quic"] {
        let l4 = ss.option("network").unwrap();
        let ib = json!({"protocol": "shadowsocks", "settings": {"method": methods.values[0],
            "password": STANDARD.encode([1u8; 16]), "clients": [], "network": nw}});
        let ok = nw.split(',').all(|p| l4.values.iter().any(|v| v == p));
        assert_eq!(super::check_inbound(&ib).is_ok(), ok, "{nw}");
    }
}

/// L4 of every protocol follows the manifest.
#[test]
fn l4_follows_the_manifest() {
    let m = manifest::get();
    for p in &m.protocol {
        let ib = json!({"protocol": p.wire, "settings": {"network": "udp"}});
        let want = match p.l4.as_str() {
            "tcp" => (true, false),
            "udp" => (false, true),
            _ => (false, true), // option:network = "udp"
        };
        assert_eq!(super::l4(&ib), want, "{}", p.id);
    }
}
