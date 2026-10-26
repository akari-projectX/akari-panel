//! Host-name rules in one place (audit 2026-10, panel-core 6b: five copies
//! with different rules). Every place that accepts a DNS name, a host or a
//! `Host` header value from an operator, a template or an upstream list
//! calls the functions here; what differs between callers is a
//! [`NameRules`] value, not a private copy of the label loop.
//!
//! The rules of a name (RFC 1123 §2.1, RFC 952, RFC 3696 §2):
//!
//! - 1..=253 bytes, labels separated by single dots, **no trailing dot**
//!   (a caller that accepts the absolute form strips the dot first, and
//!   says so);
//! - a label is 1..=63 ASCII letters, digits and `-`, not starting or
//!   ending with `-` (so IDNA **A-labels** such as `xn--e1afmkfd` pass;
//!   turning a Unicode name into A-labels is the caller's job, with the
//!   `idna` crate, before it asks here);
//! - upper and lower case are the same name (callers lower-case what they
//!   store);
//! - the last label is not all digits (`1.2.3`, `123` are IPv4 spellings to
//!   a resolver, not names), so an IP literal is never a DNS name.
//!
//! [`NameRules`] widens that where a documented caller needs it: `_` in
//! labels (service names, many SMTP/CDN hosts), a leading `*` label (TLS
//! server names), a minimum number of labels (domains an operator binds).

use std::net::{IpAddr, Ipv6Addr};

/// The longest DNS name, in bytes of its text form.
pub const MAX_NAME_LEN: usize = 253;
/// The longest label.
pub const MAX_LABEL_LEN: usize = 63;

/// What a caller accepts on top of the common rules of the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NameRules {
    /// `_` is allowed in labels (`_dmarc`, `a_b`); the hyphen rule for the
    /// first and last byte is unchanged.
    pub underscore: bool,
    /// The first label may be exactly `*` (a wildcard name such as a
    /// REALITY server name `*.example.com`).
    pub wildcard: bool,
    /// At least this many labels (2 = "not a bare host like `localhost`").
    pub min_labels: usize,
}

impl NameRules {
    /// Letters, digits and hyphens; one label is enough.
    pub const RFC1123: Self = Self {
        underscore: false,
        wildcard: false,
        min_labels: 1,
    };
    /// Hosts that are looked up, not registered: `_` allowed.
    pub const WITH_UNDERSCORE: Self = Self {
        underscore: true,
        wildcard: false,
        min_labels: 1,
    };
    /// Names clients put in a TLS handshake (REALITY server names): `_`
    /// and a leading `*` label allowed.
    pub const SERVER_NAME: Self = Self {
        underscore: true,
        wildcard: true,
        min_labels: 1,
    };

    /// The same rules, with at least `labels` labels.
    #[must_use]
    pub const fn at_least_labels(self, labels: usize) -> Self {
        Self {
            min_labels: labels,
            ..self
        }
    }
}

fn is_label(label: &str, rules: NameRules) -> bool {
    let bytes = label.as_bytes();
    let (Some(&first), Some(&last)) = (bytes.first(), bytes.last()) else {
        return false;
    };
    bytes.len() <= MAX_LABEL_LEN
        && first != b'-'
        && last != b'-'
        && (rules.underscore || !bytes.contains(&b'_'))
        && bytes
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Whether `name` is a DNS name under `rules`. An IP literal is not.
pub fn is_dns_name(name: &str, rules: NameRules) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return false;
    }
    let labels: Vec<&str> = name.split('.').collect();
    if labels.len() < rules.min_labels.max(1) {
        return false;
    }
    let Some((last, _)) = labels.split_last() else {
        return false;
    };
    // `*` is a whole first label; the rest are ordinary labels.
    let ordinary = if rules.wildcard && labels.first() == Some(&"*") {
        &labels[1..]
    } else {
        &labels[..]
    };
    ordinary.iter().all(|label| is_label(label, rules))
        && (labels.len() == 1 || *last != "*")
        && !last.bytes().all(|b| b.is_ascii_digit())
}

/// Whether `host` is an IP literal (IPv6 without brackets) or a DNS name
/// under `rules`.
pub fn is_host(host: &str, rules: NameRules) -> bool {
    host.parse::<IpAddr>().is_ok() || is_dns_name(host, rules)
}

