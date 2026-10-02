# Performance and scale (M2)

Targets (ROADMAP §0), measured on the data set of one panel instance serving
200 nodes / 50k users / 10k users on every node (2M `node_users` rows, 2M
`traffic_counters` rows). Everything here is reproducible with `bench/`.

## Results against the targets

| Target | Measured | Verdict |
|---|---|---|
| Snapshot build, 10k-user node < 200 ms | DB read + build 33 ms; full build (read + user set + state hash + encode) 43 ms; agent side: xray rebuild with 10k users 57 ms | pass |
| Flush of 50k traffic rows < 1 s | 0.91 s (criterion mean; 10 chunks of 5000, about 91 ms each); W11 0.49 s; W22 (with the traffic history) 0.58 s, see "W22" | pass, ~40% margin |
| Admin API p99 < 50 ms | W21: `dashboard` 16–21 ms, `users_search` 7–31 ms, `users_filtered` 18–22 ms (one noisy run 55 ms); idle, 16 clients: worst endpoint 10.2 ms (`nodes`); under 200-agent load: worst read 30.5 ms (`users_deep`); W17: the console's node list (`nodes?view=summary`) 12–26 ms under load (full list 27–43 ms) | pass |
| Subscription p99 < 30 ms | idle 5.1 ms; under load 16.7 ms (single instance), 31 ms (`clash`) / 20 ms (`links`) through the two-instance balancer | pass (single instance); 1 ms over on the balancer run, see notes |
| User change to agent < 2 s | single instance: p50 0.26 s, p99 0.59 s, max 0.68 s; two instances behind a balancer: p99 0.89 s, max 0.98 s (3200 agent applications each) | pass |
| Billing exact | reported = billed to the byte in every steady-state run, single and two instances | pass |
| Two instances behind a balancer pass the cross-instance checks | `akari-bench multi`: all pass | pass |

Notes:

- The load generator, panel(s), PostgreSQL and Valkey share one machine, and
  other work ran on it, so every latency includes client-side CPU contention.
  Treat them as upper bounds.
- The 31 ms on the balancer run is the p99 of `clash` while 200 agents report
  and 80 changes propagate, through a user-space TCP balancer on the same host;
  the single-instance run of the same load is 16.7 ms.
- Writes under saturation: 16 concurrent `PATCH /users/{id}` clients against a
  busy panel reached p99 55 ms (every patch locks the user's ~40 nodes and
  waits behind flush chunks and its peers); 2 concurrent clients: p99 14 ms.
  Not an admin-rate scenario (the run was 2400 patches/s), recorded for
  completeness.

## W22: traffic history (2026-10-03)

The flush now also records what it settled per user, node and UTC day.
Design driven by the flush budget:

| `db/flush`, 50k rows (bench set + 30 days of history: 3M `traffic_daily` rows) | time |
|---|---|
| main before W22 (same run, same database) | 0.490 s (fresh seed); A/B interleaved: 0.515 / 0.547 / 0.635 s |
| first cut: `FLUSH_SQL` upserts `traffic_daily` + `traffic_node_daily` directly (`ON CONFLICT`) | 1.29 s (fails the budget) |
| same, existing day rows as plain `UPDATE`s (`ON CONFLICT` only for new ones, like `traffic_counters`) | 0.81 s |
| **shipped**: `FLUSH_SQL` appends to an index-less staging table (`traffic_daily_pending`), the reaper folds it every 30 s | A/B interleaved: 0.576 / 0.581 / 0.630 s |

So the history costs the flush ~+10–15% (one extra heap insert per billed
row, no index, no conflict check), and every row is written in the same
statement as the settlement (exactly as idempotent). A direct day-row update
costs as much as the `traffic_counters` update itself (~27 ms per 5000-row
chunk, `akari-bench explain`), which is why it is off the flush path.

