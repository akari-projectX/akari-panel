//! Subscription routing (2026-10-13 `sub-service-groups`, replaces the W30
//! flat template): what every Clash and sing-box subscription routes where.
//!
//! The operator's model (`Config`, `panel_settings.sub_routing`, edited
//! with `PUT /settings/subscription`): sections in priority order — block
//! (rejected), direct, then the ordered **services** (each a client-side
//! group: a pinned line `primary` plus ordered `backups`, lines or region /
//! tag groups, which clients fail over along) — and the rest to the
//! default proxy (`rest`). `mode: global` = only private destinations
//! direct, everything else through the default proxy. Items are built-in
//! categories (`catalog.rs`), raw geosite/geoip lists, domains, IP ranges or
//! remote rule-set URLs. Lines are referenced by entrance id, so renames
//! follow; what a user's subscription gets is decided per user from the
//! entrances their plan grants (`groups.rs`). DNS (`dns.rs`): recommended /
//! client / custom.
//!
//! Lists are downloaded by the client (Clash `rule-providers`, sing-box
//! remote `rule_set`s) from the configured URL templates (MetaCubeX
//! meta-rules-dat on jsDelivr by default). The links format has no routing.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::catalog;
use crate::auth::{ApiError, bad_request};

/// At most this many items in one section (block, direct, a service; also
/// the error a list too long gets).
pub const MAX_RULES: usize = 64;
pub const MAX_SERVICES: usize = 32;
pub const MAX_BACKUPS: usize = 8;
pub const MAX_TAG_GROUPS: usize = 16;
pub const MAX_NAME_CHARS: usize = 32;
pub const MAX_EMOJI_CHARS: usize = 8;
pub const MAX_URL_CHARS: usize = 512;

/// Built-in rule list URLs (`{kind}` = geosite|geoip, `{name}` = the
/// list): MetaCubeX meta-rules-dat on jsDelivr (text for Clash/Stash,
/// binary .srs for sing-box).
pub const DEFAULT_CLASH_URL: &str =
    "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/{kind}/{name}.list";
pub const DEFAULT_SINGBOX_URL: &str =
    "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/{kind}/{name}.srs";

/// What an item matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Match {
    /// A built-in category id (`catalog::CATEGORIES`).
    Category,
    /// A raw geosite list (domains), e.g. `cn`, `geolocation-!cn`.
    Geosite,
    /// A raw geoip list (addresses), e.g. `cn`, `private`.
    Geoip,
    Domain,
    DomainSuffix,
    DomainKeyword,
    IpCidr,
    /// A remote rule-set URL (https; Clash: a classical rule-provider).
    RuleSet,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    #[serde(rename = "type")]
    pub kind: Match,
    pub value: String,
}

