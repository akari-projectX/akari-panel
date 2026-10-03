//! W16 billing input: coupon codes, the order / coupon / balance /
//! withdrawal / commission request bodies, and the money split.
//!
//! Input: first byte selects; the rest is the code, the JSON body, or
//! (money) four little-endian i64 values.
//!
//! Invariants: no panic; a normalized coupon code is the trimmed input,
//! 3-32 characters of `[A-Za-z0-9_-]`, and normalizing it again is a no-op;
//! every request body is `deny_unknown_fields` (a parsing body stops parsing
//! once an unknown member is added) and an order body never carries an
//! amount; the discount (percent floors, fixed capped) is within
//! [0, list] and a percent discount never exceeds the stated percentage;
//! the split covers exactly the list price with no negative part.
#![no_main]

use akari_panel::billing::coupons::{mirror, normalize_code};
use libfuzzer_sys::fuzz_target;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn strict<T: DeserializeOwned>(body: &[u8]) -> Option<Value> {
    serde_json::from_slice::<T>(body).ok()?;
    let Ok(Value::Object(mut obj)) = serde_json::from_slice::<Value>(body) else {
        return None;
    };
    let original = Value::Object(obj.clone());
    obj.insert("zz_unknown_member".into(), Value::Bool(true));
    let widened = serde_json::to_vec(&obj).expect("serialize");
    assert!(
        serde_json::from_slice::<T>(&widened).is_err(),
        "{} accepted an unknown member",
        std::any::type_name::<T>()
    );
    Some(original)
}

fn code(raw: &str) {
    if let Some(c) = normalize_code(raw) {
        assert_eq!(c, raw.trim());
        assert!((3..=32).contains(&c.len()), "{c:?}");
        assert!(
            c.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
        assert_eq!(normalize_code(&c).as_deref(), Some(c.as_str()));
    }
}

fn money(data: &[u8]) {
    if data.len() < 32 {
        return;
    }
    let n = |i: usize| i64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().unwrap());
    // Prices are 1..=1e8 fen (CHECK), coupon values likewise.
    let list = n(0).rem_euclid(100_000_000) + 1;
    let percent = n(1) & 1 == 0;
    let value = (n(1) >> 1).rem_euclid(if percent { 100 } else { 100_000_000 }) + 1;
    let d = mirror::discount(list, percent, value);
    assert!((0..=list).contains(&d), "{list} {value} {d}");
    if percent {
        assert!(d * 100 <= list * value);
        assert!((d + 1) * 100 > list * value);
    } else {
        assert_eq!(d, value.min(list));
    }
    let credit = n(2) % 1_000_000_000_000;
    let balance = n(3) % 1_000_000_000_000;
    let (sd, sc, sb, amount) = mirror::split(list, d, credit, balance);
    assert!(sd >= 0 && sc >= 0 && sb >= 0 && amount >= 0);
    assert_eq!(sd + sc + sb + amount, list);
    assert_eq!(sd, d);
}

fuzz_target!(|data: &[u8]| {
    let Some((&sel, body)) = data.split_first() else {
        return;
    };
    use akari_panel::billing::*;
    match sel % 12 {
        0 => code(&String::from_utf8_lossy(body)),
        1 => {
            if let Some(v) = strict::<api::CreateOrderReq>(body) {
                assert!(v.get("amount_cents").is_none());
                if let Some(Value::String(c)) = v.get("coupon") {
                    code(c);
                }
            }
        }
        2 => {
            strict::<api::ShopQuery>(body);
        }
        3 => {
            strict::<api::RefundReq>(body);
        }
        4 => {
            strict::<coupons::CreateCouponReq>(body);
        }
        5 => {
            strict::<coupons::UpdateCouponReq>(body);
        }
        6 => {
            strict::<ledger::AdjustReq>(body);
        }
        7 => {
            strict::<commission::WithdrawReq>(body);
        }
        8 => {
            strict::<commission::Settings>(body);
        }
        9 => {
            strict::<commission::ApproveReq>(body);
        }
        10 => {
            strict::<commission::RejectReq>(body);
        }
        _ => money(body),
    }
});
