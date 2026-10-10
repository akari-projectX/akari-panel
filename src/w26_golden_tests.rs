//! W26 P1: golden snapshots of everything the protocol layer produces, so
//! the refactor into protocol/transport/security modules + a kernel-neutral
//! model + the xray adapter (P3) is provably byte-identical:
//!
//! - template rendering (`nodetpl::render`): the xray inbound JSON stored in
//!   `nodes.inbound` (W28-a: one per node, no tag) and sent within
//!   `ConfigSnapshot.inbounds_json`, and every template error (code,
//!   message, params);
//! - credentials (`protocols::generate_account`/`refit_account`,
//!   `entitle::{eligible_protocol, fit_account}`): the `account_json` the
//!   agent receives;
//! - state hash inputs and outputs (`grpc::state_hash` over the above);
//! - the three subscription formats (`sub::render_for`), full bodies;
//! - validation (`protocols::check_inbound`, `api::normalize_inbound`,
//!   `api::inbound_warning`, `protocols::{port_clash, l4, issuable}`).
//!
//! Randomness comes from fixed seeds (`entropy::seeded`). The golden files
//! live in `testdata/w26/`; `AKARI_UPDATE_GOLDEN=1 cargo test w26_golden`
//! rewrites them — only ever on purpose, with the diff reviewed: a changed
//! golden file is a changed client-facing or agent-facing output.

use serde_json::{Value, json};

use crate::auth::ApiError;
use crate::entropy::seeded;
use crate::nodetpl::{InboundSpec, render};
use crate::pb::{InboundUser, UserOp};
use crate::sub::{NodeRow, render_for};

const NODE_DOMAIN: &str = "node.example.com";

fn golden_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/w26")
        .join(name)
}

/// Compare `actual` with the golden file byte for byte (or rewrite it).
fn check_golden(name: &str, actual: &str) {
    let path = golden_path(name);
    if std::env::var("AKARI_UPDATE_GOLDEN").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, actual).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (AKARI_UPDATE_GOLDEN=1 creates it)", path.display()));
    if want != actual {
        let (w, a): (Vec<&str>, Vec<&str>) = (want.lines().collect(), actual.lines().collect());
        let i = w
            .iter()
            .zip(&a)
            .position(|(x, y)| x != y)
            .unwrap_or(w.len().min(a.len()));
        panic!(
            "golden {name} differs at line {} ({} vs {} lines, {} vs {} bytes):\n want: {:?}\n  got: {:?}",
            i + 1,
            w.len(),
            a.len(),
            want.len(),
            actual.len(),
            w.get(i),
            a.get(i)
        );
    }
}

fn err_line(e: &ApiError) -> String {
    format!(
        "ERR {} {}: {} {}",
        e.status().as_u16(),
        e.code(),
        e.message(),
        Value::Object(e.params().clone())
    )
}

fn spec(v: Value) -> InboundSpec {
    serde_json::from_value(v).unwrap()
}

