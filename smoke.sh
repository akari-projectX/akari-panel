#!/usr/bin/env bash
# Cross-repo end-to-end smoke test. Lives in akari-panel (the integrator) and
# expects the sibling checkout convention: ../akari-agent must exist.
set -euo pipefail
cd "$(dirname "$0")"

PANEL=./target/release/akari
AGENT="${AGENT_DIR:-../akari-agent}/agent"
BOOT=test-node-bootstrap.toml
JAR=/tmp/akari-smoke.cookies
LOG=/tmp/akari-smoke
ADMIN_PW=smoke-admin-password-123
AGENT_PID=""
rm -rf "$LOG" data "$BOOT" "$JAR" && mkdir -p "$LOG"

# Clean up any leftovers from earlier runs (zombie panels keep port 8443).
# Anchored full-command-line patterns: only the exact processes this script
# starts (panel binary here, any sibling agent checkout's binary with this
# script's bootstrap file) — never a shell that merely mentions them.
pkill -f '^\./target/release/akari serve$' 2>/dev/null || true
pkill -f "^\.\./[A-Za-z0-9_.-]+/agent -config ${BOOT//./\\.}\$" 2>/dev/null || true
sleep 1

echo "== start panel (runs migrations) =="
"$PANEL" serve >"$LOG/panel.log" 2>&1 &
PANEL_PID=$!
trap 'kill $PANEL_PID ${AGENT_PID:+$AGENT_PID} 2>/dev/null || true' EXIT
sleep 2

# Reset AFTER startup: fresh volumes have no tables until the panel migrates,
# and Valkey rate-limit counters would poison the next run's login test.
docker compose exec -T postgres psql -U akari -d akari -c "TRUNCATE nodes CASCADE; TRUNCATE users CASCADE;" >/dev/null 2>&1 || true
docker compose exec -T valkey valkey-cli flushall >/dev/null

echo "== first admin (env password) =="
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" admin add root
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" admin add root 2>&1 | grep -q "created admin account: root" \
  && { echo "FAIL: duplicate admin creation should error"; exit 1; } || echo "duplicate rejected: ok"

echo "== register node =="
"$PANEL" node add test-node --out "$BOOT" >/dev/null
NODE_ID=$("$PANEL" node list | awk 'NR==2{print $1}')

PREFIX=$("$PANEL" info | awk '/route prefix/{sub(/^\//,"",$3); print $3}')
BASE="http://127.0.0.1:8080/$PREFIX"
code() { curl -s --noproxy '*' -o /tmp/akari-smoke/last -w "%{http_code}" "$@"; }

