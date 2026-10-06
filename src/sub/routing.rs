//! W30: the routing rules every Clash and sing-box subscription carries
//! (an admin-editable template, `PUT /settings/subscription`; built-in
//! default: 广告拦截 (ads rejected), 国内直连 (private and mainland-China
//! destinations direct), 国外代理 (everything else through the proxy
//! group)). geosite/geoip rules become Clash `rule-providers` (text lists)
//! and sing-box remote `rule_set`s (binary), downloaded by the client from
//! the configured URLs; domain and IP rules are inline. The links format
//! has no routing (the client's own rules apply).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{ApiError, bad_request};

/// At most this many rules (the `panel_settings_sub_rules` CHECK).
pub const MAX_RULES: usize = 64;

/// Built-in rule list URLs (`{kind}` = geosite|geoip, `{name}` = the
/// list): MetaCubeX meta-rules-dat on jsDelivr (text for Clash/Stash,
/// binary .srs for sing-box).
pub const DEFAULT_CLASH_URL: &str =
    "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/{kind}/{name}.list";
pub const DEFAULT_SINGBOX_URL: &str =
    "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/{kind}/{name}.srs";

/// What a rule matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Match {
    /// A geosite list (domains), e.g. `cn`, `category-ads-all`.
    Geosite,
    /// A geoip list (addresses), e.g. `cn`, `private`.
    Geoip,
    Domain,
    DomainSuffix,
    DomainKeyword,
    IpCidr,
}

/// Where matching traffic goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Direct,
    Proxy,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    #[serde(rename = "type")]
    pub kind: Match,
    pub value: String,
    pub action: Action,
}

fn rule(kind: Match, value: &str, action: Action) -> Rule {
    Rule {
        kind,
        value: value.into(),
        action,
    }
}

/// The built-in template: 广告拦截, 国内直连, then 国外代理 (the final
/// rule every format adds).
pub fn default_rules() -> Vec<Rule> {
    vec![
        rule(Match::Geosite, "category-ads-all", Action::Reject),
        rule(Match::Geosite, "private", Action::Direct),
        rule(Match::Geoip, "private", Action::Direct),
        rule(Match::Geosite, "cn", Action::Direct),
        rule(Match::Geoip, "cn", Action::Direct),
    ]
}

fn invalid(index: usize, detail: &str) -> ApiError {
    bad_request!(
        "settings.sub_rule_invalid",
        "rule {index}: {detail}",
        index = index + 1,
        detail = detail
    )
}

/// A geosite/geoip list name: lowercase letters, digits and `-_.!@`
/// (`geolocation-!cn`, `category-ads-all`), 1-64 characters.
fn list_name(v: &str) -> bool {
    (1..=64).contains(&v.len())
        && v.bytes().all(|b| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || matches!(b, b'-' | b'_' | b'.' | b'!' | b'@')
        })
}

/// Validate and normalize the rules (values trimmed and lowercased where
/// case does not matter).
pub fn parse(rules: Vec<Rule>) -> Result<Vec<Rule>, ApiError> {
    if rules.len() > MAX_RULES {
        return Err(bad_request!(
            "settings.sub_rules_too_many",
            "at most {max} routing rules",
            max = MAX_RULES
        ));
    }
    rules
        .into_iter()
        .enumerate()
        .map(|(i, mut r)| {
            r.value = r.value.trim().to_ascii_lowercase();
            let ok = match r.kind {
                Match::Geosite | Match::Geoip => list_name(&r.value),
                Match::Domain | Match::DomainSuffix => {
                    crate::entrances::valid_host(&r.value)
                        && r.value.parse::<std::net::IpAddr>().is_err()
                }
                Match::DomainKeyword => {
                    (1..=64).contains(&r.value.len())
                        && r.value
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
                }
                Match::IpCidr => {
                    match crate::entrances::clean_cidrs(std::slice::from_ref(&r.value)) {
                        Ok(mut v) if v.len() == 1 => {
                            r.value = v.remove(0);
                            true
                        }
                        _ => false,
                    }
                }
            };
            if ok {
                Ok(r)
            } else {
                Err(invalid(i, "invalid value for this rule type"))
            }
        })
        .collect()
}

/// A rule-list URL template: https (or http on loopback, for tests),
/// with `{name}`.
pub fn url_template(v: &str) -> Result<String, ApiError> {
    let v = v.trim();
    let ok = (12..=512).contains(&v.len())
        && v.contains("{name}")
        && !v
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\'')
        && (v.starts_with("https://") || v.starts_with("http://127.0.0.1"));
    if ok {
        Ok(v.to_string())
    } else {
        Err(bad_request!(
            "settings.sub_rule_set_url_invalid",
            "the rule list URL must be https and contain {{name}} (and optionally {{kind}})"
        ))
    }
}

