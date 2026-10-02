# Fuzzing and the billing-core coverage gate

ROADMAP §0 exit criteria: "关键解析器做 fuzz" and "计费核心路径覆盖率 ≥ 90%".
This file covers both for the panel; the agent's counterparts are in
`akari-agent` (`fuzz_test.go`, `release/fuzz_test.go`, `make fuzz`,
`make cover`).

## Fuzz targets (`fuzz/`)

cargo-fuzz (libFuzzer). `fuzz/` is its own crate with its own lockfile and
pinned nightly (`fuzz/rust-toolchain.toml`): libfuzzer-sys never reaches the
release binary, the Docker build or `cargo deny`. cargo-fuzz builds the
library with `--cfg fuzzing`, which compiles `src/fuzzing.rs` (entry points
for crate-private parsers) and `traffic::introspect`; neither exists in any
other build. Debug assertions and overflow checks are on (cargo-fuzz's
default build), as is AddressSanitizer.

Every target asserts invariants, not only "no panic":

| target | input (who controls it) | invariants |
|---|---|---|
| `alipay_notify` | notify form body (anyone on the internet) | decoder is canonical (re-encode → same map), ≤ 64 params, no duplicates; nothing verifies without Alipay's key; a map Alipay signed (either empty-value convention) verifies after the wire round trip; tampering with any signed non-empty value, or `sign_type` ≠ RSA2, fails |
| `alipay_response` | gateway response bytes | an unsigned/forged body is never accepted; a body signed over the exact raw `<method>_response` text is accepted iff `code` = 10000 and yields that text parsed; any change inside the signed text → `BadSignature` |
| `inbounds` | admin inbounds JSON | verdict deterministic; accepted ⇒ every inbound passes `check_inbound`, no port clash, no object (any depth) with keys equal under Go's case folding (W14), issuable ones get an account that needs no refit, all three subscription formats render (sing-box is valid JSON) |
| `node_templates` | template request (admin) | whatever renders is accepted by `validate_inbounds`; rendered managed inbounds are issuable; no TCP inbound on a taken port |
| `client_ip` | peer, trusted CIDRs, Cloudflare CIDRs, headers (attacker headers) | untrusted peer ⇒ the peer; the answer is the peer, an X-Forwarded-For hop or CF-Connecting-IP; CF-Connecting-IP never matters without Cloudflare trust; `Cidr` Display round-trips and contains its network |
| `domain` | system-settings domain (admin), Host header (attacker), CF range list | accepted domain is ASCII/lowercase/≤ 253/no trailing dot, re-parses from its authority **and from its Unicode display** (what the console sends back), and `request_host` of its authority is exactly the stored host (the Host gate admits it) |
| `csr` | enrollment/renewal CSR (unauthenticated peer) | raw DER and byte-patched valid CSRs: accepted only if rcgen agrees on a P-256 key, and a patched CSR is never accepted with another key; > 4 KiB never accepted |
| `updates` | release manifest, signature file, `release_keys`, versions (admin; the agent re-verifies) | manifest round-trips; version order is reflexive, antisymmetric, transitive; a signature verifies for its exact bytes and key id only |
| `agent_messages` | `AgentUp` protobuf from a node (compromised node) | sequences of traffic reports / flush / prune / membership changes keep the traffic buffer's index equal to its entries; counters never decrease while unpersisted; non-members and unknown nodes never get entries; the heartbeat blob is JSON with clamped numbers and bounded, control-free agent text |
| `json_bodies` | 23 request bodies with `deny_unknown_fields`, request paths | a body that parses stops parsing once an unknown member is added; `redacted_path` always replaces the prefix segment and a sub/install token segment; token shape checks are exactly 43 base64url characters |

Curated seeds (including every crash found, as `regress-*`) are committed
under `fuzz/seeds/<target>/`; the grown corpus lives in `fuzz/corpus/`
(gitignored; CI keeps it in the Actions cache).

```bash
cargo install cargo-fuzz          # once (0.13)
make fuzz FUZZ_SECS=600           # every target 10 min (fuzz/run.sh)
cd fuzz && ./run.sh 60 csr domain # some targets
make fuzz-lint                    # fmt + clippy of the fuzz crate
```

A crash leaves its input in `fuzz/artifacts/<target>/`; reproduce with
`cd fuzz && cargo fuzz run <target> artifacts/<target>/<file>`. Fix it,
add a unit test at the bug, and move the input to `seeds/<target>/regress-*`.

### CI (`.github/workflows/fuzz.yml`)

- pull requests and pushes: every target 20 s (about 4 min of fuzzing plus
  the build) — catches regressions against the seeds and the cached corpus;
- nightly (03:47 UTC): every target 5 min (50 min);
- manual (`workflow_dispatch`): choose the seconds per target.

The corpus is restored from and saved to the Actions cache, so nightly runs
build on each other. A crash fails the job and uploads `fuzz/artifacts/`.

### Findings (W13, 2026-10-02)

| target | finding | fix |
|---|---|---|
| `domain` | a long IDN (Unicode form > 300 bytes, punycode ≤ 253) could not be saved back: the console sends the Unicode `display` and `Domain::parse` capped the input at 300 bytes | input bound raised to 1024 (the 253-byte ASCII limit is the real one); `settings::tests::long_idn_display_round_trips` |
| `agent_messages` | `Heartbeat.cert` domain/challenge/error went into the shared Valkey blob uncapped and with control characters (a compromised node could park ~4 MB per heartbeat) | `grpc::cert_status_json` passes every agent string through `nodestat::agent_text` (253/512/32); latency URLs with control characters are dropped |
| `node_templates` | templates rendered a tag the save refuses (`_x`, `akari-*`, `api`, duplicates) | `nodetpl::render` ends with `validate_inbounds` |

The coverage work also found that `traffic::db_tests::one_bad_row_does_not_poison_the_batch`
had stopped exercising the row-by-row retry after the per-node index
refactor (its planted row was invisible to `snapshot`); it now plants the
index entry too and asserts the path.

## Billing-core coverage gate (`scripts/coverage-gate.py`)

`cargo llvm-cov` over the full test suite **including the real-database
tests** (CI's `coverage` job has the same PostgreSQL/Valkey services as the
`rust` job), then line coverage per module counting production code only
(an inline `#[cfg(test)] mod … {` ends a file's production lines). The job
fails if any module drops below its threshold (90 %):

`traffic.rs`, `enforce.rs`, `entitle.rs`, `plans.rs`, `billing/orders.rs`,
`billing/catalog.rs`, `billing/api.rs`, `billing/alipay.rs`.

```bash
cargo install cargo-llvm-cov && rustup component add llvm-tools-preview
make dev-up && make coverage
```

The per-module table is printed in the job log and the job summary; the
lcov file is uploaded as an artifact. Thresholds only go up.
