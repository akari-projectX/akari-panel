AGENT_DIR ?= ../akari-agent

.PHONY: dev-up dev-down spa panel agent-build check smoke lint test deny ci bench bench-seed bench-lint

dev-up:
	docker compose up -d --wait

dev-down:
	docker compose down

spa:
	cd spa && npm install && npm run build

panel:
	cargo build --release

agent-build:
	$(MAKE) -C $(AGENT_DIR) build

check:
	cargo fmt --check && cargo clippy -- -D warnings
	cd spa && npx tsc --noEmit && node scripts/check-auth-paths.mjs

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

# --- M2 benchmarks and load tooling (bench/, docs/PERF.md) ----------------
# Own crate and lockfile: nothing here reaches the release binary. DB
# benches need the seeded bench database (its own database, akari_bench).
# Run from the repo root: CARGO_TARGET_DIR pins the shared target dir (cargo
# reads bench/.cargo/config.toml only when invoked from bench/), and the
# tools' default paths (bench/data) are root-relative.
bench-seed:
	CARGO_TARGET_DIR=target cargo run --release --manifest-path bench/Cargo.toml -- seed --reset

bench:
	CARGO_TARGET_DIR=target cargo bench --manifest-path bench/Cargo.toml --bench panel

bench-lint:
	cd bench && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings
