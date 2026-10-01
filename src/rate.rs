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

#[cfg(test)]
mod tests {
    use super::*;

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
