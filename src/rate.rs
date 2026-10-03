//! Fixed-window request counters in Valkey (shared by every panel
//! instance), for endpoints that need a plain "N per window" cap: the
//! subscription endpoint (M1-10) and self-service token regeneration
//! (M1-9). Every counter key carries the window TTL from its first hit
//! (EXPIRE NX in the same script), so a key never outlives its window;
//! callers keep the key space bounded (see each caller).

use fred::prelude::*;

use crate::state::AppState;

const HIT: &str = r#"
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]), 'NX')
return n
"#;

/// Count one request against `key`; true while the window's count is
/// within `limit`.
pub async fn hit(
    state: &AppState,
    key: String,
    limit: i64,
    window_secs: i64,
) -> Result<bool, fred::error::Error> {
    let n: i64 = state
        .valkey()
        .eval(HIT, vec![key], vec![window_secs.max(1)])
        .await?;
    Ok(n <= limit)
}

/// `hit`, falling back to an in-process limiter when Valkey is unavailable
/// (review 2026-10-02 W9). The callers (enrollment, subscription) fail OPEN
/// on Valkey errors by design (their limits protect CPU/DB, not secrets),
/// but "open" must not mean "unlimited": during an outage each instance
/// enforces the same limit locally with a token bucket per key (capacity
/// `limit`, refilled at `limit` per window). Per instance, so N instances
/// admit up to N times the limit while Valkey is down. `limiter` labels the
/// fallback metric (enroll | sub).
pub async fn hit_or_local(
    state: &AppState,
    limiter: &'static str,
    key: String,
    limit: i64,
    window_secs: i64,
) -> bool {
    let r = hit(state, key.clone(), limit, window_secs).await;
    settle(
        limiter,
        &key,
        limit,
        window_secs,
        r,
        std::time::Instant::now(),
    )
}

fn settle(
    limiter: &'static str,
    key: &str,
    limit: i64,
    window_secs: i64,
    r: Result<bool, fred::error::Error>,
    now: std::time::Instant,
) -> bool {
    match r {
        Ok(ok) => ok,
        Err(e) => {
            let ok = local().allow(key, limit, window_secs, now);
            tracing::warn!(error = %e, limiter, allowed = ok,
                "rate limit store unavailable; in-process fallback limiter applied");
            crate::metrics::local_limit(limiter, ok);
            ok
        }
    }
}

fn local() -> &'static LocalLimiter {
    static LOCAL: std::sync::OnceLock<LocalLimiter> = std::sync::OnceLock::new();
    LOCAL.get_or_init(LocalLimiter::default)
}

/// Keys tracked by the fallback limiter. Past it, buckets that have
/// refilled completely (equivalent to absent) are dropped; if every bucket
/// is still in use, new keys share one overflow bucket (stricter, never
/// unbounded memory: a flood of distinct source addresses cannot grow it).
const LOCAL_MAX_KEYS: usize = 65_536;
const OVERFLOW_KEY: &str = "\0overflow";

#[derive(Default)]
struct LocalLimiter {
    buckets: std::sync::Mutex<std::collections::HashMap<String, Bucket>>,
}

#[derive(Clone, Copy)]
struct Bucket {
    tokens: f64,
    at: std::time::Instant,
}

impl Bucket {
    fn refilled(self, limit: f64, window: f64, now: std::time::Instant) -> f64 {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        (self.tokens + elapsed * limit / window).min(limit)
    }
}

