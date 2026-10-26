//! Record requests (validation, the Cloudflare body) and the names the
//! panel itself depends on (the "dangerous" records).

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;

use crate::auth::{ApiError, bad_request};

/// The record types the console manages.
pub const TYPES: &[&str] = &["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA", "NS"];
/// Types Cloudflare can proxy (orange cloud).
pub const PROXIABLE: &[&str] = &["A", "AAAA", "CNAME"];
/// TTL 1 = "automatic".
pub const TTL_AUTO: u32 = 1;
const TTL_MIN: u32 = 60;
const TTL_MAX: u32 = 86_400;

fn auto_ttl() -> u32 {
    TTL_AUTO
}

/// Body of create / update.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordReq {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default = "auto_ttl")]
    pub ttl: u32,
    #[serde(default)]
    pub proxied: Option<bool>,
    #[serde(default)]
    pub comment: Option<String>,
    /// MX preference.
    #[serde(default)]
    pub priority: Option<u16>,
    /// SRV (`service`, `proto`, `name`, `priority`, `weight`, `port`,
    /// `target`) and CAA (`flags`, `tag`, `value`) fields.
    #[serde(default)]
    pub data: Option<Value>,
    /// The admin saw the impact on a record the panel depends on.
    #[serde(default)]
    pub confirm: bool,
}

fn invalid(field: &'static str, why: &'static str) -> ApiError {
    bad_request!(
        "dns.record_field_invalid",
        "record field {field}: {why}",
        field = field,
        why = why
    )
}

fn text_ok(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

/// A validated record, ready for Cloudflare.
#[derive(Debug, Clone, PartialEq)]
pub struct Checked {
    pub kind: &'static str,
    pub name: String,
    /// The Cloudflare request body.
    pub body: Value,
}

const SRV_KEYS: &[&str] = &[
    "service", "proto", "name", "priority", "weight", "port", "target",
];
const CAA_KEYS: &[&str] = &["flags", "tag", "value"];

fn clean_data(kind: &str, data: &Value) -> Result<Value, ApiError> {
    let allowed = if kind == "SRV" { SRV_KEYS } else { CAA_KEYS };
    let obj = data
        .as_object()
        .ok_or_else(|| invalid("data", "must be an object"))?;
    let mut out = Map::new();
    for (k, v) in obj {
        if !allowed.contains(&k.as_str()) {
            return Err(invalid("data", "unknown key"));
        }
        let scalar = match v {
            Value::String(s) => text_ok(s) && s.len() <= 2048,
            Value::Number(_) => true,
            _ => false,
        };
        if !scalar {
            return Err(invalid("data", "values must be text or numbers"));
        }
        out.insert(k.clone(), v.clone());
    }
    if allowed.iter().any(|k| !out.contains_key(*k)) {
        return Err(invalid("data", "a field is missing"));
    }
    Ok(Value::Object(out))
}

/// Validate `req` and build the Cloudflare body.
pub fn check(req: &RecordReq) -> Result<Checked, ApiError> {
    let kind = TYPES
        .iter()
        .copied()
        .find(|t| t.eq_ignore_ascii_case(req.kind.trim()))
        .ok_or_else(|| invalid("type", "unsupported record type"))?;
    let name = req.name.trim().to_string();
    if name.is_empty()
        || name.len() > 255
        || name.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(invalid("name", "1-255 characters without spaces"));
    }
    if !(req.ttl == TTL_AUTO || (TTL_MIN..=TTL_MAX).contains(&req.ttl)) {
        return Err(invalid("ttl", "automatic (1) or 60-86400 seconds"));
    }
    let comment = req
        .comment
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    if comment.chars().count() > 100 || !text_ok(&comment) {
        return Err(invalid("comment", "at most 100 characters"));
    }
    let proxied = req.proxied.unwrap_or(false);
    if proxied && !PROXIABLE.contains(&kind) {
        return Err(bad_request!(
            "dns.proxy_unsupported",
            "{kind} records cannot be proxied",
            kind = kind
        ));
    }
    let mut body = Map::new();
    body.insert("type".into(), json!(kind));
    body.insert("name".into(), json!(name));
    body.insert("comment".into(), json!(comment));
    // A proxied record has an automatic TTL.
    body.insert(
        "ttl".into(),
        json!(if proxied { TTL_AUTO } else { req.ttl }),
    );
    if PROXIABLE.contains(&kind) {
        body.insert("proxied".into(), json!(proxied));
    }
    let content = req.content.as_deref().unwrap_or_default().trim();
    match kind {
        "A" => {
            content
                .parse::<Ipv4Addr>()
                .map_err(|_| invalid("content", "not an IPv4 address"))?;
        }
        "AAAA" => {
            content
                .parse::<Ipv6Addr>()
                .map_err(|_| invalid("content", "not an IPv6 address"))?;
        }
        "SRV" | "CAA" => {
            let data = req
                .data
                .as_ref()
                .ok_or_else(|| invalid("data", "required"))?;
            body.insert("data".into(), clean_data(kind, data)?);
        }
        _ => {
            if content.is_empty() || content.len() > 2048 || !text_ok(content) {
                return Err(invalid("content", "1-2048 characters"));
            }
        }
    }
    if !matches!(kind, "SRV" | "CAA") {
        body.insert("content".into(), json!(content));
    }
    if kind == "MX" {
        body.insert("priority".into(), json!(req.priority.unwrap_or(10)));
    }
    Ok(Checked {
        kind,
        name,
        body: Value::Object(body),
    })
}

