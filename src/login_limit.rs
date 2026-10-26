//! Login rate limit (S4-1): FAILED attempts only, in Valkey (shared by
//! every panel instance), fixed 15-minute windows, three buckets:
//!
//! - per client address (IPv6 per /64, see `client_ip::bucket`);
//! - per (login name, client network) (the lower-cased email address, D1;
//!   the network is the IPv4 /24 or IPv6 /64, `client_ip::network`): the
//!   lockout of one person's password login, which therefore only reaches
//!   the network the failures came from. Anybody can send failures for a
//!   known address, and a name bucket shared by all addresses would let
//!   them lock the owner out for the window (audit 2026-10 P3);
//! - per login name across all networks, `PER_NAME` = 10 × the pair limit:
//!   still stops guessing spread over many networks, but needs a botnet
//!   rather than one host to lock somebody out.
//!
//! An attempt first reserves a slot in all three buckets atomically (a Lua
//! script: INCR them, refuse and undo if any is over its limit), so
//! concurrent attempts cannot overshoot a limit. A successful login (or an
//! attempt that fails for a reason other than bad credentials) returns its
//! reservation; only credential failures keep it. Refused attempts (429)
//! are not counted.
//!
//! Cardinality: a key outlives its request only when it holds a failed
//! attempt, and every failed attempt costs an argon2 verification, so the
//! number of live keys is bounded by argon2 throughput × the window; each
//! key has a TTL set in the same script (EXPIRE NX), and the name part of a
//! key is a fixed-size hash of the login.
//!
//! The current-password checks of `/me/password` and `/me/email/code`
//! reserve here too (a wrong current password is a credential failure).

use std::net::IpAddr;

use fred::prelude::*;
use sha2::{Digest, Sha256};

use crate::state::AppState;

/// Failed attempts per client address per window.
pub const PER_IP: i64 = 20;
/// Failed attempts per (login name, client network) per window. Equal to
/// `PER_IP`: a user's own typos hit their address's limit first.
pub const PER_NAME_NETWORK: i64 = 20;
/// Failed attempts per login name per window across all networks: the
/// looser bucket against distributed guessing.
pub const PER_NAME: i64 = 10 * PER_NAME_NETWORK;
pub const WINDOW_SECS: i64 = 900;

/// KEYS: address, name, (name, network). ARGV: the three limits, the TTL.
/// Returns `{name count, pair count}` of the reservation, `{0, 0}` when
/// refused.
const RESERVE: &str = r#"
local ttl = tonumber(ARGV[4])
local n = {}
for i = 1, 3 do
  n[i] = redis.call('INCR', KEYS[i])
  redis.call('EXPIRE', KEYS[i], ttl, 'NX')
end
if n[1] > tonumber(ARGV[1]) or n[2] > tonumber(ARGV[2]) or n[3] > tonumber(ARGV[3]) then
  for i = 1, 3 do
    if redis.call('DECR', KEYS[i]) <= 0 then redis.call('DEL', KEYS[i]) end
  end
  return {0, 0}
end
return {n[2], n[3]}
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
    /// Reserved slots in the login-name bucket (all networks) including
    /// this one: if this attempt fails, it is failure number `name_count`
    /// of the window (audit.rs records the first and the one that fills
    /// the bucket).
    pub name_count: i64,
    /// The same for the (login name, client network) bucket.
    pub pair_count: i64,
}

/// The login-name bucket (all networks) of `login`.
pub fn name_key(login: &str) -> String {
    format!(
        "akari:rl:login:name:{}",
        hex::encode(Sha256::digest(login.as_bytes()))
    )
}

/// The three bucket keys of an attempt: address, name, (name, network). An
/// unknown client (no address on the request) shares one "unknown" bucket
/// and network.
pub fn keys(client: Option<IpAddr>, login: &str) -> Vec<String> {
    let (bucket, network) = match client {
        Some(ip) => (crate::client_ip::bucket(ip), crate::client_ip::network(ip)),
        None => ("unknown".to_owned(), "unknown".to_owned()),
    };
    vec![
        format!("akari:rl:login:ip:{bucket}"),
        name_key(login),
        format!(
            "akari:rl:login:pair:{network}:{}",
            hex::encode(Sha256::digest(login.as_bytes()))
        ),
    ]
}

