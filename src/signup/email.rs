//! Email address syntax (W15): the one parser for every address the panel
//! stores or sends to (registration, email change, reset requests, SMTP
//! from/test addresses). Deliberately narrower than RFC 5322: a dot-atom
//! local part of printable ASCII and a DNS domain (IDN → punycode) with at
//! least two labels and an alphabetic TLD. No quoted local parts, comments,
//! IP literals or display names — nothing that could carry header syntax
//! (CR/LF, `<>`, `,`, `;`, quotes) into a message. The result is lower
//! case: addresses are compared, stored and unique in that form.

/// Longest address (RFC 5321 path limit minus the brackets).
pub const MAX_LEN: usize = 254;
const MAX_LOCAL: usize = 64;

/// atext of RFC 5322 (without the quoted forms).
fn atext(c: u8) -> bool {
    c.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~".contains(&c)
}

/// A lower-case DNS name: punycode for IDN, LDH labels of 1–63, at least
/// two labels, alphabetic (or punycode) TLD, ≤ 253 octets.
pub fn parse_domain(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_end_matches('.');
    if raw.is_empty() || raw.len() > 253 * 4 {
        return None;
    }
    let ascii = idna::domain_to_ascii(raw).ok()?;
    if ascii.is_empty() || ascii.len() > 253 {
        return None;
    }
    let labels: Vec<&str> = ascii.split('.').collect();
    if labels.len() < 2 {
        return None;
    }
    for l in &labels {
        let b = l.as_bytes();
        if b.is_empty()
            || b.len() > 63
            || b[0] == b'-'
            || b[b.len() - 1] == b'-'
            || !b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
        {
            return None;
        }
    }
    let tld = labels[labels.len() - 1];
    if !(tld.starts_with("xn--")
        || (tld.len() >= 2 && tld.bytes().all(|c| c.is_ascii_alphabetic())))
    {
        return None;
    }
    Some(ascii.to_ascii_lowercase())
}

/// Parse and normalise an address; None if it is not one we accept.
pub fn parse(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > MAX_LEN * 4 {
        return None;
    }
    let (local, domain) = s.rsplit_once('@')?;
    let lb = local.as_bytes();
    if lb.is_empty()
        || lb.len() > MAX_LOCAL
        || lb[0] == b'.'
        || lb[lb.len() - 1] == b'.'
        || local.contains("..")
        || !lb.iter().all(|&c| atext(c) || c == b'.')
    {
        return None;
    }
    let domain = parse_domain(domain)?;
    let out = format!("{}@{domain}", local.to_ascii_lowercase());
    (out.len() <= MAX_LEN).then_some(out)
}

/// The domain part of a normalised address.
pub fn domain_of(email: &str) -> &str {
    email.rsplit_once('@').map_or("", |(_, d)| d)
}

/// Whether a normalised address is admitted by the registration allow-list
/// (normalised domains; empty = any). A listed domain admits itself and its
/// subdomains (`example.com` admits `mail.example.com`).
pub fn domain_allowed(email: &str, allow: &[String]) -> bool {
    if allow.is_empty() {
        return true;
    }
    let d = domain_of(email);
    allow.iter().any(|a| {
        d == a
            || (d.len() > a.len()
                && d.ends_with(a.as_str())
                && d.as_bytes()[d.len() - a.len() - 1] == b'.')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_and_normalises() {
        assert_eq!(
            parse(" Alice.B+tag@Example.COM ").as_deref(),
            Some("alice.b+tag@example.com")
        );
        assert_eq!(
            parse("x@mail.example.co.uk").as_deref(),
            Some("x@mail.example.co.uk")
        );
        assert_eq!(
            parse("o'brien@example.org").as_deref(),
            Some("o'brien@example.org")
        );
        assert_eq!(
            parse("u@bücher.example").as_deref(),
            Some("u@xn--bcher-kva.example")
        );
        assert_eq!(
            parse("u@example.xn--p1ai").as_deref(),
            Some("u@example.xn--p1ai")
        );
        assert_eq!(parse("u@example.com.").as_deref(), Some("u@example.com"));
    }

    #[test]
    fn rejects() {
        for bad in [
            "",
            "plain",
            "@example.com",
            "a@",
            "a@localhost",
            "a@127.0.0.1",
            "a@[127.0.0.1]",
            "a@example.c0m",
            "a@example.c",
            ".a@example.com",
            "a.@example.com",
            "a..b@example.com",
            "\"a b\"@example.com",
            "a b@example.com",
            "a@exa mple.com",
            "a\r\nBcc: x@evil.com@example.com",
            "a@example.com\r\nBcc: x@evil.com",
            "a<b>@example.com",
            "a,b@example.com",
            "a;b@example.com",
            "Name <a@example.com>",
            "a@-example.com",
            "a@example-.com",
            "a@exa_mple.com",
            "ä@example.com",
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
        let long_local = format!("{}@example.com", "a".repeat(65));
        assert_eq!(parse(&long_local), None);
        let long = format!("a@{}.com", vec!["b".repeat(63); 4].join("."));
        assert_eq!(parse(&long), None, "over 254");
        assert!(parse(&format!("{}@example.com", "a".repeat(64))).is_some());
    }

    #[test]
    fn allow_list() {
        let allow = vec!["example.com".to_string(), "qq.com".to_string()];
        assert!(domain_allowed("a@example.com", &allow));
        assert!(domain_allowed("a@mail.example.com", &allow));
        assert!(!domain_allowed("a@badexample.com", &allow));
        assert!(!domain_allowed("a@example.com.evil.net", &allow));
        assert!(domain_allowed("a@qq.com", &allow));
        assert!(!domain_allowed("a@gmail.com", &allow));
        assert!(domain_allowed("a@anything.net", &[]));
        assert_eq!(domain_of("a@b.cc"), "b.cc");
        assert_eq!(parse_domain("Example.COM").as_deref(), Some("example.com"));
        assert_eq!(parse_domain("com"), None);
        assert_eq!(parse_domain("*.example.com"), None);
    }
}