/// Template cases: (name, specs, taken ports, node TLS domain).
fn template_cases() -> Vec<(&'static str, Value, Vec<u16>, Option<&'static str>)> {
    let nd = Some(NODE_DOMAIN);
    let mut c: Vec<(&'static str, Value, Vec<u16>, Option<&'static str>)> = vec![
        (
            "vless_reality default",
            json!([{"template": "vless_reality", "port": 443}]),
            vec![],
            None,
        ),
        (
            "vless_reality no vision",
            json!([{"template": "vless_reality", "port": 443, "vision": false}]),
            vec![],
            None,
        ),
        (
            "vless_reality vision explicit",
            json!([{"template": "vless_reality", "port": 443, "vision": true}]),
            vec![],
            None,
        ),
        (
            "vless_reality custom dest/sni/fp",
            json!([{"template": "vless_reality", "port": 8443,
            "dest": "DL.Google.com:8443", "server_name": "Www.Example.COM", "fingerprint": "firefox"}]),
            vec![],
            None,
        ),
        (
            "vless_reality dest default port",
            json!([{"template": "vless_reality", "port": 443, "dest": "www.cloudflare.com"}]),
            vec![],
            None,
        ),
        (
            "vless_reality empty server_name",
            json!([{"template": "vless_reality", "port": 443, "server_name": "  "}]),
            vec![],
            None,
        ),
        (
            "vless_reality bad fingerprint",
            json!([{"template": "vless_reality", "port": 443, "fingerprint": "netscape"}]),
            vec![],
            None,
        ),
        (
            "vless_reality bad dest",
            json!([{"template": "vless_reality", "port": 443, "dest": "1.2.3.4"}]),
            vec![],
            None,
        ),
        (
            "vless_reality bad dest port",
            json!([{"template": "vless_reality", "port": 443, "dest": "a.example.com:0"}]),
            vec![],
            None,
        ),
        (
            "vless_reality bad server_name",
            json!([{"template": "vless_reality", "port": 443, "server_name": "a b"}]),
            vec![],
            None,
        ),
        (
            "vless_reality port 0",
            json!([{"template": "vless_reality", "port": 0}]),
            vec![],
            None,
        ),
        (
            "vless_reality with a tag (D2: refused)",
            json!([{"template": "vless_reality", "port": 443, "tag": "_x"}]),
            vec![],
            None,
        ),
        (
            "vless_reality_xhttp default",
            json!([{"template": "vless_reality_xhttp", "port": 443}]),
            vec![],
            None,
        ),
        (
            "vless_reality_xhttp path + fp",
            json!([{"template": "vless_reality_xhttp", "port": 443, "path": "/x-h_t.t~p", "fingerprint": "safari"}]),
            vec![],
            None,
        ),
        (
            "vless_reality_xhttp bad mode",
            json!([{"template": "vless_reality_xhttp", "port": 443, "mode": "fast"}]),
            vec![],
            None,
        ),
        (
            "vless_reality_xhttp bad path",
            json!([{"template": "vless_reality_xhttp", "port": 443, "path": "nope"}]),
            vec![],
            None,
        ),
        (
            "vless_tls_vision node domain",
            json!([{"template": "vless_tls_vision", "port": 443}]),
            vec![],
            nd,
        ),
        (
            "vless_tls_vision explicit domain",
            json!([{"template": "vless_tls_vision", "port": 443, "domain": "A.Example.com"}]),
            vec![],
            None,
        ),
        (
            "vless_tls_vision same as node",
            json!([{"template": "vless_tls_vision", "port": 443, "domain": NODE_DOMAIN}]),
            vec![],
            nd,
        ),
        (
            "vless_tls_vision mismatch",
            json!([{"template": "vless_tls_vision", "port": 443, "domain": "other.example.com"}]),
            vec![],
            nd,
        ),
        (
            "vless_tls_vision missing domain",
            json!([{"template": "vless_tls_vision", "port": 443}]),
            vec![],
            None,
        ),
        (
            "vless_tls_vision bad domain",
            json!([{"template": "vless_tls_vision", "port": 443, "domain": "-x-"}]),
            vec![],
            None,
        ),
        (
            "vless_ws_tls",
            json!([{"template": "vless_ws_tls", "port": 443, "path": "/ws"}]),
            vec![],
            nd,
        ),
        (
            "vless_ws_tls default path",
            json!([{"template": "vless_ws_tls", "port": 443, "domain": "w.example.com"}]),
            vec![],
            None,
        ),
        (
            "vmess_ws plain",
            json!([{"template": "vmess_ws", "port": 8080}]),
            vec![],
            None,
        ),
        (
            "vmess_ws tls node",
            json!([{"template": "vmess_ws", "port": 8443, "tls": true, "path": "/vm"}]),
            vec![],
            nd,
        ),
        (
            "vmess_ws tls_domain",
            json!([{"template": "vmess_ws", "port": 8443, "tls_domain": "v.example.com"}]),
            vec![],
            None,
        ),
        (
            "vmess_ws tls false + domain",
            json!([{"template": "vmess_ws", "port": 8443, "tls": false, "tls_domain": "v.example.com"}]),
            vec![],
            None,
        ),
        (
            "vmess_ws tls missing domain",
            json!([{"template": "vmess_ws", "port": 8443, "tls": true}]),
            vec![],
            None,
        ),
        (
            "vmess_tcp",
            json!([{"template": "vmess_tcp", "port": 10086, "tag": "vm"}]),
            vec![],
            None,
        ),
        (
            "trojan_tls",
            json!([{"template": "trojan_tls", "port": 443}]),
            vec![],
            nd,
        ),
        (
            "trojan_tls explicit",
            json!([{"template": "trojan_tls", "port": 443, "domain": "t.example.com"}]),
            vec![],
            None,
        ),
        (
            "ss2022 default",
            json!([{"template": "shadowsocks_2022", "port": 8388}]),
            vec![],
            None,
        ),
        (
            "ss2022 aes-256",
            json!([{"template": "shadowsocks_2022", "port": 8388, "method": "2022-blake3-aes-256-gcm"}]),
            vec![],
            None,
        ),
        (
            "ss2022 blank method",
            json!([{"template": "shadowsocks_2022", "port": 8388, "method": " "}]),
            vec![],
            None,
        ),
        (
            "ss2022 chacha refused",
            json!([{"template": "shadowsocks_2022", "port": 8388, "method": "2022-blake3-chacha20-poly1305"}]),
            vec![],
            None,
        ),
        (
            "hysteria2",
            json!([{"template": "hysteria2", "port": 443}]),
            vec![],
            nd,
        ),
        (
            "hysteria2 explicit",
            json!([{"template": "hysteria2", "port": 8443, "domain": "h.example.com"}]),
            vec![],
            None,
        ),
        (
            "hysteria2 shares tcp 443",
            json!([{"template": "vless_reality", "port": 443}, {"template": "hysteria2", "port": 443}]),
            vec![],
            nd,
        ),
        (
            "ss2022 clashes with hysteria2",
            json!([{"template": "shadowsocks_2022", "port": 443}, {"template": "hysteria2", "port": 443}]),
            vec![],
            nd,
        ),
        (
            "two tcp on one port",
            json!([{"template": "vless_reality", "port": 443}, {"template": "vmess_tcp", "port": 443}]),
            vec![],
            None,
        ),
        (
            "taken port",
            json!([{"template": "vmess_tcp", "port": 443}]),
            vec![443],
            None,
        ),
        (
            "taken port udp too",
            json!([{"template": "hysteria2", "port": 443}]),
            vec![443],
            nd,
        ),
        (
            "duplicate tag",
            json!([{"template": "vmess_tcp", "port": 1, "tag": "a"}, {"template": "vmess_tcp", "port": 2, "tag": "a"}]),
            vec![],
            None,
        ),
        (
            "too many",
            Value::Array(
                (1..=17)
                    .map(|p| json!({"template": "vmess_tcp", "port": p}))
                    .collect(),
            ),
            vec![],
            None,
        ),
        (
            "transport bad protocol",
            json!([{"template": "transport", "port": 443, "protocol": "socks", "network": "ws"}]),
            vec![],
            None,
        ),
        (
            "transport bad network",
            json!([{"template": "transport", "port": 443, "protocol": "vless", "network": "kcp"}]),
            vec![],
            None,
        ),
        (
            "transport trojan no tls",
            json!([{"template": "transport", "port": 443, "protocol": "trojan", "network": "ws"}]),
            vec![],
            None,
        ),
        (
            "transport grpc no tls",
            json!([{"template": "transport", "port": 443, "protocol": "vless", "network": "grpc"}]),
            vec![],
            None,
        ),
        (
            "transport tls false + domain",
            json!([{"template": "transport", "port": 443, "protocol": "vless", "network": "ws", "tls": false, "tls_domain": "a.example.com"}]),
            vec![],
            None,
        ),
        (
            "transport bad host",
            json!([{"template": "transport", "port": 443, "protocol": "vless", "network": "ws", "host": "a b"}]),
            vec![],
            None,
        ),
        (
            "transport bad service name",
            json!([{"template": "transport", "port": 443, "protocol": "vless", "network": "grpc", "tls": true, "service_name": "a/b"}]),
            vec![],
            nd,
        ),
        (
            "transport grpc long service name",
            json!([{"template": "transport", "port": 443, "protocol": "vless", "network": "grpc", "tls": true, "service_name": "s".repeat(65)}]),
            vec![],
            nd,
        ),
        (
            "transport upper-case protocol/network",
            json!([{"template": "transport", "port": 443, "protocol": " VLESS ", "network": "WS"}]),
            vec![],
            None,
        ),
        (
            "transport xhttp mode packet-up",
            json!([{"template": "transport", "port": 443, "protocol": "vless", "network": "xhttp", "mode": "packet-up", "path": "/p"}]),
            vec![],
            None,
        ),
        (
            "transport xhttp mode stream-up",
            json!([{"template": "transport", "port": 443, "protocol": "vless", "network": "xhttp", "mode": "stream-up"}]),
            vec![],
            None,
        ),
        (
            "transport xhttp mode stream-one",
            json!([{"template": "transport", "port": 443, "protocol": "vless", "network": "xhttp", "mode": "stream-one"}]),
            vec![],
            None,
        ),
    ];
    // Every protocol x network x tls of the transport template.
    let names: &[&'static str] = &[
        "transport vless ws",
        "transport vless ws tls",
        "transport vless httpupgrade",
        "transport vless httpupgrade tls",
        "transport vless xhttp",
        "transport vless xhttp tls",
        "transport vless grpc",
        "transport vless grpc tls",
        "transport vmess ws",
        "transport vmess ws tls",
        "transport vmess httpupgrade",
        "transport vmess httpupgrade tls",
        "transport vmess xhttp",
        "transport vmess xhttp tls",
        "transport vmess grpc",
        "transport vmess grpc tls",
        "transport trojan ws",
        "transport trojan ws tls",
        "transport trojan httpupgrade",
        "transport trojan httpupgrade tls",
        "transport trojan xhttp",
        "transport trojan xhttp tls",
        "transport trojan grpc",
        "transport trojan grpc tls",
    ];
    let mut i = 0;
    for proto in ["vless", "vmess", "trojan"] {
        for net in ["ws", "httpupgrade", "xhttp", "grpc"] {
            for tls in [false, true] {
                let mut s = json!({"template": "transport", "port": 2000 + i, "protocol": proto, "network": net});
                if tls {
                    s["tls"] = json!(true);
                }
                if net != "grpc" {
                    s["host"] = json!("CDN.Example.com");
                }
                c.push((names[i as usize], Value::Array(vec![s]), vec![], nd));
                i += 1;
            }
        }
    }
    c.push((
        "transport explicit everything",
        json!([{"template": "transport", "port": 443, "tag": "t1", "protocol": "trojan", "network": "grpc",
                "service_name": "svc.name-1_x", "tls_domain": NODE_DOMAIN}]),
        vec![],
        nd,
    ));
    c
}