/// A line in a service's failover chain or the default proxy's target.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Ref {
    /// One entrance (a line), by id.
    Entrance(Uuid),
    /// The region group (url-test) of a node region (`nodes.region`).
    Region(String),
    /// The tag group (url-test) of an entrance tag.
    Tag(String),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Rules,
    /// Private destinations direct, everything else the default proxy.
    Global,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Service {
    /// Stable id (`[a-z0-9_-]`, 1-32; a catalog key for common services).
    pub key: String,
    /// The client group's name (with the emoji): stable, clients remember
    /// the user's choice in a group by its name.
    pub name: String,
    #[serde(default)]
    pub emoji: String,
    #[serde(default)]
    pub items: Vec<Item>,
    /// The pinned line (None = no pinned line).
    #[serde(default)]
    pub primary: Option<Uuid>,
    /// Ordered failover after the primary.
    #[serde(default)]
    pub backups: Vec<Ref>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DnsMode {
    /// The built-in servers (below), fake-ip on.
    #[default]
    Recommended,
    /// No DNS in the subscription: the client's own settings.
    Client,
    /// The operator's `cn`/`intl` servers and fake-ip switch.
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dns {
    #[serde(default)]
    pub mode: DnsMode,
    #[serde(default = "yes")]
    pub fakeip: bool,
    /// Domestic resolvers: domestic destinations and the lines' own
    /// addresses (never through the proxy).
    #[serde(default)]
    pub cn: Vec<String>,
    /// Foreign resolvers, queried through the proxy by the routing rules.
    #[serde(default)]
    pub intl: Vec<String>,
}

fn yes() -> bool {
    true
}

impl Default for Dns {
    fn default() -> Self {
        Self {
            mode: DnsMode::Recommended,
            fakeip: true,
            cn: super::dns::DEFAULT_CN
                .iter()
                .map(|s| s.to_string())
                .collect(),
            intl: super::dns::DEFAULT_INTL
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
}

impl Dns {
    /// The values subscriptions use: the built-in ones in the recommended
    /// mode.
    pub fn effective(&self) -> Dns {
        match self.mode {
            DnsMode::Recommended => Dns::default(),
            _ => self.clone(),
        }
    }
}

/// The operator's routing (`panel_settings.sub_routing`; NULL = `recommended`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub mode: Mode,
    #[serde(default)]
    pub block: Vec<Item>,
    #[serde(default)]
    pub direct: Vec<Item>,
    #[serde(default)]
    pub services: Vec<Service>,
    /// The default proxy's preselected target (None = all lines, fastest).
    #[serde(default)]
    pub rest: Option<Ref>,
    /// Entrance tags that get a group of their own.
    #[serde(default)]
    pub tag_groups: Vec<String>,
    #[serde(default)]
    pub dns: Dns,
}

fn item(kind: Match, value: &str) -> Item {
    Item {
        kind,
        value: value.into(),
    }
}

/// The built-in routing (the agreed mock's `recommended()` with no lines
/// pinned: every service falls back to the default proxy until the
/// operator picks lines).
pub fn recommended() -> Config {
    let services = ["netflix", "google", "youtube", "telegram", "ai"]
        .into_iter()
        .filter_map(catalog::service)
        .map(|s| Service {
            key: s.key.into(),
            name: s.name.into(),
            emoji: s.emoji.into(),
            items: s
                .categories
                .iter()
                .map(|c| item(Match::Category, c))
                .collect(),
            primary: None,
            backups: vec![],
        })
        .collect();
    Config {
        mode: Mode::Rules,
        block: vec![item(Match::Category, "ads")],
        direct: vec![
            item(Match::Category, "private"),
            item(Match::Category, "cn"),
            item(Match::Category, "cnip"),
        ],
        services,
        rest: None,
        tag_groups: vec![],
        dns: Dns::default(),
    }
}

/// A geosite/geoip list name: lowercase letters, digits and `-_.!@`
/// (`geolocation-!cn`, `category-ads-all`), 1-64 characters.
pub(crate) fn list_name(v: &str) -> bool {
    (1..=64).contains(&v.len())
        && v.bytes().all(|b| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || matches!(b, b'-' | b'_' | b'.' | b'!' | b'@')
        })
}

/// A remote rule-set URL: https, no whitespace, quotes or control
/// characters, at most 512 characters.
pub(crate) fn rule_set_url(v: &str) -> bool {
    v.len() <= MAX_URL_CHARS
        && v.len() > "https://".len() + 3
        && v.starts_with("https://")
        && !v
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '\\'))
}

fn item_error(section: &str, index: usize, detail: &str) -> ApiError {
    bad_request!(
        "settings.sub_rule_invalid",
        "{section} item {index}: {detail}",
        section = section,
        index = index + 1,
        detail = detail
    )
}

