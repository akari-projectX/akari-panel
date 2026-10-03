//! W26: the schema, parser and validator of `proto/protocols.toml` (the
//! protocol capability manifest). This file is compiled twice: by `build.rs`
//! (`#[path]`), which parses and validates the manifest at build time and
//! emits it as Rust construction code (`Emit`), and by the crate
//! (`protocols::manifest::def`), for the fuzz target and the consistency
//! tests. Keep it self-contained: std, serde and toml only.

use std::collections::{BTreeMap, BTreeSet};

/// Rust source that rebuilds a value (build.rs writes the manifest as code,
/// so the binary has no runtime parse that could fail).
pub trait Emit {
    fn emit(&self, out: &mut String);
}

impl Emit for String {
    fn emit(&self, out: &mut String) {
        out.push_str(&format!("String::from({self:?})"));
    }
}

impl Emit for bool {
    fn emit(&self, out: &mut String) {
        out.push_str(if *self { "true" } else { "false" });
    }
}

impl Emit for u32 {
    fn emit(&self, out: &mut String) {
        out.push_str(&format!("{self}u32"));
    }
}

impl<T: Emit> Emit for Option<T> {
    fn emit(&self, out: &mut String) {
        match self {
            None => out.push_str("None"),
            Some(v) => {
                out.push_str("Some(");
                v.emit(out);
                out.push(')');
            }
        }
    }
}

impl<T: Emit> Emit for Vec<T> {
    fn emit(&self, out: &mut String) {
        out.push_str("vec![");
        for v in self {
            v.emit(out);
            out.push_str(", ");
        }
        out.push(']');
    }
}

impl<V: Emit> Emit for BTreeMap<String, V> {
    fn emit(&self, out: &mut String) {
        out.push_str("std::collections::BTreeMap::from([");
        for (k, v) in self {
            out.push('(');
            k.emit(out);
            out.push_str(", ");
            v.emit(out);
            out.push_str("), ");
        }
        out.push_str("])");
    }
}