impl Attempt {
    /// Reserve a slot in all three buckets; `None` = over a limit (429).
    pub async fn reserve(
        state: &AppState,
        client: Option<IpAddr>,
        login: &str,
    ) -> Result<Option<Self>, fred::error::Error> {
        let keys = keys(client, login);
        let counts: Vec<i64> = state
            .valkey()
            .eval(
                RESERVE,
                keys.clone(),
                vec![PER_IP, PER_NAME, PER_NAME_NETWORK, WINDOW_SECS],
            )
            .await?;
        let (name_count, pair_count) = match counts[..] {
            [name, pair] => (name, pair),
            _ => (0, 0),
        };
        crate::metrics::login_attempt(name_count >= 1);
        Ok((name_count >= 1).then_some(Self {
            keys,
            name_count,
            pair_count,
        }))
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
    use std::net::Ipv4Addr;

    use super::*;

    async fn state() -> Option<(crate::testdb::TestDb, AppState)> {
        let db = crate::testdb::TestDb::new().await?;
        let st = AppState::for_test(db.pool.clone()).await;
        Some((db, st))
    }

    fn uniq() -> String {
        uuid::Uuid::new_v4().simple().to_string()
    }

    /// An address in 100.<network>.<host>: `network` picks the /24, `host`
    /// the address inside it.
    fn addr(network: [u8; 2], host: u8) -> Option<IpAddr> {
        Some(IpAddr::V4(Ipv4Addr::new(100, network[0], network[1], host)))
    }

    fn random_network() -> [u8; 2] {
        let id = uuid::Uuid::new_v4();
        [id.as_bytes()[0], id.as_bytes()[1]]
    }

    async fn clear(st: &AppState, clients: &[Option<IpAddr>], login: &str) {
        let mut all = Vec::new();
        for client in clients {
            all.extend(keys(*client, login));
        }
        let _: i64 = st.valkey().del(all).await.unwrap();
    }

    async fn count(st: &AppState, key: &str) -> i64 {
        let n: Option<i64> = st.valkey().get(key).await.unwrap();
        n.unwrap_or(0)
    }

    #[test]
    fn keys_pair_the_name_with_the_network() {
        let login = "a@example.test";
        let same_24 = (keys(addr([1, 2], 3), login), keys(addr([1, 2], 200), login));
        assert_ne!(same_24.0[0], same_24.1[0], "addresses are separate buckets");
        assert_eq!(same_24.0[1], same_24.1[1], "one name bucket");
        assert_eq!(same_24.0[2], same_24.1[2], "one /24, one pair bucket");
        let other_24 = keys(addr([1, 3], 3), login);
        assert_eq!(other_24[1], same_24.0[1]);
        assert_ne!(other_24[2], same_24.0[2], "another network, another pair");
        let other_name = keys(addr([1, 2], 3), "b@example.test");
        assert_ne!(other_name[1], same_24.0[1]);
        assert_ne!(other_name[2], same_24.0[2]);
        assert_eq!(name_key(login), same_24.0[1]);
    }

    #[tokio::test]
    async fn failures_only_per_ip() {
        let Some((db, st)) = state().await else {
            return;
        };
        let (ip, other_ip) = (addr(random_network(), 1), addr(random_network(), 1));
        let login = format!("login-{}", uniq());
        // Successes never count.
        for _ in 0..(PER_IP * 3) {
            let a = Attempt::reserve(&st, ip, &login).await.unwrap().unwrap();
            a.release(&st).await;
        }
        for key in keys(ip, &login) {
            let n: Option<i64> = st.valkey().get(&key).await.unwrap();
            assert_eq!(n, None, "released to zero = deleted: {key}");
        }
        // PER_IP failures from one address (under the pair limit: other
        // names), then that address is refused (for any login) ...
        let spread: Vec<String> = (0..PER_IP).map(|_| format!("l-{}", uniq())).collect();
        for name in &spread {
            Attempt::reserve(&st, ip, name)
                .await
                .unwrap()
                .unwrap()
                .fail();
        }
        assert!(Attempt::reserve(&st, ip, &login).await.unwrap().is_none());
        // ... refusals are not counted (still exactly PER_IP, and the
        // refused attempt left nothing behind in the other buckets) ...
        assert_eq!(count(&st, &keys(ip, &login)[0]).await, PER_IP);
        assert_eq!(count(&st, &keys(ip, &login)[1]).await, 0);
        assert_eq!(count(&st, &keys(ip, &login)[2]).await, 0);
        // ... and a different address still gets to try the same login.
        let a = Attempt::reserve(&st, other_ip, &spread[0])
            .await
            .unwrap()
            .expect("other address not limited by the first one's failures");
        a.release(&st).await;
        // Every key carries the window TTL.
        for key in keys(ip, &spread[0]) {
            let ttl: i64 = st.valkey().ttl(&key).await.unwrap();
            assert!(ttl > 0 && ttl <= WINDOW_SECS, "ttl {ttl} of {key}");
        }
        for name in &spread {
            clear(&st, &[ip, other_ip], name).await;
        }
        clear(&st, &[ip, other_ip], &login).await;
        drop(st);
        db.drop().await;
    }

    /// The abuse the pair bucket exists for: failures sent for somebody's
    /// address lock only the network they came from, not the owner at
    /// home. Other names from the attacker's network are unaffected too.
    #[tokio::test]
    async fn pair_bucket_locks_only_the_attackers_network() {
        let Some((db, st)) = state().await else {
            return;
        };
        let (attacker_net, home_net) = (random_network(), random_network());
        let victim = format!("victim-{}", uniq());
        let bystander = format!("bystander-{}", uniq());
        // The attacker rotates over the addresses of its /24, so no
        // single address bucket fills first.
        let mut used = Vec::new();
        for host in 0..PER_NAME_NETWORK as u8 {
            let c = addr(attacker_net, host);
            Attempt::reserve(&st, c, &victim)
                .await
                .unwrap()
                .unwrap()
                .fail();
            used.push(c);
        }
        let fresh_in_net = addr(attacker_net, 250);
        assert!(
            Attempt::reserve(&st, fresh_in_net, &victim)
                .await
                .unwrap()
                .is_none(),
            "the attacker's network is locked out of the victim's login"
        );
        // Refused: nothing counted, in any bucket.
        let k = keys(fresh_in_net, &victim);
        assert_eq!(count(&st, &k[0]).await, 0);
        assert_eq!(count(&st, &k[1]).await, PER_NAME_NETWORK);
        assert_eq!(count(&st, &k[2]).await, PER_NAME_NETWORK);
        // The owner (another network) still gets in, and other logins
        // from the attacker's network are not locked.
        let home = addr(home_net, 7);
        Attempt::reserve(&st, home, &victim)
            .await
            .unwrap()
            .expect("the owner's network is not locked")
            .release(&st)
            .await;
        Attempt::reserve(&st, fresh_in_net, &bystander)
            .await
            .unwrap()
            .expect("another login from the attacker's network")
            .release(&st)
            .await;
        used.extend([fresh_in_net, home]);
        clear(&st, &used, &victim).await;
        clear(&st, &used, &bystander).await;
        drop(st);
        db.drop().await;
    }

    /// A distributed guesser (a few failures from each of many networks)
    /// is stopped by the per-name bucket; other logins are unaffected.
    #[tokio::test]
    async fn name_bucket_stops_distributed_guessing() {
        let Some((db, st)) = state().await else {
            return;
        };
        let login = format!("victim-{}", uniq());
        let base = random_network()[0];
        let mut used = Vec::new();
        for i in 0..PER_NAME {
            let c = addr([base, i as u8], 1);
            Attempt::reserve(&st, c, &login)
                .await
                .unwrap()
                .unwrap_or_else(|| panic!("failure {i} of {PER_NAME} refused early"))
                .fail();
            used.push(c);
        }
        let fresh = addr([base, 255], 1);
        assert!(
            Attempt::reserve(&st, fresh, &login)
                .await
                .unwrap()
                .is_none(),
            "every network is refused once the name bucket is full"
        );
        assert_eq!(count(&st, &name_key(&login)).await, PER_NAME, "not counted");
        let other = format!("bystander-{}", uniq());
        let a = Attempt::reserve(&st, fresh, &other).await.unwrap().unwrap();
        a.release(&st).await;
        used.push(fresh);
        clear(&st, &used, &login).await;
        clear(&st, &used, &other).await;
        drop(st);
        db.drop().await;
    }

    /// The counts the audit trail throttles on.
    #[tokio::test]
    async fn attempt_reports_both_name_counts() {
        let Some((db, st)) = state().await else {
            return;
        };
        let login = format!("login-{}", uniq());
        let net = random_network();
        let (a, b) = (addr(net, 1), addr([net[0], net[1].wrapping_add(1)], 1));
        let first = Attempt::reserve(&st, a, &login).await.unwrap().unwrap();
        assert_eq!((first.name_count, first.pair_count), (1, 1));
        first.fail();
        let second = Attempt::reserve(&st, b, &login).await.unwrap().unwrap();
        assert_eq!(
            (second.name_count, second.pair_count),
            (2, 1),
            "another network: its own pair count"
        );
        second.fail();
        let third = Attempt::reserve(&st, a, &login).await.unwrap().unwrap();
        assert_eq!((third.name_count, third.pair_count), (3, 2));
        third.fail();
        clear(&st, &[a, b], &login).await;
        drop(st);
        db.drop().await;
    }

    /// Concurrent attempts cannot overshoot the limit (atomic reserve).
    #[tokio::test]
    async fn concurrent_reservations_respect_the_limit() {
        let Some((db, st)) = state().await else {
            return;
        };
        let ip = addr(random_network(), 1);
        let login = format!("login-{}", uniq());
        let tasks: Vec<_> = (0..(PER_IP * 3))
            .map(|_| {
                let (st, login) = (st.clone(), login.clone());
                tokio::spawn(async move {
                    Attempt::reserve(&st, ip, &login)
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
        assert_eq!(granted, PER_IP.min(PER_NAME_NETWORK));
        clear(&st, &[ip], &login).await;
        drop(st);
        db.drop().await;
    }
}