impl LocalLimiter {
    fn allow(&self, key: &str, limit: i64, window_secs: i64, now: std::time::Instant) -> bool {
        if limit <= 0 {
            return false;
        }
        let (limit, window) = (limit as f64, window_secs.max(1) as f64);
        let mut map = self
            .buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut key = key;
        if !map.contains_key(key) && map.len() >= LOCAL_MAX_KEYS {
            map.retain(|k, b| k == OVERFLOW_KEY || b.refilled(limit, window, now) < limit);
            if map.len() >= LOCAL_MAX_KEYS {
                key = OVERFLOW_KEY;
            }
        }
        let b = map.entry(key.to_owned()).or_insert(Bucket {
            tokens: limit,
            at: now,
        });
        let tokens = b.refilled(limit, window, now);
        let ok = tokens >= 1.0;
        *b = Bucket {
            tokens: if ok { tokens - 1.0 } else { tokens },
            at: now,
        };
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// W9: the fallback admits `limit` per window per key, refills over the
    /// window, and keeps keys apart.
    #[test]
    fn local_bucket_limits_and_refills() {
        let l = LocalLimiter::default();
        let t0 = Instant::now();
        for _ in 0..5 {
            assert!(l.allow("a", 5, 60, t0));
        }
        assert!(!l.allow("a", 5, 60, t0), "sixth within the window");
        assert!(l.allow("b", 5, 60, t0), "other key unaffected");
        assert!(!l.allow("a", 5, 60, t0 + Duration::from_secs(11)));
        assert!(
            l.allow("a", 5, 60, t0 + Duration::from_secs(12)),
            "one refilled"
        );
        assert!(!l.allow("a", 5, 60, t0 + Duration::from_secs(12)));
        let later = t0 + Duration::from_secs(600);
        for _ in 0..5 {
            assert!(l.allow("a", 5, 60, later), "full again, capped at limit");
        }
        assert!(!l.allow("a", 5, 60, later));
        assert!(!l.allow("z", 0, 60, t0), "limit 0 admits nothing");
    }

    /// The key space is bounded: refilled buckets are dropped first, then
    /// new keys share the overflow bucket.
    #[test]
    fn local_bucket_key_space_is_bounded() {
        let l = LocalLimiter::default();
        let t0 = Instant::now();
        for i in 0..LOCAL_MAX_KEYS {
            assert!(l.allow(&format!("k{i}"), 2, 60, t0));
        }
        // Every bucket is in use: overflow (2 per window, shared).
        assert!(l.allow("new-1", 2, 60, t0));
        assert!(l.allow("new-2", 2, 60, t0));
        assert!(!l.allow("new-3", 2, 60, t0));
        assert!(l.buckets.lock().unwrap().len() <= LOCAL_MAX_KEYS + 1);
        // Once the buckets refill they are evictable: new keys get their own.
        let later = t0 + Duration::from_secs(120);
        assert!(l.allow("new-4", 2, 60, later));
        assert!(l.allow("new-4", 2, 60, later));
        assert!(!l.allow("new-4", 2, 60, later));
        assert!(l.buckets.lock().unwrap().len() < 10);
    }

    /// Valkey answers decide; a Valkey error falls back to the local
    /// bucket (fail open, but bounded).
    #[test]
    fn valkey_errors_fall_back_to_the_local_bucket() {
        let t0 = Instant::now();
        let key = format!("akari:rl:test:{}", uuid::Uuid::new_v4().simple());
        assert!(!settle("sub", &key, 1, 60, Ok(false), t0));
        let err = || {
            Err(fred::error::Error::new(
                fred::error::ErrorKind::IO,
                "connection refused",
            ))
        };
        assert!(settle("sub", &key, 1, 60, err(), t0));
        assert!(!settle("sub", &key, 1, 60, err(), t0), "bounded, not open");
    }

    #[tokio::test]
    async fn counts_within_a_window_with_ttl() {
        let Some(db) = crate::testdb::TestDb::new().await else {
            return;
        };
        let st = AppState::for_test(db.pool.clone()).await;
        let key = format!("akari:rl:test:{}", uuid::Uuid::new_v4().simple());
        for _ in 0..3 {
            assert!(hit(&st, key.clone(), 3, 60).await.unwrap());
        }
        assert!(!hit(&st, key.clone(), 3, 60).await.unwrap());
        let ttl: i64 = st.valkey().ttl(&key).await.unwrap();
        assert!(ttl > 0 && ttl <= 60, "ttl {ttl}");
        let _: i64 = st.valkey().del(&key).await.unwrap();
        drop(st);
        db.drop().await;
    }
}