/// Declares the manifest structs (strict serde: unknown keys are errors)
/// together with their `Emit` implementation, so the two cannot diverge.
macro_rules! manifest_structs {
    ($( $(#[$sm:meta])* pub struct $name:ident { $( $(#[$fm:meta])* pub $f:ident : $t:ty ),* $(,)? } )*) => {
        $(
            $(#[$sm])*
            #[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            pub struct $name { $( $(#[$fm])* pub $f: $t ),* }

            impl Emit for $name {
                fn emit(&self, out: &mut String) {
                    out.push_str(concat!(stringify!($name), " { "));
                    $(
                        out.push_str(concat!(stringify!($f), ": "));
                        self.$f.emit(out);
                        out.push_str(", ");
                    )*
                    out.push('}');
                }
            }
        )*
    };
}

manifest_structs! {
    /// The whole manifest.
    pub struct Manifest {
        pub schema: u32,
        pub kernel: Vec<Kernel>,
        pub security: Vec<Security>,
        pub transport: Vec<Transport>,
        pub protocol: Vec<Protocol>,
        #[serde(default)]
        pub rule: Vec<Rule>,
        #[serde(default)]
        pub format: Vec<Format>,
        #[serde(default)]
        pub scenario: Vec<Scenario>,
    }

    /// A kernel an adapter exists for.
    pub struct Kernel {
        pub id: String,
        pub label: String,
        pub version: String,
    }

    /// A security layer (none / tls / reality).
    pub struct Security {
        pub id: String,
        pub label: String,
        pub label_zh: String,
        #[serde(default)]
        pub needs_certificate: bool,
        #[serde(default)]
        pub field: Vec<Field>,
    }

    /// A transport (tcp / ws / httpupgrade / xhttp / grpc / native).
    pub struct Transport {
        pub id: String,
        pub label: String,
        pub label_zh: String,
        pub alpn: Vec<String>,
        #[serde(default)]
        pub field: Vec<Field>,
    }

    /// A form/validation field of a transport, security layer or protocol
    /// option.
    pub struct Field {
        pub name: String,
        pub label_zh: String,
        #[serde(rename = "type")]
        pub kind: String,
        #[serde(default)]
        pub values: Vec<String>,
        #[serde(default)]
        pub value_labels_zh: Vec<String>,
        #[serde(default)]
        pub key_len: Vec<u32>,
        #[serde(default)]
        pub key_len_from: Option<String>,
        #[serde(default)]
        pub default: Option<String>,
        #[serde(default)]
        pub required: bool,
        #[serde(default)]
        pub generated: bool,
        #[serde(default)]
        pub help_zh: Option<String>,
    }

    /// A managed protocol.
    pub struct Protocol {
        pub id: String,
        pub wire: String,
        pub label: String,
        pub label_zh: String,
        pub transports: Vec<String>,
        pub security: Vec<String>,
        pub l4: String,
        #[serde(default)]
        pub template_requires_tls: bool,
        #[serde(default)]
        pub shrink_unsafe: bool,
        #[serde(default)]
        pub alpn: Vec<String>,
        #[serde(default)]
        pub credential: Vec<Credential>,
        #[serde(default)]
        pub option: Vec<Field>,
    }

    /// One key of a per-user account.
    pub struct Credential {
        pub field: String,
        pub kind: String,
        #[serde(default)]
        pub from: Option<String>,
        #[serde(default)]
        pub bytes: Option<u32>,
        #[serde(default)]
        pub key_len_from: Option<String>,
        #[serde(default)]
        pub min_len: Option<u32>,
    }

    /// A combination rule.
    pub struct Rule {
        pub id: String,
        #[serde(default)]
        pub template_only: bool,
        pub when: BTreeMap<String, Vec<String>>,
        pub require: BTreeMap<String, Vec<String>>,
        pub doc: String,
    }

    /// A subscription format.
    pub struct Format {
        pub id: String,
        pub label: String,
        #[serde(default)]
        pub notes: BTreeMap<String, String>,
        #[serde(default)]
        pub unsupported: Vec<Unsupported>,
    }

    /// What a format cannot express (all non-empty lists must match).
    pub struct Unsupported {
        #[serde(default)]
        pub protocol: Vec<String>,
        #[serde(default)]
        pub protocol_not: Vec<String>,
        #[serde(default)]
        pub transport: Vec<String>,
        #[serde(default)]
        pub security: Vec<String>,
        pub reason: String,
    }

    /// An end-to-end scenario (the agent's revocation canary runs these).
    pub struct Scenario {
        pub name: String,
        pub protocol: String,
        pub transport: String,
        pub security: String,
        #[serde(default)]
        pub options: BTreeMap<String, String>,
    }
}

/// Field types the manifest may use.
pub const FIELD_TYPES: &[&str] = &[
    "domain",
    "dest",
    "enum",
    "path",
    "host",
    "service_name",
    "base64_key",
    "l4_list",
];

/// Credential kinds the manifest may use.
pub const CREDENTIAL_KINDS: &[&str] = &["uuid", "hex", "base64_key", "option"];

/// Rule/selector keys besides `option.<name>`.
pub const SELECTOR_KEYS: &[&str] = &["protocol", "transport", "security"];

/// Parse and validate the manifest.
pub fn parse(src: &str) -> Result<Manifest, String> {
    let m: Manifest = toml::from_str(src).map_err(|e| e.to_string())?;
    validate(&m)?;
    Ok(m)
}

fn ident_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn unique<'a>(what: &str, ids: impl Iterator<Item = &'a str>) -> Result<BTreeSet<&'a str>, String> {
    let mut seen = BTreeSet::new();
    for id in ids {
        if !ident_ok(id) {
            return Err(format!(
                "{what} id {id:?}: lowercase letters, digits, - and _ only"
            ));
        }
        if !seen.insert(id) {
            return Err(format!("duplicate {what} id {id:?}"));
        }
    }
    Ok(seen)
}

fn subset(what: &str, items: &[String], known: &BTreeSet<&str>) -> Result<(), String> {
    for i in items {
        if !known.contains(i.as_str()) {
            return Err(format!("{what}: unknown {i:?}"));
        }
    }
    Ok(())
}

fn check_fields(owner: &str, fields: &[Field]) -> Result<(), String> {
    let mut names = BTreeSet::new();
    for f in fields {
        let what = format!("{owner} field {:?}", f.name);
        if !ident_ok(&f.name) || !names.insert(f.name.as_str()) {
            return Err(format!("{what}: bad or duplicate name"));
        }
        if f.label_zh.trim().is_empty() {
            return Err(format!("{what}: label_zh is required"));
        }
        if !FIELD_TYPES.contains(&f.kind.as_str()) {
            return Err(format!("{what}: unknown type {:?}", f.kind));
        }
        let enum_like = matches!(f.kind.as_str(), "enum" | "l4_list");
        if enum_like && f.values.is_empty() {
            return Err(format!("{what}: {} needs values", f.kind));
        }
        if !enum_like && !f.values.is_empty() {
            return Err(format!("{what}: only enum/l4_list fields take values"));
        }
        let distinct: BTreeSet<&String> = f.values.iter().collect();
        if distinct.len() != f.values.len() {
            return Err(format!("{what}: duplicate values"));
        }
        if !f.value_labels_zh.is_empty() && f.value_labels_zh.len() != f.values.len() {
            return Err(format!("{what}: value_labels_zh must label every value"));
        }
        if !f.key_len.is_empty() && (f.key_len.len() != f.values.len() || f.kind != "enum") {
            return Err(format!(
                "{what}: key_len must give one length per enum value"
            ));
        }
        if f.key_len.iter().any(|n| *n == 0 || *n > 64) {
            return Err(format!("{what}: key_len out of range"));
        }
        if let Some(d) = &f.default {
            let ok = match f.kind.as_str() {
                "enum" => f.values.contains(d),
                "l4_list" => !d.is_empty() && d.split(',').all(|p| f.values.iter().any(|v| v == p)),
                _ => true,
            };
            if !ok {
                return Err(format!("{what}: default {d:?} is not one of the values"));
            }
        }
        if f.kind == "base64_key" {
            let from = f.key_len_from.as_deref().unwrap_or("");
            match fields.iter().find(|o| o.name == from) {
                Some(o) if !o.key_len.is_empty() => {}
                _ => {
                    return Err(format!(
                        "{what}: key_len_from must name an enum field with key_len"
                    ));
                }
            }
        } else if f.key_len_from.is_some() {
            return Err(format!(
                "{what}: key_len_from is only for base64_key fields"
            ));
        }
        if f.generated && f.kind != "base64_key" {
            return Err(format!("{what}: only base64_key fields can be generated"));
        }
    }
    Ok(())
}

/// Every cross-reference and invariant the code relies on.
pub fn validate(m: &Manifest) -> Result<(), String> {
    if m.schema != 1 {
        return Err(format!("schema {} (this build reads schema 1)", m.schema));
    }
    let kernels = unique("kernel", m.kernel.iter().map(|k| k.id.as_str()))?;
    if !kernels.contains("xray") {
        return Err("the xray kernel must be listed".into());
    }
    let securities = unique("security", m.security.iter().map(|s| s.id.as_str()))?;
    let transports = unique("transport", m.transport.iter().map(|t| t.id.as_str()))?;
    let protocols = unique("protocol", m.protocol.iter().map(|p| p.id.as_str()))?;
    for (set, what) in [
        (&securities, "security"),
        (&transports, "transport"),
        (&protocols, "protocol"),
    ] {
        if set.is_empty() {
            return Err(format!("no {what} defined"));
        }
    }
    for s in &m.security {
        check_fields(&format!("security {:?}", s.id), &s.field)?;
    }
    for t in &m.transport {
        check_fields(&format!("transport {:?}", t.id), &t.field)?;
    }
    let mut wires = BTreeSet::new();
    let mut options: BTreeMap<&str, Vec<&Field>> = BTreeMap::new();
    for p in &m.protocol {
        let what = format!("protocol {:?}", p.id);
        if !ident_ok(&p.wire) || !wires.insert(p.wire.as_str()) {
            return Err(format!("{what}: bad or duplicate wire name {:?}", p.wire));
        }
        if p.transports.is_empty() || p.security.is_empty() {
            return Err(format!("{what}: needs transports and security"));
        }
        subset(&format!("{what} transports"), &p.transports, &transports)?;
        subset(&format!("{what} security"), &p.security, &securities)?;
        check_fields(&what, &p.option)?;
        match p.l4.as_str() {
            "tcp" | "udp" => {}
            l4 => {
                let opt = l4.strip_prefix("option:").unwrap_or("");
                if !p
                    .option
                    .iter()
                    .any(|o| o.name == opt && o.kind == "l4_list")
                {
                    return Err(format!(
                        "{what}: l4 must be tcp, udp or option:<an l4_list option>"
                    ));
                }
            }
        }
        if p.credential.is_empty() {
            return Err(format!("{what}: no credential fields"));
        }
        let mut fields = BTreeSet::new();
        for c in &p.credential {
            let cw = format!("{what} credential {:?}", c.field);
            if !ident_ok(&c.field) || !fields.insert(c.field.as_str()) {
                return Err(format!("{cw}: bad or duplicate field"));
            }
            if !CREDENTIAL_KINDS.contains(&c.kind.as_str()) {
                return Err(format!("{cw}: unknown kind {:?}", c.kind));
            }
            let ok = match c.kind.as_str() {
                "hex" => {
                    c.bytes.is_some_and(|b| (1..=64).contains(&b))
                        && c.from.is_none()
                        && c.key_len_from.is_none()
                }
                "base64_key" => {
                    c.bytes.is_none()
                        && c.from.is_none()
                        && p.option.iter().any(|o| {
                            Some(&o.name) == c.key_len_from.as_ref() && !o.key_len.is_empty()
                        })
                }
                "option" => {
                    c.bytes.is_none()
                        && c.key_len_from.is_none()
                        && p.option
                            .iter()
                            .any(|o| Some(&o.name) == c.from.as_ref() && o.kind == "enum")
                }
                _ => c.bytes.is_none() && c.from.is_none() && c.key_len_from.is_none(),
            };
            if !ok {
                return Err(format!("{cw}: parameters do not fit kind {:?}", c.kind));
            }
        }
        for o in &p.option {
            options.entry(o.name.as_str()).or_default().push(o);
        }
        if p.alpn.iter().any(String::is_empty) {
            return Err(format!("{what}: empty alpn"));
        }
    }
    let selector = |what: &str, key: &str, values: &[String]| -> Result<(), String> {
        let known: BTreeSet<&str> = match key {
            "protocol" | "protocol_not" => protocols.clone(),
            "transport" => transports.clone(),
            "security" => securities.clone(),
            k => match k.strip_prefix("option.").and_then(|o| options.get(o)) {
                Some(fields) => fields
                    .iter()
                    .flat_map(|f| f.values.iter().map(String::as_str))
                    .collect(),
                None => return Err(format!("{what}: unknown key {key:?}")),
            },
        };
        if values.is_empty() {
            return Err(format!("{what}: {key} lists nothing"));
        }
        for v in values {
            if !known.contains(v.as_str()) {
                return Err(format!("{what}: {key} has unknown value {v:?}"));
            }
        }
        Ok(())
    };
    let rules = unique("rule", m.rule.iter().map(|r| r.id.as_str()))?;
    let _ = rules;
    for r in &m.rule {
        let what = format!("rule {:?}", r.id);
        if r.when.is_empty() || r.require.is_empty() || r.doc.trim().is_empty() {
            return Err(format!("{what}: needs when, require and doc"));
        }
        for (k, v) in r.when.iter().chain(&r.require) {
            selector(&what, k, v)?;
        }
    }
    let _ = unique("format", m.format.iter().map(|f| f.id.as_str()))?;
    for f in &m.format {
        let what = format!("format {:?}", f.id);
        for k in f.notes.keys() {
            if !protocols.contains(k.as_str()) {
                return Err(format!("{what}: note for unknown protocol {k:?}"));
            }
        }
        for u in &f.unsupported {
            if u.reason.trim().is_empty() {
                return Err(format!("{what}: unsupported entry without a reason"));
            }
            let lists = [
                ("protocol", &u.protocol),
                ("protocol_not", &u.protocol_not),
                ("transport", &u.transport),
                ("security", &u.security),
            ];
            if lists.iter().all(|(_, l)| l.is_empty()) {
                return Err(format!("{what}: unsupported entry matches everything"));
            }
            for (k, l) in lists {
                if !l.is_empty() {
                    selector(&what, k, l)?;
                }
            }
        }
    }
    let mut names = BTreeSet::new();
    for s in &m.scenario {
        let what = format!("scenario {:?}", s.name);
        if s.name.trim().is_empty() || !names.insert(s.name.as_str()) {
            return Err(format!("{what}: empty or duplicate name"));
        }
        let Some(p) = m.protocol.iter().find(|p| p.id == s.protocol) else {
            return Err(format!("{what}: unknown protocol"));
        };
        if !p.transports.contains(&s.transport) || !p.security.contains(&s.security) {
            return Err(format!(
                "{what}: transport/security not accepted for {}",
                p.id
            ));
        }
        for (k, v) in &s.options {
            match p.option.iter().find(|o| &o.name == k) {
                Some(o) if o.values.contains(v) => {}
                _ => {
                    return Err(format!(
                        "{what}: option {k}={v:?} is not a value of {}",
                        p.id
                    ));
                }
            }
        }
        if let Some(r) = violated_rule(m, &s.protocol, &s.transport, &s.security, &s.options, true)
        {
            return Err(format!("{what}: violates rule {r:?}"));
        }
    }
    Ok(())
}

/// Does a selector map (`when` of a rule) match this combination? Option
/// keys match only when the option is set to one of the listed values.
pub fn selects(
    sel: &BTreeMap<String, Vec<String>>,
    protocol: &str,
    transport: &str,
    security: &str,
    options: &BTreeMap<String, String>,
) -> bool {
    sel.iter().all(|(k, vals)| {
        let v = match k.as_str() {
            "protocol" => Some(protocol),
            "transport" => Some(transport),
            "security" => Some(security),
            k => k
                .strip_prefix("option.")
                .and_then(|o| options.get(o))
                .map(String::as_str),
        };
        v.is_some_and(|v| vals.iter().any(|x| x == v))
    })
}

/// The first rule this combination breaks (`with_templates`: also the
/// template-only rules).
pub fn violated_rule<'a>(
    m: &'a Manifest,
    protocol: &str,
    transport: &str,
    security: &str,
    options: &BTreeMap<String, String>,
    with_templates: bool,
) -> Option<&'a str> {
    m.rule
        .iter()
        .filter(|r| with_templates || !r.template_only)
        .find(|r| {
            selects(&r.when, protocol, transport, security, options)
                && !selects(&r.require, protocol, transport, security, options)
        })
        .map(|r| r.id.as_str())
}
