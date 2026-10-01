//! Login rate limit (S4-1): FAILED attempts only, counted per client
//! address (IPv6 per /64, see `client_ip::bucket`) and per login name, in
//! Valkey (shared by every panel instance), fixed 15-minute windows.
//!
//! An attempt first reserves a slot in both buckets atomically (a Lua
//! script: INCR both, refuse and undo if either is over its limit), so
//! concurrent attempts cannot overshoot a limit. A successful login (or an
//! attempt that fails for a reason other than bad credentials) returns its
//! reservation; only credential failures keep it. Refused attempts (429)
//! are not counted.
//!
//! Cardinality: a key outlives its request only when it holds a failed
//! attempt, and every failed attempt costs an argon2 verification, so the
//! number of live keys is bounded by argon2 throughput × the window; each
//! key has a TTL set in the same script (EXPIRE NX), and the name bucket is
//! a fixed-size hash of the login.

use fred::prelude::*;
use sha2::{Digest, Sha256};

use crate::state::AppState;

/// Failed attempts per client address per window.
pub const PER_IP: i64 = 20;
/// Failed attempts per login name per window (across all addresses). Above
/// PER_IP so a user's own typos hit their address's limit first.
pub const PER_LOGIN: i64 = 50;
pub const WINDOW_SECS: i64 = 900;

const RESERVE: &str = r#"
local ttl = tonumber(ARGV[3])
local a = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ttl, 'NX')
local b = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ttl, 'NX')
if a > tonumber(ARGV[1]) or b > tonumber(ARGV[2]) then
  for i = 1, 2 do
    if redis.call('DECR', KEYS[i]) <= 0 then redis.call('DEL', KEYS[i]) end
  end
  return 0
end
return 1
"#;

const RELEASE: &str = r#"
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    if redis.call('DECR', KEYS[i]) <= 0 then redis.call('DEL', KEYS[i]) end
  end
end
return 1
"#;

/// One login attempt's reservation.
pub struct Attempt {
    keys: Vec<String>,
}

pub fn keys(client_bucket: &str, login: &str) -> Vec<String> {
    vec![
        format!("akari:rl:login:ip:{client_bucket}"),
        format!(
            "akari:rl:login:name:{}",
            hex::encode(Sha256::digest(login.as_bytes()))
        ),
    ]
}

impl Attempt {
    /// Reserve a slot in both buckets; `None` = over a limit (429).
    pub async fn reserve(
        state: &AppState,
        client_bucket: &str,
        login: &str,
    ) -> Result<Option<Self>, fred::error::Error> {
        let keys = keys(client_bucket, login);
        let ok: i64 = state
            .valkey()
            .eval(RESERVE, keys.clone(), vec![PER_IP, PER_LOGIN, WINDOW_SECS])
            .await?;
        crate::metrics::login_attempt(ok == 1);
        Ok((ok == 1).then_some(Self { keys }))
    }

    /// The attempt did not fail on credentials: give the slots back.
    pub async fn release(self, state: &AppState) {
        let r: Result<i64, _> = state
            .valkey()
            .eval(RELEASE, self.keys, Vec::<i64>::new())
            .await;
        if let Err(e) = r {
            tracing::warn!(error = %e, "login rate limit release failed");
        }
    }

