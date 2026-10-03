//! Safe Markdown subset → HTML (announcements, knowledge base, the
//! announcement mail). Rendered server-side; the output is inserted into
//! the portal as HTML, so this is a sanitizer as much as a renderer:
//!
//! - **No raw HTML.** Every character of the input that is not Markdown
//!   syntax is HTML-escaped; `<script>`, `<iframe>`, `<style>` and friends
//!   can only ever appear as text. The output uses a fixed tag set
//!   (`p br h3-h6 strong em code pre ul ol li blockquote hr a img`), no
//!   `style`, no `on*` attributes, no `id`/`class` from the input.
//! - **Links** are `https:`, `http:`, `mailto:` or same-origin (`/…`,
//!   `#…`); absolute ones get `rel="noopener noreferrer"` and open in a
//!   new tab. Anything else (`javascript:`, `data:`, `//host`, control
//!   characters, whitespace) renders as plain text.
//! - **Images** are `https:` or same-origin only (never `http:`), with the
//!   alt text escaped.
//! - Bounded: nesting is capped, and the output is at most a small
//!   constant times the input (escaping + tags), so a 64 KiB body cannot
//!   produce megabytes.
//!
//! Supported syntax: `#`–`######` headings (rendered as `<h3>`–`<h6>`, so
//! they never compete with the page's own headings), paragraphs (lines
//! joined with `<br>`), `**bold**`/`__bold__`, `*italic*`/`_italic_`,
//! `` `code` ``, fenced code blocks, `[text](url)`, `![alt](url)`, `-`/`*`
//! /`+` and `1.` lists (one level), `>` quotes, `---` rules, and `\`
//! escapes of punctuation. `fuzz/fuzz_targets/content.rs` asserts the
//! invariants above on arbitrary input.

/// Longest body (characters) the editors accept.
pub const MAX_BODY: usize = 65_536;

/// Deepest block nesting (blockquotes) and inline nesting rendered.
const MAX_DEPTH: usize = 8;

/// HTML-escape text nodes and double-quoted attribute values.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    push_esc(&mut out, s);
    out
}

fn push_esc(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
}

/// Where a URL may point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlKind {
    /// `https://…`, `http://…`, `mailto:…` (links only).
    Absolute,
    /// `/path`, `#anchor` (same origin).
    SameOrigin,
}

/// A link target the renderer accepts (`None` = rendered as plain text).
pub fn safe_link(url: &str) -> Option<UrlKind> {
    let u = url.trim();
    if u.is_empty() || u.len() > 2048 {
        return None;
    }
    if u.chars().any(|c| {
        c.is_control() || c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '`' | '\\')
    }) {
        return None;
    }
    if u.starts_with("//") {
        return None;
    }
    if u.starts_with('/') || u.starts_with('#') {
        return Some(UrlKind::SameOrigin);
    }
    let lower = u.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")
    {
        return Some(UrlKind::Absolute);
    }
    None
}

/// An image source the renderer accepts: `https:` or same-origin only.
pub fn safe_image(url: &str) -> Option<UrlKind> {
    let kind = safe_link(url)?;
    match kind {
        UrlKind::SameOrigin => Some(kind),
        UrlKind::Absolute => url
            .trim()
            .to_ascii_lowercase()
            .starts_with("https://")
            .then_some(kind),
    }
}

/// Render Markdown to HTML.
pub fn render(md: &str) -> String {
    let mut out = String::with_capacity(md.len() * 2 + 64);
    let text = md.replace("\r\n", "\n").replace('\r', "\n");
    blocks(&text, &mut out, 0);
    out
}

/// Plain-text form for the text part of mail: the Markdown source with
/// control characters (other than LF/TAB) removed.
pub fn to_text(md: &str) -> String {
    md.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}

fn is_fence(line: &str) -> Option<usize> {
    let t = line.trim_start();
    let n = t.chars().take_while(|c| *c == '`').count();
    (n >= 3).then_some(n)
}

fn is_rule(line: &str) -> bool {
    let t = line.trim();
    if t.len() < 3 {
        return false;
    }
    let mut chars = t.chars().filter(|c| !c.is_whitespace());
    let Some(first) = chars.next() else {
        return false;
    };
    if !matches!(first, '-' | '*' | '_') {
        return false;
    }
    let count = 1 + chars.clone().count();
    count >= 3 && chars.all(|c| c == first)
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let t = line.trim_start();
    let n = t.chars().take_while(|c| *c == '#').count();
    if n == 0 || n > 6 {
        return None;
    }
    let rest = &t[n..];
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim_end();
    Some((n, text))
}

