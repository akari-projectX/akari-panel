//! C2: USDT on-chain payments — the JSON-RPC answers of an
//! operator-configured node (`billing::chain::rpc`): the envelope, logs,
//! receipts, blocks and `decimals()` on attacker bytes.
//!
//! Input: first byte = mode; the rest is the answer (modes 0–4) or, for
//! mode 5, 32 bytes of a transfer value followed by junk.
//!
//! Invariants: no panic; an envelope is only ever the result of the
//! request id asked; every log kept is a `Transfer` of the configured
//! token to the configured address with well-formed hashes, addresses and
//! numbers (lowercase), at most `MAX_LOGS`; a receipt's logs obey the same;
//! decimals ≤ 255; a well-formed transfer log round-trips its value exactly
//! (None only when it does not fit 128 bits).
#![no_main]

use akari_panel::billing::chain::rpc::{
    MAX_LOGS, TRANSFER_TOPIC, address_topic, envelope, parse_block, parse_decimals, parse_logs,
    parse_receipt,
};
use libfuzzer_sys::fuzz_target;
use serde_json::{Value, json};

const TOKEN: &str = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
const TO: &str = "0x52908400098527886e0f7030069857d2e4169ee7";

fn hex_ok(s: &str, bytes: usize) -> bool {
    s.len() == 2 + 2 * bytes
        && s.starts_with("0x")
        && s[2..]
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn check_logs(logs: &[akari_panel::billing::chain::rpc::Log]) {
    assert!(logs.len() <= MAX_LOGS);
    for l in logs {
        assert!(hex_ok(&l.tx_hash, 32), "{l:?}");
        assert!(hex_ok(&l.block_hash, 32), "{l:?}");
        assert!(hex_ok(&l.from, 20), "{l:?}");
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&mode, body)) = data.split_first() else {
        return;
    };
    match mode % 6 {
        0 => {
            if let Ok(v) = envelope(body, 7) {
                // Only an object answering id 7 gets here.
                let whole: Value = serde_json::from_slice(body).expect("parsed once");
                assert_eq!(whole["id"].as_u64(), Some(7));
                assert_eq!(whole["result"], v);
            }
        }
        1..=4 => {
            let Ok(v) = serde_json::from_slice::<Value>(body) else {
                return;
            };
            match mode % 6 {
                1 => {
                    if let Ok(logs) = parse_logs(&v, TOKEN, TO) {
                        check_logs(&logs);
                    }
                }
                2 => {
                    if let Ok(Some(r)) = parse_receipt(&v, TOKEN, TO) {
                        assert!(hex_ok(&r.block_hash, 32));
                        check_logs(&r.logs);
                    }
                }
                3 => {
                    if let Ok(Some(b)) = parse_block(&v) {
                        assert!(hex_ok(&b.hash, 32) && b.timestamp >= 0);
                    }
                }
                _ => {
                    if let Ok(d) = parse_decimals(&v) {
                        assert!(d <= 255);
                    }
                }
            }
        }
        _ => {
            if body.len() < 32 {
                return;
            }
            let word = &body[..32];
            let hex: String = word.iter().map(|b| format!("{b:02x}")).collect();
            let log = json!({
                "address": TOKEN,
                "topics": [TRANSFER_TOPIC, address_topic("0x3333333333333333333333333333333333333333"), address_topic(TO)],
                "data": format!("0x{hex}"),
                "blockNumber": "0x10",
                "blockHash": format!("0x{}", "b".repeat(64)),
                "transactionHash": format!("0x{}", "a".repeat(64)),
                "logIndex": "0x1",
            });
            let logs = parse_logs(&json!([log]), TOKEN, TO).expect("well-formed");
            assert_eq!(logs.len(), 1);
            let want = word[..16]
                .iter()
                .all(|b| *b == 0)
                .then(|| u128::from_be_bytes(word[16..].try_into().expect("16 bytes")));
            assert_eq!(logs[0].value, want);
        }
    }
});