    /// A credential failure: the slots stay taken until the window ends.
    pub fn fail(self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn state() -> Option<(crate::testdb::TestDb, AppState)> {
        let db = crate::testdb::TestDb::new().await?;
        let st = AppState::for_test(db.pool.clone()).await;
        Some((db, st))
    }

    fn uniq() -> String {
        uuid::Uuid::new_v4().simple().to_string()
    }

    async fn clear(st: &AppState, ip: &str, login: &str) {
        let _: i64 = st.valkey().del(keys(ip, login)).await.unwrap();
    }

    #[tokio::test]
    async fn failures_only_per_ip_and_per_login() {
        let Some((db, st)) = state().await else {
            return;
        };
        let (ip, other_ip) = (format!("ip-{}", uniq()), format!("ip-{}", uniq()));
        let login = format!("login-{}", uniq());
        // Successes never count.
        for _ in 0..(PER_IP * 3) {
            let a = Attempt::reserve(&st, &ip, &login).await.unwrap().unwrap();
            a.release(&st).await;
        }
        let n: Option<i64> = st.valkey().get(&keys(&ip, &login)[0]).await.unwrap();
        assert_eq!(n, None, "released to zero = deleted");
        // PER_IP failures from one address, then that address is refused
        // (for any login) ...
        for _ in 0..PER_IP {
            Attempt::reserve(&st, &ip, &login)
                .await
                .unwrap()
                .unwrap()
                .fail();
        }
        assert!(Attempt::reserve(&st, &ip, &login).await.unwrap().is_none());
        let other_login = format!("login-{}", uniq());
        assert!(Attempt::reserve(&st, &ip, &other_login)
            .await
            .unwrap()
            .is_none());
        // ... refusals are not counted (still exactly PER_IP) ...
        let n: i64 = st.valkey().get(&keys(&ip, &login)[0]).await.unwrap();
        assert_eq!(n, PER_IP);
        // ... and a different address still gets to try the same login.
        let a = Attempt::reserve(&st, &other_ip, &login)
            .await
            .unwrap()
            .expect("other address not limited by the first one's failures");
        a.release(&st).await;
        // The refused attempt for other_login left no key behind.
        let n: Option<i64> = st.valkey().get(&keys(&ip, &other_login)[1]).await.unwrap();
        assert_eq!(n, None);
        // Both keys carry the window TTL.
        let ttl: i64 = st.valkey().ttl(&keys(&ip, &login)[0]).await.unwrap();
        assert!(ttl > 0 && ttl <= WINDOW_SECS, "ttl {ttl}");
        let ttl: i64 = st.valkey().ttl(&keys(&ip, &login)[1]).await.unwrap();
        assert!(ttl > 0 && ttl <= WINDOW_SECS, "ttl {ttl}");
        clear(&st, &ip, &login).await;
        clear(&st, &other_ip, &login).await;
        drop(st);
        db.drop().await;
    }

    /// A distributed guesser (one failure per address) is stopped by the
    /// per-login bucket; other logins are unaffected.
    #[tokio::test]
    async fn per_login_bucket_stops_distributed_guessing() {
        let Some((db, st)) = state().await else {
            return;
        };
        let login = format!("victim-{}", uniq());
        let mut ips = Vec::new();
        for _ in 0..PER_LOGIN {
            let ip = format!("ip-{}", uniq());
            Attempt::reserve(&st, &ip, &login)
                .await
                .unwrap()
                .unwrap()
                .fail();
            ips.push(ip);
        }
        let fresh = format!("ip-{}", uniq());
        assert!(Attempt::reserve(&st, &fresh, &login)
            .await
            .unwrap()
            .is_none());
        let other = format!("bystander-{}", uniq());
        let a = Attempt::reserve(&st, &fresh, &other)
            .await
            .unwrap()
            .unwrap();
        a.release(&st).await;
        for ip in &ips {
            clear(&st, ip, &login).await;
        }
        clear(&st, &fresh, &other).await;
        drop(st);
        db.drop().await;
    }

    /// Concurrent attempts cannot overshoot the limit (atomic reserve).
    #[tokio::test]
    async fn concurrent_reservations_respect_the_limit() {
        let Some((db, st)) = state().await else {
            return;
        };
        let ip = format!("ip-{}", uniq());
        let login = format!("login-{}", uniq());
        let tasks: Vec<_> = (0..(PER_IP * 3))
            .map(|_| {
                let (st, ip, login) = (st.clone(), ip.clone(), login.clone());
                tokio::spawn(async move {
                    Attempt::reserve(&st, &ip, &login)
                        .await
                        .unwrap()
                        .map(|a| a.fail())
                        .is_some()
                })
            })
            .collect();
        let mut granted = 0;
        for t in tasks {
            granted += i64::from(t.await.unwrap());
        }
        assert_eq!(granted, PER_IP);
        clear(&st, &ip, &login).await;
        drop(st);
        db.drop().await;
    }
}