Compaction (`traffic::COMPACT_SQL`, one statement per 50k staged rows:
`DELETE ... RETURNING` → aggregate → `UPDATE` existing day rows → `INSERT`
new ones → per-node-day upsert): `db/compact/50000` = 0.25–0.29 s for one
flush's worth (50k distinct user-node pairs). At the 30 s cadence a busy
panel stages ~6 flushes per pass but folds them into the same 50k day rows,
so a pass is well under a second every 30 s, under an advisory try-lock (one
instance at a time), holding no node or user locks.

Read side (`akari-bench http`, panel on the bench set + 30 days of history at
2 nodes per user per day = 3M daily rows, ~7.9k distinct users per node per
30 days; default 30-day range):

| Scenario | 4 clients p99 | 8 clients p99 | 16 clients p99 |
|---|---|---|---|
| `traffic_user` (`/users/{id}/traffic`, per day) | 2.1 ms | 5.6 ms | 15.0 ms |
| `traffic_user_nodes` (`group=node`) | — | — | 14.4 ms |
| `traffic_node` (`/nodes/{id}/traffic`, per day + top 20 users) | 10.4 ms | 11.0 ms | 55.4 ms |
| `traffic_summary` (`/traffic/summary`) | 3.5 ms | 8.8 ms | 20.3 ms |
| `traffic_me` (`/me/traffic`) | 2.3 ms | 7.9 ms | 5.2 ms |

`traffic_node` aggregates ~15k day rows per request (10 ms of CPU each): at
16 concurrent clients it saturates the machine's cores (770 req/s) and the
p99 is queueing, not the query; 8 concurrent admin node pages stay at 11 ms.
Node and fleet charts read `traffic_node_daily` (one row per node per day);
only the top-users list touches `traffic_daily` (index `(node_id, day)`).

Reproduce: `make bench-seed` (now also seeds `--history-days 30
--history-nodes-per-user 2`), `make bench`, then the panel on the bench set
and `akari-bench http --only traffic_user,traffic_user_nodes,traffic_node,traffic_summary,traffic_me`;
`akari-bench explain` includes `COMPACT_SQL` and `ROLLUP_SQL`.

## Admin dashboard and user search (W21, 2026-10-03)

`GET /dashboard` (src/dashboard.rs) is one aggregate read in a REPEATABLE READ snapshot; `GET
/users` gained search (`q`, login/email prefix), filters (`status`, `plan_id`, `role`), sorts and a
`total`. Measured on the bench stack (own database `akari_bench_w21`: `make bench-seed` = 200 nodes,
50k users, 2M node_users, 200k audit rows; plus 200k paid orders spread over a year (2 % refunded)
and 10k expired ones, inserted with SQL), `akari-bench http` 16 closed-loop clients × 10 s, idle
panel (no agents), three runs, while another worker's e2e ran on the same machine:

| Scenario | p50 | p99 (runs 1 / 2 / 3) | req/s |
|---|---|---|---|
| `dashboard` | 10.8–11.8 ms | 20.6 / 16.8 / 15.7 ms | 1286–1439 |
| `users_search` (`q=bench-user-123`, ~100 matches + total) | 4.6–5.0 ms | 30.8 / 6.6 / 8.2 ms | 2413–3413 |
| `users_filtered` (`status=active&role=user&sort=-traffic`) | 12.7–14.1 ms | 22.3 / 55.2 / 18.4 ms | 935–1219 |
| `users_page1` (reference) | 6.0–6.5 ms | 11.6 / 9.7 / 9.5 ms | 2336–2561 |

The first dashboard version took p99 45–139 ms: two separate scans of users (the sign-up windows
and the total) and heap fetches for 16.5k revenue rows. Now users are counted in one pass and the
revenue/refund windows are index-only scans (`orders_paid_at` / `orders_refunded_at` INCLUDE the
amounts, 0125). The users-table pass (~5–10 ms at 50k) is the floor of the endpoint;
`users_filtered` sorts all matching users by traffic (`traffic_used_bytes` must stay unindexed:
billing updates are HOT, 0012) and its one noisy run is the concurrent e2e. Reproduce:

