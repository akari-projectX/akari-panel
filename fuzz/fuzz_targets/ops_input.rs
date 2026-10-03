//! Ops (admin batch / export / manual orders / batch coupons): the request
//! bodies and the CSV writer.
//!
//! Input: first byte selects; the rest is a JSON body, or (csv) cells
//! separated by 0x1F with a kind byte each.
//!
//! Invariants: no panic; every body is `deny_unknown_fields` (adding an
//! unknown member stops it parsing, also inside the batch action and the
//! selection); a manual order body never carries an amount; a parsed batch
//! action passes or fails `check_action` without panicking and its stored
//! parameters round-trip; the CSV writer's output always parses back
//! (RFC 4180) to the same cells, a text cell whose first character could
//! start a spreadsheet formula comes back prefixed with an apostrophe, and
//! no text cell ever comes back starting with a formula character.
#![no_main]

use akari_panel::batch::{self, CreateReq, PreviewReq};
use akari_panel::billing::coupon_batches::CreateBatchReq;
use akari_panel::billing::manual::ManualOrderReq;
use akari_panel::csvx::{self, Cell};
use libfuzzer_sys::fuzz_target;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn strict<T: DeserializeOwned>(body: &[u8]) -> Option<(T, Value)> {
    let parsed = serde_json::from_slice::<T>(body).ok()?;
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
    Some((parsed, original))
}

/// The nested object at `key` widened with an unknown member must fail too.
fn nested_strict<T: DeserializeOwned>(original: &Value, key: &str) {
    let mut v = original.clone();
    if let Some(Value::Object(inner)) = v.get_mut(key) {
        inner.insert("zz_unknown_member".into(), Value::Bool(true));
        assert!(
            serde_json::from_value::<T>(v).is_err(),
            "{key}: unknown member accepted"
        );
    }
}

fn csv(data: &[u8]) {
    let mut cells = Vec::new();
    for part in data.split(|b| *b == 0x1F) {
        let Some((&k, rest)) = part.split_first() else {
            continue;
        };
        let s = String::from_utf8_lossy(rest).into_owned();
        cells.push(match k % 3 {
            0 => Cell::Text(s),
            1 => Cell::Raw(s),
            _ => Cell::Empty,
        });
    }
    if cells.is_empty() {
        return;
    }
    let mut out = Vec::new();
    out.extend_from_slice(csvx::BOM);
    csvx::write_row(&mut out, &cells);
    csvx::write_row(&mut out, &cells);
    let rows = csvx::parse(&out).expect("writer output must parse");
    assert_eq!(rows.len(), 2);
    for row in &rows {
        assert_eq!(row.len(), cells.len());
        for (got, cell) in row.iter().zip(&cells) {
            match cell {
                Cell::Empty => assert_eq!(got, ""),
                Cell::Raw(s) => assert_eq!(got, s),
                Cell::Text(s) => {
                    let clean: String = s
                        .chars()
                        .filter(|c| !c.is_control() || matches!(c, '\t' | '\n' | '\r'))
                        .collect();
                    let lead = clean
                        .chars()
                        .next()
                        .is_some_and(|c| matches!(c, '=' | '+' | '-' | '@' | '\t' | '\r'));
                    if lead {
                        assert_eq!(got, &format!("'{clean}"));
                    } else {
                        assert_eq!(got, &clean);
                    }
                    assert!(
                        !got.chars()
                            .next()
                            .is_some_and(|c| matches!(c, '=' | '+' | '-' | '@')),
                        "formula cell {got:?}"
                    );
                }
            }
        }
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&sel, body)) = data.split_first() else {
        return;
    };
    match sel % 5 {
        0 => {
            if let Some((req, v)) = strict::<CreateReq>(body) {
                nested_strict::<CreateReq>(&v, "action");
                nested_strict::<CreateReq>(&v, "selection");
                let _ = batch::check_action(&req.action);
            }
        }
        1 => {
            if let Some((_, v)) = strict::<PreviewReq>(body) {
                nested_strict::<PreviewReq>(&v, "selection");
            }
        }
        2 => {
            if let Some((_, v)) = strict::<ManualOrderReq>(body) {
                assert!(v.get("amount_cents").is_none());
            }
        }
        3 => {
            if let Some((req, _)) = strict::<CreateBatchReq>(body) {
                let _ = akari_panel::billing::coupon_batches::check_shape(&req);
            }
        }
        _ => csv(body),
    }
});
