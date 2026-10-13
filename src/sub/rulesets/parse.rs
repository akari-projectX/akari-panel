//! Rule-set lists as operators paste them (pure; fuzz target
//! `rule_sets`): Clash `.yaml` (`payload:` with `- ` items), `.list` and
//! `.txt` — classical `TYPE,VALUE[,option…]` lines and the bare forms of
//! Clash's domain / ipcidr lists (`example.com`, `+.example.com`,
//! `.example.com`, `1.2.3.0/24`, `2001:db8::/32`). Comments (`#`, `//`,
//! `;`), blank lines and YAML markers are skipped.
//!
//! Only what sing-box's headless rules can express is kept (domain,
//! domain_suffix, domain_keyword, ip_cidr); other classical types
//! (PROCESS-NAME, USER-AGENT, DOMAIN-REGEX, logical rules, …) are counted
//! as unsupported by type, and unreadable lines as invalid. The kept rules
//! become the hosted sing-box `source` rule-set (`source_json`).

use std::collections::{BTreeMap, HashSet};
use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// At most this many rules (kept + unsupported) in one list.
pub const MAX_RULES: usize = 200_000;
/// Lines longer than this are invalid (never a rule).
const MAX_LINE: usize = 4096;
/// At most this many distinct unsupported type names are counted.
const MAX_TYPES: usize = 16;
/// The sing-box source rule-set version (sing-box 1.11+; the profiles
/// target 1.12+).
pub const SOURCE_VERSION: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleKind {
    Domain,
    /// `example.com` = the domain and its subdomains; `.example.com` =
    /// subdomains only (sing-box `domain_suffix` semantics).
    DomainSuffix,
    DomainKeyword,
    IpCidr,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Rule {
    #[serde(rename = "type")]
    pub kind: RuleKind,
    pub value: String,
}

/// What a list holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counts {
    /// Rules read: kept (deduplicated) + unsupported.
    pub total: usize,
    pub domain: usize,
    pub domain_suffix: usize,
    pub domain_keyword: usize,
    pub ip_cidr: usize,
    /// Rules sing-box cannot express (skipped there; Clash loads the
    /// original list).
    pub unsupported: usize,
    /// Unsupported rules by type (at most 16 types).
    pub unsupported_types: BTreeMap<String, usize>,
    /// Lines that are not a rule.
    pub invalid: usize,
}

impl Counts {
    /// Rules the sing-box rule-set carries.
    pub fn kept(&self) -> usize {
        self.domain + self.domain_suffix + self.domain_keyword + self.ip_cidr
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parsed {
    /// Kept rules, deduplicated, in file order.
    pub rules: Vec<Rule>,
    pub counts: Counts,
}

/// Why a downloaded file is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// No rule and nothing else either (only comments / blank lines).
    Empty,
    /// More unreadable lines than rules (an HTML page, a binary file, …).
    NotAList {
        invalid: usize,
    },
    TooMany,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Empty => f.write_str("no rules found"),
            Refused::NotAList { invalid } => {
                write!(f, "not a rule list ({invalid} unreadable lines)")
            }
            Refused::TooMany => write!(f, "more than {MAX_RULES} rules"),
        }
    }
}

enum Line {
    Skip,
    Rule(Rule),
    Unsupported(String),
    Invalid,
}

/// Parse a list (never fails: see `check`).
pub fn parse(text: &str) -> Parsed {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Parsed::default();
    let mut seen: HashSet<Rule> = HashSet::new();
    for raw in text.lines() {
        if out.counts.total > MAX_RULES {
            break;
        }
        match line(raw) {
            Line::Skip => {}
            Line::Invalid => out.counts.invalid += 1,
            Line::Unsupported(t) => {
                out.counts.unsupported += 1;
                out.counts.total += 1;
                let n = out.counts.unsupported_types.len();
                if let Some(c) = out.counts.unsupported_types.get_mut(&t) {
                    *c += 1;
                } else if n < MAX_TYPES {
                    out.counts.unsupported_types.insert(t, 1);
                }
            }
            Line::Rule(r) => {
                if seen.contains(&r) {
                    continue;
                }
                let c = &mut out.counts;
                match r.kind {
                    RuleKind::Domain => c.domain += 1,
                    RuleKind::DomainSuffix => c.domain_suffix += 1,
                    RuleKind::DomainKeyword => c.domain_keyword += 1,
                    RuleKind::IpCidr => c.ip_cidr += 1,
                }
                c.total += 1;
                seen.insert(r.clone());
                out.rules.push(r);
            }
        }
    }
    out
}

