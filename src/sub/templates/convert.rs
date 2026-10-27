//! One-time conversion of the retired subscription routing
//! (`panel_settings.sub_routing`, migration 1107, and the rule list URL
//! templates of 1066) into the Clash and sing-box templates. Migration 1123
//! moved the old values into `sub_routing_legacy`; the first start after
//! it converts them (`import_legacy`), records the import in
//! `legacy_config_imports` and drops that table. Surge and Surfboard had
//! no routing, so they keep the built-in templates.
//!
//! Best effort, and lossy where the templates cannot say the same thing:
//!
//! - region groups (`🌐 <region>`) and tag groups become `filter` /
//!   `{all:<regex>}` groups that match the region or tag *in the line
//!   names* (lines are named "<entrance> | <tags>", not after the node's
//!   region field) — they work when the entrance names carry the region;
//! - a service's pinned line and ordered backups become one group over
//!   those lines' current names: Clash `fallback` takes them in the
//!   client's line order, not the pinned order (sing-box had no fallback
//!   either);
//! - remote rule-set links: Clash keeps them as `classical` rule-providers
//!   pointing at the original link; sing-box cannot read those lists (the
//!   panel-hosted converted copies are gone), so they are left out of the
//!   sing-box template and listed in the import's audit entry and warning.
//!
//! Remove this module (and the table) once no install can still be on a
//! build older than 1123.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use super::TemplateFormat;
use super::doc::Doc;
use crate::audit::Actor;
use crate::state::AppState;

const CLASH_URL: &str = "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/{kind}/{name}.list";
const SINGBOX_URL: &str = "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/{kind}/{name}.srs";
const TEST_URL: &str = "https://www.gstatic.com/generate_204";
const DEFAULT_GROUP: &str = "🚀 默认代理";
const ALL_GROUP: &str = "♻️ 全部节点";

/// Built-in categories of the old catalog: (id, geosite lists, geoip lists).
const CATEGORIES: &[(&str, &[&str], &[&str])] = &[
    ("ads", &["category-ads-all"], &[]),
    ("private", &["private"], &["private"]),
    ("cn", &["cn"], &[]),
    ("cnip", &[], &["cn"]),
    ("netflix", &["netflix"], &[]),
    ("google", &["google"], &[]),
    ("youtube", &["youtube"], &[]),
    ("telegram", &["telegram"], &["telegram"]),
    ("ai", &["category-ai-!cn"], &[]),
    ("disney", &["disney"], &[]),
    ("spotify", &["spotify"], &[]),
    ("tiktok", &["tiktok"], &[]),
    ("apple", &["apple"], &[]),
    ("microsoft", &["microsoft"], &[]),
    ("steam", &["steam"], &[]),
    ("github", &["github"], &[]),
    ("twitter", &["twitter"], &[]),
];