/// Each spec of a case on its own (D2: one inbound per node), against the
/// case's taken ports; a spec the API would refuse to parse (e.g. a `tag`)
/// says so.
#[test]
fn w26_golden_templates() {
    let mut out = String::new();
    for (i, (name, specs, taken, nd)) in template_cases().into_iter().enumerate() {
        let seed = 1000 + i as u64;
        out.push_str(&format!("== {name} (seed {seed})\n"));
        let specs = specs.as_array().cloned().unwrap_or_default();
        seeded(seed, || {
            for raw in &specs {
                match serde_json::from_value::<InboundSpec>(raw.clone()) {
                    Err(e) => out.push_str(&format!("SPEC ERR {e}\n")),
                    Ok(spec) => match render(&spec, &taken, nd) {
                        Ok(ib) => {
                            out.push_str(&serde_json::to_string(&ib).unwrap());
                            out.push_str(&format!(
                                "\nneeds_certificate={} spec_needs_certificate={}\n",
                                crate::nodetpl::needs_certificate(&Value::Array(vec![ib])),
                                spec.needs_certificate()
                            ));
                        }
                        Err(e) => {
                            out.push_str(&err_line(&e));
                            out.push('\n');
                        }
                    },
                }
            }
        });
    }
    check_golden("templates.golden", &out);
}

/// Every template's inbound, tagged `t<i>` as if each were an inbound the
/// agent runs.
fn all_templates_inbounds() -> Vec<Value> {
    let specs = json!([
        {"template": "vless_reality", "port": 443},
        {"template": "vless_reality", "port": 444, "vision": false, "fingerprint": "ios"},
        {"template": "vless_reality_xhttp", "port": 445, "mode": "stream-one"},
        {"template": "vless_tls_vision", "port": 446},
        {"template": "vless_ws_tls", "port": 447, "path": "/vl"},
        {"template": "vmess_ws", "port": 448},
        {"template": "vmess_ws", "port": 449, "tls": true},
        {"template": "vmess_tcp", "port": 450},
        {"template": "trojan_tls", "port": 451},
        {"template": "transport", "port": 452, "protocol": "vless", "network": "httpupgrade", "tls": true, "host": "cdn.example.com"},
        {"template": "transport", "port": 453, "protocol": "vmess", "network": "xhttp"},
        {"template": "transport", "port": 454, "protocol": "trojan", "network": "grpc", "tls": true},
        {"template": "shadowsocks_2022", "port": 455},
        {"template": "shadowsocks_2022", "port": 456, "method": "2022-blake3-aes-256-gcm"},
        {"template": "hysteria2", "port": 443},
        {"template": "transport", "port": 457, "protocol": "vless", "network": "grpc", "tls": true, "service_name": "grpc-svc"},
    ]);
    let specs: Vec<InboundSpec> = specs
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .map(spec)
        .collect();
    seeded(1, || {
        specs
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let mut ib = render(s, &[], Some(NODE_DOMAIN)).unwrap();
                ib["tag"] = json!(format!("t{i}"));
                ib
            })
            .collect()
    })
}

/// Hand-written inbounds a node may also hold (legacy, unmanaged, edge).
fn hand_inbounds() -> Vec<Value> {
    serde_json::from_value(json!([
        {"tag": "dokodemo", "port": 9000, "protocol": "dokodemo-door", "settings": {"network": "tcp,udp"}},
        {"tag": "ss-legacy", "port": 9001, "protocol": "shadowsocks", "settings": {"method": "aes-128-gcm", "password": "x"}},
        {"tag": "vless-kcp", "port": 9002, "protocol": "vless", "streamSettings": {"network": "kcp"}},
        {"tag": "hy-bad", "port": 9003, "protocol": "hysteria", "settings": {"version": 1}},
        {"tag": "ss-tcp", "port": 9004, "protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm",
            "password": "AAAAAAAAAAAAAAAAAAAAAA==", "clients": [], "network": "tcp"}},
        {"tag": "vless-split", "port": 9005, "protocol": "vless", "settings": {"flow": "xtls-rprx-vision"},
            "streamSettings": {"network": "splithttp", "splithttpSettings": {"path": "/s"}}},
    ]))
    .unwrap()
}