/// Whether a parsed list is usable (a rule list, not empty, not too big).
pub fn check(p: &Parsed) -> Result<(), Refused> {
    if p.counts.total > MAX_RULES {
        return Err(Refused::TooMany);
    }
    if p.counts.total == 0 && p.counts.invalid == 0 {
        return Err(Refused::Empty);
    }
    if p.counts.invalid > p.counts.total {
        return Err(Refused::NotAList {
            invalid: p.counts.invalid,
        });
    }
    Ok(())
}

fn line(raw: &str) -> Line {
    if raw.len() > MAX_LINE {
        return Line::Invalid;
    }
    let mut s = raw.trim();
    if s.is_empty()
        || s.starts_with('#')
        || s.starts_with("//")
        || s.starts_with(';')
        || s == "---"
        || s == "..."
    {
        return Line::Skip;
    }
    if let Some(rest) = s.strip_prefix("payload") {
        let rest = rest.trim_start();
        if let Some(value) = rest.strip_prefix(':') {
            return if matches!(value.trim(), "" | "[]") {
                Line::Skip
            } else {
                Line::Invalid
            };
        }
    }
    // A YAML list item.
    if let Some(rest) = s.strip_prefix('-')
        && (rest.is_empty() || rest.starts_with([' ', '\t']))
    {
        s = rest.trim();
    }
    // A trailing comment (no supported value contains " #").
    if let Some(i) = s.find(" #") {
        s = s[..i].trim_end();
    }
    for q in ['\'', '"'] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            s = s[1..s.len() - 1].trim();
            break;
        }
    }
    if s.is_empty() {
        return Line::Invalid;
    }
    if s.chars().any(|c| c.is_control()) {
        return Line::Invalid;
    }
    match s.split_once(',') {
        Some((t, rest)) => classical(t.trim(), rest),
        None => bare(s),
    }
}

/// `TYPE,VALUE[,option…]`.
fn classical(t: &str, rest: &str) -> Line {
    let ty = t.to_ascii_uppercase();
    let value = rest.split(',').next().unwrap_or("").trim();
    let rule = |kind, value: Option<String>| match value {
        Some(value) => Line::Rule(Rule { kind, value }),
        None => Line::Invalid,
    };
    match ty.as_str() {
        "DOMAIN" => rule(RuleKind::Domain, domain(value)),
        "DOMAIN-SUFFIX" => rule(
            RuleKind::DomainSuffix,
            domain(value.strip_prefix('.').unwrap_or(value)),
        ),
        "DOMAIN-KEYWORD" => rule(RuleKind::DomainKeyword, keyword(value)),
        "IP-CIDR" | "IP-CIDR6" => rule(RuleKind::IpCidr, cidr(value)),
        _ if type_name(&ty) => Line::Unsupported(ty),
        _ => Line::Invalid,
    }
}

/// A rule type name: `A-Z`, digits and `-`, 2-32 characters, starting
/// with a letter.
fn type_name(t: &str) -> bool {
    (2..=32).contains(&t.len())
        && t.as_bytes()[0].is_ascii_uppercase()
        && t.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
}

/// The bare forms of Clash's domain and ipcidr lists.
fn bare(s: &str) -> Line {
    if let Some(d) = s.strip_prefix("+.") {
        return match domain(d) {
            Some(v) => Line::Rule(Rule {
                kind: RuleKind::DomainSuffix,
                value: v,
            }),
            None => Line::Invalid,
        };
    }
    if let Some(d) = s.strip_prefix('.') {
        return match domain(d) {
            Some(v) => Line::Rule(Rule {
                kind: RuleKind::DomainSuffix,
                value: format!(".{v}"),
            }),
            None => Line::Invalid,
        };
    }
    if s.contains('*') {
        return if domain(&s.replace('*', "x")).is_some() {
            Line::Unsupported("DOMAIN-WILDCARD".into())
        } else {
            Line::Invalid
        };
    }
    if s.contains('/') || s.parse::<IpAddr>().is_ok() {
        return match cidr(s) {
            Some(v) => Line::Rule(Rule {
                kind: RuleKind::IpCidr,
                value: v,
            }),
            None => Line::Invalid,
        };
    }
    match domain(s) {
        Some(v) => Line::Rule(Rule {
            kind: RuleKind::Domain,
            value: v,
        }),
        None => Line::Invalid,
    }
}

/// A domain name (ASCII / punycode, lowercased, no trailing dot), never an
/// IP address.
fn domain(v: &str) -> Option<String> {
    let v = v.trim().strip_suffix('.').unwrap_or(v.trim());
    if v.is_empty() || v.len() > 253 || v.parse::<IpAddr>().is_ok() {
        return None;
    }
    let ok = v.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    });
    ok.then(|| v.to_ascii_lowercase())
}

/// A keyword: 1-253 characters of a domain name.
fn keyword(v: &str) -> Option<String> {
    let ok = (1..=253).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    ok.then(|| v.to_ascii_lowercase())
}

