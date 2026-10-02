//! W17 support input: ticket and alert-settings request bodies, the ticket
//! text cleaners, the alert channel validators, the heartbeat facts the
//! alert evaluator reads, and the evaluator itself on arbitrary facts.
//!
//! Input: first byte selects; the rest is the text, the JSON body or (for
//! the evaluator) raw bytes turned into facts and rules.
//!
//! Invariants: no panic; every body is `deny_unknown_fields`; a cleaned
//! subject is a trimmed single line of 1-120 characters, a cleaned body
//! has no control characters but LF/TAB, no CR, 1-5000 characters, and
//! cleaning again is a no-op; an accepted alert-settings body has every
//! threshold in its documented range and a well-formed bot token / chat id
//! / webhook URL (https, or http to loopback; no credentials); the
//! evaluator fires each kind at most once with bounded, control-free
//! values and never decides a kind both firing and unknown.
#![no_main]

use akari_panel::alerts::eval::{evaluate, heartbeat_facts, Facts, Rules};
use akari_panel::alerts::{self, NodeRules, PutSettings, TestReq};
use akari_panel::tickets::{self, AssignReq, CreateReq, ReplyReq};
use chrono::{TimeZone, Utc};
use libfuzzer_sys::fuzz_target;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn strict<T: DeserializeOwned>(body: &[u8]) -> Option<T> {
    let parsed = serde_json::from_slice::<T>(body).ok()?;
    if let Ok(Value::Object(mut obj)) = serde_json::from_slice::<Value>(body) {
        obj.insert("zz_unknown_member".into(), Value::Bool(true));
        let widened = serde_json::to_vec(&obj).expect("serialize");
        assert!(
            serde_json::from_slice::<T>(&widened).is_err(),
            "{} accepted an unknown member",
            std::any::type_name::<T>()
        );
    }
    Some(parsed)
}

fn subject(s: &str) {
    if let Ok(c) = tickets::clean_subject(s) {
        assert_eq!(c, c.trim());
        let n = c.chars().count();
        assert!((1..=tickets::MAX_SUBJECT).contains(&n), "{n}");
        assert!(!c.chars().any(char::is_control));
        assert_eq!(tickets::clean_subject(&c).ok().as_deref(), Some(c.as_str()));
    }
}

fn body(s: &str) {
    if let Ok(c) = tickets::clean_body(s) {
        let n = c.chars().count();
        assert!((1..=tickets::MAX_BODY).contains(&n), "{n}");
        assert!(!c.contains('\r') && !c.contains('\0'));
        assert!(c
            .chars()
            .all(|ch| !ch.is_control() || ch == '\n' || ch == '\t'));
        assert_eq!(tickets::clean_body(&c).ok().as_deref(), Some(c.as_str()));
    }
}

fn in_range(v: Option<i32>, lo: i32, hi: i32) -> bool {
    v.is_none_or(|x| (lo..=hi).contains(&x))
}

fn settings(req: &PutSettings) {
    if alerts::check_put(req).is_err() {
        return;
    }
    assert!(in_range(req.offline_secs, 30, 86_400));
    assert!(in_range(req.cpu_percent, 1, 100) && in_range(req.mem_percent, 1, 100));
    assert!(in_range(req.disk_percent, 1, 100) && in_range(req.cert_days, 1, 90));
    assert!((1..=60).contains(&req.cpu_minutes) && (1..=60).contains(&req.mem_minutes));
    assert!((0..=1440).contains(&req.cooldown_minutes));
    if let Some(c) = &req.telegram_chat_id {
        assert!(alerts::valid_chat_id(c));
    }
    if let Some(Some(t)) = &req.telegram_token {
        assert!(alerts::valid_bot_token(t) && !t.contains('/'));
    }
    if let Some(u) = &req.webhook_url {
        url(u);
    }
    assert!(req.email_to.len() <= 5);
    assert!(!req.telegram_enabled || req.telegram_chat_id.is_some());
    assert!(!req.webhook_enabled || req.webhook_url.is_some());
}

fn url(u: &str) {
    if alerts::check_webhook_url(u).is_ok() {
        assert!(u.len() <= 512 && !u.chars().any(char::is_whitespace));
        let uri: http::Uri = u.parse().expect("accepted URL parses");
        assert!(!uri.authority().expect("authority").as_str().contains('@'));
        match uri.scheme_str() {
            Some("https") => {}
            Some("http") => assert!(akari_panel::billing::http::is_loopback_host(
                uri.host().expect("host")
            )),
            other => panic!("scheme {other:?}"),
        }
    }
}