fn user_id(i: u8) -> String {
    format!("0000000{i}-0000-4000-8000-00000000000{i}")
}

/// A credential: (inbound tag, protocol, account).
type Cred = (String, String, Value);

/// Credentials per user (entitle's path: one per inbound with an eligible
/// protocol, as every entrance has its own).
fn credentials_for(inbounds: &Value, users: u8) -> Vec<(String, Vec<Cred>)> {
    (1..=users)
        .map(|u| {
            let creds = seeded(100 + u as u64, || {
                inbounds
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|ib| {
                        let proto = crate::entitle::eligible_protocol(Some(ib))?;
                        let account = crate::entitle::fit_account(None, proto, ib)
                            .unwrap()
                            .unwrap();
                        Some((
                            ib["tag"].as_str().unwrap().to_string(),
                            proto.to_string(),
                            account,
                        ))
                    })
                    .collect()
            });
            (user_id(u), creds)
        })
        .collect()
}

#[test]
fn w26_golden_accounts() {
    let mut out = String::new();
    let mut inbounds = all_templates_inbounds();
    inbounds.extend(hand_inbounds());
    out.push_str("== generate_account / issuable / l4 per inbound\n");
    for (i, ib) in inbounds.iter().enumerate() {
        let tag = ib["tag"].as_str().unwrap();
        let acc = seeded(500 + i as u64, || crate::protocols::generate_account(ib));
        let (t, u) = crate::protocols::l4(ib);
        out.push_str(&format!(
            "{tag}: issuable={} l4=({t},{u}) account={}\n",
            crate::protocols::issuable(ib),
            match acc {
                Ok(a) => a.to_string(),
                Err(e) => format!("ERR {e}"),
            }
        ));
    }
    let arr = Value::Array(inbounds.clone());
    out.push_str("== eligible_protocol\n");
    for ib in &inbounds {
        if let Some(p) = crate::entitle::eligible_protocol(Some(ib)) {
            out.push_str(&format!("{} {p}\n", ib["tag"].as_str().unwrap()));
        }
    }
    out.push_str("== fit_account, new (2 users)\n");
    for (u, creds) in credentials_for(&arr, 2) {
        for (tag, proto, account) in creds {
            out.push_str(&format!("{u} {tag} {proto} {account}\n"));
        }
    }
    out.push_str("== refit_account\n");
    let vision = json!({"protocol": "vless", "settings": {"flow": "xtls-rprx-vision"}});
    let plain = json!({"protocol": "vless"});
    let s128 =
        json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm"}});
    let s256 =
        json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-256-gcm"}});
    let k16 = json!({"password": "AAECAwQFBgcICQoLDA0ODw=="});
    let cases = [
        (
            "vless gains vision",
            &vision,
            json!({"id": "x", "flow": ""}),
        ),
        (
            "vless keeps vision",
            &vision,
            json!({"id": "x", "flow": "xtls-rprx-vision"}),
        ),
        (
            "vless loses vision",
            &plain,
            json!({"id": "x", "flow": "xtls-rprx-vision"}),
        ),
        ("vless no flow key", &plain, json!({"id": "x"})),
        ("ss fits 128", &s128, k16.clone()),
        ("ss 128 key on 256", &s256, k16.clone()),
        ("ss garbage key", &s128, json!({"password": "%%%"})),
        ("ss no password", &s128, json!({})),
        (
            "vmess untouched",
            &json!({"protocol": "vmess"}),
            json!({"id": "y"}),
        ),
        (
            "unknown method",
            &json!({"protocol": "shadowsocks", "settings": {"method": "aes-128-gcm"}}),
            k16.clone(),
        ),
    ];
    for (i, (name, ib, acc)) in cases.iter().enumerate() {
        let r = seeded(900 + i as u64, || crate::protocols::refit_account(ib, acc));
        out.push_str(&format!(
            "{name}: {}\n",
            r.map(|v| v.to_string()).unwrap_or_else(|| "None".into())
        ));
    }
    out.push_str("== fit_account, kept (set_inbound path)\n");
    let by_tag = |t: &str| {
        inbounds
            .iter()
            .find(|i| i["tag"] == t)
            .cloned()
            .unwrap_or(Value::Null)
    };
    let stored = [
        (
            "t0",
            "vless",
            json!({"id": "11111111-1111-4111-8111-111111111111", "flow": ""}),
        ),
        (
            "t1",
            "vless",
            json!({"id": "22222222-2222-4222-8222-222222222222", "flow": "xtls-rprx-vision"}),
        ),
        ("t13", "shadowsocks", k16.clone()),
        (
            "t0",
            "vmess",
            json!({"id": "33333333-3333-4333-8333-333333333333"}),
        ),
    ];
    seeded(77, || {
        for (tag, proto, account) in &stored {
            let ib = by_tag(tag);
            let want = crate::entitle::eligible_protocol(Some(&ib)).unwrap();
            let r = crate::entitle::fit_account(Some((proto, account)), want, &ib).unwrap();
            out.push_str(&format!(
                "{tag} {proto} -> {}\n",
                r.map(|v| v.to_string()).unwrap_or_else(|| "kept".into())
            ));
        }
    });
    check_golden("accounts.golden", &out);
}

#[test]
fn w26_golden_state_hash() {
    let mut out = String::new();
    let mut inbounds = all_templates_inbounds();
    inbounds.extend(hand_inbounds());
    let arr = Value::Array(inbounds);
    // As desired_state sends it.
    let inbounds_json = serde_json::to_string(&arr).unwrap();
    let ops: Vec<UserOp> = credentials_for(&arr, 3)
        .into_iter()
        .map(|(u, creds)| UserOp {
            op: crate::pb::user_op::Op::Add as i32,
            user_id: u,
            inbound_users: creds
                .into_iter()
                .map(|(tag, protocol, account)| InboundUser {
                    inbound_tag: tag,
                    account_json: account.to_string(),
                    protocol,
                })
                .collect(),
            speed_limit_bytes_per_sec: 0,
        })
        .collect();
    out.push_str("== inbounds_json\n");
    out.push_str(&inbounds_json);
    out.push('\n');
    out.push_str("== users (user_id inbound_tag protocol account_json)\n");
    for op in &ops {
        for iu in &op.inbound_users {
            out.push_str(&format!(
                "{} {} {} {}\n",
                op.user_id, iu.inbound_tag, iu.protocol, iu.account_json
            ));
        }
    }
    let state = crate::grpc::NodeState::of_snapshot(inbounds_json.clone(), &ops);
    out.push_str("== state_hash\n");
    for v in [0u64, 1, 7, u64::MAX] {
        out.push_str(&format!("v{v} {}\n", crate::grpc::state_hash(v, &state)));
    }
    let empty = crate::grpc::NodeState::of_snapshot("[]".into(), &[]);
    out.push_str(&format!(
        "empty v0 {}\n",
        crate::grpc::state_hash(0, &empty)
    ));
    check_golden("state_hash.golden", &out);
}

/// One subscription row per credential whose inbound (by tag) exists.
fn rows(name: &str, server: Option<&str>, inbounds: &Value, creds: &[Cred]) -> Vec<NodeRow> {
    creds
        .iter()
        .filter_map(|(tag, protocol, account)| {
            let ib = inbounds
                .as_array()?
                .iter()
                .find(|i| i["tag"] == tag.as_str())?;
            Some(NodeRow {
                name: name.into(),
                display_name: None,
                tags: vec![],
                entrance: tag.clone(),
                name_rate_permille: None,
                inbound: ib.clone(),
                server: server.map(String::from),
                port: None,
                protocol: protocol.clone(),
                account: account.clone(),
            })
        })
        .collect()
}

/// Subscription fixtures: (name, rows).
fn sub_fixtures() -> Vec<(&'static str, Vec<NodeRow>)> {
    let mut inbounds = all_templates_inbounds();
    inbounds.extend(hand_inbounds());
    let arr = Value::Array(inbounds);
    let creds = credentials_for(&arr, 1).remove(0).1;
    let templates = rows("HK 1", Some("hk.example.com"), &arr, &creds);
    let mut named = rows("jp-1", Some("203.0.113.7"), &arr, &creds);
    for r in &mut named {
        r.display_name = Some("东京 01".into());
        r.tags = vec!["IPLC".into(), "0.5x".into()];
        // Entrance addresses: another host and port, or only a port.
        match r.entrance.as_str() {
            "t0" => {
                r.server = Some("relay.example.net".into());
                r.port = Some(30443);
            }
            "t12" => r.port = Some(18388),
            _ => {}
        }
    }
    // Single-credential nodes whose display name repeats (unique names);
    // the last has no address at all (left out).
    let one = |name: &str, server: Option<&str>| {
        let mut r = rows(name, server, &arr, &creds[8..9]);
        r[0].display_name = Some("Same".into());
        r
    };
    named.extend(one("a", Some("a.example.com")));
    named.extend(one("b", Some("nat.example.org")));
    named.extend(one("c", None));

    let edge_inbounds = json!([
        {"tag": "kcp", "protocol": "vless", "port": 1, "streamSettings": {"network": "kcp"}},
        {"tag": "split", "protocol": "vless", "port": 2, "streamSettings": {"network": "splithttp",
            "splithttpSettings": {"path": "/s p#?", "host": "h.example.com"}}},
        {"tag": "ws-hdr", "protocol": "vless", "port": 3, "streamSettings": {"network": "websocket",
            "wsSettings": {"headers": {"Host": "hdr.example.com"}}}},
        {"tag": "ws-both", "protocol": "vmess", "port": 4, "streamSettings": {"network": "ws",
            "wsSettings": {"path": "/w?ed=2048", "host": "host.example.com", "headers": {"Host": "hdr.example.com"}}}},
        {"tag": "hu", "protocol": "trojan", "port": 5, "streamSettings": {"network": "HTTPUpgrade", "security": "TLS",
            "httpupgradeSettings": {"path": ""}, "tlsSettings": {}}},
        {"tag": "vmx", "protocol": "vmess", "port": 6, "streamSettings": {"network": "xhttp",
            "xhttpSettings": {"path": "/vx", "host": "x.example.com", "mode": "packet-up"}}},
        {"tag": "vmg", "protocol": "vmess", "port": 7, "streamSettings": {"network": "grpc", "security": "tls",
            "grpcSettings": {"serviceName": "a b/c"}, "tlsSettings": {"serverName": "g.example.com"}}},
        {"tag": "rx-nofp", "protocol": "vless", "port": 8, "streamSettings": {"network": "raw", "security": "reality",
            "realitySettings": {"serverNames": [], "publicKey": "PK", "fingerprint": "bogus"}}},
        {"tag": "tls-vision", "protocol": "vless", "port": 9, "streamSettings": {"network": "tcp", "security": "tls",
            "tlsSettings": {"serverName": "v.example.com"}}},
        {"tag": "plain-vision", "protocol": "vless", "port": 10},
        {"tag": "port-str", "protocol": "vless", "port": "11"},
        {"tag": "no-port", "protocol": "vless"},
        {"tag": "big-port", "protocol": "vless", "port": 70000},
        {"tag": "ss-nopsk", "protocol": "shadowsocks", "port": 12, "settings": {"method": "2022-blake3-aes-128-gcm"}},
        {"tag": "ss-nomethod", "protocol": "shadowsocks", "port": 13, "settings": {"password": "AAAA"}},
        {"tag": "ss-tcp", "protocol": "shadowsocks", "port": 14, "settings": {"method": "2022-blake3-aes-128-gcm",
            "password": "AAAAAAAAAAAAAAAAAAAAAA==", "network": "tcp"}},
        {"tag": "ss-udp-only", "protocol": "shadowsocks", "port": 15, "settings": {"method": "2022-blake3-aes-256-gcm",
            "password": "pw", "network": " UDP "}},
        {"tag": "hy-nosni", "protocol": "hysteria", "port": 16, "streamSettings": {"network": "hysteria", "security": "tls"}},
        {"tag": "sec-weird", "protocol": "vless", "port": 17, "streamSettings": {"security": "xtls"}},
        {"tag": "tro-123", "protocol": "trojan", "port": 18},
        {"tag": "tro-colon", "protocol": "trojan", "port": 19},
        {"tag": "socks", "protocol": "socks", "port": 20},
        {"tag": "dup", "protocol": "vmess", "port": 21},
        {"tag": "grpc-empty", "protocol": "vless", "port": 22, "streamSettings": {"network": "grpc"}},
        {"tag": "xh-nomode", "protocol": "vless", "port": 23, "streamSettings": {"network": "xhttp", "security": "reality",
            "xhttpSettings": {"path": "/x"}, "realitySettings": {"serverNames": ["r.example.com"], "publicKey": "P", "shortId": ""}}},
    ]);
    let c = |tag: &str, protocol: &str, account: Value| -> Cred {
        (tag.into(), protocol.into(), account)
    };
    let edge_creds = vec![
        c("kcp", "vless", json!({"id": "a1", "flow": ""})),
        c(
            "split",
            "vless",
            json!({"id": "a2", "flow": "xtls-rprx-vision"}),
        ),
        c("ws-hdr", "vless", json!({"id": "a3"})),
        c("ws-both", "vmess", json!({"id": "a4"})),
        c("hu", "trojan", json!({"password": "p@ss word"})),
        c("vmx", "vmess", json!({"id": "a5"})),
        c("vmg", "vmess", json!({"id": "a6"})),
        c(
            "rx-nofp",
            "vless",
            json!({"id": "a7", "flow": "xtls-rprx-vision"}),
        ),
        c(
            "tls-vision",
            "vless",
            json!({"id": "a8", "flow": "xtls-rprx-vision"}),
        ),
        c(
            "plain-vision",
            "vless",
            json!({"id": "a9", "flow": "xtls-rprx-vision"}),
        ),
        c("port-str", "vless", json!({"id": "b1"})),
        c("no-port", "vless", json!({"id": "b2"})),
        c("big-port", "vless", json!({"id": "b3"})),
        c("ss-nopsk", "shadowsocks", json!({"password": "k"})),
        c("ss-nomethod", "shadowsocks", json!({"password": "k"})),
        c(
            "ss-tcp",
            "shadowsocks",
            json!({"password": "AQEBAQEBAQEBAQEBAQEBAQ=="}),
        ),
        c("ss-udp-only", "shadowsocks", json!({"password": "u"})),
        c("hy-nosni", "hysteria", json!({"auth": "a:b c"})),
        c("sec-weird", "vless", json!({"id": "b4"})),
        c("tro-123", "trojan", json!({"password": "123"})),
        c("tro-colon", "trojan", json!({"password": "true"})),
        c("socks", "socks", json!({"user": "x"})),
        c("dup", "vmess", json!({"id": "b6"})),
        c("dup", "vmess", json!({"id": "b7"})),
        c("grpc-empty", "vless", json!({"id": "b8"})),
        c("xh-nomode", "vless", json!({"id": "b9", "flow": ""})),
        c("kcp", "vmess", json!({})),
        c("tls-vision", "trojan", json!({"password": 5})),
    ];
    let mut edge = rows(
        "Edge: \"quoted\" - true",
        Some("edge.example.com"),
        &edge_inbounds,
        &edge_creds,
    );
    for r in &mut edge {
        if r.entrance == "kcp" {
            r.port = Some(65535);
        }
    }
    // An empty address is no address; an inbound that is not one is
    // nothing to render.
    edge.extend(rows(
        "no-server",
        Some(""),
        &edge_inbounds,
        &[c("dup", "vmess", json!({"id": "c1"}))],
    ));
    edge.push(NodeRow {
        name: "123".into(),
        display_name: None,
        tags: vec![],
        entrance: "a".into(),
        name_rate_permille: None,
        inbound: json!("not an inbound"),
        server: Some("x".into()),
        port: None,
        protocol: "vless".into(),
        account: json!({"id": "c2"}),
    });
    vec![
        ("templates", templates),
        ("named", named),
        ("edge", edge),
        ("empty", vec![]),
    ]
}

