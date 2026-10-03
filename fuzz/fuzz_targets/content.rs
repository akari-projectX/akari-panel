//! Ops content: the safe Markdown renderer/sanitizer (announcements, help
//! articles, the announcement mail), its URL rules, editable mail
//! templates, branding PNG headers and request bodies.
//!
//! Input: first byte selects; the rest is the text / body.
//!
//! Invariants: no panic; the renderer emits only whitelisted tags
//! (`p br h3-h6 strong em code pre ul ol li blockquote hr a img`) with only
//! whitelisted attributes (`href target rel src alt loading`), never raw
//! input markup; every `href` passes `safe_link`, every `src` passes
//! `safe_image` (https or same-origin, never http); absolute links carry
//! `rel="noopener noreferrer"`; output size is linear in the input. An
//! accepted mail template renders a one-line subject and HTML whose tags
//! are only the mail layout's and the renderer's. PNG dimensions are
//! non-zero; request bodies are `deny_unknown_fields`.
#![no_main]

use akari_panel::fuzzing;
use libfuzzer_sys::fuzz_target;

const TAGS: [&str; 17] = [
    "p",
    "br",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "em",
    "code",
    "pre",
    "ul",
    "ol",
    "li",
    "blockquote",
    "hr",
    "a",
    "img",
];
const ATTRS: [&str; 6] = ["href", "target", "rel", "src", "alt", "loading"];
const MAIL_TAGS: [&str; 9] = [
    "!doctype", "html", "head", "meta", "title", "body", "div", "h1", "a",
];

fn unescape(v: &str) -> String {
    v.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Every tag of `html`: (name, [(attr, value)]). Panics on malformed output.
fn tags(html: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        let after = &rest[i + 1..];
        let end = after.find('>').expect("unterminated tag");
        let inner = &after[..end];
        assert!(!inner.contains('<'), "'<' inside a tag: {inner}");
        let inner = inner.strip_prefix('/').unwrap_or(inner);
        let (name, mut attrs_src) = match inner.find(' ') {
            Some(sp) => (&inner[..sp], &inner[sp + 1..]),
            None => (inner, ""),
        };
        let mut attrs = Vec::new();
        if name.eq_ignore_ascii_case("!doctype") {
            assert_eq!(attrs_src, "html", "doctype");
            attrs_src = "";
        }
        while !attrs_src.trim().is_empty() {
            let s = attrs_src.trim_start();
            let eq = s.find("=\"").expect("attribute without a quoted value");
            let key = &s[..eq];
            let vs = &s[eq + 2..];
            let close = vs.find('"').expect("unterminated attribute");
            attrs.push((key.to_string(), unescape(&vs[..close])));
            attrs_src = &vs[close + 1..];
        }
        out.push((name.to_ascii_lowercase(), attrs));
        rest = &after[end + 1..];
    }
    out
}

fn markdown(md: &str) {
    let html = fuzzing::markdown_render(md);
    assert!(html.len() <= md.len() * 24 + 64, "output too large");
    for (name, attrs) in tags(&html) {
        assert!(TAGS.contains(&name.as_str()), "tag {name}");
        let mut absolute = false;
        let mut rel = false;
        for (k, v) in &attrs {
            assert!(ATTRS.contains(&k.as_str()), "attribute {k} on {name}");
            match k.as_str() {
                "href" => {
                    assert_eq!(name, "a");
                    let (ok, _) = fuzzing::markdown_urls(v);
                    assert!(ok.is_some(), "unsafe href {v:?}");
                    absolute = ok == Some(true);
                    assert!(!v.trim().to_ascii_lowercase().starts_with("javascript"));
                }
                "src" => {
                    assert_eq!(name, "img");
                    let (_, img) = fuzzing::markdown_urls(v);
                    assert!(img, "unsafe src {v:?}");
                    assert!(!v.trim().to_ascii_lowercase().starts_with("http:"));
                }
                "rel" => {
                    assert_eq!(v, "noopener noreferrer");
                    rel = true;
                }
                "target" => assert_eq!(v, "_blank"),
                "loading" => assert_eq!(v, "lazy"),
                _ => {}
            }
        }
        if name == "a" && absolute {
            assert!(rel, "absolute link without rel");
        }
    }
}

fn template(data: &[u8]) {
    // kind index, then subject \0 body.
    let Some((&k, rest)) = data.split_first() else {
        return;
    };
    let kinds = [
        "register_code",
        "register_exists",
        "email_code",
        "password_reset",
        "order_paid",
        "expiry_soon",
        "expired",
        "quota_80",
        "quota_100",
        "test",
        "ticket_reply",
        "ticket_new",
        "node_alert",
        "announcement",
    ];
    let kind = kinds[usize::from(k) % kinds.len()];
    let text = String::from_utf8_lossy(rest);
    let (subject, body) = text.split_once('\0').unwrap_or((&text, ""));
    if let Some((s, _t, html)) = fuzzing::mail_template(kind, subject, body) {
        assert!(
            !s.chars().any(char::is_control),
            "control character in subject"
        );
        for (name, _) in tags(&html) {
            assert!(
                TAGS.contains(&name.as_str()) || MAIL_TAGS.contains(&name.as_str()) || name == "hr",
                "mail tag {name}"
            );
        }
        assert!(!html.to_ascii_lowercase().contains("<script"));
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&sel, rest)) = data.split_first() else {
        return;
    };
    let text = String::from_utf8_lossy(rest);
    match sel % 6 {
        0 | 1 => markdown(&text),
        2 => {
            let (link, img) = fuzzing::markdown_urls(&text);
            if img {
                assert!(link.is_some());
                let t = text.trim().to_ascii_lowercase();
                assert!(t.starts_with("https://") || t.starts_with('/') || t.starts_with('#'));
            }
            // The URL is judged (and used) trimmed.
            if link.is_some() {
                assert!(!text
                    .trim()
                    .chars()
                    .any(|c| c.is_control() || c.is_whitespace() || c == '"' || c == '<'));
            }
        }
        3 => template(rest),
        4 => {
            if let Some((w, h)) = fuzzing::branding_png(rest) {
                assert!(w > 0 && h > 0);
            }
            if let Ok(Some(f)) = fuzzing::branding_body(rest) {
                for u in f
                    .footer_links
                    .iter()
                    .map(|l| &l.url)
                    .chain(f.client_downloads.iter().map(|d| &d.url))
                    .chain(f.tos_url.iter())
                    .chain(f.privacy_url.iter())
                {
                    // Schemes are case-insensitive.
                    let lower = u.to_ascii_lowercase();
                    assert!(
                        lower.starts_with("https://")
                            || lower.starts_with("http://")
                            || (u.starts_with('/') && !u.starts_with("//")),
                        "{u}"
                    );
                }
            } else if let Err(e) = fuzzing::branding_body(rest) {
                panic!("{e}");
            }
        }
        _ => {
            if let Err(e) = fuzzing::content_bodies(
                rest.first().copied().unwrap_or(0),
                rest.get(1..).unwrap_or(&[]),
            ) {
                panic!("{e}");
            }
        }
    }
});