// ---------------------------------------------------------------------------
// The old model (read-only; lenient)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct Item {
    #[serde(rename = "type")]
    kind: String,
    value: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Ref {
    Entrance(Uuid),
    Region(String),
    Tag(String),
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct Service {
    key: String,
    name: String,
    #[serde(default)]
    emoji: String,
    #[serde(default)]
    items: Vec<Item>,
    #[serde(default)]
    primary: Option<Uuid>,
    #[serde(default)]
    backups: Vec<Ref>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct DnsCfg {
    #[serde(default = "recommended_mode")]
    mode: String,
    #[serde(default = "yes")]
    fakeip: bool,
    #[serde(default)]
    cn: Vec<String>,
    #[serde(default)]
    intl: Vec<String>,
}

fn recommended_mode() -> String {
    "recommended".into()
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct Cfg {
    #[serde(default)]
    mode: String,
    #[serde(default)]
    block: Vec<Item>,
    #[serde(default)]
    direct: Vec<Item>,
    #[serde(default)]
    services: Vec<Service>,
    #[serde(default)]
    rest: Option<Ref>,
    #[serde(default)]
    tag_groups: Vec<String>,
    #[serde(default = "default_dns")]
    dns: DnsCfg,
}

fn default_dns() -> DnsCfg {
    DnsCfg {
        mode: recommended_mode(),
        fakeip: true,
        cn: vec![],
        intl: vec![],
    }
}

fn item(kind: &str, value: &str) -> Item {
    Item {
        kind: kind.into(),
        value: value.into(),
    }
}

/// The old built-in routing (what a site that never edited it had).
fn recommended() -> Cfg {
    let svc = |key: &str, name: &str, emoji: &str| Service {
        key: key.into(),
        name: name.into(),
        emoji: emoji.into(),
        items: vec![item("category", key)],
        primary: None,
        backups: vec![],
    };
    Cfg {
        mode: "rules".into(),
        block: vec![item("category", "ads")],
        direct: vec![item("category", "private"), item("category", "cn"), item("category", "cnip")],
        services: vec![
            svc("netflix", "Netflix", "🎬"),
            svc("google", "Google", "🔍"),
            svc("youtube", "YouTube", "📺"),
            svc("telegram", "Telegram", "✈️"),
            svc("ai", "AI 服务", "🤖"),
        ],
        rest: None,
        tag_groups: vec![],
        dns: default_dns(),
    }
}

/// Fields that did not exist in older rows get their defaults; `mode`
/// "" = rules.
fn normalize(mut c: Cfg) -> Cfg {
    if c.mode.is_empty() {
        c.mode = "rules".into();
    }
    c
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/// What the conversion needs from the database.
#[derive(Debug, Default)]
struct World {
    /// Entrance id → its subscription line name.
    lines: Vec<(Uuid, String)>,
    /// Node regions in use.
    regions: Vec<String>,
}

#[derive(Debug, Default)]
struct Converted {
    clash: String,
    sing_box: String,
    /// Remote rule-set links the sing-box template could not keep.
    dropped: Vec<String>,
}

fn list_url(template: &str, kind: &str, name: &str) -> String {
    template.replace("{kind}", kind).replace("{name}", name)
}

fn service_name(s: &Service) -> String {
    if s.emoji.is_empty() {
        s.name.clone()
    } else {
        format!("{} {}", s.emoji, s.name)
    }
}

fn remote_name(url: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("rs-{}", &hex::encode(Sha256::digest(url.as_bytes()))[..10])
}

enum Matcher<'a> {
    List(&'static str, String),
    Domain(&'a str),
    Suffix(&'a str),
    Keyword(&'a str),
    Cidr(&'a str),
    Remote(&'a str),
}

fn matchers(it: &Item) -> Vec<Matcher<'_>> {
    let v = it.value.as_str();
    match it.kind.as_str() {
        "category" => CATEGORIES
            .iter()
            .find(|c| c.0 == v)
            .map(|c| {
                c.1.iter()
                    .map(|n| Matcher::List("geosite", (*n).to_string()))
                    .chain(c.2.iter().map(|n| Matcher::List("geoip", (*n).to_string())))
                    .collect()
            })
            .unwrap_or_default(),
        "geosite" => vec![Matcher::List("geosite", v.to_string())],
        "geoip" => vec![Matcher::List("geoip", v.to_string())],
        "domain" => vec![Matcher::Domain(v)],
        "domain_suffix" => vec![Matcher::Suffix(v)],
        "domain_keyword" => vec![Matcher::Keyword(v)],
        "ip_cidr" => vec![Matcher::Cidr(v)],
        "rule_set" => vec![Matcher::Remote(v)],
        _ => vec![],
    }
}

enum Target {
    Reject,
    Direct,
    Group(String),
}

struct Plan {
    /// (group name, kind, members, filter regex, hidden) in output order.
    groups: Vec<Group>,
    default: String,
    /// Where each section goes: block, direct, then the services.
    sections: Vec<(Vec<Item>, Target)>,
    /// geosite lists routed direct (domestic DNS).
    direct_sites: Vec<String>,
}

struct Group {
    name: String,
    kind: &'static str,
    /// Static members; `$proxies` / `{all}` are added per format.
    members: Vec<String>,
    /// All lines (`$proxies`) are members too.
    all_lines: bool,
    /// Lines whose name matches (regex), via filter.
    filter: Option<String>,
    hidden: bool,
}

fn unique(taken: &mut HashSet<String>, want: String) -> String {
    let mut n = want.clone();
    let mut i = 2;
    while !taken.insert(n.clone()) {
        n = format!("{want} #{i}");
        i += 1;
    }
    n
}

fn plan(c: &Cfg, w: &World) -> Plan {
    let mut taken: HashSet<String> = HashSet::new();
    let default = unique(&mut taken, DEFAULT_GROUP.into());
    let all = unique(&mut taken, ALL_GROUP.into());
    let regions: Vec<(String, String)> = w
        .regions
        .iter()
        .map(|r| (r.clone(), unique(&mut taken, format!("🌐 {r}"))))
        .collect();
    let mut tag_keys: Vec<String> = c.tag_groups.clone();
    for r in c.services.iter().flat_map(|s| s.backups.iter()).chain(c.rest.iter()) {
        if let Ref::Tag(t) = r
            && !tag_keys.contains(t)
        {
            tag_keys.push(t.clone());
        }
    }
    let tags: Vec<(String, String)> = tag_keys
        .iter()
        .map(|t| (t.clone(), unique(&mut taken, format!("🏷 {t}"))))
        .collect();
    let line = |id: &Uuid| w.lines.iter().find(|(i, _)| i == id).map(|(_, n)| n.clone());
    let resolve_group = |r: &Ref| -> Option<String> {
        match r {
            Ref::Entrance(_) => None,
            Ref::Region(k) => regions.iter().find(|(x, _)| x == k).map(|(_, n)| n.clone()),
            Ref::Tag(k) => tags.iter().find(|(x, _)| x == k).map(|(_, n)| n.clone()),
        }
    };
    let region_names: Vec<String> = regions.iter().map(|(_, n)| n.clone()).collect();
    let tag_names: Vec<String> = tags.iter().map(|(_, n)| n.clone()).collect();

    let mut groups = Vec::new();
    // The default proxy: the preselected target first.
    let mut members: Vec<String> = Vec::new();
    let first = match &c.rest {
        Some(Ref::Entrance(id)) => line(id),
        Some(r) => resolve_group(r),
        None => None,
    };
    members.push(first.clone().unwrap_or_else(|| all.clone()));
    members.extend(region_names.iter().chain(&tag_names).cloned());
    members.push(all.clone());
    members.dedup();
    let mut seen = HashSet::new();
    members.retain(|m| seen.insert(m.clone()));
    groups.push(Group {
        name: default.clone(),
        kind: "select",
        members,
        all_lines: true,
        filter: None,
        hidden: false,
    });
    let mut sections: Vec<(Vec<Item>, Target)> = Vec::new();
    if c.mode == "global" {
        sections.push((vec![item("category", "private")], Target::Direct));
    } else {
        sections.push((c.block.clone(), Target::Reject));
        sections.push((c.direct.clone(), Target::Direct));
        for s in &c.services {
            let name = unique(&mut taken, service_name(s));
            let lines: Vec<String> = s
                .primary
                .iter()
                .map(|id| Ref::Entrance(*id))
                .chain(s.backups.iter().cloned())
                .filter_map(|r| match r {
                    Ref::Entrance(id) => line(&id),
                    _ => None,
                })
                .collect();
            let chain_groups: Vec<String> = s.backups.iter().filter_map(&resolve_group).collect();
            let mut members: Vec<String> = Vec::new();
            if lines.is_empty() && chain_groups.is_empty() {
                members.push(default.clone());
            } else {
                let rec = unique(&mut taken, format!("♻️ {} 推荐", s.name));
                groups.push(Group {
                    name: rec.clone(),
                    kind: "fallback",
                    members: chain_groups,
                    all_lines: false,
                    filter: (!lines.is_empty()).then(|| {
                        format!(
                            "^(?:{})$",
                            lines.iter().map(|l| regex::escape(l)).collect::<Vec<_>>().join("|")
                        )
                    }),
                    hidden: true,
                });
                members.push(rec);
            }
            members.extend(region_names.iter().cloned());
            members.push(all.clone());
            members.push("DIRECT".into());
            groups.push(Group {
                name: name.clone(),
                kind: "select",
                members,
                all_lines: false,
                filter: None,
                hidden: false,
            });
            sections.push((s.items.clone(), Target::Group(name)));
        }
    }
    groups.push(Group {
        name: all,
        kind: "url-test",
        members: vec![],
        all_lines: true,
        filter: None,
        hidden: false,
    });
    for (r, name) in &regions {
        groups.push(Group {
            name: name.clone(),
            kind: "url-test",
            members: vec![],
            all_lines: false,
            filter: Some(format!("(?i){}", regex::escape(r))),
            hidden: false,
        });
    }
    for (t, name) in &tags {
        groups.push(Group {
            name: name.clone(),
            kind: "url-test",
            members: vec![],
            all_lines: false,
            filter: Some(format!("(?i){}", regex::escape(t))),
            hidden: false,
        });
    }
    let mut direct_sites: Vec<String> = Vec::new();
    for (items, target) in &sections {
        if matches!(target, Target::Direct) {
            for it in items {
                for m in matchers(it) {
                    if let Matcher::List("geosite", n) = m {
                        let n = format!("geosite-{n}");
                        if !direct_sites.contains(&n) {
                            direct_sites.push(n);
                        }
                    }
                }
            }
        }
    }
    Plan {
        groups,
        default,
        sections,
        direct_sites,
    }
}

fn strs(v: &[String]) -> Doc {
    Doc::seq_of_strs(v.iter().cloned())
}

/// A DNS server string as (scheme, host, port, path).
fn dns_server(v: &str) -> Option<(String, String, Option<u16>, String)> {
    let v = v.trim();
    if v.parse::<std::net::IpAddr>().is_ok() {
        return Some(("udp".into(), v.to_string(), None, String::new()));
    }
    let (scheme, rest) = v.split_once("://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let (host, port) = if let Some(r) = authority.strip_prefix('[') {
        let (h, after) = r.split_once(']')?;
        (h.to_string(), after.strip_prefix(':').and_then(|p| p.parse().ok()))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().ok()),
            None => (authority.to_string(), None),
        }
    };
    let path = if path == "/dns-query" { "" } else { path };
    Some((scheme.to_ascii_lowercase(), host.to_ascii_lowercase(), port, path.to_string()))
}

struct Dns {
    client: bool,
    fakeip: bool,
    cn: Vec<String>,
    intl: Vec<String>,
}

fn effective_dns(d: &DnsCfg) -> Dns {
    let rec = Dns {
        client: false,
        fakeip: true,
        cn: vec!["https://223.5.5.5/dns-query".into(), "https://doh.pub/dns-query".into()],
        intl: vec!["https://1.1.1.1/dns-query".into(), "https://8.8.8.8/dns-query".into()],
    };
    match d.mode.as_str() {
        "client" => Dns { client: true, ..rec },
        "custom" if !d.cn.is_empty() && !d.intl.is_empty() => Dns {
            client: false,
            fakeip: d.fakeip,
            cn: d.cn.clone(),
            intl: d.intl.clone(),
        },
        _ => rec,
    }
}

fn bootstrap(cn: &[String]) -> Vec<String> {
    let ips: Vec<String> = cn
        .iter()
        .filter_map(|s| dns_server(s))
        .filter(|(_, h, _, _)| h.parse::<std::net::IpAddr>().is_ok())
        .map(|(_, h, _, _)| h)
        .collect();
    if ips.is_empty() {
        vec!["223.5.5.5".into(), "119.29.29.29".into()]
    } else {
        ips
    }
}

fn clash_template(c: &Cfg, w: &World, clash_url: &str) -> Result<String, String> {
    let p = plan(c, w);
    let mut doc = serde_saphyr::from_str::<Doc>(TemplateFormat::Clash.default_body()).map_err(|e| e.to_string())?;
    // Rules and the providers they use.
    let mut providers: Vec<(String, &'static str, String, &'static str)> = Vec::new();
    let mut rules: Vec<String> = Vec::new();
    let mut add_provider = |name: String, behavior: &'static str, url: String, format: &'static str| {
        if !providers.iter().any(|p| p.0 == name) {
            providers.push((name, behavior, url, format));
        }
    };
    for (items, target) in &p.sections {
        let t = match target {
            Target::Reject => "REJECT".to_string(),
            Target::Direct => "DIRECT".to_string(),
            Target::Group(g) => g.clone(),
        };
        for it in items {
            for m in matchers(it) {
                rules.push(match m {
                    Matcher::List(k, n) => {
                        let name = format!("{k}-{n}");
                        let behavior = if k == "geosite" { "domain" } else { "ipcidr" };
                        add_provider(name.clone(), behavior, list_url(clash_url, k, &n), "text");
                        if k == "geosite" {
                            format!("RULE-SET,{name},{t}")
                        } else {
                            format!("RULE-SET,{name},{t},no-resolve")
                        }
                    }
                    Matcher::Remote(url) => {
                        let name = remote_name(url);
                        let path = url.split(['?', '#']).next().unwrap_or_default();
                        let format = if path.ends_with(".yaml") || path.ends_with(".yml") { "yaml" } else { "text" };
                        add_provider(name.clone(), "classical", url.to_string(), format);
                        format!("RULE-SET,{name},{t}")
                    }
                    Matcher::Domain(v) => format!("DOMAIN,{v},{t}"),
                    Matcher::Suffix(v) => format!("DOMAIN-SUFFIX,{v},{t}"),
                    Matcher::Keyword(v) => format!("DOMAIN-KEYWORD,{v},{t}"),
                    Matcher::Cidr(v) if v.contains(':') => format!("IP-CIDR6,{v},{t},no-resolve"),
                    Matcher::Cidr(v) => format!("IP-CIDR,{v},{t},no-resolve"),
                });
            }
        }
    }
    rules.push(format!("MATCH,{}", p.default));
    // Groups.
    let mut gs = Vec::new();
    for g in &p.groups {
        let mut m = Doc::map().with("name", g.name.as_str()).with("type", g.kind);
        if g.hidden {
            m.set("hidden", true);
        }
        if g.kind != "select" {
            m.set("url", TEST_URL);
            m.set("interval", 300u64);
        }
        let mut members = g.members.clone();
        if g.all_lines {
            members.push("$proxies".into());
        }
        if g.filter.is_some() {
            m.set("include-all-proxies", true);
        }
        if let Some(f) = &g.filter {
            m.set("filter", f.as_str());
        }
        if !members.is_empty() {
            m.set("proxies", strs(&members));
        }
        gs.push(m);
    }
    doc.set("proxy-groups", Doc::Seq(gs));
    let mut pm = Doc::map();
    for (name, behavior, url, format) in &providers {
        pm.set(
            name,
            Doc::map()
                .with("type", "http")
                .with("behavior", *behavior)
                .with("format", *format)
                .with("url", url.as_str())
                .with("interval", 86400u64),
        );
    }
    if providers.is_empty() {
        remove(&mut doc, "rule-providers");
    } else {
        doc.set("rule-providers", pm);
    }
    doc.set("rules", strs(&rules));
    // DNS.
    let d = effective_dns(&c.dns);
    if d.client {
        remove(&mut doc, "dns");
    } else {
        let has = |n: &str| providers.iter().any(|p| p.0 == n);
        let mut dns = Doc::map().with("enable", true).with("ipv6", false);
        if d.fakeip {
            let mut filter = vec!["+.lan".to_string(), "+.local".into()];
            if has("geosite-private") {
                filter.push("rule-set:geosite-private".into());
            }
            filter.extend(["+.msftconnecttest.com", "+.msftncsi.com", "time.*.com", "ntp.*.com"].map(String::from));
            dns.set("enhanced-mode", "fake-ip");
            dns.set("fake-ip-range", "198.18.0.1/16");
            dns.set("fake-ip-filter", strs(&filter));
        } else {
            dns.set("enhanced-mode", "redir-host");
        }
        dns.set("default-nameserver", strs(&bootstrap(&d.cn)));
        dns.set("proxy-server-nameserver", strs(&d.cn));
        let domestic: Vec<String> = p.direct_sites.iter().filter(|n| has(n)).cloned().collect();
        if !domestic.is_empty() {
            dns.set(
                "nameserver-policy",
                Doc::map().with(&format!("rule-set:{}", domestic.join(",")), strs(&d.cn)),
            );
        }
        dns.set("nameserver", strs(&d.intl));
        dns.set("respect-rules", true);
        doc.set("dns", dns);
    }
    serde_saphyr::to_string(&doc).map_err(|e| e.to_string())
}

fn remove(doc: &mut Doc, key: &str) {
    if let Doc::Map(m) = doc {
        m.retain(|(k, _)| k != key);
    }
}

fn sing_box_server(s: &(String, String, Option<u16>, String), tag: &str, resolver: &str) -> Value {
    let mut o = json!({"type": s.0, "tag": tag, "server": s.1});
    if let Some(p) = s.2 {
        o["server_port"] = json!(p);
    }
    if !s.3.is_empty() {
        o["path"] = json!(s.3);
    }
    if s.1.parse::<std::net::IpAddr>().is_err() {
        o["domain_resolver"] = json!(resolver);
    }
    o
}

fn sing_box_template(c: &Cfg, w: &World, url: &str, dropped: &mut Vec<String>) -> Result<String, String> {
    let p = plan(c, w);
    let mut doc: Value = serde_json::from_str(TemplateFormat::SingBox.default_body()).map_err(|e| e.to_string())?;
    // Groups.
    let mut outbounds: Vec<Value> = Vec::new();
    for g in &p.groups {
        let mut members: Vec<String> = g
            .members
            .iter()
            .map(|m| if m == "DIRECT" { "direct".to_string() } else { m.clone() })
            .collect();
        if g.all_lines {
            members.push("{all}".into());
        }
        if let Some(f) = &g.filter {
            members.push(format!("{{all:{f}}}"));
        }
        outbounds.push(if g.kind == "select" {
            json!({"type": "selector", "tag": g.name, "outbounds": members})
        } else {
            json!({"type": "urltest", "tag": g.name, "outbounds": members, "url": TEST_URL, "interval": "300s"})
        });
    }
    outbounds.push(json!({"type": "direct", "tag": "direct"}));
    // Rules.
    let mut rule_sets: Vec<(String, String)> = Vec::new();
    let mut rules = vec![json!({"action": "sniff"}), json!({"protocol": "dns", "action": "hijack-dns"})];
    for (items, target) in &p.sections {
        for it in items {
            for m in matchers(it) {
                let mut r = match m {
                    Matcher::List(k, n) => {
                        let tag = format!("{k}-{n}");
                        if !rule_sets.iter().any(|(t, _)| *t == tag) {
                            rule_sets.push((tag.clone(), list_url(url, k, &n)));
                        }
                        json!({"rule_set": [tag]})
                    }
                    Matcher::Domain(v) => json!({"domain": [v]}),
                    Matcher::Suffix(v) => json!({"domain_suffix": [v]}),
                    Matcher::Keyword(v) => json!({"domain_keyword": [v]}),
                    Matcher::Cidr(v) => json!({"ip_cidr": [v]}),
                    Matcher::Remote(u) => {
                        if !dropped.iter().any(|d| d == u) {
                            dropped.push(u.to_string());
                        }
                        continue;
                    }
                };
                match target {
                    Target::Reject => r["action"] = json!("reject"),
                    Target::Direct => r["outbound"] = json!("direct"),
                    Target::Group(g) => r["outbound"] = json!(g),
                }
                rules.push(r);
            }
        }
    }
    let rs: Vec<Value> = rule_sets
        .iter()
        .map(|(tag, u)| json!({"type": "remote", "tag": tag, "format": "binary", "url": u, "update_interval": "1d"}))
        .collect();
    let mut route = json!({
        "rules": rules,
        "final": p.default,
        "auto_detect_interface": true,
        "default_domain_resolver": "local",
    });
    if !rs.is_empty() {
        route["rule_set"] = json!(rs);
    }
    // DNS.
    let d = effective_dns(&c.dns);
    let dns = if d.client {
        json!({"servers": [{"type": "local", "tag": "local"}], "final": "local"})
    } else {
        let mut servers = Vec::new();
        let local = d.cn.iter().find_map(|s| dns_server(s));
        if local.as_ref().is_some_and(|s| s.1.parse::<std::net::IpAddr>().is_err()) {
            servers.push(json!({"type": "udp", "tag": "bootstrap", "server": bootstrap(&d.cn)[0]}));
        }
        servers.push(match &local {
            Some(s) => sing_box_server(s, "local", "bootstrap"),
            None => json!({"type": "local", "tag": "local"}),
        });
        servers.push(match d.intl.iter().find_map(|s| dns_server(s)) {
            Some(s) => {
                let mut r = sing_box_server(&s, "remote", "local");
                r["detour"] = json!(p.default);
                r
            }
            None => json!({"type": "local", "tag": "remote"}),
        });
        let mut drules = Vec::new();
        let direct: Vec<&String> = p.direct_sites.iter().filter(|n| rule_sets.iter().any(|(t, _)| t == *n)).collect();
        if !direct.is_empty() {
            drules.push(json!({"rule_set": direct, "server": "local"}));
        }
        if d.fakeip {
            servers.push(json!({"type": "fakeip", "tag": "fakeip", "inet4_range": "198.18.0.0/15", "inet6_range": "fc00::/18"}));
            drules.push(json!({"query_type": ["A", "AAAA"], "server": "fakeip"}));
        }
        let mut out = json!({"servers": servers, "final": "remote", "strategy": "prefer_ipv4"});
        if !drules.is_empty() {
            out["rules"] = json!(drules);
        }
        out
    };
    doc["dns"] = dns;
    doc["outbounds"] = json!(outbounds);
    doc["route"] = route;
    doc["experimental"] = json!({"cache_file": if d.fakeip && !d.client {
        json!({"enabled": true, "store_fakeip": true})
    } else {
        json!({"enabled": true})
    }});
    serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())
}

fn convert(c: &Cfg, w: &World, clash_url: &str, singbox_url: &str) -> Result<Converted, String> {
    let mut dropped = Vec::new();
    Ok(Converted {
        clash: clash_template(c, w, clash_url)?,
        sing_box: sing_box_template(c, w, singbox_url, &mut dropped)?,
        dropped,
    })
}

// ---------------------------------------------------------------------------
// Startup import
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct LegacyRow {
    routing: Option<Value>,
    clash_url: Option<String>,
    singbox_url: Option<String>,
}

/// What an import did, for the log.
#[derive(Debug, Default)]
struct Report {
    converted: bool,
    dropped: Vec<String>,
}

async fn world(conn: &mut PgConnection, c: &Cfg) -> sqlx::Result<World> {
    let mut ids: Vec<Uuid> = Vec::new();
    for s in &c.services {
        ids.extend(s.primary);
        ids.extend(s.backups.iter().filter_map(|b| match b {
            Ref::Entrance(i) => Some(*i),
            _ => None,
        }));
    }
    if let Some(Ref::Entrance(i)) = &c.rest {
        ids.push(*i);
    }
    let rows: Vec<(Uuid, String, Vec<String>)> =
        sqlx::query_as("SELECT id, name, tags FROM entrances WHERE id = ANY($1)")
            .bind(&ids)
            .fetch_all(&mut *conn)
            .await?;
    let regions: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT btrim(region) FROM nodes WHERE region IS NOT NULL AND btrim(region) <> '' ORDER BY 1",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(World {
        lines: rows
            .into_iter()
            .map(|(id, name, tags)| (id, crate::nodemeta::line_name(&name, &tags)))
            .collect(),
        regions,
    })
}

async fn import(pg: &sqlx::PgPool) -> anyhow::Result<Report> {
    let mut tx = pg.begin().await?;
    let exists: Option<String> = sqlx::query_scalar("SELECT to_regclass('sub_routing_legacy')::text")
        .fetch_one(&mut *tx)
        .await?;
    let mut report = Report::default();
    if exists.is_none() {
        return Ok(report);
    }
    let row: Option<LegacyRow> = sqlx::query_as(
        "SELECT routing, clash_url, singbox_url FROM sub_routing_legacy FOR UPDATE",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let have: i64 = sqlx::query_scalar("SELECT count(*) FROM sub_templates")
        .fetch_one(&mut *tx)
        .await?;
    if let (Some(row), 0) = (row, have) {
        let cfg = match &row.routing {
            Some(v) => normalize(serde_json::from_value::<Cfg>(v.clone())?),
            None => recommended(),
        };
        let urls_default = row.clash_url.is_none() && row.singbox_url.is_none();
        if !(cfg == recommended() && urls_default) {
            let w = world(&mut tx, &cfg).await?;
            let out = convert(
                &cfg,
                &w,
                row.clash_url.as_deref().unwrap_or(CLASH_URL),
                row.singbox_url.as_deref().unwrap_or(SINGBOX_URL),
            )
            .map_err(anyhow::Error::msg)?;
            // The result must be something the API would accept.
            super::render_sample(TemplateFormat::Clash, &out.clash).map_err(|e| anyhow::anyhow!(e.message))?;
            super::render_sample(TemplateFormat::SingBox, &out.sing_box).map_err(|e| anyhow::anyhow!(e.message))?;
            for (f, body) in [(TemplateFormat::Clash, &out.clash), (TemplateFormat::SingBox, &out.sing_box)] {
                sqlx::query(
                    "INSERT INTO sub_templates (format, body, updated_by) VALUES ($1, $2, 'system')",
                )
                .bind(f.id())
                .bind(body)
                .execute(&mut *tx)
                .await?;
            }
            sqlx::query(
                "INSERT INTO legacy_config_imports (key, outcome) VALUES ('sub.routing', 'imported') \
                 ON CONFLICT DO NOTHING",
            )
            .execute(&mut *tx)
            .await?;
            crate::audit::record(
                &mut tx,
                &Actor::system(),
                "settings.sub_template.import",
                "sub_template",
                None,
                None,
                Some(json!({
                    "formats": ["clash", "sing-box"],
                    "clash_length": out.clash.len(),
                    "sing_box_length": out.sing_box.len(),
                    "dropped_rule_sets": out.dropped,
                })),
            )
            .await?;
            report.converted = true;
            report.dropped = out.dropped;
        }
    }
    sqlx::query("DROP TABLE sub_routing_legacy").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(report)
}

/// Convert the retired routing into templates (once) and drop the holding
/// table. A failure keeps the table and is retried at the next start; the
/// built-in templates serve meanwhile.
pub async fn import_legacy(state: &AppState) {
    match import(state.pg()).await {
        Ok(r) if r.converted => {
            tracing::warn!(
                "the subscription routing was converted into the Clash and sing-box templates \
                 (系统设置 → 订阅模板); check them: region and tag groups match line names, pinned \
                 line order is not kept"
            );
            if !r.dropped.is_empty() {
                tracing::warn!(
                    links = ?r.dropped,
                    "remote rule-set links cannot be used by sing-box and were left out of its template"
                );
            }
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(
            error = %e,
            "the subscription routing could not be converted into templates; the built-in templates \
             are used and the conversion is retried at the next start"
        ),
    }
}

#[cfg(test)]
mod tests;
