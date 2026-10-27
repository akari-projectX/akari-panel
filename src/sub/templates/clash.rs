//! Clash (mihomo, Clash Verge, Stash) from a YAML template: the user's
//! proxies are appended to `proxies:`; the token `$proxies` in a group's
//! `proxies:` list expands to every proxy name. Groups that select by
//! mihomo's own `include-all-proxies` / `filter` need no expansion.

use std::collections::HashSet;

use super::doc::Doc;
use super::{Ctx, TemplateError, proxies as docs, rule_target, substitute};
use crate::sub::proxy::Proxy;

/// Built-in policies a group member or rule target may name.
const BUILTIN: [&str; 5] = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"];
/// Group keys that pull in proxies by themselves.
const SELF_FILLING: [&str; 4] = ["use", "include-all", "include-all-proxies", "include-all-providers"];

pub(super) fn parse(body: &str) -> Result<Doc, TemplateError> {
    match serde_saphyr::from_str::<Doc>(body) {
        Ok(d @ Doc::Map(_)) => Ok(d),
        Ok(_) => Err(TemplateError::new("the template must be a YAML mapping")),
        Err(e) => {
            let mut t = TemplateError::new(format!("YAML: {e}"));
            if let Some(l) = e.location() {
                t.line = Some(l.line() as usize);
                t.column = Some(l.column() as usize);
            }
            Err(t)
        }
    }
}

/// Inject `proxies` into the parsed template. `strict` (saving, previews)
/// reports dangling references; otherwise (a subscription) they are left
/// out so one user's missing line never breaks the profile.
pub(super) fn render(
    body: &str,
    mut doc: Doc,
    proxies: &[Proxy],
    ctx: &Ctx<'_>,
    strict: bool,
) -> Result<String, TemplateError> {
    substitute(&mut doc, ctx);
    let kept = docs::kept(proxies, "clash");

    // Static names the template defines.
    let mut groups: Vec<String> = Vec::new();
    let mut static_proxies: Vec<String> = Vec::new();
    if let Some(Doc::Seq(gs)) = doc.get("proxy-groups") {
        for g in gs {
            match g.get("name").and_then(Doc::as_str) {
                Some(n) => {
                    if groups.iter().any(|x| x == n) {
                        return Err(TemplateError::at(body, n, format!("two proxy groups are named {n:?}")));
                    }
                    groups.push(n.to_string());
                }
                None if strict => return Err(TemplateError::new("a proxy group has no name")),
                None => {}
            }
        }
    }
    match doc.get("proxies") {
        Some(Doc::Seq(ps)) => {
            static_proxies.extend(ps.iter().filter_map(|p| p.get("name")?.as_str().map(String::from)));
        }
        Some(Doc::Null) | None => {}
        Some(_) => return Err(TemplateError::new("`proxies` must be a list")),
    }
    let mut taken: HashSet<String> = groups.iter().chain(&static_proxies).cloned().collect();
    taken.extend(BUILTIN.iter().map(|s| (*s).to_string()));
    let names = super::unique_names(kept.iter().map(|p| p.name.as_str()), &mut taken);

    // Append the user's proxies.
    let mut list: Vec<Doc> = match doc.get_mut("proxies") {
        Some(Doc::Seq(v)) => std::mem::take(v),
        _ => Vec::new(),
    };
    for (p, name) in kept.iter().zip(&names) {
        list.push(docs::clash(p).with("name", name.as_str()));
    }
    doc.set("proxies", Doc::Seq(list));

    // Names a group member or rule may refer to.
    let known: HashSet<&str> = names
        .iter()
        .chain(&static_proxies)
        .chain(&groups)
        .map(String::as_str)
        .chain(BUILTIN)
        .collect();
    let all: Vec<String> = names.clone();

    if let Some(Doc::Seq(gs)) = doc.get_mut("proxy-groups") {
        for g in gs.iter_mut() {
            let gname = g.get("name").and_then(Doc::as_str).unwrap_or_default().to_string();
            let self_filling = SELF_FILLING.iter().any(|k| g.get(k).is_some());
            let Some(Doc::Seq(items)) = g.get_mut("proxies") else {
                if g.get("proxies").is_none() && !self_filling && strict {
                    return Err(TemplateError::at(body, &gname, format!("group {gname:?} has no proxies")));
                }
                continue;
            };
            let mut out: Vec<Doc> = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            for item in items.drain(..) {
                let Doc::Str(s) = item else {
                    return Err(TemplateError::at(body, &gname, format!("group {gname:?}: members are names")));
                };
                if s == "$proxies" {
                    for n in &all {
                        if seen.insert(n.clone()) {
                            out.push(Doc::Str(n.clone()));
                        }
                    }
                } else if known.contains(s.as_str()) {
                    if seen.insert(s.clone()) {
                        out.push(Doc::Str(s));
                    }
                } else if strict {
                    return Err(TemplateError::at(
                        body,
                        &s,
                        format!("group {gname:?} refers to {s:?}, which is neither a proxy nor a group"),
                    ));
                } else {
                    tracing::debug!(group = %gname, member = %s, "dangling group member left out");
                }
            }
            if out.is_empty() {
                if self_filling && !(all.is_empty() && static_proxies.is_empty()) {
                    if let Doc::Map(m) = g {
                        m.retain(|(k, _)| k != "proxies");
                    }
                } else {
                    g.set("proxies", Doc::seq_of_strs(["DIRECT".to_string()]));
                }
            } else {
                g.set("proxies", Doc::Seq(out));
            }
        }
    }
    if strict {
        check_cycles(body, &doc)?;
    }

    if let Some(Doc::Seq(rules)) = doc.get_mut("rules") {
        let mut out = Vec::with_capacity(rules.len());
        for r in rules.drain(..) {
            let Doc::Str(line) = &r else {
                return Err(TemplateError::new("`rules` entries must be strings"));
            };
            match rule_target(line, "MATCH") {
                Some(t) if !known.contains(t) => {
                    if strict {
                        return Err(TemplateError::at(
                            body,
                            line,
                            format!("rule {line:?} sends traffic to {t:?}, which does not exist"),
                        ));
                    }
                    tracing::debug!(rule = %line, "rule with a dangling target left out");
                }
                _ => out.push(r),
            }
        }
        *rules = out;
    }
    serde_saphyr::to_string(&doc).map_err(|e| TemplateError::new(format!("YAML output: {e}")))
}

/// mihomo refuses groups that (indirectly) contain themselves.
fn check_cycles(body: &str, doc: &Doc) -> Result<(), TemplateError> {
    let Some(Doc::Seq(gs)) = doc.get("proxy-groups") else {
        return Ok(());
    };
    let edges: Vec<(&str, Vec<&str>)> = gs
        .iter()
        .filter_map(|g| {
            let name = g.get("name")?.as_str()?;
            let members = g.get("proxies")?.as_seq()?.iter().filter_map(Doc::as_str).collect();
            Some((name, members))
        })
        .collect();
    for (start, _) in &edges {
        let mut stack: Vec<&str> = vec![start];
        let mut seen: HashSet<&str> = HashSet::new();
        while let Some(n) = stack.pop() {
            let Some((_, members)) = edges.iter().find(|(x, _)| *x == n) else {
                continue;
            };
            for m in members {
                if m == start {
                    return Err(TemplateError::at(body, start, format!("group {start:?} contains itself through {n:?}")));
                }
                if seen.insert(m) {
                    stack.push(m);
                }
            }
        }
    }
    Ok(())
}
