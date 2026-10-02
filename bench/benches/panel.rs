//! Criterion benchmarks of the panel's hot paths (M2-1). Pure CPU benches
//! always run; the database benches (desired state of a 10k-user node, the
//! 50k-row traffic flush) need the seeded bench database
//! (`akari-bench seed`, BENCH_DATABASE_URL) and are skipped with a note
//! when it is unreachable or empty.
//!
//!   make bench                      # everything
//!   cargo bench --manifest-path bench/Cargo.toml -- state_hash

use std::collections::HashSet;
use std::time::{Duration, Instant};

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use uuid::Uuid;

use akari_panel::gen::{user_op, InboundUser, TrafficReport, UserOp, UserTraffic};
use akari_panel::grpc::{diff_user_sets, state_hash, user_set, NodeState, UserSet};

const DEFAULT_DB: &str = "postgres://akari:akari-dev@localhost:5433/akari_bench";

/// A node's user set like the seeded ones: one vless + one trojan
/// credential per user.
fn ops(n: usize) -> Vec<UserOp> {
    (0..n)
        .map(|_| UserOp {
            op: user_op::Op::Add as i32,
            user_id: Uuid::new_v4().to_string(),
            inbound_users: vec![
                InboundUser {
                    inbound_tag: "in-vless".into(),
                    account_json: format!(
                        r#"{{"flow":"xtls-rprx-vision","id":"{}"}}"#,
                        Uuid::new_v4()
                    ),
                    protocol: "vless".into(),
                },
                InboundUser {
                    inbound_tag: "in-trojan".into(),
                    account_json: format!(r#"{{"password":"{}"}}"#, Uuid::new_v4().simple()),
                    protocol: "trojan".into(),
                },
            ],
            speed_limit_bytes_per_sec: 0,
        })
        .collect()
}

/// `want` = `base` with `changed` users removed and `changed` new ones.
fn changed(base: &UserSet, changed: usize) -> NodeState {
    let mut want = base.clone();
    let drop: Vec<String> = want.keys().take(changed).cloned().collect();
    for k in drop {
        want.remove(&k);
    }
    want.extend(user_set(&ops(changed)));
    NodeState {
        users: want,
        ..Default::default()
    }
}

fn pure(c: &mut Criterion) {
    let mut g = c.benchmark_group("pure");
    for n in [1_000usize, 10_000] {
        let o = ops(n);
        let set = user_set(&o);
        let state = NodeState {
            inbounds: "[{\"tag\":\"in-vless\",\"protocol\":\"vless\",\"port\":443}]".repeat(4),
            users: set.clone(),
            ..Default::default()
        };
        g.throughput(Throughput::Elements(n as u64));
        g.bench_with_input(BenchmarkId::new("user_set", n), &o, |b, o| {
            b.iter(|| user_set(std::hint::black_box(o)))
        });
        g.bench_with_input(BenchmarkId::new("state_hash", n), &state, |b, s| {
            b.iter(|| state_hash(7, std::hint::black_box(s)))
        });
        let base = NodeState {
            users: set.clone(),
            ..Default::default()
        };
        let one = changed(&set, 1);
        g.bench_with_input(
            BenchmarkId::new("diff_user_sets/1_changed", n),
            &one,
            |b, w| b.iter(|| diff_user_sets(std::hint::black_box(&base), w)),
        );
        let tenth = changed(&set, n / 10);
        g.bench_with_input(
            BenchmarkId::new("diff_user_sets/10pct_changed", n),
            &tenth,
            |b, w| b.iter(|| diff_user_sets(std::hint::black_box(&base), w)),
        );
        let snap = akari_panel::gen::ConfigSnapshot {
            config_version: 3,
            inbounds_json: state.inbounds.clone(),
            user_version: 9,
            users: o.clone(),
            ..Default::default()
        };
        g.bench_with_input(BenchmarkId::new("snapshot_encode", n), &snap, |b, s| {
            b.iter(|| prost::Message::encode_to_vec(std::hint::black_box(s)))
        });
    }
    g.finish();
}

fn sub_rows(nodes: usize) -> Vec<akari_panel::sub::NodeRow> {
    (0..nodes)
        .map(|i| akari_panel::sub::NodeRow {
            name: format!("bench-node-{i:03}"),
            xray_inbounds: serde_json::json!([
                {"tag": "in-vless", "protocol": "vless", "port": 443,
                 "streamSettings": {"network": "tcp", "security": "reality",
                    "realitySettings": {"serverNames": ["n.example.com"],
                        "publicKey": "Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw",
                        "shortId": "6ba85179e30d4fc2"}}},
                {"tag": "in-trojan", "protocol": "trojan", "port": 8443,
                 "streamSettings": {"network": "ws", "security": "tls",
                    "tlsSettings": {"serverName": "n.example.com"},
                    "wsSettings": {"path": "/t", "headers": {"Host": "n.example.com"}}}}
            ]),
            server_addr: Some(format!("198.51.100.{}", 1 + i % 250)),
            credentials: serde_json::json!([
                {"inbound_tag": "in-vless", "protocol": "vless",
                 "account": {"id": Uuid::new_v4().to_string(), "flow": "xtls-rprx-vision"}},
                {"inbound_tag": "in-trojan", "protocol": "trojan",
                 "account": {"password": Uuid::new_v4().simple().to_string()}}
            ]),
            display_name: None,
            tags: vec![],
            connect_overrides: serde_json::Value::Null,
        })
        .collect()
}

fn subscription(c: &mut Criterion) {
    let mut g = c.benchmark_group("sub_render");
    for nodes in [1usize, 40, 200] {
        let rows = sub_rows(nodes);
        for (fmt, ua) in [
            ("clash", "clash-verge/v2"),
            ("links", "v2rayN/7"),
            ("sing-box", "sing-box 1.12"),
        ] {
            g.bench_with_input(BenchmarkId::new(fmt, nodes), &rows, |b, rows| {
                b.iter(|| akari_panel::sub::render(ua, std::hint::black_box(rows)))
            });
        }
    }
    g.finish();
}

struct Db {
    rt: tokio::runtime::Runtime,
    pg: sqlx::PgPool,
}

fn db() -> Option<Db> {
    let url = std::env::var("BENCH_DATABASE_URL").unwrap_or_else(|_| DEFAULT_DB.into());
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .ok()?;
    let pg = rt.block_on(async {
        let pg = sqlx::postgres::PgPoolOptions::new()
            .max_connections(4)
            .acquire_timeout(Duration::from_secs(3))
            .connect(&url)
            .await
            .ok()?;
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM node_users")
            .fetch_one(&pg)
            .await
            .ok()?;
        (n > 0).then_some(pg)
    });
    match pg {
        Some(pg) => Some(Db { rt, pg }),
        None => {
            eprintln!(
                "database benches skipped: no seeded bench database at {url} (akari-bench seed)"
            );
            None
        }
    }
}

fn database(c: &mut Criterion) {
    let Some(db) = db() else {
        return;
    };
    let mut g = c.benchmark_group("db");
    g.sample_size(20);
    g.measurement_time(Duration::from_secs(10));

    // Snapshot of the biggest node: DB read (REPEATABLE READ) + build.
    let Ok(Some((node, users))) = db.rt.block_on(
        sqlx::query_as::<_, (Uuid, i64)>(
            "SELECT node_id, count(*) FROM node_users GROUP BY node_id ORDER BY 2 DESC LIMIT 1",
        )
        .fetch_optional(&db.pg),
    ) else {
        eprintln!("no node_users");
        return;
    };
    g.throughput(Throughput::Elements(users as u64));
    g.bench_function(BenchmarkId::new("desired_snapshot", users), |b| {
        b.to_async(&db.rt)
            .iter(|| async { akari_panel::grpc::desired_snapshot(&db.pg, node).await })
    });
    // The whole build a session does for a Snapshot: read + user set +
    // state hash + encode.
    g.bench_function(BenchmarkId::new("snapshot_build_full", users), |b| {
        b.to_async(&db.rt).iter(|| async {
            if let Ok(Some(s)) = akari_panel::grpc::desired_snapshot(&db.pg, node).await {
                let h = state_hash(
                    s.config_version,
                    &NodeState::of_snapshot(s.inbounds_json.clone(), &s.users),
                );
                (h, prost::Message::encode_to_vec(&s).len())
            } else {
                (String::new(), 0)
            }
        })
    });

    // Traffic flush: 50k dirty rows (250 users on each of 200 nodes), one
    // flush per iteration; counters grow every iteration so every row is
    // an UPDATE that bills a delta (the steady state).
    let rows = 50_000i64;
    let Ok(pairs) = db.rt.block_on(
        sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT node_id, user_id FROM (SELECT node_id, user_id, \
             row_number() OVER (PARTITION BY node_id ORDER BY user_id) AS r FROM node_users) t \
             WHERE r <= $1 / (SELECT count(DISTINCT node_id) FROM node_users) LIMIT $1",
        )
        .bind(rows)
        .fetch_all(&db.pg),
    ) else {
        return;
    };
    let mut by_node: std::collections::HashMap<Uuid, Vec<Uuid>> = Default::default();
    for (n, u) in &pairs {
        by_node.entry(*n).or_default().push(*u);
    }
    let rates = akari_panel::traffic::Rates::from_cfg(&akari_panel::config::PanelConfig::default());
    let session = format!("criterion-{}", Uuid::new_v4().simple());
    let mut step = 0u64;
    g.throughput(Throughput::Elements(pairs.len() as u64));
    g.bench_function(BenchmarkId::new("flush", pairs.len()), |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                step += 1;
                let buf = akari_panel::traffic::TrafficBuffer::new();
                for (node, users) in &by_node {
                    buf.set_members(*node, users.iter().copied().collect::<HashSet<_>>());
                    buf.update(
                        *node,
                        &session,
                        &TrafficReport {
                            users: users
                                .iter()
                                .map(|u| UserTraffic {
                                    user_id: u.to_string(),
                                    up_bytes: 1000 * step,
                                    down_bytes: 5000 * step,
                                })
                                .collect(),
                            monotonic_ms: 0,
                            session_id: session.clone(),
                        },
                    );
                }
                let t = Instant::now();
                let r = db.rt.block_on(akari_panel::traffic::flush_buffer(
                    &db.pg, &buf, rates, None,
                ));
                total += t.elapsed();
                if let Err(e) = r {
                    eprintln!("flush failed: {e:#}");
                }
            }
            total
        })
    });
    g.finish();
}