```bash
BENCH_DATABASE_URL=postgres://akari:akari-dev@localhost:5433/akari_bench_w21 make bench-seed
# orders: see the W21 PR (INSERT … generate_series(1, 200000), then VACUUM ANALYZE orders)
akari -c <panel.toml on akari_bench_w21> serve &
akari-bench http --data-dir <its data dir> --url <its url> --only dashboard,users_search,users_filtered,users_page1
```

## Node list summary view (W17, 2026-10-02)

W14 left `GET /nodes` borderline under 200 reporting agents (p99 47–55 ms, a 480 KB body). W17
adds `GET /nodes?view=summary` — the list's columns only: no inbounds JSON, no full latency set
(the best agent result), the heartbeat cut to CPU/memory/connections/rates/online users, no
per-second `lease_remaining_seconds` — with a strong ETag (`If-None-Match` → empty 304) on both
views. The console's list, the plan editor's and the rollout form's node pickers read it; the node
page fetches `GET /nodes/{id}`.

Same machine and method as W14 (bench stack, `make bench-seed` into its own database
`akari_bench_w17`, 系统设置 main domain set, 200 swarm agents × 10k users, heartbeats with W11
machine metrics, `http` 16 closed-loop clients 80 s into a 150 s swarm with 40 timed changes).
`nodes_etag` replays the browser: every request carries the last ETag (a 304 while nothing
changed). Three loaded runs:

| Scenario | idle p99 | 200 agents p99 (runs 1 / 2 / 3) | req/s under load | body under load |
|---|---|---|---|---|
| `nodes` (full) | 12.1 ms | 43.3 / 29.6 / 26.7 ms | 759–827 | 480 KB |
| `nodes_summary` | 10.2 ms | 26.2 / 12.8 / 11.9 ms | 1612–1929 | 180 KB |
| `nodes_etag` (revalidated) | 9.9 ms | 25.5 / 11.9 / 11.5 ms | 1661–2025 | 0 (304) or 180 KB |
| `users_deep` (reference) | — | 37.4 / 16.1 / 15.7 ms | 1796–2155 | — |

Verdict: the console's list now meets the admin target with a wide margin (worst loaded p99
26 ms against 50 ms; run 1 was noisier for every scenario, `users_deep` included). Throughput
of the list doubled (the 480 KB serialization was the ceiling). The revalidated request still
builds the body to hash it (no server-side cache: the heartbeat data changes every 15 s), so its
gain is the bytes on the wire and the browser's parse, not server time. Billing stayed exact and
change-to-agent p99 0.76 s in the same runs.

## Re-verification 2026-10-02 (W14, after W5/W7/W9/W11/W12)

Same machine and method as below (bench stack, `make bench-seed`, 200 swarm agents x 10k users,
`http` 16 closed-loop clients, the loaded `http` run starting 80 s into a 150 s swarm with 40 timed
changes). New in the load since M2: the 系统设置 Host gate is active (main domain set in
`panel_settings`), every swarm heartbeat carries W11 machine metrics (the `node_metrics_1m`
upserts), the user-set read LEFT JOINs the plan speed limit (W7), the node list carries
heartbeat/latency/group/rollout fields. Host caveat: 15 GiB shared with other work, swap full
during the swarm runs, so every loaded number is an upper bound.

