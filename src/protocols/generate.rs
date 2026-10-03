//! W26: artifacts generated from the protocol manifest. Each one is
//! committed; `generated_artifacts_are_current` fails when one is stale and
//! `make gen-protocols` (`AKARI_REGEN=1`) rewrites them.
//!
//! - docs/DEPLOY.md §3d: the support matrix (between the GENERATED markers).

use std::collections::BTreeMap;

use super::manifest::{Manifest, Protocol};

/// A generated artifact: a whole file, or the part of a file between
/// `<!-- BEGIN GENERATED {marker} ... -->` and `<!-- END GENERATED {marker} -->`.
pub struct Artifact {
    pub path: &'static str,
    pub marker: Option<&'static str>,
    pub render: fn(&Manifest) -> String,
}

pub const ARTIFACTS: &[Artifact] = &[Artifact {
    path: "docs/DEPLOY.md",
    marker: Some("protocols-matrix"),
    render: deploy_matrix,
}];

/// `doc` with the marked section replaced by `body` (None: markers missing).
pub fn splice(doc: &str, marker: &str, body: &str) -> Option<String> {
    let begin = format!("<!-- BEGIN GENERATED {marker}");
    let end = format!("<!-- END GENERATED {marker} -->");
    let b = doc.find(&begin)?;
    let b_end = b + doc[b..].find("-->")? + 3;
    let e = b_end + doc[b_end..].find(&end)?;
    Some(format!("{}\n{body}{}", &doc[..b_end], &doc[e..]))
}

/// The expected content of `artifact` given the current file text.
pub fn expected(m: &Manifest, artifact: &Artifact, current: &str) -> Option<String> {
    let body = (artifact.render)(m);
    match artifact.marker {
        None => Some(body),
        Some(marker) => splice(current, marker, &body),
    }
}

fn label<'a>(m: &'a Manifest, kind: &str, id: &'a str) -> &'a str {
    match kind {
        "transport" => m.transport(id).map(|t| t.label.as_str()),
        "security" => m.security(id).map(|s| s.label.as_str()),
        _ => m.protocol(id).map(|p| p.label.as_str()),
    }
    .unwrap_or(id)
}

/// Securities of `p` over `transport` the validation accepts, and those
/// the templates produce.
fn securities(m: &Manifest, p: &Protocol, transport: &str) -> (Vec<String>, Vec<String>) {
    let none = BTreeMap::new();
    let legal: Vec<String> = p
        .security
        .iter()
        .filter(|s| m.violated_rule(&p.id, transport, s, &none).is_none())
        .cloned()
        .collect();
    let templates = legal
        .iter()
        .filter(|s| {
            m.violated_template_rule(&p.id, transport, s, &none)
                .is_none()
                && !(p.template_requires_tls && s.as_str() == "none")
        })
        .cloned()
        .collect();
    (legal, templates)
}

fn joined(m: &Manifest, kind: &str, ids: &[String]) -> String {
    ids.iter()
        .map(|i| label(m, kind, i))
        .collect::<Vec<_>>()
        .join(" / ")
}

fn options_cell(m: &Manifest, p: &Protocol, transport: &str, legal: &[String]) -> String {
    let mut parts = Vec::new();
    for o in p
        .option
        .iter()
        .filter(|o| o.kind == "enum" && o.values.len() > 1)
    {
        let mut vals = Vec::new();
        for v in &o.values {
            let opts = BTreeMap::from([(o.name.clone(), v.clone())]);
            let ok: Vec<String> = legal
                .iter()
                .filter(|s| m.violated_rule(&p.id, transport, s, &opts).is_none())
                .cloned()
                .collect();
            let shown = if v.is_empty() {
                "none".to_string()
            } else {
                format!("`{v}`")
            };
            if ok.is_empty() {
                continue;
            } else if ok.len() == legal.len() {
                vals.push(shown);
            } else {
                vals.push(format!("{shown} ({})", joined(m, "security", &ok)));
            }
        }
        if vals.len() > 1 || vals.first().is_some_and(|v| v != "none") {
            parts.push(format!("{}: {}", o.name, vals.join(", ")));
        }
    }
    if parts.is_empty() {
        "—".into()
    } else {
        parts.join("; ")
    }
}

