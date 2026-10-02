//! W15: email addresses (registration, email change, reset requests, SMTP
//! sender), the registration allow-list, code/token/invite shapes, the
//! registration / reset / email-change / settings request bodies, and the
//! mail templates (HTML escaping).
//!
//! Input: first byte selects the mode; the rest is the payload.
//!
//! Invariants: no panic; a parsed address is lower case, ≤ 254 bytes, has
//! exactly one '@', no character that could break a header or HTML
//! (CR/LF, '<', '>', '"', ',', ';', space) and re-parses to itself; an
//! address is always admitted by an allow-list holding its own domain and by
//! an empty list; shapes are exactly 6 ASCII digits / 43 base64url /
//! 8–32 of [a-z2-9]; request bodies refuse unknown members and their
//! validators keep control characters out; template HTML never contains an
//! unescaped '<' from the inputs.
#![no_main]

use akari_panel::fuzzing::{
    email_domain_allowed, email_parse, email_parse_domain, mail_render, signup_body, signup_shapes,
};
use libfuzzer_sys::fuzz_target;

fn address(raw: &str) {
    if let Some(e) = email_parse(raw) {
        assert!(e.len() <= 254, "{e}");
        assert_eq!(e, e.to_ascii_lowercase(), "not lower case: {e}");
        assert_eq!(e.matches('@').count(), 1, "{e}");
        assert!(
            !e.chars().any(|c| c.is_control()
                || matches!(c, '<' | '>' | '"' | ',' | ';' | ' ' | '\\' | '[' | ']')),
            "unsafe character in {e:?}"
        );
        assert_eq!(
            email_parse(&e).as_deref(),
            Some(e.as_str()),
            "not idempotent"
        );
        let domain = e
            .rsplit_once('@')
            .map(|(_, d)| d.to_string())
            .unwrap_or_default();
        assert!(email_domain_allowed(&e, &[]));
        assert!(
            email_domain_allowed(&e, std::slice::from_ref(&domain)),
            "own domain refused: {e}"
        );
        assert_eq!(
            email_parse_domain(&domain).as_deref(),
            Some(domain.as_str())
        );
    }
    if let Some(d) = email_parse_domain(raw) {
        assert_eq!(email_parse_domain(&d).as_deref(), Some(d.as_str()));
        assert!(d.len() <= 253 && d.contains('.'), "{d}");
        // A sibling that merely ends with the text is not admitted.
        assert!(!email_domain_allowed(
            &format!("a@x{d}"),
            std::slice::from_ref(&d)
        ));
    }
}

fn shapes(s: &str) {
    let (code, token, invite) = signup_shapes(s);
    assert_eq!(code, s.len() == 6 && s.bytes().all(|b| b.is_ascii_digit()));
    assert_eq!(
        token,
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    );
    assert_eq!(
        invite,
        (8..=32).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || (b'2'..=b'9').contains(&b))
    );
}

fn templates(s: &str) {
    let (name, code) = s.split_once('\n').unwrap_or((s, ""));
    // Escaping: the inputs add no markup — the number of '<' in each HTML
    // part is the template's own, whatever the plan name, site or code.
    let base = mail_render("", "");
    for ((subject, _text, html), (_, _, html0)) in mail_render(name, code).into_iter().zip(base) {
        assert_eq!(
            html.matches('<').count(),
            html0.matches('<').count(),
            "input added markup"
        );
        assert!(!subject.chars().any(char::is_control), "{subject:?}");
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    match mode % 4 {
        0 => {
            if let Ok(s) = std::str::from_utf8(rest) {
                address(s);
            }
        }
        1 => {
            if let Ok(s) = std::str::from_utf8(rest) {
                shapes(s);
            }
        }
        2 => {
            if let Some((&kind, body)) = rest.split_first()
                && let Err(e) = signup_body(kind, body)
            {
                panic!("{e}");
            }
        }
        _ => {
            if let Ok(s) = std::str::from_utf8(rest) {
                templates(s);
            }
        }
    }
});