echo "== rejections: one identical empty 404 (SEC-1) =="
# Fingerprint = status line + headers (minus Date) + body.
fp() {
  curl -s --noproxy '*' -D - -o /tmp/akari-smoke/fpbody "$@" | tr -d '\r' | grep -vi '^date:' >/tmp/akari-smoke/fphead
  cat /tmp/akari-smoke/fphead /tmp/akari-smoke/fpbody | sha256sum | cut -d' ' -f1
}
REJ=$(fp http://127.0.0.1:8080/definitely-not-here)
head -1 /tmp/akari-smoke/fphead | grep -q " 404" || { echo "FAIL: rejection is not 404"; cat /tmp/akari-smoke/fphead; exit 1; }
[ ! -s /tmp/akari-smoke/fpbody ] || { echo "FAIL: rejection has a body"; exit 1; }
grep -qiE '^(x-frame-options|x-content-type-options|referrer-policy|content-security-policy|content-type):' /tmp/akari-smoke/fphead \
  && { echo "FAIL: rejection carries distinctive headers"; cat /tmp/akari-smoke/fphead; exit 1; }
for probe in \
    "http://127.0.0.1:8080/" \
    "-X POST http://127.0.0.1:8080/" \
    "http://127.0.0.1:8080/deadbeef/api/v1/users" \
    "http://127.0.0.1:8080/assets/missing.js" \
    "$BASE" \
    "$BASE/" \
    "$BASE/nope" \
    "$BASE/api/v1/nope" \
    "$BASE/auth/login" \
    "-X DELETE $BASE/auth/logout" \
    "-X POST $BASE/healthz" \
    "-X POST $BASE/api/v1/auth/login" \
    "$BASE/sub/not-a-real-token" \
    "$BASE/assets/missing.js"; do
  # shellcheck disable=SC2086
  [ "$(fp $probe)" = "$REJ" ] || { echo "FAIL: rejection differs for: $probe"; cat /tmp/akari-smoke/fphead; exit 1; }
done
# Real responses keep the security headers.
curl -s --noproxy '*' -D - -o /dev/null "$BASE/healthz" | grep -qi '^x-frame-options: DENY' \
  || { echo "FAIL: security headers missing on real responses"; exit 1; }
echo "rejections: ok ($REJ)"

echo "== login (wrong password x3, then ok) =="
for i in 1 2 3; do
  [ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
      -d '{"login":"root","password":"totally-wrong"}')" = "401" ] || { echo "FAIL: bad login not 401"; exit 1; }
done
[ "$(code -c "$JAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\"}")" = "200" ] || { echo "FAIL: good login failed"; exit 1; }
grep -q '"role":"admin"' /tmp/akari-smoke/last || { echo "FAIL: login response missing role"; exit 1; }
echo "login: ok"

echo "== auth lives at /{prefix}/auth, not /api/v1/auth (REVIEW P0 #1) =="
# Nothing may depend on the wrong path: it must stay a rejection.
[ "$(code -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\"}")" = "404" ] || { echo "FAIL: /api/v1/auth/login not 404"; exit 1; }
[ ! -s /tmp/akari-smoke/last ] || { echo "FAIL: /api/v1/auth/login is not the empty rejection"; exit 1; }
[ "$(code -X POST "$BASE/api/v1/auth/logout")" = "404" ] || { echo "FAIL: /api/v1/auth/logout not 404"; exit 1; }
echo "auth path: ok"

echo "== unauthorized access =="
[ "$(code "$BASE/api/v1/users")" = "401" ] || { echo "FAIL: cookieless access not 401"; exit 1; }
echo "unauthorized: ok"

echo "== configure node + user via API =="
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' \
    -d '{"inbounds":[{"tag":"in-vless","listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp"}}]}')" = "200" ] \
  || { echo "FAIL: set inbounds failed"; exit 1; }

[ "$(code -b "$JAR" -X PATCH "$BASE/api/v1/nodes/$NODE_ID" -H 'Content-Type: application/json' \
    -d '{"server_addr":"node1.example.test"}')" = "200" ] \
  || { echo "FAIL: set server_addr failed"; exit 1; }

[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-user","password":"user-password-123","traffic_limit_bytes":107374182400}')" = "201" ] \
  || { echo "FAIL: create user failed"; cat /tmp/akari-smoke/last; exit 1; }
USER_ID=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
SUB_TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['sub_token'])")

[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_ID/nodes/$NODE_ID" -H 'Content-Type: application/json' \
    -d '{"inbound_tag":"in-vless","protocol":"vless"}')" = "201" ] \
  || { echo "FAIL: assign account failed"; cat /tmp/akari-smoke/last; exit 1; }
grep -q '"flow":""' /tmp/akari-smoke/last || { echo "FAIL: generated vless account missing"; cat /tmp/akari-smoke/last; exit 1; }
VLESS_A=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['account']['id'])")
echo "api setup: ok (user $USER_ID on node $NODE_ID)"

echo "== subscription =="
SUB="$BASE/sub/$SUB_TOKEN"
curl -s --noproxy '*' "$SUB" | base64 -d 2>/dev/null | grep -q "vless://.*@node1.example.test:11443" \
  || { echo "FAIL: base64 links missing vless"; exit 1; }
curl -s --noproxy '*' -A "sing-box/1.12.0" "$SUB" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); ob=[o for o in d['outbounds'] if o.get('type')=='vless']; assert ob and ob[0]['server']=='node1.example.test' and ob[0]['server_port']==11443" \
  || { echo "FAIL: sing-box format"; exit 1; }
curl -s --noproxy '*' -A "clash-meta/1.19" "$SUB" | grep -q "^    type: vless" \
  || { echo "FAIL: clash format"; exit 1; }
INFO=$(curl -s --noproxy '*' -D - -o /dev/null "$SUB" | grep -i "^subscription-userinfo:")
echo "$INFO" | grep -q "download=0" && echo "$INFO" | grep -q "total=107374182400" \
  || { echo "FAIL: subscription-userinfo header: $INFO"; exit 1; }