/// docs/DEPLOY.md §3d: one row per protocol x accepted transport.
pub fn deploy_matrix(m: &Manifest) -> String {
    let mut out = String::new();
    let kernel = m.kernel.iter().find(|k| k.id == "xray");
    out.push_str(&format!(
        "Generated from `proto/protocols.toml` (manifest schema {}, kernel {} {}); edit the manifest, \
         then `make gen-protocols`.\n\n",
        m.schema,
        kernel.map(|k| k.label.as_str()).unwrap_or("?"),
        kernel.map(|k| k.version.as_str()).unwrap_or("?"),
    ));
    out.push_str("| Protocol | Transport | Security | Options |");
    for f in &m.format {
        out.push_str(&format!(" {} |", f.label));
    }
    out.push_str("\n|---|---|---|---|");
    for _ in &m.format {
        out.push_str("---|");
    }
    out.push('\n');
    for p in &m.protocol {
        for t in &p.transports {
            let (legal, templates) = securities(m, p, t);
            if legal.is_empty() {
                continue;
            }
            let mut sec = joined(m, "security", &legal);
            if templates != legal {
                let hand: Vec<String> = legal
                    .iter()
                    .filter(|s| !templates.contains(s))
                    .cloned()
                    .collect();
                sec = format!(
                    "{} ({}: hand-written JSON only)",
                    joined(m, "security", &templates),
                    joined(m, "security", &hand)
                );
            }
            out.push_str(&format!(
                "| {} | {} | {} | {} |",
                p.label,
                label(m, "transport", t),
                sec,
                options_cell(m, p, t, &legal)
            ));
            for f in &m.format {
                // A format either carries every security of the row or the
                // reason names the first one it cannot.
                let why = legal
                    .iter()
                    .find_map(|s| m.unsupported_in(&f.id, &p.id, t, s));
                match why {
                    Some(r) => out.push_str(&format!(" ✗ left out ({r}) |")),
                    None => out.push_str(&format!(
                        " ✓ {} |",
                        f.notes.get(&p.id).map(String::as_str).unwrap_or("")
                    )),
                }
            }
            out.push('\n');
        }
    }
    out.push_str("\nCombination rules (checked in this order, beyond each protocol's transports and security):\n\n");
    for r in &m.rule {
        out.push_str(&format!(
            "- `{}`: {}{}\n",
            r.id,
            r.doc,
            if r.template_only {
                " (templates only)"
            } else {
                ""
            }
        ));
    }
    out.push_str("\nPer-user credentials (`account_json`, keys sorted):\n\n");
    for p in &m.protocol {
        let keys: Vec<String> = p
            .credential
            .iter()
            .map(|c| match c.kind.as_str() {
                "uuid" => format!("`{}` (UUID)", c.field),
                "hex" => format!("`{}` ({} random bytes, hex)", c.field, c.bytes.unwrap_or(0)),
                "base64_key" => format!(
                    "`{}` (base64 key, length by `{}`)",
                    c.field,
                    c.key_len_from.as_deref().unwrap_or("")
                ),
                _ => format!(
                    "`{}` (= the inbound's `{}`)",
                    c.field,
                    c.from.as_deref().unwrap_or("")
                ),
            })
            .collect();
        out.push_str(&format!(
            "- {} (agent protocol name `{}`): {}{}\n",
            p.label,
            p.wire,
            keys.join(", "),
            if p.shrink_unsafe {
                "; removed users stay as gate-refused tombstones (removal = delta, rotation = rebuild)"
            } else {
                ""
            }
        ));
    }
    out.push_str("\nEnd-to-end scenarios (agent `TestRT_ProtocolMatrix`: real client, billing, speed limit, revocation, re-add): ");
    out.push_str(
        &m.scenario
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
    );
    out.push_str(".\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every generated artifact matches the manifest (`make gen-protocols`
    /// = this test with AKARI_REGEN=1 rewrites them).
    #[test]
    fn generated_artifacts_are_current() {
        let regen = std::env::var("AKARI_REGEN").is_ok_and(|v| v == "1");
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let m = super::super::manifest::get();
        let mut stale = Vec::new();
        for a in ARTIFACTS {
            let path = root.join(a.path);
            let current = std::fs::read_to_string(&path).unwrap_or_default();
            let want = expected(m, a, &current)
                .unwrap_or_else(|| panic!("{}: GENERATED markers missing", a.path));
            if want != current {
                if regen {
                    std::fs::write(&path, &want).unwrap();
                } else {
                    stale.push(a.path);
                }
            }
        }
        assert!(
            stale.is_empty(),
            "stale generated artifacts {stale:?}: run `make gen-protocols`"
        );
    }

    #[test]
    fn splice_replaces_only_the_marked_section() {
        let doc = "a\n<!-- BEGIN GENERATED x: note -->\nold\n<!-- END GENERATED x -->\nb\n";
        assert_eq!(
            splice(doc, "x", "new\n").unwrap(),
            "a\n<!-- BEGIN GENERATED x: note -->\nnew\n<!-- END GENERATED x -->\nb\n"
        );
        assert!(splice(doc, "y", "new\n").is_none());
    }
}
