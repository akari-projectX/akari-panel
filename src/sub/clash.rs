//! Clash (mihomo, Clash Verge, Stash) format: the DNS block (`dns.rs`), a
//! YAML proxy list, the user's routing groups (`groups.rs`: default proxy,
//! services with failover, region / tag groups) and the routing's
//! rule-providers and rules (`routing.rs`) ending with MATCH to the default
//! proxy. Renders the neutral client proxies (`proxy.rs`).

use super::groups::{self, Kind, Member, Plan, TEST_INTERVAL, TEST_URL};
use super::proxy::{Proxy, log_omitted, yaml};
use super::routing::{DnsMode, Kind as ListKind, Matcher, Routing, Target};

pub(crate) fn render_clash(proxies: &[Proxy], routing: &Routing) -> String {
    let kept: Vec<&Proxy> = proxies
        .iter()
        .filter(|p| match p.omitted_from("clash") {
            Some(why) => {
                log_omitted(p, "clash", why);
                false
            }
            None => true,
        })
        .collect();
    let lines: Vec<groups::Line<'_>> = kept.iter().map(|p| groups::Line::from(*p)).collect();
    let plan = groups::plan(&lines, routing);
    let (providers, rules) = rules(routing, &plan);
    let mut out = dns(routing, &providers);
    out.push_str("proxies:\n");
    for p in kept {
        let kind = match p.protocol {
            "ss2022" => "ss",
            other => other,
        };
        out.push_str("  - name: ");
        out.push_str(&serde_json::to_string(&p.name).unwrap_or_else(|_| "\"proxy\"".into()));
        out.push('\n');
        out.push_str(&format!("    type: {kind}\n"));
        out.push_str(&format!("    server: {}\n", p.server));
        out.push_str(&format!("    port: {}\n", p.net.port));
        match p.protocol {
            "vless" => {
                out.push_str(&format!("    uuid: {}\n", p.id_or_password));
                if !p.flow.is_empty() {
                    out.push_str(&format!("    flow: {}\n", p.flow));
                }
            }
            "vmess" => {
                out.push_str(&format!("    uuid: {}\n", p.id_or_password));
                out.push_str("    alterId: 0\n    cipher: auto\n");
            }
            "trojan" => {
                out.push_str(&format!("    password: {}\n", yaml(&p.id_or_password)));
            }
            "ss2022" => {
                out.push_str(&format!("    cipher: {}\n", p.method));
                out.push_str(&format!("    password: {}\n", yaml(&p.id_or_password)));
                out.push_str(&format!("    udp: {}\n", p.udp));
                continue;
            }
            "hysteria2" => {
                out.push_str(&format!("    password: {}\n", yaml(&p.id_or_password)));
                if !p.net.sni.is_empty() {
                    out.push_str(&format!("    sni: {}\n", p.net.sni));
                }
                out.push_str("    alpn:\n      - h3\n");
                continue;
            }
            _ => {}
        }
        // HTTPUpgrade is mihomo's websocket with v2ray-http-upgrade.
        let network = match p.net.network() {
            "httpupgrade" => "ws",
            n => n,
        };
        out.push_str(&format!("    network: {network}\n"));
        if p.net.security == "tls" || p.net.security == "reality" {
            out.push_str("    tls: true\n");
            if !p.net.sni.is_empty() {
                // mihomo reads the SNI of trojan from `sni` (vless/vmess:
                // `servername`); a wrong key silently falls back to the
                // server address, and verification fails (W10 smoke).
                let key = if p.protocol == "trojan" {
                    "sni"
                } else {
                    "servername"
                };
                out.push_str(&format!("    {key}: {}\n", p.net.sni));
            }
        }
        if !p.net.fingerprint.is_empty() {
            out.push_str(&format!("    client-fingerprint: {}\n", p.net.fingerprint));
        }
        if p.net.security == "reality" {
            out.push_str("    reality-opts:\n");
            out.push_str(&format!("      public-key: {}\n", p.net.public_key));
            if !p.net.short_id.is_empty() {
                out.push_str(&format!("      short-id: {}\n", p.net.short_id));
            }
        }
        match p.net.network() {
            "ws" | "httpupgrade" => {
                out.push_str("    ws-opts:\n");
                out.push_str(&format!("      path: {}\n", yaml(&p.net.path)));
                if !p.net.host.is_empty() {
                    out.push_str("      headers:\n");
                    out.push_str(&format!("        Host: {}\n", p.net.host));
                }
                if p.net.network() == "httpupgrade" {
                    out.push_str("      v2ray-http-upgrade: true\n");
                }
            }
            "xhttp" => {
                out.push_str("    xhttp-opts:\n");
                out.push_str(&format!("      path: {}\n", yaml(&p.net.path)));
                if !p.net.host.is_empty() {
                    out.push_str(&format!("      host: {}\n", p.net.host));
                }
                if !p.net.mode.is_empty() {
                    out.push_str(&format!("      mode: {}\n", p.net.mode));
                }
            }
            "grpc" => {
                out.push_str("    grpc-opts:\n");
                out.push_str(&format!(
                    "      grpc-service-name: {}\n",
                    yaml(&p.net.service_name)
                ));
            }
            _ => {}
        }
    }
    out.push_str(&proxy_groups(&plan));
    out.push_str(&providers_yaml(routing, &providers));
    out.push_str(&rules);
    out
}

