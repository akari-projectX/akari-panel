# Performance and scale (M2)

Targets (ROADMAP §0), measured on the data set of one panel instance serving
200 nodes / 50k users / 10k users on every node (2M `node_users` rows, 2M
`traffic_counters` rows). Everything here is reproducible with `bench/`.

## Results against the targets

| Target | Measured | Verdict |
|---|---|---|
| Snapshot build, 10k-user node < 200 ms | DB read + build 33 ms; full build (read + user set + state hash + encode) 43 ms; agent side: xray rebuild with 10k users 57 ms | pass |
| Flush of 50k traffic rows < 1 s | 0.91 s (criterion mean; 10 chunks of 5000, about 91 ms each) | pass, 9% margin |
| Admin API p99 < 50 ms | idle, 16 clients: worst endpoint 10.2 ms (`nodes`); under 200-agent load: worst read 30.5 ms (`users_deep`) | pass |
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
| `db/flush`, 50k rows | 0.907 s |

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

## Limits and honest caveats

- Flush margin is 9%: on a slower disk or a busier PostgreSQL the 50k-row flush
  will exceed 1 s. That does not affect correctness (chunking bounds lock hold
  to one chunk), only how long a backlog takes to drain.
- If the database stalls for longer than the burst window while agents keep
  reporting, per-node caps clamp the delayed traffic (under-billing, never
  over-billing). Observed once, on this machine, when the host's disk stalled
  PostgreSQL for several seconds during a 2M-row restart storm; this is the
  documented bound (R13), not a defect, but a slow backlog drain widens it.
- `LISTEN/NOTIFY` needs a direct PostgreSQL connection (no transaction-mode
  pooler).
