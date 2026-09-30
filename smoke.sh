#!/usr/bin/env bash
# Cross-repo end-to-end smoke test. Lives in akari-panel (the integrator) and
# expects the sibling checkout convention: ../akari-agent must exist.
set -euo pipefail
cd "$(dirname "$0")"

PANEL=./target/release/akari
AGENT=../akari-agent/agent
BOOT=test-node-bootstrap.toml
JAR=/tmp/akari-smoke.cookies
LOG=/tmp/akari-smoke
ADMIN_PW=smoke-admin-password-123
AGENT_PID=""
rm -rf "$LOG" data "$BOOT" "$JAR" && mkdir -p "$LOG"

# Clean up any leftovers from earlier runs (zombie panels keep port 8443).
pkill -f "target/release/akari serve" 2>/dev/null || true
pkill -f "agent -config" 2>/dev/null || true
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

echo "== decoy on wrong prefix =="
[ "$(code http://127.0.0.1:8080/deadbeef/api/v1/users)" = "404" ] || { echo "FAIL: wrong prefix not 404"; exit 1; }
grep -q "Meridian Systems" /tmp/akari-smoke/last || { echo "FAIL: wrong prefix did not return decoy"; exit 1; }
echo "decoy: ok"

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
# Nothing may depend on the wrong path: it must stay a decoy 404.
[ "$(code -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\"}")" = "404" ] || { echo "FAIL: /api/v1/auth/login not 404"; exit 1; }
grep -q "Meridian Systems" /tmp/akari-smoke/last || { echo "FAIL: /api/v1/auth/login not the decoy"; exit 1; }
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
# Wrong token must be a byte-identical decoy, and never carry quota headers.
DECOY=$(curl -s --noproxy '*' http://127.0.0.1:8080/junk | sha256sum | cut -d' ' -f1)
SUBDECOY=$(curl -s --noproxy '*' "$BASE/sub/not-a-real-token" | sha256sum | cut -d' ' -f1)
[ "$DECOY" = "$SUBDECOY" ] || { echo "FAIL: bad-token response differs from decoy"; exit 1; }
curl -s --noproxy '*' -D - -o /dev/null "$BASE/sub/not-a-real-token" | grep -qi "subscription-userinfo" \
  && { echo "FAIL: quota header leaked on decoy"; exit 1; }
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

echo "== me + logout =="
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "200" ] || { echo "FAIL: me failed"; exit 1; }
[ "$(code -b "$JAR" -c "$JAR" -X POST "$BASE/auth/logout")" = "200" ] || { echo "FAIL: logout failed"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: me after logout not 401"; exit 1; }

echo "== decoy site checks =="
[ "$(code http://127.0.0.1:8080/)" = "200" ] || { echo "FAIL: / not 200"; exit 1; }
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
[ "$(code "$BASE/assets/missing.js")" = "404" ] || { echo "FAIL: missing asset not decoy 404"; exit 1; }
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