#[test]
fn w26_golden_subscriptions() {
    for (name, rows) in sub_fixtures() {
        for (fmt, query, ua) in [
            ("links", Some("format=links"), "x"),
            ("clash", Some("format=clash"), "x"),
            ("sing-box", Some("format=sing-box"), "x"),
            ("ua-clash", None, "clash.meta/1"),
        ] {
            let (ct, body) = render_for(query, ua, &rows, &crate::sub::routing::Routing::default());
            check_golden(
                &format!("sub_{name}.{fmt}.golden"),
                &format!("content-type: {ct}\n{body}"),
            );
            // The links body is base64; keep a readable copy as well.
            if fmt == "links" {
                use base64::Engine;
                let plain = base64::engine::general_purpose::STANDARD
                    .decode(body.trim_end())
                    .unwrap();
                check_golden(
                    &format!("sub_{name}.links-decoded.golden"),
                    &String::from_utf8(plain).unwrap(),
                );
            }
        }
    }
}

/// W30: which format each client's User-Agent gets (real UA strings of
/// the clients' current releases), and the routing template of Clash and
/// sing-box with custom rules and mirror URLs.
#[test]
fn w30_golden_client_formats() {
    let rows = &sub_fixtures()[0].1;
    let mut out = String::new();
    for ua in [
        "clash-verge/v2.2.3",
        "ClashMetaForAndroid/2.11.5.Meta",
        "FlClash/v0.8.80 clash-verge Platform/android",
        "mihomo.party/v1.7.3 (clash.meta)",
        "Stash/2.7.5 Clash/1.11.0",
        "SFA/1.12.0 (Android 14; sing-box 1.12.0; language zh_CN)",
        "SFI/1.12.0 (Apple iOS 18.1; sing-box 1.12.0; language zh_CN)",
        "sing-box 1.12.0",
        "HiddifyNext/2.5.7 (android) like ClashMeta v2ray sing-box",
        "Shadowrocket/2070 CFNetwork/1410.0.3 Darwin/22.4.0",
        "v2rayN/7.4.2",
        "v2rayNG/1.9.30",
        "NekoBox/Android/1.3.4 (Prefer ClashMeta Format)",
        "curl/8.5.0",
        "",
    ] {
        let (ct, _) = render_for(None, ua, rows, &crate::sub::routing::Routing::default());
        out.push_str(&format!("{ua:?} -> {ct}\n"));
    }
    check_golden("w30_client_formats.golden", &out);

    use crate::sub::routing::{Action, Match, Routing, Rule};
    let routing = Routing {
        rules: vec![
            Rule {
                kind: Match::DomainSuffix,
                value: "example.org".into(),
                action: Action::Proxy,
            },
            Rule {
                kind: Match::DomainKeyword,
                value: "tracker".into(),
                action: Action::Reject,
            },
            Rule {
                kind: Match::Domain,
                value: "intra.example.com".into(),
                action: Action::Direct,
            },
            Rule {
                kind: Match::IpCidr,
                value: "10.8.0.0/16".into(),
                action: Action::Direct,
            },
            Rule {
                kind: Match::IpCidr,
                value: "fd00::/8".into(),
                action: Action::Direct,
            },
            Rule {
                kind: Match::Geosite,
                value: "geolocation-!cn".into(),
                action: Action::Proxy,
            },
            Rule {
                kind: Match::Geoip,
                value: "cn".into(),
                action: Action::Direct,
            },
        ],
        clash_url: "https://mirror.example.net/{kind}/{name}.list".into(),
        singbox_url: "https://mirror.example.net/{kind}/{name}.srs".into(),
    };
    for (fmt, query) in [("clash", "format=clash"), ("sing-box", "format=sing-box")] {
        let (ct, body) = render_for(Some(query), "x", rows, &routing);
        check_golden(
            &format!("w30_custom_routing.{fmt}.golden"),
            &format!("content-type: {ct}\n{body}"),
        );
    }
    // No rules: only the final rule, no providers / rule sets.
    let none = Routing {
        rules: vec![],
        ..Routing::default()
    };
    let (_, clash) = render_for(Some("format=clash"), "x", rows, &none);
    assert!(
        clash.trim_end().ends_with("rules:\n  - MATCH,PROXY"),
        "{clash}"
    );
    assert!(!clash.contains("rule-providers"));
    let (_, sb) = render_for(Some("format=sing-box"), "x", rows, &none);
    let sb: Value = serde_json::from_str(sb.trim_end()).unwrap();
    assert!(sb["route"].get("rule_set").is_none());
    assert!(sb["dns"].get("rules").is_none());
}