fn kind_str(m: Match) -> &'static str {
    match m {
        Match::Geosite => "geosite",
        _ => "geoip",
    }
}

/// The routing a subscription renders: rules and the list URL templates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Routing {
    pub rules: Vec<Rule>,
    pub clash_url: String,
    pub singbox_url: String,
}

impl Default for Routing {
    fn default() -> Self {
        Self {
            rules: default_rules(),
            clash_url: DEFAULT_CLASH_URL.into(),
            singbox_url: DEFAULT_SINGBOX_URL.into(),
        }
    }
}

impl Routing {
    /// From the stored settings (NULL = default; a stored value the API
    /// would refuse is replaced by the default, logged).
    pub fn of(stored: &crate::settings::Stored) -> Self {
        let d = Self::default();
        let rules = match &stored.sub_rules {
            None => d.rules,
            Some(v) => match serde_json::from_value::<Vec<Rule>>(v.clone())
                .map_err(|e| e.to_string())
                .and_then(|r| parse(r).map_err(|e| e.message().to_string()))
            {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!(error = %e, "stored subscription rules unusable; using the default");
                    default_rules()
                }
            },
        };
        Self {
            rules,
            clash_url: stored.sub_rule_set_clash_url.clone().unwrap_or(d.clash_url),
            singbox_url: stored
                .sub_rule_set_singbox_url
                .clone()
                .unwrap_or(d.singbox_url),
        }
    }

    /// The distinct geosite/geoip lists in rule order: (kind, name).
    fn lists(&self) -> Vec<(Match, &str)> {
        let mut out: Vec<(Match, &str)> = Vec::new();
        for r in &self.rules {
            if matches!(r.kind, Match::Geosite | Match::Geoip)
                && !out.iter().any(|(k, n)| *k == r.kind && *n == r.value)
            {
                out.push((r.kind, &r.value));
            }
        }
        out
    }

    fn url(template: &str, kind: Match, name: &str) -> String {
        template
            .replace("{kind}", kind_str(kind))
            .replace("{name}", name)
    }

    /// Clash `rule-providers` (YAML, empty when no list is used) and
    /// `rules` (YAML, ending with MATCH to `proxy_group`).
    pub fn clash(&self, proxy_group: &str) -> (String, String) {
        let mut providers = String::new();
        let lists = self.lists();
        if !lists.is_empty() {
            providers.push_str("rule-providers:\n");
            for (k, name) in &lists {
                let behavior = if *k == Match::Geosite {
                    "domain"
                } else {
                    "ipcidr"
                };
                providers.push_str(&format!(
                    "  {kind}-{name}:\n    type: http\n    behavior: {behavior}\n    format: text\n    url: {url}\n    interval: 86400\n",
                    kind = kind_str(*k),
                    name = name,
                    url = serde_json::to_string(&Self::url(&self.clash_url, *k, name)).unwrap_or_default(),
                ));
            }
        }
        let mut rules = String::from("rules:\n");
        for r in &self.rules {
            let target = match r.action {
                Action::Direct => "DIRECT",
                Action::Proxy => proxy_group,
                Action::Reject => "REJECT",
            };
            let line = match r.kind {
                Match::Geosite => format!("RULE-SET,geosite-{},{target}", r.value),
                Match::Geoip => format!("RULE-SET,geoip-{},{target},no-resolve", r.value),
                Match::Domain => format!("DOMAIN,{},{target}", r.value),
                Match::DomainSuffix => format!("DOMAIN-SUFFIX,{},{target}", r.value),
                Match::DomainKeyword => format!("DOMAIN-KEYWORD,{},{target}", r.value),
                Match::IpCidr if r.value.contains(':') => {
                    format!("IP-CIDR6,{},{target},no-resolve", r.value)
                }
                Match::IpCidr => format!("IP-CIDR,{},{target},no-resolve", r.value),
            };
            rules.push_str(&format!("  - {line}\n"));
        }
        rules.push_str(&format!("  - MATCH,{proxy_group}\n"));
        (providers, rules)
    }

    /// sing-box `route` (rules + rule_set) sending the rest to
    /// `proxy_tag`, `direct_tag` for direct.
    pub fn sing_box(&self, proxy_tag: &str, direct_tag: &str) -> Value {
        let mut rules = vec![
            json!({"action": "sniff"}),
            json!({"protocol": "dns", "action": "hijack-dns"}),
        ];
        for r in &self.rules {
            let mut m = match r.kind {
                Match::Geosite => json!({"rule_set": [format!("geosite-{}", r.value)]}),
                Match::Geoip => json!({"rule_set": [format!("geoip-{}", r.value)]}),
                Match::Domain => json!({"domain": [r.value]}),
                Match::DomainSuffix => json!({"domain_suffix": [r.value]}),
                Match::DomainKeyword => json!({"domain_keyword": [r.value]}),
                Match::IpCidr => json!({"ip_cidr": [r.value]}),
            };
            match r.action {
                Action::Direct => m["outbound"] = json!(direct_tag),
                Action::Proxy => m["outbound"] = json!(proxy_tag),
                Action::Reject => m["action"] = json!("reject"),
            }
            rules.push(m);
        }
        let rule_set: Vec<Value> = self
            .lists()
            .into_iter()
            .map(|(k, name)| {
                json!({"type": "remote", "tag": format!("{}-{name}", kind_str(k)), "format": "binary",
                       "url": Self::url(&self.singbox_url, k, name), "update_interval": "1d"})
            })
            .collect();
        let mut route = json!({
            "rules": rules,
            "final": proxy_tag,
            "auto_detect_interface": true,
            "default_domain_resolver": "local",
        });
        if !rule_set.is_empty() {
            route["rule_set"] = json!(rule_set);
        }
        route
    }

    /// The geosite lists routed direct (sing-box's DNS uses the local
    /// resolver for them).
    pub fn direct_geosites(&self) -> Vec<String> {
        self.rules
            .iter()
            .filter(|r| r.kind == Match::Geosite && r.action == Action::Direct)
            .map(|r| format!("geosite-{}", r.value))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(kind: Match, value: &str) -> Rule {
        rule(kind, value, Action::Direct)
    }

    #[test]
    fn parse_validates_and_normalizes() {
        let ok = parse(vec![
            r(Match::Geosite, " CN "),
            r(Match::Geosite, "geolocation-!cn"),
            r(Match::DomainSuffix, "Example.COM"),
            r(Match::IpCidr, "10.1.2.3/8"),
            r(Match::IpCidr, "2001:db8::1/32"),
            r(Match::DomainKeyword, "ads"),
        ])
        .unwrap();
        let values: Vec<&str> = ok.iter().map(|r| r.value.as_str()).collect();
        assert_eq!(
            values,
            [
                "cn",
                "geolocation-!cn",
                "example.com",
                "10.0.0.0/8",
                "2001:db8::/32",
                "ads"
            ]
        );
        for bad in [
            r(Match::Geosite, ""),
            r(Match::Geosite, "cn/../x"),
            r(Match::Geoip, "c n"),
            r(Match::Domain, "1.2.3.4"),
            r(Match::DomainSuffix, "-bad-.com"),
            r(Match::DomainKeyword, "a,b"),
            r(Match::IpCidr, "10.0.0.0/33"),
            r(Match::IpCidr, "example.com"),
        ] {
            let e = parse(vec![r(Match::Geosite, "cn"), bad.clone()]).unwrap_err();
            assert_eq!(e.code(), "settings.sub_rule_invalid", "{bad:?}");
            assert_eq!(e.params()["index"], 2);
        }
        let many = vec![r(Match::Geosite, "cn"); MAX_RULES + 1];
        assert_eq!(
            parse(many).unwrap_err().code(),
            "settings.sub_rules_too_many"
        );
        // A rule value cannot break out of a YAML line or a rule.
        assert!(parse(vec![r(Match::DomainSuffix, "a.com\n  - MATCH,DIRECT")]).is_err());
    }

    #[test]
    fn url_templates() {
        assert!(url_template("https://m.example/{kind}/{name}.list").is_ok());
        assert!(url_template(" https://m.example/x/{name}.srs ").is_ok());
        assert!(url_template("http://127.0.0.1:8080/{name}").is_ok());
        for bad in [
            "https://m.example/static.list",
            "http://m.example/{name}",
            "ftp://m.example/{name}",
            "https://m.example/{name} x",
            "https://m.example/\"{name}",
        ] {
            assert_eq!(
                url_template(bad).unwrap_err().code(),
                "settings.sub_rule_set_url_invalid",
                "{bad}"
            );
        }
    }

    #[test]
    fn stored_values_fall_back_to_the_default() {
        let mut s = crate::settings::Stored::default();
        assert_eq!(Routing::of(&s), Routing::default());
        s.sub_rules = Some(serde_json::json!([]));
        s.sub_rule_set_clash_url = Some("https://m.example/{name}".into());
        let r = Routing::of(&s);
        assert!(r.rules.is_empty());
        assert_eq!(r.clash_url, "https://m.example/{name}");
        assert_eq!(r.singbox_url, DEFAULT_SINGBOX_URL);
        // Unusable stored rules (impossible through the API): the default.
        s.sub_rules =
            Some(serde_json::json!([{"type": "geosite", "value": "x y", "action": "direct"}]));
        assert_eq!(Routing::of(&s).rules, default_rules());
    }
}
