//! W24 / R40: the 系统设置 → 支付 request body (`MethodReq`, strict) and the
//! Alipay F2F configuration validation; the registration proof-of-work
//! checker; the legacy notify out_trade_no peek.
//!
//! Input: first byte selects the part; the rest is the body.
//!
//! Invariants: no panic; deny_unknown_fields holds; no secret ever lands
//! in the plain config or the admin view; a random proof of work does not
//! verify.
#![no_main]

use akari_panel::fuzzing::{alipay_check_notify, payment_method_body, pow_check};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&sel, body)) = data.split_first() else {
        return;
    };
    match sel % 3 {
        0 => {
            if let Err(e) = payment_method_body(body) {
                panic!("{e}");
            }
        }
        1 => {
            let s = String::from_utf8_lossy(body);
            let (c, n) = s.split_once('\n').unwrap_or((&s, ""));
            let _ = pow_check(c, n);
        }
        _ => {
            alipay_check_notify(body);
        }
    }
});
