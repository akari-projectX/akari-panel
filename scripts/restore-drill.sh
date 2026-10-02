#!/usr/bin/env bash
# Backup/restore drill against the DEV stack (docs/BACKUP.md).
#
#   Uses its own database on the dev PostgreSQL (DRILL_DB, default
#   akari_drill: DESTROYED and recreated) and its own Valkey db index
#   (DRILL_VALKEY_DB, default 14: FLUSHDB), so other databases on the dev
#   stack are untouched. Binds 8080/8443/8081: serialise with smoke (flock).
#   Development machines only. Needs: make dev-up, a release build (make panel), the
#   agent binary (../akari-agent/agent), age + age-keygen, jq, curl,
#   python3 (TOTP codes: admins must use two-factor authentication).
#
# Flow: fresh install -> admin + user + node, agent online -> backup.sh ->
# stop panel, WIPE database and data dir (agent keeps running) -> restore.sh
# -> start panel: same route prefix, same logins and users, the admin's
# TOTP still works (data/totp.key restored with the database), the
# (unchanged) agent reconnects and the node is online again.
set -euo pipefail

# Pattern test on a command's output that READS ALL OF IT (grep -q exits at
# the first match; the writer's next write then fails with EPIPE/SIGPIPE and
# pipefail turns a match into a FAIL — flaky, depending on chunking). Use
# `cmd | matches [grep flags] PATTERN`, never `cmd | grep -q`, and
# `| sed -n 1p` instead of `| head -1`.
matches() { grep "$@" >/dev/null; }
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

unset DATABASE_URL VALKEY_URL  # panel.toml below names the drill database
DRILL_DB="${DRILL_DB:-akari_drill}"
DRILL_VALKEY_DB="${DRILL_VALKEY_DB:-14}"
case "$DRILL_DB" in akari|*[!a-z0-9_]*) fail "DRILL_DB must be [a-z0-9_] and not the dev database";; esac
psql_dev() { docker compose exec -T postgres psql -U akari -d "$DRILL_DB" -v ON_ERROR_STOP=1 -q "$@"; }
docker compose exec -T postgres psql -U akari -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DRILL_DB'" | matches 1 \
  || docker compose exec -T postgres psql -U akari -d postgres -qc "CREATE DATABASE \"$DRILL_DB\"" >/dev/null
wipe_db() {
  psql_dev -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
  docker compose exec -T valkey valkey-cli -n "$DRILL_VALKEY_DB" flushdb >/dev/null
}

cat >"$W/panel.toml" <<TOML
data_dir = "$W/data"
database_url = "postgres://akari:akari-dev@localhost:5432/$DRILL_DB"
valkey_url = "redis://127.0.0.1:6379/$DRILL_VALKEY_DB"
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
# RFC 6238 code for a step strictly after the last one used (the panel
# refuses replays); waits for the next 30 s step when needed.
cat >"$W/totp.py" <<'PY'
import base64, hashlib, hmac, os, struct, sys, time
secret, state = sys.argv[1], sys.argv[2]
key = base64.b32decode(secret + "=" * (-len(secret) % 8))
last = int(open(state).read()) if os.path.exists(state) else -1
while int(time.time()) // 30 <= last:
    time.sleep(30 - time.time() % 30 + 0.3)
