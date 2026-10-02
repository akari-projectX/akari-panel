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
pub fn cert_status_json(c: &crate::gen::CertStatus) -> Value {
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