fn evaluator(data: &[u8]) {
    if data.len() < 48 {
        return;
    }
    let b = |i: usize| data[i];
    let n = |i: usize| i64::from_le_bytes(data[i..i + 8].try_into().unwrap());
    let f64_of = |i: usize| f64::from_le_bytes(data[i..i + 8].try_into().unwrap());
    let now = Utc.with_ymd_and_hms(2026, 10, 2, 12, 0, 0).unwrap();
    let opt = |flag: u8, v: i64| (flag & 1 == 1).then_some(v);
    let rules = Rules {
        offline_secs: opt(b(0), n(8).rem_euclid(90_000)),
        cpu: (b(1) & 1 == 1).then_some((f64_of(16), n(24).rem_euclid(70))),
        mem: (b(2) & 1 == 1).then_some((f64_of(16), i64::from(b(3) % 70))),
        disk: (b(4) & 1 == 1).then_some(f64::from(b(5))),
        cert_days: opt(b(6), i64::from(b(7))),
        latency: b(0) & 2 == 2,
        last_error: b(0) & 4 == 4,
    };
    let rest = &data[32..];
    let text = String::from_utf8_lossy(&rest[16..]).into_owned();
    let point = |k: usize| (i64::from(rest[k] % 8), f64::from(rest[k + 1]) * 1.5);
    let facts = Facts {
        online: b(1) & 2 == 2,
        seen_age_secs: opt(b(2) >> 1, n(8)),
        last_error: (b(3) & 1 == 1).then(|| text.clone()),
        agent_cert_not_after: Utc
            .timestamp_opt(1_790_000_000 + n(24) % 100_000_000, 0)
            .single(),
        tls_domain: (b(4) & 2 == 2).then(|| "n1.example.com".to_string()),
        cpu: (0..4).map(|k| point(k * 2)).collect(),
        mem: (4..8).map(|k| point(k * 2)).collect(),
        heartbeat: b(5) & 1 == 1,
        disk: (b(5) & 2 == 2).then_some((n(16).wrapping_abs(), n(24).wrapping_abs())),
        cert: (b(6) & 2 == 2).then(|| {
            (
                "valid".into(),
                Some(now + chrono::Duration::days(i64::from(b(7)) - 30)),
            )
        }),
        latency: vec![(
            "panel".into(),
            i64::from(b(5) % 4),
            i64::from(b(6) % 4),
            text.clone(),
        )],
    };
    let v = evaluate(&facts, &rules, now);
    let mut kinds: Vec<&str> = v.firing.iter().map(|o| o.kind).collect();
    kinds.sort_unstable();
    let before = kinds.len();
    kinds.dedup();
    assert_eq!(before, kinds.len(), "a kind fired twice");
    for o in &v.firing {
        assert!(alerts::KINDS.contains(&o.kind));
        assert!(
            !v.unknown.contains(&o.kind),
            "{} both firing and unknown",
            o.kind
        );
        assert!(o.value.chars().count() <= 200 && o.detail.chars().count() <= 600);
        assert!(!o.value.chars().any(char::is_control) && !o.detail.chars().any(char::is_control));
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&sel, rest)) = data.split_first() else {
        return;
    };
    let text = String::from_utf8_lossy(rest);
    match sel % 12 {
        0 => subject(&text),
        1 => body(&text),
        2 => {
            if let Some(r) = strict::<CreateReq>(rest) {
                subject(&r.subject);
                body(&r.message);
            }
        }
        3 => {
            if let Some(r) = strict::<ReplyReq>(rest) {
                body(&r.message);
            }
        }
        4 => {
            strict::<AssignReq>(rest);
        }
        5 => {
            if let Some(r) = strict::<PutSettings>(rest) {
                settings(&r);
            }
        }
        6 => {
            if let Some(r) = strict::<NodeRules>(rest) {
                if r.check().is_ok() {
                    assert!(r
                        .disabled
                        .iter()
                        .all(|k| alerts::KINDS.contains(&k.as_str())));
                }
            }
        }
        7 => {
            strict::<TestReq>(rest);
        }
        8 => {
            url(&text);
            let _ = alerts::valid_email(&text);
            let _ = alerts::valid_chat_id(&text);
            let _ = alerts::valid_bot_token(&text);
        }
        9 => {
            let (disk, cert) = heartbeat_facts(&text);
            if let Some((_, Some(_))) = &cert {
                assert!(text.contains("not_after"));
            }
            let _ = disk;
        }
        _ => evaluator(rest),
    }
});
