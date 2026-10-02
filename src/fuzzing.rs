//! Entry points for the fuzz targets (`fuzz/`, cargo-fuzz). Compiled only
//! under `--cfg fuzzing` (cargo-fuzz sets it for every crate it builds), so
//! nothing here exists in the release binary, the tests or the benches.
//! Each function exposes one crate-private parser exactly as the panel
//! calls it; the targets assert their invariants on top.

use std::collections::BTreeMap;

use serde_json::Value;

/// `billing::api::parse_form`: the Alipay notify body decoder.
pub fn alipay_parse_form(body: &[u8]) -> Option<BTreeMap<String, String>> {
    crate::billing::api::parse_form(body)
}

/// Maximum parameters `alipay_parse_form` accepts.
pub const ALIPAY_MAX_NOTIFY_PARAMS: usize = crate::billing::api::MAX_NOTIFY_PARAMS;

/// `api::validate_inbounds` (admin-supplied inbounds JSON), error as text.
pub fn validate_inbounds(inbounds: &Value) -> Result<(), String> {
    crate::api::validate_inbounds(inbounds).map_err(|e| e.message().to_string())
}

/// `sub::plausible_token` (subscription path segment).
pub fn sub_plausible_token(token: &str) -> bool {
    crate::sub::plausible_token(token)
}

/// `enroll::plausible_token` (enrollment / install token).
pub fn enroll_plausible_token(token: &str) -> bool {
    crate::enroll::plausible_token(token)
}

/// `grpc::cert_status_json` (Heartbeat.cert from the agent).
pub fn cert_status_json(c: &crate::pb::CertStatus) -> Value {
    crate::grpc::cert_status_json(c)
}

/// The traffic buffer's internal invariants (index == entries, caps).
pub fn traffic_check(buf: &crate::traffic::TrafficBuffer) -> Result<(), String> {
    buf.check_invariants()
}

/// Buffered (up, down) of one key, if any.
pub fn traffic_peek(
    buf: &crate::traffic::TrafficBuffer,
    node: uuid::Uuid,
    user: uuid::Uuid,
    session: &str,
) -> Option<(i64, i64)> {
    buf.peek(node, user, session)
}

// --- W15: registration / reset / email ------------------------------------

/// `signup::email::parse` (every address the panel stores or mails).
pub fn email_parse(raw: &str) -> Option<String> {
    crate::signup::email::parse(raw)
}

/// `signup::email::parse_domain` (allow-list entries, address domains).
pub fn email_parse_domain(raw: &str) -> Option<String> {
    crate::signup::email::parse_domain(raw)
}

/// `signup::email::domain_allowed` (registration allow-list).
pub fn email_domain_allowed(email: &str, allow: &[String]) -> bool {
    crate::signup::email::domain_allowed(email, allow)
}

/// Shapes checked before any lookup: verification code, reset token,
/// invite code.
pub fn signup_shapes(s: &str) -> (bool, bool, bool) {
    (
        crate::signup::plausible_code(s),
        crate::signup::reset::plausible_token(s),
        crate::signup::invite::plausible(s),
    )
}

/// Number of W15 request body kinds `signup_body` knows.
pub const SIGNUP_BODIES: u8 = 9;

fn strict<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<Option<T>, String> {
    let Ok(v) = serde_json::from_slice::<T>(body) else {
        return Ok(None);
    };
    if let Ok(Value::Object(mut obj)) = serde_json::from_slice::<Value>(body) {
        obj.insert("zz_unknown_member".into(), Value::Bool(true));
        let widened = serde_json::to_vec(&obj).map_err(|e| e.to_string())?;
        if serde_json::from_slice::<T>(&widened).is_ok() {
            return Err(format!(
                "{} accepted an unknown member",
                std::any::type_name::<T>()
            ));
        }
    }
    Ok(Some(v))
}

/// Parse `body` as W15 request kind `kind % SIGNUP_BODIES` (registration,
/// reset, email change, locale, SMTP and signup settings), run the
/// validators the handlers run, and check `deny_unknown_fields`.
/// Ok(parsed?) or Err(invariant violation).
pub fn signup_body(kind: u8, body: &[u8]) -> Result<bool, String> {
    use crate::signup::{profile, register, reset};
    Ok(match kind % SIGNUP_BODIES {
        0 => strict::<register::CodeReq>(body)?.is_some(),
        1 => strict::<register::RegisterReq>(body)?
            .map(|r| {
                let _ = crate::signup::check_password(&r.password);
                let _ = crate::signup::plausible_code(r.code.trim());
            })
            .is_some(),
        2 => strict::<reset::RequestReq>(body)?.is_some(),
        3 => strict::<reset::ResetReq>(body)?.is_some(),
        4 => strict::<profile::EmailCodeReq>(body)?.is_some(),
        5 => strict::<profile::VerifyReq>(body)?.is_some(),
        6 => strict::<profile::LocaleReq>(body)?.is_some(),
        7 => match strict::<crate::mail::SmtpReq>(body)? {
            Some(r) => {
                if let Ok(v) = crate::mail::smtp_values(&r) {
                    // Validated values never carry header-breaking text.
                    for s in [&v.host, &v.username, &v.from_addr, &v.from_name]
                        .into_iter()
                        .flatten()
                    {
                        if s.chars().any(char::is_control) {
                            return Err(format!("control character survived: {s:?}"));
                        }
                    }
                    if v.security == "none" && v.username.is_some() {
                        return Err("credentials over a plain connection".into());
                    }
                }
                true
            }
            None => false,
        },
        _ => match strict::<crate::signup::SignupReq>(body)? {
            Some(r) => {
                if let Ok(v) = crate::signup::signup_values(&r) {
                    for d in &v.email_domains {
                        if crate::signup::email::parse_domain(d).as_deref() != Some(d.as_str()) {
                            return Err(format!("allow-list entry not normalised: {d:?}"));
                        }
                    }
                }
                true
            }
            None => false,
        },
    })
}

/// Render the order receipt with an arbitrary plan name and the code mail
/// with an arbitrary code: (text, html) of each, both locales.
pub fn mail_render(plan_name: &str, code: &str) -> Vec<(String, String, String)> {
    use crate::mail::templates::{render, Locale, Template};
    let at = chrono::DateTime::<chrono::Utc>::from_timestamp(1_790_000_000, 0).unwrap_or_default();
    let mut out = Vec::new();
    for t in [
        Template::OrderPaid {
            order_no: "AK1".into(),
            plan_name: plan_name.into(),
            money: crate::mail::templates::OrderMoney {
                list_cents: 3,
                discount_cents: 1,
                credit_cents: 1,
                balance_cents: 1,
                paid_cents: 0,
            },
            paid_at: at,
            expires_at: None,
        },
        Template::RegisterCode {
            code: code.into(),
            minutes: 10,
        },
    ] {
        for l in [Locale::Zh, Locale::En] {
            let r = render(&t, l, plan_name);
            out.push((r.subject, r.text, r.html));
        }
    }
    out
}