fn quoted(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn member(m: &Member) -> String {
    match m {
        Member::Name(n) => quoted(n),
        Member::Direct => "DIRECT".into(),
    }
}

fn proxy_groups(plan: &Plan) -> String {
    let mut out = String::from("proxy-groups:\n");
    for g in &plan.groups {
        out.push_str(&format!("  - name: {}\n", quoted(&g.name)));
        let kind = match g.kind {
            Kind::Select => "select",
            Kind::UrlTest => "url-test",
            Kind::Fallback => "fallback",
        };
        out.push_str(&format!("    type: {kind}\n"));
        if g.hidden {
            out.push_str("    hidden: true\n");
        }
        if g.kind != Kind::Select {
            out.push_str(&format!(
                "    url: {TEST_URL}\n    interval: {TEST_INTERVAL}\n"
            ));
        }
        out.push_str("    proxies:\n");
        for m in &g.members {
            out.push_str(&format!("      - {}\n", member(m)));
        }
    }
    out
}

/// A rule line: plain when it cannot be misread as YAML syntax, else a
/// JSON-quoted scalar (group names may hold `#` or `:`).
fn rule_line(s: &str) -> String {
    if s.contains(['"', '\\', '#', ':', '\'']) || s.chars().any(char::is_control) {
        quoted(s)
    } else {
        s.to_string()
    }
}

/// A provider the rules use: a geosite/geoip list or a remote rule-set.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Provider {
    List(ListKind, String),
    Remote { name: String, url: String },
}

impl Provider {
    fn name(&self) -> String {
        match self {
            Provider::List(k, n) => format!("{}-{n}", k.id()),
            Provider::Remote { name, .. } => name.clone(),
        }
    }
}

