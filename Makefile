AGENT_DIR ?= ../akari-agent

.PHONY: dev-up dev-down spa panel agent-build check smoke

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
