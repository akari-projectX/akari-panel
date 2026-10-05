//! Shared helpers: deterministic secrets of the seeded data set, latency
//! summaries.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hdrhistogram::Histogram;
use sha2::{Digest, Sha256};

/// Default database of the bench data set: the dedicated bench stack
/// (bench/compose.yml, port 5433), so seeding never touches the dev stack.
pub const DEFAULT_DB: &str = "postgres://akari:akari-dev@localhost:5433/akari_bench";

/// Address (login name) of the seeded admin (the load tool signs its
/// session with data/jwt.key instead of logging in).
pub const ADMIN_EMAIL: &str = "bench-admin@bench.invalid";
/// Address and password of the seeded user that exercises the login path.
pub const LOGIN_USER: &str = "bench-login@bench.invalid";
pub const LOGIN_PASSWORD: &str = "bench-login-password";

/// A 43-char base64url token derived from `kind` and `i`: the seeder
/// stores its hash, the load tools re-derive the plaintext. Bench data
/// only — never a real secret.
pub fn token(kind: &str, i: usize) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(format!("akari-bench-{kind}-{i}").as_bytes()))
}

pub fn sub_token(i: usize) -> String {
    token("sub", i)
}

pub fn enroll_token(i: usize) -> String {
    token("enroll", i)
}

pub fn user_email(i: usize) -> String {
    format!("bench-user-{i:05}@bench.invalid")
}

pub fn node_name(i: usize) -> String {
    format!("bench-node-{i:03}")
}

pub fn histogram() -> anyhow::Result<Histogram<u64>> {
    // 1 µs .. 120 s, 3 significant digits.
    Ok(Histogram::new_with_bounds(1, 120_000_000, 3)?)
}

pub fn record(h: &mut Histogram<u64>, d: Duration) {
    let us = d.as_micros().clamp(1, 120_000_000) as u64;
    h.saturating_record(us);
}

fn ms(us: u64) -> String {
    format!("{:.2}", us as f64 / 1000.0)
}

/// "n=… p50=… p90=… p99=… max=… ms".
pub fn summary(h: &Histogram<u64>) -> String {
    if h.is_empty() {
        return "n=0".into();
    }
    format!(
        "n={} p50={} p90={} p99={} p99.9={} max={} ms",
        h.len(),
        ms(h.value_at_quantile(0.50)),
        ms(h.value_at_quantile(0.90)),
        ms(h.value_at_quantile(0.99)),
        ms(h.value_at_quantile(0.999)),
        ms(h.max()),
    )
}