/// Inbounds for the validation goldens: protocols.rs's matrix cases and
/// more (each mostly one fault).
fn validation_corpus() -> Vec<Value> {
    use base64::Engine;
    let b64 = |n: usize| base64::engine::general_purpose::STANDARD.encode(vec![1u8; n]);
    let (k16, k32) = (b64(16), b64(32));
    let ss = |method: &str, psk: &str| {
        json!({"tag": "s", "port": 8388, "protocol": "shadowsocks",
               "settings": {"method": method, "password": psk, "clients": [], "network": "tcp,udp"}})
    };
    let hy = |extra: Value| {
        let mut v = json!({"tag": "h", "port": 443, "protocol": "hysteria", "settings": {"version": 2, "clients": []},
            "streamSettings": {"network": "hysteria", "security": "tls", "hysteriaSettings": {"version": 2}}});
        for (k, val) in extra.as_object().unwrap() {
            v["streamSettings"]["hysteriaSettings"][k] = val.clone();
        }
        v
    };
    let mut v = vec![
        json!({"protocol": "vless"}),
        json!({"protocol": "vless", "port": 443, "settings": {"decryption": "none", "flow": "xtls-rprx-vision"},
               "streamSettings": {"network": "raw", "security": "reality"}}),
        json!({"protocol": "vless", "settings": {"flow": "xtls-rprx-vision"}, "streamSettings": {"network": "tcp", "security": "tls"}}),
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
        hy(json!({"auth": ""})),
        json!({"protocol": "dokodemo-door", "streamSettings": {"network": "kcp"}}),
        json!({"protocol": "vless", "port": 0}),
        json!({"protocol": "vless", "port": "443"}),
        json!({"protocol": "vless", "port": 70000}),
        json!({"protocol": "vless", "port": -1}),
        json!({"protocol": "vless", "port": 1.5}),
        json!({"protocol": "vless", "settings": {"flow": "xtls-rprx-vision"}, "streamSettings": {"network": "ws", "security": "tls"}}),
        json!({"protocol": "vless", "settings": {"flow": "xtls-rprx-vision"}}),
        json!({"protocol": "vless", "settings": {"flow": "xtls-rprx-direct"}}),
        json!({"protocol": "vless", "settings": {"decryption": "mlkem768x25519plus.native.0rtt.x"}}),
        json!({"protocol": "vless", "settings": {"decryption": null}}),
        json!({"protocol": "vmess", "streamSettings": {"security": "reality"}}),
        json!({"protocol": "trojan", "streamSettings": {"security": "reality"}}),
        json!({"protocol": "vless", "streamSettings": {"network": "ws", "security": "reality"}}),
        json!({"protocol": "vless", "streamSettings": {"network": "httpupgrade", "security": "reality"}}),
        json!({"protocol": "vless", "streamSettings": {"network": "kcp"}}),
        json!({"protocol": "vless", "streamSettings": {"network": "quic"}}),
        json!({"protocol": "vless", "streamSettings": {"security": "xtls"}}),
        json!({"protocol": "vless", "streamSettings": {"security": " TLS "}}),
        json!({"protocol": "vless", "streamSettings": {"security": ""}}),
        json!({"protocol": "vless", "streamSettings": {"network": " WebSocket "}}),
        json!({"protocol": "vless", "streamSettings": {"network": "ws", "wsSettings": {"path": "ws"}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "ws", "wsSettings": {"path": "/a b"}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "ws", "wsSettings": {"path": 5}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "ws", "wsSettings": {"path": format!("/{}", "a".repeat(256))}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "ws", "wsSettings": {"headers": {"Host": "a b"}}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "ws", "wsSettings": {"host": ""}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "xhttp", "xhttpSettings": {"mode": "fast"}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "xhttp", "xhttpSettings": {"mode": ""}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "xhttp", "xhttpSettings": {"mode": 1}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "splithttp", "splithttpSettings": {"mode": "x"}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "grpc", "grpcSettings": {"serviceName": "a b"}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "grpc", "grpcSettings": {"serviceName": "a/b.c-d_e"}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "httpupgrade", "httpupgradeSettings": {"host": "a b"}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "hysteria"}}),
        json!({"protocol": "vmess", "streamSettings": {"network": "hysteria"}}),
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
               "clients": [], "network": " "}}),
        json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm", "password": k16,
               "clients": [], "network": "UDP"}}),
        json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm", "password": k16,
               "clients": []}, "streamSettings": {"network": "ws"}}),
        json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm", "password": k16,
               "clients": []}, "streamSettings": {"security": "tls"}}),
        json!({"protocol": "shadowsocks", "settings": {"method": "2022-blake3-aes-128-gcm", "password": k16,
               "clients": []}, "streamSettings": {"security": "reality"}}),
        hy(json!({"auth": "shared-secret"})),
        hy(json!({"version": 1})),
        json!({"protocol": "hysteria", "settings": {"version": 2}, "streamSettings": {"network": "hysteria",
               "hysteriaSettings": {"version": 2}}}),
        json!({"protocol": "hysteria", "settings": {"version": 2}, "streamSettings": {"network": "tcp", "security": "tls"}}),
        json!({"protocol": "hysteria", "settings": {"version": 1}, "streamSettings": {"network": "hysteria", "security": "tls"}}),
        json!({"protocol": "hysteria", "settings": {"version": 2}, "streamSettings": {"network": "hysteria", "security": "reality"}}),
        json!({"protocol": "hysteria", "settings": {"version": 2}, "streamSettings": {"network": "hysteria", "security": "tls"}}),
        json!({"tag": "a", "TAG": "b", "protocol": "vless"}),
        json!({"tag": "a", "protocol": "vless", "\u{17f}ettings": {}, "settings": {}}),
        json!({"protocol": "VLESS", "streamSettings": {"network": "kcp"}}),
        // Two faults: which one is reported is part of the behaviour.
        json!({"protocol": "vless", "port": 0, "streamSettings": {"network": "kcp"}}),
        json!({"protocol": "vless", "settings": {"flow": "x"}, "streamSettings": {"network": "ws", "wsSettings": {"path": "bad"}}}),
        json!({"protocol": "vless", "settings": {"decryption": "x", "flow": "y"}}),
        json!({"protocol": "vmess", "streamSettings": {"network": "kcp", "security": "reality"}}),
        json!({"protocol": "shadowsocks", "settings": {"method": "x", "clients": [1]}, "streamSettings": {"security": "tls"}}),
        json!({"protocol": "hysteria", "settings": {"version": 1}, "streamSettings": {"network": "hysteria", "security": "none",
               "hysteriaSettings": {"auth": "x"}}}),
        json!({"protocol": "vless", "streamSettings": {"network": "grpc", "security": "reality", "grpcSettings": {"serviceName": "a b"}}}),
    ];
    // The templates' own output is valid by construction; include it.
    v.extend(all_templates_inbounds());
    v.extend(hand_inbounds());
    v
}