/// The used providers (first-use order) and the `rules:` YAML.
fn rules(routing: &Routing, plan: &Plan) -> (Vec<Provider>, String) {
    let mut providers: Vec<Provider> = Vec::new();
    let mut out = String::from("rules:\n");
    for (items, target) in routing.sections() {
        let target = match target {
            Target::Reject => "REJECT".to_string(),
            Target::Direct => "DIRECT".to_string(),
            Target::Service(i) => match plan.services.get(i).cloned().flatten() {
                Some(n) => n,
                None => continue,
            },
        };
        for it in items.iter() {
            for m in it.matchers() {
                let line = match m {
                    Matcher::List(k, n) => {
                        let p = Provider::List(k, n.to_string());
                        let name = p.name();
                        if !providers.contains(&p) {
                            providers.push(p);
                        }
                        match k {
                            ListKind::Geosite => format!("RULE-SET,{name},{target}"),
                            ListKind::Geoip => format!("RULE-SET,{name},{target},no-resolve"),
                        }
                    }
                    Matcher::Remote { url, provider } => {
                        let p = Provider::Remote {
                            name: provider.clone(),
                            url: url.to_string(),
                        };
                        if !providers.contains(&p) {
                            providers.push(p);
                        }
                        format!("RULE-SET,{provider},{target}")
                    }
                    Matcher::Domain(v) => format!("DOMAIN,{v},{target}"),
                    Matcher::Suffix(v) => format!("DOMAIN-SUFFIX,{v},{target}"),
                    Matcher::Keyword(v) => format!("DOMAIN-KEYWORD,{v},{target}"),
                    Matcher::Cidr(v) if v.contains(':') => {
                        format!("IP-CIDR6,{v},{target},no-resolve")
                    }
                    Matcher::Cidr(v) => format!("IP-CIDR,{v},{target},no-resolve"),
                };
                out.push_str(&format!("  - {}\n", rule_line(&line)));
            }
        }
    }
    out.push_str(&format!(
        "  - {}\n",
        rule_line(&format!("MATCH,{}", plan.default))
    ));
    (providers, out)
}

fn providers_yaml(routing: &Routing, providers: &[Provider]) -> String {
    if providers.is_empty() {
        return String::new();
    }
    let mut out = String::from("rule-providers:\n");
    for p in providers {
        let (behavior, format, url) = match p {
            Provider::List(k, n) => (
                match k {
                    ListKind::Geosite => "domain",
                    ListKind::Geoip => "ipcidr",
                },
                "text",
                Routing::list_url(&routing.clash_url, *k, n),
            ),
            Provider::Remote { url, .. } => {
                let path = url.split(['?', '#']).next().unwrap_or_default();
                let yaml = path.ends_with(".yaml") || path.ends_with(".yml");
                ("classical", if yaml { "yaml" } else { "text" }, url.clone())
            }
        };
        out.push_str(&format!(
            "  {}:\n    type: http\n    behavior: {behavior}\n    format: {format}\n    url: {}\n    interval: 86400\n",
            p.name(),
            quoted(&url),
        ));
    }
    out
}

fn flow(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

/// The `dns:` block (none in the client mode): domestic servers for the
/// lines' own names and the directly routed lists, foreign servers through
/// the proxy by the rules.
fn dns(routing: &Routing, providers: &[Provider]) -> String {
    let d = routing.config.dns.effective();
    if d.mode == DnsMode::Client {
        return String::new();
    }
    let has = |name: &str| providers.iter().any(|p| p.name() == name);
    let mut out = String::from("dns:\n  enable: true\n  ipv6: false\n");
    if d.fakeip {
        let mut filter: Vec<String> = vec!["+.lan".into(), "+.local".into()];
        if has("geosite-private") {
            filter.push("rule-set:geosite-private".into());
        }
        filter.extend(
            [
                "+.msftconnecttest.com",
                "+.msftncsi.com",
                "time.*.com",
                "ntp.*.com",
            ]
            .map(String::from),
        );
        out.push_str(&format!(
            "  enhanced-mode: fake-ip\n  fake-ip-range: 198.18.0.1/16\n  fake-ip-filter: {}\n",
            flow(&filter)
        ));
    } else {
        out.push_str("  enhanced-mode: redir-host\n");
    }
    out.push_str(&format!(
        "  default-nameserver: {}\n  proxy-server-nameserver: {}\n",
        flow(&super::dns::bootstrap(&d)),
        flow(&d.cn)
    ));
    let domestic: Vec<String> = routing
        .direct_geosites()
        .into_iter()
        .filter(|n| has(n))
        .collect();
    if !domestic.is_empty() {
        out.push_str(&format!(
            "  nameserver-policy:\n    {}: {}\n",
            quoted(&format!("rule-set:{}", domestic.join(","))),
            flow(&d.cn)
        ));
    }
    out.push_str(&format!(
        "  nameserver: {}\n  respect-rules: true\n",
        flow(&d.intl)
    ));
    out
}