| §0 target | M2 (PERF below) | W14 first run | W14 after fixes | Verdict |
|---|---|---|---|---|
| Snapshot build, 10k users < 200 ms | 33 / 43 ms | `db/desired_snapshot` 42.6 ms, `db/snapshot_build_full` 52.6 ms | (unchanged) | pass (W7 join + newer fields: +10 ms) |
| Flush 50k rows < 1 s | 0.91 s (M2), 0.49 s (W11) | 0.477 s | (unchanged) | pass, 52% margin |
| Admin API p99 < 50 ms, idle | worst read 10.2 ms (`nodes`) | `nodes` 20.1 ms; worst write `user_patch` 24.5 ms | `nodes` 12.6 ms; `user_patch` 23.3 ms | pass |
| Admin API p99 < 50 ms, 200 agents | worst read 30.5 ms (`users_deep`) | `nodes` 58.2 / 61.3 ms | `nodes` 47–55 ms (4 runs: 49.9, 54.6, 47.5, 49.3), `users_deep` 35.8 ms | **borderline** (`nodes`, see below) |
| Subscription p99 < 30 ms | 5.1 idle / 16.7 load / 31 balancer | 5.5 / 15.4 | 5.3 idle / 16.4–17.0 load / 28.0 (`clash`), 11.2 (`links`) balancer | pass |
| User change → agent < 2 s | p99 0.59 s, max 0.68 s | **p99 1.86 s, max 2.01 s** | p99 0.75 s, max 0.96 s (balancer: p99 0.55 s, max 0.79 s) | pass after fix |
| Billing exact | exact | exact | exact (every run, single and two instances) | pass |
| `akari-bench multi` | all pass | — | all pass | pass |

**Fix 1 — change-to-agent tail (grpc.rs).** Every session re-read its node's full desired state
on a 60 s reconcile tick whose phase was the session start, so agents that connected together (all
of them after a panel restart, and the swarm) reconciled in lockstep: ~200 reads of 10k users
queued on the 8 read permits once a minute, and a change landing in that burst waited behind
them (max 1.36 s without HTTP load, 2.01 s with it). The tick's phase is now random per
session; the period, the lease renewal and the notification path are unchanged.

**Fix 2 — node list query (api.rs).** `NODE_VIEW_COLS` ran five correlated subqueries per node
(enrollment, groups, latency, rollout, speed-limit check); four are now joins against
per-table aggregates (`NODE_VIEW_FROM`): 4.4 → 2.6 ms for 200 nodes in PostgreSQL (single node
0.65 → 0.85 ms), and the heartbeat blobs are passed through as validated raw JSON instead of
being parsed into `Value`s and re-serialized. Idle `nodes` p99 20.1 → 12.6 ms (1157 → 1865 req/s).