/// Validate and normalize one section's items (values trimmed, lowercased
/// where case does not matter, duplicates dropped).
fn parse_items(section: &str, items: Vec<Item>) -> Result<Vec<Item>, ApiError> {
    if items.len() > MAX_RULES {
        return Err(bad_request!(
            "settings.sub_rules_too_many",
            "at most {max} items in {section}",
            max = MAX_RULES,
            section = section
        ));
    }
    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    for (i, mut r) in items.into_iter().enumerate() {
        r.value = r.value.trim().to_string();
        if r.kind != Match::RuleSet {
            r.value = r.value.to_ascii_lowercase();
        }
        let ok = match r.kind {
            Match::Category => catalog::category(&r.value).is_some(),
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
            Match::IpCidr => match crate::entrances::clean_cidrs(std::slice::from_ref(&r.value)) {
                Ok(mut v) if v.len() == 1 => {
                    r.value = v.remove(0);
                    true
                }
                _ => false,
            },
            Match::RuleSet => rule_set_url(&r.value),
        };
        if !ok {
            let detail = match r.kind {
                Match::Category => "unknown category",
                Match::RuleSet => "a rule-set link must be https",
                _ => "invalid value for this item type",
            };
            return Err(item_error(section, i, detail));
        }
        if !out.contains(&r) {
            out.push(r);
        }
    }
    Ok(out)
}

fn printable_name(v: &str, max: usize) -> bool {
    let n = v.chars().count();
    (1..=max).contains(&n)
        && !v.chars().any(|c| c.is_control())
        && !v.contains([',', '"', '\\'])
        && v.trim() == v
}

fn service_error(index: usize, detail: &str) -> ApiError {
    bad_request!(
        "settings.sub_service_invalid",
        "service {index}: {detail}",
        index = index + 1,
        detail = detail
    )
}

fn line_error(detail: &str) -> ApiError {
    bad_request!(
        "settings.sub_line_invalid",
        "line reference: {detail}",
        detail = detail
    )
}

/// A region (`nodes.region`, at most 64 characters) or tag
/// (`nodemeta::tags`) reference.
fn parse_ref(r: Ref) -> Result<Ref, ApiError> {
    Ok(match r {
        Ref::Entrance(id) => Ref::Entrance(id),
        Ref::Region(v) => {
            let v = v.trim().to_string();
            if v.is_empty() || v.chars().count() > 64 || v.chars().any(char::is_control) {
                return Err(line_error("a region is 1-64 printable characters"));
            }
            Ref::Region(v)
        }
        Ref::Tag(v) => Ref::Tag(tag(&v)?),
    })
}

fn tag(v: &str) -> Result<String, ApiError> {
    match crate::nodemeta::tags(&[v.to_string()]) {
        Ok(mut t) if t.len() == 1 => Ok(t.remove(0)),
        _ => Err(line_error("a tag is 1-24 printable characters without '|'")),
    }
}

impl Config {
    /// Validate and normalize (before any lock). Entrance ids are checked
    /// against the database by the caller (`unknown_entrances`).
    pub fn parse(self) -> Result<Config, ApiError> {
        let block = parse_items("block", self.block)?;
        let direct = parse_items("direct", self.direct)?;
        if self.services.len() > MAX_SERVICES {
            return Err(bad_request!(
                "settings.sub_services_too_many",
                "at most {max} services",
                max = MAX_SERVICES
            ));
        }
        let mut keys = HashSet::new();
        let mut names = HashSet::new();
        let mut services = Vec::with_capacity(self.services.len());
        for (i, s) in self.services.into_iter().enumerate() {
            let key = s.key.trim().to_string();
            if !(1..=32).contains(&key.len())
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
            {
                return Err(service_error(i, "the key is 1-32 of a-z, 0-9, '-' and '_'"));
            }
            let name = s.name.trim().to_string();
            if !printable_name(&name, MAX_NAME_CHARS) {
                return Err(service_error(
                    i,
                    "the name is 1-32 printable characters without commas or quotes",
                ));
            }
            let emoji = s.emoji.trim().to_string();
            if !emoji.is_empty()
                && (!printable_name(&emoji, MAX_EMOJI_CHARS)
                    || emoji.chars().any(char::is_whitespace))
            {
                return Err(service_error(
                    i,
                    "the emoji is at most 8 characters without spaces",
                ));
            }
            if !keys.insert(key.clone()) || !names.insert(name.clone()) {
                return Err(bad_request!(
                    "settings.sub_service_duplicate",
                    "two services named {name}",
                    name = name
                ));
            }
            if s.backups.len() > MAX_BACKUPS {
                return Err(service_error(i, "at most 8 backups"));
            }
            let items = parse_items(&name, s.items)?;
            let mut backups: Vec<Ref> = Vec::with_capacity(s.backups.len());
            for b in s.backups {
                let b = parse_ref(b)?;
                if Some(&b) != s.primary.map(Ref::Entrance).as_ref() && !backups.contains(&b) {
                    backups.push(b);
                }
            }
            services.push(Service {
                key,
                name,
                emoji,
                items,
                primary: s.primary,
                backups,
            });
        }
        if self.tag_groups.len() > MAX_TAG_GROUPS {
            return Err(line_error("at most 16 tag groups"));
        }
        let mut tag_groups: Vec<String> = Vec::new();
        for t in &self.tag_groups {
            let t = tag(t)?;
            if !tag_groups.contains(&t) {
                tag_groups.push(t);
            }
        }
        Ok(Config {
            mode: self.mode,
            block,
            direct,
            services,
            rest: self.rest.map(parse_ref).transpose()?,
            tag_groups,
            dns: super::dns::parse(self.dns)?,
        })
    }

