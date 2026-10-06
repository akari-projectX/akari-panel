AGENT_DIR ?= ../akari-agent

FUZZ_SECS ?= 30

.PHONY: shellcheck gen-protocols check-generated monitoring-check fuzz fuzz-lint coverage third-party bench-up bench-down dev-up dev-down spa admin panel agent-build check smoke e2e lint test deny ci bench bench-seed bench-lint

dev-up:
	docker compose up -d --wait

dev-down:
	docker compose down

spa:
	cd spa && npm ci && npm run build

# W33-b: the admin app (sign-in page + console), its own build (admin/dist).
admin:
	cd admin && npm ci && npm run build

panel:
	cargo build --release

agent-build:
	$(MAKE) -C $(AGENT_DIR) build

check: check-generated shellcheck
	cargo fmt --check && cargo clippy -- -D warnings
	cd spa && npm run check
	cd admin && npm run check

# Every shell script (installer, backup/restore, smoke, test drivers, the
# node installer templates). smoke.sh predates the gate: warnings and
# errors only there; everything else at full strictness. CI job shellcheck.
# Then the installer's input validators under this machine's sh and grep.
SHELL_SCRIPTS = scripts/*.sh scripts/installer-test/*.sh fuzz/run.sh src/nodeinstall.sh
shellcheck:
	@command -v shellcheck >/dev/null || { echo "shellcheck not installed (apt install shellcheck)"; exit 1; }
	shellcheck $(SHELL_SCRIPTS)
	shellcheck -s sh src/nodeinstall-uninstall.sh
	shellcheck -S warning smoke.sh
	sh scripts/installer-test/validators.sh

# W26: artifacts generated from proto/protocols.toml (docs/DEPLOY.md §3d
# matrix, the admin form schema). `gen-protocols` rewrites them after a
# manifest edit; `check-generated` (part of `make check`, and of
# `cargo test` in CI) fails when one is stale. Then sync the agent:
# `make -C ../akari-agent sync-proto`.
GEN_TEST = protocols::generate::tests::generated_artifacts_are_current
gen-protocols:
	AKARI_REGEN=1 cargo test --lib -q $(GEN_TEST) -- --exact

check-generated:
	cargo test --lib -q $(GEN_TEST) -- --exact

# Playwright end-to-end against a real panel (release build, real CSP) on its
# own database / Valkey index / data dir / port 8090 (does not touch smoke's).
# Needs `make dev-up` and `npx playwright install chromium` once.
e2e: dev-up spa admin panel
	./scripts/e2e-portal.sh
	./scripts/e2e.sh

# Smoke isolation (parallel checkouts): SMOKE_DB=<name> runs against its own
# Postgres database and Valkey db index (SMOKE_VALKEY_DB to override); default
# "akari" = db index 0. Serialise runs on the shared ports (flock) and set
# COMPOSE_PROJECT_NAME to the shared compose project.
#   SMOKE_DB=akari_w4 COMPOSE_PROJECT_NAME=akari-panel make smoke   (AGENT_DIR=<agent checkout>)
smoke: dev-up spa admin panel agent-build
	AGENT_DIR=$(AGENT_DIR) ./smoke.sh

# --- CI parity: .github/workflows/ci.yml runs exactly these ---------------
# `check` is the fast gate; `lint` adds test targets to clippy (CI's flags).
lint:
	cargo fmt --check && cargo clippy --all-targets -- -D warnings

# DB tests need `make dev-up` (they fail, not skip, when PG is unreachable;
# AKARI_SKIP_DB_TESTS=1 skips them locally).
test:
	cargo test --locked

# Licenses / advisories / bans / sources (deny.toml). `cargo install cargo-deny`.
deny:
	cargo deny check

ci: lint test deny check

# Third-party licences of the binary (Rust crates linked + npm packages
# bundled into the embedded portal and admin app, with their licence texts),
# the notice that ships with releases: target/THIRD_PARTY_LICENSES.txt. Needs
# `cargo fetch` (crate sources) and, for npm licence texts, `npm ci` in spa/
# and admin/.
third-party:
	cargo fetch --locked
	python3 scripts/third-party.py

# --- M2 benchmarks and load tooling (bench/, docs/PERF.md) ----------------
# Own crate and lockfile: nothing here reaches the release binary. DB
# benches need the bench stack (bench/compose.yml: PostgreSQL :5433, Valkey
# :6380, never the dev stack) and its seeded database.
# Run from the repo root: CARGO_TARGET_DIR pins the shared target dir (cargo
# reads bench/.cargo/config.toml only when invoked from bench/), and the
# tools' default paths (bench/data) are root-relative.
bench-up:
	docker compose -f bench/compose.yml up -d --wait

bench-down:
	docker compose -f bench/compose.yml down -v

bench-seed:
	CARGO_TARGET_DIR=target cargo run --release --manifest-path bench/Cargo.toml -- seed --reset

bench:
	CARGO_TARGET_DIR=target cargo bench --manifest-path bench/Cargo.toml --bench panel

bench-lint:
	cd bench && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings

# --- Fuzzing (fuzz/, own lockfile; cargo-fuzz + pinned nightly) ------------
# `cargo install cargo-fuzz` once. Every target FUZZ_SECS seconds on its
# seeds + local corpus; crashes land in fuzz/artifacts/<target>/. See
# docs/FUZZING.md. The library is built with --cfg fuzzing (src/fuzzing.rs).
fuzz:
	cd fuzz && ./run.sh $(FUZZ_SECS)

fuzz-lint:
	cd fuzz && cargo fmt --check && RUSTFLAGS="--cfg fuzzing" cargo clippy --all-targets --locked -- -D warnings

# --- Billing-core coverage gate (CI job `coverage`) ------------------------
# `cargo install cargo-llvm-cov` + `rustup component add llvm-tools-preview`;
# needs `make dev-up` (real-database tests count).
coverage:
	cargo llvm-cov --locked --lcov --output-path target/cov.lcov
	scripts/coverage-gate.py target/cov.lcov

# W17: Prometheus rules (promtool check + unit tests) and Grafana dashboards
# reference only exported metrics (docker; CI docker job runs it).
monitoring-check:
	./scripts/monitoring-check.sh