/// Whether `value` is a `Host` header value: a DNS name (letters, digits,
/// hyphens) or IPv4 address, or an IPv6 address **in brackets**, optionally
/// followed by `:port` (1..=65535). At most [`MAX_NAME_LEN`] bytes.
pub fn is_host_header(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_NAME_LEN {
        return false;
    }
    let (host_ok, port) = match value.strip_prefix('[') {
        Some(rest) => {
            let Some((inside, after)) = rest.split_once(']') else {
                return false;
            };
            let port = match after {
                "" => None,
                _ => match after.strip_prefix(':') {
                    Some(port) => Some(port),
                    None => return false,
                },
            };
            (inside.parse::<Ipv6Addr>().is_ok(), port)
        }
        None => match value.split_once(':') {
            Some((host, port)) => (is_host(host, NameRules::RFC1123), Some(port)),
            None => (is_host(value, NameRules::RFC1123), None),
        },
    };
    host_ok
        && port.is_none_or(|port| {
            !port.is_empty()
                && port.len() <= 5
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u16>().is_ok_and(|port| port > 0)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC: NameRules = NameRules::RFC1123;
    const UNDERSCORE: NameRules = NameRules::WITH_UNDERSCORE;
    const SERVER_NAME: NameRules = NameRules::SERVER_NAME;

    fn label(len: usize) -> String {
        "a".repeat(len)
    }

    #[track_caller]
    fn names(rules: NameRules, good: &[&str], bad: &[&str]) {
        for name in good {
            assert!(is_dns_name(name, rules), "{name:?} should be a name");
        }
        for name in bad {
            assert!(!is_dns_name(name, rules), "{name:?} should not be a name");
        }
    }

    #[test]
    fn rfc1123_names() {
        names(
            RFC,
            &[
                "example.com",
                "Example.COM",
                "localhost",
                "a.b",
                "a-b.c-d.example",
                "xn--e1afmkfd.xn--p1ai",
                "1a.example",
                "node1.example.com",
            ],
            &[
                "",
                ".",
                "example.com.",
                ".example.com",
                "a..b",
                "-a.com",
                "a-.com",
                "a_b.com",
                "a b.com",
                "a/b.com",
                "a.com:443",
                "[::1]",
                "*.example.com",
                "例子.中国",
                "a\u{0}.com",
            ],
        );
    }

    #[test]
    fn length_limits() {
        let max_label = label(MAX_LABEL_LEN);
        assert!(is_dns_name(&max_label, RFC));
        assert!(!is_dns_name(&label(MAX_LABEL_LEN + 1), RFC));
        // 4 × 63 + 3 dots = 255 > 253: three full labels and a short one.
        let long = format!("{0}.{0}.{0}.{1}", label(63), label(61));
        assert_eq!(long.len(), MAX_NAME_LEN);
        assert!(is_dns_name(&long, RFC));
        assert!(!is_dns_name(&format!("{long}a"), RFC));
    }

    /// An IP literal or an IPv4 look-alike is never a DNS name.
    #[test]
    fn numeric_last_label_is_not_a_name() {
        names(
            RFC,
            &["a.b1", "1.2.3.com", "x.1a"],
            &["1.2.3.4", "123", "1.2.3", "a.123", "999.1.1.1", "::1"],
        );
    }

    #[test]
    fn underscore_only_when_allowed() {
        names(
            UNDERSCORE,
            &["_dmarc.example.com", "a_b.example.com", "host_1", "a_.com"],
            &["-_a.com", "a b_c.com", "_a-.com"],
        );
        assert!(!is_dns_name("a_b.com", RFC));
        assert!(!is_dns_name("_dmarc.example.com", RFC));
    }

    #[test]
    fn wildcard_is_a_whole_first_label() {
        names(
            SERVER_NAME,
            &[
                "*.example.com",
                "example.com",
                "a_b.example.com",
                "*",
                "www.microsoft.com",
            ],
            &[
                "a.*.com",
                "*.*.com",
                "a*.example.com",
                "*a.example.com",
                "example.*",
                "-",
                "example.com.",
                "a b",
                "a/b",
                "<script>",
                "a\"b.com",
            ],
        );
        assert!(!is_dns_name("*.example.com", UNDERSCORE));
        assert!(!is_dns_name("*", RFC));
        assert!(!is_dns_name("*", SERVER_NAME.at_least_labels(2)));
    }

    #[test]
    fn minimum_labels() {
        let domain = RFC.at_least_labels(2);
        names(
            domain,
            &["example.com", "a.b", "x.y.example.com"],
            &["localhost", "example", "a.123", ""],
        );
        // `at_least_labels(0)` cannot weaken the "a name has a label" rule.
        assert!(!is_dns_name("", RFC.at_least_labels(0)));
    }

    #[test]
    fn hosts_are_ip_literals_or_names() {
        for good in [
            "example.com",
            "1.2.3.4",
            "::1",
            "2001:db8::1",
            "::ffff:1.2.3.4",
            "_dmarc.example.com",
            "a_b",
            "localhost",
        ] {
            assert!(is_host(good, UNDERSCORE), "{good:?}");
        }
        for bad in [
            "",
            "bad host",
            "[::1]",
            "a/b",
            "https://a.b",
            "a.b:443",
            "1.2.3",
            "123",
            "::::",
            "-a.b",
        ] {
            assert!(!is_host(bad, UNDERSCORE), "{bad:?}");
        }
    }

    #[test]
    fn host_header_values() {
        for good in [
            "example.com",
            "example.com:8443",
            "localhost",
            "localhost:1",
            "1.2.3.4",
            "1.2.3.4:65535",
            "[::1]",
            "[::1]:443",
            "[2001:db8::1]:8080",
            "xn--e1afmkfd.xn--p1ai",
        ] {
            assert!(is_host_header(good), "{good:?}");
        }
        for bad in [
            "",
            "::::",
            "[[]]",
            "[]",
            "[::1",
            "[::1]x",
            "[::1]:",
            "[::1]:0",
            "[1.2.3.4]",
            "[example.com]:443",
            "::1",
            "a:b:c",
            "example.com:",
            "example.com:0",
            "example.com:65536",
            "example.com:-1",
            "example.com:+80",
            "example.com:80:80",
            "example.com/x",
            "a b",
            "a_b.example.com",
            "*.example.com",
            "ex\"ample.com",
        ] {
            assert!(!is_host_header(bad), "{bad:?}");
        }
        let long = format!("{}.com", label(250));
        assert!(!is_host_header(&long));
    }
}
