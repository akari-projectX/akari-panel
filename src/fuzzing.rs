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
                let _ = r
                    .code
                    .as_deref()
                    .map(|c| crate::signup::plausible_code(c.trim()));
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
    use crate::mail::templates::{Locale, Template, render};
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

// --- W24 / R40: payment methods, registration proof of work ---------------

/// A payment method form (`billing::methods::MethodReq`, strict) through
/// the common checks and the kind's validation as a create (no previous
/// config) and as an edit of a complete stored method. Invariants: no
/// secret in the plain config or the admin view; Ok(parsed?).
pub fn payment_method_body(body: &[u8]) -> Result<bool, String> {
    use crate::billing::provider::ProviderKind;
    let Some(req) = strict::<crate::billing::methods::MethodReq>(body)? else {
        return Ok(false);
    };
    let _ = crate::billing::methods::common(&req);
    let kind = crate::billing::alipay::AlipayKind;
    let check = |v: &crate::billing::provider::Validated| -> Result<(), String> {
        let plain = v.config.to_string() + &kind.view(&v.config, Some(&v.secrets)).to_string();
        if plain.contains("PRIVATE KEY") || v.config.get("app_private_key").is_some() {
            return Err("a secret in the plain config or the view".into());
        }
        Ok(())
    };
    if let Ok(v) = kind.validate(&req.config, None, req.enabled) {
        check(&v)?;
        if req.enabled && kind.build(&v.config, &v.secrets).is_err() {
            // Enabling is refused by apply_* in this case; not a violation.
        }
    }
    let prev_config = serde_json::json!({ "app_id": "2021", "environment": "production" });
    let prev_secrets = serde_json::json!({});
    if let Ok(v) = kind.validate(
        &req.config,
        Some((&prev_config, &prev_secrets)),
        req.enabled,
    ) {
        check(&v)?;
    }
    Ok(true)
}

/// `signup::pow::check` on arbitrary input with a fixed key (never
/// panics; a random nonce essentially never passes 18 bits).
pub fn pow_check(challenge: &str, nonce: &str) -> bool {
    let keys = crate::totp::Keys::from_material(&[7; 32]).expect("keys");
    crate::signup::pow::check(
        &keys,
        challenge,
        nonce,
        1_800_000_000,
        crate::signup::pow::PROD_BITS,
    )
    .is_ok()
}

/// The Alipay F2F notify verdict of a method with fixed test keys (no
/// panic on any body).
pub fn alipay_check_notify(body: &[u8]) -> bool {
    use crate::billing::provider::ProviderKind;
    let _ = crate::billing::alipay::AlipayKind.peek_out_trade_no(body);
    true
}

// --- Ops: content (announcements, knowledge base, branding, templates) ---

/// `markdown::render` (announcement / help bodies, the announcement mail).
pub fn markdown_render(md: &str) -> String {
    crate::markdown::render(md)
}

/// `markdown::safe_link` / `safe_image`: (link ok, absolute?), image ok.
pub fn markdown_urls(url: &str) -> (Option<bool>, bool) {
    (
        crate::markdown::safe_link(url).map(|k| k == crate::markdown::UrlKind::Absolute),
        crate::markdown::safe_image(url).is_some(),
    )
}

/// `mail::templates::validate` then `render_custom` with the kind's sample
/// values: Ok(rendered (subject, text, html)) when the template is accepted.
pub fn mail_template(kind: &str, subject: &str, body: &str) -> Option<(String, String, String)> {
    use crate::mail::templates::{Locale, Template, render_custom, validate};
    validate(kind, subject, body).ok()?;
    let sample = Template::sample(kind)?;
    let r = render_custom(
        subject,
        body,
        &sample.values(Locale::En),
        Locale::En,
        "Site & <Co>",
    );
    Some((r.subject, r.text, r.html))
}

/// `branding::png_dimensions` and `branding::check` on a strict body.
pub fn branding_png(bytes: &[u8]) -> Option<(u32, u32)> {
    crate::branding::png_dimensions(bytes)
}

pub fn branding_body(body: &[u8]) -> Result<Option<crate::branding::Fields>, String> {
    let Some(req) = strict::<crate::branding::BrandingReq>(body)? else {
        return Ok(None);
    };
    Ok(crate::branding::check(&req).ok())
}

/// Announcement / help request bodies (strict), cleaned.
pub fn content_bodies(sel: u8, body: &[u8]) -> Result<(), String> {
    match sel % 3 {
        0 => {
            if let Some(r) = strict::<crate::announcements::AnnouncementReq>(body)? {
                let _ = crate::announcements::check(&r);
            }
        }
        1 => {
            if let Some(r) = strict::<crate::kb::ArticleReq>(body)? {
                let _ = crate::kb::check_article(&r);
            }
        }
        _ => {
            if let Some(r) = strict::<crate::kb::CategoryReq>(body)? {
                let _ = crate::kb::check_category(&r);
            }
        }
    }
    Ok(())
}
