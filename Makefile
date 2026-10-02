AGENT_DIR ?= ../akari-agent

.PHONY: third-party bench-up bench-down dev-up dev-down spa panel agent-build check smoke e2e lint test deny ci bench bench-seed bench-lint

dev-up:
	docker compose up -d --wait

dev-down:
	docker compose down

spa:
	cd spa && npm ci && npm run build

panel:
	cargo build --release

agent-build:
	$(MAKE) -C $(AGENT_DIR) build

check:
	cargo fmt --check && cargo clippy -- -D warnings
	cd spa && npx tsc --noEmit && npm run lint && node scripts/check-auth-paths.mjs && npx vitest run

# Playwright end-to-end against a real panel (release build, real CSP) on its
# own database / Valkey index / data dir / port 8090 (does not touch smoke's).
# Needs `make dev-up` and `npx playwright install chromium` once.
e2e: dev-up spa panel
	./scripts/e2e.sh

# Smoke isolation (parallel checkouts): SMOKE_DB=<name> runs against its own
# Postgres database and Valkey db index (SMOKE_VALKEY_DB to override); default
# "akari" = db index 0. Serialise runs on the shared ports (flock) and set
# COMPOSE_PROJECT_NAME to the shared compose project.
#   SMOKE_DB=akari_w4 COMPOSE_PROJECT_NAME=akari-panel make smoke   (AGENT_DIR=<agent checkout>)
smoke: dev-up spa panel agent-build
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
# bundled into the embedded SPA, with their licence texts), the notice that
# ships with releases: target/THIRD_PARTY_LICENSES.txt. Needs `cargo fetch`
# (crate sources) and, for npm licence texts, `npm ci` in spa/.
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