    /// Every entrance the configuration names (primaries, backups, rest).
    pub fn entrances(&self) -> Vec<Uuid> {
        let mut out: Vec<Uuid> = Vec::new();
        let refs = self
            .services
            .iter()
            .flat_map(|s| s.backups.iter())
            .chain(self.rest.iter());
        for id in self
            .services
            .iter()
            .filter_map(|s| s.primary)
            .chain(refs.filter_map(|r| match r {
                Ref::Entrance(id) => Some(*id),
                _ => None,
            }))
        {
            if !out.contains(&id) {
                out.push(id);
            }
        }
        out
    }
}

/// The configured entrances that do not exist (any one = 400, so a typo
/// never silently becomes "fall back to the default proxy").
pub async fn check_entrances(
    conn: &mut sqlx::PgConnection,
    config: &Config,
) -> Result<(), ApiError> {
    let ids = config.entrances();
    if ids.is_empty() {
        return Ok(());
    }
    let found: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM entrances WHERE id = ANY($1)")
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await?;
    match ids.iter().find(|id| !found.contains(id)) {
        Some(id) => Err(bad_request!(
            "settings.sub_entrance_unknown",
            "no entrance {id}",
            id = id.to_string()
        )),
        None => Ok(()),
    }
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

/// A geosite or geoip list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Kind {
    Geosite,
    Geoip,
}

impl Kind {
    pub fn id(self) -> &'static str {
        match self {
            Kind::Geosite => "geosite",
            Kind::Geoip => "geoip",
        }
    }
}