fn bullet(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let mut it = t.chars();
    match (it.next(), it.next()) {
        (Some('-' | '*' | '+'), Some(' ' | '\t')) => Some(t[2..].trim()).filter(|s| !s.is_empty()),
        _ => None,
    }
}

fn numbered(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let rest = &t[digits..];
    let rest = rest.strip_prefix('.').or_else(|| rest.strip_prefix(')'))?;
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    Some(rest.trim()).filter(|s| !s.is_empty())
}

fn quoted(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let rest = t.strip_prefix('>')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

fn blocks(text: &str, out: &mut String, depth: usize) {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut i = 0;
    let mut para: Vec<&str> = Vec::new();
    let flush = |para: &mut Vec<&str>, out: &mut String| {
        if para.is_empty() {
            return;
        }
        out.push_str("<p>");
        for (k, l) in para.iter().enumerate() {
            if k > 0 {
                out.push_str("<br>");
            }
            inline(l.trim(), out, depth);
        }
        out.push_str("</p>");
        para.clear();
    };
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            flush(&mut para, out);
            i += 1;
            continue;
        }
        if let Some(n) = is_fence(line) {
            flush(&mut para, out);
            out.push_str("<pre><code>");
            i += 1;
            let mut first = true;
            while i < lines.len() {
                let l = lines[i];
                if is_fence(l).is_some_and(|m| m >= n) && l.trim().chars().all(|c| c == '`') {
                    i += 1;
                    break;
                }
                if !first {
                    out.push('\n');
                }
                first = false;
                push_esc(out, l);
                i += 1;
            }
            out.push_str("</code></pre>");
            continue;
        }
        if let Some((level, h)) = heading(line) {
            flush(&mut para, out);
            let l = (level + 2).min(6);
            out.push_str(&format!("<h{l}>"));
            inline(h, out, depth);
            out.push_str(&format!("</h{l}>"));
            i += 1;
            continue;
        }
        if is_rule(line) {
            flush(&mut para, out);
            out.push_str("<hr>");
            i += 1;
            continue;
        }
        if quoted(line).is_some() {
            flush(&mut para, out);
            let mut inner = String::new();
            while i < lines.len() {
                let Some(q) = quoted(lines[i]) else { break };
                inner.push_str(q);
                inner.push('\n');
                i += 1;
            }
            if depth < MAX_DEPTH {
                out.push_str("<blockquote>");
                blocks(&inner, out, depth + 1);
                out.push_str("</blockquote>");
            } else {
                out.push_str("<p>");
                push_esc(out, inner.trim());
                out.push_str("</p>");
            }
            continue;
        }
        if bullet(line).is_some() || numbered(line).is_some() {
            flush(&mut para, out);
            let ordered = numbered(line).is_some();
            fn item(ordered: bool, l: &str) -> Option<&str> {
                if ordered {
                    numbered(l)
                } else {
                    bullet(l)
                }
            }
            out.push_str(if ordered { "<ol>" } else { "<ul>" });
            while i < lines.len() {
                let Some(it) = item(ordered, lines[i]) else {
                    break;
                };
                out.push_str("<li>");
                inline(it, out, depth);
                out.push_str("</li>");
                i += 1;
            }
            out.push_str(if ordered { "</ol>" } else { "</ul>" });
            continue;
        }
        para.push(line);
        i += 1;
    }
    flush(&mut para, out);
}