SIZE=$(curl -s --noproxy '*' -o /tmp/akari-smoke/subbody "$SUB" && wc -c < /tmp/akari-smoke/subbody)
[ "$SIZE" -ge 8192 ] || { echo "FAIL: body not padded ($SIZE bytes)"; exit 1; }
# Wrong token: identical rejection (checked above), never quota headers.
curl -s --noproxy '*' -D - -o /dev/null "$BASE/sub/not-a-real-token" | grep -qi "subscription-userinfo" \
  && { echo "FAIL: quota header leaked on rejection"; exit 1; }
echo "subscription: ok ($SIZE-byte padded body)"

echo "== start agent: initial snapshot =="
"$AGENT" -config "$BOOT" >"$LOG/agent.log" 2>&1 &
AGENT_PID=$!
sleep 6
grep -q "channel established" "$LOG/agent.log" || { echo "FAIL: agent channel"; exit 1; }
grep -q '"users":1' "$LOG/agent.log" || { echo "FAIL: initial snapshot without 1 user"; cat "$LOG/agent.log"; exit 1; }

echo "== disable user: expect instant push =="
[ "$(code -b "$JAR" -X PATCH "$BASE/api/v1/users/$USER_ID" -H 'Content-Type: application/json' \
    -d '{"enabled": false}')" = "200" ] || { echo "FAIL: disable user failed"; exit 1; }
sleep 3
grep -q '"users":0' "$LOG/agent.log" || { echo "FAIL: agent did not converge to empty user set"; cat "$LOG/agent.log"; exit 1; }

# --- Sprint 2: "disable means disabled" -----------------------------------
# The user count the agent last applied (snapshot or delta) must reach $1
# within $2 seconds.
wait_users() {
  for _ in $(seq 1 "$2"); do
    grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | grep -q "\"users\":$1[,}]" && return 0
    sleep 1
  done
  echo "FAIL: agent did not converge to users=$1 ($3)"; grep 'state applied' "$LOG/agent.log" | tail -3; exit 1
}
port_open() { (exec 3<>/dev/tcp/127.0.0.1/11443) 2>/dev/null; }
wait_port() { # open|closed timeout
  for _ in $(seq 1 "$2"); do
    if port_open; then [ "$1" = open ] && return 0; else [ "$1" = closed ] && return 0; fi
    sleep 1
  done
  echo "FAIL: inbound port 11443 not $1"; exit 1
}
patch_code() { code -b "$JAR" -X PATCH "$1" -H 'Content-Type: application/json' -d "$2"; }

echo "== re-enable user =="
[ "$(patch_code "$BASE/api/v1/users/$USER_ID" '{"enabled": true}')" = "200" ] || { echo "FAIL: enable user"; exit 1; }
wait_users 1 10 "re-enable"
wait_port open 10

echo "== PATCH semantics =="
[ "$(patch_code "$BASE/api/v1/users/$USER_ID" '{}')" = "400" ] || { echo "FAIL: PATCH user {} not 400"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{}')" = "400" ] || { echo "FAIL: PATCH node {} not 400"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"enabled": null}')" = "400" ] || { echo "FAIL: enabled null not 400"; exit 1; }
[ "$(patch_code "$BASE/api/v1/users/$USER_ID" '{"expires_at": "2030-01-01"}')" = "400" ] || { echo "FAIL: date-only not 400"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"server_addr": null}')" = "200" ] || { echo "FAIL: clear server_addr not 200"; exit 1; }
grep -q '"server_addr":null' /tmp/akari-smoke/last || { echo "FAIL: server_addr not cleared"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"server_addr": "node1.example.test"}')" = "200" ] || { echo "FAIL: restore server_addr"; exit 1; }
echo "patch: ok"

echo "== failed apply is recorded (last_error) and cleared =="
GOOD_INB='{"inbounds":[{"tag":"in-vless","listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp"}}]}'
BAD_INB='{"inbounds":[{"tag":"in-vless","listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp"}},{"tag":"in-bad","listen":"127.0.0.1","port":11444,"protocol":"no-such-protocol","settings":{}}]}'
node_field() { # jq-less: print field $1 of node $NODE_ID
  code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
  python3 -c "import json,sys; print(json.dumps([n for n in json.load(open('/tmp/akari-smoke/last')) if n['id']=='$NODE_ID'][0]['$1']))"
}
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' -d "$BAD_INB")" = "200" ] \
  || { echo "FAIL: put bad inbounds"; exit 1; }