#[test]
fn w26_golden_validation() {
    let mut out = String::new();
    out.push_str("== check_inbound / issuable / l4\n");
    for ib in validation_corpus() {
        let (t, u) = crate::protocols::l4(&ib);
        out.push_str(&format!(
            "{}\n  -> {} | issuable={} l4=({t},{u})\n",
            ib,
            match crate::protocols::check_inbound(&ib) {
                Ok(()) => "ok".to_string(),
                Err(e) => format!("ERR {e}"),
            },
            crate::protocols::issuable(&ib),
        ));
    }
    out.push_str("== normalize_inbound\n");
    let cases = vec![
        json!({"not": "an inbound"}),
        json!([]),
        json!([{"protocol": "vless"}]),
        json!("vless"),
        json!({"protocol": "vless"}),
        json!({"tag": "", "protocol": "vless"}),
        json!({"tag": "api", "TAG": "akari-x", "protocol": "vless"}),
        json!({"tag": "a"}),
        json!({"tag": "a", "protocol": ""}),
        json!({"protocol": "fakedns"}),
        json!({"protocol": "vless", "sniffing": {"destOverride": ["http", "FakeDNS"]}}),
        json!({"protocol": "vless", "Sniffing": {"DESTOVERRIDE": "tls, fakedns+others"}}),
        json!({"tag": "fakedns-tag", "protocol": "vless", "sniffing": {"destOverride": ["http"]}}),
        json!({"protocol": "vless", "streamSettings": {"network": "kcp"}}),
    ];
    for l in cases.into_iter().chain(all_templates_inbounds()) {
        out.push_str(&format!(
            "{}\n  -> {}\n",
            l,
            match crate::api::normalize_inbound(&l) {
                Ok(v) => format!("ok {v}"),
                Err(e) => err_line(&e),
            }
        ));
    }
    out.push_str("== inbound_warning\n");
    let mut stored = hand_inbounds();
    stored.extend(validation_corpus().into_iter().take(30));
    for ib in &stored {
        if let Some(w) = crate::api::inbound_warning(ib) {
            out.push_str(&w);
            out.push('\n');
        }
    }
    out.push_str("== port_clash\n");
    for l in [
        json!([{"port": 443, "protocol": "vless"}, {"port": 443, "protocol": "hysteria"}]),
        json!([{"port": 443, "protocol": "shadowsocks"}, {"port": 443, "protocol": "hysteria"}]),
        json!([{"port": 443, "protocol": "shadowsocks", "settings": {"network": "tcp"}}, {"port": 443, "protocol": "hysteria"}]),
        json!([{"port": 443, "protocol": "tunnel", "settings": {"network": "udp"}}, {"port": 443, "protocol": "vless"}]),
        json!([{"port": 443, "protocol": "vless", "listen": "::"}, {"port": 443, "protocol": "vless", "listen": "1.1.1.1"}]),
        json!([{"port": "443", "protocol": "vless"}, {"port": "443", "protocol": "vless"}]),
    ] {
        out.push_str(&format!(
            "{} -> {:?}\n",
            l,
            crate::protocols::port_clash(l.as_array().unwrap())
        ));
    }
    check_golden("validation.golden", &out);
}