/// Buffer maintenance at the M2 scale (200 nodes x 10k users = 2M entries,
/// 2.5% dirty per report): the work the 5 s flush tick does besides SQL
/// (`snapshot` = what to write, `prune` = eviction + index upkeep).
fn buffer(c: &mut Criterion) {
    let mut g = c.benchmark_group("buffer");
    g.sample_size(10);
    let (nodes, per_node) = (200usize, 10_000usize);
    let buf = akari_panel::traffic::TrafficBuffer::new();
    let session = "criterion-buffer".to_string();
    let report = |users: &[Uuid], step: u64| TrafficReport {
        users: users
            .iter()
            .map(|u| UserTraffic {
                user_id: u.to_string(),
                up_bytes: 1000 * step,
                down_bytes: 5000 * step,
            })
            .collect(),
        monotonic_ms: 0,
        session_id: session.clone(),
    };
    let mut all = Vec::new();
    for _ in 0..nodes {
        let node = Uuid::new_v4();
        let users: Vec<Uuid> = (0..per_node).map(|_| Uuid::new_v4()).collect();
        buf.set_members(node, users.iter().copied().collect::<HashSet<_>>());
        buf.update(node, &session, &report(&users, 1));
        all.push((node, users));
    }
    buf.bench_mark_all_flushed();
    // 2.5% of users report new traffic.
    for (node, users) in &all {
        buf.update(*node, &session, &report(&users[..per_node / 40], 2));
    }
    g.bench_function("snapshot/2M_entries_2.5pct_dirty", |b| {
        b.iter(|| std::hint::black_box(buf.bench_snapshot_len()))
    });
    g.bench_function("prune_idle/2M_entries", |b| {
        b.iter(|| buf.bench_prune_idle(Instant::now()))
    });
    g.bench_function("prune_full/2M_entries", |b| {
        b.iter(|| buf.prune(Instant::now()))
    });
    g.finish();
}

criterion_group!(benches, pure, subscription, database, buffer);
criterion_main!(benches);