/// What the audit log keeps of a record (no secrets exist here, but only
/// the fields that matter).
pub fn audit_view(r: &super::cloudflare::Record) -> Value {
    json!({
        "type": r.kind, "name": r.name, "content": r.content, "proxied": r.proxied,
        "ttl": r.ttl, "comment": r.comment, "priority": r.priority, "data": r.data,
    })
}

/// One thing in the panel that depends on a DNS name.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Use {
    /// `main`, `sub`, `node` (site domains), `passkey`, `server` (the
    /// server's certificate domain) or `entrance` (a connect address).
    pub kind: &'static str,
    /// Shown to the admin ("服务器 hk-1", "入口 hk-1 / 直连").
    pub label: String,
}

/// Lower-case host → what depends on it.
pub type Managed = HashMap<String, Vec<Use>>;

fn host_of(authority: &str) -> String {
    let a = authority.trim().to_ascii_lowercase();
    match a.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or_default().to_string(),
        None => a.split(':').next().unwrap_or_default().to_string(),
    }
}

/// Every DNS name the panel itself depends on: site domains, the passkey
/// centre, servers' certificate domains and entrances' connect hosts.
pub async fn managed(conn: &mut PgConnection) -> sqlx::Result<Managed> {
    let mut out: Managed = HashMap::new();
    let mut add = |host: String, kind: &'static str, label: String| {
        if !host.is_empty() {
            out.entry(host).or_default().push(Use { kind, label });
        }
    };
    let domains: Vec<(String, String)> = sqlx::query_as("SELECT kind, host FROM site_domains")
        .fetch_all(&mut *conn)
        .await?;
    for (kind, host) in domains {
        let (kind, label) = match kind.as_str() {
            "main" => ("main", "主域名"),
            "sub" => ("sub", "订阅域名"),
            _ => ("node", "节点通信域名"),
        };
        add(host.to_ascii_lowercase(), kind, label.to_string());
    }
    let passkey: Option<String> =
        sqlx::query_scalar("SELECT passkey_domain FROM panel_settings WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await?
            .flatten();
    if let Some(p) = passkey {
        add(host_of(&p), "passkey", "通行密钥中心域名".to_string());
    }
    let servers: Vec<(String, String)> = sqlx::query_as(
        "SELECT tls_domain, name FROM servers WHERE tls_domain IS NOT NULL AND deleting_at IS NULL",
    )
    .fetch_all(&mut *conn)
    .await?;
    for (domain, name) in servers {
        add(
            domain.to_ascii_lowercase(),
            "server",
            format!("服务器 {name}"),
        );
    }
    let entrances: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT e.connect_host, s.name, e.name FROM entrances e \
         JOIN nodes n ON n.id = e.node_id JOIN servers s ON s.id = n.server_id \
         WHERE e.connect_host IS NOT NULL AND s.deleting_at IS NULL",
    )
    .fetch_all(&mut *conn)
    .await?;
    for (host, server, entrance) in entrances {
        add(
            host.to_ascii_lowercase(),
            "entrance",
            format!("入口 {server} / {entrance}"),
        );
    }
    Ok(out)
}