for _ in $(seq 1 10); do [ "$(node_field last_error)" != "null" ] && break; sleep 1; done
[ "$(node_field last_error)" != "null" ] || { echo "FAIL: last_error not recorded"; exit 1; }
echo "last_error: $(node_field last_error | cut -c1-100)"
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' -d "$GOOD_INB")" = "200" ] \
  || { echo "FAIL: restore inbounds"; exit 1; }
for _ in $(seq 1 10); do [ "$(node_field last_error)" = "null" ] && break; sleep 1; done
[ "$(node_field last_error)" = "null" ] || { echo "FAIL: last_error not cleared by a good apply"; exit 1; }
wait_users 1 10 "after restoring inbounds"
wait_port open 10
echo "last_error: ok"

echo "== disable node: no inbounds, no users; re-enable restores =="
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"enabled": false}')" = "200" ] || { echo "FAIL: disable node"; exit 1; }
wait_users 0 10 "node disabled"
wait_port closed 10
grep -q "node disabled" "$LOG/agent.log" && { echo "FAIL: disabled node's stream was rejected"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"enabled": true}')" = "200" ] || { echo "FAIL: enable node"; exit 1; }
wait_users 1 10 "node re-enabled"
wait_port open 10
echo "node disable/enable: ok"

echo "== expiry removes the user from the node =="
EXP=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=3)).isoformat())")
[ "$(patch_code "$BASE/api/v1/users/$USER_ID" "{\"expires_at\": \"$EXP\"}")" = "200" ] || { echo "FAIL: set expiry"; cat /tmp/akari-smoke/last; exit 1; }
wait_users 0 20 "expiry"
[ "$(patch_code "$BASE/api/v1/users/$USER_ID" '{"expires_at": null}')" = "200" ] || { echo "FAIL: clear expiry"; exit 1; }
wait_users 1 10 "expiry cleared"
echo "expiry: ok"

echo "== Sprint 3a: user-only change = UserDelta, no rebuild, other users' connections survive =="
# A tiny raw-VLESS client (no flow, plain TCP) and an echo target.
cat >"$LOG/vless.py" <<'PY'
import os, socket, struct, sys, threading, time, uuid
mode, a_id, b_id, ready, go = sys.argv[1:6]
echo = socket.socket(); echo.bind(("127.0.0.1", 0)); echo.listen(8)
eport = echo.getsockname()[1]
def serve():
    while True:
        c, _ = echo.accept()
        threading.Thread(target=lambda c=c: [c.sendall(d) for d in iter(lambda: c.recv(4096), b"")], daemon=True).start()
threading.Thread(target=serve, daemon=True).start()
def dial(uid):
    s = socket.create_connection(("127.0.0.1", 11443), timeout=5)
    s.sendall(b"\x00" + uuid.UUID(uid).bytes + b"\x00\x01" + struct.pack(">H", eport) + b"\x01" + socket.inet_aton("127.0.0.1"))
    return [s, False]
def roundtrip(c, msg):
    s = c[0]; s.settimeout(5); s.sendall(msg)
    want = len(msg) + (0 if c[1] else 2); got = b""
    while len(got) < want:
        d = s.recv(want - len(got))
        if not d: raise EOFError("closed")
        got += d
    if not c[1]: got = got[2:]; c[1] = True
    assert got == msg, got
def closed(c, secs):
    c[0].settimeout(secs)
    try: return c[0].recv(1) == b""
    except socket.timeout: return False
    except OSError: return True
a, b = dial(a_id), dial(b_id)
roundtrip(a, b"a-before"); roundtrip(b, b"b-before")
open(ready, "w").close()
for _ in range(300):
    if os.path.exists(go): break
    time.sleep(0.1)
else:
    sys.exit("timeout waiting for go")
roundtrip(a, b"a-after")                      # A's live connection survived
if not closed(b, 5): sys.exit("B's live connection stayed open")
try:
    nb = dial(b_id); roundtrip(nb, b"b-new"); sys.exit("B can still connect")
except (EOFError, OSError, AssertionError):
    pass
roundtrip(a, b"a-end")
print("vless: A kept its connection, B was cut and refused")
PY
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-user-b","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create user B"; exit 1; }
USER_B=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_B/nodes/$NODE_ID" -H 'Content-Type: application/json' \
    -d '{"inbound_tag":"in-vless","protocol":"vless"}')" = "201" ] || { echo "FAIL: assign B"; exit 1; }
