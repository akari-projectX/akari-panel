//! Request bodies (serde, `deny_unknown_fields`) of the login, account,
//! admin and shop APIs, plus the request-path helpers that see raw paths:
//! `web::redacted_path` (log redaction of the route prefix and tokens) and
//! the subscription / enrollment token shape checks.
//!
//! Input: first byte selects the body type; the rest is the JSON body (or
//! the path).
//!
//! Invariants: no panic; deny_unknown_fields holds — a body that parses
//! no longer parses once an unknown member is added; a redacted path never
//! shows the prefix segment or a sub/install token segment; plausible tokens
//! are exactly 43 base64url characters.
#![no_main]

use akari_panel::fuzzing::{enroll_plausible_token, sub_plausible_token};
use akari_panel::web::redacted_path;
use libfuzzer_sys::fuzz_target;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn strict<T: DeserializeOwned>(body: &[u8]) {
    if serde_json::from_slice::<T>(body).is_err() {
        return;
    }
    let Ok(Value::Object(mut obj)) = serde_json::from_slice::<Value>(body) else {
        return;
    };
    obj.insert("zz_unknown_member".into(), Value::Bool(true));
    let widened = serde_json::to_vec(&obj).expect("serialize");
    assert!(
        serde_json::from_slice::<T>(&widened).is_err(),
        "{} accepted an unknown member",
        std::any::type_name::<T>()
    );
}

fn path(raw: &str) {
    let out = redacted_path(raw);
    let segs: Vec<&str> = raw.split('?').next().unwrap_or("").split('/').collect();
    let red: Vec<&str> = out.split('/').collect();
    // segs[0] is before the leading '/', segs[1] the prefix: whatever it
    // was, the redacted path shows the placeholder there, and a sub /
    // install token segment is replaced too.
    if segs.len() >= 2 {
        assert_eq!(red.get(1), Some(&"{prefix}"), "prefix not redacted: {out}");
        assert_eq!(red.len(), segs.len(), "segment count changed: {out}");
    }
    if let Some(&kind) = segs.get(2) {
        if (kind == "sub" || kind == "install") && segs.len() > 3 {
            assert_eq!(red.get(3), Some(&"{token}"), "token not redacted: {out}");
        }
    }
    let t = raw.trim_start_matches('/');
    let plausible = t.len() == 43
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    assert_eq!(sub_plausible_token(t), plausible);
    assert_eq!(enroll_plausible_token(t), plausible);
}

fuzz_target!(|data: &[u8]| {
    let Some((&sel, body)) = data.split_first() else {
        return;
    };
    use akari_panel::*;
    match sel % 24 {
        0 => strict::<api::LoginReq>(body),
        1 => strict::<api::CreateUserReq>(body),
        2 => strict::<api::UpdateUserReq>(body),
        3 => strict::<api::CreateNodeReq>(body),
        4 => strict::<api::UpdateNodeReq>(body),
        5 => strict::<api::SetInboundsReq>(body),
        6 => strict::<api::AssignReq>(body),
        7 => strict::<account::CodeReq>(body),
        8 => strict::<account::ConfirmReq>(body),
        9 => strict::<account::ChangePasswordReq>(body),
        10 => strict::<billing::api::CreateOrderReq>(body),
        11 => strict::<billing::api::FulfilReq>(body),
        12 => strict::<billing::catalog::SetPricesReq>(body),
        13 => strict::<plans::CreatePlanReq>(body),
        14 => strict::<plans::UpdatePlanReq>(body),
        15 => strict::<plans::SetUserPlanReq>(body),
        16 => strict::<plans::UpdateUserPlanReq>(body),
        17 => strict::<plans::CreateGroupReq>(body),
        18 => strict::<rollout::CreateRolloutReq>(body),
        19 => strict::<settings::UpdateReq>(body),
        20 => strict::<nodetpl::RenderReq>(body),
        21 => strict::<updates::CreateReleaseReq>(body),
        22 => strict::<updates::Manifest>(body),
        _ => path(&String::from_utf8_lossy(body)),
    }
});