/// What depends on the record name `name` (case-insensitive).
pub fn uses_of<'a>(managed: &'a Managed, name: &str) -> &'a [Use] {
    managed
        .get(&name.trim_end_matches('.').to_ascii_lowercase())
        .map_or(&[], Vec::as_slice)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(kind: &str, name: &str, content: &str) -> RecordReq {
        RecordReq {
            kind: kind.into(),
            name: name.into(),
            content: Some(content.into()),
            ttl: TTL_AUTO,
            proxied: None,
            comment: None,
            priority: None,
            data: None,
            confirm: false,
        }
    }

    #[test]
    fn a_record_body() {
        let mut r = req("a", " www.example.test ", "192.0.2.1");
        r.proxied = Some(true);
        r.ttl = 300;
        let c = check(&r).unwrap();
        assert_eq!(c.kind, "A");
        assert_eq!(c.body["name"], "www.example.test");
        assert_eq!(c.body["proxied"], true);
        // Proxied records are always automatic.
        assert_eq!(c.body["ttl"], 1);
        assert_eq!(c.body["comment"], "");
    }

    #[test]
    fn content_is_checked_per_type() {
        for (kind, content) in [
            ("A", "2001:db8::1"),
            ("A", "999.1.1.1"),
            ("AAAA", "192.0.2.1"),
            ("CNAME", ""),
            ("TXT", "bad\u{0}"),
            ("PTR", "x"),
        ] {
            assert!(
                check(&req(kind, "x.test", content)).is_err(),
                "{kind} {content}"
            );
        }
        assert!(check(&req("AAAA", "x.test", "2001:db8::1")).is_ok());
        assert!(check(&req("TXT", "x.test", "v=spf1 -all")).is_ok());
        let mx = check(&req("MX", "x.test", "mail.x.test")).unwrap();
        assert_eq!(mx.body["priority"], 10);
    }

    #[test]
    fn limits() {
        let mut r = req("A", "x.test", "192.0.2.1");
        r.ttl = 30;
        assert!(check(&r).is_err());
        r.ttl = 86_401;
        assert!(check(&r).is_err());
        r.ttl = 60;
        assert!(check(&r).is_ok());
        r.comment = Some("x".repeat(101));
        assert!(check(&r).is_err());
        let mut t = req("TXT", "x.test", "v");
        t.proxied = Some(true);
        assert!(check(&t).is_err());
        assert!(check(&req("A", "a b.test", "192.0.2.1")).is_err());
        assert!(check(&req("A", "", "192.0.2.1")).is_err());
    }

    #[test]
    fn srv_and_caa_need_their_data() {
        let mut r = req("SRV", "_sip._tcp.x.test", "");
        assert!(check(&r).is_err());
        r.data = Some(json!({"service": "_sip", "proto": "_tcp", "name": "x.test",
            "priority": 1, "weight": 5, "port": 5060, "target": "sip.x.test"}));
        let c = check(&r).unwrap();
        assert!(c.body.get("content").is_none());
        r.data = Some(json!({"service": "_sip", "bogus": 1}));
        assert!(check(&r).is_err());
        let mut caa = req("CAA", "x.test", "");
        caa.data = Some(json!({"flags": 0, "tag": "issue", "value": "letsencrypt.org"}));
        assert!(check(&caa).is_ok());
        caa.data = Some(json!({"flags": [0], "tag": "issue", "value": "x"}));
        assert!(check(&caa).is_err());
    }

    #[test]
    fn hosts_of_authorities() {
        assert_eq!(host_of("Panel.Example.test:8443"), "panel.example.test");
        assert_eq!(host_of("[::1]:443"), "::1");
        assert_eq!(host_of("a.test"), "a.test");
    }
}
