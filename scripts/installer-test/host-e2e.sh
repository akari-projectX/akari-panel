#!/usr/bin/env bash
# Installer end-to-end test on a whole (throw-away) host: the CI runner
# (job installer-host; docs/DEPLOY.md "Installer tests"). Run as root.
#
#   host-e2e.sh RELEASES_DIR NEW_TAG AGENT_BIN [PREV_TAG]
#
# 1. Docker mode: install PREV_TAG (v0.3.x) from GitHub (keyless cosign,
#    ghcr image) -> login -> the upgrade to NEW_TAG is refused untouched
#    (v0.4 baseline: fresh install only) -> purge -> install NEW_TAG (local
#    release, image in a local registry) -> login -> uninstall --purge.
#    Without PREV_TAG: install NEW_TAG directly.
# 2. Bare metal -> Docker -> bare metal on the same host: install NEW_TAG
#    bare, enroll a real agent (AGENT_BIN), create a user; `akari-ctl
#    migrate --to docker`, then `--to bare`; after each move: healthz, same
#    prefix, admin login, the SAME agent reconnects (no re-enrollment), the
#    same subscription link answers.
#
# myapp.test must resolve to 127.0.0.1 (/etc/hosts); Caddy uses local_certs.
# PARTS=docker|migrate|all (default all) runs a part only.
set -euo pipefail
# The CI job exports the dev stack's DATABASE_URL/VALKEY_URL for every step;
# the panel CLI would let them override /etc/akari/panel.toml.
unset DATABASE_URL VALKEY_URL

rel=$(cd "${1:?usage: host-e2e.sh RELEASES_DIR NEW_TAG AGENT_BIN [PREV_TAG]}" && pwd)
new=${2:?}
agent_bin=$(readlink -f "${3:?}")
prev=${4:-}
root=$(cd "$(dirname "$0")/../.." && pwd)
pw="e2e-Admin-Pass-$(date +%s)"
work=$(mktemp -d)
origin=https://myapp.test
log() { printf '\n\033[1;36m### %s\033[0m\n' "$*"; }
fail() {
	printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2
	tail -n 60 /var/log/akari-install.log >&2 || true
	journalctl -u akari-panel -n 30 --no-pager -o cat >&2 || true
	[ ! -d /opt/akari ] || (cd /opt/akari && docker compose logs --no-color --tail 30 panel) >&2 || true
	tail -n 30 "$work/agent.log" >&2 2>/dev/null || true
	exit 1
}
agent_pid=
cleanup() {
	[ -z "$agent_pid" ] || kill "$agent_pid" 2>/dev/null || true
	rm -rf "$work"
}
trap cleanup EXIT

grep -q 'myapp.test' /etc/hosts || echo '127.0.0.1 myapp.test' >>/etc/hosts

export AKARI_ADMIN_PASSWORD=$pw AKARI_SOURCE_DIR=$root LANG=C.UTF-8
local_rel() { env AKARI_RELEASES_URL="file://$rel" AKARI_COSIGN_KEY="$rel/cosign.pub" "$@"; }