VLESS_B=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['account']['id'])")
wait_users 2 10 "user B added"
grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | grep -q '"via":"delta"' \
  || { echo "FAIL: adding a user was not a delta"; grep 'state applied' "$LOG/agent.log" | tail -2; exit 1; }
SNAPS_BEFORE=$(grep -c '"msg":"applying config snapshot"' "$LOG/agent.log")
SESSION_BEFORE=$(grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['session'])")
rm -f "$LOG/vless.ready" "$LOG/vless.go"
python3 "$LOG/vless.py" hold "$VLESS_A" "$VLESS_B" "$LOG/vless.ready" "$LOG/vless.go" >"$LOG/vless.out" 2>&1 &
VLESS_PID=$!
for _ in $(seq 1 50); do [ -e "$LOG/vless.ready" ] && break; sleep 0.2; done
[ -e "$LOG/vless.ready" ] || { echo "FAIL: vless client could not connect"; cat "$LOG/vless.out"; exit 1; }
[ "$(patch_code "$BASE/api/v1/users/$USER_B" '{"enabled": false}')" = "200" ] || { echo "FAIL: disable B"; exit 1; }
wait_users 1 10 "user B disabled"
touch "$LOG/vless.go"
wait $VLESS_PID || { echo "FAIL: live-connection check"; cat "$LOG/vless.out"; exit 1; }
cat "$LOG/vless.out"
SNAPS_AFTER=$(grep -c '"msg":"applying config snapshot"' "$LOG/agent.log")
SESSION_AFTER=$(grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['session'])")
[ "$SNAPS_BEFORE" = "$SNAPS_AFTER" ] || { echo "FAIL: disabling a user rebuilt xray ($SNAPS_BEFORE -> $SNAPS_AFTER snapshots)"; exit 1; }
[ "$SESSION_BEFORE" = "$SESSION_AFTER" ] || { echo "FAIL: xray session changed ($SESSION_BEFORE -> $SESSION_AFTER)"; exit 1; }
grep -q '"msg":"applying user delta"' "$LOG/agent.log" || { echo "FAIL: no user delta in agent log"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$USER_B")" = "204" ] || { echo "FAIL: delete B"; exit 1; }
echo "user delta: ok (no rebuild, session $SESSION_AFTER)"

echo "== Sprint 3a: protocol + lease surfaced on the node =="
[ "$(node_field agent_protocol)" = "1" ] || { echo "FAIL: agent_protocol $(node_field agent_protocol)"; exit 1; }
LEASE=$(node_field lease_remaining_seconds)
[ "$LEASE" != "null" ] && [ "$LEASE" -gt 80000 ] || { echo "FAIL: lease_remaining_seconds '$LEASE'"; exit 1; }
echo "lease: ok (${LEASE}s left)"

echo "== node online + heartbeat =="
STATUS=$(docker compose exec -T postgres psql -U akari -d akari -tAc "SELECT status FROM nodes WHERE id='$NODE_ID'")
[ "$STATUS" = "online" ] || { echo "FAIL: node status '$STATUS'"; exit 1; }
docker compose exec -T valkey valkey-cli exists "akari:node:online:$NODE_ID" | grep -q 1 \
  || { echo "FAIL: online key missing"; exit 1; }

echo "== rate limit (20/15min) =="
CODE=200
for i in $(seq 1 25); do
  CODE=$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"login":"root","password":"nope"}')
done
[ "$CODE" = "429" ] || { echo "FAIL: login rate limit never hit (last $CODE)"; exit 1; }
echo "rate limit: ok"

echo "== delete user: node converges to users=0 =="
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$USER_ID")" = "204" ] || { echo "FAIL: delete user"; exit 1; }
wait_users 0 10 "delete user"
echo "delete user: ok"