step = int(time.time()) // 30
h = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
o = h[-1] & 15
print("%06d" % ((struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 1000000))
open(state, "w").write(str(step))
PY
totp() { python3 "$W/totp.py" "$TOTP_SECRET" "$W/totp.last"; }
login() { # [code] -> http status
  local body="{\"login\":\"root\",\"password\":\"$PW\"${1:+,\"code\":\"$1\"}}"
  api "$W/jar" -o "$W/login.json" -w '%{http_code}' -X POST "$BASE/auth/login" \
    -H 'Content-Type: application/json' -d "$body"
}

echo "== 1. fresh install: admin, user, node, agent online =="
wipe_db
PREFIX="$(p info | awk '/route prefix/{sub(/^\//,"",$3); print $3}')"
[ -n "$PREFIX" ] || fail "no route prefix"
BASE="http://127.0.0.1:8080/$PREFIX"
start_panel
p admin add root >/dev/null
# 2FA is optional (R18): the password alone yields a full session; the drill
# still enables TOTP so the restore proves totp.key survives the backup.
[ "$(login)" = 200 ] || fail "login before backup"
[ "$(jq -r .stage "$W/login.json")" = full ] || fail "admin without 2FA did not get a full session"
TOTP_SECRET="$(api "$W/jar" -X POST "$BASE/api/v1/me/totp/enroll" -H 'Content-Type: application/json' -d '{}' | jq -r .secret)"
[ -n "$TOTP_SECRET" ] && [ "$TOTP_SECRET" != null ] || fail "totp enroll"
[ "$(api "$W/jar" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/me/totp/confirm" \
  -H 'Content-Type: application/json' -d "{\"code\":\"$(totp)\"}")" = 200 ] \
  || fail "totp confirm"
[ "$(api "$W/jar" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/users" \
  -H 'Content-Type: application/json' -d '{"login":"alice","password":"alice-password-123"}')" = 201 ] \
  || fail "create user"
p node add drill-node --out "$W/boot.toml" >/dev/null
"$AGENT" -config "$W/boot.toml" -state-dir "$W/agent-state" >"$W/agent.log" 2>&1 &
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
  AKARI_PG_DUMP_CMD="docker compose exec -T postgres pg_dump -U akari -Fc $DRILL_DB" \
  scripts/backup.sh
BACKUP="$(find "$W/backups" -maxdepth 1 -name 'akari-*' -type d | sed -n 1p)"
ls -l "$BACKUP"
grep -q "BEGIN" "$BACKUP/db.dump.age" && fail "backup is not encrypted"
# The TOTP key must be in the backup: without it every 2FA account is locked out.
age -d -i "$W/age.key" "$BACKUP/data.tar.age" | tar -tf - | matches -x './totp.key' \
  || fail "data/totp.key missing from the backup"

echo "== 3. disaster: stop panel, wipe database and data dir (agent keeps running) =="
stop_panel
rm -rf "$W/data"
wipe_db
[ "$(psql_dev -At -c "select count(*) from information_schema.tables where table_schema='public'")" = 0 ] \
  || fail "wipe did not empty the database"

echo "== 4. restore =="
AGE_IDENTITY_FILE="$W/age.key" AKARI_DATA_DIR="$W/data" \
  AKARI_PG_RESTORE_CMD="docker compose exec -T postgres pg_restore -U akari -d $DRILL_DB --clean --if-exists --no-owner --single-transaction" \
  scripts/restore.sh "$BACKUP"

echo "== 5. verify: same prefix, logins, users; agent reconnects =="
PREFIX2="$(p info | awk '/route prefix/{sub(/^\//,"",$3); print $3}')"
[ "$PREFIX2" = "$PREFIX" ] || fail "route prefix changed ($PREFIX -> $PREFIX2)"
: >"$W/jar"
started="$(date +%s)"
start_panel
[ "$(login)" = 401 ] || fail "password-only admin login after restore must fail"
[ "$(login "$(totp)")" = 200 ] || fail "admin TOTP login after restore (totp.key restored?)"
[ "$(jq -r .stage "$W/login.json")" = full ] || fail "admin login after restore is not a full session"
[ "$(api "$W/jar" "$BASE/api/v1/users" | jq -r '[.[] | select(.login=="alice")] | length')" = 1 ] \
  || fail "user alice missing after restore"
for _ in $(seq 1 90); do [ "$(online)" = online ] && break; sleep 1; done
[ "$(online)" = online ] || fail "agent did not reconnect"
[ "$(api "$W/jar" "$BASE/api/v1/nodes" | jq -r '.[0].id')" = "$NODE_ID" ] || fail "node identity changed"
[ "$(grep -c "channel established" "$W/agent.log")" -ge 2 ] || fail "agent did not re-establish its channel"
echo "DRILL PASS: prefix kept, logins (with TOTP) and users restored, agent reconnected in $(( $(date +%s) - started )) s (panel start to online)"
