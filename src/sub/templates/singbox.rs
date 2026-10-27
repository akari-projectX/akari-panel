//! sing-box (1.12+) from a JSON template: the user's proxies are appended
//! to `outbounds`; in a selector / urltest `outbounds` list the member
//! `"{all}"` expands to every proxy tag and `"{all:<regex>}"` to the tags
//! the (unanchored, Rust `regex` syntax) expression matches.

use std::collections::HashSet;

use regex::RegexBuilder;

use super::doc::Doc;
use super::{Ctx, TemplateError, proxies as docs, substitute};
use crate::sub::proxy::Proxy;

/// The keys sing-box accepts at the top of a configuration (it refuses
/// unknown ones).
const TOP_LEVEL: [&str; 10] = [
    "log",
    "dns",
    "ntp",
    "certificate",
    "endpoints",
    "inbounds",
    "outbounds",
    "route",
    "services",
    "experimental",
];

pub(super) fn parse(body: &str) -> Result<Doc, TemplateError> {
    match serde_json::from_str::<Doc>(body) {
        Ok(d @ Doc::Map(_)) => Ok(d),
        Ok(_) => Err(TemplateError::new("the template must be a JSON object")),
        Err(e) => {
            let mut t = TemplateError::new(format!("JSON: {e}"));
            if e.line() > 0 {
                t.line = Some(e.line());
                t.column = Some(e.column());
            }
            Err(t)
        }
    }
}

fn member_filter(body: &str, m: &str) -> Result<Option<Option<regex::Regex>>, TemplateError> {
    if m == "{all}" {
        return Ok(Some(None));
    }
    let Some(expr) = m.strip_prefix("{all:").and_then(|r| r.strip_suffix('}')) else {
        return Ok(None);
    };
    RegexBuilder::new(expr)
        .size_limit(1 << 20)
        .build()
        .map(|r| Some(Some(r)))
        .map_err(|e| TemplateError::at(body, m, format!("{m}: not a valid expression ({e})")))
}

pub(super) fn render(
    body: &str,
    mut doc: Doc,
    proxies: &[Proxy],
    ctx: &Ctx<'_>,
    strict: bool,
) -> Result<String, TemplateError> {
    if let Doc::Map(m) = &doc
        && let Some((k, _)) = m.iter().find(|(k, _)| !TOP_LEVEL.contains(&k.as_str()))
        && strict
    {
        return Err(TemplateError::at(body, k, format!("{k:?} is not a sing-box configuration key")));
    }
    substitute(&mut doc, ctx);
    let kept = docs::kept(proxies, "sing-box");

    let mut tags: Vec<String> = Vec::new();
    match doc.get("outbounds") {
        Some(Doc::Seq(os)) => {
            for o in os {
                match o.get("tag").and_then(Doc::as_str) {
                    Some(t) if tags.iter().any(|x| x == t) => {
                        return Err(TemplateError::at(body, t, format!("two outbounds have the tag {t:?}")));
                    }
                    Some(t) => tags.push(t.to_string()),
                    None if strict => return Err(TemplateError::new("an outbound has no tag")),
                    None => {}
                }
            }
        }
        Some(Doc::Null) | None => {}
        Some(_) => return Err(TemplateError::new("`outbounds` must be a list")),
    }
    let mut taken: HashSet<String> = tags.iter().cloned().collect();
    let names = super::unique_names(kept.iter().map(|p| p.name.as_str()), &mut taken);
    let known: HashSet<&str> = tags.iter().chain(&names).map(String::as_str).collect();

    let mut list: Vec<Doc> = match doc.get_mut("outbounds") {
        Some(Doc::Seq(v)) => std::mem::take(v),
        _ => Vec::new(),
    };
    let has_direct = tags.iter().any(|t| t == "direct");
    for o in &mut list {
        let tag = o.get("tag").and_then(Doc::as_str).unwrap_or_default().to_string();
        let Some(Doc::Seq(members)) = o.get_mut("outbounds") else {
            continue;
        };
        let mut out: Vec<Doc> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for m in members.drain(..) {
            let Doc::Str(s) = m else {
                return Err(TemplateError::at(body, &tag, format!("outbound {tag:?}: members are tags")));
            };
            match member_filter(body, &s)? {
                Some(re) => {
                    for n in &names {
                        if re.as_ref().is_none_or(|r| r.is_match(n)) && seen.insert(n.clone()) {
                            out.push(Doc::Str(n.clone()));
                        }
                    }
                }
                None if known.contains(s.as_str()) => {
                    if seen.insert(s.clone()) {
                        out.push(Doc::Str(s));
                    }
                }
                None if strict => {
                    return Err(TemplateError::at(
                        body,
                        &s,
                        format!("outbound {tag:?} refers to {s:?}, which does not exist"),
                    ));
                }
                None => tracing::debug!(outbound = %tag, member = %s, "dangling member left out"),
            }
        }
        if out.is_empty() && has_direct {
            out.push(Doc::Str("direct".into()));
        } else if out.is_empty() && strict {
            return Err(TemplateError::at(body, &tag, format!("outbound {tag:?} has no members and there is no \"direct\" outbound")));
        }
        if let Some(Doc::Str(d)) = o.get("default")
            && !out.iter().any(|m| m.as_str() == Some(d.as_str()))
            && let Doc::Map(m) = o
        {
            m.retain(|(k, _)| k != "default");
        }
        o.set("outbounds", Doc::Seq(out));
    }
    for (p, name) in kept.iter().zip(&names) {
        list.push(docs::sing_box(p).with("tag", name.as_str()));
    }
    doc.set("outbounds", Doc::Seq(list));

    // Everything else that names an outbound.
    let exists = |t: &str| known.contains(t);
    if let Some(route) = doc.get_mut("route") {
        if let Some(Doc::Seq(rules)) = route.get_mut("rules") {
            let mut out = Vec::with_capacity(rules.len());
            for r in rules.drain(..) {
                match r.get("outbound").and_then(Doc::as_str) {
                    Some(t) if !exists(t) => {
                        if strict {
                            return Err(TemplateError::at(body, t, format!("a route rule sends traffic to {t:?}, which does not exist")));
                        }
                    }
                    _ => out.push(r),
                }
            }
            *rules = out;
        }
        if let Some(Doc::Str(f)) = route.get("final")
            && !exists(f)
        {
            if strict {
                return Err(TemplateError::at(body, f, format!("route.final is {f:?}, which does not exist")));
            }
            route.set("final", if has_direct { "direct" } else { "" });
        }
    }
    if let Some(dns) = doc.get_mut("dns")
        && let Some(Doc::Seq(servers)) = dns.get_mut("servers")
    {
        for s in servers.iter_mut() {
            if let Some(Doc::Str(d)) = s.get("detour")
                && !exists(d)
            {
                if strict {
                    return Err(TemplateError::at(body, d, format!("a DNS server detours through {d:?}, which does not exist")));
                }
                if let Doc::Map(m) = s {
                    m.retain(|(k, _)| k != "detour");
                }
            }
        }
    }
    serde_json::to_string_pretty(&doc).map_err(|e| TemplateError::new(format!("JSON output: {e}")))
}
