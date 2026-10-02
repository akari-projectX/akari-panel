#!/usr/bin/env bash
# Cross-repo end-to-end smoke test. Lives in akari-panel (the integrator) and
# expects the sibling checkout convention: ../akari-agent must exist.
set -euo pipefail
cd "$(dirname "$0")"

# Pattern test on a command's output that READS ALL OF IT (grep -q exits at
# the first match; the writer's next write then fails with EPIPE/SIGPIPE and
# pipefail turns a match into a FAIL — flaky, depending on chunking). Use
# `cmd | matches [grep flags] PATTERN`, never `cmd | grep -q`, and
# `| sed -n 1p` instead of `| head -1`.
matches() { grep "$@" >/dev/null; }
if grep -nE '^[^#]*[^|]\| *(grep -[a-zA-Z]*q|head -(n *)?1([^0-9]|$))' smoke.sh scripts/*.sh; then
  echo "FAIL: early-exiting pipe consumer above (use matches / sed -n 1p)"; exit 1
fi

# R22 (main domain behind Caddy): the PANEL itself dials https://myapp.test
# (install-link TLS pin probe), so the name must resolve to loopback here
# (CI adds it to /etc/hosts; curl calls use --resolve).
getent hosts myapp.test | matches -E '^(127\.0\.0\.1|::1)[[:space:]]' \
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
docker compose exec -T postgres psql -U akari -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$SMOKE_DB'" | matches 1 \
  || docker compose exec -T postgres psql -U akari -d postgres -qc "CREATE DATABASE \"$SMOKE_DB\"" >/dev/null
rm -rf "$LOG" data "$BOOT" "$JAR" && mkdir -p "$LOG"

# Clean up any leftovers from earlier runs (zombie panels keep port 8443).
# Anchored full-command-line patterns: only the exact processes this script
# starts (panel binary here, any sibling agent checkout's binary with this
# script's bootstrap file) — never a shell that merely mentions them.
pkill -f '^\./target/release/akari (-c [^ ]+ )?serve$' 2>/dev/null || true
pkill -f "^[A-Za-z0-9_./-]+/agent -config ${BOOT//./\\.}( .*)?\$" 2>/dev/null || true
# M6 self-update node (W18: a systemd container).
docker rm -f akari-smoke-upd >/dev/null 2>&1 || true
sleep 1
UPD_CONTAINER=""
cleanup_upd() {
  if [ -n "$UPD_CONTAINER" ]; then
    docker rm -f akari-smoke-upd >/dev/null 2>&1 || true
    UPD_CONTAINER=""
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

# W11 latency tests: a local test URL (the 204 server below), short cooldown.
[probe]
urls = ["http://127.0.0.1:18204/generate_204"]
timeout_ms = 2000
manual_cooldown_secs = 5

# W10: agents of nodes with a TLS domain order from the local pebble CA
# (docker, W10 section), never from Let's Encrypt.
[acme]
directory_url = "https://127.0.0.1:14000/dir"

# W17: evaluate node alerts and deliver notifications every 5 s.
[alerts]
eval_interval_secs = 5
TOML
# Helper servers (payment mock, latency target) must die with this script
# on EVERY exit path, a crash or kill -9 included: they inherit the caller's
# file descriptors, so a leftover one would keep holding `flock smoke.lock`
# for every later run. Each one closes its inherited descriptors and exits
# as soon as its parent (this shell) is gone; the EXIT traps kill them too.
TIE_PY='import os, sys, threading, time
os.closerange(3, 65536)
_parent = os.getppid()
def _watch():
    while os.getppid() == _parent:
        time.sleep(1)
    os._exit(0)
threading.Thread(target=_watch, daemon=True).start()
'
# W11: the agents' latency test target (204, like generate_204); dies with
# the smoke run.
python3 -c "$TIE_PY"'
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", 18204), H).serve_forever()
' >/dev/null 2>&1 &
W11_PROBE_PID=$!
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
pkill -f "$PAY/mock.py $PAY\$" 2>/dev/null || true
python3 -c "$TIE_PY"'
import runpy, sys
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
' "$PAY/mock.py" "$PAY" >"$LOG/mock-alipay.log" 2>&1 &
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
trap 'cleanup_upd; kill $PANEL_PID ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT
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
# Catalogue rows a run aborted midway leaves behind (names are unique).
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "TRUNCATE plans, node_groups, coupons CASCADE;" >/dev/null 2>&1 || true
# R22 settings left behind by an aborted run (e.g. a node domain the agents
# here cannot reach): back to "use panel.toml" (the trigger reloads them).
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "UPDATE panel_settings SET version = 0, main_domain = NULL, sub_domain = NULL, node_domain = NULL, trust_cloudflare = NULL, probe_interval_secs = NULL, probe_urls = NULL, probe_panel_tcp = NULL; TRUNCATE grpc_server_names;" >/dev/null 2>&1 || true
# W15 settings back to the defaults (off; version 0) and an empty outbox.
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "DELETE FROM signup_settings; INSERT INTO signup_settings (id) VALUES (1); DELETE FROM smtp_settings; INSERT INTO smtp_settings (id) VALUES (1); TRUNCATE mail_outbox;" >/dev/null 2>&1 || true
# W17: alert settings an aborted run may leave (a webhook to a dead receiver).
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "TRUNCATE node_alerts, alert_notifications; UPDATE alert_settings SET version = 0, enabled = true, offline_secs = 300, webhook_enabled = false, webhook_url = NULL, webhook_secret_enc = NULL, telegram_enabled = false, telegram_chat_id = NULL, telegram_token_enc = NULL, email_enabled = false, email_to = '{}';" >/dev/null 2>&1 || true
vk flushdb >/dev/null

echo "== first admin (env password) =="
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" admin add root | tee "$LOG/admin-add.out"
# R18: admin 2FA is optional (recommended); no one-time enrollment code.
grep -q "two-factor authentication is recommended" "$LOG/admin-add.out" || { echo "FAIL: admin add lacks the 2FA hint"; exit 1; }
grep -qE '^  [A-Z2-7]{4}(-[A-Z2-7]{1,4})+$' "$LOG/admin-add.out" && { echo "FAIL: admin add still prints an enrollment code"; exit 1; }
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" admin add root 2>&1 | matches "created admin account: root" \
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
head -1 /tmp/akari-smoke/fphead | matches " 404" || { echo "FAIL: rejection is not 404"; cat /tmp/akari-smoke/fphead; exit 1; }
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
    "$BASE/assets/missing.js" \
    "$BASE/admin" \
    "$BASE/admin/users" \
    "$BASE/admin/assets/missing.js"; do
  # shellcheck disable=SC2086
  [ "$(fp $probe)" = "$REJ" ] || { echo "FAIL: rejection differs for: $probe"; cat /tmp/akari-smoke/fphead; exit 1; }
done
# Real responses keep the security headers.
curl -s --noproxy '*' -D - -o /dev/null "$BASE/healthz" | matches -i '^x-frame-options: DENY' \
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
curl -s --noproxy '*' "$SUB" | base64 -d 2>/dev/null | matches "vless://.*@node1.example.test:11443" \
  || { echo "FAIL: base64 links missing vless"; exit 1; }
curl -s --noproxy '*' -A "sing-box/1.12.0" "$SUB" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); ob=[o for o in d['outbounds'] if o.get('type')=='vless']; assert ob and ob[0]['server']=='node1.example.test' and ob[0]['server_port']==11443" \
  || { echo "FAIL: sing-box format"; exit 1; }
curl -s --noproxy '*' -A "clash-meta/1.19" "$SUB" | matches "^    type: vless" \
  || { echo "FAIL: clash format"; exit 1; }
INFO=$(curl -s --noproxy '*' -D - -o /dev/null "$SUB" | grep -i "^subscription-userinfo:")
echo "$INFO" | matches "download=0" && echo "$INFO" | matches "total=107374182400" \
  || { echo "FAIL: subscription-userinfo header: $INFO"; exit 1; }
SIZE=$(curl -s --noproxy '*' -o /tmp/akari-smoke/subbody "$SUB" && wc -c < /tmp/akari-smoke/subbody)
[ "$SIZE" -ge 8192 ] || { echo "FAIL: body not padded ($SIZE bytes)"; exit 1; }
# Wrong token: identical rejection (checked above), never quota headers.
curl -s --noproxy '*' -D - -o /dev/null "$BASE/sub/not-a-real-token" | matches -i "subscription-userinfo" \
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
  curl -s --noproxy '*' "$FP_SUB" | base64 -d 2>/dev/null | matches "security=reality.*&fp=$1" \
    || { echo "FAIL: link lacks fp=$1"; exit 1; }
  curl -s --noproxy '*' -A "clash-meta/1.19" "$FP_SUB" | matches "^    client-fingerprint: $1" \
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
# W11: frequent heartbeats here (production default 15 s) when supported.
HB_FLAG=""
"$AGENT" -h 2>&1 | matches heartbeat-interval && HB_FLAG="-heartbeat-interval 2s"
# shellcheck disable=SC2086
"$AGENT" -config "$BOOT" -state-dir "$LOG/state-main" $HB_FLAG >"$LOG/agent.log" 2>&1 &
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
    grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | matches "\"users\":$1[,}]" && return 0
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

echo "== W12: agent capabilities (gates for agent-dependent sections) =="
# Sections that exercise an AGENT feature run only when the agent under test
# has it and otherwise SKIP LOUDLY (a panel PR may land before the agent PR:
# panel-first merge order, CLAUDE.md). The gate is what the panel recorded
# from the agent's Hello (admin API: agent_protocol, agent_capabilities).
# Skips cannot hide a regression: the agent checkout's own source declares
# its protocol and capabilities, and the panel must have recorded exactly
# those (an agent that stops advertising, or a panel that stops recording,
# fails right here instead of silently skipping). SMOKE_REQUIRE_AGENT=1
# (CI's agent_ref dispatch runs) turns every skip into a failure.
AGENT_SRC_PROTO=$(sed -n 's/^const agentProtocol = \([0-9][0-9]*\)$/\1/p' "$AGENT_DIR/agent.go")
[ -n "$AGENT_SRC_PROTO" ] || { echo "FAIL: cannot read agentProtocol from $AGENT_DIR/agent.go"; exit 1; }
AGENT_SRC_CAPS=$(sed -n 's/^var agentCapabilities = \[\]string{\(.*\)}$/\1/p' "$AGENT_DIR/agent.go" \
  | tr -d '" ' | tr ',' '\n' | sed '/^$/d' | sort -u | paste -sd, -)
if [ -z "$AGENT_SRC_CAPS" ] && grep -q 'agentCapabilities' "$AGENT_DIR/agent.go"; then
  echo "FAIL: agent.go declares agentCapabilities in a form this smoke cannot read; update the parser"; exit 1
fi
for _ in $(seq 1 20); do [ "$(node_field agent_protocol)" = "$AGENT_SRC_PROTO" ] && break; sleep 0.5; done
AGENT_PROTO=$(node_field agent_protocol)
AGENT_CAPS=$(node_field agent_capabilities | python3 -c "import json,sys; print(','.join(sorted(set(json.load(sys.stdin) or []))))")
[ "$AGENT_PROTO" = "$AGENT_SRC_PROTO" ] \
  || { echo "FAIL: agent source declares protocol $AGENT_SRC_PROTO, the panel recorded $AGENT_PROTO"; exit 1; }
[ "$AGENT_CAPS" = "$AGENT_SRC_CAPS" ] \
  || { echo "FAIL: agent source declares capabilities [$AGENT_SRC_CAPS], the panel recorded [$AGENT_CAPS]"; exit 1; }
echo "agent under test: protocol $AGENT_PROTO, capabilities [$AGENT_CAPS] ($(git -C "$AGENT_DIR" describe --tags --always 2>/dev/null || echo '?'))"
SKIPPED=()
# agent_has REQ: REQ = "protocol>=N" or "cap:NAME" (from the gate above).
agent_has() {
  case "$1" in
    protocol\>=*) [ "$AGENT_PROTO" -ge "${1#protocol>=}" ] ;;
    cap:*) [[ ",$AGENT_CAPS," == *",${1#cap:},"* ]] ;;
    *) echo "FAIL: bad agent requirement '$1'"; exit 1 ;;
  esac
}
# need_agent REQ SECTION: 0 = run the section; else print the loud skip
# (and a GitHub warning annotation) and return 1.
need_agent() {
  agent_has "$1" && return 0
  local msg="SKIP: agent lacks $1 (protocol $AGENT_PROTO, capabilities [$AGENT_CAPS]) - '$2' not exercised; run ci with agent_ref=<agent branch>"
  echo "$msg"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning title=smoke skipped an agent-dependent section::$msg"
  if [ "${SMOKE_REQUIRE_AGENT:-0}" = 1 ]; then echo "FAIL: SMOKE_REQUIRE_AGENT=1 forbids skips"; exit 1; fi
  SKIPPED+=("$2 (needs $1)")
  return 1
}

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
grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | matches '"via":"delta"' \
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
# SS2022 is a managed protocol from W8 on (agent protocol >= 4).
if need_agent "protocol>=4" "W9 Shadowsocks 2022 delta/snapshot"; then
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
fi

echo "== Sprint 3a: protocol + lease surfaced on the node =="
[ "$(node_field agent_protocol)" -ge 3 ] || { echo "FAIL: agent_protocol $(node_field agent_protocol)"; exit 1; }
LEASE=$(node_field lease_remaining_seconds)
[ "$LEASE" != "null" ] && [ "$LEASE" -gt 80000 ] || { echo "FAIL: lease_remaining_seconds '$LEASE'"; exit 1; }
echo "lease: ok (${LEASE}s left)"

echo "== node online + heartbeat =="
STATUS=$(docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -tAc "SELECT status FROM nodes WHERE id='$NODE_ID'")
[ "$STATUS" = "online" ] || { echo "FAIL: node status '$STATUS'"; exit 1; }
vk exists "akari:node:online:$NODE_ID" | matches 1 \
  || { echo "FAIL: online key missing"; exit 1; }

echo "== W11: node form fields, multiplier billing, machine status, latency =="
psql_q() { docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -tAc "$1"; }
# Agent-side assertions need the agent capabilities "metrics" / "latency"
# (W12 gates); the panel-side ones always run.
# xboard-style fields: display name, tags, multiplier, connect override.
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" \
    '{"display_name":"冒烟 01","tags":["IPLC","0.5x"],"traffic_rate":0.5,"sort":1,"connect_overrides":{"in-vless":{"host":"127.0.0.1","port":11443}}}')" = "200" ] \
  || { echo "FAIL: W11 node fields"; cat /tmp/akari-smoke/last; exit 1; }
grep -q '"traffic_rate_permille":500' /tmp/akari-smoke/last || { echo "FAIL: multiplier not stored"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"traffic_rate":0.0001}')" = "400" ] || { echo "FAIL: bad multiplier accepted"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"connect_overrides":{"nope":{"port":1}}}')" = "400" ] \
  || { echo "FAIL: override for an unknown inbound accepted"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='node.update' AND target_id='$NODE_ID' AND after->>'traffic_rate_permille' = '500'")" -ge 1 ] \
  || { echo "FAIL: W11 node update not audited"; exit 1; }
# Multiplier on a real transfer: user D on the 0.5x node bills half the
# bytes the node accepted for D (floor per row: never more).
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-user-d","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create user D"; exit 1; }
USER_D=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
SUB_D=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['sub_token'])")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_D/nodes/$NODE_ID" -H 'Content-Type: application/json' \
    -d '{"inbound_tag":"in-vless","protocol":"vless"}')" = "201" ] || { echo "FAIL: assign D"; exit 1; }
VLESS_D=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['account']['id'])")
cat >"$LOG/w11-vless.py" <<'PY'
import socket, struct, sys, threading, time, uuid
echo = socket.socket(); echo.bind(("127.0.0.1", 0)); echo.listen(1)
def serve():
    c, _ = echo.accept()
    for d in iter(lambda: c.recv(65536), b""): c.sendall(d)
threading.Thread(target=serve, daemon=True).start()
for attempt in range(40):  # the user is added by a delta: retry until admitted
    try:
        s = socket.create_connection(("127.0.0.1", 11443), timeout=5)
        s.sendall(b"\x00" + uuid.UUID(sys.argv[1]).bytes + b"\x00\x01" + struct.pack(">H", echo.getsockname()[1]) + b"\x01" + socket.inet_aton("127.0.0.1"))
        msg = b"w" * 300000; s.sendall(msg); got = b""
        while len(got) < len(msg) + 2:
            d = s.recv(65536)
            if not d: raise EOFError
            got += d
        print("w11 vless round trip ok"); sys.exit(0)
    except (OSError, EOFError):
        time.sleep(0.5)
sys.exit("w11 vless round trip failed")
PY
NODE_TOTALS0=$(psql_q "SELECT traffic_raw_bytes || ' ' || traffic_billed_bytes FROM nodes WHERE id='$NODE_ID'")
python3 "$LOG/w11-vless.py" "$VLESS_D" || { echo "FAIL: vless round trip for D"; exit 1; }
for _ in $(seq 1 40); do
  [ "$(psql_q "SELECT traffic_used_bytes FROM users WHERE id='$USER_D'")" -ge 300000 ] && break; sleep 1
done
RAW_D=$(psql_q "SELECT coalesce(sum(up_bytes + down_bytes), 0) FROM traffic_counters WHERE node_id='$NODE_ID' AND user_id='$USER_D'")
USED_D=$(psql_q "SELECT traffic_used_bytes FROM users WHERE id='$USER_D'")
python3 -c "
raw, used = $RAW_D, $USED_D
assert raw >= 600000, f'raw {raw}'
assert 2 * used <= raw, f'over-billed: used {used} raw {raw}'
assert raw - 2 * used <= 64, f'0.5x bills half: used {used} raw {raw}'
" || { echo "FAIL: multiplier billing (raw $RAW_D, used $USED_D)"; exit 1; }
# Node totals since the rate change: everything billed there was at 0.5x.
NODE_TOTALS1=$(psql_q "SELECT traffic_raw_bytes || ' ' || traffic_billed_bytes FROM nodes WHERE id='$NODE_ID'")
python3 -c "
r0, b0 = map(int, '$NODE_TOTALS0'.split()); r1, b1 = map(int, '$NODE_TOTALS1'.split())
assert r1 - r0 >= $RAW_D - 1, (r0, r1)
assert 2 * (b1 - b0) <= r1 - r0, (b0, b1, r0, r1)
" || { echo "FAIL: node raw/billed totals ($NODE_TOTALS0 -> $NODE_TOTALS1, D raw $RAW_D)"; exit 1; }
echo "multiplier: ok (raw $RAW_D bytes, billed $USED_D at 0.5x)"
# Subscription: display name + tags name the proxy, the override is dialed.
curl -s --noproxy '*' -A 'clash.meta' "$BASE/sub/$SUB_D" >"$LOG/w11-sub.yaml"
grep -q '"冒烟 01 | IPLC | 0.5x"' "$LOG/w11-sub.yaml" || { echo "FAIL: subscription name"; head -20 "$LOG/w11-sub.yaml"; exit 1; }
grep -q 'server: 127.0.0.1' "$LOG/w11-sub.yaml" || { echo "FAIL: connect override not in subscription"; exit 1; }
# Portal: the user's node list (no ids/addresses).
DJAR="$LOG/w11-d.jar"
[ "$(code -c "$DJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-user-d","password":"user-password-123"}')" = "200" ] || { echo "FAIL: user D login"; exit 1; }
[ "$(code -b "$DJAR" "$BASE/api/v1/me/nodes")" = "200" ] || { echo "FAIL: /me/nodes"; exit 1; }
python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last'))
assert len(v) == 1 and v[0]['name'] == '冒烟 01' and v[0]['rate'] == 0.5 and v[0]['online'] is True, v
assert 'id' not in v[0] and 'server_addr' not in v[0], v
" || { echo "FAIL: /me/nodes content"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$DJAR" "$BASE/api/v1/nodes/$NODE_ID/status")" = "403" ] || { echo "FAIL: user reads node status"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"visible":false}')" = "200" ] || { echo "FAIL: hide node"; exit 1; }
code -b "$DJAR" "$BASE/api/v1/me/nodes" >/dev/null
[ "$(cat /tmp/akari-smoke/last)" = "[]" ] || { echo "FAIL: hidden node listed to the user"; exit 1; }
curl -s --noproxy '*' -A 'clash.meta' "$BASE/sub/$SUB_D" >"$LOG/w11-sub-hidden.yaml"
grep -q '冒烟' "$LOG/w11-sub-hidden.yaml" && { echo "FAIL: hidden node in subscription"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"visible":true}')" = "200" ] || { echo "FAIL: show node"; exit 1; }
echo "portal + subscription: ok"

if need_agent cap:metrics "W11 machine status"; then
  # Machine status: the heartbeat blob carries metrics; history and
  # Prometheus fleet gauges follow.
  for _ in $(seq 1 30); do
    vk get "akari:node:hb:$NODE_ID" | matches '"online_users"' && break; sleep 1
  done
  vk get "akari:node:hb:$NODE_ID" | matches '"xray_version"' || { echo "FAIL: heartbeat lacks machine status"; vk get "akari:node:hb:$NODE_ID"; exit 1; }
  [ "$(code -b "$JAR" "$BASE/api/v1/nodes/$NODE_ID/status")" = "200" ] || { echo "FAIL: node status API"; exit 1; }
  python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last')); m = v['heartbeat']['metrics']
assert v['online'] is True and v['heartbeat']['mem_total_bytes'] > 0, v
assert m['cpu_count'] >= 1 and m['disk_total_bytes'] > 0 and m['xray_version'], m
assert v['traffic_rate'] == 0.5, v
" || { echo "FAIL: node status content"; cat /tmp/akari-smoke/last; exit 1; }
  for _ in $(seq 1 15); do [ "$(psql_q "SELECT count(*) FROM node_metrics_1m WHERE node_id='$NODE_ID'")" -ge 1 ] && break; sleep 1; done
  [ "$(code -b "$JAR" "$BASE/api/v1/nodes/$NODE_ID/metrics?range=1h")" = "200" ] || { echo "FAIL: metrics API"; exit 1; }
  python3 -c "import json; v = json.load(open('/tmp/akari-smoke/last')); assert v['points'] and v['points'][0]['mem_total'] > 0, v" \
    || { echo "FAIL: no metrics history"; cat /tmp/akari-smoke/last; exit 1; }
  # (to a file: `curl | matches` fails under pipefail when grep exits first)
  curl -s --noproxy '*' http://127.0.0.1:9109/metrics >"$LOG/w11-metrics.txt"
  grep -q '^akari_fleet{kind="nodes_reporting"} 1$' "$LOG/w11-metrics.txt" \
    || { echo "FAIL: fleet gauge"; grep akari_fleet "$LOG/w11-metrics.txt"; exit 1; }
  echo "machine status: ok"
fi
if need_agent cap:latency "W11 latency test"; then
  # Latency: "立即测速" -> the agent tests the (local) URL from [probe], the
  # panel TCP-tests the inbound's connect address; a second request inside
  # the cooldown is refused.
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes/$NODE_ID/probe")" = "202" ] || { echo "FAIL: probe request"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes/$NODE_ID/probe")" = "429" ] || { echo "FAIL: probe cooldown"; exit 1; }
  for _ in $(seq 1 40); do
    [ "$(psql_q "SELECT count(*) FROM node_latency WHERE node_id='$NODE_ID' AND source='agent' AND delay_ms IS NOT NULL AND target='http://127.0.0.1:18204/generate_204' AND measured_at > now() - interval '1 minute'")" = "1" ] \
      && [ "$(psql_q "SELECT count(*) FROM node_latency WHERE node_id='$NODE_ID' AND source='panel' AND target='in-vless' AND delay_ms IS NOT NULL")" = "1" ] && break
    sleep 1
  done
  [ "$(psql_q "SELECT count(*) FROM node_latency WHERE node_id='$NODE_ID' AND source='agent' AND delay_ms IS NOT NULL")" -ge 1 ] \
    || { echo "FAIL: no agent latency result"; psql_q "SELECT * FROM node_latency"; grep latency "$LOG/agent.log" | tail -3; exit 1; }
  [ "$(psql_q "SELECT count(*) FROM node_latency WHERE node_id='$NODE_ID' AND source='panel' AND delay_ms IS NOT NULL")" -ge 1 ] \
    || { echo "FAIL: no panel TCP latency"; psql_q "SELECT * FROM node_latency"; exit 1; }
  code -b "$DJAR" "$BASE/api/v1/me/nodes" >/dev/null
  python3 -c "import json; v = json.load(open('/tmp/akari-smoke/last')); assert v[0]['latency_status'] == 'ok' and v[0]['latency_ms'] >= 1, v" \
    || { echo "FAIL: portal latency"; cat /tmp/akari-smoke/last; exit 1; }
  echo "latency: ok ($(psql_q "SELECT source || ' ' || target || ' ' || delay_ms || 'ms' FROM node_latency WHERE node_id='$NODE_ID' ORDER BY source" | tr '\n' ';'))"
fi
echo "-- W12: latency-test settings in 系统设置 (versioned, audited, reloaded on every instance) --"
put_probe() { code -b "$JAR" -X PUT "$BASE/api/v1/settings/probe" -H 'Content-Type: application/json' -d "$1"; }
[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings"; exit 1; }
SV=$(python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last')); p = v['probe']
assert p['urls']['source'] == 'config' and p['urls']['effective'] == ['http://127.0.0.1:18204/generate_204'], p
assert p['interval_secs']['effective'] == 18000 and p['panel_tcp']['effective'] is True, p
print(v['version'])") || { echo "FAIL: probe settings view"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(put_probe "{\"version\":$SV,\"interval_secs\":60,\"urls\":null,\"panel_tcp\":null}")" = "400" ] \
  || { echo "FAIL: probe interval below 10 min accepted"; exit 1; }
[ "$(put_probe "{\"version\":$SV,\"interval_secs\":1200,\"urls\":[\"http://127.0.0.1:18204/generate_204?via=settings\"],\"panel_tcp\":true}")" = "200" ] \
  || { echo "FAIL: save probe settings"; cat /tmp/akari-smoke/last; exit 1; }
python3 -c "
import json; p = json.load(open('/tmp/akari-smoke/last'))['probe']
assert p['interval_secs']['effective'] == 1200 and p['interval_secs']['source'] == 'settings', p
assert p['urls']['effective'] == ['http://127.0.0.1:18204/generate_204?via=settings'], p
assert p['panel_tcp']['source'] == 'settings', p
" || { echo "FAIL: probe settings not applied"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(put_probe "{\"version\":$SV,\"interval_secs\":null,\"urls\":null,\"panel_tcp\":null}")" = "409" ] \
  || { echo "FAIL: stale probe form accepted"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='settings.probe.update' AND after->>'probe_interval_secs' = '1200'")" = "1" ] \
  || { echo "FAIL: probe settings not audited"; exit 1; }
echo "probe settings: ok (version $SV -> $((SV + 1)))"
if need_agent cap:latency "W12 probe settings reach the agent"; then
  # W12: the URL saved in 系统设置 reached the connected agent (notify ->
  # reload -> session re-sends LatencyProbeConfig): the next "立即测速"
  # tests it. Wait out the agent's 10 s gap after its last run first: a
  # request inside it is coalesced, and agents before the W12 fix lose a
  # coalesced request when the interval changes at the same time.
  sleep 11
  for _ in $(seq 1 20); do
    [ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes/$NODE_ID/probe")" = "202" ] && break; sleep 1
  done
  for _ in $(seq 1 30); do
    [ "$(psql_q "SELECT count(*) FROM node_latency WHERE node_id='$NODE_ID' AND source='agent' AND delay_ms IS NOT NULL AND target='http://127.0.0.1:18204/generate_204?via=settings'")" = "1" ] && break
    sleep 1
  done
  [ "$(psql_q "SELECT count(*) FROM node_latency WHERE node_id='$NODE_ID' AND source='agent' AND target='http://127.0.0.1:18204/generate_204?via=settings'")" = "1" ] \
    || { echo "FAIL: the agent did not test the URL from 系统设置"; psql_q "SELECT * FROM node_latency WHERE source='agent'"; exit 1; }
  echo "probe settings reached the agent: ok"
fi
# Back to panel.toml's [probe] through the CLI (audited as cli; the running
# panel reloads through the notification).
"$PANEL" settings unset probe >"$LOG/unset-probe.out" || { echo "FAIL: settings unset probe"; cat "$LOG/unset-probe.out"; exit 1; }
"$PANEL" settings show >"$LOG/settings-show.out"
matches 'probe interval: *(not set) *-> 18000s \[Config\]' <"$LOG/settings-show.out" \
  || { echo "FAIL: settings show (probe)"; cat "$LOG/settings-show.out"; exit 1; }
for _ in $(seq 1 20); do
  code -b "$JAR" "$BASE/api/v1/settings" >/dev/null
  python3 -c "import json; p = json.load(open('/tmp/akari-smoke/last'))['probe']; assert p['urls']['source'] == 'config'" 2>/dev/null && break
  sleep 0.5
done
python3 -c "import json; p = json.load(open('/tmp/akari-smoke/last'))['probe']; assert p['urls']['source'] == 'config' and p['interval_secs']['effective'] == 18000, p" \
  || { echo "FAIL: running panel did not reload the unset probe settings"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='settings.probe.update' AND actor_login='cli'")" = "1" ] \
  || { echo "FAIL: CLI probe unset not audited"; exit 1; }
# Back to the defaults the rest of the smoke expects.
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"display_name":null,"tags":[],"traffic_rate":1,"sort":0,"connect_overrides":null}')" = "200" ] \
  || { echo "FAIL: reset W11 fields"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$USER_D")" = "204" ] || { echo "FAIL: delete D"; exit 1; }
# The test-URL server is done (background helpers inherit the caller's
# flock descriptor: never leave one running).
kill "$W11_PROBE_PID" 2>/dev/null || true

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

echo "== W15 registration, password reset, SMTP outbox (Mailpit as the SMTP sink) =="
# Mailpit (docker, host network, loopback only): SMTP 127.0.0.1:11025, API
# 127.0.0.1:18025. The panel's outbox sender delivers to it; the steps read
# codes and links through its API, like a user reading their mail.
MP_API="http://127.0.0.1:18025/api/v1"
docker rm -f akari-smoke-mailpit >/dev/null 2>&1 || true
docker run -d --name akari-smoke-mailpit --network host -e MP_SMTP_BIND_ADDR=127.0.0.1:11025 \
  -e MP_UI_BIND_ADDR=127.0.0.1:18025 axllent/mailpit:v1.27 >/dev/null
trap 'docker rm -f akari-smoke-mailpit >/dev/null 2>&1 || true; cleanup_upd; kill $PANEL_PID ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -sf --noproxy '*' "$MP_API/info" >/dev/null && break; sleep 0.5; done
curl -sf --noproxy '*' "$MP_API/info" >/dev/null || { echo "FAIL: mailpit did not start"; docker logs akari-smoke-mailpit 2>&1 | tail -5; exit 1; }
# mp_mail ADDR N: wait until ADDR has >= N messages; print the newest one's
# subject (line 1) and text body.
mp_mail() {
  python3 - "$MP_API" "$1" "$2" <<'PY'
import json, sys, time, urllib.parse, urllib.request
api, to, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(60):
    d = json.load(op.open(api + "/search?query=" + urllib.parse.quote("to:" + to)))
    if len(d["messages"]) >= n:
        m = json.load(op.open(api + "/message/" + d["messages"][0]["ID"]))
        print(m["Subject"]); print(m["Text"]); sys.exit(0)
    time.sleep(0.5)
sys.exit("no message #%d to %s" % (n, to))
PY
}
# Fingerprint without the per-request id (X-Request-Id) and Date.
fpr() {
  curl -s --noproxy '*' -D - -o /tmp/akari-smoke/fpbody "$@" | tr -d '\r' | grep -viE '^(date|x-request-id):' >/tmp/akari-smoke/fphead
  cat /tmp/akari-smoke/fphead /tmp/akari-smoke/fpbody | sha256sum | cut -d' ' -f1
}
J='Content-Type: application/json'
# Off by default: every self-service endpoint is the canonical rejection.
for p in register/code register password-reset/request password-reset; do
  [ "$(fp -X POST "$BASE/auth/$p" -H "$J" -d '{"email":"a@akari.test"}')" = "$REJ" ] \
    || { echo "FAIL: disabled /auth/$p is not the canonical rejection"; cat /tmp/akari-smoke/fphead; exit 1; }
done
[ "$(code "$BASE/auth/options")" = "200" ] && last_json "d['register'] or d['reset']" | matches False \
  || { echo "FAIL: auth options while disabled"; cat /tmp/akari-smoke/last; exit 1; }
SIGNUP_ON='"register_enabled":true,"invite_required":false,"invite_single_use":false,"invite_codes_per_user":5,"email_domains":[],"trial_plan_id":null,"trial_days":3,"reset_enabled":true'
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/signup" -H "$J" -d "{\"version\":0,$SIGNUP_ON}")" = "409" ] \
  || { echo "FAIL: registration enabled without mail"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/mail" -H "$J" -d '{"version":0,"enabled":true,"host":"127.0.0.1","port":11025,"security":"none","username":null,"from_addr":"noreply@akari.test","from_name":"Akari Smoke","notify_order_paid":true,"notify_expiry_days":3,"notify_expired":true,"notify_quota":true}')" = "200" ] \
  || { echo "FAIL: save SMTP settings"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/mail/test" -H "$J" -d '{"to":"admin@akari.test"}')" = "200" ] \
  || { echo "FAIL: test mail"; cat /tmp/akari-smoke/last; exit 1; }
mp_mail admin@akari.test 1 | sed -n 1p | matches '^Akari Smoke 测试邮件$' || { echo "FAIL: test mail not delivered"; exit 1; }
# Reset links need the main domain (never the request's Host): set it for
# this section only (IP literal; the host gate keeps accepting 127.0.0.1).
[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings"; exit 1; }
VER=$(last_json "d['version']")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings" -H "$J" \
    -d "{\"version\":$VER,\"main_domain\":\"127.0.0.1:8080\",\"sub_domain\":null,\"node_domain\":null,\"trust_cloudflare\":null}")" = "200" ] \
  || { echo "FAIL: set main domain"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/signup" -H "$J" -d "{\"version\":0,$SIGNUP_ON}")" = "200" ] \
  || { echo "FAIL: enable registration + reset"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code "$BASE/auth/options")" = "200" ] && last_json "d['register'] and d['reset']" | matches True \
  || { echo "FAIL: auth options while enabled"; exit 1; }
# Register: code by mail -> account + session; login by the address.
REG="smoke-reg-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')@akari.test"
NEW="smoke-new-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')@akari.test"
F1=$(fpr -X POST "$BASE/auth/register/code" -H "$J" -d "{\"email\":\"$REG\",\"locale\":\"en\"}")
grep -q '^HTTP/1.1 200' /tmp/akari-smoke/fphead || { echo "FAIL: register code request"; cat /tmp/akari-smoke/fphead /tmp/akari-smoke/fpbody; exit 1; }
REG_CODE=$(mp_mail "$REG" 1 | grep -oE '\b[0-9]{6}\b' | sed -n 1p)
[ -n "$REG_CODE" ] || { echo "FAIL: no code in the registration mail"; exit 1; }
RJAR="$LOG/reg-cookies"
[ "$(code -c "$RJAR" -X POST "$BASE/auth/register" -H "$J" \
    -d "{\"email\":\"$REG\",\"code\":\"$REG_CODE\",\"password\":\"reg-password-1\",\"locale\":\"en\"}")" = "200" ] \
  || { echo "FAIL: register"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$RJAR" "$BASE/api/v1/me")" = "200" ] && last_json "d['email_verified'] and d['email']=='$REG' and d['role']=='user'" | matches True \
  || { echo "FAIL: registered account"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -X POST "$BASE/auth/register" -H "$J" \
    -d "{\"email\":\"$REG\",\"code\":\"$REG_CODE\",\"password\":\"reg-password-1\"}")" = "400" ] \
  || { echo "FAIL: registration code reused"; exit 1; }
[ "$(code -X POST "$BASE/auth/login" -H "$J" -d "{\"login\":\"$(echo "$REG" | tr a-z A-Z)\",\"password\":\"reg-password-1\"}")" = "200" ] \
  || { echo "FAIL: login by (verified) email"; exit 1; }
# No existence oracle: a registered and a fresh address get byte-identical
# answers; the owner of the registered one gets an "already registered" mail.
F2=$(fpr -X POST "$BASE/auth/register/code" -H "$J" -d "{\"email\":\"$REG\",\"locale\":\"en\"}")
F3=$(fpr -X POST "$BASE/auth/register/code" -H "$J" -d "{\"email\":\"$NEW\",\"locale\":\"en\"}")
[ "$F1" = "$F2" ] && [ "$F2" = "$F3" ] || { echo "FAIL: code request answers differ by account existence"; exit 1; }
mp_mail "$REG" 2 | sed -n 1p | matches 'already has an account' || { echo "FAIL: no 'already registered' mail"; exit 1; }
mp_mail "$NEW" 1 | sed -n 1p | matches 'sign-up code' || { echo "FAIL: no code for the fresh address"; exit 1; }
# Password reset by link: every session ends, the link works once.
R1=$(fpr -X POST "$BASE/auth/password-reset/request" -H "$J" -d "{\"email\":\"$REG\"}")
R2=$(fpr -X POST "$BASE/auth/password-reset/request" -H "$J" -d "{\"email\":\"nobody-$NEW\"}")
[ "$R1" = "$R2" ] || { echo "FAIL: reset answers differ by account existence"; exit 1; }
RESET_TOKEN=$(mp_mail "$REG" 3 | grep -oE '/app/reset#token=[A-Za-z0-9_-]{43}' | sed -n 1p | sed 's/.*token=//')
[ -n "$RESET_TOKEN" ] || { echo "FAIL: no reset link in the mail"; mp_mail "$REG" 3; exit 1; }
mp_mail "$REG" 3 | matches 'https\?://127\.0\.0\.1:8080/' || { echo "FAIL: reset link is not on the main domain"; exit 1; }
[ "$(code -X POST "$BASE/auth/password-reset" -H "$J" -d "{\"token\":\"$RESET_TOKEN\",\"password\":\"reg-password-2\"}")" = "200" ] \
  || { echo "FAIL: reset password"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$RJAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: session survived the password reset"; exit 1; }
[ "$(code -X POST "$BASE/auth/password-reset" -H "$J" -d "{\"token\":\"$RESET_TOKEN\",\"password\":\"reg-password-3\"}")" = "400" ] \
  || { echo "FAIL: reset link reused"; exit 1; }
[ "$(code -c "$RJAR" -X POST "$BASE/auth/login" -H "$J" -d "{\"login\":\"$REG\",\"password\":\"reg-password-2\"}")" = "200" ] \
  || { echo "FAIL: login with the new password"; exit 1; }
# Outbox: settled bodies cleared; codes/tokens never in the log; audited.
for _ in $(seq 1 20); do
  [ "$(psql_q "SELECT count(*) FROM mail_outbox WHERE status = 'pending'")" = "0" ] && break; sleep 0.5
done
[ "$(psql_q "SELECT count(*) FROM mail_outbox WHERE status <> 'sent' OR body_text <> '' OR body_html <> ''")" = "0" ] \
  || { echo "FAIL: outbox not drained / bodies kept"; psql_q "SELECT id, kind, status, last_error FROM mail_outbox"; exit 1; }
grep -qe "$RESET_TOKEN" -e "\"$REG_CODE\"" "$LOG/panel.log" && { echo "FAIL: a code or reset token in the panel log"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action IN ('user.register', 'user.password.reset', 'settings.mail.update', 'settings.signup.update', 'settings.mail.test')")" = "5" ] \
  || { echo "FAIL: W15 audit rows"; psql_q "SELECT action FROM audit_log ORDER BY id DESC LIMIT 10"; exit 1; }
# The admin user list shows the address and its verification.
[ "$(code -b "$JAR" "$BASE/api/v1/users?limit=200")" = "200" ] \
  && python3 -c "import json; d=json.load(open('/tmp/akari-smoke/last')); u=[x for x in (d['users'] if isinstance(d, dict) else d) if x['login']=='$REG'][0]; assert u['email']=='$REG' and u['email_verified'], u" \
  || { echo "FAIL: user list email"; exit 1; }
# Back to no main domain (later sections use the browser origin).
"$PANEL" settings unset main >/dev/null || { echo "FAIL: settings unset main"; exit 1; }

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
[ "$(code -b "$JAR" "$BASE/api/v1/plan-prices")" = "200" ] && last_json "d['payments_enabled']" | matches True \
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
# W15: the buyer adds an email address in the portal (current password +
# emailed code); the payment below then mails a receipt to it.
BUYER_MAIL="smoke-buyer@akari.test"
[ "$(code -b "$BJAR" -X POST "$BASE/api/v1/me/email/code" -H "$J" -d "{\"email\":\"$BUYER_MAIL\",\"password\":\"wrong\"}")" = "400" ] \
  || { echo "FAIL: email change without the password"; exit 1; }
[ "$(code -b "$BJAR" -X POST "$BASE/api/v1/me/email/code" -H "$J" -d "{\"email\":\"$BUYER_MAIL\",\"password\":\"buyer-password-123\"}")" = "200" ] \
  || { echo "FAIL: email change code"; cat /tmp/akari-smoke/last; exit 1; }
BUYER_CODE=$(mp_mail "$BUYER_MAIL" 1 | grep -oE '\b[0-9]{6}\b' | sed -n 1p)
[ "$(code -b "$BJAR" -X POST "$BASE/api/v1/me/email/verify" -H "$J" -d "{\"code\":\"$BUYER_CODE\"}")" = "200" ] \
  || { echo "FAIL: email verify"; cat /tmp/akari-smoke/last; exit 1; }
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
last_json "d['qr_code']" | matches '^https://qr.alipay.com/smoke' || { echo "FAIL: no QR from precreate"; exit 1; }
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
# W15: exactly one receipt (zh: admin-created account), even after the replay.
mp_mail "$BUYER_MAIL" 2 >"$LOG/receipt.txt" || { echo "FAIL: no order receipt mail"; exit 1; }
sed -n 1p "$LOG/receipt.txt" | matches '支付成功' && matches -F "$OTN" "$LOG/receipt.txt" \
  || { echo "FAIL: receipt content"; cat "$LOG/receipt.txt"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM mail_outbox WHERE kind='order_paid' AND to_addr='$BUYER_MAIL'")" = "1" ] \
  || { echo "FAIL: receipt queued more than once"; exit 1; }
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

echo "== W16 coupons, balance, invite commission, withdrawals (money: one ledger row + audit per movement) =="
api_json() { # method url body -> http status; body in /tmp/akari-smoke/last
  code -b "$1" -X "$2" "$3" -H 'Content-Type: application/json' -d "$4"
}
[ "$(api_json "$JAR" POST "$BASE/api/v1/plans" "{\"name\":\"w16-plan\",\"period\":\"monthly\",\"group_ids\":[\"$PAID_GROUP\"]}")" = "201" ] \
  || { echo "FAIL: create w16 plan"; cat /tmp/akari-smoke/last; exit 1; }
W16_PLAN=$(last_json "d['id']")
[ "$(api_json "$JAR" PUT "$BASE/api/v1/plans/$W16_PLAN/prices" '{"on_sale":true,"prices":[{"period":"month","price_cents":1000}]}')" = "204" ] \
  || { echo "FAIL: w16 prices"; exit 1; }
[ "$(api_json "$JAR" PUT "$BASE/api/v1/commission-settings" '{"enabled":true,"rate_percent":10,"first_order_only":false,"hold_days":7,"min_withdrawal_cents":50}')" = "200" ] \
  || { echo "FAIL: commission settings"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" PUT "$BASE/api/v1/commission-settings" '{"enabled":true,"rate_percent":101,"first_order_only":false,"hold_days":7,"min_withdrawal_cents":50}')" = "400" ] \
  || { echo "FAIL: bad commission settings accepted"; exit 1; }
for who in smoke-inviter smoke-w16; do
  [ "$(api_json "$JAR" POST "$BASE/api/v1/users" "{\"login\":\"$who\",\"password\":\"$who-password-123\"}")" = "201" ] \
    || { echo "FAIL: create $who"; exit 1; }
  code -c "$LOG/$who-cookies" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"$who\",\"password\":\"$who-password-123\"}" >/dev/null
done
INVITER=$(psql_q "SELECT id FROM users WHERE login='smoke-inviter'")
W16U=$(psql_q "SELECT id FROM users WHERE login='smoke-w16'")
IJAR="$LOG/smoke-inviter-cookies"; WJAR="$LOG/smoke-w16-cookies"
# Inviter attribution is W15's (registration with an invite code); set it directly.
psql_q "UPDATE users SET inviter_id='$INVITER' WHERE id='$W16U'" >/dev/null
psql_q "UPDATE users SET inviter_id='$W16U' WHERE id='$INVITER'" >/dev/null 2>&1 \
  && { echo "FAIL: an invitation cycle was accepted"; exit 1; }
# Coupon: 20% off, one use in total.
[ "$(api_json "$JAR" POST "$BASE/api/v1/coupons" '{"code":"SMOKE20","kind":"percent","value":20,"max_uses":1}')" = "201" ] \
  || { echo "FAIL: create coupon"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/coupons" '{"code":"smoke20","kind":"percent","value":5}')" = "409" ] \
  || { echo "FAIL: duplicate coupon code (case-insensitive) accepted"; exit 1; }
[ "$(code -b "$WJAR" "$BASE/api/v1/me/shop?coupon=smoke20")" = "200" ] || { echo "FAIL: shop with coupon"; exit 1; }
python3 -c "
import json; d=json.load(open('/tmp/akari-smoke/last')); p=[x for x in d['plans'] if x['plan_id']=='$W16_PLAN'][0]; o=p['offers'][0]
assert d['coupon']=={'code':'SMOKE20','refusal':None} and o['discount_cents']==200 and o['amount_cents']==800, d
" || { echo "FAIL: coupon preview"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$WJAR" POST "$BASE/api/v1/me/orders" "{\"plan_id\":\"$W16_PLAN\",\"period\":\"month\",\"coupon\":\"smoke20\",\"discount_cents\":1000}")" = "400" ] \
  || { echo "FAIL: client discount accepted"; exit 1; }
[ "$(api_json "$WJAR" POST "$BASE/api/v1/me/orders" "{\"plan_id\":\"$W16_PLAN\",\"period\":\"month\",\"coupon\":\"smoke20\"}")" = "201" ] \
  || { echo "FAIL: order with coupon"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(last_json "d['amount_cents']")/$(last_json "d['discount_cents']")/$(last_json "d['coupon_code']")" = "800/200/SMOKE20" ] \
  || { echo "FAIL: coupon order amounts"; cat /tmp/akari-smoke/last; exit 1; }
CORDER=$(last_json "d['id']"); COTN=$(last_json "d['out_trade_no']")
# The last use is reserved: nobody else gets it.
[ "$(api_json "$IJAR" POST "$BASE/api/v1/me/orders" "{\"plan_id\":\"$W16_PLAN\",\"period\":\"month\",\"coupon\":\"SMOKE20\"}")" = "409" ] \
  && last_json "d['error']" | matches 'coupon has been used up' || { echo "FAIL: coupon's last use given twice"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(curl -s --noproxy '*' -X POST "$BASE/pay/alipay/notify" --data-binary "$(python3 "$PAY/notify.py" "$PAY" "$COTN" 8.00 TRADE_SUCCESS)")" = "success" ] \
  || { echo "FAIL: coupon order notify"; exit 1; }
[ "$(psql_q "SELECT status, fulfilled_at IS NOT NULL FROM orders WHERE id='$CORDER'")" = "paid|t" ] || { echo "FAIL: coupon order not fulfilled"; exit 1; }
[ "$(psql_q "SELECT status || '/' || (SELECT used FROM coupons WHERE code='SMOKE20') FROM coupon_redemptions WHERE order_id='$CORDER'")" = "redeemed/1" ] \
  || { echo "FAIL: coupon not redeemed once"; exit 1; }
# Commission: 10% of the Alipay amount (800) pending for the inviter.
[ "$(psql_q "SELECT amount_cents || '/' || status FROM commissions WHERE order_id='$CORDER'")" = "80/pending" ] \
  || { echo "FAIL: commission not pending"; psql_q "SELECT * FROM commissions"; exit 1; }
# Time travel past the hold: the enforce pass credits it (once).
psql_q "UPDATE commissions SET available_at = now() - interval '1 second' WHERE order_id='$CORDER'" >/dev/null
for _ in $(seq 1 30); do
  [ "$(psql_q "SELECT status FROM commissions WHERE order_id='$CORDER'")" = "credited" ] && break; sleep 0.5
done
[ "$(code -b "$IJAR" "$BASE/api/v1/me/balance")" = "200" ] \
  && [ "$(last_json "d['balance_cents']")/$(last_json "d['withdrawable_cents']")/$(last_json "d['entries'][0]['kind']")" = "80/80/commission" ] \
  || { echo "FAIL: commission not credited"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$IJAR" "$BASE/api/v1/me/invite")" = "200" ] && [ "$(last_json "d['invited_count']")/$(last_json "d['credited_cents']")" = "1/80" ] \
  || { echo "FAIL: /me/invite"; cat /tmp/akari-smoke/last; exit 1; }
# Withdrawal: over the withdrawable amount refused; 60 held, approved by hand.
[ "$(api_json "$IJAR" POST "$BASE/api/v1/me/withdrawals" '{"amount_cents":100,"method":"alipay","account":"inviter@example"}')" = "409" ] \
  || { echo "FAIL: withdrawal over the withdrawable amount"; exit 1; }
[ "$(api_json "$IJAR" POST "$BASE/api/v1/me/withdrawals" '{"amount_cents":60,"method":"alipay","account":"inviter@example"}')" = "201" ] \
  || { echo "FAIL: withdrawal request"; cat /tmp/akari-smoke/last; exit 1; }
WD=$(last_json "d['id']")
[ "$(psql_q "SELECT balance_cents FROM user_balances WHERE user_id='$INVITER'")" = "20" ] || { echo "FAIL: withdrawal not held"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/withdrawals/$WD/approve" '{"payout_reference":"smoke-payout-1"}')" = "204" ] \
  || { echo "FAIL: approve withdrawal"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/withdrawals/$WD/approve" '{"payout_reference":"again"}')" = "409" ] \
  || { echo "FAIL: withdrawal approved twice"; exit 1; }
# Balance: fully paid order (no Alipay), then a partial one cancelled (refund to balance).
[ "$(api_json "$JAR" POST "$BASE/api/v1/users/$W16U/balance" '{"amount_cents":1300,"reason":"smoke top-up"}')" = "200" ] \
  || { echo "FAIL: admin balance adjust"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/users/$W16U/balance" '{"amount_cents":-99999,"reason":"too much"}')" = "409" ] \
  || { echo "FAIL: negative balance allowed"; exit 1; }
[ "$(api_json "$WJAR" POST "$BASE/api/v1/me/orders" "{\"plan_id\":\"$W16_PLAN\",\"period\":\"month\",\"use_balance\":true}")" = "201" ] \
  || { echo "FAIL: balance order"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(last_json "d['status']")/$(last_json "d['amount_cents']")/$(last_json "d['balance_cents']")" = "paid/0/1000" ] \
  || { echo "FAIL: balance order not paid by balance"; cat /tmp/akari-smoke/last; exit 1; }
BORDER=$(last_json "d['id']")
[ "$(psql_q "SELECT paid_via FROM orders WHERE id='$BORDER'")" = "balance" ] || { echo "FAIL: paid_via balance"; exit 1; }
[ "$(api_json "$WJAR" POST "$BASE/api/v1/me/orders" "{\"plan_id\":\"$W16_PLAN\",\"period\":\"month\",\"use_balance\":true}")" = "201" ] \
  || { echo "FAIL: partial balance order"; exit 1; }
[ "$(last_json "d['status']")/$(last_json "d['amount_cents']")/$(last_json "d['balance_cents']")" = "pending/700/300" ] \
  || { echo "FAIL: partial balance split"; cat /tmp/akari-smoke/last; exit 1; }
PORDER=$(last_json "d['id']")
[ "$(psql_q "SELECT balance_cents FROM user_balances WHERE user_id='$W16U'")" = "0" ] || { echo "FAIL: balance part not held"; exit 1; }
[ "$(api_json "$WJAR" POST "$BASE/api/v1/me/orders/$PORDER/cancel" '{}')" = "200" ] && [ "$(last_json "d['status']")" = "cancelled" ] \
  || { echo "FAIL: cancel partial order"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT balance_cents FROM user_balances WHERE user_id='$W16U'")" = "300" ] || { echo "FAIL: balance part not returned"; exit 1; }
# Admin refund of the coupon order to the balance (the commission was already credited: kept).
[ "$(api_json "$JAR" POST "$BASE/api/v1/orders/$CORDER/refund" '{"reason":"smoke refund","to_balance":true}')" = "200" ] \
  && [ "$(last_json "d['refund_cents']")/$(last_json "d['commission']")" = "800/credited" ] \
  || { echo "FAIL: refund"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT balance_cents FROM user_balances WHERE user_id='$W16U'")" = "1100" ] || { echo "FAIL: refund not on the balance"; exit 1; }
# The money invariants, over everything above.
[ "$(psql_q "SELECT count(*) FROM users u LEFT JOIN user_balances b ON b.user_id = u.id
             WHERE COALESCE(b.balance_cents, 0) <> COALESCE((SELECT sum(amount_cents) FROM balance_ledger l WHERE l.user_id = u.id), 0)")" = "0" ] \
  || { echo "FAIL: balance != sum(ledger)"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM balance_ledger")" = "$(psql_q "SELECT count(*) FROM audit_log WHERE action LIKE 'balance.%'")" ] \
  || { echo "FAIL: a ledger row without its audit row"; exit 1; }
psql_q "UPDATE user_balances SET balance_cents = balance_cents + 1" >/dev/null 2>&1 && { echo "FAIL: balance written outside the ledger"; exit 1; }
psql_q "DELETE FROM balance_ledger" >/dev/null 2>&1 && { echo "FAIL: ledger is not append-only"; exit 1; }
for a in coupon.create commission.create commission.settings.update balance.commission balance.withdrawal \
         withdrawal.approved balance.admin_adjust balance.order_payment balance.refund_to_balance order.refund; do
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='$a'")" -ge 1 ] || { echo "FAIL: audit lacks $a"; exit 1; }
done
# Clean up: the W16 buyer holds w16-plan (the paid group's node); later
# sections expect the node to serve only the R18-3 buyer. The ledger,
# commission and withdrawal rows outlive the users (user_id -> NULL).
for u in "$W16U" "$INVITER"; do
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$u")" = "204" ] || { echo "FAIL: delete W16 user"; exit 1; }
done
[ "$(psql_q "SELECT count(*) FROM balance_ledger WHERE user_id IS NULL AND user_login IN ('smoke-w16','smoke-inviter')")" -ge 5 ] \
  || { echo "FAIL: ledger rows did not outlive the users"; exit 1; }
echo "w16: ok (coupon reserve/redeem + last use, commission pending -> credited, withdrawal, balance full/partial/refund, ledger invariants)"
# W15: Mailpit is no longer needed; stop sending (nothing to deliver to).
psql_q "UPDATE smtp_settings SET enabled = false" >/dev/null
docker rm -f akari-smoke-mailpit >/dev/null 2>&1 || true
trap 'cleanup_upd; kill $PANEL_PID ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT

# W7: plan speed limits are enforced by the agent (protocol 4, per user,
# both directions). A limit change alone is a UserDelta (no xray rebuild)
# and VLESS throughput drops to the limit; removing it restores it.
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
    grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | matches "\"user_version\":$uv[,}]" && break; sleep 1
  done
  grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | matches "\"via\":\"$1\".*\"user_version\":$uv[,}]" \
    || { echo "FAIL: agent did not apply user_version $uv via $1"; grep 'state applied' "$LOG/agent.log" | tail -3; exit 1; }
}
if need_agent "protocol>=4" "W7 speed limit throughput"; then
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
  echo "speed limit: NodeView warning for the protocol $AGENT_PROTO agent present (throughput check skipped above)"
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
# The agent's W8 matrix (SS2022, Hysteria 2, XHTTP, HTTPUpgrade, gRPC) came
# before protocol 4 bumped; protocol >= 4 implies it.
if need_agent "protocol>=4" "W8 protocol matrix"; then
  BASE="$BASE" JAR="$JAR" NODE_ID="$NODE_ID" LOG="$LOG" AGENT_LOG="$LOG/agent.log" \
    python3 scripts/smoke-protocols.py || { echo "FAIL: W8 protocol matrix"; tail -20 "$LOG/agent.log"; exit 1; }
fi

echo "== W10: automatic node certificate (pebble ACME CA in docker) -> agent -> verified clients =="
if [ "${SMOKE_ACME:-1}" != 1 ]; then
  echo "W10 ACME test skipped (SMOKE_ACME=0)"
elif need_agent "protocol>=6" "W10 automatic node certificate"; then
  # pebble validates HTTP-01 on 5002 / TLS-ALPN-01 on 5001 of whatever its
  # DNS (challtestsrv: every name -> 127.0.0.1) says; its own challenge
  # servers and DoH (:8443 = the panel's gRPC port) are off.
  docker rm -f akari-smoke-pebble akari-smoke-dns >/dev/null 2>&1 || true
  docker run -d --name akari-smoke-dns --network host ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1 \
    -defaultIPv4 127.0.0.1 -defaultIPv6 "" -dnsserver 127.0.0.1:8053 -doh "" -http01 "" -https01 "" \
    -tlsalpn01 "" -management 127.0.0.1:18055 >/dev/null
  docker run -d --name akari-smoke-pebble --network host -e PEBBLE_VA_NOSLEEP=1 ghcr.io/letsencrypt/pebble:2.10.1 \
    -config test/config/pebble-config.json -dnsserver 127.0.0.1:8053 >/dev/null
  PREV_EXIT_TRAP=$(trap -p EXIT)
  trap 'docker rm -f akari-smoke-pebble akari-smoke-dns >/dev/null 2>&1 || true; cleanup_upd; kill $PANEL_PID ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT
  mkdir -p "$LOG/acme"
  for _ in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/14000) 2>/dev/null && break; sleep 0.5; done
  docker cp akari-smoke-pebble:/test/certs/pebble.minica.pem "$LOG/acme/pebble-api.pem" >/dev/null
  BASE="$BASE" JAR="$JAR" LOG="$LOG" AGENT="$AGENT" PEBBLE_API_ROOT="$LOG/acme/pebble-api.pem" \
    python3 scripts/smoke-acme.py || { echo "FAIL: W10 automatic certificate"; docker logs akari-smoke-pebble 2>&1 | tail -10; exit 1; }
  docker rm -f akari-smoke-pebble akari-smoke-dns >/dev/null
  eval "$PREV_EXIT_TRAP"
fi

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
  for _ in $(seq 1 15); do node_field last_error | matches "agent too old" && break; sleep 1; done
  node_field last_error | matches "agent too old" || { echo "FAIL: too-old agent not flagged: $(node_field last_error)"; exit 1; }
  [ "$(node_field agent_protocol)" = "0" ] || { echo "FAIL: agent_protocol not 0"; exit 1; }
  for _ in $(seq 1 10); do grep -q '"config_version":0,"user_version":0' "$LOG/old-agent.log" && break; sleep 1; done
  grep '"msg":"applying config snapshot"' "$LOG/old-agent.log" | tail -1 | matches '"config_version":0' \
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

echo "== W17: tickets (own only, both sides), node alerts (stopped agent -> firing -> signed webhook -> resolved), node summary + 304 =="
psql_q() { docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -tAc "$1"; }
last_json() { python3 -c "import json,sys; d=json.load(open('/tmp/akari-smoke/last')); print($1)"; }
api_json() { code -b "$1" -X "$2" "$3" -H 'Content-Type: application/json' -d "$4"; }
for who in smoke-tk-a smoke-tk-b; do
  [ "$(api_json "$JAR" POST "$BASE/api/v1/users" "{\"login\":\"$who\",\"password\":\"$who-password-123\"}")" = "201" ] \
    || { echo "FAIL: create $who"; cat /tmp/akari-smoke/last; exit 1; }
  code -c "$LOG/$who-cookies" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"$who\",\"password\":\"$who-password-123\"}" >/dev/null
done
TJA="$LOG/smoke-tk-a-cookies"; TJB="$LOG/smoke-tk-b-cookies"
[ "$(api_json "$TJA" POST "$BASE/api/v1/me/tickets" '{"subject":"冒烟：连不上","category":"technical","priority":"high","message":"smoke ticket body"}')" = "201" ] \
  || { echo "FAIL: create ticket"; cat /tmp/akari-smoke/last; exit 1; }
TK=$(last_json "d['id']")
# Another customer: every ticket endpoint is the canonical rejection.
for probe in "$BASE/api/v1/me/tickets/$TK" "-X POST $BASE/api/v1/me/tickets/$TK/close" \
    "$BASE/api/v1/me/tickets/not-a-uuid"; do
  # shellcheck disable=SC2086
  [ "$(fp -b "$TJB" $probe)" = "$REJ" ] || { echo "FAIL: ticket not hidden from another user: $probe"; cat /tmp/akari-smoke/fphead; exit 1; }
done
[ "$(code -b "$TJB" "$BASE/api/v1/me/tickets")" = "200" ] && [ "$(cat /tmp/akari-smoke/last)" = "[]" ] \
  || { echo "FAIL: another user's ticket listed"; exit 1; }
[ "$(code -b "$TJA" "$BASE/api/v1/tickets")" = "403" ] || { echo "FAIL: customer reached the staff queue"; exit 1; }
# Staff: unread in the queue, reply, the customer sees "answered" + unread, no staff login.
[ "$(code -b "$JAR" "$BASE/api/v1/tickets?unread=true&status=open")" = "200" ] \
  && [ "$(last_json "[t['id'] for t in d['tickets']]==['$TK'] and d['unread']==1")" = "True" ] \
  || { echo "FAIL: staff queue"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/tickets/$TK")" = "200" ] && last_json "d['thread'][0]['author_login']" | matches '^smoke-tk-a$' \
  || { echo "FAIL: staff ticket view"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/tickets/$TK/replies" '{"message":"smoke staff reply"}')" = "201" ] || { echo "FAIL: staff reply"; exit 1; }
[ "$(code -b "$TJA" "$BASE/api/v1/me/tickets")" = "200" ] \
  && [ "$(last_json "(d[0]['status'], d[0]['unread'])")" = "('answered', True)" ] || { echo "FAIL: customer list after reply"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$TJA" "$BASE/api/v1/me/tickets/$TK")" = "200" ] \
  && [ "$(last_json "[m['staff'] and 'author_login' not in m for m in d['messages']]")" = "[False, True]" ] \
  || { echo "FAIL: customer thread (staff identity must be hidden)"; cat /tmp/akari-smoke/last; exit 1; }
matches -F '"root"' </tmp/akari-smoke/last && { echo "FAIL: staff login shown to a customer"; exit 1; }
[ "$(code -b "$TJA" -X POST "$BASE/api/v1/me/tickets/$TK/close")" = "204" ] || { echo "FAIL: customer close"; exit 1; }
[ "$(api_json "$TJA" POST "$BASE/api/v1/me/tickets/$TK/replies" '{"message":"x"}')" = "409" ] || { echo "FAIL: reply on a closed ticket"; exit 1; }
[ "$(psql_q "SELECT string_agg(action, ',' ORDER BY id) FROM audit_log WHERE target_id='$TK'")" = "ticket.create,ticket.reply,ticket.close" ] \
  || { echo "FAIL: ticket audit rows"; psql_q "SELECT action FROM audit_log WHERE target_id='$TK'"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE after::text LIKE '%smoke ticket body%'")" = "0" ] || { echo "FAIL: ticket text in the audit log"; exit 1; }
echo "tickets: ok"

# Node summary view: the list's columns only, ETag + 304.
[ "$(code -D "$LOG/sum.h" -b "$JAR" "$BASE/api/v1/nodes?view=summary")" = "200" ] || { echo "FAIL: summary view"; exit 1; }
ETAG=$(tr -d '\r' <"$LOG/sum.h" | awk -F': ' 'tolower($1)=="etag"{print $2}')
[ -n "$ETAG" ] || { echo "FAIL: summary view without ETag"; cat "$LOG/sum.h"; exit 1; }
tr -d '\r' <"$LOG/sum.h" | matches -i '^cache-control: private, no-cache$' || { echo "FAIL: summary cache-control"; exit 1; }
last_json "[n for n in d if n['id']=='$NODE_ID'][0]['online']" | matches True || { echo "FAIL: node not online in the summary"; exit 1; }
matches -F 'xray_inbounds' </tmp/akari-smoke/last && { echo "FAIL: summary carries the inbounds JSON"; exit 1; }
SUM_BYTES=$(wc -c </tmp/akari-smoke/last)
[ "$(code -b "$JAR" "$BASE/api/v1/nodes")" = "200" ] && [ "$(wc -c </tmp/akari-smoke/last)" -gt "$SUM_BYTES" ] \
  || { echo "FAIL: full list"; exit 1; }
# The agent here heartbeats every 2 s (the list changes with it): revalidate
# right after fetching, a few times, until the body held still in between.
GOT304=""
for _ in $(seq 1 10); do
  code -D "$LOG/sum.h" -b "$JAR" "$BASE/api/v1/nodes?view=summary" >/dev/null
  ETAG=$(tr -d '\r' <"$LOG/sum.h" | awk -F': ' 'tolower($1)=="etag"{print $2}')
  : >/tmp/akari-smoke/last # curl -o leaves the file alone when there is no body
  if [ "$(code -b "$JAR" -H "If-None-Match: $ETAG" "$BASE/api/v1/nodes?view=summary")" = "304" ]; then
    [ ! -s /tmp/akari-smoke/last ] || { echo "FAIL: 304 with a body"; exit 1; }
    GOT304=1; break
  fi
done
[ -n "$GOT304" ] || { echo "FAIL: If-None-Match never answered with 304"; exit 1; }
[ "$(code -b "$JAR" -H 'If-None-Match: "stale"' "$BASE/api/v1/nodes?view=summary")" = "200" ] \
  || { echo "FAIL: a stale ETag did not get the body"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/nodes/$NODE_ID")" = "200" ] && matches -F 'xray_inbounds' </tmp/akari-smoke/last \
  || { echo "FAIL: GET /nodes/{id}"; exit 1; }
echo "summary view: ok ($SUM_BYTES bytes, 304 on revalidation)"

# Alerts: a local webhook receiver records signed deliveries.
HOOK_SECRET="smoke-webhook-secret-0123456789"
python3 -c "$TIE_PY"'
import http.server, json, sys
out = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        rec = {"h": {k.lower(): v for k, v in self.headers.items()}, "b": body.decode()}
        open(out, "a").write(json.dumps(rec) + "\n")
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", 18206), H).serve_forever()
' "$LOG/hook.jsonl" >/dev/null 2>&1 &
HOOK_PID=$!
: >"$LOG/hook.jsonl"
[ "$(code -b "$JAR" "$BASE/api/v1/alerts/settings")" = "200" ] || { echo "FAIL: alert settings"; exit 1; }
AV=$(last_json "d['version']")
ALERT_BODY='{"version":'"$AV"',"enabled":true,"offline_secs":30,"cpu_percent":95,"cpu_minutes":5,"mem_percent":95,"mem_minutes":5,"disk_percent":95,"cert_days":7,"latency_failures":false,"last_error":false,"cooldown_minutes":0,"notify_resolved":true,"telegram_enabled":false,"webhook_enabled":true,"webhook_url":"http://127.0.0.1:18206/hook","webhook_secret":"'"$HOOK_SECRET"'","email_enabled":false,"email_to":[]}'
[ "$(api_json "$JAR" PUT "$BASE/api/v1/alerts/settings" "$ALERT_BODY")" = "200" ] || { echo "FAIL: save alert settings"; cat /tmp/akari-smoke/last; exit 1; }
last_json "(d['webhook_secret_set'], 'webhook_secret' in d)" | matches -Fx '(True, False)' || { echo "FAIL: alert settings view"; exit 1; }
[ "$(api_json "$JAR" PUT "$BASE/api/v1/alerts/settings" "$ALERT_BODY")" = "409" ] || { echo "FAIL: stale alert settings version accepted"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='alerts.settings.update' AND after::text LIKE '%$HOOK_SECRET%'")" = "0" ] \
  || { echo "FAIL: webhook secret in the audit log"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/alerts/test" '{"channel":"webhook"}')" = "200" ] && last_json "d['ok']" | matches True \
  || { echo "FAIL: webhook test"; cat /tmp/akari-smoke/last; exit 1; }
# Stop the agent: the node goes offline, the alert fires (one evaluator),
# the webhook gets a signed "firing" for this node.
kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
cat >"$LOG/hook-check.py" <<'PY'
import hashlib, hmac, json, sys
path, secret, node, event = sys.argv[1:5]
for line in open(path):
    r = json.loads(line); h = r["h"]; b = r["b"]
    want = "sha256=" + hmac.new(secret.encode(), (h["x-akari-timestamp"] + "." + b).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, h.get("x-akari-signature", "")):
        sys.exit("bad signature on delivery " + h.get("x-akari-delivery", "?"))
    d = json.loads(b)
    if h["x-akari-event"] == event and (d.get("alert") or {}).get("node_id") == node and d["alert"]["kind"] == "offline":
        print("ok"); sys.exit(0)
sys.exit(1)
PY
for _ in $(seq 1 60); do
  python3 "$LOG/hook-check.py" "$LOG/hook.jsonl" "$HOOK_SECRET" "$NODE_ID" firing >/dev/null 2>&1 && break; sleep 2
done
python3 "$LOG/hook-check.py" "$LOG/hook.jsonl" "$HOOK_SECRET" "$NODE_ID" firing \
  || { echo "FAIL: no signed firing webhook for the stopped agent"; cat "$LOG/hook.jsonl"; psql_q "SELECT * FROM node_alerts"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/alerts?status=firing&kind=offline&node=$NODE_ID")" = "200" ] \
  && [ "$(last_json "len(d['alerts'])")" = "1" ] || { echo "FAIL: alert center lists the offline alert once"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/admin-badges")" = "200" ] && [ "$(last_json "d['alerts_firing'] >= 1")" = "True" ] || { echo "FAIL: alert badge"; exit 1; }
curl -s --noproxy '*' http://127.0.0.1:9109/metrics | matches '^akari_node_alerts_firing{kind="offline"} [1-9]' \
  || { echo "FAIL: akari_node_alerts_firing"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM alert_notifications WHERE status='sent' AND event='firing'")" -ge 1 ] || { echo "FAIL: firing delivery not settled"; exit 1; }
# Agent back: resolved, and a signed "resolved" delivery.
# shellcheck disable=SC2086
"$AGENT" -config "$BOOT" -state-dir "$LOG/state-main" $HB_FLAG >>"$LOG/agent.log" 2>&1 &
AGENT_PID=$!
wait_port open 20
for _ in $(seq 1 30); do
  python3 "$LOG/hook-check.py" "$LOG/hook.jsonl" "$HOOK_SECRET" "$NODE_ID" resolved >/dev/null 2>&1 && break; sleep 1
done
python3 "$LOG/hook-check.py" "$LOG/hook.jsonl" "$HOOK_SECRET" "$NODE_ID" resolved \
  || { echo "FAIL: no resolved webhook after the agent came back"; cat "$LOG/hook.jsonl"; exit 1; }
[ "$(psql_q "SELECT string_agg(status, ',') FROM node_alerts WHERE node_id='$NODE_ID' AND kind='offline'")" = "resolved" ] \
  || { echo "FAIL: offline alert not resolved exactly once"; psql_q "SELECT * FROM node_alerts"; exit 1; }
# Later sections stop agents too: quiet channels again.
QUIET=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['version']=int(sys.argv[2]); d['webhook_enabled']=False; d.pop('webhook_secret'); print(json.dumps(d))" \
  "$ALERT_BODY" "$(psql_q "SELECT version FROM alert_settings")")
[ "$(api_json "$JAR" PUT "$BASE/api/v1/alerts/settings" "$QUIET")" = "200" ] || { echo "FAIL: quiet alert channels"; cat /tmp/akari-smoke/last; exit 1; }
kill "$HOOK_PID" 2>/dev/null || true
echo "alerts: ok (fired, signed webhook, resolved)"

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
grep '"msg":"channel closed"' "$LOG/agent.log" | matches 'Unauthenticated desc = node deleted' \
  || { echo "FAIL: agent stream not closed as deleted"; grep 'channel closed' "$LOG/agent.log" | tail -3; exit 1; }
# Reconnects with the same (revoked) certificate: accepted only to be closed.
for _ in $(seq 1 20); do grep -q 'certificate revoked' "$LOG/agent.log" && break; sleep 1; done
grep '"msg":"channel closed"' "$LOG/agent.log" | matches 'Unauthenticated desc = certificate revoked' \
  || { echo "FAIL: revoked certificate not closed on reconnect"; grep 'channel closed' "$LOG/agent.log" | tail -3; exit 1; }
port_open && { echo "FAIL: revoked agent serves again"; exit 1; }
vk exists "akari:node:online:$NODE_ID" | matches 0 \
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
"$PANEL" node delete "$SPARE_ID" | matches "deletion started" || { echo "FAIL: CLI node delete"; exit 1; }
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
trap 'cleanup_upd; kill $PANEL_PID ${PANEL_B:+$PANEL_B} ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT
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
"$UPD/agent-v900.0.0" -release-keys | matches TEST-ONLY || { echo "FAIL: smoke agent does not pin the test key"; exit 1; }
"$AGENT" -release-keys | matches TEST-ONLY && { echo "FAIL: the regular build pins the TEST release key"; exit 1; }
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
upd_sign "$UPD/agent-v900.0.0" v900.0.0
upd_sign "$UPD/v1/akari-agent" v900.0.1
upd_sign "$UPD/v2/akari-agent" v900.0.2
# A manifest signed by another key is refused before anything is stored.
"$UPD/akari-sign" keygen -out "$UPD/other.key" >/dev/null
cp "$UPD/v1/akari-agent" "$UPD/other-bin"
"$UPD/akari-sign" sign -key "$UPD/other.key" -binary "$UPD/other-bin" -version v900.0.9 -os "$GOOS_" -arch "$GOARCH_" >/dev/null
python3 -c "import json,sys; print(json.dumps({'manifest': open(sys.argv[1]+'.manifest.json').read(), 'sig': json.load(open(sys.argv[1]+'.manifest.sig'))}))" "$UPD/other-bin" >"$UPD/req.json"
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/agent-releases" -H 'Content-Type: application/json' --data-binary @"$UPD/req.json")" = "400" ] \
  || { echo "FAIL: release signed by an untrusted key accepted"; exit 1; }

# W18: the update runs on a real node: Debian 13 with systemd 257 as PID 1,
# the units the installer ships, and the agent's StateDirectory on a
# filesystem that takes idmapped mounts (tmpfs), so systemd mounts it
# noexec,idmapped exactly as on a production VPS. Agents up to v0.4.0
# executed the staged binary from there and failed ("permission denied");
# now the privileged updater unit installs it.
upd_rel_store() {
  REL0=$(upd_upload "$UPD/agent-v900.0.0")
  [ "$(code -b "$JAR" -X PUT "$BASE/api/v1/agent-releases/$REL0/binary" --data-binary @"$UPD/agent-v900.0.0")" = "409" ] \
    || { echo "FAIL: second upload not 409"; exit 1; }
}
if need_agent "cap:updater" "M6 self-update through the updater unit (systemd container)" \
   && { [ "${SMOKE_INSTALL_CONTAINER:-1}" = 1 ] || { echo "M6 container test skipped (SMOKE_INSTALL_CONTAINER=0)"; false; }; }; then
  # Only v900.0.0 is published while the node is installed (the installer
  # serves the newest complete release).
  upd_rel_store
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' \
      -d '{"name":"upd-node","install":{"origin":"http://127.0.0.1:8080"}}')" = "201" ] \
    || { echo "FAIL: create upd-node: $(cat /tmp/akari-smoke/last)"; exit 1; }
  UPD_ID=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
  UPD_CMD=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['install']['command'])")
  docker build -q -t akari-node-test:debian13 scripts/install-test >/dev/null
  docker rm -f akari-smoke-upd >/dev/null 2>&1 || true
  docker run -d --name akari-smoke-upd --network host --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /var/lib/private:mode=0700 akari-node-test:debian13 >/dev/null
  UPD_CONTAINER=1
  for _ in $(seq 1 30); do docker exec akari-smoke-upd systemctl is-system-running 2>/dev/null | matches -E 'running|degraded' && break; sleep 1; done
  docker exec akari-smoke-upd sh -c "$UPD_CMD" >"$LOG/upd-install.out" 2>&1 \
    || { echo "FAIL: installer (update node)"; cat "$LOG/upd-install.out"; exit 1; }
  udx() { docker exec akari-smoke-upd sh -c "$1"; }
  upd_logs() {
    udx 'journalctl -u akari-agent -o cat --no-pager' >"$LOG/upd-agent.log" 2>&1 || true
    udx 'journalctl -u akari-agent-update -o cat --no-pager' >"$LOG/upd-updater.log" 2>&1 || true
  }
  upd_node() { psql_q "SELECT $1 FROM nodes WHERE id='$UPD_ID'"; }
  for _ in $(seq 1 20); do [ "$(upd_node agent_version)" = "v900.0.0" ] && break; sleep 1; done
  [ "$(upd_node agent_version)" = "v900.0.0" ] && [ "$(upd_node agent_protocol)" -ge 3 ] \
    || { echo "FAIL: update agent not connected ($(upd_node agent_version)/$(upd_node agent_protocol))"; upd_logs; tail -5 "$LOG/upd-agent.log"; exit 1; }
  # The condition that broke v0.4.0 holds here: the agent's state dir is
  # mounted noexec in its namespace, and the updater trigger is armed.
  udx 'grep " /var/lib/private/akari-agent " /proc/$(systemctl show -p MainPID --value akari-agent)/mountinfo' | matches noexec \
    || { echo "FAIL: the agent's state dir is not noexec in this container (test does not reproduce production)"; exit 1; }
  udx 'systemctl is-active -q akari-agent-update.path && systemctl is-enabled -q akari-agent-update.path' \
    || { echo "FAIL: updater trigger not active/enabled"; exit 1; }
  # Then the releases to roll out.
  upd_upload "$UPD/v1/akari-agent" >/dev/null
  upd_upload "$UPD/v2/akari-agent" >/dev/null
  [ "$(psql_q "SELECT count(*) FROM agent_releases WHERE complete_at IS NOT NULL")" = "3" ] || { echo "FAIL: releases not stored"; exit 1; }
  # Only the update node takes part: the others run development builds.
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts" -H 'Content-Type: application/json' \
      -d "{\"version\":\"v900.0.1\",\"node_ids\":[\"$UPD_ID\"],\"health_timeout_secs\":90}")" = "201" ] \
    || { echo "FAIL: rollout create"; cat /tmp/akari-smoke/last; exit 1; }
  RO1=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
  ro_status() { psql_q "SELECT status FROM rollouts WHERE id='$1'"; }
  for _ in $(seq 1 90); do [ "$(ro_status "$RO1")" = "completed" ] && break; sleep 1; done
  upd_logs
  [ "$(ro_status "$RO1")" = "completed" ] || { echo "FAIL: rollout to v900.0.1 not completed ($(ro_status "$RO1"))"; \
    psql_q "SELECT status, detail FROM rollout_nodes WHERE rollout_id='$RO1'"; tail -20 "$LOG/upd-agent.log" "$LOG/upd-updater.log"; exit 1; }
  [ "$(upd_node agent_version)" = "v900.0.1" ] || { echo "FAIL: node not on v900.0.1"; exit 1; }
  [ "$(psql_q "SELECT status FROM rollout_nodes WHERE rollout_id='$RO1'")" = "healthy" ] || { echo "FAIL: node not healthy"; exit 1; }
  for m in "update offer accepted" "agent update verified and staged" "switching to the new agent" "agent update passed its self-check"; do
    grep -q "$m" "$LOG/upd-agent.log" || { echo "FAIL: agent log lacks '$m'"; tail -20 "$LOG/upd-agent.log"; exit 1; }
  done
  for m in "agent update installed; restarting the agent" "agent update passed its self-check"; do
    grep -q "$m" "$LOG/upd-updater.log" || { echo "FAIL: updater log lacks '$m'"; cat "$LOG/upd-updater.log"; exit 1; }
  done
  grep -q "permission denied" "$LOG/upd-agent.log" && { echo "FAIL: permission denied during the update"; exit 1; }
  # Installed by root in place (old one kept), nothing executable in the
  # agent-writable directory, the updater's probation record closed.
  udx '/usr/local/bin/akari-agent -version' | matches "akari-agent v900.0.1 " || { echo "FAIL: installed binary not v900.0.1"; exit 1; }
  udx '/usr/local/bin/akari-agent.prev -version' | matches "akari-agent v900.0.0 " || { echo "FAIL: previous binary not kept"; exit 1; }
  [ "$(udx 'stat -c "%a %U" /usr/local/bin/akari-agent')" = "755 root" ] || { echo "FAIL: installed binary mode/owner"; exit 1; }
  [ -z "$(udx 'find /var/lib/private/akari-agent -type f -perm /111')" ] || { echo "FAIL: executable file in the agent state dir"; exit 1; }
  udx 'cat /var/lib/akari-agent-update/updater.json' | python3 -c "import json,sys; s=json.load(sys.stdin); assert 'trial' not in s, s" \
    || { echo "FAIL: updater probation not closed"; exit 1; }
  code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
  python3 -c "
import json; n=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$UPD_ID'][0]
assert n['update_status']['status']=='healthy' and n['agent_version']=='v900.0.1', n['update_status']
assert 'updater' in n['agent_capabilities'] and not any('重装命令' in w for w in n['warnings']), n" \
    || { echo "FAIL: node view update status"; exit 1; }
  echo "update to v900.0.1 (updater unit): ok"

  # Broken vN+2: the binary dies on start; the updater sees the restarts,
  # puts v900.0.1 back; the agent reports ROLLED_BACK; the rollout halts.
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts" -H 'Content-Type: application/json' \
      -d "{\"version\":\"v900.0.2\",\"node_ids\":[\"$UPD_ID\"],\"health_timeout_secs\":90}")" = "201" ] \
    || { echo "FAIL: rollout 2 create"; cat /tmp/akari-smoke/last; exit 1; }
  RO2=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
  for _ in $(seq 1 90); do [ "$(ro_status "$RO2")" = "halted" ] && break; sleep 1; done
  upd_logs
  [ "$(ro_status "$RO2")" = "halted" ] || { echo "FAIL: broken rollout not halted ($(ro_status "$RO2"))"; \
    psql_q "SELECT status, detail FROM rollout_nodes WHERE rollout_id='$RO2'"; tail -20 "$LOG/upd-agent.log" "$LOG/upd-updater.log"; exit 1; }
  psql_q "SELECT detail FROM rollout_nodes WHERE rollout_id='$RO2'" | matches "rolled back" \
    || { echo "FAIL: no rollback report: $(psql_q "SELECT status, detail FROM rollout_nodes WHERE rollout_id='$RO2'")"; exit 1; }
  grep -q "broken agent build" "$LOG/upd-agent.log" || { echo "FAIL: broken build never ran"; exit 1; }
  grep -q "rolling back agent update" "$LOG/upd-updater.log" || { echo "FAIL: updater did not roll back"; exit 1; }
  for _ in $(seq 1 20); do [ "$(upd_node agent_version)" = "v900.0.1" ] && [ "$(upd_node status)" = "online" ] && break; sleep 1; done
  [ "$(upd_node agent_version)" = "v900.0.1" ] || { echo "FAIL: node not back on v900.0.1"; exit 1; }
  udx '/usr/local/bin/akari-agent -version' | matches "akari-agent v900.0.1 " || { echo "FAIL: binary not rolled back"; exit 1; }
  udx 'cat /var/lib/akari-agent-update/updater.json' | python3 -c "import json,sys; s=json.load(sys.stdin); assert 'v900.0.2' in s['rolled_back'] and 'trial' not in s, s" \
    || { echo "FAIL: updater state after rollback"; exit 1; }
  udx 'cat /var/lib/private/akari-agent/update/state.json' | python3 -c "import json,sys; s=json.load(sys.stdin); assert 'v900.0.2' in s['rolled_back'], s" \
    || { echo "FAIL: agent state after rollback"; exit 1; }
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='rollout.halt' AND actor_login='system'")" = "1" ] \
    || { echo "FAIL: halt not audited"; exit 1; }
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts/$RO2/resume")" = "409" ] || { echo "FAIL: halted rollout resumed"; exit 1; }
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts/$RO2/abort")" = "200" ] || { echo "FAIL: abort"; exit 1; }
  [ "$(code -b "$JAR" "$BASE/api/v1/rollouts")" = "200" ] && grep -q '"aborted"' /tmp/akari-smoke/last || { echo "FAIL: rollout list"; exit 1; }
  for a in agent_release.create agent_release.upload rollout.create rollout.complete rollout.abort; do
    [ "$(psql_q "SELECT count(*) > 0 FROM audit_log WHERE action='$a'")" = "t" ] || { echo "FAIL: $a not audited"; exit 1; }
  done
  # Uninstall removes the updater as well.
  udx 'akari-agent-uninstall' >>"$LOG/upd-install.out" 2>&1 || { echo "FAIL: uninstall (update node)"; exit 1; }
  udx 'test ! -e /etc/systemd/system/akari-agent-update.path && test ! -e /etc/systemd/system/akari-agent-update.service && test ! -e /var/lib/akari-agent-update && test ! -e /usr/local/bin/akari-agent.prev' \
    || { echo "FAIL: uninstall left the updater behind"; exit 1; }
  cleanup_upd
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/nodes/$UPD_ID")" = "202" ] || { echo "FAIL: delete upd-node"; exit 1; }
  echo "m6 self-update: ok (installer + updater unit on systemd 257, noexec state dir: v900.0.0 -> v900.0.1 healthy; broken v900.0.2 rolled back, rollout halted)"
else
  # The installer section below still needs the releases.
  upd_rel_store
  upd_upload "$UPD/v1/akari-agent" >/dev/null
  upd_upload "$UPD/v2/akari-agent" >/dev/null
fi

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
as_root = "sh -c '[ \"$(id -u)\" = 0 ] || exec sudo sh; exec sh'"
assert i["command"] == "curl -fsSL '%s' | %s" % (sys.argv[2], as_root), i["command"]
assert i["command_wget"] == "wget -qO- '%s' | %s" % (sys.argv[2], as_root), i["command_wget"]
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
  # tmpfs state: idmapped (noexec) StateDirectory mounts as on a VPS (W18).
  docker run -d --name akari-smoke-node --network host --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /var/lib/private:mode=0700 akari-node-test:debian13 >/dev/null
  PREV_EXIT_TRAP=$(trap -p EXIT)
  trap 'docker rm -f akari-smoke-node >/dev/null 2>&1 || true; cleanup_upd; kill $PANEL_PID ${PANEL_B:+$PANEL_B} ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do docker exec akari-smoke-node systemctl is-system-running 2>/dev/null | matches -E 'running|degraded' && break; sleep 1; done
  # Not root and no sudo (the image has none): the command stops at sudo,
  # nothing of the script runs unprivileged.
  docker exec -u nobody akari-smoke-node sh -c "$INST_CMD" >"$LOG/install-nobody.out" 2>&1 \
    && { echo "FAIL: install command ran without root"; cat "$LOG/install-nobody.out"; exit 1; }
  grep -q "sudo" "$LOG/install-nobody.out" && ! grep -q "akari-install" "$LOG/install-nobody.out" \
    || { echo "FAIL: non-root install output"; cat "$LOG/install-nobody.out"; exit 1; }
  # Exactly what the admin copies, as root on an image without sudo.
  docker exec akari-smoke-node sh -c "$INST_CMD" >"$LOG/install.out" 2>&1 \
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
  docker exec akari-smoke-node sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\0" " "' | matches "$(python3 -c "import json;print(json.load(open('$LOG/inst-create.json'))['enrollment_token'])")" \
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
# Earlier sections (W15) may have audited settings changes of their own.
R22_AUDIT0=$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.update'")
R22_CLI0=$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.update' AND actor_login = 'cli'")
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
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.update'")" = "$((R22_AUDIT0 + 1))" ] || { echo "FAIL: settings change not audited"; exit 1; }

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
# R23-3: the admin console only on the main domain (and IP literals); on the
# subscription domain it is the canonical rejection, even for an admin.
# (The session goes in an explicit Cookie header: curl matches jar cookies
# against a custom Host header.)
SID=$(awk '$6=="sid"{print $7}' "$JAR")
[ -n "$SID" ] || { echo "FAIL: no session cookie in the jar"; exit 1; }
for p in admin admin/users; do
  [ "$(fp -H "Cookie: sid=$SID" -H "Host: sub.akari.test" "$BASE/$p")" = "$REJ" ] || { echo "FAIL: console on the sub domain: $p"; exit 1; }
done
[ "$(code -H "Host: sub.akari.test" "$BASE/app")" = "200" ] || { echo "FAIL: portal refused on the sub domain"; exit 1; }
for h in myapp.test:8446 127.0.0.1:8080; do
  [ "$(code -H "Cookie: sid=$SID" -H "Host: $h" "$BASE/admin")" = "200" ] || { echo "FAIL: console refused on Host $h"; exit 1; }
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
trap 'docker rm -f akari-smoke-caddy akari-smoke-r22 >/dev/null 2>&1 || true; cleanup_upd; kill $PANEL_PID ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT
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
    head -1 /tmp/akari-smoke/fphead | matches " 404" || { echo "FAIL: Caddy 404 ($base)"; cat /tmp/akari-smoke/fphead; exit 1; }
    for p in "$PREFIX/nope" "$PREFIX/api/v1/nope" "$PREFIX"; do
      [ "$(fp -k "${RES[@]}" -H "Accept-Encoding: $enc" "$base/$p")" = "$A" ] \
        || { echo "FAIL: prefix oracle through Caddy: $base/<prefix>${p#"$PREFIX"} ($enc)"; cat /tmp/akari-smoke/fphead; exit 1; }
    done
  done
done
# Plain HTTP: AKARI_DOMAIN is redirected; any other host gets the canonical
# empty 404 on every path (never Caddy's default 200, never a redirect).
[ "$(code "${RES[@]}" "http://myapp.test:8447/x")" = "308" ] || { echo "FAIL: http main domain not redirected"; exit 1; }
# ... by our own redirect: no Server/Via (Caddy's automatic one says "Caddy").
fp "${RES[@]}" "http://myapp.test:8447/x?y" >/dev/null
grep -qiE '^(server|via):' /tmp/akari-smoke/fphead && { echo "FAIL: http redirect identifies the proxy"; cat /tmp/akari-smoke/fphead; exit 1; }
grep -qiE '^location: https://myapp\.test/x\?y' /tmp/akari-smoke/fphead || { echo "FAIL: http redirect target"; cat /tmp/akari-smoke/fphead; exit 1; }
for base in "http://127.0.0.1:8447" "http://evil.test:8447"; do
  A=$(fp "${RES[@]}" "$base/junk")
  head -1 /tmp/akari-smoke/fphead | matches " 404" || { echo "FAIL: plain http $base"; cat /tmp/akari-smoke/fphead; exit 1; }
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
"$PANEL" settings show | matches 'node domain: *grpc.akari.test' || { echo "FAIL: settings show"; "$PANEL" settings show; exit 1; }
"$PANEL" settings unset all >/dev/null || { echo "FAIL: settings unset"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.update' AND actor_login = 'cli'")" = "$((R22_CLI0 + 1))" ] || { echo "FAIL: CLI unset not audited"; exit 1; }
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
# Not piped into grep -q: grep exits at the first match and the CLI's next
# line then dies on EPIPE (pipefail turned that into a flaky FAIL).
"$PANEL" secrets rotate-jwt >"$LOG/rotate-jwt.out" && grep -q "revoked" "$LOG/rotate-jwt.out" || { echo "FAIL: CLI rotate-jwt"; exit 1; }
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
"$PANEL" --version | matches -E '^akari [0-9]+\.[0-9]+\.[0-9]+ \(([0-9a-f]+|unknown)\)' \
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
curl -s --noproxy '*' -D - -o /dev/null "$BASE/healthz" | matches -i '^x-request-id: [0-9a-f]\{32\}' \
  || { echo "FAIL: no minted request id on a real response"; exit 1; }
curl -s --noproxy '*' -D - -o /dev/null -H 'X-Request-Id: smoke-req-1' "$BASE/healthz" | matches -i '^x-request-id: smoke-req-1' \
  || { echo "FAIL: incoming request id not echoed"; exit 1; }
curl -s --noproxy '*' -D - -o /dev/null -H 'X-Request-Id: smoke-req-1' "$BASE/nope" | matches -i '^x-request-id' \
  && { echo "FAIL: request id on a rejection"; exit 1; }
[ "$(fp -H 'X-Request-Id: smoke-req-1' "$BASE/nope")" = "$REJ" ] || { echo "FAIL: rejection differs with a request id"; exit 1; }
echo "m1a: ok"

echo "== SPA =="
[ "$(code "$BASE/app")" = "200" ] || { echo "FAIL: /app not 200"; exit 1; }
grep -q 'id="root"' /tmp/akari-smoke/last || { echo "FAIL: SPA index has no root div"; exit 1; }
JS=$(grep -o "/$PREFIX/assets/[^\"]*\.js" /tmp/akari-smoke/last | sed -n 1p)
[ -n "$JS" ] || { echo "FAIL: SPA index did not reference prefixed asset"; exit 1; }
CT=$(curl -s --noproxy '*' -o /dev/null -w "%{content_type}" "http://127.0.0.1:8080$JS")
echo "$CT" | matches javascript || { echo "FAIL: asset content-type '$CT'"; exit 1; }
# The SPA's own stylesheet and script must be allowed by the CSP it is served
# with (a real-browser check found style-src missing 'self': unstyled UI).
CSP=$(curl -s --noproxy '*' -D - -o /dev/null "$BASE/app" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-security-policy"{print $2}')
echo "$CSP" | matches -E "style-src[^;]*'self'" || { echo "FAIL: CSP style-src lacks 'self': $CSP"; exit 1; }
echo "$CSP" | matches -E "default-src[^;]*'self'" || { echo "FAIL: CSP default-src lacks 'self': $CSP"; exit 1; }
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

echo "== R23: separate admin bundle, served to admin sessions only =="
# Fresh sessions (rotate-jwt above revoked everything); 2FA was reset, so the
# admin signs in with the password alone.
AJAR="$LOG/spa-admin-cookies"; SJAR="$LOG/spa-user-cookies"; RJAR="$LOG/spa-revoked-cookies"
[ "$(code -c "$AJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\"}")" = "200" ] || { echo "FAIL: admin login (R23)"; exit 1; }
[ "$(code -b "$AJAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-spa-user","password":"spa-user-password-1"}')" = "201" ] || { echo "FAIL: create spa user"; exit 1; }
[ "$(code -c "$SJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"login":"smoke-spa-user","password":"spa-user-password-1"}')" = "200" ] || { echo "FAIL: spa user login"; exit 1; }
# A revoked admin session: log in, keep the cookie, log out (bumps session_ver).
code -c "$RJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\"}" >/dev/null
cp "$RJAR" "$RJAR.kept"
[ "$(code -b "$RJAR" -X POST "$BASE/auth/logout")" = "200" ] || { echo "FAIL: logout (R23 revoked session)"; exit 1; }
# Logging out bumped root's session_ver: the console session needs a fresh login too.
[ "$(code -c "$AJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"root\",\"password\":\"$ADMIN_PW\"}")" = "200" ] || { echo "FAIL: admin re-login (R23)"; exit 1; }

cache_of() { curl -s --noproxy '*' -D - -o /dev/null "$@" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}'; }
[ "$(code -b "$AJAR" "$BASE/admin")" = "200" ] || { echo "FAIL: /admin not 200 for an admin"; exit 1; }
grep -q 'id="root"' /tmp/akari-smoke/last || { echo "FAIL: console index has no root div"; exit 1; }
AJS=$(grep -o "/$PREFIX/admin/assets/[^\"]*\.js" /tmp/akari-smoke/last | sed -n 1p)
ACSS=$(grep -o "/$PREFIX/admin/assets/[^\"]*\.css" /tmp/akari-smoke/last | sed -n 1p)
[ -n "$AJS" ] && [ -n "$ACSS" ] || { echo "FAIL: console index lacks prefixed /admin/assets/ script or stylesheet"; exit 1; }
[ "$(cache_of -b "$AJAR" "$BASE/admin")" = "private, no-store" ] || { echo "FAIL: console index cacheable"; exit 1; }
[ "$(cache_of -b "$AJAR" "http://127.0.0.1:8080$AJS")" = "private, no-store" ] || { echo "FAIL: console asset cacheable"; exit 1; }
[ "$(cache_of "http://127.0.0.1:8080$JS")" = "public, max-age=31536000, immutable" ] || { echo "FAIL: portal asset not immutable"; exit 1; }
CT=$(curl -s --noproxy '*' -b "$AJAR" -o /dev/null -w "%{content_type}" "http://127.0.0.1:8080$AJS")
echo "$CT" | matches javascript || { echo "FAIL: console asset content-type '$CT'"; exit 1; }
curl -s --noproxy '*' -D - -o /dev/null -b "$AJAR" "$BASE/admin" | matches -i "^content-security-policy: default-src 'self'" \
  || { echo "FAIL: console index without the CSP"; exit 1; }
# Deep links: every console view loads on reload.
for v in users plans orders nodes updates audit account settings; do
  [ "$(code -b "$AJAR" "$BASE/admin/$v")" = "200" ] || { echo "FAIL: deep link /admin/$v"; exit 1; }
done
# Everyone else gets the canonical rejection, byte-identical: no cookie, a
# user's session, a forged cookie, a revoked admin session; and the console's
# assets do not exist under the portal's public /assets/ path.
for who in "" "-b $SJAR" "-b sid=forged" "-b $RJAR.kept"; do
  for p in "$BASE/admin" "$BASE/admin/users" "$BASE/admin/settings" "http://127.0.0.1:8080$AJS" "http://127.0.0.1:8080$ACSS"; do
    # shellcheck disable=SC2086
    [ "$(fp $who "$p")" = "$REJ" ] || { echo "FAIL: console reachable ($who): $p"; cat /tmp/akari-smoke/fphead; exit 1; }
  done
done
[ "$(fp -b "$AJAR" "$BASE/admin/")" = "$REJ" ] || { echo "FAIL: /admin/ (trailing slash) not the rejection"; exit 1; }
[ "$(fp -b "$AJAR" -X POST "$BASE/admin")" = "$REJ" ] || { echo "FAIL: POST /admin not the rejection"; exit 1; }
[ "$(fp -b "$AJAR" "$BASE/admin/assets/missing.js")" = "$REJ" ] || { echo "FAIL: missing console asset not the rejection"; exit 1; }
[ "$(fp -b "$AJAR" "http://127.0.0.1:8080${AJS/\/admin\/assets\//\/assets\/}")" = "$REJ" ] \
  || { echo "FAIL: console asset served under the public /assets/ path"; exit 1; }
# The portal never references the console's files, and the bundles as served
# pass the build-time guard: no admin marker in anything the portal loads.
SERVED="$LOG/served"; rm -rf "$SERVED" && mkdir -p "$SERVED/app" "$SERVED/admin"
curl -s --noproxy '*' -b "$SJAR" "$BASE/app" >"$SERVED/app/index.html"
grep -q '/admin/' "$SERVED/app/index.html" && { echo "FAIL: portal index references the console"; exit 1; }
for a in $(grep -o "/$PREFIX/assets/[^\"]*\.\(js\|css\)" "$SERVED/app/index.html"); do
  curl -s --noproxy '*' "http://127.0.0.1:8080$a" >"$SERVED/app/$(basename "$a")"
done
curl -s --noproxy '*' -b "$AJAR" "$BASE/admin" >"$SERVED/admin/admin.html"
for a in "$AJS" "$ACSS"; do curl -s --noproxy '*' -b "$AJAR" "http://127.0.0.1:8080$a" >"$SERVED/admin/$(basename "$a")"; done
node spa/scripts/check-bundles.mjs "$SERVED/app" "$SERVED/admin" || { echo "FAIL: served portal bundle carries admin code"; exit 1; }
echo "admin bundle: ok"

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
"$PANEL" secrets rotate-prefix | matches "new route prefix" || { echo "FAIL: CLI rotate-prefix"; exit 1; }
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
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  # Loud on purpose: these agent features were NOT exercised by this run.
  echo "!! ${#SKIPPED[@]} agent-dependent section(s) SKIPPED (agent protocol $AGENT_PROTO, capabilities [$AGENT_CAPS]):"
  printf '!!   - %s\n' "${SKIPPED[@]}"
  echo "!! run ci (workflow_dispatch) with agent_ref=<agent branch> to exercise them"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "### smoke: ${#SKIPPED[@]} agent-dependent section(s) skipped"
      echo "agent protocol $AGENT_PROTO, capabilities [$AGENT_CAPS]"
      printf -- '- %s\n' "${SKIPPED[@]}"; } >>"$GITHUB_STEP_SUMMARY"
  fi
fi
echo "SMOKE TEST PASSED"