/// An address or network, normalized to its network address
/// (`10.1.2.3/8` → `10.0.0.0/8`, a bare address → /32 or /128).
pub fn cidr(v: &str) -> Option<String> {
    let (addr, len) = match v.split_once('/') {
        Some((a, l)) => (a, Some(l)),
        None => (v, None),
    };
    let ip: IpAddr = addr.parse().ok()?;
    let max: u8 = if ip.is_ipv4() { 32 } else { 128 };
    let len: u8 = match len {
        None => max,
        Some(l) if !l.is_empty() && l.len() <= 3 && l.bytes().all(|b| b.is_ascii_digit()) => {
            l.parse().ok().filter(|l| *l <= max)?
        }
        Some(_) => return None,
    };
    let net = match ip {
        IpAddr::V4(a) => {
            let mask = u32::MAX.checked_shl(u32::from(32 - len)).unwrap_or(0);
            IpAddr::V4((u32::from(a) & mask).into())
        }
        IpAddr::V6(a) => {
            let mask = u128::MAX.checked_shl(u32::from(128 - len)).unwrap_or(0);
            IpAddr::V6((u128::from(a) & mask).into())
        }
    };
    Some(format!("{net}/{len}"))
}

/// The sing-box `source` rule-set of the kept rules: one headless rule
/// for the domain matchers (any of them matches) and one for the
/// networks; `{"version":3,"rules":[]}` when nothing is kept.
pub fn source_json(rules: &[Rule]) -> Value {
    let pick = |k: RuleKind| -> Vec<&str> {
        rules
            .iter()
            .filter(|r| r.kind == k)
            .map(|r| r.value.as_str())
            .collect()
    };
    let mut domains = serde_json::Map::new();
    for (k, field) in [
        (RuleKind::Domain, "domain"),
        (RuleKind::DomainSuffix, "domain_suffix"),
        (RuleKind::DomainKeyword, "domain_keyword"),
    ] {
        let v = pick(k);
        if !v.is_empty() {
            domains.insert(field.into(), json!(v));
        }
    }
    let mut out = Vec::new();
    if !domains.is_empty() {
        out.push(Value::Object(domains));
    }
    let nets = pick(RuleKind::IpCidr);
    if !nets.is_empty() {
        out.push(json!({ "ip_cidr": nets }));
    }
    json!({ "version": SOURCE_VERSION, "rules": out })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(p: &Parsed) -> Vec<(RuleKind, &str)> {
        p.rules.iter().map(|r| (r.kind, r.value.as_str())).collect()
    }

    #[test]
    fn clash_yaml_payload() {
        let p = parse(
            "# NAME: Claude\n# TOTAL: 4\npayload:\n  - DOMAIN-SUFFIX,claude.ai\n  - DOMAIN-SUFFIX,anthropic.com # api\n  - 'DOMAIN,cdn.usefathom.com'\n  - \"DOMAIN-KEYWORD,claude\"\n  - IP-CIDR,160.79.104.0/23,no-resolve\n  - PROCESS-NAME,Claude.exe\n",
        );
        assert_eq!(
            kinds(&p),
            vec![
                (RuleKind::DomainSuffix, "claude.ai"),
                (RuleKind::DomainSuffix, "anthropic.com"),
                (RuleKind::Domain, "cdn.usefathom.com"),
                (RuleKind::DomainKeyword, "claude"),
                (RuleKind::IpCidr, "160.79.104.0/23"),
            ]
        );
        assert_eq!(p.counts.total, 6);
        assert_eq!(p.counts.unsupported, 1);
        assert_eq!(p.counts.unsupported_types["PROCESS-NAME"], 1);
        assert_eq!(p.counts.invalid, 0);
        assert_eq!(p.counts.kept(), 5);
        assert!(check(&p).is_ok());
    }

    #[test]
    fn classical_list_and_text() {
        let p = parse(
            "// ACL4SSR\r\n; comment\r\nDOMAIN-SUFFIX,Example.COM\r\ndomain,www.example.org\r\nIP-CIDR6,2001:DB8::1/32,no-resolve\r\nIP-CIDR,10.1.2.3/8\r\nUSER-AGENT,Instagram*\r\nAND,((DOMAIN,x.com),(NETWORK,UDP))\r\nDOMAIN-REGEX,^ads\\.\r\nDOMAIN-SUFFIX,.lead-dot.net\r\n",
        );
        assert_eq!(
            kinds(&p),
            vec![
                (RuleKind::DomainSuffix, "example.com"),
                (RuleKind::Domain, "www.example.org"),
                (RuleKind::IpCidr, "2001:db8::/32"),
                (RuleKind::IpCidr, "10.0.0.0/8"),
                (RuleKind::DomainSuffix, "lead-dot.net"),
            ]
        );
        assert_eq!(p.counts.unsupported, 3);
        assert_eq!(
            p.counts.unsupported_types.keys().collect::<Vec<_>>(),
            vec!["AND", "DOMAIN-REGEX", "USER-AGENT"]
        );
    }

    #[test]
    fn bare_forms() {
        let p = parse(
            "payload:\n  - '+.google.com'\n  - '.only-subs.example'\n  - 'exact.example.net.'\n  - '*.wild.example'\n  - 1.2.3.4\n  - 192.168.0.0/16\n  - '2400:cb00::/32'\n  - ::1\n",
        );
        assert_eq!(
            kinds(&p),
            vec![
                (RuleKind::DomainSuffix, "google.com"),
                (RuleKind::DomainSuffix, ".only-subs.example"),
                (RuleKind::Domain, "exact.example.net"),
                (RuleKind::IpCidr, "1.2.3.4/32"),
                (RuleKind::IpCidr, "192.168.0.0/16"),
                (RuleKind::IpCidr, "2400:cb00::/32"),
                (RuleKind::IpCidr, "::1/128"),
            ]
        );
        assert_eq!(p.counts.unsupported_types["DOMAIN-WILDCARD"], 1);
    }

    #[test]
    fn duplicates_and_junk() {
        let p = parse(
            "DOMAIN,a.com\nDOMAIN,A.com\nDOMAIN,a.com,extra\nIP-CIDR,1.2.3.0/33\nIP-CIDR,300.1.1.1/8\nDOMAIN,bad host\nDOMAIN,\n-\npayload: [x]\n\u{0}\n",
        );
        assert_eq!(kinds(&p), vec![(RuleKind::Domain, "a.com")]);
        assert_eq!(p.counts.total, 1);
        assert_eq!(p.counts.invalid, 7);
        assert_eq!(
            check(&p),
            Err(Refused::NotAList { invalid: 7 }),
            "more junk than rules"
        );
    }

    #[test]
    fn html_and_empty_are_refused() {
        let html = "<!DOCTYPE html>\n<html>\n<head><title>404 Not Found</title></head>\n<body>Not Found</body>\n</html>\n";
        assert!(matches!(check(&parse(html)), Err(Refused::NotAList { .. })));
        assert_eq!(check(&parse("# only comments\n\n")), Err(Refused::Empty));
        assert_eq!(check(&parse("payload:\n")), Err(Refused::Empty));
        assert_eq!(check(&parse("\u{feff}DOMAIN,a.com\n")), Ok(()));
    }

    #[test]
    fn too_many_rules() {
        let mut s = String::new();
        for i in 0..=MAX_RULES {
            s.push_str(&format!("DOMAIN,d{i}.example\n"));
        }
        let p = parse(&s);
        assert_eq!(check(&p), Err(Refused::TooMany));
    }

    #[test]
    fn unsupported_types_are_bounded() {
        let s: String = (0..40).map(|i| format!("TYPE-{i},x\n")).collect();
        let p = parse(&s);
        assert_eq!(p.counts.unsupported, 40);
        assert_eq!(p.counts.unsupported_types.len(), MAX_TYPES);
    }

    #[test]
    fn source_rule_set() {
        let p = parse(
            "DOMAIN,a.com\nDOMAIN-SUFFIX,b.com\n+.c.com\nDOMAIN-KEYWORD,kw\nIP-CIDR,1.2.3.0/24\n",
        );
        assert_eq!(
            source_json(&p.rules),
            json!({"version": 3, "rules": [
                {"domain": ["a.com"], "domain_suffix": ["b.com", "c.com"], "domain_keyword": ["kw"]},
                {"ip_cidr": ["1.2.3.0/24"]},
            ]})
        );
        assert_eq!(
            source_json(&parse("IP-CIDR,::/0\n").rules),
            json!({"version": 3, "rules": [{"ip_cidr": ["::/0"]}]})
        );
        assert_eq!(source_json(&[]), json!({"version": 3, "rules": []}));
    }

    #[test]
    fn cidr_normalization() {
        assert_eq!(cidr("10.1.2.3/8").as_deref(), Some("10.0.0.0/8"));
        assert_eq!(cidr("0.0.0.0/0").as_deref(), Some("0.0.0.0/0"));
        assert_eq!(cidr("2001:db8::ff/0").as_deref(), Some("::/0"));
        assert_eq!(cidr("fe80::1%eth0"), None);
        assert_eq!(cidr("1.2.3.4/+8"), None);
        assert_eq!(cidr("1.2.3.4/"), None);
        assert_eq!(cidr("1.2.3.4/0008"), None);
    }
}
