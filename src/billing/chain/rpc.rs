//! C2: the EVM JSON-RPC calls of the on-chain payment watcher, and their
//! pure parsers (fuzz target `chain_rpc`).
//!
//! Every call is a panel request to an operator-configured URL, so it goes
//! through the shared SSRF guard (`crate::outbound::post_json`: https only,
//! public addresses only, no redirects, a deadline and a body cap). The
//! URLs may carry an API key: they never appear in errors or logs.
//!
//! Answers are untrusted: the parsers accept only well-formed quantities,
//! hashes and addresses, and keep only `Transfer(address,address,uint256)`
//! logs of the configured token to the configured receiving address
//! (anything else in an answer is ignored, never credited).

use std::time::Duration;

use serde_json::{Value, json};

use crate::outbound::{FetchError, Policy, post_json};

/// keccak256("Transfer(address,address,uint256)").
pub const TRANSFER_TOPIC: &str =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/// `decimals()` selector.
const DECIMALS_CALL: &str = "0x313ce567";
/// One call (per URL).
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// The largest answer read (a log range of a busy address).
pub const MAX_ANSWER: usize = 8 << 20;
/// Logs accepted from one answer (more = the range is halved).
pub const MAX_LOGS: usize = 10_000;
/// Longest node error message kept (shown to the admin).
const MAX_MESSAGE: usize = 200;

/// A failed call. Never carries the URL.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RpcError {
    #[error("RPC unreachable: {0}")]
    Transport(String),
    #[error("RPC answered HTTP {0}")]
    Status(u16),
    #[error("RPC error {code}: {message}")]
    Node { code: i64, message: String },
    #[error("malformed RPC answer: {0}")]
    Malformed(&'static str),
}

/// One `Transfer` of the token to the receiving address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Log {
    /// 0x + 64 lowercase hex.
    pub tx_hash: String,
    pub log_index: u32,
    pub block_number: u64,
    /// 0x + 64 lowercase hex.
    pub block_hash: String,
    /// 0x + 40 lowercase hex.
    pub from: String,
    /// Token base units (None: larger than 2^128 — never a real USDT
    /// amount, never matched).
    pub value: Option<u128>,
}

/// A transaction receipt (the logs filtered as in `parse_logs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    /// status 0x1.
    pub success: bool,
    pub block_number: u64,
    pub block_hash: String,
    pub logs: Vec<Log>,
}

/// A block header (what the watcher needs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub number: u64,
    pub hash: String,
    /// Unix seconds.
    pub timestamp: i64,
}

/// `0x`-prefixed quantity (no leading zeros required) → u64.
pub fn quantity(v: &Value) -> Option<u64> {
    let s = v.as_str()?.strip_prefix("0x")?;
    if s.is_empty() || s.len() > 16 {
        return None;
    }
    u64::from_str_radix(s, 16).ok()
}

fn hex_of(v: &Value, bytes: usize) -> Option<String> {
    let s = v.as_str()?.strip_prefix("0x")?;
    (s.len() == bytes * 2 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("0x{}", s.to_ascii_lowercase()))
}

/// A 32-byte hash (lowercase).
pub fn hash32(v: &Value) -> Option<String> {
    hex_of(v, 32)
}

/// A 20-byte address (lowercase).
pub fn address(v: &Value) -> Option<String> {
    hex_of(v, 20)
}

/// A 32-byte topic holding an address (12 zero bytes + 20) → the address.
fn topic_address(v: &Value) -> Option<String> {
    let t = hash32(v)?;
    t[2..26]
        .bytes()
        .all(|c| c == b'0')
        .then(|| format!("0x{}", &t[26..]))
}

/// A uint256 word → u128 when it fits (Some(None) = valid but too big).
fn uint256(v: &Value) -> Option<Option<u128>> {
    let s = v.as_str()?.strip_prefix("0x")?;
    if s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if !s[..32].bytes().all(|c| c == b'0') {
        return Some(None);
    }
    Some(u128::from_str_radix(&s[32..], 16).ok())
}

/// The JSON-RPC answer of request `id`: its `result` (Null allowed).
pub fn envelope(body: &[u8], id: u64) -> Result<Value, RpcError> {
    let v: Value = serde_json::from_slice(body).map_err(|_| RpcError::Malformed("not JSON"))?;
    let obj = v
        .as_object()
        .ok_or(RpcError::Malformed("not a JSON-RPC object"))?;
    if obj.get("id").and_then(Value::as_u64) != Some(id) {
        return Err(RpcError::Malformed("answer to another request"));
    }
    if let Some(e) = obj.get("error").filter(|e| !e.is_null()) {
        let message: String = e
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_MESSAGE)
            .collect();
        return Err(RpcError::Node {
            code: e.get("code").and_then(Value::as_i64).unwrap_or(0),
            message,
        });
    }
    obj.get("result")
        .cloned()
        .ok_or(RpcError::Malformed("no result"))
}

