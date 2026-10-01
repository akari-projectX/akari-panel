#!/usr/bin/env bash
# Backup/restore drill against the DEV stack (docs/BACKUP.md).
#
#   DESTROYS the dev database and flushes the dev Valkey. Development
#   machines only. Needs: make dev-up, a release build (make panel), the
#   agent binary (../akari-agent/agent), age + age-keygen, jq, curl.
#
# Flow: fresh install -> admin + user + node, agent online -> backup.sh ->
# stop panel, WIPE database and data dir (agent keeps running) -> restore.sh
# -> start panel: same route prefix, same logins and users, the (unchanged)
# agent reconnects and the node is online again.
set -euo pipefail
cd "$(dirname "$0")/.."

PANEL="${PANEL:-./target/release/akari}"
AGENT="${AGENT:-../akari-agent/agent}"
W="$(mktemp -d)"
PW=drill-admin-password-123
PANEL_PID=""
AGENT_PID=""
cleanup() {
  [ -z "$PANEL_PID" ] || kill "$PANEL_PID" 2>/dev/null || true
  [ -z "$AGENT_PID" ] || kill "$AGENT_PID" 2>/dev/null || true
  [ -n "${DRILL_KEEP:-}" ] || rm -rf "$W"
}
trap cleanup EXIT
fail() { echo "DRILL FAIL: $*" >&2; tail -n 20 "$W"/*.log 2>/dev/null >&2 || true; exit 1; }

psql_dev() { docker compose exec -T postgres psql -U akari -d akari -v ON_ERROR_STOP=1 -q "$@"; }
wipe_db() {
  psql_dev -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
  docker compose exec -T valkey valkey-cli flushall >/dev/null
}

cat >"$W/panel.toml" <<TOML
data_dir = "$W/data"
[web]
cookie_secure = false
TOML
export AKARI_ADMIN_PASSWORD="$PW"
p() { "$PANEL" -c "$W/panel.toml" "$@"; }
start_panel() {
  # exec: $! must be the panel itself (a backgrounded function would leave
  # an orphan that survives the kill and keeps the ports).
  ( exec "$PANEL" -c "$W/panel.toml" serve >>"$W/panel.log" 2>&1 ) &
  PANEL_PID=$!
  for _ in $(seq 1 30); do
    curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:8080/$PREFIX/healthz" && return 0
    sleep 1
  done
  fail "panel did not come up"
}
stop_panel() { kill -TERM "$PANEL_PID"; wait "$PANEL_PID" 2>/dev/null || true; PANEL_PID=""; }
api() { # api <jar> curl-args... (with $BASE)
  local jar="$1"; shift
  curl -s --noproxy '*' -b "$jar" -c "$jar" "$@"
}
login() { api "$W/jar" -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' -d "{\"login\":\"root\",\"password\":\"$PW\"}"; }

echo "== 1. fresh install: admin, user, node, agent online =="
wipe_db
PREFIX="$(p info | awk '/route prefix/{sub(/^\//,"",$3); print $3}')"
[ -n "$PREFIX" ] || fail "no route prefix"
BASE="http://127.0.0.1:8080/$PREFIX"
start_panel
p admin add root >/dev/null
[ "$(login)" = 200 ] || fail "login before backup"
[ "$(api "$W/jar" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/users" \
  -H 'Content-Type: application/json' -d '{"login":"alice","password":"alice-password-123"}')" = 201 ] \
  || fail "create user"
p node add drill-node --out "$W/boot.toml" >/dev/null
"$AGENT" -config "$W/boot.toml" >"$W/agent.log" 2>&1 &
AGENT_PID=$!
online() { api "$W/jar" "$BASE/api/v1/nodes" | jq -r '.[0].status'; }
for _ in $(seq 1 30); do [ "$(online)" = online ] && break; sleep 1; done
[ "$(online)" = online ] || fail "node never came online"
NODE_ID="$(api "$W/jar" "$BASE/api/v1/nodes" | jq -r '.[0].id')"
echo "prefix=$PREFIX node=$NODE_ID"

echo "== 2. backup =="
age-keygen -o "$W/age.key" 2>"$W/age.pub.txt"
RECIP="$(awk '/Public key:/{print $3}' "$W/age.pub.txt")"
AGE_RECIPIENT="$RECIP" AKARI_DATA_DIR="$W/data" AKARI_BACKUP_DIR="$W/backups" \
  AKARI_PG_DUMP_CMD='docker compose exec -T postgres pg_dump -U akari -Fc akari' \
  scripts/backup.sh
BACKUP="$(find "$W/backups" -maxdepth 1 -name 'akari-*' -type d | head -1)"
ls -l "$BACKUP"
grep -q "BEGIN" "$BACKUP/db.dump.age" && fail "backup is not encrypted"

echo "== 3. disaster: stop panel, wipe database and data dir (agent keeps running) =="
stop_panel
rm -rf "$W/data"
wipe_db
[ "$(psql_dev -At -c "select count(*) from information_schema.tables where table_schema='public'")" = 0 ] \
  || fail "wipe did not empty the database"

echo "== 4. restore =="
AGE_IDENTITY_FILE="$W/age.key" AKARI_DATA_DIR="$W/data" \
  AKARI_PG_RESTORE_CMD='docker compose exec -T postgres pg_restore -U akari -d akari --clean --if-exists --no-owner --single-transaction' \
  scripts/restore.sh "$BACKUP"

echo "== 5. verify: same prefix, logins, users; agent reconnects =="
PREFIX2="$(p info | awk '/route prefix/{sub(/^\//,"",$3); print $3}')"
[ "$PREFIX2" = "$PREFIX" ] || fail "route prefix changed ($PREFIX -> $PREFIX2)"
: >"$W/jar"
started="$(date +%s)"
start_panel
[ "$(login)" = 200 ] || fail "admin login after restore"
[ "$(api "$W/jar" "$BASE/api/v1/users" | jq -r '[.[] | select(.login=="alice")] | length')" = 1 ] \
  || fail "user alice missing after restore"
for _ in $(seq 1 90); do [ "$(online)" = online ] && break; sleep 1; done
[ "$(online)" = online ] || fail "agent did not reconnect"
[ "$(api "$W/jar" "$BASE/api/v1/nodes" | jq -r '.[0].id')" = "$NODE_ID" ] || fail "node identity changed"
[ "$(grep -c "channel established" "$W/agent.log")" -ge 2 ] || fail "agent did not re-establish its channel"
echo "DRILL PASS: prefix kept, logins and users restored, agent reconnected in $(( $(date +%s) - started )) s (panel start to online)"
