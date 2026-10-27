//! Surge and Surfboard profiles from a text template. Placeholders:
//!
//! - `$proxies` alone on a line: one proxy line per entrance;
//! - `$proxy_group`: the proxy names, `, ` separated (`DIRECT` when the
//!   user has none) — put it where a group lists its members;
//! - `$subs_link`, `$subs_domain`, `$site_name`, `$subscribe_info`
//!   (`upload=…, download=…, total=…, expire=…`).
//!
//! Every substituted value is a single line, and proxy names go through
//! `surge::safe_name`, so a name or password can never add a line, a
//! parameter or a section to the profile.
//! Syntax: https://manual.nssurge.com/ (policy groups, rules, managed
//! profiles) and https://getsurfboard.com/docs/profile-format/.

use std::collections::HashSet;

use super::{Ctx, TemplateError, rule_target};
use crate::sub::proxy::Proxy;
use crate::sub::surge::{Dialect, line, safe_name};

const BUILTIN: [&str; 3] = ["DIRECT", "REJECT", "REJECT-NO-DROP"];
const SECTIONS: [&str; 3] = ["Proxy", "Proxy Group", "Rule"];

fn one_line(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            c if c.is_control() => ' ',
            '"' => '\'',
            c => c,
        })
        .collect()
}

/// Replace `$token`s in one pass (a substituted value is never scanned
/// again).
fn fill(line: &str, tokens: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(i) = rest.find('$') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // Longest token first so `$proxy_group` is not read as `$proxies`.
        match tokens
            .iter()
            .filter(|(t, _)| rest.starts_with(t))
            .max_by_key(|(t, _)| t.len())
        {
            Some((t, v)) => {
                out.push_str(v);
                rest = &rest[t.len()..];
            }
            None => {
                out.push('$');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

pub(super) fn render(
    d: Dialect,
    body: &str,
    proxies: &[Proxy],
    ctx: &Ctx<'_>,
    strict: bool,
) -> Result<String, TemplateError> {
    // Names the template itself defines (groups) must not collide with a
    // proxy's.
    let mut taken: HashSet<String> = BUILTIN.iter().map(|s| (*s).to_string()).collect();
    let mut section = String::new();
    for l in body.lines() {
        let t = l.trim();
        if let Some(s) = t.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            section = s.to_string();
        } else if section == "Proxy Group"
            && !t.starts_with(['#', ';'])
            && let Some((n, _)) = t.split_once('=')
        {
            taken.insert(n.trim().to_string());
        }
    }
    let sanitized: Vec<String> = proxies.iter().map(|p| safe_name(&p.name)).collect();
    let names = super::unique_names(sanitized.iter().map(String::as_str), &mut taken);
    let mut lines: Vec<String> = Vec::new();
    let mut kept_names: Vec<String> = Vec::new();
    for (p, name) in proxies.iter().zip(&names) {
        match line(p, name, d) {
            Ok(l) => {
                lines.push(l);
                kept_names.push(name.clone());
            }
            Err(why) => crate::sub::proxy::log_omitted(p, ctx.format_id, why),
        }
    }
    let group = if kept_names.is_empty() {
        "DIRECT".to_string()
    } else {
        kept_names.join(", ")
    };
    let info = format!(
        "upload={}, download={}, total={}, expire={}",
        ctx.info.upload, ctx.info.download, ctx.info.total, ctx.info.expire
    );
    let tokens = [
        ("$proxy_group", group),
        ("$subs_link", one_line(ctx.subs_link)),
        ("$subs_domain", one_line(ctx.subs_domain)),
        ("$site_name", one_line(ctx.site_name)),
        ("$subscribe_info", info),
    ];
    let mut out: Vec<String> = Vec::new();
    for l in body.lines() {
        let t = l.trim();
        if t == "$proxies" {
            out.extend(lines.iter().cloned());
        } else if t.starts_with(['#', ';']) && !t.starts_with("#!MANAGED-CONFIG") {
            out.push(l.to_string()); // comments are not templates
        } else {
            out.push(fill(l, &tokens));
        }
    }
    check(d, body, &out, &kept_names, strict)
}

/// Check (strict: report) or prune (otherwise) the group members and rule
/// targets of the assembled profile.
fn check(
    _d: Dialect,
    body: &str,
    lines: &[String],
    proxy_names: &[String],
    strict: bool,
) -> Result<String, TemplateError> {
    let mut sections: Vec<String> = Vec::new();
    let mut known: HashSet<String> = BUILTIN.iter().map(|s| (*s).to_string()).collect();
    known.extend(proxy_names.iter().cloned());
    let mut section = String::new();
    for l in lines {
        let t = l.trim();
        if let Some(s) = t.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            section = s.to_string();
            sections.push(section.clone());
        } else if matches!(section.as_str(), "Proxy" | "Proxy Group")
            && !t.starts_with(['#', ';', '/'])
            && let Some((n, _)) = t.split_once('=')
        {
            known.insert(n.trim().to_string());
        }
    }
    if strict {
        for s in SECTIONS {
            if !sections.iter().any(|x| x == s) {
                return Err(TemplateError::new(format!("the template needs a [{s}] section")));
            }
        }
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    section.clear();
    for l in lines {
        let t = l.trim();
        if let Some(s) = t.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            section = s.to_string();
            out.push(l.clone());
            continue;
        }
        if t.is_empty() || t.starts_with(['#', ';', '/']) {
            out.push(l.clone());
            continue;
        }
        match section.as_str() {
            "Proxy Group" => match group_line(t, &known, strict) {
                Ok(fixed) => out.push(fixed),
                Err(m) => return Err(TemplateError::at(body, m.0.as_str(), m.1)),
            },
            "Rule" => match rule_target(t, "FINAL") {
                Some(target) if !known.contains(target) => {
                    if strict {
                        return Err(TemplateError::at(
                            body,
                            t,
                            format!("rule {t:?} sends traffic to {target:?}, which does not exist"),
                        ));
                    }
                    tracing::debug!(rule = %t, "rule with a dangling target left out");
                }
                _ => out.push(l.clone()),
            },
            _ => out.push(l.clone()),
        }
    }
    let mut text = out.join("\n");
    text.push('\n');
    Ok(text)
}

/// One `[Proxy Group]` line, as is when every member exists. A member that
/// does not exist is an error (strict: `(needle, message)`) or is dropped;
/// a group left without members gets `DIRECT`.
fn group_line(t: &str, known: &HashSet<String>, strict: bool) -> Result<String, (String, String)> {
    let Some((name, rest)) = t.split_once('=') else {
        return Ok(t.to_string());
    };
    let name = name.trim();
    let mut fields: Vec<&str> = rest.split(',').map(str::trim).collect();
    let kind = fields.remove(0);
    let (params, mut members): (Vec<&str>, Vec<&str>) = fields.into_iter().partition(|f| f.contains('='));
    let self_filling = params.iter().any(|p| {
        p.starts_with("include-all-proxies") || p.starts_with("policy-path") || p.starts_with("include-other-group")
    });
    let before = members.len();
    if strict && let Some(m) = members.iter().find(|m| !known.contains(**m)) {
        return Err((
            (*m).to_string(),
            format!("group {name:?} refers to {m:?}, which is neither a proxy nor a group"),
        ));
    }
    members.retain(|m| known.contains(*m));
    if members.is_empty() && !self_filling {
        members.push("DIRECT");
    } else if members.len() == before {
        return Ok(t.to_string());
    }
    let mut v = vec![kind];
    v.extend(members);
    v.extend(params);
    Ok(format!("{name} = {}", v.join(", ")))
}