/// One log entry if it is a `Transfer` of `token` to `to` (lowercase
/// addresses); None for anything else (other events, other tokens,
/// removed logs, malformed fields).
fn transfer_log(l: &Value, token: &str, to: &str) -> Option<Log> {
    if l.get("removed").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    if address(l.get("address")?)? != token {
        return None;
    }
    let topics = l.get("topics")?.as_array()?;
    if topics.len() != 3 || hash32(&topics[0])?.as_str() != TRANSFER_TOPIC {
        return None;
    }
    if topic_address(&topics[2])? != to {
        return None;
    }
    Some(Log {
        from: topic_address(&topics[1])?,
        value: uint256(l.get("data")?)?,
        tx_hash: hash32(l.get("transactionHash")?)?,
        log_index: u32::try_from(quantity(l.get("logIndex")?)?).ok()?,
        block_number: quantity(l.get("blockNumber")?)?,
        block_hash: hash32(l.get("blockHash")?)?,
    })
}

/// `eth_getLogs` result → the token's transfers to `to`.
pub fn parse_logs(result: &Value, token: &str, to: &str) -> Result<Vec<Log>, RpcError> {
    let arr = result
        .as_array()
        .ok_or(RpcError::Malformed("logs are not a list"))?;
    if arr.len() > MAX_LOGS {
        return Err(RpcError::Malformed("too many logs"));
    }
    Ok(arr
        .iter()
        .filter_map(|l| transfer_log(l, token, to))
        .collect())
}

/// `eth_getTransactionReceipt` result (null = unknown to the node).
pub fn parse_receipt(result: &Value, token: &str, to: &str) -> Result<Option<Receipt>, RpcError> {
    if result.is_null() {
        return Ok(None);
    }
    let bad = || RpcError::Malformed("receipt");
    let logs = result
        .get("logs")
        .and_then(Value::as_array)
        .ok_or_else(bad)?;
    if logs.len() > MAX_LOGS {
        return Err(bad());
    }
    Ok(Some(Receipt {
        success: result.get("status").and_then(quantity) == Some(1),
        block_number: result
            .get("blockNumber")
            .and_then(quantity)
            .ok_or_else(bad)?,
        block_hash: result.get("blockHash").and_then(hash32).ok_or_else(bad)?,
        logs: logs
            .iter()
            .filter_map(|l| transfer_log(l, token, to))
            .collect(),
    }))
}

/// `eth_getBlockByNumber` result (null = not known to the node).
pub fn parse_block(result: &Value) -> Result<Option<Block>, RpcError> {
    if result.is_null() {
        return Ok(None);
    }
    let bad = || RpcError::Malformed("block");
    Ok(Some(Block {
        number: result.get("number").and_then(quantity).ok_or_else(bad)?,
        hash: result.get("hash").and_then(hash32).ok_or_else(bad)?,
        timestamp: result
            .get("timestamp")
            .and_then(quantity)
            .and_then(|t| i64::try_from(t).ok())
            .ok_or_else(bad)?,
    }))
}

/// `eth_call` of `decimals()` → the value (≤ 255).
pub fn parse_decimals(result: &Value) -> Result<u64, RpcError> {
    match uint256(result) {
        Some(Some(d)) if d <= 255 => Ok(d as u64),
        _ => Err(RpcError::Malformed("decimals")),
    }
}

/// `0x` + hex of a block number.
fn block_tag(n: u64) -> String {
    format!("0x{n:x}")
}

/// The left-padded topic of an address (lowercase `0x…`).
pub fn address_topic(addr: &str) -> String {
    format!("0x{:0>64}", addr.trim_start_matches("0x"))
}

/// A JSON-RPC client over the configured endpoints (tried in order; the
/// first that answers wins).
#[derive(Clone)]
pub struct Rpc {
    urls: Vec<String>,
    policy: Policy,
}

impl std::fmt::Debug for Rpc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The URLs may hold API keys.
        f.debug_struct("Rpc")
            .field("endpoints", &self.urls.len())
            .finish()
    }
}