/// The closing run of exactly `n` backticks after `start` in `s`.
fn find_code_close(s: &str, n: usize) -> Option<usize> {
    let mut i = 0;
    let b = s.as_bytes();
    while i < b.len() {
        if b[i] == b'`' {
            let run = b[i..].iter().take_while(|c| **c == b'`').count();
            if run == n {
                return Some(i);
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}

/// `[text](url)` starting at `s` (which begins with `[`): (text, url, consumed).
fn bracket_link(s: &str) -> Option<(&str, &str, usize)> {
    let rest = s.strip_prefix('[')?;
    // No nested brackets inside the text; no newlines in either part.
    let close = rest.find(']')?;
    let text = &rest[..close];
    if text.contains('[') || text.contains('\n') {
        return None;
    }
    let after = &rest[close + 1..];
    let after = after.strip_prefix('(')?;
    let end = after.find(')')?;
    let url = &after[..end];
    if url.contains('(') || url.contains('\n') {
        return None;
    }
    // Drop an optional "title" after the URL.
    let url = url.split_whitespace().next().unwrap_or("");
    Some((text, url, 1 + close + 1 + 1 + end + 1))
}

/// The closing `marker` after a non-empty inner text that does not start
/// or end with whitespace.
fn find_emph_close(s: &str, marker: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(pos) = s[from..].find(marker) {
        let at = from + pos;
        if at > 0 {
            let inner = &s[..at];
            if !inner.starts_with(char::is_whitespace) && !inner.ends_with(char::is_whitespace) {
                return Some(at);
            }
        }
        from = at + marker.len();
        if from >= s.len() {
            break;
        }
    }
    None
}

fn inline(s: &str, out: &mut String, depth: usize) {
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        let c = rest.chars().next().unwrap_or('\0');
        match c {
            '\\' => {
                let mut it = rest.chars();
                it.next();
                match it.next() {
                    Some(n) if n.is_ascii_punctuation() => {
                        push_esc(out, &n.to_string());
                        i += 1 + n.len_utf8();
                    }
                    _ => {
                        out.push('\\');
                        i += 1;
                    }
                }
            }
            '`' => {
                let n = rest.chars().take_while(|c| *c == '`').count();
                let body = &rest[n..];
                match find_code_close(body, n) {
                    Some(end) => {
                        out.push_str("<code>");
                        push_esc(out, body[..end].trim());
                        out.push_str("</code>");
                        i += n + end + n;
                    }
                    None => {
                        out.push_str(&"`".repeat(n));
                        i += n;
                    }
                }
            }
            '*' | '_' => {
                let double = rest.starts_with("**") || rest.starts_with("__");
                let marker = if double { &rest[..2] } else { &rest[..1] };
                let body = &rest[marker.len()..];
                match find_emph_close(body, marker).filter(|_| depth < MAX_DEPTH) {
                    Some(end) => {
                        let tag = if double { "strong" } else { "em" };
                        out.push_str(&format!("<{tag}>"));
                        inline(&body[..end], out, depth + 1);
                        out.push_str(&format!("</{tag}>"));
                        i += marker.len() + end + marker.len();
                    }
                    None => {
                        out.push_str(marker);
                        i += marker.len();
                    }
                }
            }
            '!' if rest[1..].starts_with('[') => match bracket_link(&rest[1..]) {
                Some((alt, url, used)) if safe_image(url).is_some() => {
                    out.push_str("<img src=\"");
                    push_esc(out, url.trim());
                    out.push_str("\" alt=\"");
                    push_esc(out, alt);
                    out.push_str("\" loading=\"lazy\">");
                    i += 1 + used;
                }
                _ => {
                    out.push('!');
                    i += 1;
                }
            },
            '[' => match bracket_link(rest) {
                Some((text, url, used)) if safe_link(url).is_some() && depth < MAX_DEPTH => {
                    let kind = safe_link(url).unwrap_or(UrlKind::SameOrigin);
                    out.push_str("<a href=\"");
                    push_esc(out, url.trim());
                    out.push('"');
                    if kind == UrlKind::Absolute {
                        out.push_str(" target=\"_blank\" rel=\"noopener noreferrer\"");
                    }
                    out.push('>');
                    // No links inside links: the text renders with the
                    // link syntax disabled.
                    inline_no_links(text, out, depth + 1);
                    out.push_str("</a>");
                    i += used;
                }
                _ => {
                    out.push('[');
                    i += 1;
                }
            },
            _ => {
                push_esc(out, &c.to_string());
                i += c.len_utf8();
            }
        }
    }
}

/// Inline rendering with `[`/`!` as plain text (link text).
fn inline_no_links(s: &str, out: &mut String, depth: usize) {
    // Split on '[' and render each piece; the brackets themselves become text.
    let mut first = true;
    for piece in s.split('[') {
        if !first {
            out.push('[');
        }
        first = false;
        inline(piece, out, depth);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_and_inline() {
        let html = render(
            "# Title\n\nSome **bold** and *em* and `code` text\nsecond line\n\n- a\n- b\n\n1. one\n2. two\n\n> quote\n> more\n\n---\n\n```\n<x> & y\n```\n",
        );
        assert_eq!(
            html,
            "<h3>Title</h3><p>Some <strong>bold</strong> and <em>em</em> and <code>code</code> text<br>second line</p>\
             <ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol>\
             <blockquote><p>quote<br>more</p></blockquote><hr><pre><code>&lt;x&gt; &amp; y</code></pre>"
        );
        assert_eq!(
            render("###### six\n####### seven"),
            "<h6>six</h6><p>####### seven</p>"
        );
    }

    #[test]
    fn raw_html_is_text() {
        let html = render(
            "<script>alert(1)</script> <img src=x onerror=alert(1)> <a href='javascript:x'>",
        );
        // Everything is text: the only tag is the paragraph.
        assert_eq!(html.matches('<').count(), 2, "{html}");
        assert!(html.starts_with("<p>&lt;script&gt;") && html.ends_with("</p>"));
        assert!(!html.contains("<img") && !html.contains("<a ") && !html.contains("<script"));
    }

    #[test]
    fn links_and_images() {
        assert_eq!(
            render("[a](https://x.example/p?q=1&r=2)"),
            "<p><a href=\"https://x.example/p?q=1&amp;r=2\" target=\"_blank\" rel=\"noopener noreferrer\">a</a></p>"
        );
        assert_eq!(
            render("[a](/app/shop)"),
            "<p><a href=\"/app/shop\">a</a></p>"
        );
        assert!(render("[a](mailto:x@y.z)").contains("href=\"mailto:x@y.z\""));
        for bad in [
            "[a](javascript:alert(1))",
            "[a](JAVASCRIPT:alert%281%29)",
            "[a](data:text/html,x)",
            "[a](//evil.example)",
            "[a](java\tscript:x)",
            "[a](https://x.example/\"onmouseover=\"x)",
        ] {
            let h = render(bad);
            assert!(!h.contains("<a"), "{bad} -> {h}");
            assert!(!h.contains("onmouseover=\""), "{bad} -> {h}");
        }
        assert_eq!(
            render("![alt \"x\"](https://x.example/i.png)"),
            "<p><img src=\"https://x.example/i.png\" alt=\"alt &quot;x&quot;\" loading=\"lazy\"></p>"
        );
        assert_eq!(
            render("![a](/brand/logo)"),
            "<p><img src=\"/brand/logo\" alt=\"a\" loading=\"lazy\"></p>"
        );
        assert!(!render("![a](http://x.example/i.png)").contains("<img"));
        // Linked images are not supported: never an image inside a link.
        let h = render("[![a](https://x/i.png)](https://y)");
        assert!(!h.contains("<a "), "{h}");
        assert_eq!(
            render("[x](https://a) [y]"),
            "<p><a href=\"https://a\" target=\"_blank\" rel=\"noopener noreferrer\">x</a> [y]</p>"
        );
    }

    #[test]
    fn literals_and_escapes() {
        assert_eq!(render("a * b _ c ** d"), "<p>a * b _ c ** d</p>");
        assert_eq!(render("\\*not em\\*"), "<p>*not em*</p>");
        assert_eq!(render("``a`b``"), "<p><code>a`b</code></p>");
        assert_eq!(render("`unclosed"), "<p>`unclosed</p>");
        assert_eq!(render("* \n-"), "<p>*<br>-</p>");
        assert_eq!(render("\r\n\r\n"), "");
        assert_eq!(to_text("a\r\nb\u{1}c"), "a\nbc");
    }

    #[test]
    fn deep_nesting_is_bounded() {
        let q = "> ".repeat(40) + "x";
        let h = render(&q);
        assert!(h.matches("<blockquote>").count() <= MAX_DEPTH + 1);
        let e = "*".repeat(200) + "x" + &"*".repeat(200);
        let h = render(&e);
        let (mut depth, mut max) = (0usize, 0usize);
        let mut rest = h.as_str();
        while let Some(i) = rest.find('<') {
            rest = &rest[i..];
            if rest.starts_with("<em>") || rest.starts_with("<strong>") {
                depth += 1;
                max = max.max(depth);
            } else if rest.starts_with("</em>") || rest.starts_with("</strong>") {
                depth -= 1;
            }
            rest = &rest[1..];
        }
        assert!(max <= MAX_DEPTH + 1, "{max}");
        assert!(h.len() <= e.len() * 16);
        assert_eq!(
            safe_link(&("https://".to_string() + &"a".repeat(3000))),
            None
        );
    }
}
