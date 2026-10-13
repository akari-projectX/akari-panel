//! sing-box format (a complete client configuration for sing-box 1.12+,
//! the SFA/SFI/SFM apps' remote profile): DNS (`dns.rs`), a TUN and a
//! local mixed inbound, the user's routing groups (`groups.rs`) as
//! selector / urltest outbounds, the proxies, direct, and the routing
//! (`routing.rs`) as route rules and remote rule sets.
//!
//! sing-box has no `fallback` group: a service's 推荐 group is a urltest
//! over the same chain (the fastest working line, not the first one).
//! Remote rule-set links are Clash-format lists sing-box cannot load: the
//! panel hosts a converted copy (`rulesets`) and the profile references
//! that as a remote `source` rule set; a link without a usable copy is
//! left out (logged).
//! Renders the neutral client proxies (`proxy.rs`).

use serde_json::{Value, json};

use super::dns::{self, sing_box_server};
use super::groups::{self, Kind, Member, Plan, TEST_INTERVAL, TEST_URL};
use super::proxy::{Proxy, log_omitted};
use super::routing::{DnsMode, Matcher, Routing, Target};
use super::rulesets::Hosted;

const DIRECT: &str = "direct";

pub(crate) fn render_sing_box(proxies: &[Proxy], routing: &Routing, hosted: &Hosted) -> Value {
    let kept: Vec<&Proxy> = proxies
        .iter()
        .filter(|p| match p.omitted_from("sing-box") {
            Some(why) => {
                log_omitted(p, "sing-box", why);
                false
            }
            None => true,
        })
        .collect();
    let lines: Vec<groups::Line<'_>> = kept.iter().map(|p| groups::Line::from(*p)).collect();
    let plan = groups::plan(&lines, routing);
    let outbounds: Vec<Value> = kept
        .iter()
        .map(|p| {
            let kind = match p.protocol {
                "ss2022" => "shadowsocks",
                other => other,
            };
            let mut obj = serde_json::Map::new();
            obj.insert("tag".into(), json!(p.name));
            obj.insert("type".into(), json!(kind));
            obj.insert("server".into(), json!(p.server));
            obj.insert("server_port".into(), json!(p.net.port));
            match p.protocol {
                "vless" | "vmess" => {
                    obj.insert("uuid".into(), json!(p.id_or_password));
                    if p.protocol == "vless" && !p.flow.is_empty() {
                        obj.insert("flow".into(), json!(p.flow));
                    }
                }
                "trojan" => {
                    obj.insert("password".into(), json!(p.id_or_password));
                }
                "ss2022" => {
                    obj.insert("method".into(), json!(p.method));
                    obj.insert("password".into(), json!(p.id_or_password));
                    return Value::Object(obj);
                }
                "hysteria2" => {
                    obj.insert("password".into(), json!(p.id_or_password));
                    let mut tls = json!({"enabled": true, "alpn": ["h3"]});
                    if !p.net.sni.is_empty() {
                        tls["server_name"] = json!(p.net.sni);
                    }
                    obj.insert("tls".into(), tls);
                    return Value::Object(obj);
                }
                _ => {}
            }
            if p.net.security == "tls" || p.net.security == "reality" {
                let mut tls = json!({"enabled": true});
                if !p.net.sni.is_empty() {
                    tls["server_name"] = json!(p.net.sni);
                }
                if p.net.security == "reality" {
                    tls["utls"] = json!({
                        "enabled": true,
                        "fingerprint": p.net.fingerprint,
                    });
                    tls["reality"] = json!({
                        "enabled": true,
                        "public_key": p.net.public_key,
                        "short_id": p.net.short_id,
                    });
                }
                obj.insert("tls".into(), tls);
            }
            match p.net.network() {
                "ws" => {
                    let mut transport = json!({"type": "ws", "path": p.net.path});
                    if !p.net.host.is_empty() {
                        transport["headers"] = json!({"Host": p.net.host});
                    }
                    obj.insert("transport".into(), transport);
                }
                "httpupgrade" => {
                    let mut transport = json!({"type": "httpupgrade", "path": p.net.path});
                    if !p.net.host.is_empty() {
                        transport["host"] = json!(p.net.host);
                    }
                    obj.insert("transport".into(), transport);
                }
                "grpc" => {
                    obj.insert(
                        "transport".into(),
                        json!({"type": "grpc", "service_name": p.net.service_name}),
                    );
                }
                _ => {}
            }
            Value::Object(obj)
        })
        .collect();
    let fakeip =
        routing.config.dns.mode != DnsMode::Client && routing.config.dns.effective().fakeip;
    json!({
        "log": {"level": "warn"},
        "dns": dns_section(routing, &plan),
        "inbounds": [
            {"type": "tun", "tag": "tun-in",
             "address": ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
             "auto_route": true, "strict_route": true},
            {"type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 2080},
        ],
        "outbounds": group_outbounds(&plan)
            .into_iter()
            .chain(outbounds)
            .chain(std::iter::once(json!({"type": "direct", "tag": DIRECT})))
            .collect::<Vec<Value>>(),
        "route": route(routing, &plan, hosted),
        "experimental": {"cache_file": if fakeip {
            json!({"enabled": true, "store_fakeip": true})
        } else {
            json!({"enabled": true})
        }},
    })
}

fn group_outbounds(plan: &Plan) -> Vec<Value> {
    plan.groups
        .iter()
        .map(|g| {
            let members: Vec<&str> = g
                .members
                .iter()
                .map(|m| match m {
                    Member::Name(n) => n.as_str(),
                    Member::Direct => DIRECT,
                })
                .collect();
            match g.kind {
                Kind::Select => json!({"type": "selector", "tag": g.name, "outbounds": members}),
                Kind::UrlTest | Kind::Fallback => json!({
                    "type": "urltest", "tag": g.name, "outbounds": members,
                    "url": TEST_URL, "interval": format!("{}s", TEST_INTERVAL),
                }),
            }
        })
        .collect()
}

/// Route rules (sniff, DNS hijack, then the routing's sections), the
/// remote rule sets they use (the lists, then the panel-hosted copies of
/// remote rule-set links), everything else to the default proxy.
fn route(routing: &Routing, plan: &Plan, hosted: &Hosted) -> Value {
    let mut remote: Vec<(String, String)> = Vec::new();
    let mut rules = vec![
        json!({"action": "sniff"}),
        json!({"protocol": "dns", "action": "hijack-dns"}),
    ];
    for (items, target) in routing.sections() {
        let to = match target {
            Target::Reject => None,
            Target::Direct => Some(DIRECT.to_string()),
            Target::Service(i) => match plan.services.get(i).cloned().flatten() {
                Some(n) => Some(n),
                None => continue,
            },
        };
        for it in items.iter() {
            for m in it.matchers() {
                let mut r = match m {
                    Matcher::List(k, n) => json!({"rule_set": [format!("{}-{n}", k.id())]}),
                    Matcher::Domain(v) => json!({"domain": [v]}),
                    Matcher::Suffix(v) => json!({"domain_suffix": [v]}),
                    Matcher::Keyword(v) => json!({"domain_keyword": [v]}),
                    Matcher::Cidr(v) => json!({"ip_cidr": [v]}),
                    Matcher::Remote { url, provider } => match hosted.url_of(url) {
                        Some(at) => {
                            if !remote.iter().any(|(t, _)| *t == provider) {
                                remote.push((provider.clone(), at.to_string()));
                            }
                            json!({"rule_set": [provider]})
                        }
                        None => {
                            tracing::info!(
                                provider = %provider,
                                "remote rule-set without a usable copy left out of the sing-box profile"
                            );
                            continue;
                        }
                    },
                };
                match &to {
                    Some(o) => r["outbound"] = json!(o),
                    None => r["action"] = json!("reject"),
                }
                rules.push(r);
            }
        }
    }
    let rule_set: Vec<Value> = routing
        .lists()
        .into_iter()
        .map(|(k, name)| {
            json!({"type": "remote", "tag": format!("{}-{name}", k.id()), "format": "binary",
                   "url": Routing::list_url(&routing.singbox_url, k, &name), "update_interval": "1d"})
        })
        .chain(remote.into_iter().map(|(tag, url)| {
            json!({"type": "remote", "tag": tag, "format": "source", "url": url,
                   "update_interval": "1d"})
        }))
        .collect();
    let mut route = json!({
        "rules": rules,
        "final": plan.default,
        "auto_detect_interface": true,
        "default_domain_resolver": "local",
    });
    if !rule_set.is_empty() {
        route["rule_set"] = json!(rule_set);
    }
    route
}

/// DNS: `local` = the first domestic server (the lines' own names via
/// `route.default_domain_resolver`, and the directly routed lists),
/// `remote` = the first foreign server through the default proxy; sing-box
/// takes one server per role, so later list entries are Clash-only. The
/// client mode: the system resolver only.
fn dns_section(routing: &Routing, plan: &Plan) -> Value {
    let d = routing.config.dns.effective();
    if d.mode == DnsMode::Client {
        return json!({"servers": [{"type": "local", "tag": "local"}], "final": "local"});
    }
    let mut servers = Vec::new();
    let local = dns::first(&d.cn);
    if local.as_ref().is_some_and(|s| s.ip().is_none()) {
        let boot = dns::bootstrap(&d);
        servers.push(json!({"type": "udp", "tag": "bootstrap", "server": boot[0]}));
    }
    servers.push(match &local {
        Some(s) => sing_box_server(s, "local", "bootstrap"),
        None => json!({"type": "local", "tag": "local"}),
    });
    servers.push(match dns::first(&d.intl) {
        Some(s) => {
            let mut r = sing_box_server(&s, "remote", "local");
            r["detour"] = json!(plan.default);
            r
        }
        None => json!({"type": "local", "tag": "remote"}),
    });
    let mut rules = Vec::new();
    let direct = routing.direct_geosites();
    if !direct.is_empty() {
        rules.push(json!({"rule_set": direct, "server": "local"}));
    }
    if d.fakeip {
        servers.push(json!({"type": "fakeip", "tag": "fakeip",
                            "inet4_range": "198.18.0.0/15", "inet6_range": "fc00::/18"}));
        rules.push(json!({"query_type": ["A", "AAAA"], "server": "fakeip"}));
    }
    let mut out = json!({"servers": servers, "final": "remote", "strategy": "prefer_ipv4"});
    if !rules.is_empty() {
        out["rules"] = json!(rules);
    }
    out
}