impl Rpc {
    pub fn new(urls: Vec<String>, policy: Policy) -> Self {
        Self { urls, policy }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id: u64 = rand::random::<u32>().into();
        let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
            .to_string()
            .into_bytes();
        let mut last = RpcError::Transport("no endpoint".into());
        for url in &self.urls {
            let r = match post_json(url, self.policy, body.clone(), CALL_TIMEOUT, MAX_ANSWER).await
            {
                Ok((200, b)) => envelope(&b, id),
                Ok((status, _)) => Err(RpcError::Status(status)),
                Err(FetchError::TooLarge) => Err(RpcError::Malformed("answer too large")),
                Err(e) => Err(RpcError::Transport(e.to_string())),
            };
            match r {
                Ok(v) => return Ok(v),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    pub async fn chain_id(&self) -> Result<u64, RpcError> {
        quantity(&self.call("eth_chainId", json!([])).await?).ok_or(RpcError::Malformed("chain id"))
    }

    pub async fn block_number(&self) -> Result<u64, RpcError> {
        quantity(&self.call("eth_blockNumber", json!([])).await?)
            .ok_or(RpcError::Malformed("block number"))
    }

    pub async fn decimals(&self, token: &str) -> Result<u64, RpcError> {
        parse_decimals(
            &self
                .call(
                    "eth_call",
                    json!([{"to": token, "data": DECIMALS_CALL}, "latest"]),
                )
                .await?,
        )
    }

    /// Transfers of `token` to `to` in blocks `from..=to_block`.
    pub async fn logs(
        &self,
        token: &str,
        to: &str,
        from: u64,
        to_block: u64,
    ) -> Result<Vec<Log>, RpcError> {
        let r = self
            .call(
                "eth_getLogs",
                json!([{
                    "fromBlock": block_tag(from),
                    "toBlock": block_tag(to_block),
                    "address": token,
                    "topics": [TRANSFER_TOPIC, null, address_topic(to)],
                }]),
            )
            .await?;
        parse_logs(&r, token, to)
    }

    pub async fn receipt(
        &self,
        tx_hash: &str,
        token: &str,
        to: &str,
    ) -> Result<Option<Receipt>, RpcError> {
        let r = self
            .call("eth_getTransactionReceipt", json!([tx_hash]))
            .await?;
        parse_receipt(&r, token, to)
    }

    pub async fn block(&self, number: u64) -> Result<Option<Block>, RpcError> {
        let r = self
            .call("eth_getBlockByNumber", json!([block_tag(number), false]))
            .await?;
        parse_block(&r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
    const TO: &str = "0x1111111111111111111111111111111111111111";
    const FROM: &str = "0x2222222222222222222222222222222222222222";

    fn h(c: char) -> String {
        format!("0x{}", c.to_string().repeat(64))
    }

    pub fn log(value: u128) -> Value {
        json!({
            "address": TOKEN,
            "topics": [TRANSFER_TOPIC, address_topic(FROM), address_topic(TO)],
            "data": format!("0x{value:064x}"),
            "blockNumber": "0x10",
            "blockHash": h('b'),
            "transactionHash": h('a'),
            "logIndex": "0x3",
            "removed": false,
        })
    }

    #[test]
    fn transfer_topic_is_the_keccak_of_the_signature() {
        let k = crate::billing::usdt::keccak256(b"Transfer(address,address,uint256)");
        assert_eq!(format!("0x{}", hex::encode(k)), TRANSFER_TOPIC);
        let d = crate::billing::usdt::keccak256(b"decimals()");
        assert_eq!(format!("0x{}", hex::encode(&d[..4])), DECIMALS_CALL);
    }

    #[test]
    fn quantities_and_hashes() {
        assert_eq!(quantity(&json!("0x0")), Some(0));
        assert_eq!(quantity(&json!("0x1f")), Some(31));
        assert_eq!(quantity(&json!("0xffffffffffffffff")), Some(u64::MAX));
        for bad in [
            json!("0x"),
            json!("1f"),
            json!("0x1ffffffffffffffff"),
            json!(5),
            json!("0xzz"),
        ] {
            assert_eq!(quantity(&bad), None, "{bad}");
        }
        assert_eq!(hash32(&json!(h('A'))), Some(h('a')));
        assert_eq!(hash32(&json!("0xab")), None);
        assert_eq!(
            address(&json!(TOKEN.to_uppercase().replace("0X", "0x"))),
            Some(TOKEN.into())
        );
        assert_eq!(
            address_topic(TO),
            format!("0x{}{}", "0".repeat(24), &TO[2..])
        );
    }

    #[test]
    fn logs_keep_only_transfers_of_the_token_to_the_address() {
        let good = log(4_170_123);
        let mut other_token = log(1);
        other_token["address"] = json!(FROM);
        let mut other_to = log(1);
        other_to["topics"][2] = json!(address_topic(FROM));
        let mut removed = log(1);
        removed["removed"] = json!(true);
        let mut approval = log(1);
        approval["topics"][0] = json!(h('c'));
        let mut dirty_topic = log(1);
        dirty_topic["topics"][2] = json!(format!("0x01{}", &address_topic(TO)[4..]));
        let mut huge = log(0);
        huge["data"] = json!(format!("0x01{}", "0".repeat(62)));
        let mut short = log(1);
        short["data"] = json!("0x01");
        let mut big_index = log(1);
        big_index["logIndex"] = json!("0x100000000");
        let r = json!([
            good,
            other_token,
            other_to,
            removed,
            approval,
            dirty_topic,
            huge,
            short,
            big_index
        ]);
        let logs = parse_logs(&r, TOKEN, TO).unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(
            logs[0],
            Log {
                tx_hash: h('a'),
                log_index: 3,
                block_number: 16,
                block_hash: h('b'),
                from: FROM.into(),
                value: Some(4_170_123),
            }
        );
        assert_eq!(logs[1].value, None);
        assert_eq!(
            parse_logs(&json!({}), TOKEN, TO),
            Err(RpcError::Malformed("logs are not a list"))
        );
        let many = Value::Array(vec![json!(null); MAX_LOGS + 1]);
        assert_eq!(
            parse_logs(&many, TOKEN, TO),
            Err(RpcError::Malformed("too many logs"))
        );
    }

    #[test]
    fn envelopes() {
        assert_eq!(
            envelope(br#"{"jsonrpc":"2.0","id":7,"result":"0x1"}"#, 7),
            Ok(json!("0x1"))
        );
        assert_eq!(
            envelope(br#"{"jsonrpc":"2.0","id":7,"result":null}"#, 7),
            Ok(Value::Null)
        );
        assert_eq!(
            envelope(br#"{"jsonrpc":"2.0","id":8,"result":"0x1"}"#, 7),
            Err(RpcError::Malformed("answer to another request"))
        );
        assert_eq!(
            envelope(
                br#"{"jsonrpc":"2.0","id":7,"error":{"code":-32005,"message":"range\ntoo large"}}"#,
                7
            ),
            Err(RpcError::Node {
                code: -32005,
                message: "rangetoo large".into()
            })
        );
        assert_eq!(
            envelope(b"[]", 7),
            Err(RpcError::Malformed("not a JSON-RPC object"))
        );
        assert_eq!(envelope(b"<html>", 7), Err(RpcError::Malformed("not JSON")));
        assert_eq!(
            envelope(br#"{"id":7}"#, 7),
            Err(RpcError::Malformed("no result"))
        );
    }

    #[test]
    fn receipts_blocks_decimals() {
        let r = json!({"status": "0x1", "blockNumber": "0x10", "blockHash": h('b'),
                       "logs": [log(5), log(6)]});
        let rc = parse_receipt(&r, TOKEN, TO).unwrap().unwrap();
        assert!(rc.success);
        assert_eq!((rc.block_number, rc.logs.len()), (16, 2));
        let mut failed = r.clone();
        failed["status"] = json!("0x0");
        assert!(!parse_receipt(&failed, TOKEN, TO).unwrap().unwrap().success);
        assert_eq!(parse_receipt(&Value::Null, TOKEN, TO), Ok(None));
        assert!(parse_receipt(&json!({"status": "0x1"}), TOKEN, TO).is_err());
        let b = json!({"number": "0x10", "hash": h('b'), "timestamp": "0x6527a0c0"});
        assert_eq!(
            parse_block(&b),
            Ok(Some(Block {
                number: 16,
                hash: h('b'),
                timestamp: 0x6527a0c0
            }))
        );
        assert_eq!(parse_block(&Value::Null), Ok(None));
        assert!(parse_block(&json!({"number": "0x10"})).is_err());
        assert_eq!(parse_decimals(&json!(format!("0x{:064x}", 6))), Ok(6));
        assert!(parse_decimals(&json!(format!("0x{:064x}", 256))).is_err());
        assert!(parse_decimals(&json!("0x06")).is_err());
        assert_eq!(
            format!(
                "{:?}",
                Rpc::new(vec!["https://key@x/".into()], Policy::default())
            ),
            "Rpc { endpoints: 1 }"
        );
    }
}

/// Test helpers shared with the watcher tests (a log as a node shows it).
#[cfg(test)]
pub mod fixtures {
    use super::*;

    /// A `Transfer` log entry as an RPC node returns it.
    #[allow(clippy::too_many_arguments)]
    pub fn log_json(
        token: &str,
        from: &str,
        to: &str,
        value: u128,
        block: u64,
        block_hash: &str,
        tx_hash: &str,
        log_index: u32,
    ) -> Value {
        json!({
            "address": token,
            "topics": [TRANSFER_TOPIC, address_topic(from), address_topic(to)],
            "data": format!("0x{value:064x}"),
            "blockNumber": format!("0x{block:x}"),
            "blockHash": block_hash,
            "transactionHash": tx_hash,
            "logIndex": format!("0x{log_index:x}"),
            "removed": false,
        })
    }
}