echo "== Sprint 3a: a protocol-0 agent gets the empty state and is flagged (N5) =="
OLD_SRC="$LOG/old-agent-src"
mkdir -p "$OLD_SRC"
if git -C "${AGENT_DIR:-../akari-agent}" archive 2b3e7e3 2>/dev/null | tar -x -C "$OLD_SRC" \
    && (cd "$OLD_SRC" && go build -o "$LOG/old-agent" . ) >"$LOG/old-build.log" 2>&1; then
  kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
  "$LOG/old-agent" -config "$BOOT" >"$LOG/old-agent.log" 2>&1 &
  AGENT_PID=$!
  for _ in $(seq 1 15); do node_field last_error | grep -q "agent too old" && break; sleep 1; done
  node_field last_error | grep -q "agent too old" || { echo "FAIL: too-old agent not flagged: $(node_field last_error)"; exit 1; }
  [ "$(node_field agent_protocol)" = "0" ] || { echo "FAIL: agent_protocol not 0"; exit 1; }
  for _ in $(seq 1 10); do grep -q '"config_version":0,"user_version":0' "$LOG/old-agent.log" && break; sleep 1; done
  grep '"msg":"applying config snapshot"' "$LOG/old-agent.log" | tail -1 | grep -q '"config_version":0' \
    || { echo "FAIL: old agent did not get the empty state"; cat "$LOG/old-agent.log"; exit 1; }
  wait_port closed 10
  kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
  "$AGENT" -config "$BOOT" >>"$LOG/agent.log" 2>&1 &
  AGENT_PID=$!
  for _ in $(seq 1 15); do [ "$(node_field last_error)" = "null" ] && break; sleep 1; done
  [ "$(node_field last_error)" = "null" ] || { echo "FAIL: too-old flag not cleared by a current agent"; exit 1; }
  wait_port open 10
  echo "old agent: ok (empty state, flagged, cleared after upgrade)"
else
  echo "old agent: SKIPPED (could not build the pinned protocol-0 agent)"; tail -3 "$LOG/old-build.log"
fi

echo "== me + logout =="
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "200" ] || { echo "FAIL: me failed"; exit 1; }
[ "$(code -b "$JAR" -c "$JAR" -X POST "$BASE/auth/logout")" = "200" ] || { echo "FAIL: logout failed"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: me after logout not 401"; exit 1; }

echo "== root + healthz =="
[ "$(code http://127.0.0.1:8080/)" = "404" ] || { echo "FAIL: / not 404"; exit 1; }
[ "$(code http://127.0.0.1:8080/definitely-not-here)" = "404" ] || { echo "FAIL: junk not 404"; exit 1; }
[ "$(code "$BASE/healthz")" = "200" ] || { echo "FAIL: healthz not 200"; exit 1; }

echo "== SPA =="
[ "$(code "$BASE/app")" = "200" ] || { echo "FAIL: /app not 200"; exit 1; }
grep -q 'id="root"' /tmp/akari-smoke/last || { echo "FAIL: SPA index has no root div"; exit 1; }
JS=$(grep -o "/$PREFIX/assets/[^\"]*\.js" /tmp/akari-smoke/last | head -1)
[ -n "$JS" ] || { echo "FAIL: SPA index did not reference prefixed asset"; exit 1; }
CT=$(curl -s --noproxy '*' -o /dev/null -w "%{content_type}" "http://127.0.0.1:8080$JS")
echo "$CT" | grep -q javascript || { echo "FAIL: asset content-type '$CT'"; exit 1; }
[ "$(code "$BASE/app/some-client-route")" = "200" ] || { echo "FAIL: SPA client-route fallback"; exit 1; }
[ "$(code "$BASE/assets/missing.js")" = "404" ] || { echo "FAIL: missing asset not 404"; exit 1; }
[ "$(code http://127.0.0.1:8080/assets/missing.js)" = "404" ] || { echo "FAIL: asset path reachable without prefix"; exit 1; }
# REVIEW P0 #1 regression guards. (a) Behavioural: run the real api.ts with a
# fake location/fetch and check the URLs it requests. (b) Bundle: the shipped
# JS derives an `${prefix}/auth` base and never carries a bare "/auth/login"
# literal (that shape is what gets prefixed with /api/v1 by get/post).
node spa/scripts/check-auth-paths.mjs || { echo "FAIL: SPA auth request paths"; exit 1; }
curl -s --noproxy '*' "http://127.0.0.1:8080$JS" >/tmp/akari-smoke/app.js
grep -q '}/auth[`"'"'"']' /tmp/akari-smoke/app.js || { echo "FAIL: bundle lacks the {prefix}/auth base"; exit 1; }
grep -qE '[`"'"'"']/auth/(login|logout)' /tmp/akari-smoke/app.js \
  && { echo "FAIL: bundle posts a bare /auth/* path (would be joined to /api/v1)"; exit 1; }
echo "spa: ok (asset $JS)"

echo
echo "SMOKE TEST PASSED"