/// One matcher of an item, as both renderers need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Matcher<'a> {
    List(Kind, &'a str),
    Domain(&'a str),
    Suffix(&'a str),
    Keyword(&'a str),
    Cidr(&'a str),
    /// A remote rule-set (`provider` = its stable name).
    Remote {
        url: &'a str,
        provider: String,
    },
}

/// The stable provider name of a remote rule-set URL.
pub(crate) fn remote_name(url: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("rs-{}", &hex::encode(Sha256::digest(url.as_bytes()))[..10])
}

impl Item {
    /// The matchers this item stands for (a category may be two lists).
    pub(crate) fn matchers(&self) -> Vec<Matcher<'_>> {
        let v = self.value.as_str();
        match self.kind {
            Match::Category => catalog::category(v)
                .map(|c| {
                    c.geosite
                        .iter()
                        .map(|n| Matcher::List(Kind::Geosite, n))
                        .chain(c.geoip.iter().map(|n| Matcher::List(Kind::Geoip, n)))
                        .collect()
                })
                .unwrap_or_default(),
            Match::Geosite => vec![Matcher::List(Kind::Geosite, v)],
            Match::Geoip => vec![Matcher::List(Kind::Geoip, v)],
            Match::Domain => vec![Matcher::Domain(v)],
            Match::DomainSuffix => vec![Matcher::Suffix(v)],
            Match::DomainKeyword => vec![Matcher::Keyword(v)],
            Match::IpCidr => vec![Matcher::Cidr(v)],
            Match::RuleSet => vec![Matcher::Remote {
                url: v,
                provider: remote_name(v),
            }],
        }
    }
}

/// Where a routed section sends its traffic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    Reject,
    Direct,
    /// A service (index into `Config::services`).
    Service(usize),
}

/// The routing a subscription renders: the configuration and the list URL
/// templates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Routing {
    pub config: Config,
    pub clash_url: String,
    pub singbox_url: String,
}

impl Default for Routing {
    fn default() -> Self {
        Self {
            config: recommended(),
            clash_url: DEFAULT_CLASH_URL.into(),
            singbox_url: DEFAULT_SINGBOX_URL.into(),
        }
    }
}

impl Routing {
    /// From the stored settings (NULL = recommended; a stored value the API
    /// would refuse is replaced by the default, logged).
    pub fn of(stored: &crate::settings::Stored) -> Self {
        let d = Self::default();
        let config = match &stored.sub_routing {
            None => d.config,
            Some(v) => match serde_json::from_value::<Config>(v.clone())
                .map_err(|e| e.to_string())
                .and_then(|c| c.parse().map_err(|e| e.message().to_string()))
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!(error = %e, "stored subscription routing unusable; using the default");
                    recommended()
                }
            },
        };
        Self {
            config,
            clash_url: stored.sub_rule_set_clash_url.clone().unwrap_or(d.clash_url),
            singbox_url: stored
                .sub_rule_set_singbox_url
                .clone()
                .unwrap_or(d.singbox_url),
        }
    }

    /// The routed sections in priority order: (items, target). Global
    /// mode: private destinations direct, nothing else.
    pub(crate) fn sections(&self) -> Vec<(std::borrow::Cow<'_, [Item]>, Target)> {
        use std::borrow::Cow;
        let c = &self.config;
        if c.mode == Mode::Global {
            return vec![(
                Cow::Owned(vec![item(Match::Category, "private")]),
                Target::Direct,
            )];
        }
        let mut out = vec![
            (Cow::Borrowed(c.block.as_slice()), Target::Reject),
            (Cow::Borrowed(c.direct.as_slice()), Target::Direct),
        ];
        for (i, s) in c.services.iter().enumerate() {
            out.push((Cow::Borrowed(s.items.as_slice()), Target::Service(i)));
        }
        out
    }

    /// The geosite/geoip lists the rules use, in first-use order.
    pub(crate) fn lists(&self) -> Vec<(Kind, String)> {
        let mut out: Vec<(Kind, String)> = Vec::new();
        for (items, _) in self.sections() {
            for it in items.iter() {
                for m in it.matchers() {
                    if let Matcher::List(k, n) = m
                        && !out.iter().any(|(k2, n2)| *k2 == k && n2 == n)
                    {
                        out.push((k, n.to_string()));
                    }
                }
            }
        }
        out
    }

    /// The geosite lists routed direct (domestic DNS for them).
    pub(crate) fn direct_geosites(&self) -> Vec<String> {
        let mut out = Vec::new();
        for (items, target) in self.sections() {
            if target != Target::Direct {
                continue;
            }
            for it in items.iter() {
                for m in it.matchers() {
                    if let Matcher::List(Kind::Geosite, n) = m {
                        let n = format!("geosite-{n}");
                        if !out.contains(&n) {
                            out.push(n);
                        }
                    }
                }
            }
        }
        out
    }

    pub(crate) fn list_url(template: &str, kind: Kind, name: &str) -> String {
        template
            .replace("{kind}", kind.id())
            .replace("{name}", name)
    }
}

#[cfg(test)]
mod tests;
