#!/usr/bin/env bash
# Cross-repo end-to-end smoke test. Lives in akari-panel (the integrator) and
# expects the sibling checkout convention: ../akari-agent must exist.
set -euo pipefail
cd "$(dirname "$0")"

# R22 (main domain behind Caddy): the PANEL itself dials https://myapp.test
# (install-link TLS pin probe), so the name must resolve to loopback here
# (CI adds it to /etc/hosts; curl calls use --resolve).
getent hosts myapp.test | grep -qE '^(127\.0\.0\.1|::1)[[:space:]]' \
  || { echo "smoke needs 'myapp.test' -> 127.0.0.1 (echo '127.0.0.1 myapp.test' | sudo tee -a /etc/hosts)"; exit 1; }

PANEL=./target/release/akari
AGENT_DIR="${AGENT_DIR:-../akari-agent}"
AGENT="$AGENT_DIR/agent"
BOOT=test-node-bootstrap.toml
JAR=/tmp/akari-smoke.cookies
LOG=/tmp/akari-smoke
ADMIN_PW=smoke-admin-password-123
AGENT_PID=""
# Per-checkout database (parallel worktrees carry different migrations; a
# shared DB fails with "migration N was previously applied but is missing").
SMOKE_DB=${SMOKE_DB:-akari}
export DATABASE_URL=${DATABASE_URL:-postgres://akari:akari-dev@localhost:5432/$SMOKE_DB}
# Valkey isolation: one logical db index (1..15) per SMOKE_DB; the default
# database keeps index 0. FLUSHDB below only ever wipes this index.
if [ -z "${SMOKE_VALKEY_DB:-}" ]; then
  if [ "$SMOKE_DB" = akari ]; then SMOKE_VALKEY_DB=0
  else SMOKE_VALKEY_DB=$(( $(printf '%s' "$SMOKE_DB" | cksum | cut -d' ' -f1) % 15 + 1 )); fi
fi
export VALKEY_URL="redis://127.0.0.1:6379/$SMOKE_VALKEY_DB"
vk() { docker compose exec -T valkey valkey-cli -n "$SMOKE_VALKEY_DB" "$@"; }
docker compose exec -T postgres psql -U akari -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$SMOKE_DB'" | grep -q 1 \
  || docker compose exec -T postgres psql -U akari -d postgres -qc "CREATE DATABASE \"$SMOKE_DB\"" >/dev/null
rm -rf "$LOG" data "$BOOT" "$JAR" && mkdir -p "$LOG"

# Clean up any leftovers from earlier runs (zombie panels keep port 8443).
# Anchored full-command-line patterns: only the exact processes this script
# starts (panel binary here, any sibling agent checkout's binary with this
# script's bootstrap file) — never a shell that merely mentions them.
pkill -f '^\./target/release/akari (-c [^ ]+ )?serve$' 2>/dev/null || true
pkill -f "^[A-Za-z0-9_./-]+/agent -config ${BOOT//./\\.}( .*)?\$" 2>/dev/null || true
# M6 self-update agents (staged binaries keep their -state-dir argument).
pkill -f -- "-state-dir $LOG/state-upd\$" 2>/dev/null || true
sleep 1
UPD_LOOP=""
cleanup_upd() {
  if [ -n "$UPD_LOOP" ]; then
    touch "$LOG/upd/stop" 2>/dev/null || true
    kill "$UPD_LOOP" 2>/dev/null || true
    pkill -f -- "-state-dir $LOG/state-upd\$" 2>/dev/null || true
  fi
}

echo "== start panel (runs migrations) =="
# Plain-HTTP development: the session cookie must not be Secure. 127.0.0.2
# plays a trusted reverse proxy (curl --interface 127.0.0.2); requests from
# 127.0.0.1 are direct clients whose X-Forwarded-For must be ignored.
cat >"$LOG/panel.toml" <<'TOML'
[web]
cookie_secure = false
trusted_proxies = ["127.0.0.2/32"]
[metrics]
bind = "127.0.0.1:9109"
[tls_ask]
bind = "127.0.0.1:8092"

[sub]
rate_per_token = 8
TOML
# M6: the agent's TEST release key (testdata/, public on purpose) is the
# panel's trusted key here; production configures the real one.
TEST_RELEASE_PUB=$(cut -d' ' -f1 "$AGENT_DIR/testdata/TEST-ONLY-release.pub")
printf '\n[updates]\nrelease_keys = ["%s TEST-ONLY"]\n' "$TEST_RELEASE_PUB" >>"$LOG/panel.toml"
# R18-3: Alipay Face-to-Face against a local mock gateway, with throwaway
# RSA keys made here (never real credentials). The notify URL must carry
# the route prefix, so the data dir (prefix) is created first.
PAY="$LOG/pay"; mkdir -p "$PAY"
for k in app alipay; do
  openssl genrsa -out "$PAY/$k-key.pem" 2048 2>/dev/null
  openssl rsa -in "$PAY/$k-key.pem" -pubout -out "$PAY/$k-pub.pem" 2>/dev/null
done
chmod 600 "$PAY"/*.pem
PAY_PREFIX=$("$PANEL" info | awk '/route prefix/{sub(/^\//,"",$3); print $3}')
cat >>"$LOG/panel.toml" <<TOML

[payments.alipay]
enabled = true
app_id = "2021000000000001"
seller_id = "2088000000000001"
app_private_key_file = "$PAY/app-key.pem"
alipay_public_key_file = "$PAY/alipay-pub.pem"
gateway_url = "http://127.0.0.1:18089/gateway.do"
notify_url = "http://127.0.0.1:8080/$PAY_PREFIX/pay/alipay/notify"
TOML
# The mock gateway: verifies the panel's request signature (app public
# key), answers signed with the "Alipay" key; POST /control/pay?otn=X
# marks a trade paid (TRADE_SUCCESS) for the query path.
cat >"$PAY/mock.py" <<'PY'
import base64, json, subprocess, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
D = sys.argv[1]; trades = {}
def sign(data):
    return base64.b64encode(subprocess.run(["openssl", "dgst", "-sha256", "-sign", D + "/alipay-key.pem"],
        input=data.encode(), capture_output=True, check=True).stdout).decode()
def verify(data, sig):
    open(D + "/req.sig", "wb").write(base64.b64decode(sig))
    return subprocess.run(["openssl", "dgst", "-sha256", "-verify", D + "/app-pub.pem", "-signature", D + "/req.sig"],
        input=data.encode(), capture_output=True).returncode == 0
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def answer(self, code, body):
        b = body.encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json;charset=utf-8"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        if u.path == "/control/pay":
            otn = urllib.parse.parse_qs(u.query)["otn"][0]; trades[otn]["status"] = "TRADE_SUCCESS"
            return self.answer(200, "{}")
        p = dict(urllib.parse.parse_qsl(raw, keep_blank_values=True))
        content = "&".join(f"{k}={v}" for k, v in sorted(p.items()) if k != "sign" and v != "")
        if not verify(content, p["sign"]): return self.answer(400, '{"error":"bad request signature"}')
        m = p["method"]; biz = json.loads(p["biz_content"]); otn = biz["out_trade_no"]
        if m == "alipay.trade.precreate":
            trades[otn] = {"total": biz["total_amount"], "status": None}
            obj = {"code": "10000", "msg": "Success", "out_trade_no": otn, "qr_code": "https://qr.alipay.com/smoke" + otn[-6:]}
        elif m == "alipay.trade.query" and trades.get(otn, {}).get("status"):
            t = trades[otn]
            obj = {"code": "10000", "msg": "Success", "out_trade_no": otn, "trade_no": "2026" + otn[-10:],
                   "trade_status": t["status"], "total_amount": t["total"]}
        else:
            obj = {"code": "40004", "msg": "Business Failed", "sub_code": "ACQ.TRADE_NOT_EXIST", "sub_msg": "x"}
        body = json.dumps(obj, separators=(",", ":"))
        self.answer(200, '{"%s_response":%s,"sign":"%s"}' % (m.replace(".", "_"), body, sign(body)))
ThreadingHTTPServer(("127.0.0.1", 18089), H).serve_forever()
PY
pkill -f "^python3 $PAY/mock.py" 2>/dev/null || true
python3 "$PAY/mock.py" "$PAY" >"$LOG/mock-alipay.log" 2>&1 &
MOCK_PID=$!
# Sign Alipay-style notify params (sorted, without sign/sign_type) with the
# mock "Alipay" key; prints the form body.
cat >"$PAY/notify.py" <<'PY'
import base64, subprocess, sys, urllib.parse
d, otn, total, status = sys.argv[1:5]
p = {"app_id": "2021000000000001", "seller_id": "2088000000000001", "out_trade_no": otn,
     "total_amount": total, "trade_status": status, "trade_no": "2026" + otn[-10:],
     "notify_type": "trade_status_sync", "notify_id": "smoke" + otn[-8:], "charset": "utf-8",
     "version": "1.0", "subject": "Akari - smoke 套餐", "notify_time": "2026-10-02 12:00:00"}
content = "&".join(f"{k}={v}" for k, v in sorted(p.items()))
sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", d + "/alipay-key.pem"], input=content.encode(),
                     capture_output=True, check=True).stdout
p["sign_type"] = "RSA2"; p["sign"] = base64.b64encode(sig).decode()
if len(sys.argv) > 5: p["total_amount"] = sys.argv[5]  # tamper after signing
print(urllib.parse.urlencode(p), end="")
PY
"$PANEL" -c "$LOG/panel.toml" serve >"$LOG/panel.log" 2>&1 &
PANEL_PID=$!
trap 'cleanup_upd; kill $PANEL_PID ${AGENT_PID:+$AGENT_PID} $MOCK_PID 2>/dev/null || true' EXIT
# Poll instead of a fixed sleep: migrations run before the listener binds.
for _ in $(seq 1 100); do
  (exec 3<>/dev/tcp/127.0.0.1/8080) 2>/dev/null && break
  kill -0 "$PANEL_PID" 2>/dev/null || { echo "FAIL: panel exited during startup"; cat "$LOG/panel.log"; exit 1; }
  sleep 0.3
done
(exec 3<>/dev/tcp/127.0.0.1/8080) 2>/dev/null || { echo "FAIL: panel not listening"; cat "$LOG/panel.log"; exit 1; }

# Reset AFTER startup: fresh volumes have no tables until the panel migrates,
# and Valkey rate-limit counters would poison the next run's login test.
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "TRUNCATE nodes CASCADE; TRUNCATE users CASCADE;" >/dev/null 2>&1 || true
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "TRUNCATE revoked_certs, traffic_counters, audit_log, agent_releases, rollouts CASCADE;" >/dev/null 2>&1 || true
vk flushdb >/dev/null

echo "== first admin (env password) =="
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" admin add root | tee "$LOG/admin-add.out"
# R18: admin 2FA is optional (recommended); no one-time enrollment code.
grep -q "two-factor authentication is recommended" "$LOG/admin-add.out" || { echo "FAIL: admin add lacks the 2FA hint"; exit 1; }
grep -qE '^  [A-Z2-7]{4}(-[A-Z2-7]{1,4})+$' "$LOG/admin-add.out" && { echo "FAIL: admin add still prints an enrollment code"; exit 1; }
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" admin add root 2>&1 | grep -q "created admin account: root" \
  && { echo "FAIL: duplicate admin creation should error"; exit 1; } || echo "duplicate rejected: ok"

echo "== register node (M1-8: key-less bootstrap with a one-time enrollment token) =="
"$PANEL" node add test-node --out "$BOOT" >/dev/null
NODE_ID=$("$PANEL" node list | awk 'NR==2{print $1}')
grep -q 'PRIVATE KEY' "$BOOT" && { echo "FAIL: bootstrap file contains a private key"; exit 1; }
grep -qE '^enrollment_token = "[A-Za-z0-9_-]{43}"$' "$BOOT" || { echo "FAIL: bootstrap file lacks the enrollment token"; exit 1; }
[ "$(stat -c %a "$BOOT")" = "600" ] || { echo "FAIL: bootstrap file is not 0600"; exit 1; }

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

echo "== M1-6/R18 admin 2FA: optional, enroll voluntarily, log in with a code =="
grep -q '"stage":"full"' /tmp/akari-smoke/last || { echo "FAIL: admin without 2FA did not get a full session (2FA is optional)"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/users")" = "200" ] || { echo "FAIL: admin without 2FA cannot list users"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/me/totp")" = "200" ] || { echo "FAIL: totp status"; exit 1; }
python3 -c "import json;d=json.load(open('/tmp/akari-smoke/last'));assert d['stage']=='full' and d['enabled'] is False and d['admin_2fa_required'] is False and 'enroll_code_required' not in d, d" \
  || { echo "FAIL: totp status (optional 2FA)"; exit 1; }
# A5: the login body is strict JSON (400 + JSON error, not axum's 415/422).
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\",\"extra\":1}")" = "400" ] && grep -q '"error"' /tmp/akari-smoke/last \
  || { echo "FAIL: unknown login field not a 400"; exit 1; }
[ "$(code -X POST "$BASE/auth/login" -d 'not json')" = "400" ] || { echo "FAIL: non-JSON login body not a 400"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/me/totp/enroll" -H 'Content-Type: application/json' -d '{}')" = "200" ] \
  || { echo "FAIL: totp enroll"; cat /tmp/akari-smoke/last; exit 1; }
TOTP_SECRET=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['secret'])")
grep -q 'otpauth://totp/Akari:root?secret=' /tmp/akari-smoke/last || { echo "FAIL: otpauth uri"; exit 1; }
# RFC 6238 code for a time step strictly after the last one used (the
# server refuses replays), waiting for the next step when needed.
cat >"$LOG/totp.py" <<'PY'
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
totp() { python3 "$LOG/totp.py" "$TOTP_SECRET" "$LOG/totp.last"; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/me/totp/confirm" -H 'Content-Type: application/json' -d '{"code":"000000x"}')" = "400" ] \
  || { echo "FAIL: bad confirm code not 400"; exit 1; }
CODE0=$(totp)
# The removed M1c field is refused (unknown field), not silently ignored.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/me/totp/confirm" -H 'Content-Type: application/json' \
    -d "{\"code\":\"$CODE0\",\"enrollment_code\":\"AAAA-BBBB\"}")" = "400" ] || { echo "FAIL: enrollment_code field accepted"; exit 1; }
[ "$(code -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/me/totp/confirm" -H 'Content-Type: application/json' \
    -d "{\"code\":\"$CODE0\"}")" = "200" ] || { echo "FAIL: totp confirm"; cat /tmp/akari-smoke/last; exit 1; }
python3 -c "import json;print('\n'.join(json.load(open('/tmp/akari-smoke/last'))['recovery_codes']))" >"$LOG/recovery"
[ "$(wc -l <"$LOG/recovery")" = "10" ] || { echo "FAIL: 10 recovery codes expected"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/users")" = "200" ] || { echo "FAIL: full session after enrollment"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/me/totp")" = "200" ] && ! grep -q "$TOTP_SECRET" /tmp/akari-smoke/last \
  || { echo "FAIL: totp status leaks the secret"; exit 1; }
login_root() { # code -> http status; session in $JAR
  code -c "$JAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\",\"code\":\"$1\"}"
}
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\"}")" = "401" ] || { echo "FAIL: password-only login of a 2FA admin"; exit 1; }
REJ401=$(cat /tmp/akari-smoke/last)
CODE=$(totp)
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"wrong-password\",\"code\":\"$CODE\"}")" = "401" ] \
  && [ "$(cat /tmp/akari-smoke/last)" = "$REJ401" ] || { echo "FAIL: wrong password + code not the uniform 401"; exit 1; }
[ "$(login_root "$CODE")" = "200" ] || { echo "FAIL: login with a TOTP code"; cat /tmp/akari-smoke/last; exit 1; }
grep -q '"stage":"full"' /tmp/akari-smoke/last || { echo "FAIL: login with code not full"; exit 1; }
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\",\"code\":\"$CODE\"}")" = "401" ] \
  && [ "$(cat /tmp/akari-smoke/last)" = "$REJ401" ] || { echo "FAIL: TOTP code replay accepted"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/users")" = "200" ] || { echo "FAIL: admin API after TOTP login"; exit 1; }
echo "2fa: ok (enrolled, code login, replay refused)"

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
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' \
    -d '{"inbounds":[{"tag":"in-vless","listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"sniffing":{"enabled":true,"destOverride":["fakedns"]}}]}')" = "400" ] \
  || { echo "FAIL: fakedns inbound not rejected"; exit 1; }
# W8: the protocol matrix is validated (Vision only on raw TCP + TLS/REALITY).
# gRPC is accepted again since R26 (exercised in the W8 section below).
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' \
    -d '{"inbounds":[{"tag":"in-vless","listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none","flow":"xtls-rprx-vision"},"streamSettings":{"network":"ws"}}]}')" = "400" ] \
  || { echo "FAIL: vision over ws not rejected"; exit 1; }
grep -q 'xtls-rprx-vision needs' /tmp/akari-smoke/last || { echo "FAIL: vision rejection lacks the reason"; exit 1; }
code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
grep -q '"warnings":\[\]' /tmp/akari-smoke/last || { echo "FAIL: node view lacks empty warnings"; exit 1; }

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

echo "== subscription: REALITY inbound carries a uTLS fingerprint (default + admin hint) =="
# Throwaway REALITY inbound + user; the panel only reads publicKey/fingerprint
# for subscriptions (the keys here are never used by a client).
RKEY=$(python3 -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('='))")
reality_inbounds() { # $1 = extra realitySettings JSON members (leading comma) or empty
  printf '{"inbounds":[{"tag":"in-vless","listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp"}},{"tag":"in-reality","listen":"127.0.0.1","port":11445,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"dest":"www.apple.com:443","serverNames":["www.apple.com"],"privateKey":"%s","publicKey":"%s","shortIds":["ab12"],"shortId":"ab12"%s}}}]}' "$RKEY" "$RKEY" "$1"
}
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-fp","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create fp user"; cat /tmp/akari-smoke/last; exit 1; }
FP_USER=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
FP_SUB="$BASE/sub/$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['sub_token'])")"
check_fp() { # $1 = expected fingerprint
  curl -s --noproxy '*' "$FP_SUB" | base64 -d 2>/dev/null | grep -q "security=reality.*&fp=$1" \
    || { echo "FAIL: link lacks fp=$1"; exit 1; }
  curl -s --noproxy '*' -A "clash-meta/1.19" "$FP_SUB" | grep -q "^    client-fingerprint: $1" \
    || { echo "FAIL: clash lacks client-fingerprint $1"; exit 1; }
  curl -s --noproxy '*' -A "sing-box/1.12.0" "$FP_SUB" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); u=[o['tls']['utls'] for o in d['outbounds'] if o.get('tls',{}).get('reality')][0]; assert u=={'enabled':True,'fingerprint':'$1'}, u" \
    || { echo "FAIL: sing-box lacks tls.utls $1"; exit 1; }
}
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' -d "$(reality_inbounds '')")" = "200" ] \
  || { echo "FAIL: put reality inbound"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$FP_USER/nodes/$NODE_ID" -H 'Content-Type: application/json' \
    -d '{"inbound_tag":"in-reality","protocol":"vless"}')" = "201" ] || { echo "FAIL: assign reality account"; cat /tmp/akari-smoke/last; exit 1; }
check_fp chrome
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' -d "$(reality_inbounds ',"fingerprint":"firefox"')")" = "200" ] \
  || { echo "FAIL: put reality inbound with fingerprint"; exit 1; }
check_fp firefox
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$FP_USER")" = "204" ] || { echo "FAIL: delete fp user"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' \
    -d '{"inbounds":[{"tag":"in-vless","listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp"}}]}')" = "200" ] \
  || { echo "FAIL: restore inbounds"; exit 1; }
echo "reality fingerprint: ok"

echo "== M1-9 self-service sub token; M1-10 over the limit = the canonical rejection =="
UJAR="$LOG/user-cookies"
[ "$(code -c "$UJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-user","password":"user-password-123"}')" = "200" ] || { echo "FAIL: user login"; exit 1; }
[ "$(code -b "$UJAR" -X POST "$BASE/api/v1/me/sub-token" -H 'Content-Type: application/json' -d '{}')" = "200" ] \
  || { echo "FAIL: self-service sub token"; cat /tmp/akari-smoke/last; exit 1; }
NEW_TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['sub_token'])")
[ "$(fp "$SUB")" = "$REJ" ] || { echo "FAIL: old subscription URL still answers differently"; exit 1; }
SUB="$BASE/sub/$NEW_TOKEN"
# rate_per_token = 8 per window (smoke panel.toml): 5 fetches above + 3 here.
for i in 1 2 3; do
  [ "$(code -A "clash-meta/1.19" "$SUB")" = "200" ] || { echo "FAIL: new subscription URL fetch $i"; exit 1; }
done
[ "$(fp "$SUB")" = "$REJ" ] || { echo "FAIL: over-limit subscription is not the canonical rejection"; cat /tmp/akari-smoke/fphead; exit 1; }
[ "$(fp -A "clash-meta/1.19" "$SUB")" = "$REJ" ] || { echo "FAIL: over-limit (clash UA) differs"; exit 1; }
echo "sub token + rate limit: ok"

echo "== start agent: initial snapshot =="
"$AGENT" -config "$BOOT" -state-dir "$LOG/state-main" >"$LOG/agent.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 60); do grep -q "channel established" "$LOG/agent.log" && break; sleep 0.5; done
grep -q '"msg":"enrolled"' "$LOG/agent.log" || { echo "FAIL: agent did not enroll"; cat "$LOG/agent.log"; exit 1; }
grep -q "channel established" "$LOG/agent.log" || { echo "FAIL: agent channel"; exit 1; }
for f in identity.pem enrolled.token.sha256; do
  [ "$(stat -c %a "$LOG/state-main/$f")" = "600" ] || { echo "FAIL: agent state file $f is not 0600"; exit 1; }
done
[ -e "$LOG/state-main/enroll.key.pem" ] && { echo "FAIL: enrollment key left behind"; exit 1; }
TOKEN=$(sed -n 's/^enrollment_token = "\(.*\)"$/\1/p' "$BOOT")
grep -qF "$TOKEN" "$LOG/agent.log" "$LOG/panel.log" && { echo "FAIL: enrollment token in a log"; exit 1; }
grep -q 'PRIVATE KEY' "$LOG/agent.log" "$LOG/panel.log" && { echo "FAIL: key material in a log"; exit 1; }
grep -q '"users":1' "$LOG/agent.log" || { echo "FAIL: initial snapshot without 1 user"; cat "$LOG/agent.log"; exit 1; }

echo "== disable user: expect instant push =="
[ "$(code -b "$JAR" -X PATCH "$BASE/api/v1/users/$USER_ID" -H 'Content-Type: application/json' \
    -d '{"enabled": false}')" = "200" ] || { echo "FAIL: disable user failed"; exit 1; }
for _ in $(seq 1 30); do grep -q '"users":0' "$LOG/agent.log" && break; sleep 0.5; done
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
# R21: an expired user still logs in, with the renewal scope only.
EJAR="$LOG/expired-cookies"
[ "$(code -c "$EJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-user","password":"user-password-123"}')" = "200" ] && grep -q '"expired":true' /tmp/akari-smoke/last \
  || { echo "FAIL: expired user cannot log in (R21)"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$EJAR" "$BASE/api/v1/me")" = "200" ] && grep -q '"expired":true' /tmp/akari-smoke/last \
  || { echo "FAIL: expired user /me"; exit 1; }
[ "$(code -b "$EJAR" "$BASE/api/v1/me/plan")" = "200" ] || { echo "FAIL: expired user /me/plan"; exit 1; }
[ "$(code -b "$EJAR" -X POST "$BASE/api/v1/me/sub-token" -H 'Content-Type: application/json' -d '{}')" = "401" ] \
  || { echo "FAIL: expired user regenerated the subscription token"; exit 1; }
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

echo "== W9: Shadowsocks 2022 removal/re-add = UserDelta (agent protocol >= 5), Snapshot before =="
# Agents of protocol >= 5 keep a removed SS2022 credential as a gate-refused
# tombstone (indices never move), so the panel sends removals and re-adds
# on a Shadowsocks node as deltas; older agents get a Snapshot (W8 rule).
SS_PSK=$(python3 -c "import base64,os;print(base64.b64encode(os.urandom(16)).decode())")
SS_INB="{\"inbounds\":[{\"tag\":\"in-vless\",\"listen\":\"127.0.0.1\",\"port\":11443,\"protocol\":\"vless\",\"settings\":{\"clients\":[],\"decryption\":\"none\"},\"streamSettings\":{\"network\":\"tcp\"}},{\"tag\":\"in-ss\",\"listen\":\"127.0.0.1\",\"port\":11445,\"protocol\":\"shadowsocks\",\"settings\":{\"method\":\"2022-blake3-aes-128-gcm\",\"password\":\"$SS_PSK\",\"clients\":[],\"network\":\"tcp\"}}]}"
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' -d "$SS_INB")" = "200" ] \
  || { echo "FAIL: put shadowsocks inbounds"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-user-ss","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create SS user"; exit 1; }
USER_SS=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_SS/nodes/$NODE_ID" -H 'Content-Type: application/json' \
    -d '{"inbound_tag":"in-ss","protocol":"shadowsocks"}')" = "201" ] || { echo "FAIL: assign SS user"; cat /tmp/akari-smoke/last; exit 1; }
wait_users 2 15 "SS user added"
for _ in $(seq 1 10); do [ "$(node_field last_error)" = "null" ] && break; sleep 1; done
SS_PROTO=$(node_field agent_protocol)
snaps() { grep -c '"msg":"applying config snapshot"' "$LOG/agent.log"; }
last_via() { grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['via'])"; }
SS_SNAPS=$(snaps)
[ "$(patch_code "$BASE/api/v1/users/$USER_SS" '{"enabled": false}')" = "200" ] || { echo "FAIL: disable SS user"; exit 1; }
wait_users 1 15 "SS user disabled"
if [ "$SS_PROTO" -ge 5 ]; then
  [ "$(snaps)" = "$SS_SNAPS" ] && [ "$(last_via)" = "delta" ] \
    || { echo "FAIL: SS removal was not a delta on a protocol $SS_PROTO agent"; grep 'state applied' "$LOG/agent.log" | tail -2; exit 1; }
  grep -q 'shadowsocks credential change' "$LOG/agent.log" && { echo "FAIL: agent refused an SS delta"; exit 1; }
  [ "$(patch_code "$BASE/api/v1/users/$USER_SS" '{"enabled": true}')" = "200" ] || { echo "FAIL: re-enable SS user"; exit 1; }
  wait_users 2 15 "SS user re-enabled"
  [ "$(snaps)" = "$SS_SNAPS" ] && [ "$(last_via)" = "delta" ] \
    || { echo "FAIL: SS re-add (tombstone revival) was not a delta"; grep 'state applied' "$LOG/agent.log" | tail -2; exit 1; }
  echo "shadowsocks: removal and re-add applied as deltas (agent protocol $SS_PROTO, no rebuild)"
else
  [ "$(snaps)" -gt "$SS_SNAPS" ] || { echo "FAIL: SS removal on a protocol $SS_PROTO agent was not a Snapshot"; exit 1; }
  echo "shadowsocks: removal is a Snapshot (agent protocol $SS_PROTO < 5)"
fi
[ "$(node_field last_error)" = "null" ] || { echo "FAIL: last_error after SS changes: $(node_field last_error)"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$USER_SS")" = "204" ] || { echo "FAIL: delete SS user"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' -d "$GOOD_INB")" = "200" ] \
  || { echo "FAIL: restore inbounds after SS"; exit 1; }
wait_users 1 15 "after SS inbound removed"
wait_port open 10

echo "== Sprint 3a: protocol + lease surfaced on the node =="
[ "$(node_field agent_protocol)" -ge 3 ] || { echo "FAIL: agent_protocol $(node_field agent_protocol)"; exit 1; }
LEASE=$(node_field lease_remaining_seconds)
[ "$LEASE" != "null" ] && [ "$LEASE" -gt 80000 ] || { echo "FAIL: lease_remaining_seconds '$LEASE'"; exit 1; }
echo "lease: ok (${LEASE}s left)"

echo "== node online + heartbeat =="
STATUS=$(docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -tAc "SELECT status FROM nodes WHERE id='$NODE_ID'")
[ "$STATUS" = "online" ] || { echo "FAIL: node status '$STATUS'"; exit 1; }
vk exists "akari:node:online:$NODE_ID" | grep -q 1 \
  || { echo "FAIL: online key missing"; exit 1; }

echo "== S4-1 login rate limit: failures only, per client; XFF only from trusted proxies =="
login_code() { # extra curl args..., then login, password (last two)
  local n=$#; local pw="${!n}"; local lg="${@:$((n-1)):1}"
  code "${@:1:$((n-2))}" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"$lg\",\"password\":\"$pw\"}"
}
rl_clear() {
  vk EVAL \
    "for _,k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1" 0 'akari:rl:*' >/dev/null
}
rl_clear
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"rl-user","password":"rl-user-password"}')" = "201" ] || { echo "FAIL: create rl-user"; exit 1; }
# Successful logins never count.
for _ in $(seq 1 25); do
  [ "$(login_code rl-user rl-user-password)" = "200" ] || { echo "FAIL: successful logins were rate limited"; exit 1; }
done
# A direct client (untrusted peer 127.0.0.1) rotating X-Forwarded-For stays
# in its own bucket.
for i in $(seq 1 20); do
  [ "$(login_code -H "X-Forwarded-For: 198.51.100.$i" rl-direct nope)" = "401" ] || { echo "FAIL: bad login $i not 401"; exit 1; }
done
[ "$(login_code -H 'X-Forwarded-For: 203.0.113.250' rl-user rl-user-password)" = "429" ] \
  || { echo "FAIL: X-Forwarded-For from an untrusted peer escaped the rate limit"; exit 1; }
# Behind the trusted proxy each forwarded client has its own bucket.
for i in $(seq 1 20); do
  [ "$(login_code --interface 127.0.0.2 -H 'X-Forwarded-For: 203.0.113.7' rl-proxied nope)" = "401" ] \
    || { echo "FAIL: proxied bad login $i not 401"; exit 1; }
done
[ "$(login_code --interface 127.0.0.2 -H 'X-Forwarded-For: 203.0.113.7' rl-user rl-user-password)" = "429" ] \
  || { echo "FAIL: proxied client 203.0.113.7 not limited"; exit 1; }
[ "$(login_code --interface 127.0.0.2 -H 'X-Forwarded-For: 203.0.113.7, 203.0.113.8' rl-user rl-user-password)" = "200" ] \
  || { echo "FAIL: another client behind the proxy was locked out"; exit 1; }
[ "$(login_code --interface 127.0.0.2 -H 'X-Forwarded-For: 203.0.113.8, 203.0.113.7' rl-user rl-user-password)" = "429" ] \
  || { echo "FAIL: a forged left-hand XFF hop escaped the limit"; exit 1; }
rl_clear
echo "rate limit: ok"

echo "== delete user: node converges to users=0 =="
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$USER_ID")" = "204" ] || { echo "FAIL: delete user"; exit 1; }
wait_users 0 10 "delete user"
echo "delete user: ok"

echo "== M3 operations model: group + plan -> automatic access; quota; period reset; cancel =="
psql_q() { docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -tAc "$1"; }
last_json() { python3 -c "import json,sys; d=json.load(open('/tmp/akari-smoke/last')); print($1)"; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"region": "Smokeland"}')" = "200" ] || { echo "FAIL: set region"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/node-groups" -H 'Content-Type: application/json' \
    -d "{\"name\":\"smoke-group\",\"node_ids\":[\"$NODE_ID\"]}")" = "201" ] || { echo "FAIL: create group"; cat /tmp/akari-smoke/last; exit 1; }
GROUP_ID=$(last_json "d['id']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/node-groups" -H 'Content-Type: application/json' \
    -d '{"name":"x","nodes":[]}')" = "400" ] || { echo "FAIL: unknown group field not 400"; exit 1; }
[ "$(patch_code "$BASE/api/v1/node-groups/$GROUP_ID" '{"node_ids": null}')" = "400" ] || { echo "FAIL: node_ids null not 400"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/plans" -H 'Content-Type: application/json' \
    -d '{"name":"smoke-plan","traffic_quota_bytes":150000,"period":"weekly"}')" = "400" ] || { echo "FAIL: bad period not 400"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/plans" -H 'Content-Type: application/json' \
    -d "{\"name\":\"smoke-plan\",\"traffic_quota_bytes\":150000,\"period\":\"monthly\",\"speed_limit_mbps\":100,\"group_ids\":[\"$GROUP_ID\"]}")" = "201" ] \
  || { echo "FAIL: create plan"; cat /tmp/akari-smoke/last; exit 1; }
PLAN_ID=$(last_json "d['id']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-plan-user","password":"plan-password-123"}')" = "201" ] || { echo "FAIL: create plan user"; exit 1; }
PU=$(last_json "d['id']")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/users/$PU/plan" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PLAN_ID\"}")" = "200" ] || { echo "FAIL: assign plan"; cat /tmp/akari-smoke/last; exit 1; }
wait_users 1 10 "plan grants the node (no manual assignment)"
[ "$(psql_q "SELECT manual FROM node_users WHERE user_id='$PU' AND node_id='$NODE_ID'")" = "f" ] \
  || { echo "FAIL: plan row not plan-managed"; exit 1; }
[ "$(psql_q "SELECT traffic_limit_bytes FROM users WHERE id='$PU'")" = "150000" ] || { echo "FAIL: limit not derived from the plan"; exit 1; }
[ "$(patch_code "$BASE/api/v1/users/$PU" '{"traffic_limit_bytes": 1}')" = "409" ] || { echo "FAIL: plan-managed limit editable"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$PU/nodes/$NODE_ID")" = "409" ] || { echo "FAIL: plan row unassignable"; exit 1; }
# R18: per-user node access view (no credentials in it).
[ "$(code -b "$JAR" "$BASE/api/v1/users/$PU/nodes")" = "200" ] || { echo "FAIL: user nodes view"; exit 1; }
python3 -c "import json; d=json.load(open('/tmp/akari-smoke/last')); r=[x for x in d if x['node_id']=='$NODE_ID'][0]; assert r['manual'] is False and r['inbounds'] and 'account' not in json.dumps(d), d" \
  || { echo "FAIL: user nodes view content"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/users/00000000-0000-0000-0000-000000000000/nodes")" = "404" ] || { echo "FAIL: user nodes of no user not 404"; exit 1; }
code -b "$JAR" "$BASE/api/v1/users" >/dev/null
python3 -c "import json; u=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$PU'][0]; assert u['plan_name']=='smoke-plan' and u['next_reset_at']" \
  || { echo "FAIL: users list lacks plan/reset"; exit 1; }
PJAR="$LOG/plan-user-cookies"
[ "$(code -c "$PJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-plan-user","password":"plan-password-123"}')" = "200" ] || { echo "FAIL: plan user login"; exit 1; }
[ "$(code -b "$PJAR" "$BASE/api/v1/me/plan")" = "200" ] || { echo "FAIL: /me/plan"; exit 1; }
python3 -c "import json; d=json.load(open('/tmp/akari-smoke/last')); assert d['plan']['name']=='smoke-plan' and d['plan']['period']=='monthly' and d['plan']['next_reset_at'] and d['nodes']==[{'name':'test-node','region':'Smokeland'}], d" \
  || { echo "FAIL: /me/plan content"; cat /tmp/akari-smoke/last; exit 1; }
grep -q "$NODE_ID" /tmp/akari-smoke/last && { echo "FAIL: /me/plan exposes node ids"; exit 1; }
[ "$(code -b "$PJAR" "$BASE/api/v1/plans")" = "403" ] || { echo "FAIL: user reached the plans API"; exit 1; }
[ "$(code -b "$PJAR" -X POST "$BASE/api/v1/me/password" -H 'Content-Type: application/json' \
    -d '{"current_password":"wrong-password","new_password":"plan-password-456"}')" = "400" ] || { echo "FAIL: wrong current password not 400"; exit 1; }
cp "$PJAR" "$LOG/plan-user-old-cookies"
[ "$(code -b "$PJAR" -c "$PJAR" -X POST "$BASE/api/v1/me/password" -H 'Content-Type: application/json' \
    -d '{"current_password":"plan-password-123","new_password":"plan-password-456"}')" = "204" ] || { echo "FAIL: change password"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$PJAR" "$BASE/api/v1/me")" = "200" ] || { echo "FAIL: session lost after own password change"; exit 1; }
[ "$(code -b "$LOG/plan-user-old-cookies" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: old session survived the password change"; exit 1; }
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-plan-user","password":"plan-password-456"}')" = "200" ] || { echo "FAIL: login with the new password"; exit 1; }
# Over quota: ~200 kB of VLESS traffic against a 150 kB plan.
cat >"$LOG/vless1.py" <<'PY'
import socket, struct, sys, threading, uuid
echo = socket.socket(); echo.bind(("127.0.0.1", 0)); echo.listen(1)
def serve():
    c, _ = echo.accept()
    for d in iter(lambda: c.recv(65536), b""): c.sendall(d)
threading.Thread(target=serve, daemon=True).start()
s = socket.create_connection(("127.0.0.1", 11443), timeout=5)
s.sendall(b"\x00" + uuid.UUID(sys.argv[1]).bytes + b"\x00\x01" + struct.pack(">H", echo.getsockname()[1]) + b"\x01" + socket.inet_aton("127.0.0.1"))
msg = b"x" * 100000; s.sendall(msg); got = b""
while len(got) < len(msg) + 2:
    d = s.recv(65536)
    if not d: sys.exit("closed")
    got += d
print("vless round trip ok")
PY
wait_port open 10
PU_VLESS=$(psql_q "SELECT credentials->0->'account'->>'id' FROM node_users WHERE user_id='$PU' AND node_id='$NODE_ID'")
python3 "$LOG/vless1.py" "$PU_VLESS" || { echo "FAIL: vless round trip for the plan user"; exit 1; }
for _ in $(seq 1 30); do
  [ "$(psql_q "SELECT disabled_reason FROM users WHERE id='$PU'")" = "quota" ] && break; sleep 1
done
[ "$(psql_q "SELECT enabled::text || '/' || disabled_reason FROM users WHERE id='$PU'")" = "false/quota" ] \
  || { echo "FAIL: over-quota user not disabled for quota: $(psql_q "SELECT traffic_used_bytes, enabled, disabled_reason FROM users WHERE id='$PU'")"; exit 1; }
wait_users 0 10 "over quota"
# R21: a quota-disabled user logs in with the renewal scope only.
QJAR="$LOG/quota-cookies"
[ "$(code -c "$QJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-plan-user","password":"plan-password-456"}')" = "200" ] && grep -q '"quota_exhausted":true' /tmp/akari-smoke/last \
  || { echo "FAIL: quota-disabled user cannot log in (R21)"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$QJAR" "$BASE/api/v1/me/plan")" = "200" ] || { echo "FAIL: quota-disabled user /me/plan"; exit 1; }
[ "$(code -b "$QJAR" -X POST "$BASE/api/v1/me/sub-token" -H 'Content-Type: application/json' -d '{}')" = "401" ] \
  || { echo "FAIL: quota-disabled user regenerated the subscription token"; exit 1; }
# The period boundary passes (simulated): the reset pass zeroes usage and
# re-enables the quota-disabled user, audited as 'system'.
psql_q "UPDATE user_plans SET next_reset_at = now() - interval '1 second' WHERE user_id='$PU' AND status='active'" >/dev/null
for _ in $(seq 1 20); do
  [ "$(psql_q "SELECT enabled FROM users WHERE id='$PU'")" = "t" ] && break; sleep 1
done
[ "$(psql_q "SELECT enabled::text || '/' || traffic_used_bytes FROM users WHERE id='$PU'")" = "true/0" ] \
  || { echo "FAIL: period reset did not re-enable/zero: $(psql_q "SELECT traffic_used_bytes, enabled, disabled_reason FROM users WHERE id='$PU'")"; exit 1; }
[ "$(psql_q "SELECT next_reset_at > now() FROM user_plans WHERE user_id='$PU' AND status='active'")" = "t" ] || { echo "FAIL: reset marker not advanced"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='user.traffic.reset' AND actor_login='system' AND target_id='$PU'")" = "1" ] \
  || { echo "FAIL: reset not audited once as system"; exit 1; }
wait_users 1 10 "period reset re-enabled"
# Admin-disabled users are never re-enabled by a reset.
[ "$(patch_code "$BASE/api/v1/users/$PU" '{"enabled": false}')" = "200" ] || { echo "FAIL: admin disable"; exit 1; }
wait_users 0 10 "admin disabled"
psql_q "UPDATE user_plans SET next_reset_at = now() - interval '1 second' WHERE user_id='$PU' AND status='active'" >/dev/null
for _ in $(seq 1 20); do
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='user.traffic.reset' AND target_id='$PU'")" = "2" ] && break; sleep 1
done
[ "$(psql_q "SELECT enabled::text || '/' || disabled_reason FROM users WHERE id='$PU'")" = "false/admin" ] \
  || { echo "FAIL: reset re-enabled an admin-disabled user"; exit 1; }
[ "$(patch_code "$BASE/api/v1/users/$PU" '{"enabled": true}')" = "200" ] || { echo "FAIL: admin enable"; exit 1; }
wait_users 1 10 "admin re-enabled"
# Cancel: plan access removed (departed row for the final counters).
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/plans/$PLAN_ID")" = "409" ] || { echo "FAIL: plan with a subscriber deleted"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$PU/plan")" = "204" ] || { echo "FAIL: cancel plan"; exit 1; }
wait_users 0 10 "plan cancelled"
[ "$(psql_q "SELECT count(*) FROM node_users_departed WHERE user_id='$PU' AND node_id='$NODE_ID'")" = "1" ] \
  || { echo "FAIL: no departed row after cancel"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$PU/plan")" = "404" ] || { echo "FAIL: second cancel not 404"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/audit?action=user.plan.&limit=10")" = "200" ] || { echo "FAIL: audit user.plan."; exit 1; }
for a in user.plan.set user.plan.cancel; do
  grep -q "\"action\":\"$a\"" /tmp/akari-smoke/last || { echo "FAIL: audit lacks $a"; exit 1; }
done
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/plans/$PLAN_ID")" = "204" ] || { echo "FAIL: delete plan"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/node-groups/$GROUP_ID")" = "204" ] || { echo "FAIL: delete group"; exit 1; }
for a in plan.create plan.delete group.create group.delete; do
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='$a'")" -ge 1 ] || { echo "FAIL: audit lacks $a"; exit 1; }
done
echo "m3: ok (plan access, quota disable, reset re-enable, cancel)"

echo "== R18-3 Alipay F2F: price -> order (precreate) -> signed notify -> plan + node access; replay no-op; bad notify = rejection =="
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/node-groups" -H 'Content-Type: application/json' \
    -d "{\"name\":\"paid-group\",\"node_ids\":[\"$NODE_ID\"]}")" = "201" ] || { echo "FAIL: create paid group"; exit 1; }
PAID_GROUP=$(last_json "d['id']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/plans" -H 'Content-Type: application/json' \
    -d "{\"name\":\"paid-plan\",\"period\":\"monthly\",\"group_ids\":[\"$PAID_GROUP\"]}")" = "201" ] || { echo "FAIL: create paid plan"; exit 1; }
PAID_PLAN=$(last_json "d['id']")
PRICES="$BASE/api/v1/plans/$PAID_PLAN/prices"
[ "$(code -b "$JAR" -X PUT "$PRICES" -H 'Content-Type: application/json' \
    -d '{"on_sale":true,"prices":[{"period":"days","days":30,"price_cents":0}]}')" = "400" ] || { echo "FAIL: zero price accepted"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$PRICES" -H 'Content-Type: application/json' \
    -d '{"on_sale":true,"prices":[{"period":"weekly","price_cents":1}]}')" = "400" ] || { echo "FAIL: unknown period accepted"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$PRICES" -H 'Content-Type: application/json' \
    -d '{"on_sale":true,"prices":[{"period":"reset","price_cents":1}]}')" = "400" ] || { echo "FAIL: on sale with only a reset pack"; exit 1; }
# W7: one price per period kind; the 1-cent 30-day price drives the flow below.
[ "$(code -b "$JAR" -X PUT "$PRICES" -H 'Content-Type: application/json' \
    -d '{"on_sale":true,"prices":[{"period":"days","days":30,"price_cents":1},{"period":"month","price_cents":2},{"period":"reset","price_cents":3}]}')" = "204" ] \
  || { echo "FAIL: set prices"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/plan-prices")" = "200" ] && last_json "d['payments_enabled']" | grep -q True \
  || { echo "FAIL: plan-prices / payments not enabled"; cat /tmp/akari-smoke/last; exit 1; }
python3 -c "import json; d=json.load(open('/tmp/akari-smoke/last')); p=[x for x in d['plans'] if x['plan_id']=='$PAID_PLAN'][0]; assert p['on_sale'] and len(p['prices'])==3, d" \
  || { echo "FAIL: plan-prices content"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(patch_code "$BASE/api/v1/plans/$PAID_PLAN" '{"description":"Smoke\n- fast","capacity":5,"allow_switch_in":true}')" = "200" ] \
  && [ "$(last_json "d['capacity']")" = "5" ] || { echo "FAIL: plan catalogue fields"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-buyer","password":"buyer-password-123"}')" = "201" ] || { echo "FAIL: create buyer"; exit 1; }
BUYER=$(last_json "d['id']")
BJAR="$LOG/buyer-cookies"
[ "$(code -c "$BJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-buyer","password":"buyer-password-123"}')" = "200" ] || { echo "FAIL: buyer login"; exit 1; }
[ "$(code -b "$BJAR" "$BASE/api/v1/me/shop")" = "200" ] || { echo "FAIL: shop"; exit 1; }
python3 -c "
import json; d=json.load(open('/tmp/akari-smoke/last')); p=[x for x in d['plans'] if x['plan_id']=='$PAID_PLAN'][0]
o={x['period']: x for x in p['offers']}
assert d['enabled'] and p['description']=='Smoke\n- fast' and p['remaining']==5, d
assert sorted(o)==['days','month'] and o['days']['price_cents']==1 and o['days']['amount_cents']==1 and o['days']['action']=='new', d
" || { echo "FAIL: shop content"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$BJAR" -X POST "$BASE/api/v1/me/orders" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PAID_PLAN\",\"period\":\"reset\"}")" = "409" ] || { echo "FAIL: reset pack sold to a non-subscriber"; exit 1; }
[ "$(code -b "$BJAR" -X POST "$BASE/api/v1/me/orders" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PAID_PLAN\",\"period\":\"days\",\"amount_cents\":0}")" = "400" ] || { echo "FAIL: client amount accepted"; exit 1; }
[ "$(code -b "$BJAR" -X POST "$BASE/api/v1/me/orders" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PAID_PLAN\"}")" = "400" ] || { echo "FAIL: order without a period accepted"; exit 1; }
[ "$(code -b "$BJAR" -X POST "$BASE/api/v1/me/orders" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PAID_PLAN\",\"period\":\"days\"}")" = "201" ] || { echo "FAIL: create order"; cat /tmp/akari-smoke/last "$LOG/mock-alipay.log"; exit 1; }
[ "$(last_json "d['period']")/$(last_json "d['credit_cents']")/$(last_json "d['list_price_cents']")" = "days/0/1" ] \
  || { echo "FAIL: order period/credit"; cat /tmp/akari-smoke/last; exit 1; }
ORDER=$(last_json "d['id']"); OTN=$(last_json "d['out_trade_no']")
last_json "d['qr_code']" | grep -q '^https://qr.alipay.com/smoke' || { echo "FAIL: no QR from precreate"; exit 1; }
[ "$(last_json "d['status']")" = "pending" ] || { echo "FAIL: new order not pending"; exit 1; }
NOTIFY="$BASE/pay/alipay/notify"
# Tampered amount (signature no longer matches) / wrong amount (validly
# signed): both the canonical rejection; nothing fulfilled.
[ "$(fp -X POST "$NOTIFY" --data-binary "$(python3 "$PAY/notify.py" "$PAY" "$OTN" 0.01 TRADE_SUCCESS 0.02)")" = "$REJ" ] \
  || { echo "FAIL: bad-signature notify not the canonical rejection"; cat /tmp/akari-smoke/fphead; exit 1; }
[ "$(fp -X POST "$NOTIFY" --data-binary "$(python3 "$PAY/notify.py" "$PAY" "$OTN" 0.02 TRADE_SUCCESS)")" = "$REJ" ] \
  || { echo "FAIL: wrong-amount notify not the canonical rejection"; exit 1; }
[ "$(fp "$NOTIFY")" = "$REJ" ] || { echo "FAIL: GET notify not the canonical rejection"; exit 1; }
[ "$(psql_q "SELECT status FROM orders WHERE id='$ORDER'")" = "pending" ] || { echo "FAIL: rejected notify changed the order"; exit 1; }
GOOD_NOTIFY=$(python3 "$PAY/notify.py" "$PAY" "$OTN" 0.01 TRADE_SUCCESS)
[ "$(curl -s --noproxy '*' -X POST "$NOTIFY" --data-binary "$GOOD_NOTIFY")" = "success" ] \
  || { echo "FAIL: valid notify not acknowledged"; tail -5 "$LOG/panel.log"; exit 1; }
[ "$(code -b "$BJAR" "$BASE/api/v1/me/orders/$ORDER")" = "200" ] || { echo "FAIL: order status"; exit 1; }
python3 -c "import json; d=json.load(open('/tmp/akari-smoke/last')); assert d['status']=='paid' and d['fulfilled'] and d['qr_code'] is None, d" \
  || { echo "FAIL: order not paid+fulfilled"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT plan_id FROM user_plans WHERE user_id='$BUYER' AND status='active'")" = "$PAID_PLAN" ] || { echo "FAIL: plan not active"; exit 1; }
wait_users 1 10 "purchased plan grants the node"
BUYER_VLESS=$(psql_q "SELECT credentials->0->'account'->>'id' FROM node_users WHERE user_id='$BUYER' AND node_id='$NODE_ID'")
wait_port open 10
python3 "$LOG/vless1.py" "$BUYER_VLESS" || { echo "FAIL: vless round trip for the buyer"; exit 1; }
# Replay: acknowledged, fulfilled exactly once.
[ "$(curl -s --noproxy '*' -X POST "$NOTIFY" --data-binary "$GOOD_NOTIFY")" = "success" ] || { echo "FAIL: replayed notify"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='order.paid' AND target_id='$ORDER'")" = "1" ] || { echo "FAIL: order paid twice"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM user_plans WHERE user_id='$BUYER'")" = "1" ] || { echo "FAIL: plan granted twice"; exit 1; }
[ "$(psql_q "SELECT outcome FROM payment_events WHERE order_id='$ORDER' AND source='notify' AND verified ORDER BY id DESC LIMIT 1")" = "duplicate" ] \
  || { echo "FAIL: replay not logged as duplicate"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM payment_events WHERE params->>'sign' IS NOT NULL AND params->>'sign' <> '<redacted>'")" = "0" ] \
  || { echo "FAIL: a signature was stored"; exit 1; }
# Renewal through the active query (no notify reaches the panel): +30 days.
EXP1=$(psql_q "SELECT extract(epoch FROM expires_at)::bigint FROM user_plans WHERE user_id='$BUYER' AND status='active'")
[ "$(code -b "$BJAR" -X POST "$BASE/api/v1/me/orders" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PAID_PLAN\",\"period\":\"days\"}")" = "201" ] || { echo "FAIL: renewal order"; exit 1; }
ORDER2=$(last_json "d['id']"); OTN2=$(last_json "d['out_trade_no']")
curl -s --noproxy '*' -X POST "http://127.0.0.1:18089/control/pay?otn=$OTN2" >/dev/null
for _ in $(seq 1 10); do
  code -b "$BJAR" "$BASE/api/v1/me/orders/$ORDER2" >/dev/null
  [ "$(last_json "d['status']")" = "paid" ] && break; sleep 1
done
[ "$(last_json "d['status']")" = "paid" ] || { echo "FAIL: polling did not detect the payment"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT paid_via FROM orders WHERE id='$ORDER2'")" = "query" ] || { echo "FAIL: renewal not paid via query"; exit 1; }
EXP2=$(psql_q "SELECT extract(epoch FROM expires_at)::bigint FROM user_plans WHERE user_id='$BUYER' AND status='active'")
[ $((EXP2 - EXP1)) -eq $((30 * 86400)) ] || { echo "FAIL: renewal did not extend by 30 days ($EXP1 -> $EXP2)"; exit 1; }
# W7: a traffic reset pack (current subscribers only): usage to zero, no
# period change; paid through the active query like the renewal.
psql_q "UPDATE users SET traffic_used_bytes = 1000000000000 WHERE id='$BUYER'" >/dev/null
[ "$(code -b "$BJAR" "$BASE/api/v1/me/shop")" = "200" ] || { echo "FAIL: shop (subscriber)"; exit 1; }
python3 -c "
import json; d=json.load(open('/tmp/akari-smoke/last')); p=[x for x in d['plans'] if x['plan_id']=='$PAID_PLAN'][0]
o={x['period']: x for x in p['offers']}
assert p['current'] and o['reset']['action']=='reset' and o['reset']['amount_cents']==3 and o['days']['action']=='renew', d
" || { echo "FAIL: subscriber shop (reset pack / renew)"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$BJAR" -X POST "$BASE/api/v1/me/orders" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PAID_PLAN\",\"period\":\"reset\"}")" = "201" ] || { echo "FAIL: reset pack order"; cat /tmp/akari-smoke/last; exit 1; }
ORDER3=$(last_json "d['id']"); OTN3=$(last_json "d['out_trade_no']")
curl -s --noproxy '*' -X POST "http://127.0.0.1:18089/control/pay?otn=$OTN3" >/dev/null
for _ in $(seq 1 10); do
  code -b "$BJAR" "$BASE/api/v1/me/orders/$ORDER3" >/dev/null
  [ "$(last_json "d['status']")" = "paid" ] && break; sleep 1
done
[ "$(last_json "d['status']")/$(last_json "d['fulfilled']")" = "paid/True" ] || { echo "FAIL: reset pack not paid+fulfilled"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT traffic_used_bytes < 1000000000 FROM users WHERE id='$BUYER'")" = "t" ] || { echo "FAIL: reset pack did not zero the usage"; exit 1; }
[ "$(psql_q "SELECT extract(epoch FROM expires_at)::bigint FROM user_plans WHERE user_id='$BUYER' AND status='active'")" = "$EXP2" ] \
  || { echo "FAIL: reset pack changed the expiry"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='user.traffic.reset' AND target_id='$BUYER' AND after->>'source'='reset_pack'")" = "1" ] \
  || { echo "FAIL: reset pack not audited"; exit 1; }

# W7: plan speed limits are enforced by the agent (protocol 4, per user,
# both directions). A limit change alone is a UserDelta (no xray rebuild)
# and VLESS throughput drops to the limit; removing it restores it.
AGENT_PROTO=$(psql_q "SELECT agent_protocol FROM nodes WHERE id='$NODE_ID'")
cat >"$LOG/vless_rate.py" <<'PY'
import socket, struct, sys, threading, time, uuid
n = int(sys.argv[2])
echo = socket.socket(); echo.bind(("127.0.0.1", 0)); echo.listen(1)
def serve():
    c, _ = echo.accept()
    for d in iter(lambda: c.recv(65536), b""): c.sendall(d)
threading.Thread(target=serve, daemon=True).start()
s = socket.create_connection(("127.0.0.1", 11443), timeout=30)
s.sendall(b"\x00" + uuid.UUID(sys.argv[1]).bytes + b"\x00\x01" + struct.pack(">H", echo.getsockname()[1]) + b"\x01" + socket.inet_aton("127.0.0.1"))
start = time.monotonic()
threading.Thread(target=lambda: s.sendall(b"x" * n), daemon=True).start()
got = 0
while got < n + 2:
    d = s.recv(65536)
    if not d: sys.exit("closed")
    got += len(d)
print("%.3f" % (time.monotonic() - start))
PY
wait_uv() { # wait until the agent applied the node's current user_version; $1 = expected via
  local uv; uv=$(psql_q "SELECT user_version FROM nodes WHERE id='$NODE_ID'")
  for _ in $(seq 1 15); do
    grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | grep -q "\"user_version\":$uv[,}]" && break; sleep 1
  done
  grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | grep -q "\"via\":\"$1\".*\"user_version\":$uv[,}]" \
    || { echo "FAIL: agent did not apply user_version $uv via $1"; grep 'state applied' "$LOG/agent.log" | tail -3; exit 1; }
}
if [ "$AGENT_PROTO" -ge 4 ]; then
  FAST=$(python3 "$LOG/vless_rate.py" "$BUYER_VLESS" 400000) || { echo "FAIL: unlimited transfer"; exit 1; }
  [ "$(patch_code "$BASE/api/v1/plans/$PAID_PLAN" '{"speed_limit_mbps": 1}')" = "200" ] || { echo "FAIL: set speed limit"; exit 1; }
  wait_uv delta
  SLOW=$(python3 "$LOG/vless_rate.py" "$BUYER_VLESS" 400000) || { echo "FAIL: limited transfer"; exit 1; }
  [ "$(patch_code "$BASE/api/v1/plans/$PAID_PLAN" '{"speed_limit_mbps": null}')" = "200" ] || { echo "FAIL: clear speed limit"; exit 1; }
  wait_uv delta
  AGAIN=$(python3 "$LOG/vless_rate.py" "$BUYER_VLESS" 400000) || { echo "FAIL: transfer after clearing the limit"; exit 1; }
  echo "speed limit: unlimited ${FAST}s, 1 Mbps ${SLOW}s (>= ~2.7s expected), cleared ${AGAIN}s for 400 kB each way"
  python3 -c "f,s,a=$FAST,$SLOW,$AGAIN; assert f < 1.5 and 2.0 <= s <= 15 and a < 1.5, (f,s,a)" \
    || { echo "FAIL: speed limit not enforced as expected"; exit 1; }
else
  # An agent older than protocol 4 (the panel CI runs agent main until the
  # agent PR lands) ignores the field: the node must say so.
  [ "$(patch_code "$BASE/api/v1/plans/$PAID_PLAN" '{"speed_limit_mbps": 1}')" = "200" ] || { echo "FAIL: set speed limit"; exit 1; }
  [ "$(code -b "$JAR" "$BASE/api/v1/nodes")" = "200" ] && grep -q "too old to enforce speed limits" /tmp/akari-smoke/last \
    || { echo "FAIL: no warning for an agent that cannot enforce speed limits"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(patch_code "$BASE/api/v1/plans/$PAID_PLAN" '{"speed_limit_mbps": null}')" = "200" ] || { echo "FAIL: clear speed limit"; exit 1; }
  echo "speed limit: SKIPPED throughput check (agent protocol $AGENT_PROTO < 4); NodeView warning present"
fi
# Admin views and audit.
[ "$(code -b "$JAR" "$BASE/api/v1/orders?login=smoke-buyer")" = "200" ] || { echo "FAIL: admin orders"; exit 1; }
[ "$(last_json "len(d)")" = "3" ] || { echo "FAIL: admin order list"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/orders/$ORDER")" = "200" ] || { echo "FAIL: admin order detail"; exit 1; }
[ "$(code -b "$BJAR" "$BASE/api/v1/orders")" = "403" ] || { echo "FAIL: user reached admin orders"; exit 1; }
for a in order.create order.paid plan.price.set user.plan.set user.plan.update; do
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='$a'")" -ge 1 ] || { echo "FAIL: audit lacks $a"; exit 1; }
done
# R21: expired and quota-disabled users (renewal scope) can shop, order,
# poll and cancel; an admin-disabled user cannot.
for who in expired quota; do
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
      -d "{\"login\":\"smoke-renew-$who\",\"password\":\"renew-password-123\"}")" = "201" ] || { echo "FAIL: create $who user"; exit 1; }
  RU=$(last_json "d['id']")
  if [ "$who" = expired ]; then
    psql_q "UPDATE users SET expires_at = now() - interval '1 minute' WHERE id='$RU'" >/dev/null
  else
    psql_q "UPDATE users SET enabled = false, disabled_reason = 'quota' WHERE id='$RU'" >/dev/null
  fi
  RJAR="$LOG/renew-$who-cookies"
  [ "$(code -c "$RJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
      -d "{\"login\":\"smoke-renew-$who\",\"password\":\"renew-password-123\"}")" = "200" ] || { echo "FAIL: $who user login (R21)"; exit 1; }
  [ "$(code -b "$RJAR" "$BASE/api/v1/me/shop")" = "200" ] && [ "$(last_json "d['enabled']")" = "True" ] \
    || { echo "FAIL: $who user cannot list the shop (R21)"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(code -b "$RJAR" -X POST "$BASE/api/v1/me/orders" -H 'Content-Type: application/json' \
      -d "{\"plan_id\":\"$PAID_PLAN\",\"period\":\"days\"}")" = "201" ] || { echo "FAIL: $who user cannot order (R21)"; cat /tmp/akari-smoke/last; exit 1; }
  RO=$(last_json "d['id']")
  [ "$(code -b "$RJAR" "$BASE/api/v1/me/orders/$RO")" = "200" ] && [ "$(last_json "d['status']")" = "pending" ] \
    || { echo "FAIL: $who user cannot poll the order (R21)"; exit 1; }
  [ "$(code -b "$RJAR" "$BASE/api/v1/me/orders")" = "200" ] || { echo "FAIL: $who user order list (R21)"; exit 1; }
  [ "$(code -b "$RJAR" -X POST "$BASE/api/v1/me/orders/$RO/cancel" -H 'Content-Type: application/json' -d '{}')" = "200" ] \
    && [ "$(last_json "d['status']")" = "cancelled" ] || { echo "FAIL: $who user cannot cancel (R21)"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(code -b "$RJAR" -X POST "$BASE/api/v1/me/sub-token" -H 'Content-Type: application/json' -d '{}')" = "401" ] \
    || { echo "FAIL: $who user regenerated the subscription token"; exit 1; }
done
# Disabled by an admin (the quota user's session stays signed with the same
# session_ver: the reason alone must end the renewal scope).
psql_q "UPDATE users SET disabled_reason = 'admin' WHERE id='$RU'" >/dev/null
[ "$(code -b "$RJAR" "$BASE/api/v1/me/shop")" = "401" ] || { echo "FAIL: admin-disabled user listed the shop"; exit 1; }
[ "$(code -b "$RJAR" -X POST "$BASE/api/v1/me/orders" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PAID_PLAN\",\"period\":\"days\"}")" = "401" ] || { echo "FAIL: admin-disabled user ordered"; exit 1; }
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-renew-quota","password":"renew-password-123"}')" = "401" ] || { echo "FAIL: admin-disabled user logged in"; exit 1; }
for who in expired quota; do
  RU=$(psql_q "SELECT id FROM users WHERE login='smoke-renew-$who'")
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$RU")" = "204" ] || { echo "FAIL: delete $who user"; exit 1; }
done
# Clean up for the following sections (the node serves nobody again).
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$BUYER")" = "204" ] || { echo "FAIL: delete buyer"; exit 1; }
wait_users 0 10 "buyer deleted"
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/plans/$PAID_PLAN")" = "204" ] || { echo "FAIL: delete paid plan"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/node-groups/$PAID_GROUP")" = "204" ] || { echo "FAIL: delete paid group"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM orders WHERE user_id IS NULL AND user_login='smoke-buyer' AND plan_id IS NULL")" = "3" ] \
  || { echo "FAIL: orders not kept after user/plan deletion"; exit 1; }
echo "r18-3 payments: ok"

echo "== W8 protocol matrix: every template -> agent -> three subscription formats -> real clients =="
BASE="$BASE" JAR="$JAR" NODE_ID="$NODE_ID" LOG="$LOG" AGENT_LOG="$LOG/agent.log" \
  python3 scripts/smoke-protocols.py || { echo "FAIL: W8 protocol matrix"; tail -20 "$LOG/agent.log"; exit 1; }

echo "== Sprint 3a: a protocol-0 agent gets the empty state and is flagged (N5) =="
OLD_SRC="$LOG/old-agent-src"
mkdir -p "$OLD_SRC"
if git -C "$AGENT_DIR" archive 2b3e7e3 2>/dev/null | tar -x -C "$OLD_SRC" \
    && (cd "$OLD_SRC" && go build -o "$LOG/old-agent" . ) >"$LOG/old-build.log" 2>&1; then
  kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
  # The old agent only reads v1 bootstrap files (key inside): build one from
  # the enrolled identity — the same shape as pre-M1c bootstrap files.
  python3 - "$BOOT" "$LOG/state-main/identity.pem" "$LOG/v1-bootstrap.toml" <<'PY'
import re, sys
boot, ident, out = open(sys.argv[1]).read(), open(sys.argv[2]).read(), sys.argv[3]
key = re.search(r"-----BEGIN PRIVATE KEY-----.*?-----END PRIVATE KEY-----\n", ident, re.S).group(0)
cert = re.search(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----\n", ident, re.S).group(0)
head = "".join(l for l in boot.splitlines(True) if l.startswith(("panel_addr", "server_name")))
q = "'" * 3
ca = re.search(r"ca_pem = '{3}(.*?)'{3}", boot, re.S).group(1)
open(out, "w").write(head + "\n[identity]\nca_pem = %s%s%s\ncert_pem = %s%s%s\nkey_pem = %s%s%s\n" % (q, ca, q, q, cert, q, q, key, q))
PY
  chmod 600 "$LOG/v1-bootstrap.toml"
  "$LOG/old-agent" -config "$LOG/v1-bootstrap.toml" >"$LOG/old-agent.log" 2>&1 &
  AGENT_PID=$!
  for _ in $(seq 1 15); do node_field last_error | grep -q "agent too old" && break; sleep 1; done
  node_field last_error | grep -q "agent too old" || { echo "FAIL: too-old agent not flagged: $(node_field last_error)"; exit 1; }
  [ "$(node_field agent_protocol)" = "0" ] || { echo "FAIL: agent_protocol not 0"; exit 1; }
  for _ in $(seq 1 10); do grep -q '"config_version":0,"user_version":0' "$LOG/old-agent.log" && break; sleep 1; done
  grep '"msg":"applying config snapshot"' "$LOG/old-agent.log" | tail -1 | grep -q '"config_version":0' \
    || { echo "FAIL: old agent did not get the empty state"; cat "$LOG/old-agent.log"; exit 1; }
  wait_port closed 10
  kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
  "$AGENT" -config "$BOOT" -state-dir "$LOG/state-main" >>"$LOG/agent.log" 2>&1 &
  AGENT_PID=$!
  for _ in $(seq 1 15); do [ "$(node_field last_error)" = "null" ] && break; sleep 1; done
  [ "$(node_field last_error)" = "null" ] || { echo "FAIL: too-old flag not cleared by a current agent"; exit 1; }
  wait_port open 10
  echo "old agent: ok (empty state, flagged, cleared after upgrade)"
else
  echo "old agent: SKIPPED (could not build the pinned protocol-0 agent)"; tail -3 "$LOG/old-build.log" 2>/dev/null || true
fi

echo "== Sprint 3b: node delete = empty state, then revoke + close; billing rows kept =="
psql_q() { docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -tAc "$1"; }
# Some billed traffic on the node first (a user C with one VLESS round trip).
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-user-c","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create user C"; exit 1; }
USER_C=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_C/nodes/$NODE_ID" -H 'Content-Type: application/json' \
    -d '{"inbound_tag":"in-vless","protocol":"vless"}')" = "201" ] || { echo "FAIL: assign C"; exit 1; }
VLESS_C=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['account']['id'])")
wait_users 1 10 "user C added"
wait_port open 10
cat >"$LOG/vless1.py" <<'PY'
import socket, struct, sys, threading, uuid
echo = socket.socket(); echo.bind(("127.0.0.1", 0)); echo.listen(1)
def serve():
    c, _ = echo.accept()
    for d in iter(lambda: c.recv(65536), b""): c.sendall(d)
threading.Thread(target=serve, daemon=True).start()
s = socket.create_connection(("127.0.0.1", 11443), timeout=5)
s.sendall(b"\x00" + uuid.UUID(sys.argv[1]).bytes + b"\x00\x01" + struct.pack(">H", echo.getsockname()[1]) + b"\x01" + socket.inet_aton("127.0.0.1"))
msg = b"x" * 100000; s.sendall(msg); got = b""
while len(got) < len(msg) + 2:
    d = s.recv(65536)
    if not d: sys.exit("closed")
    got += d
print("vless round trip ok")
PY
python3 "$LOG/vless1.py" "$VLESS_C" || { echo "FAIL: vless round trip for C"; exit 1; }
for _ in $(seq 1 30); do
  [ "$(psql_q "SELECT count(*) FROM traffic_counters WHERE node_id='$NODE_ID' AND user_id='$USER_C'")" -ge 1 ] && break; sleep 1
done
COUNTERS_BEFORE=$(psql_q "SELECT count(*) FROM traffic_counters WHERE node_id='$NODE_ID'")
[ "$(psql_q "SELECT count(*) FROM traffic_counters WHERE node_id='$NODE_ID' AND user_id='$USER_C'")" -ge 1 ] \
  || { echo "FAIL: user C's traffic never reached traffic_counters"; exit 1; }
[ "$(psql_q "SELECT traffic_used_bytes FROM users WHERE id='$USER_C'")" -ge 200000 ] \
  || { echo "FAIL: user C not billed: $(psql_q "SELECT traffic_used_bytes FROM users WHERE id='$USER_C'")"; exit 1; }
SERIAL=$(psql_q "SELECT cert_serial FROM nodes WHERE id='$NODE_ID'")
wait_port open 10
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/nodes/$NODE_ID")" = "202" ] || { echo "FAIL: delete node not 202"; cat /tmp/akari-smoke/last; exit 1; }
grep -q '"deleting":true' /tmp/akari-smoke/last || { echo "FAIL: delete response"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"enabled": true}')" = "409" ] || { echo "FAIL: deleting node re-enabled"; exit 1; }
wait_users 0 10 "node deleting"
wait_port closed 10
for _ in $(seq 1 40); do
  [ "$(psql_q "SELECT count(*) FROM nodes WHERE id='$NODE_ID'")" = "0" ] && break; sleep 1
done
[ "$(psql_q "SELECT count(*) FROM nodes WHERE id='$NODE_ID'")" = "0" ] || { echo "FAIL: node row not deleted"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM revoked_certs WHERE cert_serial='$SERIAL' AND node_id='$NODE_ID'")" = "1" ] \
  || { echo "FAIL: certificate not tombstoned"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM traffic_counters WHERE node_id='$NODE_ID'")" = "$COUNTERS_BEFORE" ] \
  || { echo "FAIL: billing rows not kept"; exit 1; }
for _ in $(seq 1 15); do grep -q 'node deleted' "$LOG/agent.log" && break; sleep 1; done
grep '"msg":"channel closed"' "$LOG/agent.log" | grep -q 'Unauthenticated desc = node deleted' \
  || { echo "FAIL: agent stream not closed as deleted"; grep 'channel closed' "$LOG/agent.log" | tail -3; exit 1; }
# Reconnects with the same (revoked) certificate: accepted only to be closed.
for _ in $(seq 1 20); do grep -q 'certificate revoked' "$LOG/agent.log" && break; sleep 1; done
grep '"msg":"channel closed"' "$LOG/agent.log" | grep -q 'Unauthenticated desc = certificate revoked' \
  || { echo "FAIL: revoked certificate not closed on reconnect"; grep 'channel closed' "$LOG/agent.log" | tail -3; exit 1; }
port_open && { echo "FAIL: revoked agent serves again"; exit 1; }
vk exists "akari:node:online:$NODE_ID" | grep -q 0 \
  || { echo "FAIL: online key left behind"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/nodes/$NODE_ID")" = "404" ] || { echo "FAIL: second delete not 404"; exit 1; }
code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
grep -q "$NODE_ID" /tmp/akari-smoke/last && { echo "FAIL: deleted node still listed"; exit 1; }
# CLI: an offline node is deleted right away by the running panel.
# `--out -`: bootstrap on stdout (compose flow), progress on stderr.
"$PANEL" node add spare-node --out - >"$LOG/spare-bootstrap.toml" 2>"$LOG/spare-add.err"
grep -q '^enrollment_token = ' "$LOG/spare-bootstrap.toml" || { echo "FAIL: node add --out - lacks bootstrap on stdout"; exit 1; }
grep -q 'node registered' "$LOG/spare-add.err" || { echo "FAIL: node add --out - progress not on stderr"; exit 1; }
grep -q 'node registered' "$LOG/spare-bootstrap.toml" && { echo "FAIL: progress leaked into stdout bootstrap"; exit 1; }
SPARE_ID=$("$PANEL" node list | awk '$2=="spare-node"{print $1}')
"$PANEL" node delete "$SPARE_ID" | grep -q "deletion started" || { echo "FAIL: CLI node delete"; exit 1; }
for _ in $(seq 1 20); do
  [ "$(psql_q "SELECT count(*) FROM nodes WHERE id='$SPARE_ID'")" = "0" ] && break; sleep 1
done
[ "$(psql_q "SELECT count(*) FROM nodes WHERE id='$SPARE_ID'")" = "0" ] || { echo "FAIL: CLI-deleted offline node not reaped"; exit 1; }
# Never enrolled (pending, no certificate): nothing to revoke; its token died
# with the row.
[ "$(psql_q "SELECT count(*) FROM revoked_certs WHERE node_id='$SPARE_ID'")" = "0" ] || { echo "FAIL: pending node left a tombstone"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM node_enrollments WHERE node_id='$SPARE_ID'")" = "0" ] || { echo "FAIL: enrollment token outlived its node"; exit 1; }
kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
AGENT_PID=""
echo "node delete: ok (empty state, revoked, closed; $COUNTERS_BEFORE billing rows kept)"

echo "== M1-8 enrollment API, token reuse, certificate renewal (2nd instance, 60 s certificates) =="
# Admin API: create a node -> one-time token + key-less bootstrap (201).
[ "$(code -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' -d '{"name":"api-node"}')" = "401" ] \
  || { echo "FAIL: anonymous node create"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' -d '{"name":"api-node"}')" = "201" ] \
  || { echo "FAIL: API node create"; cat /tmp/akari-smoke/last; exit 1; }
read -r API_NODE API_TOKEN < <(python3 -c "import json;d=json.load(open('/tmp/akari-smoke/last'));print(d['id'],d['enrollment_token'])")
python3 -c "import json,sys;b=json.load(open('/tmp/akari-smoke/last'))['bootstrap'];sys.exit('PRIVATE KEY' in b or 'enrollment_token = \"$API_TOKEN\"' not in b)" \
  || { echo "FAIL: API bootstrap"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' -d '{"name":"api-node"}')" = "409" ] \
  || { echo "FAIL: duplicate node name not 409"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes/$API_NODE/enroll-token")" = "200" ] || { echo "FAIL: API enroll-token"; exit 1; }
API_TOKEN2=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['enrollment_token'])")
[ "$API_TOKEN2" != "$API_TOKEN" ] || { echo "FAIL: enroll-token reused the token"; exit 1; }
code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
python3 -c "
import json; n=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$API_NODE'][0]
assert n['enrolled'] is False and n['enroll_token_expires_at'] and n['cert_not_after'] is None, n" \
  || { echo "FAIL: pending node view"; exit 1; }
[ "$(psql_q "SELECT encode(token_hash,'hex') FROM node_enrollments WHERE node_id='$API_NODE'")" != "$API_TOKEN2" ] \
  || { echo "FAIL: token stored in clear"; exit 1; }

# Second panel instance (same DB/CA, multi-instance) issuing 60 s
# certificates: its agent must renew within about a minute.
cat >"$LOG/panel-b.toml" <<'TOML'
[web]
bind = "127.0.0.1:8081"
cookie_secure = false
[grpc]
bind = "127.0.0.1:8444"
advertise = "127.0.0.1:8444"
[agent]
cert_validity_secs = 60
[auth]
require_admin_2fa = true
TOML
"$PANEL" -c "$LOG/panel-b.toml" serve >"$LOG/panel-b.log" 2>&1 &
PANEL_B=$!
trap 'cleanup_upd; kill $PANEL_PID ${PANEL_B:+$PANEL_B} ${AGENT_PID:+$AGENT_PID} $MOCK_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do [ "$(code "http://127.0.0.1:8081/$PREFIX/healthz")" = "200" ] && break; sleep 0.5; done
# R18 opt-in policy on instance B (auth.require_admin_2fa): an admin without
# 2FA only gets an enrollment-only session there, a full one on A.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"admin-no2fa","password":"admin-no2fa-pw","role":"admin"}')" = "201" ] || { echo "FAIL: create 2nd admin"; exit 1; }
ADMIN2=$(python3 -c "import json;d=json.load(open('/tmp/akari-smoke/last'));assert 'totp_enrollment_code' not in d;print(d['id'])") \
  || { echo "FAIL: create admin still returns an enrollment code"; exit 1; }
A2JAR="$LOG/admin2-cookies"
[ "$(code -c "$A2JAR" -X POST "http://127.0.0.1:8081/$PREFIX/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"admin-no2fa","password":"admin-no2fa-pw"}')" = "200" ] && grep -q '"stage":"enroll"' /tmp/akari-smoke/last \
  || { echo "FAIL: require_admin_2fa did not confine the admin"; exit 1; }
[ "$(code -b "$A2JAR" "http://127.0.0.1:8081/$PREFIX/api/v1/users")" = "401" ] || { echo "FAIL: enrollment-only session listed users"; exit 1; }
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"admin-no2fa","password":"admin-no2fa-pw"}')" = "200" ] && grep -q '"stage":"full"' /tmp/akari-smoke/last \
  || { echo "FAIL: optional-2FA instance confined the admin"; exit 1; }
# Keep root the last admin (S4-2 assertions below).
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$ADMIN2")" = "204" ] || { echo "FAIL: delete 2nd admin"; exit 1; }
"$PANEL" -c "$LOG/panel-b.toml" node add renew-node --out "$LOG/renew-bootstrap.toml" >/dev/null
RENEW_ID=$("$PANEL" node list | awk '$2=="renew-node"{print $1}')
"$AGENT" -config "$LOG/renew-bootstrap.toml" -state-dir "$LOG/state-renew" >"$LOG/renew-agent.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 15); do grep -q "channel established" "$LOG/renew-agent.log" && break; sleep 1; done
grep -q '"msg":"enrolled"' "$LOG/renew-agent.log" || { echo "FAIL: renew agent did not enroll"; cat "$LOG/renew-agent.log"; exit 1; }
for _ in $(seq 1 10); do [ "$(psql_q "SELECT status FROM nodes WHERE id='$RENEW_ID'")" = "online" ] && break; sleep 1; done
[ "$(psql_q "SELECT status FROM nodes WHERE id='$RENEW_ID'")" = "online" ] || { echo "FAIL: enrolled node not online"; exit 1; }
FIRST_SERIAL=$(psql_q "SELECT cert_serial FROM nodes WHERE id='$RENEW_ID'")
# The same (used) token on a fresh state dir: refused, the agent exits.
REUSE_RC=0
timeout 20 "$AGENT" -config "$LOG/renew-bootstrap.toml" -state-dir "$LOG/state-reuse" >"$LOG/reuse-agent.log" 2>&1 || REUSE_RC=$?
[ "$REUSE_RC" = "1" ] && grep -q "enrollment refused" "$LOG/reuse-agent.log" \
  || { echo "FAIL: reused enrollment token not refused (rc $REUSE_RC)"; cat "$LOG/reuse-agent.log"; exit 1; }
[ "$(psql_q "SELECT cert_serial FROM nodes WHERE id='$RENEW_ID'")" = "$FIRST_SERIAL" ] || { echo "FAIL: refused enrollment changed the node"; exit 1; }
# Renewal: < 1/3 of 75 s left -> Renew over mTLS, reconnect, promote; the
# panel tombstones the first serial when it sees the new one.
for _ in $(seq 1 90); do grep -q "renewed certificate accepted by the panel" "$LOG/renew-agent.log" && break; sleep 1; done
grep -q "renewed certificate accepted by the panel" "$LOG/renew-agent.log" \
  || { echo "FAIL: no certificate renewal"; tail -20 "$LOG/renew-agent.log"; exit 1; }
for _ in $(seq 1 10); do
  [ "$(psql_q "SELECT reason FROM revoked_certs WHERE cert_serial='$FIRST_SERIAL'")" = "rotated" ] && break; sleep 1
done
[ "$(psql_q "SELECT reason FROM revoked_certs WHERE cert_serial='$FIRST_SERIAL'")" = "rotated" ] \
  || { echo "FAIL: renewed-from certificate not tombstoned"; exit 1; }
[ "$(psql_q "SELECT cert_serial <> '$FIRST_SERIAL' AND cert_not_after > now() FROM nodes WHERE id='$RENEW_ID'")" = "t" ] \
  || { echo "FAIL: node does not carry the renewed certificate"; exit 1; }
for a in node.enroll node.cert.renew node.cert.rotated; do
  [ "$(psql_q "SELECT count(*) > 0 FROM audit_log WHERE action='$a' AND actor_login='agent' AND target_id='$RENEW_ID'")" = "t" ] \
    || { echo "FAIL: $a not audited"; exit 1; }
done
grep -qE '"protocol":([3-9]|[1-9][0-9])' "$LOG/panel-b.log" || { echo "FAIL: agent does not speak protocol 3 (renewal + self-update)"; exit 1; }
code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
python3 -c "
import json; n=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$RENEW_ID'][0]
assert n['enrolled'] and n['cert_not_after'] and n['enroll_token_expires_at'] is None, n
assert any('agent certificate expires' in w for w in n['warnings']), n['warnings']
assert n['heartbeat'] is None or 'uptime_seconds' in n['heartbeat'], n['heartbeat']" \
  || { echo "FAIL: enrolled node view"; exit 1; }
# Files 0600; directories (M6: update/, update/bin/) 0700.
while IFS= read -r f; do
  want=600; [ -d "$f" ] && want=700
  [ "$(stat -c %a "$f")" = "$want" ] || { echo "FAIL: $f is not 0$want"; exit 1; }
done < <(find "$LOG/state-renew" -mindepth 1)
grep -q 'PRIVATE KEY' "$LOG/renew-agent.log" "$LOG/panel-b.log" && { echo "FAIL: key material in a log"; exit 1; }
kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
AGENT_PID=""
kill $PANEL_B 2>/dev/null; wait $PANEL_B 2>/dev/null || true
PANEL_B=""
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/nodes/$API_NODE")" = "202" ] || { echo "FAIL: delete api-node"; exit 1; }
echo "enrollment + renewal: ok"

echo "== M1-7 audit log: admin view lists the actions, no secrets =="
[ "$(code -b "$JAR" "$BASE/api/v1/audit?limit=200")" = "200" ] || { echo "FAIL: audit list"; exit 1; }
for a in user.create node.create node.set_inbounds node.update node.assign user.update user.delete \
         user.totp.enable auth.login auth.login_failed user.sub_token.rotate node.delete \
         node.enroll_token node.enroll node.cert.renew node.cert.rotated; do
  grep -q "\"action\":\"$a\"" /tmp/akari-smoke/last || { echo "FAIL: audit lacks $a"; exit 1; }
done
grep -q '"actor_login":"cli"' /tmp/akari-smoke/last || { echo "FAIL: CLI actions not audited as cli"; exit 1; }
for secret in "$ADMIN_PW" "$TOTP_SECRET" "$NEW_TOKEN" "$VLESS_A" "user-password-123" '$argon2' \
              "$TOKEN" "$API_TOKEN" "$API_TOKEN2"; do
  grep -qF -- "$secret" /tmp/akari-smoke/last && { echo "FAIL: audit log contains a secret"; exit 1; }
done
[ "$(code -b "$JAR" "$BASE/api/v1/audit?action=user.totp.&limit=5")" = "200" ] || { echo "FAIL: audit filter"; exit 1; }
python3 -c "import json; d=json.load(open('/tmp/akari-smoke/last')); assert d['entries'] and all(e['action'].startswith('user.totp.') for e in d['entries'])" \
  || { echo "FAIL: audit action filter"; exit 1; }
# smoke-user is gone by now; rl-user (role user) is the non-admin.
[ "$(code -c "$UJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"rl-user","password":"rl-user-password"}')" = "200" ] || { echo "FAIL: rl-user login"; exit 1; }
[ "$(code -b "$UJAR" "$BASE/api/v1/audit")" = "403" ] || { echo "FAIL: non-admin read the audit log"; exit 1; }
echo "audit: ok"

echo "== M6 signed agent self-update: staged rollout, health gate, automatic rollback =="
AD="$AGENT_DIR"
UPD="$LOG/upd"
mkdir -p "$UPD/v1" "$UPD/v2"
GOOS_=$(cd "$AD" && go env GOOS)
GOARCH_=$(cd "$AD" && go env GOARCH)
# Test-key builds (build tag akari_testkeys; `make dist` refuses them).
make -s -C "$AD" build-testkeys VERSION=v900.0.0 OUT="$UPD/agent-v900.0.0" >/dev/null
make -s -C "$AD" build-testkeys VERSION=v900.0.1 OUT="$UPD/v1/akari-agent" >/dev/null
(cd "$AD" && CGO_ENABLED=0 go build -o "$UPD/akari-sign" ./cmd/akari-sign)
"$UPD/agent-v900.0.0" -release-keys | grep -q TEST-ONLY || { echo "FAIL: smoke agent does not pin the test key"; exit 1; }
"$AGENT" -release-keys | grep -q TEST-ONLY && { echo "FAIL: the regular build pins the TEST release key"; exit 1; }
# vN+2 is broken: it exits at once (the launcher must roll it back).
printf '#!/bin/sh\necho "broken agent build" >&2\nexit 3\n' >"$UPD/v2/akari-agent"
chmod 0755 "$UPD/v2/akari-agent"
upd_sign() { # $1 binary, $2 version
  "$UPD/akari-sign" sign -key "$AD/testdata/TEST-ONLY-release.key" -binary "$1" -version "$2" \
    -os "$GOOS_" -arch "$GOARCH_" >/dev/null
  "$UPD/akari-sign" verify -keys "$AD/testdata/TEST-ONLY-release.pub" -manifest "$1.manifest.json" \
    -sig "$1.manifest.sig" -binary "$1" >/dev/null || { echo "FAIL: akari-sign verify"; exit 1; }
}
upd_upload() { # $1 binary (signed) -> release id
  python3 -c "import json,sys; print(json.dumps({'manifest': open(sys.argv[1]+'.manifest.json').read(), 'sig': json.load(open(sys.argv[1]+'.manifest.sig'))}))" "$1" >"$UPD/req.json"
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/agent-releases" -H 'Content-Type: application/json' --data-binary @"$UPD/req.json")" = "201" ] \
    || { echo "FAIL: release create: $(cat /tmp/akari-smoke/last)" >&2; exit 1; }
  local id; id=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
  [ "$(code -b "$JAR" -X PUT "$BASE/api/v1/agent-releases/$id/binary" -H 'Content-Type: application/octet-stream' --data-binary @"$1")" = "200" ] \
    || { echo "FAIL: release upload: $(cat /tmp/akari-smoke/last)" >&2; exit 1; }
  echo "$id"
}
upd_sign "$UPD/v1/akari-agent" v900.0.1
upd_sign "$UPD/v2/akari-agent" v900.0.2
# A manifest signed by another key is refused before anything is stored.
"$UPD/akari-sign" keygen -out "$UPD/other.key" >/dev/null
cp "$UPD/v1/akari-agent" "$UPD/other-bin"
"$UPD/akari-sign" sign -key "$UPD/other.key" -binary "$UPD/other-bin" -version v900.0.9 -os "$GOOS_" -arch "$GOARCH_" >/dev/null
python3 -c "import json,sys; print(json.dumps({'manifest': open(sys.argv[1]+'.manifest.json').read(), 'sig': json.load(open(sys.argv[1]+'.manifest.sig'))}))" "$UPD/other-bin" >"$UPD/req.json"
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/agent-releases" -H 'Content-Type: application/json' --data-binary @"$UPD/req.json")" = "400" ] \
  || { echo "FAIL: release signed by an untrusted key accepted"; exit 1; }
REL1=$(upd_upload "$UPD/v1/akari-agent")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/agent-releases/$REL1/binary" --data-binary @"$UPD/v1/akari-agent")" = "409" ] \
  || { echo "FAIL: second upload not 409"; exit 1; }
upd_upload "$UPD/v2/akari-agent" >/dev/null
[ "$(psql_q "SELECT count(*) FROM agent_releases WHERE complete_at IS NOT NULL")" = "2" ] || { echo "FAIL: releases not stored"; exit 1; }

"$PANEL" node add upd-node --out "$LOG/upd-bootstrap.toml" >/dev/null
UPD_ID=$("$PANEL" node list | awk '$2=="upd-node"{print $1}')
# The service manager: restart on exit (systemd Restart=always).
( while :; do
    "$UPD/agent-v900.0.0" -config "$LOG/upd-bootstrap.toml" -update-self-check 60s -state-dir "$LOG/state-upd" >>"$LOG/upd-agent.log" 2>&1 || true
    [ -f "$UPD/stop" ] && break
    sleep 1
  done ) &
UPD_LOOP=$!
upd_node() { psql_q "SELECT $1 FROM nodes WHERE id='$UPD_ID'"; }
for _ in $(seq 1 20); do [ "$(upd_node agent_version)" = "v900.0.0" ] && break; sleep 1; done
[ "$(upd_node agent_version)" = "v900.0.0" ] && [ "$(upd_node agent_protocol)" -ge 3 ] \
  || { echo "FAIL: update agent not connected ($(upd_node agent_version)/$(upd_node agent_protocol))"; tail -5 "$LOG/upd-agent.log"; exit 1; }
# Only the update node takes part: the others run development builds.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts" -H 'Content-Type: application/json' \
    -d "{\"version\":\"v900.0.1\",\"node_ids\":[\"$UPD_ID\"],\"health_timeout_secs\":90}")" = "201" ] \
  || { echo "FAIL: rollout create"; cat /tmp/akari-smoke/last; exit 1; }
RO1=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
ro_status() { psql_q "SELECT status FROM rollouts WHERE id='$1'"; }
for _ in $(seq 1 90); do [ "$(ro_status "$RO1")" = "completed" ] && break; sleep 1; done
[ "$(ro_status "$RO1")" = "completed" ] || { echo "FAIL: rollout to v900.0.1 not completed ($(ro_status "$RO1"))"; \
  psql_q "SELECT status, detail FROM rollout_nodes WHERE rollout_id='$RO1'"; tail -20 "$LOG/upd-agent.log"; exit 1; }
[ "$(upd_node agent_version)" = "v900.0.1" ] || { echo "FAIL: node not on v900.0.1"; exit 1; }
[ "$(psql_q "SELECT status FROM rollout_nodes WHERE rollout_id='$RO1'")" = "healthy" ] || { echo "FAIL: node not healthy"; exit 1; }
for m in "update offer accepted" "agent update verified and staged" "switching to the new agent" "agent update passed its self-check"; do
  grep -q "$m" "$LOG/upd-agent.log" || { echo "FAIL: agent log lacks '$m'"; tail -20 "$LOG/upd-agent.log"; exit 1; }
done
# exec-replace, not a crash: no restart by the service loop so far.
[ "$(grep -c '"msg":"agent starting"' "$LOG/upd-agent.log")" = "2" ] || { echo "FAIL: expected exactly one in-place restart"; exit 1; }
python3 -c "
import json; s=json.load(open('$LOG/state-upd/update/state.json'))
assert s['current']['version']=='v900.0.1' and 'trial' not in s and s.get('previous') is None, s" \
  || { echo "FAIL: update state after v900.0.1"; exit 1; }
[ "$(stat -c %a "$LOG/state-upd/update/state.json")" = "600" ] || { echo "FAIL: update state not 0600"; exit 1; }
code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
python3 -c "
import json; n=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$UPD_ID'][0]
assert n['update_status']['status']=='healthy' and n['agent_version']=='v900.0.1', n['update_status']" \
  || { echo "FAIL: node view update status"; exit 1; }
echo "update to v900.0.1: ok"

# Broken vN+2: the binary dies on start; the launcher counts boots and goes
# back to v900.0.1; the agent reports ROLLED_BACK; the rollout halts.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts" -H 'Content-Type: application/json' \
    -d "{\"version\":\"v900.0.2\",\"node_ids\":[\"$UPD_ID\"],\"health_timeout_secs\":90}")" = "201" ] \
  || { echo "FAIL: rollout 2 create"; cat /tmp/akari-smoke/last; exit 1; }
RO2=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
for _ in $(seq 1 90); do [ "$(ro_status "$RO2")" = "halted" ] && break; sleep 1; done
[ "$(ro_status "$RO2")" = "halted" ] || { echo "FAIL: broken rollout not halted ($(ro_status "$RO2"))"; \
  psql_q "SELECT status, detail FROM rollout_nodes WHERE rollout_id='$RO2'"; tail -20 "$LOG/upd-agent.log"; exit 1; }
psql_q "SELECT detail FROM rollout_nodes WHERE rollout_id='$RO2'" | grep -q "rolled back" \
  || { echo "FAIL: no rollback report: $(psql_q "SELECT status, detail FROM rollout_nodes WHERE rollout_id='$RO2'")"; exit 1; }
grep -q "broken agent build" "$LOG/upd-agent.log" || { echo "FAIL: broken build never ran"; exit 1; }
grep -q "rolling back agent update" "$LOG/upd-agent.log" || { echo "FAIL: launcher did not roll back"; exit 1; }
for _ in $(seq 1 20); do [ "$(upd_node agent_version)" = "v900.0.1" ] && [ "$(upd_node status)" = "online" ] && break; sleep 1; done
[ "$(upd_node agent_version)" = "v900.0.1" ] || { echo "FAIL: node not back on v900.0.1"; exit 1; }
python3 -c "
import json; s=json.load(open('$LOG/state-upd/update/state.json'))
assert s['current']['version']=='v900.0.1' and 'v900.0.2' in s['rolled_back'], s" \
  || { echo "FAIL: update state after rollback"; exit 1; }
ls "$LOG/state-upd/update/bin" | grep -q v900.0.2 && { echo "FAIL: rolled-back binary kept in bin/"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='rollout.halt' AND actor_login='system'")" = "1" ] \
  || { echo "FAIL: halt not audited"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts/$RO2/resume")" = "409" ] || { echo "FAIL: halted rollout resumed"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts/$RO2/abort")" = "200" ] || { echo "FAIL: abort"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/rollouts")" = "200" ] && grep -q '"aborted"' /tmp/akari-smoke/last || { echo "FAIL: rollout list"; exit 1; }
for a in agent_release.create agent_release.upload rollout.create rollout.complete rollout.abort; do
  [ "$(psql_q "SELECT count(*) > 0 FROM audit_log WHERE action='$a'")" = "t" ] || { echo "FAIL: $a not audited"; exit 1; }
done
cleanup_upd
wait "$UPD_LOOP" 2>/dev/null || true
UPD_LOOP=""
echo "m6 self-update: ok (v900.0.0 -> v900.0.1 healthy; broken v900.0.2 rolled back, rollout halted)"

echo "== R18-2 node form + one-line installer: template inbounds, install link, Debian 13 container =="
# The newest complete release is what the installer serves: drop the broken
# v900.0.2 of the M6 section (its rollout is over), leaving v900.0.1.
REL2=$(psql_q "SELECT id FROM agent_releases WHERE version='v900.0.2'")
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/agent-releases/$REL2")" = "204" ] \
  || { echo "FAIL: delete broken release: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM agent_releases WHERE version='v900.0.2'")" = "0" ] || { echo "FAIL: broken release kept"; exit 1; }
# Templates catalog + render (REALITY keys made by the panel).
[ "$(code -b "$JAR" "$BASE/api/v1/inbound-templates")" = "200" ] && grep -q '"www.apple.com"' /tmp/akari-smoke/last \
  || { echo "FAIL: template catalog"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/inbound-templates/render" -H 'Content-Type: application/json' \
    -d '{"templates":[{"template":"vless_reality","port":443},{"template":"vless_reality","port":443}]}')" = "400" ] \
  || { echo "FAIL: duplicate template ports accepted"; exit 1; }
INST_PORT_R=24443
INST_PORT_W=24080
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' \
    -d "{\"name\":\"inst-node\",\"region\":\"Smoke\",\"server_addr\":\"127.0.0.1\",
         \"templates\":[{\"template\":\"vless_reality\",\"port\":$INST_PORT_R},{\"template\":\"vmess_ws\",\"port\":$INST_PORT_W}],
         \"install\":{\"origin\":\"http://127.0.0.1:8080\"}}")" = "201" ] \
  || { echo "FAIL: create node with templates: $(cat /tmp/akari-smoke/last)"; exit 1; }
cp /tmp/akari-smoke/last "$LOG/inst-create.json"
INST_ID=$(python3 -c "import json;print(json.load(open('$LOG/inst-create.json'))['id'])")
INST_URL=$(python3 -c "import json;print(json.load(open('$LOG/inst-create.json'))['install']['url'])")
INST_CMD=$(python3 -c "import json;print(json.load(open('$LOG/inst-create.json'))['install']['command'])")
python3 - "$LOG/inst-create.json" "$INST_URL" <<'PY' || { echo "FAIL: create response"; exit 1; }
import base64, json, sys
v = json.load(open(sys.argv[1])); i = v["install"]
assert i["command"] == "curl -fsSL '%s' | sudo sh" % sys.argv[2], i["command"]
assert i["pin"] is None and i["command_wget"].startswith("wget -qO- ")
assert i["releases"]["amd64"]["version"] == "v900.0.1", i["releases"]
assert sys.argv[2].endswith("/install/" + v["enrollment_token"])
PY
psql_q "SELECT xray_inbounds FROM nodes WHERE id='$INST_ID'" | python3 -c "
import json, sys; ib = json.load(sys.stdin)
r = ib[0]['streamSettings']['realitySettings']
assert ib[0]['port'] == $INST_PORT_R and r['dest'] == 'www.apple.com:443' and len(r['privateKey']) == 43 and len(r['publicKey']) == 43
assert ib[1]['protocol'] == 'vmess' and ib[1]['streamSettings']['network'] == 'ws'" \
  || { echo "FAIL: template inbounds not stored"; exit 1; }
# The script: complete, POSIX sh, shellcheck-clean.
[ "$(code "$INST_URL")" = "200" ] || { echo "FAIL: install script not served"; exit 1; }
cp /tmp/akari-smoke/last "$LOG/install.sh"
grep -q '@@' "$LOG/install.sh" && { echo "FAIL: placeholder left in the script"; exit 1; }
sh -n "$LOG/install.sh" || { echo "FAIL: script does not parse"; exit 1; }
if [ "${SMOKE_SHELLCHECK:-1}" = 1 ]; then
  docker run --rm -v "$LOG:/mnt:ro" koalaman/shellcheck:stable -s sh /mnt/install.sh \
    || { echo "FAIL: shellcheck"; exit 1; }
fi
# Unknown arch / bad token: the canonical rejection.
for p in "$INST_URL/agent/amd64" "$INST_URL/agent/$(printf "%064d" 0)" "${INST_URL%?}x" "$BASE/install/short"; do
  [ "$(fp "$p")" = "$REJ" ] || { echo "FAIL: install rejection differs for $p"; exit 1; }
done
if [ "${SMOKE_INSTALL_CONTAINER:-1}" = 1 ]; then
  docker build -q -t akari-node-test:debian13 scripts/install-test >/dev/null
  docker rm -f akari-smoke-node >/dev/null 2>&1 || true
  # Host network: the node reaches the panel on 127.0.0.1 (web 8080, gRPC 8443).
  docker run -d --name akari-smoke-node --network host --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw akari-node-test:debian13 >/dev/null
  PREV_EXIT_TRAP=$(trap -p EXIT)
  trap 'docker rm -f akari-smoke-node >/dev/null 2>&1 || true; cleanup_upd; kill $PANEL_PID ${PANEL_B:+$PANEL_B} ${AGENT_PID:+$AGENT_PID} 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do docker exec akari-smoke-node systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
  # Exactly what the admin copies, minus sudo (root in the container).
  docker exec akari-smoke-node sh -c "${INST_CMD% | sudo sh} | sh" >"$LOG/install.out" 2>&1 \
    || { echo "FAIL: installer failed"; cat "$LOG/install.out"; exit 1; }
  grep -q "SUCCESS: the agent enrolled and is connected" "$LOG/install.out" || { echo "FAIL: installer output"; cat "$LOG/install.out"; exit 1; }
  for _ in $(seq 1 20); do [ "$(psql_q "SELECT status FROM nodes WHERE id='$INST_ID'")" = "online" ] && break; sleep 1; done
  [ "$(psql_q "SELECT status FROM nodes WHERE id='$INST_ID'")" = "online" ] || { echo "FAIL: installed node not online"; exit 1; }
  for _ in $(seq 1 20); do [ "$(psql_q "SELECT agent_version FROM nodes WHERE id='$INST_ID'")" = "v900.0.1" ] && break; sleep 1; done
  [ "$(psql_q "SELECT agent_version || ' ' || coalesce(last_error, 'ok') FROM nodes WHERE id='$INST_ID'")" = "v900.0.1 ok" ] \
    || { echo "FAIL: installed agent: $(psql_q "SELECT agent_version, last_error FROM nodes WHERE id='$INST_ID'")"; exit 1; }
  # xray took the generated REALITY key pair: the inbound listens.
  for _ in $(seq 1 20); do (exec 3<>/dev/tcp/127.0.0.1/$INST_PORT_R) 2>/dev/null && break; sleep 1; done
  (exec 3<>/dev/tcp/127.0.0.1/$INST_PORT_R) 2>/dev/null || { echo "FAIL: REALITY inbound not listening"; exit 1; }
  [ "$(docker exec akari-smoke-node stat -c '%a %U' /etc/akari-agent/bootstrap.toml)" = "600 root" ] \
    || { echo "FAIL: bootstrap.toml mode"; exit 1; }
  docker exec akari-smoke-node sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\0" " "' | grep -q "$(python3 -c "import json;print(json.load(open('$LOG/inst-create.json'))['enrollment_token'])")" \
    && { echo "FAIL: token visible in the process list"; exit 1; }
  # The link died with the enrollment: script and binary are the rejection.
  [ "$(fp "$INST_URL")" = "$REJ" ] || { echo "FAIL: used install link not rejected"; exit 1; }
  INST_SHA=$(python3 -c "import json;print(json.load(open('$LOG/inst-create.json'))['install']['releases']['amd64']['sha256'])")
  [ "$(fp "$INST_URL/agent/$INST_SHA")" = "$REJ" ] || { echo "FAIL: used install link serves the binary"; exit 1; }
  # Uninstall with a fresh link (re-install command), then reinstall with it.
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes/$INST_ID/install" -H 'Content-Type: application/json' \
      -d '{"origin":"http://127.0.0.1:8080"}')" = "200" ] || { echo "FAIL: re-install link"; exit 1; }
  INST_URL2=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['url'])")
  docker exec akari-smoke-node sh -c "curl -fsSL '$INST_URL2' | sh -s -- --uninstall" >>"$LOG/install.out" 2>&1 \
    || { echo "FAIL: uninstall"; tail -5 "$LOG/install.out"; exit 1; }
  docker exec akari-smoke-node sh -c 'test ! -e /usr/local/bin/akari-agent && test ! -e /etc/akari-agent && ! systemctl is-active -q akari-agent' \
    || { echo "FAIL: uninstall left files or a running agent"; exit 1; }
  docker exec akari-smoke-node sh -c "curl -fsSL '$INST_URL2' | sh" >>"$LOG/install.out" 2>&1 \
    || { echo "FAIL: reinstall"; tail -20 "$LOG/install.out"; exit 1; }
  [ "$(fp "$INST_URL2")" = "$REJ" ] || { echo "FAIL: second link not burned"; exit 1; }
  docker exec akari-smoke-node akari-agent-uninstall >>"$LOG/install.out" 2>&1 || { echo "FAIL: uninstall helper"; exit 1; }
  docker rm -f akari-smoke-node >/dev/null
  eval "$PREV_EXIT_TRAP"
  echo "installer (container): ok"
else
  echo "installer container test skipped (SMOKE_INSTALL_CONTAINER=0)"
fi
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/nodes/$INST_ID")" = "202" ] || { echo "FAIL: delete inst-node"; exit 1; }
echo "r18-2 node install: ok"

echo "== R22 系统设置: domains, Caddy on-demand ask, host gate, node domain + hot-swapped gRPC certificate =="
# An agent enrolled BEFORE the change (bootstrap server_name = panel.toml's
# grpc.server_name, "localhost"): it must keep connecting afterwards.
"$PANEL" node add r22-old --out "$LOG/r22-old.toml" >/dev/null
grep -q '^server_name = "localhost"$' "$LOG/r22-old.toml" || { echo "FAIL: CLI bootstrap server_name"; exit 1; }
"$AGENT" -config "$LOG/r22-old.toml" -state-dir "$LOG/state-r22-old" >"$LOG/r22-old-agent.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 30); do grep -q "channel established" "$LOG/r22-old-agent.log" && break; sleep 0.5; done
grep -q "channel established" "$LOG/r22-old-agent.log" || { echo "FAIL: r22-old agent never connected"; exit 1; }
kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
AGENT_PID=""
[ "$(psql_q "SELECT server_name FROM nodes WHERE name='r22-old'")" = "localhost" ] || { echo "FAIL: enrolled server name not recorded"; exit 1; }

[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings"; exit 1; }
VER=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['version'])")
# A node domain on Cloudflare is refused (422) unless forced: 104.16.0.1 is a
# Cloudflare edge address (IP literal: no DNS involved).
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings" -H 'Content-Type: application/json' \
    -d "{\"version\":$VER,\"main_domain\":null,\"sub_domain\":null,\"node_domain\":\"104.16.0.1\",\"trust_cloudflare\":null}")" = "422" ] \
  || { echo "FAIL: orange-clouded node domain accepted: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/dns-check" -H 'Content-Type: application/json' \
    -d '{"kind":"node","domain":"104.16.0.1"}')" = "200" ] && grep -q '"level":"block"' /tmp/akari-smoke/last \
  || { echo "FAIL: dns-check verdict: $(cat /tmp/akari-smoke/last)"; exit 1; }
# The real values. The request goes to 127.0.0.1 (an IP: still allowed by
# the host gate, so no confirmation needed).
R22_MAIN=myapp.test:8446
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings" -H 'Content-Type: application/json' \
    -d "{\"version\":$VER,\"main_domain\":\"$R22_MAIN\",\"sub_domain\":\"sub.akari.test\",
         \"node_domain\":\"grpc.akari.test\",\"trust_cloudflare\":true}")" = "200" ] \
  || { echo "FAIL: PUT settings: $(cat /tmp/akari-smoke/last)"; exit 1; }
cp /tmp/akari-smoke/last "$LOG/r22-settings.json"
python3 - "$LOG/r22-settings.json" <<'PY' || { echo "FAIL: settings view"; cat "$LOG/r22-settings.json"; exit 1; }
import json, sys
v = json.load(open(sys.argv[1]))
assert v["main"]["effective"] == "https://myapp.test:8446" and v["main"]["source"] == "settings"
assert v["sub"]["effective"] == "https://sub.akari.test"
assert v["node"]["panel_addr"] == "grpc.akari.test:8443" and v["node"]["server_name"] == "grpc.akari.test"
assert v["trust_cloudflare"]["effective"] is True and v["host_gate"] is True and v["ask_enabled"] is True
assert "grpc.akari.test" in v["certificate_names"] and "localhost" in v["certificate_names"], v["certificate_names"]
PY
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.update'")" = "1" ] || { echo "FAIL: settings change not audited"; exit 1; }

# Caddy on-demand TLS ask endpoint (own listener, never the web port).
ASK=http://127.0.0.1:8092/ask
for d in myapp.test sub.akari.test; do
  [ "$(code "$ASK?domain=$d")" = "200" ] || { echo "FAIL: ask refuses configured $d"; exit 1; }
done
for d in evil.test grpc.akari.test 127.0.0.1; do
  [ "$(code "$ASK?domain=$d")" = "404" ] || { echo "FAIL: ask allows $d"; exit 1; }
done
[ "$(code http://127.0.0.1:8080/ask?domain=myapp.test)" = "404" ] || { echo "FAIL: ask reachable on the web port"; exit 1; }

# Host gate: unknown DNS names get the canonical rejection even with the
# right prefix; configured names and IP literals pass.
for h in evil.test grpc.akari.test www.myapp.test; do
  [ "$(fp -H "Host: $h" "$BASE/healthz")" = "$REJ" ] || { echo "FAIL: Host $h not rejected canonically"; exit 1; }
done
for h in myapp.test:8446 sub.akari.test 127.0.0.1:8080; do
  [ "$(code -H "Host: $h" "$BASE/healthz")" = "200" ] || { echo "FAIL: Host $h refused"; exit 1; }
done

# Caddy in front: the REAL deploy/caddy/Caddyfile (site blocks verbatim),
# with test-only global options injected (internal CA for every name,
# ports 8446/8447, no admin API). AKARI_DOMAIN is the main domain's host;
# sub.akari.test gets its certificate on demand via the ask endpoint.
docker rm -f akari-smoke-caddy >/dev/null 2>&1 || true
sed '0,/^{$/s//{\n\tadmin off\n\tlocal_certs\n\tskip_install_trust\n\thttp_port 8447\n\thttps_port 8446/' \
  deploy/caddy/Caddyfile >"$LOG/Caddyfile"
grep -q '^	https_port 8446$' "$LOG/Caddyfile" || { echo "FAIL: Caddyfile global block not found"; exit 1; }
docker run -d --name akari-smoke-caddy --network host -e AKARI_PREFIX="$PREFIX" -e AKARI_DOMAIN=myapp.test \
  -e AKARI_UPSTREAM=127.0.0.1:8080 -e AKARI_ASK=http://127.0.0.1:8092/ask \
  -v "$LOG/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.11-alpine >/dev/null
PREV_EXIT_TRAP=$(trap -p EXIT)
trap 'docker rm -f akari-smoke-caddy akari-smoke-r22 >/dev/null 2>&1 || true; cleanup_upd; kill $PANEL_PID ${AGENT_PID:+$AGENT_PID} 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/8446) 2>/dev/null && break; sleep 0.5; done
RES=(--resolve myapp.test:8446:127.0.0.1 --resolve sub.akari.test:8446:127.0.0.1 --resolve evil.test:8446:127.0.0.1
     --resolve myapp.test:8447:127.0.0.1 --resolve evil.test:8447:127.0.0.1)
MAIN_URL="https://$R22_MAIN/$PREFIX"
[ "$(code -k "${RES[@]}" "$MAIN_URL/healthz")" = "200" ] || { echo "FAIL: main domain through Caddy"; docker logs akari-smoke-caddy 2>&1 | tail -5; exit 1; }
[ "$(code -k "${RES[@]}" "https://sub.akari.test:8446/$PREFIX/healthz")" = "200" ] || { echo "FAIL: sub domain through Caddy (on demand)"; docker logs akari-smoke-caddy 2>&1 | tail -5; exit 1; }
[ "$(code -k "${RES[@]}" "https://$R22_MAIN/")" = "404" ] || { echo "FAIL: Caddy forwards outside the prefix"; exit 1; }
curl -sk --noproxy '*' "${RES[@]}" -o /dev/null "https://evil.test:8446/$PREFIX/healthz" \
  && { echo "FAIL: Caddy served a certificate for an unconfigured name"; exit 1; }
# No prefix oracle through Caddy: Caddy's own 404 and the panel's rejection
# behind the prefix are byte-identical (headers minus Date, body), on the
# main domain, the on-demand subscription domain and the bare IP (no SNI),
# with and without compression negotiated. Server/Via are stripped.
for base in "https://myapp.test:8446" "https://sub.akari.test:8446" "https://127.0.0.1:8446"; do
  for enc in identity "gzip, zstd"; do
    A=$(fp -k "${RES[@]}" -H "Accept-Encoding: $enc" "$base/junk")
    grep -qiE '^(server|via):' /tmp/akari-smoke/fphead && { echo "FAIL: Server/Via through Caddy ($base)"; cat /tmp/akari-smoke/fphead; exit 1; }
    head -1 /tmp/akari-smoke/fphead | grep -q " 404" || { echo "FAIL: Caddy 404 ($base)"; cat /tmp/akari-smoke/fphead; exit 1; }
    for p in "$PREFIX/nope" "$PREFIX/api/v1/nope" "$PREFIX"; do
      [ "$(fp -k "${RES[@]}" -H "Accept-Encoding: $enc" "$base/$p")" = "$A" ] \
        || { echo "FAIL: prefix oracle through Caddy: $base/<prefix>${p#"$PREFIX"} ($enc)"; cat /tmp/akari-smoke/fphead; exit 1; }
    done
  done
done
# Plain HTTP: AKARI_DOMAIN is redirected; any other host gets the canonical
# empty 404 on every path (never Caddy's default 200, never a redirect).
[ "$(code "${RES[@]}" "http://myapp.test:8447/x")" = "308" ] || { echo "FAIL: http main domain not redirected"; exit 1; }
for base in "http://127.0.0.1:8447" "http://evil.test:8447"; do
  A=$(fp "${RES[@]}" "$base/junk")
  head -1 /tmp/akari-smoke/fphead | grep -q " 404" || { echo "FAIL: plain http $base"; cat /tmp/akari-smoke/fphead; exit 1; }
  grep -qiE '^(server|via|location):' /tmp/akari-smoke/fphead && { echo "FAIL: plain http headers ($base)"; cat /tmp/akari-smoke/fphead; exit 1; }
  [ "$(fp "${RES[@]}" "$base/$PREFIX/healthz")" = "$A" ] || { echo "FAIL: plain http prefix oracle ($base)"; exit 1; }
done

# Subscription URLs on the subscription domain (API create response).
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"r22-user","password":"r22-user-password"}')" = "201" ] || { echo "FAIL: create r22 user"; exit 1; }
python3 -c "import json,sys;v=json.load(open('/tmp/akari-smoke/last'));sys.exit(0 if v['sub_url']=='https://sub.akari.test/$PREFIX/sub/'+v['sub_token'] else 1)" \
  || { echo "FAIL: sub_url not on the subscription domain: $(cat /tmp/akari-smoke/last)"; exit 1; }

# Install command: main domain origin (browser origin ignored), pinned
# (Caddy's internal CA), script carries the node domain.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' \
    -d '{"name":"r22-new","install":{"origin":"http://127.0.0.1:8080"}}')" = "201" ] \
  || { echo "FAIL: create r22-new: $(cat /tmp/akari-smoke/last)"; exit 1; }
cp /tmp/akari-smoke/last "$LOG/r22-create.json"
R22_URL=$(python3 -c "import json;print(json.load(open('$LOG/r22-create.json'))['install']['url'])")
R22_PIN=$(python3 -c "import json;print(json.load(open('$LOG/r22-create.json'))['install']['pin'] or '')")
case "$R22_URL" in "$MAIN_URL/install/"*) ;; *) echo "FAIL: install URL not on the main domain: $R22_URL"; exit 1;; esac
[ -n "$R22_PIN" ] || { echo "FAIL: no pin for Caddy's internal certificate"; exit 1; }
python3 -c "import json;b=json.load(open('$LOG/r22-create.json'))['bootstrap'];assert 'panel_addr = \"grpc.akari.test:8443\"' in b and 'server_name = \"grpc.akari.test\"' in b, b" \
  || { echo "FAIL: bootstrap lacks the node domain"; exit 1; }
curl -fsS --noproxy '*' --proto '=https' -k "${RES[@]}" --pinnedpubkey "$R22_PIN" "$R22_URL" >"$LOG/r22-install.sh" \
  || { echo "FAIL: install script through Caddy with the pin"; exit 1; }
grep -q '^panel_addr = "grpc.akari.test:8443"$' "$LOG/r22-install.sh" && grep -q '^server_name = "grpc.akari.test"$' "$LOG/r22-install.sh" \
  || { echo "FAIL: install script lacks the node domain"; exit 1; }
# The agent enrolls verifying the NEW name (only resolvable inside its
# container: --add-host); the certificate was swapped without a restart.
sed -n "/<<'AKARI_BOOTSTRAP_EOF'$/,/^AKARI_BOOTSTRAP_EOF$/p" "$LOG/r22-install.sh" | sed '1d;$d' >"$LOG/r22-new.toml"
grep -q '^enrollment_token = ' "$LOG/r22-new.toml" || { echo "FAIL: bootstrap not extracted from the script"; head -c 400 "$LOG/r22-new.toml"; exit 1; }
mkdir -p "$LOG/state-r22-new"
docker rm -f akari-smoke-r22 >/dev/null 2>&1 || true
docker run -d --name akari-smoke-r22 --network host --add-host grpc.akari.test:127.0.0.1 --user "$(id -u):$(id -g)" \
  -v "$(realpath "$AGENT"):/agent:ro" -v "$LOG:/smoke" alpine:3 \
  /agent -config /smoke/r22-new.toml -state-dir /smoke/state-r22-new >/dev/null
R22_ID=$(python3 -c "import json;print(json.load(open('$LOG/r22-create.json'))['id'])")
for _ in $(seq 1 40); do [ "$(psql_q "SELECT status FROM nodes WHERE id='$R22_ID'")" = "online" ] && break; sleep 0.5; done
[ "$(psql_q "SELECT status FROM nodes WHERE id='$R22_ID'")" = "online" ] \
  || { echo "FAIL: agent with the new server name did not connect"; docker logs akari-smoke-r22 2>&1 | tail -8; exit 1; }
[ "$(psql_q "SELECT server_name FROM nodes WHERE id='$R22_ID'")" = "grpc.akari.test" ] || { echo "FAIL: new server name not recorded"; exit 1; }
docker rm -f akari-smoke-r22 >/dev/null
# The agent enrolled before the change (server name localhost) still connects.
"$AGENT" -config "$LOG/r22-old.toml" -state-dir "$LOG/state-r22-old" >"$LOG/r22-old-agent2.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 30); do grep -q "channel established" "$LOG/r22-old-agent2.log" && break; sleep 0.5; done
grep -q "channel established" "$LOG/r22-old-agent2.log" || { echo "FAIL: old-server-name agent lost after the change"; tail -5 "$LOG/r22-old-agent2.log"; exit 1; }
kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
AGENT_PID=""
# The current node name cannot be removed; the panel.toml one neither.
for n in grpc.akari.test localhost; do
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/server-names/remove" -H 'Content-Type: application/json' \
      -d "{\"name\":\"$n\",\"confirm\":true}")" = "400" ] || { echo "FAIL: locked server name $n removable"; exit 1; }
done
docker rm -f akari-smoke-caddy >/dev/null
eval "$PREV_EXIT_TRAP"
# CLI: show + unset (audited); the name history (certificate) stays.
"$PANEL" settings show | grep -q 'node domain: *grpc.akari.test' || { echo "FAIL: settings show"; "$PANEL" settings show; exit 1; }
"$PANEL" settings unset all >/dev/null || { echo "FAIL: settings unset"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.update' AND actor_login = 'cli'")" = "1" ] || { echo "FAIL: CLI unset not audited"; exit 1; }
for _ in $(seq 1 20); do [ "$(code "$ASK?domain=myapp.test")" = "404" ] && break; sleep 0.25; done
[ "$(code "$ASK?domain=myapp.test")" = "404" ] || { echo "FAIL: running panel did not pick up the CLI change"; exit 1; }
[ "$(code -H 'Host: evil.test' "$BASE/healthz")" = "200" ] || { echo "FAIL: host gate still on after unset"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM grpc_server_names WHERE name = 'grpc.akari.test'")" = "1" ] || { echo "FAIL: server name dropped implicitly"; exit 1; }
for p in "$PREFIX"; do grep -qF "$p" "$LOG/panel.log" && { echo "FAIL: prefix in the panel log"; exit 1; }; done
echo "r22 settings: ok"

echo "== S4-2 sessions: revoke-sessions, last admin, logout kills copies of the cookie =="
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "200" ] || { echo "FAIL: me failed"; exit 1; }
ROOT_ID=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
[ "$(patch_code "$BASE/api/v1/users/$ROOT_ID" '{"enabled": false}')" = "409" ] || { echo "FAIL: last admin disable not 409"; exit 1; }
[ "$(patch_code "$BASE/api/v1/users/$ROOT_ID" '{"role": "user"}')" = "409" ] || { echo "FAIL: last admin demote not 409"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$ROOT_ID")" = "409" ] || { echo "FAIL: last admin delete not 409"; exit 1; }
JAR2="$LOG/cookies2"
# Second session via a recovery code (single use).
RC1=$(sed -n 1p "$LOG/recovery")
[ "$(code -c "$JAR2" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\",\"code\":\"$RC1\"}")" = "200" ] || { echo "FAIL: second login (recovery code)"; exit 1; }
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\",\"code\":\"$RC1\"}")" = "401" ] || { echo "FAIL: recovery code reused"; exit 1; }
[ "$(code -b "$JAR2" "$BASE/api/v1/me")" = "200" ] || { echo "FAIL: second session"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$ROOT_ID/revoke-sessions")" = "204" ] || { echo "FAIL: revoke-sessions"; exit 1; }
[ "$(code -b "$JAR2" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: revoked session still works"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: own session survived revoke-sessions"; exit 1; }
[ "$(login_root "$(sed -n 2p "$LOG/recovery")")" = "200" ] || { echo "FAIL: login after revoke"; exit 1; }
cp "$JAR" "$LOG/stolen-cookies"
[ "$(code -b "$JAR" -c "$JAR" -X POST "$BASE/auth/logout")" = "200" ] || { echo "FAIL: logout failed"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: me after logout not 401"; exit 1; }
[ "$(code -b "$LOG/stolen-cookies" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: a copy of the cookie survived logout"; exit 1; }
echo "sessions: ok"

echo "== M1-6/M1-9 CLI: reset-2fa, rotate-jwt =="
[ "$(login_root "$(totp)")" = "200" ] || { echo "FAIL: TOTP login before reset"; exit 1; }
"$PANEL" admin reset-2fa root >"$LOG/reset.out"
grep -q "reset" "$LOG/reset.out" || { echo "FAIL: CLI reset-2fa"; exit 1; }
grep -qE '^  [A-Z2-7]{4}(-[A-Z2-7]{1,4})+$' "$LOG/reset.out" && { echo "FAIL: reset-2fa still prints an enrollment code"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: session survived reset-2fa"; exit 1; }
[ "$(code -c "$JAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\"}")" = "200" ] && grep -q '"stage":"full"' /tmp/akari-smoke/last \
  || { echo "FAIL: after reset-2fa the admin logs in with the password alone"; exit 1; }
[ "$(code -b "$UJAR" "$BASE/api/v1/me")" = "200" ] || { echo "FAIL: user session before rotate-jwt"; exit 1; }
"$PANEL" secrets rotate-jwt | grep -q "revoked" || { echo "FAIL: CLI rotate-jwt"; exit 1; }
[ "$(code -b "$UJAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: session survived rotate-jwt"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE actor_login = 'cli' AND action IN ('user.totp.reset', 'secrets.rotate_jwt')")" = "2" ] \
  || { echo "FAIL: CLI secret actions not audited"; exit 1; }
echo "cli 2fa/jwt: ok"

echo "== root + healthz =="
[ "$(code http://127.0.0.1:8080/)" = "404" ] || { echo "FAIL: / not 404"; exit 1; }
[ "$(code http://127.0.0.1:8080/definitely-not-here)" = "404" ] || { echo "FAIL: junk not 404"; exit 1; }
[ "$(code "$BASE/healthz")" = "200" ] || { echo "FAIL: healthz not 200"; exit 1; }

echo "== M1-3/M1-4: config check, version, metrics listener, request id =="
"$PANEL" -c "$LOG/panel.toml" config check >"$LOG/config-check.out" 2>&1 \
  || { echo "FAIL: config check on the smoke config"; cat "$LOG/config-check.out"; exit 1; }
grep -q 'configuration OK' "$LOG/config-check.out" || { echo "FAIL: config check output"; exit 1; }
printf '[grpc]\nlease_seconds = 5\n' >"$LOG/bad.toml"
"$PANEL" -c "$LOG/bad.toml" config check >"$LOG/bad.out" 2>&1 \
  && { echo "FAIL: invalid config accepted"; exit 1; }
grep -q 'lease_seconds' "$LOG/bad.out" || { echo "FAIL: invalid config error not readable"; cat "$LOG/bad.out"; exit 1; }
# AKARI_CONFIG replaces -c (compose run/exec drop the service command).
AKARI_CONFIG="$LOG/bad.toml" "$PANEL" config check >"$LOG/bad-env.out" 2>&1 \
  && { echo "FAIL: AKARI_CONFIG ignored (invalid config accepted)"; exit 1; }
grep -q 'lease_seconds' "$LOG/bad-env.out" || { echo "FAIL: AKARI_CONFIG not honored"; cat "$LOG/bad-env.out"; exit 1; }
"$PANEL" --version | grep -Eq '^akari [0-9]+\.[0-9]+\.[0-9]+ \(([0-9a-f]+|unknown)\)' \
  || { echo "FAIL: akari --version"; exit 1; }
# Metrics live on their own listener only; the public port has no /metrics.
for probe in "http://127.0.0.1:8080/metrics" "$BASE/metrics"; do
  [ "$(fp "$probe")" = "$REJ" ] || { echo "FAIL: /metrics reachable on the web port: $probe"; exit 1; }
done
curl -s --noproxy '*' "http://127.0.0.1:9109/metrics" >"$LOG/metrics.txt"
for m in akari_build_info akari_agents_connected akari_sync_sent_total akari_acks_total \
         akari_traffic_flush_duration_seconds_count akari_login_attempts_total; do
  grep -q "^$m" "$LOG/metrics.txt" || { echo "FAIL: metric $m missing"; exit 1; }
done
grep -q 'route="/{prefix}/healthz"' "$LOG/metrics.txt" || { echo "FAIL: route template label missing"; exit 1; }
grep -q "$PREFIX" "$LOG/metrics.txt" && { echo "FAIL: route prefix leaked into metrics"; exit 1; }
grep -qF "$NEW_TOKEN" "$LOG/metrics.txt" && { echo "FAIL: a subscription token leaked into metrics"; exit 1; }
grep -q 'route="/{prefix}/sub/{token}"' "$LOG/metrics.txt" || { echo "FAIL: subscription route not labelled by template"; exit 1; }
[ "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:9109/)" = "404" ] \
  || { echo "FAIL: metrics listener serves more than /metrics"; exit 1; }
# Request IDs: accepted requests get one (a valid incoming id is echoed);
# rejections get no header at all (byte-identical, checked above).
curl -s --noproxy '*' -D - -o /dev/null "$BASE/healthz" | grep -qi '^x-request-id: [0-9a-f]\{32\}' \
  || { echo "FAIL: no minted request id on a real response"; exit 1; }
curl -s --noproxy '*' -D - -o /dev/null -H 'X-Request-Id: smoke-req-1' "$BASE/healthz" | grep -qi '^x-request-id: smoke-req-1' \
  || { echo "FAIL: incoming request id not echoed"; exit 1; }
curl -s --noproxy '*' -D - -o /dev/null -H 'X-Request-Id: smoke-req-1' "$BASE/nope" | grep -qi '^x-request-id' \
  && { echo "FAIL: request id on a rejection"; exit 1; }
[ "$(fp -H 'X-Request-Id: smoke-req-1' "$BASE/nope")" = "$REJ" ] || { echo "FAIL: rejection differs with a request id"; exit 1; }
echo "m1a: ok"

echo "== SPA =="
[ "$(code "$BASE/app")" = "200" ] || { echo "FAIL: /app not 200"; exit 1; }
grep -q 'id="root"' /tmp/akari-smoke/last || { echo "FAIL: SPA index has no root div"; exit 1; }
JS=$(grep -o "/$PREFIX/assets/[^\"]*\.js" /tmp/akari-smoke/last | head -1)
[ -n "$JS" ] || { echo "FAIL: SPA index did not reference prefixed asset"; exit 1; }
CT=$(curl -s --noproxy '*' -o /dev/null -w "%{content_type}" "http://127.0.0.1:8080$JS")
echo "$CT" | grep -q javascript || { echo "FAIL: asset content-type '$CT'"; exit 1; }
# The SPA's own stylesheet and script must be allowed by the CSP it is served
# with (a real-browser check found style-src missing 'self': unstyled UI).
CSP=$(curl -s --noproxy '*' -D - -o /dev/null "$BASE/app" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-security-policy"{print $2}')
echo "$CSP" | grep -Eq "style-src[^;]*'self'" || { echo "FAIL: CSP style-src lacks 'self': $CSP"; exit 1; }
echo "$CSP" | grep -Eq "default-src[^;]*'self'" || { echo "FAIL: CSP default-src lacks 'self': $CSP"; exit 1; }
grep -q "/$PREFIX/assets/[^\"]*\.css" /tmp/akari-smoke/last || { echo "FAIL: SPA index has no prefixed stylesheet"; exit 1; }
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

echo "== S4-3 SIGTERM: agent streams end, final flush, clean exit =="
"$PANEL" node add term-node --out "$LOG/term-bootstrap.toml" >/dev/null
"$AGENT" -config "$LOG/term-bootstrap.toml" -state-dir "$LOG/state-term" >"$LOG/term-agent.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 15); do grep -q "channel established" "$LOG/term-agent.log" && break; sleep 1; done
grep -q "channel established" "$LOG/term-agent.log" || { echo "FAIL: term agent never connected"; exit 1; }
kill -TERM $PANEL_PID
EXIT=""
for _ in $(seq 1 24); do
  if ! kill -0 $PANEL_PID 2>/dev/null; then EXIT=0; wait $PANEL_PID || EXIT=$?; break; fi
  sleep 0.5
done
[ "$EXIT" = "0" ] || { echo "FAIL: panel did not exit cleanly within 12 s after SIGTERM (exit '$EXIT')"; tail -5 "$LOG/panel.log"; exit 1; }
for m in "SIGTERM received" "agent sessions ended" "final traffic flush done" "shutdown complete"; do
  grep -q "$m" "$LOG/panel.log" || { echo "FAIL: shutdown log lacks '$m'"; tail -8 "$LOG/panel.log"; exit 1; }
done
grep -q 'panel shutting down' "$LOG/term-agent.log" || { echo "FAIL: agent stream not ended with 'panel shutting down'"; grep 'channel closed' "$LOG/term-agent.log" | tail -2; exit 1; }
kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
AGENT_PID=""
echo "sigterm: ok"

echo "== M1-9 rotate-prefix: the old prefix is a rejection after restart =="
OLD_BASE="$BASE"
"$PANEL" secrets rotate-prefix | grep -q "new route prefix" || { echo "FAIL: CLI rotate-prefix"; exit 1; }
PREFIX=$("$PANEL" info | awk '/route prefix/{sub(/^\//,"",$3); print $3}')
BASE="http://127.0.0.1:8080/$PREFIX"
[ "$BASE" != "$OLD_BASE" ] || { echo "FAIL: prefix unchanged"; exit 1; }
# R18-3: notify_url still carries the old prefix: the panel refuses to start.
"$PANEL" -c "$LOG/panel.toml" serve >"$LOG/panel-stale.log" 2>&1 \
  && { echo "FAIL: started with a stale payments.alipay.notify_url"; exit 1; }
grep -q 'notify_url does not carry' "$LOG/panel-stale.log" || { echo "FAIL: stale notify_url error"; cat "$LOG/panel-stale.log"; exit 1; }
grep -qF "${OLD_BASE##*/}" "$LOG/panel-stale.log" && { echo "FAIL: the old prefix appears in the startup error"; exit 1; }
sed -i "s|^notify_url = .*|notify_url = \"http://127.0.0.1:8080/$PREFIX/pay/alipay/notify\"|" "$LOG/panel.toml"
"$PANEL" -c "$LOG/panel.toml" serve >"$LOG/panel2.log" 2>&1 &
PANEL_PID=$!
for _ in $(seq 1 20); do [ "$(code "$BASE/healthz")" = "200" ] && break; sleep 0.5; done
[ "$(code "$BASE/healthz")" = "200" ] || { echo "FAIL: new prefix not served"; exit 1; }
[ "$(fp "$OLD_BASE/healthz")" = "$REJ" ] || { echo "FAIL: old prefix still answers"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'secrets.rotate_prefix'")" = "1" ] || { echo "FAIL: rotate-prefix not audited"; exit 1; }
for p in "$PREFIX" "${OLD_BASE##*/}"; do
  grep -qF "$p" "$LOG/panel.log" "$LOG/panel2.log" && { echo "FAIL: a route prefix appears in the panel log"; exit 1; }
done
grep -qF "$NEW_TOKEN" "$LOG/panel.log" "$LOG/panel2.log" && { echo "FAIL: a subscription token appears in the panel log"; exit 1; }
kill $PANEL_PID 2>/dev/null; wait $PANEL_PID 2>/dev/null || true
echo "rotate-prefix: ok"

echo
echo "SMOKE TEST PASSED"