**Remaining: `GET /nodes` under 200 reporting agents.** With the swarm connected the list is
480 KB (per node: inbounds JSON, latency, and the whole W11 heartbeat with machine metrics), and
16 clients fetching it back to back saturate at ~670 req/s; the p99 lands at 47–55 ms around
the 50 ms line. It is a throughput ceiling of a closed loop, not a slow query: at 4 clients the
same load gives p99 34 ms, and a single admin console polls it every few seconds. The real
fix is a slimmer list (machine metrics and inbound JSON only on the node page, or paging),
a UI change left for a follow-up. Writes under saturation (`user_patch`, 16 clients at
~530/s) stay what M2 recorded: not an admin-rate scenario (p99 130–200 ms, each patch locks the
user's ~40 nodes behind flush chunks).

Criterion (same run): `user_set` 3.34 ms, `state_hash` 1.12 ms, `diff_user_sets` 1.50 / 1.67 ms,
`snapshot_encode` 0.40 ms, `sub_render` 200 nodes clash/links/sing-box 0.60 / 0.63 / 1.26 ms,
`buffer/snapshot` 22 ms, `buffer/prune_idle` 33 ms, `buffer/prune_full` 0.60 s.

## Machine and stack

- Intel Core Ultra 7 265K (20 threads), 15 GiB RAM, WSL2 (Linux 6.18).
- PostgreSQL 18 (docker, `bench/compose.yml`): `shared_buffers=2GB`,
  `effective_cache_size=6GB`, `work_mem=16MB`, `max_wal_size=4GB`. Stock
  `postgres:18` (128 MB shared buffers) does not hold the 2M-row working set;
  DEPLOY.md recommends sizing PostgreSQL for it.
- Valkey 9, panel release build (static features as shipped, mimalloc),
  `pool max_connections = 16`.
- Agents: `akari-bench swarm` speaks the real mTLS gRPC protocol (enrollment,
  Hello, Snapshot/UserDelta, Ack, traffic reports, heartbeats); its agents run
  in one process, so one clock times everything.

## Methodology and reproduction

The benchmark crate lives in `bench/` (own workspace and lockfile, not in the
panel's dependency graph, never in the release binary).

```bash
make bench-up                    # dedicated PostgreSQL :5433 / Valkey :6380 (bench/compose.yml)
make bench-seed                  # 200 nodes, 50k users, 10k per node: ~60 s
akari-bench explain              # EXPLAIN (ANALYZE, BUFFERS) of every hot query, rolled back
make bench                       # criterion: pure CPU + DB benches (snapshot, flush)
akari -c bench/panel-bench-1.toml serve &                 # lifted rate limits, metrics on :19100
akari-bench http --concurrency 16 --seconds 10            # closed-loop HTTP latency (hdrhistogram)
akari-bench swarm --seconds 150 --changes 40 --report-all false
                                 # 200 fake agents x 10k users, 10 s traffic reports,
                                 # 2.5% of users with new traffic per report, 40 timed changes
                                 # (disable + re-enable = 80 propagations); prints convergence,
                                 # change-to-agent latency, billing exactness, final convergence
```

`swarm` notes: change-to-agent latency = PATCH sent until the op naming the user
reached every agent that serves it. For the under-load numbers the `http` run
starts 80 s into the swarm run (flush backlog drained, agents steady). The user
that `swarm` disables for a moment can make one subscription request fail
(404), which `http` counts as an error (one in 28k).

Two instances: `panel-bench-2.toml` + `akari-bench lb` (round-robin TCP
balancer for web and gRPC, TLS untouched, so mTLS identity reaches the panel as
without it), swarm and http through the balancer, then `akari-bench multi`.

CI: `.github/workflows/bench.yml` (manual) runs the criterion suite on the
seeded set and uploads `target/criterion`. Shared runners are noisy: use it for
trends (`--save-baseline` / `critcmp`), not for absolute targets. `bench-lint`
in ci.yml keeps the crate compiling against the panel library.

## Microbenchmarks (criterion, 10k users per node unless noted)

| Bench | Time |
|---|---|
| `user_set` (build the set from ops) | 3.3 ms |
| `state_hash` | 1.1 ms |
| `diff_user_sets` (1 changed / 10% changed) | 1.9 / 2.1 ms |
| `snapshot_encode` (protobuf) | 0.54 ms |
| `sub_render` clash / links / sing-box, 1 node | 5.2 / 5.5 / 8.2 us |
| `sub_render` clash / links / sing-box, 40 nodes | 90 / 108 / 199 us |
| `sub_render` clash / links / sing-box, 200 nodes | 428 / 498 / 986 us |
| `db/desired_snapshot` (REPEATABLE READ read + build) | 33.3 ms |
| `db/snapshot_build_full` | 43.1 ms |
| `db/flush`, 50k rows | 0.907 s (M2) → **0.49 s** (W11, see below) → 0.58 s (W22, traffic history staged; see "W22") |
| `db/compact`, 50k staged rows (W22, off the flush path) | 0.25–0.29 s |

## What changed to get there

- Flush SQL: removed the O(rows x nodes) joins; existing counter rows are
  plain `UPDATE`s (index probe each, `ON CONFLICT` only arbitrates new rows);
  updated rows carry their node/session columns out of the `UPDATE ... RETURNING`
  instead of re-joining; the departed-pair window aggregation runs only on
  departed rows; session tombstone inserts only for sessions not yet known;
  no-op insert stage is skipped when every row existed. 1.37 s -> 0.91 s.
- Chunked flush: 5000 rows per transaction, highest node ids first. Each chunk
  holds its nodes' and users' row locks for about 100 ms, so admin writes and
  change propagation wait for at most one chunk even when a restart makes every
  agent re-report millions of rows. Safe for billing: every row is idempotent
  and every cap (per-node GCRA, departed pair) is cumulative across
  transactions.
- Per-session user sets are kept as compact digests (a 200 x 10k run
  previously ran out of memory); read permits bound full-set loads.
- `mimalloc` as the global allocator (the shipped binary is static musl; its
  allocator serializes this allocation-heavy workload).
- Migration 0012: `users(created_at, id)` for the user list (deferred-join
  paging: page 1 0.2 ms, offset 49000 3.6 ms), fillfactor 85/80 on `users` and
  `traffic_counters` so billing updates are HOT. Do not index
  `traffic_counters.updated_at` or the counters: every billing update would
  stop being HOT.
- Audit filters (actor, action prefix) walk their `(column, id)` index.
- Users are locked in id order after nodes (global lock order) so two
  instances flushing nodes that share users cannot deadlock.

## W4-A9: flush-tick buffer maintenance (`make bench`, group `buffer`)

The 5 s flush tick used to run `TrafficBuffer::prune` (idle eviction plus a
full rebuild of the per-node index) and `snapshot` (a full walk of `entries`)
every time. Pure CPU, 200 nodes x 10k users = 2M entries, 2.5% dirty
(criterion, same machine as above; `prune` is noisy because it allocates 2M
set entries):

| Operation | Before (every 5 s) | After |
|---|---|---|
| `snapshot` (what to flush) | 64 ms (walk all 2M entries) | 27-30 ms (walks only the per-session dirty sets: cost follows the dirty rows) |
| `prune` | 1.1-3.5 s (mean about 2.2 s), holds shard write locks | `prune_idle` 46 ms every 60 s; full index rebuild (self-heal) 0.87-0.98 s every 15 min |

Per 5 s tick that is about 2.2 s of CPU before (the reason being a full
2M-entry index rebuild) against about 30 ms plus an amortised 4 ms after.
Idle eviction is unaffected in effect (entries only become evictable after
10 minutes). The index stays exact incrementally; the periodic rebuild is only
the self-heal.

## EXPLAIN highlights (`akari-bench explain`, rolled back)

Every hot query is index-driven or a single scan of a bounded set; the
`seq_scans` counts in the tool output are tiny tables (nodes, sessions, empty
`node_users_departed`).

| Query | Execution |
|---|---|
| `desired_state` users of a 10k-user node | 14 ms (join + sort of 10k rows) |
| `refresh_members` | 1.8 ms |
| enforcement candidates (over-limit / expiry) | 2.2 / 2.3 ms |
| `list_users` page 1 / offset 49000 | 0.2 / 3.6 ms |
| `list_nodes` (200 nodes) | 1.3 ms |
| audit list: first page / deep cursor / action prefix / actor | 0.04 / 0.04 / 0.22 / 0.06 ms |
| subscription user lookup / node list | 0.02 / 0.24 ms |
| login lookup (password hash excluded) | 0.2 ms |
| `AuthUser` session query | 0.03 ms |
| retention: `RETIRE_SQL` (1 node) / dead-node scan | 0.07 / 2.5 ms |
| `FLUSH_SQL`, 5000 rows: updates / all new rows | 84 ms / 177 ms |

Billing a chunk is about 17 us per row: node membership probe 2 us, counter
update 4 us, user update 5 us, the rest numeric cap arithmetic and sorts. New
rows (first report of a session) cost twice as much, so a restart storm where
every agent opens a new session with 10k users (2M new rows) drains in roughly
70 s; steady-state reports touch about 2.5% of the rows.

## M2-3: `AuthUser` per-request cost

`AuthUser` does one indexed query per request (session version, enabled,
expiry, TOTP state): 0.03 ms on the server; measured end to end about 0.4 ms
including pool checkout and the round trip (`/me` runs it twice: 1.0 ms vs
0.11 ms for `/healthz` with one client). A 16-connection pool sustains tens of
thousands of these per second, three orders of magnitude over admin traffic,
and the admin API p99 is far under target with it. **No cache was added**: the
current guarantee is that a revoked session (logout, password change, disable,
role change, `session_ver` bump) is refused on the very next request on every
instance (`akari-bench multi` asserts it), and any cache would turn that into
"within TTL". If it ever matters, the bound to document is the TTL (<= 1 s);
there is no cross-instance invalidation to rely on, so the TTL would be the
worst-case revocation delay.

## M2-4: multiple instances

Reference topology in DEPLOY.md ("Several panel instances"). Results of
`akari-bench multi` (instances A and B on one PostgreSQL and one Valkey):

- A session logged in on A works on B; logout on A ends it on B at once.
- Failed logins alternating A/B share one budget (20 failures, then 429 on both).
- The same agent identity on A then on B: B serves it; A's stream ends. A
  learns it was superseded on its next database read (change notification or
  the 60 s reconcile tick), so a stale stream can linger up to 60 s; billing is
  idempotent so this is harmless.
- Node deleted through A while its agent streams to B: B's agent gets the empty
  state within milliseconds, the reaper (any instance) deletes the node about
  10 s later, the stream is closed, a later connection with the revoked
  certificate gets the empty state and is closed.
- Swarm through the balancer (agents split across both instances): convergence
  2.0 s, billing exact, 200/200 final convergence, 0 BASE_MISMATCH, 0 flush
  failures on either instance.

Memory: one instance with 200 agents x 10k users reporting: 0.55 GiB steady,
1.5 GiB peak (the 200 initial snapshots, 2.3 MB each, are built together).

## M2-5: `traffic_counters` retention

`traffic_counters` is the billing baseline (`new - old`), so only provably dead
rows are deleted (migration 0013, `traffic::retention_pass`, run by the reaper
loop on any instance every 10 min, safe concurrently):

1. A session is retired (tombstone in `traffic_sessions`, which `FLUSH_SQL`
   honours: a late report of a retired session is dropped, never re-billed)
   only when its node has a drain proof at least 1 h old: a Hello whose stream
   stayed up 60 s while carrying `finals_drained_session`, proving the agent
   delivered the last report of every session it superseded before that
   Hello; and the session is not the agent's current one.
2. Rows of retired sessions are deleted in 10k-row batches; rows of deleted
   nodes likewise. Rows of a live session are never deleted, whatever their age.

Table size is therefore bounded by (live sessions + sessions of the last hour
+ one per node) x users per node. Measured on the bench set after several
swarm runs (margin lowered to 0 for the demonstration): 1194 sessions retired,
about 1M rows deleted in 3.3 s, `traffic_counters` 3.7M -> 2.7M rows.

## M2-6: agent overhead (Go benchmarks, 10k users x 2 inbounds)

`make bench` in akari-agent (`bench_test.go`), same machine:

| Operation | Time | Allocations |
|---|---|---|
| Snapshot = full xray rebuild, 10k users | 56.5 ms | 54 MB, 597k allocs |
| Heap held by a running 10k-user instance | 18.8 MB (build + GC: 98.8 ms) | |
| UserDelta rotating 1 of 10k users | 5.4 us | 59 |
| Traffic report (every user has counters) | 2.5 ms per 10 s = 0.025% of one core | 2.6 MB |
| State hash over 20k credentials (Hello, every Ack) | 7.6 ms | 9.9 MB |
| Gate admit + release per proxied connection | 249 ns (parallel) | 2 |
| Heartbeat connection count with 5k live dispatches | 24.7 us per 15 s | 0 |

Verdict: nothing in the agent's loops matters at 10k users. The costs worth
knowing are the 57 ms rebuild (which drops every connection on the node, the
reason deltas exist) and the state hash allocating 10 MB per Ack. No agent
optimization was made.

**W7 speed limits** (`ratelimit.go`, same benchmarks): unlimited users are
never wrapped — their only added cost is one map lookup inside `admit`,
under the lock it already takes; `BenchmarkGateAdmitRelease` before/after
is within run-to-run noise (263–500 ns vs 280–398 ns parallel, 2026-10-02,
20 threads). A limited user's dispatch pays one bucket reservation per
buffer: `BenchmarkLimitedWrite8k` 129 ns per 8 KiB chunk including the
buffer allocation (> 60 GB/s of headroom, 3 allocs of which 2 are the test's
buffer). Throttling accuracy (real xray, raw VLESS): 768 KiB at 512 KiB/s
took 1.303 s for an expected 1.300 s down and up; Vision over TLS (splice
path) 3 MiB at 1 MiB/s took 2.809 s for 2.800 s (`ratelimit_test.go`,
`ratelimit_canary_test.go`).

**W7 panel side**: `desired_state` now LEFT JOINs each node user's active
plan for the speed limit: the user-set query for 10k users on one node went
from 4.7 ms to 7.9 ms (EXPLAIN ANALYZE, dev PG 18, 2026-10-02), about +3 ms
on the ~43 ms snapshot build. Per-user digests hash 12 more bytes only for
limited users.

**W11 (traffic multiplier, node totals; 2026-10-02, same machine, A/B
interleaved runs on the reseeded bench set):**

| `db/flush`, 50k rows | time |
|---|---|
| main before W11 | 0.902 / 0.924 / 0.915 s |
| main + `nf AS MATERIALIZED` only | 0.455 s |
| W11 (`MATERIALIZED` + multiplier `charged` CTE + raw/billed node totals) | 0.485 / 0.494 / 0.491 s |

The multiplier is one more CTE (`charged`: a hash join of the scaled rows with
the per-node CTE `nf`, floor(billed × permille / 1000)) and two more columns in
the per-node `UPDATE nodes` the flush already ran (`traffic_raw_bytes`,
`traffic_billed_bytes`): about +30 ms (6%). Referencing `nf` twice made
PostgreSQL materialize it instead of inlining it into `classified`, which
halves the statement (the inlined form re-planned the node lookup per input
row); it is now written `MATERIALIZED` explicitly so the plan does not depend
on how often the CTE is referenced. Net: 0.91 s → 0.49 s, margin to the 1 s
budget ~51%.

**W11 machine-status history**: one upsert per node per heartbeat into the
node's current minute (`node_metrics_1m`, sums + maxima, fillfactor 70 for
HOT updates), throttled to one per node per 5 s and skipped when 8 writes are
already in flight on the instance. At 200 nodes and the 15 s default that is
~13 small upserts/s; the rollup into hours re-sums the last ~3 hours of minute
rows every 10 minutes (≤ 200 × 180 rows) under an advisory try-lock, and
retention deletes in 10k-row batches. `akari-bench swarm` agents send metrics
in their heartbeats, so the swarm numbers include this load.

## Limits and honest caveats

- Flush margin (W22): 0.58 s against the 1 s budget (W11: 0.49 s) for 50k rows; on a slower
  disk or a busier PostgreSQL the flush still degrades gracefully (chunking
  bounds lock hold to one chunk), only how long a backlog takes to drain.
- If the database stalls for longer than the burst window while agents keep
  reporting, per-node caps clamp the delayed traffic (under-billing, never
  over-billing). Observed once, on this machine, when the host's disk stalled
  PostgreSQL for several seconds during a 2M-row restart storm; this is the
  documented bound (R13), not a defect, but a slow backlog drain widens it.
- `LISTEN/NOTIFY` needs a direct PostgreSQL connection (no transaction-mode
  pooler).