prefix() { akari-ctl info | sed -n '1s|.*://[^/]*/\([^/]*\)/admin$|\1|p'; }
code() {
	local url=$1
	shift
	curl -sk --noproxy '*' -o "$work/last" -w '%{http_code}' "$@" "$url"
}
# The installer's default admin: admin@<domain> (v0.4 D1: the e-mail is the
# login). A v0.3.x panel (the refused-upgrade check) still takes {"login"}.
admin_email=admin@myapp.test
login() {
	[ "$(code "$origin/$1/auth/login" -c "$work/jar" -X POST -H 'Content-Type: application/json' \
		-d "{\"email\":\"$admin_email\",\"password\":\"$pw\"}")" = 200 ] ||
		[ "$(code "$origin/$1/auth/login" -c "$work/jar" -X POST -H 'Content-Type: application/json' \
			-d "{\"login\":\"$admin_email\",\"password\":\"$pw\"}")" = 200 ] || fail "admin login"
}
check_panel() {
	local p
	p=$(prefix)
	[ -n "$p" ] || fail "no prefix"
	[ "$(code "$origin/$p/healthz")" = 200 ] || fail "healthz through Caddy"
	[ "$(code "$origin/")" = 404 ] || fail "/ is not the plain 404"
	login "$p"
	akari-ctl status >/dev/null || fail "akari-ctl status"
	echo "ok: healthy, login ok"
}
node_online() {
	local p=$1 id=$2
	for _ in $(seq 90); do
		code "$origin/$p/api/v1/nodes?view=summary" -b "$work/jar" >/dev/null
		python3 - "$work/last" "$id" <<'PY' && return 0
import json, sys
nodes = json.load(open(sys.argv[1]))
nodes = nodes.get("nodes", nodes) if isinstance(nodes, dict) else nodes
sys.exit(0 if any(n["id"] == sys.argv[2] and n.get("online") for n in nodes) else 1)
PY
		sleep 2
	done
	return 1
}

parts=${PARTS:-all}

# --- 1. Docker mode: refused v0.3 upgrade, install --------------------------------------------
if [ "$parts" = migrate ]; then
	:
else
	if [ -n "$prev" ]; then
		# v0.4 squashed the v0.3.x migrations (1000_baseline): the upgrade
		# must be refused before anything changes; then purge.
		log "docker: install $prev from GitHub"
		sh "$root/scripts/install.sh" --yes --mode docker --version "$prev" --domain myapp.test --local-certs || fail "docker install $prev"
		check_panel
		img_before=$(grep '^AKARI_IMAGE=' /opt/akari/.env)
		log "docker: upgrade $prev -> $new must be refused"
		if local_rel akari-ctl upgrade --yes --version "$new" >"$work/refused.log" 2>&1; then
			cat "$work/refused.log"
			fail "the docker upgrade from $prev was not refused"
		fi
		cat "$work/refused.log"
		grep -q 'fresh install required; see docs/DEPLOY.md' "$work/refused.log" || fail "no clear refusal message"
		ls -d /var/backups/akari/akari-* >/dev/null 2>&1 && fail "the refused upgrade made a backup"
		[ "$(grep '^AKARI_IMAGE=' /opt/akari/.env)" = "$img_before" ] || fail ".env changed by the refused upgrade"
		check_panel
		echo "ok: docker upgrade from $prev refused cleanly"
		akari-ctl uninstall --yes --purge --confirm purge || fail "docker purge $prev"
	fi
	log "docker: install $new"
	local_rel sh "$root/scripts/install.sh" --yes --mode docker --version "$new" --domain myapp.test --local-certs || fail "docker install $new"
	P0=$(prefix)
fi
if [ "$parts" != migrate ]; then
check_panel
grep -q "^AKARI_IMAGE=.*:${new#v}@sha256:" /opt/akari/.env || fail ".env does not pin the new image by digest"
[ "$(stat -c %a /opt/akari/.env)" = 600 ] || fail ".env is not 0600"
[ "$(stat -c %a /opt/akari/env/panel.env)" = 600 ] || fail "env/panel.env is not 0600"
grep -qF -e "$pw" -e "$P0" /var/log/akari-install.log && fail "a secret is in the install log"
log "docker: uninstall --purge"
akari-ctl uninstall --yes --purge --confirm purge || fail "docker purge"
docker volume ls -q | grep -q '^akari_' && fail "volumes left after purge"
echo "ok: docker install/purge"
fi
[ "$parts" != docker ] || { log "PASS: docker part"; exit 0; }

# --- 2. bare -> docker -> bare with a live agent --------------------------------------
log "bare: install $new"
local_rel sh "$root/scripts/install.sh" --yes --mode bare --version "$new" --domain myapp.test --local-certs || fail "bare install"
check_panel
P=$(prefix)

log "agent: enroll and connect"
(cd / && runuser -u akari -- akari -c /etc/akari/panel.toml node add e2e-node --out -) >"$work/bootstrap.toml" 2>/dev/null ||
	fail "node add"
chmod 600 "$work/bootstrap.toml"
NODE_ID=$(cd / && runuser -u akari -- akari -c /etc/akari/panel.toml node list | awk '$2 == "e2e-node" { print $1 }')
[ -n "$NODE_ID" ] || NODE_ID=$(cd / && runuser -u akari -- akari -c /etc/akari/panel.toml node list | awk 'NR == 2 { print $1 }')
"$agent_bin" -config "$work/bootstrap.toml" -state-dir "$work/agent-state" >"$work/agent.log" 2>&1 &
agent_pid=$!
node_online "$P" "$NODE_ID" || fail "the agent did not come online"
echo "ok: node $NODE_ID online"

[ "$(code "$origin/$P/api/v1/users" -b "$work/jar" -X POST -H 'Content-Type: application/json' \
	-d '{"email":"e2e-user@myapp.test","password":"user-password-123"}')" = 201 ] || fail "create user"
SUB=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['sub_token'])" "$work/last")
[ "$(code "$origin/$P/sub/$SUB" -A clash.meta)" = 200 ] || fail "subscription"
cert_before=$(sha256sum "$work/agent-state/identity.pem" | cut -d' ' -f1)

for to in docker bare; do
	log "migrate --to $to"
	local_rel akari-ctl migrate --to "$to" --yes || fail "migrate to $to"
	grep -q "^MODE=$to\$" /etc/akari/install.env || fail "install.env does not say $to"
	check_panel
	[ "$(prefix)" = "$P" ] || fail "prefix changed by the move to $to"
	node_online "$P" "$NODE_ID" || fail "the agent did not reconnect after the move to $to"
	[ "$(code "$origin/$P/sub/$SUB" -A clash.meta)" = 200 ] || fail "subscription after the move to $to"
	[ "$(sha256sum "$work/agent-state/identity.pem" | cut -d' ' -f1)" = "$cert_before" ] ||
		fail "the agent re-enrolled (identity changed)"
	if [ "$to" = docker ]; then
		systemctl is-active akari-panel.service >/dev/null 2>&1 && fail "the bare panel still runs"
	else
		(cd /opt/akari && docker compose ps -q panel | grep -q .) && fail "the docker panel still runs"
	fi
	echo "ok: moved to $to: same prefix, agent reconnected without re-enrolling, subscription ok"
done

log "cleanup"
akari-ctl uninstall --yes --purge --confirm purge || fail "purge"
(cd /opt/akari 2>/dev/null && docker compose down -v) >/dev/null 2>&1 || true
log "PASS: host installer e2e (docker install + refused v0.3 upgrade, bare <-> docker migration with a live agent)"
