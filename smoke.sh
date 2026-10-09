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
psql_q() { docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -tAc "$1"; }
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
  # R44 section: the allowlist table a failed run may have left.
  if [ -n "${SF_ROOT:-}" ]; then
    sudo -n nft delete table inet akari_sources >/dev/null 2>&1 || true
    sudo -n rm -rf "$SF_ROOT" || true
    SF_ROOT=""
  fi
  if [ -n "$UPD_CONTAINER" ]; then
    docker rm -f akari-smoke-upd >/dev/null 2>&1 || true
    UPD_CONTAINER=""
  fi
}

echo "== start panel (runs migrations) =="
# Plain-HTTP development: the session cookie must not be Secure. 127.0.0.2
# plays a trusted reverse proxy (curl --interface 127.0.0.2); requests from
# 127.0.0.1 are direct clients whose X-Forwarded-For must be ignored.
# W25 (R39): panel.toml keeps only what the process needs to start. The
# sections after the first block are OBSOLETE on purpose (an upgraded
# install's file): the first start imports the moved ones into 系统设置 once
# (node domain from grpc.advertise, latency test URL, ACME directory, the
# TEST release key), constants are ignored — both with a warning.
cat >"$LOG/panel.toml" <<'TOML'
[web]
cookie_secure = false
trusted_proxies = ["127.0.0.2/32"]
[metrics]
bind = "127.0.0.1:9109"
[tls_ask]
bind = "127.0.0.1:8092"

# --- obsolete (W25) ---
[grpc]
advertise = "127.0.0.1:8443"
server_name = "localhost"
lease_seconds = 86400

# W11 latency tests: a local test URL (the 204 server below).
[probe]
urls = ["http://127.0.0.1:18204/generate_204"]
timeout_ms = 2000

# W10: agents of nodes with a TLS domain order from the local pebble CA
# (docker, W10 section), never from Let's Encrypt.
[acme]
directory_url = "https://127.0.0.1:14000/dir"

[sub]
rate_per_token = 8

[alerts]
telegram_api_url = "https://tg.example.com"
TOML
# W25: the timers smoke shortens are built-in constants now; this TEST-ONLY
# variable (logged at startup) shortens them: 8 subscription fetches per
# token and window, a 5 s "立即测速" cooldown, node alerts every 5 s.
SMOKE_LIMITS="sub_rate_per_token=8,probe_manual_cooldown_secs=5,alerts_eval_interval_secs=5,entrance_health_interval_secs=2"
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
# M6: the agent's TEST release key (testdata/, public on purpose) is
# trusted here IN ADDITION to the official key compiled into the panel (W25:
# obsolete [updates] release_keys, imported once into 系统设置 → 安全).
TEST_RELEASE_PUB=$(cut -d' ' -f1 "$AGENT_DIR/testdata/TEST-ONLY-release.pub")
printf '\n[updates]\nrelease_keys = ["%s TEST-ONLY"]\n' "$TEST_RELEASE_PUB" >>"$LOG/panel.toml"
# R18-3: Alipay Face-to-Face against a local mock gateway, with throwaway
# RSA keys made here (never real credentials).
PAY="$LOG/pay"; mkdir -p "$PAY"
for k in app alipay; do
  openssl genrsa -out "$PAY/$k-key.pem" 2048 2>/dev/null
  openssl rsa -in "$PAY/$k-key.pem" -pubout -out "$PAY/$k-pub.pem" 2>/dev/null
done
chmod 600 "$PAY"/*.pem
# W24/R40: payments are configured ONLY in the database (系统设置 → 支付);
# the R18-3 section below adds the mock gateway as an Alipay payment method
# through the admin API (custom gateway, these throwaway keys).
# The mock gateway: verifies the panel's request signature (app public
# key), answers signed with the "Alipay" key; POST /control/pay?otn=X
# marks a trade paid (TRADE_SUCCESS) for the query path.
cat >"$PAY/mock.py" <<'PY'
import base64, json, subprocess, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
D = sys.argv[1]; trades = {}; refunds = {}
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
        elif m == "alipay.trade.refund" and otn in trades:
            refunds.setdefault(biz["out_request_no"], (otn, biz["refund_amount"]))
            obj = {"code": "10000", "msg": "Success", "out_trade_no": otn, "trade_no": "2026" + otn[-10:],
                   "refund_fee": refunds[biz["out_request_no"]][1], "fund_change": "Y"}
        elif m == "alipay.trade.fastpay.refund.query":
            r = refunds.get(biz["out_request_no"])
            obj = {"code": "10000", "msg": "Success", "out_trade_no": otn}
            if r: obj.update({"out_request_no": biz["out_request_no"], "refund_amount": r[1]})
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
start_panel() {  # $1 = log file
  AKARI_TEST_LIMITS="$SMOKE_LIMITS" "$PANEL" -c "$LOG/panel.toml" serve >"$1" 2>&1 &
  PANEL_PID=$!
  # Poll instead of a fixed sleep: migrations run before the listener binds.
  for _ in $(seq 1 100); do
    (exec 3<>/dev/tcp/127.0.0.1/8080) 2>/dev/null && break
    kill -0 "$PANEL_PID" 2>/dev/null || { echo "FAIL: panel exited during startup"; cat "$1"; exit 1; }
    sleep 0.3
  done
  (exec 3<>/dev/tcp/127.0.0.1/8080) 2>/dev/null || { echo "FAIL: panel not listening"; cat "$1"; exit 1; }
}
start_panel "$LOG/panel-first.log"
trap 'cleanup_upd; kill $PANEL_PID ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT

# Reset AFTER startup: fresh volumes have no tables until the panel migrates,
# and Valkey rate-limit counters would poison the next run's login test.
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "TRUNCATE servers CASCADE; TRUNCATE users CASCADE;" >/dev/null 2>&1 || true
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "TRUNCATE revoked_certs, traffic_counters, audit_log, agent_releases, rollouts CASCADE;" >/dev/null 2>&1 || true
# Catalogue rows a run aborted midway leaves behind (names are unique).
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "TRUNCATE plans, node_groups, coupons, payment_methods CASCADE;" >/dev/null 2>&1 || true
# R22 settings left behind by an aborted run (e.g. a node domain the agents
# here cannot reach): back to "use panel.toml" (the trigger reloads them).
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "DELETE FROM site_domains; UPDATE panel_settings SET version = 0, sub_domain_per_user = NULL, trust_cloudflare = NULL, probe_interval_secs = NULL, probe_urls = NULL, probe_panel_tcp = NULL, site_name = NULL, cloudflare_ranges = NULL, install_tls_pin = NULL, install_fallback_url = NULL, acme_directory_url = NULL, acme_email = NULL, audit_retention_days = NULL, traffic_daily_retention_days = NULL, remove_mode = NULL, extra_release_keys = NULL; TRUNCATE grpc_server_names, legacy_config_imports;" >/dev/null 2>&1 || true
# W15 settings back to the defaults (off; version 0) and an empty outbox.
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "DELETE FROM signup_settings; INSERT INTO signup_settings (id) VALUES (1); DELETE FROM mail_settings; INSERT INTO mail_settings (id) VALUES (1); TRUNCATE mail_outbox;" >/dev/null 2>&1 || true
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "DELETE FROM auth_settings; INSERT INTO auth_settings (id) VALUES (1);" >/dev/null 2>&1 || true
# D4/D11: the next start imports this run's data/state.json prefix and draws
# a new subscription path.
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "UPDATE access_settings SET version = 0, admin_prefix = NULL, admin_allow_cidrs = '{}', sub_path = NULL;" >/dev/null 2>&1 || true
# PR ③ D10: cleanup settings back to their defaults (reruns on one SMOKE_DB).
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "DELETE FROM cleanup_settings; INSERT INTO cleanup_settings (id) VALUES (1);" >/dev/null 2>&1 || true
# W17: alert settings an aborted run may leave (a webhook to a dead receiver).
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "TRUNCATE server_alerts, alert_notifications; UPDATE alert_settings SET version = 0, enabled = true, offline_secs = 300, webhook_enabled = false, webhook_url = NULL, webhook_secret_enc = NULL, telegram_enabled = false, telegram_chat_id = NULL, telegram_token_enc = NULL, telegram_api_url = NULL, email_enabled = false, email_to = '{}';" >/dev/null 2>&1 || true
# Ops: announcements, knowledge base, templates and branding of an earlier run.
docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -c "TRUNCATE announcements, kb_articles, kb_categories, mail_templates CASCADE; DELETE FROM site_branding; INSERT INTO site_branding (id) VALUES (1);" >/dev/null 2>&1 || true
vk flushdb >/dev/null

echo "== W25: an old panel.toml on a clean database: obsolete keys imported once, constants ignored =="
# The reset above cleared what the first start imported: start again so the
# import runs against the clean database (what an upgrade does once).
kill "$PANEL_PID" 2>/dev/null; wait "$PANEL_PID" 2>/dev/null || true
start_panel "$LOG/panel.log"
for k in grpc.advertise grpc.server_name probe.urls acme.directory_url updates.release_keys alerts.telegram_api_url; do
  matches "panel.toml $k imported into 系统设置" <"$LOG/panel.log" || { echo "FAIL: $k not imported"; grep -i obsolete "$LOG/panel.log"; exit 1; }
done
for k in grpc.lease_seconds probe.timeout_ms sub.rate_per_token; do
  matches "panel.toml $k is obsolete: the value is built in now" <"$LOG/panel.log" || { echo "FAIL: constant $k not warned about"; exit 1; }
done
matches "AKARI_TEST_LIMITS is set" <"$LOG/panel.log" || { echo "FAIL: test limits not announced"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.import' AND actor_label = 'system'")" = "1" ] \
  || { echo "FAIL: import not audited once (actor system)"; exit 1; }
[ "$(psql_q "SELECT (SELECT domain FROM site_domains WHERE kind = 'node' AND preferred) || ' ' || array_to_string(probe_urls, ',') || ' ' || acme_directory_url FROM panel_settings")" \
    = "127.0.0.1:8443 http://127.0.0.1:18204/generate_204 https://127.0.0.1:14000/dir" ] \
  || { echo "FAIL: imported values: $(psql_q "SELECT * FROM panel_settings")"; exit 1; }
[ "$(psql_q "SELECT extra_release_keys[1] FROM panel_settings")" = "$TEST_RELEASE_PUB TEST-ONLY" ] \
  || { echo "FAIL: TEST release key not imported as an extra key"; exit 1; }
[ "$(psql_q "SELECT telegram_api_url FROM alert_settings")" = "https://tg.example.com" ] \
  || { echo "FAIL: alerts.telegram_api_url not imported into 告警"; exit 1; }
# D8: every node domain is recorded as a certificate name (the imported
# grpc.advertise host here), besides grpc.server_name.
[ "$(psql_q "SELECT string_agg(name || ':' || source, ',' ORDER BY name) FROM grpc_server_names")" = "127.0.0.1:config,localhost:config" ] \
  || { echo "FAIL: grpc.server_name not recorded as a certificate name"; psql_q "SELECT * FROM grpc_server_names"; exit 1; }
echo "w25 import: ok"

echo "== first admin (env password) =="
# D1: the e-mail address is the login name.
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" admin add Root@Smoke.test | tee "$LOG/admin-add.out"
# R47: the first admin is the owner.
grep -q "created the owner account: root@smoke.test" "$LOG/admin-add.out" || { echo "FAIL: admin add (lower-cased address, owner)"; exit 1; }
[ "$(psql_q "SELECT is_owner FROM users WHERE email = 'root@smoke.test'")" = "t" ] || { echo "FAIL: the first admin is not the owner"; exit 1; }
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" admin add root@smoke.test 2>&1 | matches "created .* account" \
  && { echo "FAIL: duplicate admin creation should error"; exit 1; } || echo "duplicate rejected: ok"
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" admin add not-an-address 2>&1 | matches "created .* account" \
  && { echo "FAIL: admin add accepted a non-address"; exit 1; } || echo "non-address rejected: ok"

echo "== register server (M1-8: key-less bootstrap with a one-time enrollment token) =="
# Q1: the agent's identity is a server (machine); its node is created on it
# through the API below.
"$PANEL" server add test-node --out "$BOOT" >/dev/null
SERVER_ID=$("$PANEL" server list | awk 'NR==2{print $1}')
grep -q 'PRIVATE KEY' "$BOOT" && { echo "FAIL: bootstrap file contains a private key"; exit 1; }
grep -qE '^enrollment_token = "[A-Za-z0-9_-]{43}"$' "$BOOT" || { echo "FAIL: bootstrap file lacks the enrollment token"; exit 1; }
[ "$(stat -c %a "$BOOT")" = "600" ] || { echo "FAIL: bootstrap file is not 0600"; exit 1; }

# D4/D11: the admin prefix (API + console) and the site-wide subscription
# path; the portal, install links and payment notifications are on the root.
PREFIX=$("$PANEL" info | awk '/admin prefix/{sub(/^\//,"",$3); print $3}')
SUBP=$("$PANEL" info | awk '/sub path/{sub(/^\//,"",$3); print $3}')
[ -n "$PREFIX" ] && [ -n "$SUBP" ] || { echo "FAIL: akari info: admin prefix / sub path"; "$PANEL" info; exit 1; }
[ "$PREFIX" = "$(psql_q "SELECT admin_prefix FROM access_settings")" ] || { echo "FAIL: the admin prefix was not imported from data/state.json"; exit 1; }
ROOT="http://127.0.0.1:8080"
BASE="$ROOT/$PREFIX"
SUBBASE="$ROOT/$SUBP"
code() { curl -s --noproxy '*' -o /tmp/akari-smoke/last -w "%{http_code}" "$@"; }
last_json() { python3 -c "import json,sys; d=json.load(open('/tmp/akari-smoke/last')); print($1)"; }

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
    "-X POST http://127.0.0.1:8080/" \
    "http://127.0.0.1:8080/admin" \
    "http://127.0.0.1:8080/app" \
    "http://127.0.0.1:8080/_/healthz" \
    "http://127.0.0.1:8080/sub/x" \
    "$SUBBASE" \
    "$SUBBASE/" \
    "$BASE/sub/x" \
    "$BASE/install/x" \
    "-X POST $BASE/pay/alipay/notify" \
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
    "$SUBBASE/not-a-real-token" \
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

echo "== W27: bot protection of the public forms (default: honeypot + 2 s minimum) =="
# Fingerprint without the per-request id (status, headers, body).
fpr() { curl -s --noproxy '*' -D - "$@" | tr -d '\r' | grep -viE '^(date|x-request-id):' | sha256sum | cut -d' ' -f1; }
guard_opts() { # -> the form token of a fresh /auth/options (asserts the guard part)
  curl -s --noproxy '*' -D /tmp/akari-smoke/opth -o /tmp/akari-smoke/last "$BASE/auth/options"
  tr -d '\r' </tmp/akari-smoke/opth | matches -i '^cache-control: no-store' || { echo "FAIL: /auth/options cacheable"; exit 1; }
  last_json "d['guard']['form_token'] or ''"
}
FT=$(guard_opts)
last_json "d['guard']['form_min_secs'] == 2 and d['guard']['honeypot'] is True and d['guard']['turnstile'] is None" | matches '^True$' \
  || { echo "FAIL: default guard options"; cat /tmp/akari-smoke/last; exit 1; }
[ -n "$FT" ] || { echo "FAIL: no form token"; exit 1; }
sleep 2.2
gl() { printf '{"email":"root@smoke.test","password":"%s","guard":%s}' "$1" "$2"; }
WRONG=$(fpr -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "$(gl wrong-password "{\"form_token\":\"$FT\"}")")
FRESH=$(guard_opts)
for trap in "{\"form_token\":\"$FT\",\"website\":\"http://spam.example\"}" "{\"form_token\":\"$FRESH\"}" "{}"; do
  [ "$(fpr -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "$(gl "$ADMIN_PW" "$trap")")" = "$WRONG" ] \
    || { echo "FAIL: trapped login differs from a wrong password: $trap"; exit 1; }
done
[ "$(code -c "$JAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "$(gl "$ADMIN_PW" "{\"form_token\":\"$FT\",\"website\":\"\"}")")" = "200" ] || { echo "FAIL: guarded login"; exit 1; }
curl -s --noproxy '*' http://127.0.0.1:9109/metrics | matches '^akari_bot_trap_total{form="login",reason="honeypot"} 1$' \
  || { echo "FAIL: trap counter"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'auth.login_failed'")" -ge 1 ] || { echo "FAIL: failed login audit"; exit 1; }
# 系统设置 → 登录与注册: the secret is write-only; a Turnstile switch needs both keys.
[ "$(code -b "$JAR" "$BASE/api/v1/settings/auth")" = "200" ] && last_json "d['turnstile_secret_set'] is False and d['min_submit_secs'] == 2 and d['version'] == 0" | matches '^True$' \
  || { echo "FAIL: GET settings/auth"; cat /tmp/akari-smoke/last; exit 1; }
AUTHSET='"turnstile_register":false,"turnstile_reset":false,"honeypot":true,"passkey_only_admins":false,"passkey_only_users":false,"passkey_prompt":false'
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/auth" -H 'Content-Type: application/json' \
    -d "{\"version\":0,\"turnstile_site_key\":\"0x4AAA\",\"turnstile_login\":true,$AUTHSET,\"min_submit_secs\":2}")" = "400" ] \
  && last_json "d['code']" | matches '^auth_admin.turnstile_incomplete$' || { echo "FAIL: Turnstile without secret accepted"; exit 1; }
# The rest of the smoke posts logins straight from curl: no minimum time.
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/auth" -H 'Content-Type: application/json' \
    -d "{\"version\":0,\"turnstile_site_key\":\"0x4AAA\",\"turnstile_secret\":\"smoke-secret-x\",\"turnstile_login\":false,$AUTHSET,\"min_submit_secs\":0}")" = "200" ] \
  && last_json "d['turnstile_secret_set'] is True and 'smoke-secret-x' not in json.dumps(d)" | matches '^True$' || { echo "FAIL: PUT settings/auth"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT after->>'turnstile_secret' FROM audit_log WHERE action = 'settings.auth.update'")" = "changed" ] \
  || { echo "FAIL: settings.auth.update audit"; exit 1; }
curl -s --noproxy '*' -o /tmp/akari-smoke/last "$BASE/auth/options"
last_json "d['guard']['form_token'] is None and d['guard']['turnstile'] == {'site_key': '0x4AAA', 'login': False, 'register': False, 'reset': False}" | matches '^True$' \
  || { echo "FAIL: options after the change"; cat /tmp/akari-smoke/last; exit 1; }
matches -v smoke-secret-x /tmp/akari-smoke/last || { echo "FAIL: Turnstile secret leaked"; exit 1; }
echo "bot protection: ok"

echo "== W27: passkeys (unavailable without an https main domain), login-method reset =="
curl -s --noproxy '*' -o /tmp/akari-smoke/last "$BASE/auth/options"
last_json "d['passkey']" | matches '^False$' || { echo "FAIL: passkey offered without a main domain"; exit 1; }
# W36-b: the site time zone, for the portal's dates (default Asia/Shanghai).
last_json "d['timezone']" | matches '^Asia/Shanghai$' || { echo "FAIL: /auth/options timezone"; exit 1; }
for p in "-X POST $BASE/auth/passkey/options" "-X POST $BASE/auth/passkey/login"; do
  # shellcheck disable=SC2086
  [ "$(fp $p)" = "$REJ" ] || { echo "FAIL: unavailable passkey endpoint answers: $p"; exit 1; }
done
[ "$(code -b "$JAR" "$BASE/api/v1/me/passkeys")" = "200" ] \
  && last_json "d['available'] is False and d['passkeys'] == [] and d['password_login'] is True" | matches '^True$' \
  || { echo "FAIL: GET /me/passkeys"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/me/passkeys/options")" = "409" ] && last_json "d['code']" | matches '^account.passkey_unavailable$' \
  || { echo "FAIL: passkey registration without a main domain"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/me/password-login" -H 'Content-Type: application/json' -d '{"enabled":false}')" = "409" ] \
  && last_json "d['code']" | matches '^account.passkey_required$' || { echo "FAIL: password login off without a passkey"; exit 1; }
"$PANEL" admin reset-login ROOT@smoke.test | matches '0 passkey' || { echo "FAIL: akari admin reset-login"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'user.login_method.reset' AND actor_label = 'cli'")" = "1" ] \
  || { echo "FAIL: reset-login not audited"; exit 1; }
ROOT_ID=$(psql_q "SELECT id FROM users WHERE email = 'root@smoke.test'")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$ROOT_ID/login-method/reset")" = "200" ] && last_json "d['deleted_passkeys']" | matches '^0$' \
  || { echo "FAIL: admin login-method reset"; exit 1; }
echo "passkeys: ok"

echo "== login (wrong password x3, then ok) =="
for i in 1 2 3; do
  [ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
      -d '{"email":"root@smoke.test","password":"totally-wrong"}')" = "401" ] || { echo "FAIL: bad login not 401"; exit 1; }
done
[ "$(code -c "$JAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"root@smoke.test\",\"password\":\"$ADMIN_PW\"}")" = "200" ] || { echo "FAIL: good login failed"; exit 1; }
grep -q '"role":"admin"' /tmp/akari-smoke/last || { echo "FAIL: login response missing role"; exit 1; }
echo "login: ok"

echo "== D1/D7: email login, no second factor =="
last_json "d['email'] == 'root@smoke.test' and 'login' not in d and 'stage' not in d" | matches '^True$' \
  || { echo "FAIL: login response shape"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/users")" = "200" ] || { echo "FAIL: admin cannot list users"; exit 1; }
# A5: the login body is strict JSON (400 + JSON error, not axum's 415/422);
# the removed fields (`login`, the TOTP `code`) are unknown fields.
for body in "{\"email\":\"root@smoke.test\",\"password\":\"$ADMIN_PW\",\"extra\":1}" \
            "{\"email\":\"root@smoke.test\",\"password\":\"$ADMIN_PW\",\"code\":\"123456\"}" \
            "{\"login\":\"root@smoke.test\",\"password\":\"$ADMIN_PW\"}"; do
  [ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "$body")" = "400" ] && grep -q '"error"' /tmp/akari-smoke/last \
    || { echo "FAIL: login body not a 400: $body"; exit 1; }
done
[ "$(code -X POST "$BASE/auth/login" -d 'not json')" = "400" ] || { echo "FAIL: non-JSON login body not a 400"; exit 1; }
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"root@smoke.test","password":"wrong-password"}')" = "401" ] || { echo "FAIL: wrong password not 401"; exit 1; }
REJ401=$(cat /tmp/akari-smoke/last)
[ "$REJ401" = '{"code":"auth.unauthorized","error":"unauthorized","params":{}}' ] || { echo "FAIL: wrong password body: $REJ401"; exit 1; }
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"nobody@smoke.test\",\"password\":\"$ADMIN_PW\"}")" = "401" ] \
  && [ "$(cat /tmp/akari-smoke/last)" = "$REJ401" ] || { echo "FAIL: unknown address not the uniform 401"; exit 1; }
login_root() { # -> http status; session in $JAR (any case: addresses are case-insensitive)
  code -c "$JAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"ROOT@smoke.test\",\"password\":\"$ADMIN_PW\"}"
}
[ "$(login_root)" = "200" ] || { echo "FAIL: login in another case"; exit 1; }
# The TOTP endpoints are gone: the canonical rejection.
for p in "$BASE/api/v1/me/totp" "-X POST $BASE/api/v1/me/totp/enroll" "-X POST $BASE/api/v1/me/totp/confirm" \
         "-X POST $BASE/api/v1/me/totp/recovery-codes" "-X DELETE $BASE/api/v1/users/00000000-0000-4000-8000-000000000000/totp"; do
  # shellcheck disable=SC2086
  [ "$(fp -b "$JAR" $p)" = "$REJ" ] || { echo "FAIL: removed TOTP endpoint answers: $p"; exit 1; }
done
echo "email login: ok"

echo "-- W25: the imported settings through the API (database only; obsolete keys listed) --"
[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings"; exit 1; }
python3 - "$TEST_RELEASE_PUB" <<'PY' || { echo "FAIL: W25 settings view"; cat /tmp/akari-smoke/last; exit 1; }
import json, sys
v = json.load(open("/tmp/akari-smoke/last"))
assert v["node"]["panel_addr"] == "127.0.0.1:8443" and v["node"]["source"] == "settings", v["node"]
assert v["probe"]["urls"]["source"] == "settings", v["probe"]
assert v["node_ops"]["acme_directory_url"] == "https://127.0.0.1:14000/dir", v["node_ops"]
assert v["security"]["extra_release_keys"] == [sys.argv[1] + " TEST-ONLY"], v["security"]
assert [k["official"] for k in v["security"]["release_keys"]] == [True, False], v["security"]
for k in ("grpc.advertise", "acme.directory_url", "sub.rate_per_token", "updates.release_keys"):
    assert k in v["obsolete_config_keys"], v["obsolete_config_keys"]
PY
echo "w25 settings api: ok"

echo "== D4/D11: the portal at /, the console and the API under the admin prefix =="
[ "$(code "$ROOT/")" = "200" ] || { echo "FAIL: the portal is not at /"; exit 1; }
grep -qF "$PREFIX" /tmp/akari-smoke/last && { echo "FAIL: the portal page carries the admin prefix"; exit 1; }
curl -s --noproxy '*' -D - -o /dev/null "$ROOT/" | matches -i '^content-security-policy: default-src' \
  || { echo "FAIL: the portal page lacks the security headers"; exit 1; }
for p in /shop /tickets /help/x /register /healthz; do
  [ "$(code "$ROOT$p")" = "200" ] || { echo "FAIL: portal path $p"; exit 1; }
done
# The admin sign-in page under the prefix (W33-b) loads its assets there.
[ "$(code "$BASE/app")" = "200" ] && matches -F "/$PREFIX/app/assets/" </tmp/akari-smoke/last \
  || { echo "FAIL: the admin sign-in page under the admin prefix"; exit 1; }
# An admin's right password on the portal = the wrong password's answer; an
# admin session does not exist there.
PWRONG=$(fpr -X POST "$ROOT/auth/login" -H 'Content-Type: application/json' -d '{"email":"root@smoke.test","password":"wrong-password"}')
[ "$(fpr -X POST "$ROOT/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"root@smoke.test\",\"password\":\"$ADMIN_PW\"}")" = "$PWRONG" ] \
  || { echo "FAIL: an admin signs in on the portal"; exit 1; }
for p in /api/v1/me /api/v1/users /api/v1/settings/access; do
  [ "$(fp -b "$JAR" "$ROOT$p")" = "$REJ" ] || { echo "FAIL: an admin session answers on the portal: $p"; exit 1; }
done
echo "front door: ok"

echo "== W27: self-service account deletion =="
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-leaving@smoke.test","password":"leaving-password-1"}')" = "201" ] || { echo "FAIL: create leaving user"; exit 1; }
LEAVING=$(last_json "d['id']")
LJAR="$LOG/leaving-cookies"
[ "$(code -c "$LJAR" -X POST "$ROOT/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-leaving@smoke.test","password":"leaving-password-1"}')" = "200" ] || { echo "FAIL: leaving user login"; exit 1; }
[ "$(code -b "$LJAR" "$ROOT/api/v1/me/delete-impact")" = "200" ] \
  && last_json "d['anonymized'] is False and d['balance_cents'] == 0 and d['plan'] is None" | matches '^True$' \
  || { echo "FAIL: /me/delete-impact: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(code -b "$LJAR" -X POST "$ROOT/api/v1/me/delete" -H 'Content-Type: application/json' -d '{"confirm":true}')" = "400" ] \
  && last_json "d['code']" | matches '^account.password_required$' || { echo "FAIL: deletion without the password"; exit 1; }
[ "$(code -b "$LJAR" -c "$LJAR" -X POST "$ROOT/api/v1/me/delete" -H 'Content-Type: application/json' \
    -d '{"confirm":true,"password":"leaving-password-1"}')" = "204" ] || { echo "FAIL: self-service deletion: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM users WHERE id = '$LEAVING'")" = "0" ] || { echo "FAIL: the account (no finance records) was not deleted"; exit 1; }
[ "$(psql_q "SELECT after->>'why' FROM audit_log WHERE action = 'user.erase' AND target_id = '$LEAVING'")" = "self_service" ] \
  || { echo "FAIL: deletion not audited"; exit 1; }
[ "$(code -X POST "$ROOT/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-leaving@smoke.test","password":"leaving-password-1"}')" = "401" ] || { echo "FAIL: a deleted account signs in"; exit 1; }
echo "self-service deletion: ok"

echo "== D10: never-used accounts: filters, bulk deletion with confirmation, automatic cleanup =="
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-idle@smoke.test","password":"idle-password-123"}')" = "201" ] || { echo "FAIL: create idle user"; exit 1; }
IDLE=$(last_json "d['id']")
psql_q "UPDATE users SET created_at = now() - interval '40 days' WHERE id = '$IDLE'" >/dev/null
BEFORE=$(date -u -d '-30 days' +%F)
[ "$(code -b "$JAR" "$BASE/api/v1/users?never_used=true&registered_before=$BEFORE")" = "200" ] \
  && last_json "[u['id'] for u in d['users']] == ['$IDLE']" | matches '^True$' \
  || { echo "FAIL: never-used filter: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/users?registered_before=yesterday")" = "400" ] || { echo "FAIL: bad day filter"; exit 1; }
SEL="{\"filter\":{\"never_used\":true,\"registered_before\":\"$BEFORE\"}}"
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/delete/preview" -H 'Content-Type: application/json' -d "{\"selection\":$SEL}")" = "200" ] \
  && last_json "d['deletable'] == 1 and d['anonymized'] == 0" | matches '^True$' || { echo "FAIL: bulk delete preview: $(cat /tmp/akari-smoke/last)"; exit 1; }
CTOK=$(last_json "d['confirm_token']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/delete" -H 'Content-Type: application/json' -d "{\"selection\":$SEL,\"confirm_token\":\"x\"}")" = "409" ] \
  || { echo "FAIL: bulk delete without the preview's token"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/delete" -H 'Content-Type: application/json' -d "{\"selection\":$SEL,\"confirm_token\":\"$CTOK\"}")" = "200" ] \
  && last_json "d == {'deleted': 1, 'anonymized': 0, 'failed': 0}" | matches '^True$' || { echo "FAIL: bulk delete: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM users WHERE id = '$IDLE'")" = "0" ] || { echo "FAIL: bulk-deleted account still there"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/settings/cleanup")" = "200" ] \
  && last_json "d['auto'] is False and d['after_days'] == 30 and d['warn'] is False and d['version'] == 0" | matches '^True$' \
  || { echo "FAIL: cleanup settings defaults: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/cleanup" -H 'Content-Type: application/json' \
    -d '{"version":0,"auto":false,"after_days":45,"warn":true,"warn_days":5}')" = "200" ] \
  && last_json "d['after_days'] == 45 and d['warn_days'] == 5 and d['version'] == 1" | matches '^True$' \
  || { echo "FAIL: cleanup settings: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.cleanup.update'")" = "1" ] || { echo "FAIL: cleanup settings not audited"; exit 1; }
# A sign-in is recorded (and clears a cleanup warning).
[ -n "$(psql_q "SELECT last_login_at FROM users WHERE email = 'root@smoke.test'")" ] || { echo "FAIL: last_login_at not recorded"; exit 1; }
echo "never-used accounts: ok"

echo "== auth lives at /{prefix}/auth, not /api/v1/auth (REVIEW P0 #1) =="
# Nothing may depend on the wrong path: it must stay a rejection.
[ "$(code -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"root@smoke.test\",\"password\":\"$ADMIN_PW\"}")" = "404" ] || { echo "FAIL: /api/v1/auth/login not 404"; exit 1; }
[ ! -s /tmp/akari-smoke/last ] || { echo "FAIL: /api/v1/auth/login is not the empty rejection"; exit 1; }
[ "$(code -X POST "$BASE/api/v1/auth/logout")" = "404" ] || { echo "FAIL: /api/v1/auth/logout not 404"; exit 1; }
echo "auth path: ok"

echo "== unauthorized access =="
[ "$(code "$BASE/api/v1/users")" = "401" ] || { echo "FAIL: cookieless access not 401"; exit 1; }
echo "unauthorized: ok"

echo "== configure node + user via API =="
# Q1: the node (one inbound) on the CLI-registered server.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' \
    -d "{\"server_id\":\"$SERVER_ID\",\"name\":\"test-node\"}")" = "201" ] \
  || { echo "FAIL: create the node on the server"; cat /tmp/akari-smoke/last; exit 1; }
NODE_ID=$(last_json "d['id']")
[ "$(last_json "d['server_id']")" = "$SERVER_ID" ] && [ "$NODE_ID" != "$SERVER_ID" ] \
  && [ "$(last_json "'enrollment_token' in d")" = "False" ] \
  || { echo "FAIL: node not on its server"; cat /tmp/akari-smoke/last; exit 1; }
# W28-a (D2): a node has one inbound (the panel names it; PUT .../inbound).
put_inbound() { code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbound" -H 'Content-Type: application/json' -d "{\"inbound\":$1}"; }
GOOD_IB='{"listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp"}}'
[ "$(put_inbound "$GOOD_IB")" = "200" ] || { echo "FAIL: set inbound failed"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(put_inbound '[{"listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp"}}]')" = "400" ] && last_json "d['code']" | matches -x 'inbound.not_object' \
  || { echo "FAIL: an inbound array (pre-D2 shape) not refused"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/inbounds" -H 'Content-Type: application/json' -d '{"inbounds":[]}')" = "404" ] \
  || { echo "FAIL: the removed multi-inbound endpoint answers"; exit 1; }
[ "$(put_inbound '{"listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"sniffing":{"enabled":true,"destOverride":["fakedns"]}}')" = "400" ] \
  || { echo "FAIL: fakedns inbound not rejected"; exit 1; }
# W8: the protocol matrix is validated (Vision only on raw TCP + TLS/REALITY).
# gRPC is accepted again since R26 (exercised in the W8 section below).
[ "$(put_inbound '{"listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none","flow":"xtls-rprx-vision"},"streamSettings":{"network":"ws"}}')" = "400" ] \
  || { echo "FAIL: vision over ws not rejected"; exit 1; }
grep -q 'xtls-rprx-vision needs' /tmp/akari-smoke/last || { echo "FAIL: vision rejection lacks the reason"; exit 1; }
code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
grep -q '"warnings":\[\]' /tmp/akari-smoke/last || { echo "FAIL: node view lacks empty warnings"; exit 1; }

# W28-a: every node has its built-in direct entrance; clients dial its
# connect host (PATCH /entrances/{id}).
[ "$(code -b "$JAR" "$BASE/api/v1/nodes/$NODE_ID")" = "200" ] || { echo "FAIL: GET node"; exit 1; }
DIRECT_ID=$(last_json "[e['id'] for e in d['entrances'] if e['kind'] == 'direct'][0]")
last_json "[(e['kind'], e['name'] == '直连', e['rate_permille'], e['enabled']) for e in d['entrances']]" \
  | matches -Fx "[('direct', True, 1000, True)]" \
  || { echo "FAIL: node without exactly its direct entrance"; cat /tmp/akari-smoke/last; exit 1; }
entrance_patch() { code -b "$JAR" -X PATCH "$BASE/api/v1/entrances/$DIRECT_ID" -H 'Content-Type: application/json' -d "$1"; }
[ "$(entrance_patch '{"connect_host":"node1.example.test"}')" = "200" ] && last_json "d['connect_host']" | matches -x 'node1.example.test' \
  || { echo "FAIL: set the direct entrance's connect host"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(entrance_patch '{"connect_host":"bad host!"}')" = "400" ] && last_json "d['code']" | matches -x 'entrance.host_invalid' \
  || { echo "FAIL: bad connect host accepted"; exit 1; }
[ "$(code -b "$JAR" -X PATCH "$BASE/api/v1/entrances/00000000-0000-0000-0000-000000000000" -H 'Content-Type: application/json' -d '{"enabled":true}')" = "404" ] \
  || { echo "FAIL: PATCH of an unknown entrance not 404"; exit 1; }

# W28-a (D3): access only comes from a plan (plan -> node group -> entrance);
# there is no manual assignment. One access plan grants the direct entrance
# (its quota = smoke-user's limit); grant USER gives USER that plan.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/node-groups" -H 'Content-Type: application/json' \
    -d "{\"name\":\"smoke-access\",\"entrance_ids\":[\"$DIRECT_ID\"]}")" = "201" ] \
  || { echo "FAIL: create access group"; cat /tmp/akari-smoke/last; exit 1; }
ACCESS_GROUP=$(last_json "d['id']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/plans" -H 'Content-Type: application/json' \
    -d "{\"name\":\"smoke-access\",\"traffic_quota_bytes\":107374182400,\"period\":\"monthly\",\"group_ids\":[\"$ACCESS_GROUP\"]}")" = "201" ] \
  || { echo "FAIL: create access plan"; cat /tmp/akari-smoke/last; exit 1; }
ACCESS_PLAN=$(last_json "d['id']")
grant() { # user id -> the access plan (200)
  [ "$(code -b "$JAR" -X PUT "$BASE/api/v1/users/$1/plan" -H 'Content-Type: application/json' \
      -d "{\"plan_id\":\"$ACCESS_PLAN\",\"period\":\"month\"}")" = "200" ] || { echo "FAIL: grant $1"; cat /tmp/akari-smoke/last; exit 1; }
}
# The user's account on the direct entrance (field $2, default id).
account_of() { psql_q "SELECT account->>'${2:-id}' FROM entrance_users WHERE user_id='$1' AND entrance_id='$DIRECT_ID'"; }

[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-user@smoke.test","password":"user-password-123"}')" = "201" ] \
  || { echo "FAIL: create user failed"; cat /tmp/akari-smoke/last; exit 1; }
USER_ID=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
SUB_TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['sub_token'])")

[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_ID/nodes/$NODE_ID" -H 'Content-Type: application/json' \
    -d '{"inbound_tag":"in-vless","protocol":"vless"}')" = "404" ] \
  || { echo "FAIL: the removed manual assignment endpoint answers (D3)"; exit 1; }
grant "$USER_ID"
[ "$(account_of "$USER_ID" flow)" = "" ] && VLESS_A=$(account_of "$USER_ID") && [ -n "$VLESS_A" ] \
  || { echo "FAIL: the plan did not generate a vless account"; exit 1; }
echo "api setup: ok (user $USER_ID on node $NODE_ID)"

echo "== subscription =="
SUB="$SUBBASE/$SUB_TOKEN"
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
curl -s --noproxy '*' -D - -o /dev/null "$SUBBASE/not-a-real-token" | matches -i "subscription-userinfo" \
  && { echo "FAIL: quota header leaked on rejection"; exit 1; }
echo "subscription: ok ($SIZE-byte padded body)"

echo "== W30: client detection, routing template =="
# The subscription rate limit (8 per user per window under AKARI_TEST_LIMITS)
# would answer these checks with the rejection: a clean limiter before each.
subrl() { vk EVAL "for _,k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1" 0 'akari:rl:sub:*' >/dev/null; }
# Real User-Agents of the clients: the format each one understands.
for pair in "clash-verge/v2.2.3=text/yaml" "Stash/2.7.5 Clash/1.11.0=text/yaml" "mihomo.party/v1.7.3=text/yaml" \
            "SFA/1.12.0 (Android 14; sing-box 1.12.0)=application/json" "SFI/1.12.0 (Apple iOS 18.1; sing-box 1.12.0)=application/json" \
            "HiddifyNext/2.5.7 (android) like ClashMeta v2ray sing-box=text/plain" "Shadowrocket/2070 CFNetwork/1410=text/plain" \
            "v2rayN/7.4.2=text/plain"; do
  ua=${pair%=*}; want=${pair##*=}
  subrl
  curl -s --noproxy '*' -A "$ua" -D - -o /dev/null "$SUB" | matches -i "^content-type: $want" \
    || { echo "FAIL: $ua does not get $want"; exit 1; }
done
# The built-in routing: rule-providers (Clash), rule sets + TUN profile (sing-box).
subrl
W30_CODE=$(curl -s --noproxy '*' -o "$LOG/w30-clash.yaml" -w "%{http_code}" -A "clash-verge/v2" "$SUB")
for want in "^rule-providers:" "^  - RULE-SET,geosite-category-ads-all,REJECT" "^  - RULE-SET,geosite-cn,DIRECT" \
            "^  - RULE-SET,geoip-cn,DIRECT,no-resolve" "^  - MATCH,PROXY"; do
  matches "$want" <"$LOG/w30-clash.yaml" \
    || { echo "FAIL: clash routing lacks $want (HTTP $W30_CODE)"; head -c 3000 "$LOG/w30-clash.yaml"; exit 1; }
done
subrl
curl -s --noproxy '*' -A "SFA/1.12.0" "$SUB" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); r=d['route']; assert r['final']=='PROXY' and {s['tag'] for s in r['rule_set']}>={'geosite-cn','geoip-cn','geosite-category-ads-all'} and d['inbounds'][0]['type']=='tun' and d['outbounds'][0]['type']=='selector', r" \
  || { echo "FAIL: sing-box profile"; exit 1; }
# The template is editable (audited); null restores the default.
[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings (W30)"; exit 1; }
W30_VER=$(last_json "d['version']")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/subscription" -H 'Content-Type: application/json' \
    -d "{\"version\":$W30_VER,\"rules\":[{\"type\":\"domain_suffix\",\"value\":\"corp.example\",\"action\":\"direct\"}]}")" = "200" ] \
  || { echo "FAIL: PUT subscription settings"; cat /tmp/akari-smoke/last; exit 1; }
for _ in $(seq 1 20); do subrl; curl -s --noproxy '*' -A "clash-verge/v2" "$SUB" | matches "^  - DOMAIN-SUFFIX,corp.example,DIRECT" && break; sleep 0.25; done
subrl; curl -s --noproxy '*' -A "clash-verge/v2" "$SUB" | matches "^  - DOMAIN-SUFFIX,corp.example,DIRECT" || { echo "FAIL: edited routing not served"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/subscription" -H 'Content-Type: application/json' \
    -d "{\"version\":$((W30_VER + 1)),\"rules\":null}")" = "200" ] || { echo "FAIL: reset routing"; exit 1; }
# Section 5: a format that is off is the uniform rejection; the portal hides
# its import buttons.
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/subscription" -H 'Content-Type: application/json' \
    -d "{\"version\":$((W30_VER + 2)),\"formats\":[\"clash\"],\"import_clients\":[\"clash\",\"shadowrocket\"]}")" = "200" ] \
  && [ "$(last_json "d['subscription']['import_clients_shown']")" = "['clash']" ] \
  || { echo "FAIL: format switches"; cat /tmp/akari-smoke/last; exit 1; }
for _ in $(seq 1 20); do subrl; [ "$(fp -A "v2rayN/7.4.2" "$SUB")" = "$REJ" ] && break; sleep 0.25; done
subrl; [ "$(fp -A "v2rayN/7.4.2" "$SUB")" = "$REJ" ] || { echo "FAIL: a disabled format is not the canonical rejection"; exit 1; }
subrl; [ "$(fp "$SUB?format=sing-box")" = "$REJ" ] || { echo "FAIL: ?format of a disabled format answers"; exit 1; }
subrl; [ "$(code -A "clash-verge/v2" "$SUB")" = "200" ] || { echo "FAIL: the enabled format stopped"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/subscription" -H 'Content-Type: application/json' \
    -d "{\"version\":$((W30_VER + 3)),\"formats\":null,\"import_clients\":null}")" = "200" ] || { echo "FAIL: switches back on"; exit 1; }
for _ in $(seq 1 20); do subrl; [ "$(code -A "v2rayN/7.4.2" "$SUB")" = "200" ] && break; sleep 0.25; done
subrl; [ "$(code -A "v2rayN/7.4.2" "$SUB")" = "200" ] || { echo "FAIL: links not back"; exit 1; }
# These fetches must not eat the user's subscription rate budget (M1-10 below).
subrl
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='settings.subscription.update'")" = "4" ] || { echo "FAIL: subscription settings not audited"; exit 1; }
echo "w30 client detection + routing + format switches: ok"

echo "== subscription: REALITY inbound carries a uTLS fingerprint (default + admin hint) =="
# Throwaway REALITY inbound + user; the panel only reads publicKey/fingerprint
# for subscriptions (the keys here are never used by a client).
RKEY=$(python3 -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('='))")
reality_inbound() { # $1 = extra realitySettings JSON members (leading comma) or empty
  printf '{"listen":"127.0.0.1","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"dest":"www.apple.com:443","serverNames":["www.apple.com"],"privateKey":"%s","publicKey":"%s","shortIds":["ab12"],"shortId":"ab12"%s}}}' "$RKEY" "$RKEY" "$1"
}
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-fp@smoke.test","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create fp user"; cat /tmp/akari-smoke/last; exit 1; }
FP_USER=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
FP_SUB="$SUBBASE/$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['sub_token'])")"
check_fp() { # $1 = expected fingerprint
  curl -s --noproxy '*' "$FP_SUB" | base64 -d 2>/dev/null | matches "security=reality.*&fp=$1" \
    || { echo "FAIL: link lacks fp=$1"; exit 1; }
  curl -s --noproxy '*' -A "clash-meta/1.19" "$FP_SUB" | matches "^    client-fingerprint: $1" \
    || { echo "FAIL: clash lacks client-fingerprint $1"; exit 1; }
  curl -s --noproxy '*' -A "sing-box/1.12.0" "$FP_SUB" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); u=[o['tls']['utls'] for o in d['outbounds'] if o.get('tls',{}).get('reality')][0]; assert u=={'enabled':True,'fingerprint':'$1'}, u" \
    || { echo "FAIL: sing-box lacks tls.utls $1"; exit 1; }
}
[ "$(put_inbound "$(reality_inbound '')")" = "200" ] || { echo "FAIL: put reality inbound"; cat /tmp/akari-smoke/last; exit 1; }
grant "$FP_USER"
check_fp chrome
[ "$(put_inbound "$(reality_inbound ',"fingerprint":"firefox"')")" = "200" ] || { echo "FAIL: put reality inbound with fingerprint"; exit 1; }
check_fp firefox
# 中-7: a user delete shows its impact first and needs confirm=true.
[ "$(code -b "$JAR" "$BASE/api/v1/users/$FP_USER/delete-impact")" = "200" ] \
  && [ "$(last_json "d['balance_cents']")/$(last_json "d['pending_orders']")" = "0/0" ] \
  || { echo "FAIL: user delete impact"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$FP_USER")" = "400" ] && last_json "d['code']" | matches -x 'user.delete_confirm_required' \
  || { echo "FAIL: user deleted without confirm"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$FP_USER?confirm=true")" = "204" ] || { echo "FAIL: delete fp user"; exit 1; }
[ "$(put_inbound "$GOOD_IB")" = "200" ] || { echo "FAIL: restore inbound"; exit 1; }
# Same protocol (vless -> vless): smoke-user keeps its credential.
[ "$(account_of "$USER_ID")" = "$VLESS_A" ] || { echo "FAIL: an inbound edit of the same protocol reissued the credential"; exit 1; }
echo "reality fingerprint: ok"

echo "== M1-9 self-service sub token; M1-10 over the limit = the canonical rejection =="
UJAR="$LOG/user-cookies"
# D11: users sign in on the portal (root).
[ "$(code -c "$UJAR" -X POST "$ROOT/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-user@smoke.test","password":"user-password-123"}')" = "200" ] || { echo "FAIL: user login"; exit 1; }
[ "$(code -b "$UJAR" "$ROOT/api/v1/me")" = "200" ] || { echo "FAIL: user session on the portal"; exit 1; }
[ "$(code -b "$UJAR" -X POST "$BASE/api/v1/me/sub-token" -H 'Content-Type: application/json' -d '{}')" = "200" ] \
  || { echo "FAIL: self-service sub token"; cat /tmp/akari-smoke/last; exit 1; }
NEW_TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['sub_token'])")
[ "$(fp "$SUB")" = "$REJ" ] || { echo "FAIL: old subscription URL still answers differently"; exit 1; }
# 高-3: the reset also gave the user a new credential on every entrance.
[ "$(last_json "d['credentials_rotated']")" = "1" ] && [ "$(account_of "$USER_ID")" != "$VLESS_A" ] \
  || { echo "FAIL: subscription reset kept the old credential"; cat /tmp/akari-smoke/last; exit 1; }
SUB="$SUBBASE/$NEW_TOKEN"
# W20 (B1): the link stays retrievable — /me returns it (no-store), and an
# admin can read it (audited, no token material in the audit row).
[ "$(code -D "$LOG/me.h" -b "$UJAR" "$BASE/api/v1/me")" = "200" ] \
  && last_json "d['sub_token']" | matches "^$NEW_TOKEN\$" \
  && last_json "d['sub_legacy']" | matches '^False$' \
  && last_json "d['timezone']" | matches '^Asia/Shanghai$' \
  && tr -d '\r' <"$LOG/me.h" | matches -i '^cache-control: no-store$' \
  || { echo "FAIL: /me does not return the stored subscription link"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/users/$USER_ID/subscription")" = "200" ] \
  && last_json "d['sub_token']" | matches "^$NEW_TOKEN\$" \
  || { echo "FAIL: admin subscription read"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/audit?action=user.sub_token.read")" = "200" ] \
  && last_json "len(d['entries'])" | matches '^[1-9]' \
  && ! matches "$NEW_TOKEN" </tmp/akari-smoke/last \
  || { echo "FAIL: admin subscription read not audited (or leaks the token)"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$UJAR" "$BASE/api/v1/users/$USER_ID/subscription")" = "403" ] \
  || { echo "FAIL: a user can read the admin subscription endpoint"; exit 1; }
# rate_per_token = 8 per window (AKARI_TEST_LIMITS): all 8 here, from a clean
# limiter (W20: the first one picks the format with ?format=, not the UA).
subrl
curl -s --noproxy '*' -A "curl/8" -D "$LOG/fmt.h" -o /dev/null "$SUB?format=clash"
tr -d '\r' <"$LOG/fmt.h" | matches -i '^content-type: text/yaml' || { echo "FAIL: ?format=clash"; cat "$LOG/fmt.h"; exit 1; }
for i in 2 3 4 5 6 7 8; do
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

echo "== W28-c: ban (reason required) = instant push, portal scope only =="
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_ID/ban" -H 'Content-Type: application/json' \
    -d '{"reason": "  "}')" = "400" ] && last_json "d['code']" | matches '^user.ban_reason_required$' \
  || { echo "FAIL: ban without a reason not refused"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X PATCH "$BASE/api/v1/users/$USER_ID" -H 'Content-Type: application/json' \
    -d '{"enabled": false}')" = "400" ] || { echo "FAIL: PATCH enabled (removed) not 400"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_ID/ban" -H 'Content-Type: application/json' \
    -d '{"reason": "smoke: shared account"}')" = "200" ] \
  && last_json "d['ban']['reason']" | matches '^smoke: shared account$' \
  || { echo "FAIL: ban user failed"; cat /tmp/akari-smoke/last; exit 1; }
for _ in $(seq 1 30); do grep -q '"users":0' "$LOG/agent.log" && break; sleep 0.5; done
grep -q '"users":0' "$LOG/agent.log" || { echo "FAIL: agent did not converge to empty user set"; cat "$LOG/agent.log"; exit 1; }
BJAR="$LOG/banned-cookies"
[ "$(code -c "$BJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-user@smoke.test","password":"user-password-123"}')" = "200" ] && last_json "d['banned']" | matches '^True$' \
  || { echo "FAIL: banned user cannot sign in to the portal scope"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$BJAR" "$BASE/api/v1/me")" = "200" ] && last_json "d['ban_reason']" | matches '^smoke: shared account$' \
  && last_json "d['sub_token']" | matches '^None$' \
  || { echo "FAIL: banned user's /me"; cat /tmp/akari-smoke/last; exit 1; }
for p in me/plan me/shop me/nodes; do
  [ "$(code -b "$BJAR" "$BASE/api/v1/$p")" = "403" ] && last_json "d['code']" | matches '^account.banned$' \
    || { echo "FAIL: banned user reached /$p"; exit 1; }
done
[ "$(code -b "$BJAR" "$BASE/api/v1/me/tickets")" = "200" ] || { echo "FAIL: banned user cannot reach tickets"; exit 1; }

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

echo "== unban user =="
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_ID/unban" -H 'Content-Type: application/json' -d '{}')" = "200" ] \
  && last_json "d['ban']" | matches '^None$' || { echo "FAIL: unban user"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_ID/unban" -H 'Content-Type: application/json' -d '{}')" = "409" ] \
  || { echo "FAIL: unban of a user that is not banned not 409"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/audit?action=user.ban")" = "200" ] && last_json "len(d['entries'])" | matches '^1$' \
  || { echo "FAIL: ban not audited"; exit 1; }
wait_users 1 10 "unban"
wait_port open 10

echo "== PATCH semantics =="
[ "$(patch_code "$BASE/api/v1/users/$USER_ID" '{}')" = "400" ] || { echo "FAIL: PATCH user {} not 400"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{}')" = "400" ] || { echo "FAIL: PATCH node {} not 400"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"enabled": null}')" = "400" ] || { echo "FAIL: enabled null not 400"; exit 1; }
# D12: the limit and expiry come from the plan only (unknown fields).
for f in '{"expires_at": null}' '{"traffic_limit_bytes": 1}'; do
  [ "$(patch_code "$BASE/api/v1/users/$USER_ID" "$f")" = "400" ] || { echo "FAIL: PATCH user $f not 400"; exit 1; }
done
[ "$(entrance_patch '{}')" = "400" ] || { echo "FAIL: PATCH entrance {} not 400"; exit 1; }
[ "$(entrance_patch '{"connect_host": null}')" = "200" ] || { echo "FAIL: clear connect_host not 200"; exit 1; }
grep -q '"connect_host":null' /tmp/akari-smoke/last || { echo "FAIL: connect_host not cleared"; exit 1; }
[ "$(entrance_patch '{"connect_host": "node1.example.test"}')" = "200" ] || { echo "FAIL: restore connect_host"; exit 1; }
echo "patch: ok"

echo "== failed apply is recorded (last_error) and cleared =="
# Valid for the panel (users keep their vless credentials), refused by xray
# ("unable to listen on domain address").
BAD_IB='{"listen":"bad-listen.invalid","port":11443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp"}}'
node_field() { # jq-less: print field $1 of node $NODE_ID
  code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
  python3 -c "import json,sys; print(json.dumps([n for n in json.load(open('/tmp/akari-smoke/last')) if n['id']=='$NODE_ID'][0]['$1']))"
}
[ "$(put_inbound "$BAD_IB")" = "200" ] || { echo "FAIL: put bad inbound"; cat /tmp/akari-smoke/last; exit 1; }
for _ in $(seq 1 10); do [ "$(node_field last_error)" != "null" ] && break; sleep 1; done
[ "$(node_field last_error)" != "null" ] || { echo "FAIL: last_error not recorded"; exit 1; }
echo "last_error: $(node_field last_error | cut -c1-100)"
[ "$(put_inbound "$GOOD_IB")" = "200" ] || { echo "FAIL: restore inbound"; exit 1; }
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
    # W32: the agent release carries this service file (-print-unit).
    unit:*) "$AGENT" -print-unit "${1#unit:}" >/dev/null 2>&1 ;;
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
[ "$(psql_q "SELECT count(*) FROM user_plans WHERE user_id='$USER_ID' AND status='active'")" = "1" ] || { echo "FAIL: smoke user has no active plan"; exit 1; }
# Only the plan writes the enforced expiry, and no API sets one seconds
# away: move the active plan's expiry (and the user's copy, as
# sync_users_from_plan writes it); the enforce pass then ends the plan.
psql_q "WITH p AS (UPDATE user_plans SET expires_at = now() + interval '3 seconds' WHERE user_id='$USER_ID' AND status='active' RETURNING expires_at) \
        UPDATE users SET expires_at = (SELECT expires_at FROM p), expiry_enforced = false WHERE id='$USER_ID'" >/dev/null
wait_users 0 20 "expiry"
# R21: an expired user still logs in, with the renewal scope only.
EJAR="$LOG/expired-cookies"
[ "$(code -c "$EJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-user@smoke.test","password":"user-password-123"}')" = "200" ] && grep -q '"expired":true' /tmp/akari-smoke/last \
  || { echo "FAIL: expired user cannot log in (R21)"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$EJAR" "$BASE/api/v1/me")" = "200" ] && grep -q '"expired":true' /tmp/akari-smoke/last \
  || { echo "FAIL: expired user /me"; exit 1; }
[ "$(code -b "$EJAR" "$BASE/api/v1/me/plan")" = "200" ] || { echo "FAIL: expired user /me/plan"; exit 1; }
[ "$(code -b "$EJAR" -X POST "$BASE/api/v1/me/sub-token" -H 'Content-Type: application/json' -d '{}')" = "401" ] \
  || { echo "FAIL: expired user regenerated the subscription token"; exit 1; }
grant "$USER_ID" # renewed
wait_users 1 10 "plan renewed"
VLESS_A=$(account_of "$USER_ID")
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
    -d '{"email":"smoke-user-b@smoke.test","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create user B"; exit 1; }
USER_B=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
grant "$USER_B"
VLESS_B=$(account_of "$USER_B")
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
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_B/ban" -H 'Content-Type: application/json' \
    -d '{"reason": "smoke"}')" = "200" ] || { echo "FAIL: ban B"; exit 1; }
wait_users 1 10 "user B banned"
touch "$LOG/vless.go"
wait $VLESS_PID || { echo "FAIL: live-connection check"; cat "$LOG/vless.out"; exit 1; }
cat "$LOG/vless.out"
SNAPS_AFTER=$(grep -c '"msg":"applying config snapshot"' "$LOG/agent.log")
SESSION_AFTER=$(grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['session'])")
[ "$SNAPS_BEFORE" = "$SNAPS_AFTER" ] || { echo "FAIL: banning a user rebuilt xray ($SNAPS_BEFORE -> $SNAPS_AFTER snapshots)"; exit 1; }
[ "$SESSION_BEFORE" = "$SESSION_AFTER" ] || { echo "FAIL: xray session changed ($SESSION_BEFORE -> $SESSION_AFTER)"; exit 1; }
grep -q '"msg":"applying user delta"' "$LOG/agent.log" || { echo "FAIL: no user delta in agent log"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$USER_B?confirm=true")" = "204" ] || { echo "FAIL: delete B"; exit 1; }
echo "user delta: ok (no rebuild, session $SESSION_AFTER)"

echo "== 高-3: reset subscription = new credentials; the old client is cut and refused, others keep theirs =="
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-user-c@smoke.test","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create user C"; exit 1; }
USER_C=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
grant "$USER_C"
VLESS_C=$(account_of "$USER_C")
wait_users 2 10 "user C added"
APPLIED_BEFORE=$(grep -c '"msg":"state applied"' "$LOG/agent.log")
rm -f "$LOG/vless.ready" "$LOG/vless.go"
python3 "$LOG/vless.py" hold "$VLESS_A" "$VLESS_C" "$LOG/vless.ready" "$LOG/vless.go" >"$LOG/vless.out" 2>&1 &
VLESS_PID=$!
for _ in $(seq 1 50); do [ -e "$LOG/vless.ready" ] && break; sleep 0.2; done
[ -e "$LOG/vless.ready" ] || { echo "FAIL: vless client could not connect (reset)"; cat "$LOG/vless.out"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_C/sub-token" -H 'Content-Type: application/json' -d '{}')" = "200" ] \
  && [ "$(last_json "d['credentials_rotated']")" = "1" ] || { echo "FAIL: reset C's subscription"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(account_of "$USER_C")" != "$VLESS_C" ] || { echo "FAIL: C's credential not rotated"; exit 1; }
for _ in $(seq 1 20); do
  [ "$(grep -c '"msg":"state applied"' "$LOG/agent.log")" -gt "$APPLIED_BEFORE" ] && break; sleep 0.5
done
[ "$(grep -c '"msg":"state applied"' "$LOG/agent.log")" -gt "$APPLIED_BEFORE" ] || { echo "FAIL: agent did not apply the rotated credential"; exit 1; }
touch "$LOG/vless.go"
wait $VLESS_PID || { echo "FAIL: old-credential client after the reset"; cat "$LOG/vless.out"; exit 1; }
cat "$LOG/vless.out"
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$USER_C?confirm=true")" = "204" ] || { echo "FAIL: delete C"; exit 1; }
wait_users 1 10 "user C deleted"
echo "subscription reset: ok (old credential cut and refused)"

echo "== W9: Shadowsocks 2022 removal/re-add = UserDelta (agent protocol >= 5), Snapshot before =="
# SS2022 is a managed protocol from W8 on (agent protocol >= 4).
if need_agent "protocol>=4" "W9 Shadowsocks 2022 delta/snapshot"; then
  # Agents of protocol >= 5 keep a removed SS2022 credential as a gate-refused
  # tombstone (indices never move), so the panel sends removals and re-adds
  # on a Shadowsocks node as deltas; older agents get a Snapshot (W8 rule).
  SS_PSK=$(python3 -c "import base64,os;print(base64.b64encode(os.urandom(16)).decode())")
  # One inbound per node (D2): the node switches to Shadowsocks; smoke-user's
  # vless credential is reissued as a Shadowsocks one (protocol change).
  SS_IB="{\"listen\":\"127.0.0.1\",\"port\":11445,\"protocol\":\"shadowsocks\",\"settings\":{\"method\":\"2022-blake3-aes-128-gcm\",\"password\":\"$SS_PSK\",\"clients\":[],\"network\":\"tcp\"}}"
  [ "$(put_inbound "$SS_IB")" = "200" ] || { echo "FAIL: put shadowsocks inbound"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(psql_q "SELECT protocol FROM entrance_users WHERE user_id='$USER_ID'")" = "shadowsocks" ] \
    || { echo "FAIL: protocol change did not reissue the credential"; exit 1; }
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
      -d '{"email":"smoke-user-ss@smoke.test","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create SS user"; exit 1; }
  USER_SS=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
  grant "$USER_SS"
  wait_users 2 15 "SS user added"
  for _ in $(seq 1 10); do [ "$(node_field last_error)" = "null" ] && break; sleep 1; done
  SS_PROTO=$(node_field agent_protocol)
  snaps() { grep -c '"msg":"applying config snapshot"' "$LOG/agent.log"; }
  last_via() { grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['via'])"; }
  SS_SNAPS=$(snaps)
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_SS/ban" -H 'Content-Type: application/json' \
      -d '{"reason": "smoke"}')" = "200" ] || { echo "FAIL: ban SS user"; exit 1; }
  wait_users 1 15 "SS user banned"
  if [ "$SS_PROTO" -ge 5 ]; then
    [ "$(snaps)" = "$SS_SNAPS" ] && [ "$(last_via)" = "delta" ] \
      || { echo "FAIL: SS removal was not a delta on a protocol $SS_PROTO agent"; grep 'state applied' "$LOG/agent.log" | tail -2; exit 1; }
    grep -q 'shadowsocks credential change' "$LOG/agent.log" && { echo "FAIL: agent refused an SS delta"; exit 1; }
    [ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$USER_SS/unban" -H 'Content-Type: application/json' -d '{}')" = "200" ] \
      || { echo "FAIL: unban SS user"; exit 1; }
    wait_users 2 15 "SS user unbanned"
    [ "$(snaps)" = "$SS_SNAPS" ] && [ "$(last_via)" = "delta" ] \
      || { echo "FAIL: SS re-add (tombstone revival) was not a delta"; grep 'state applied' "$LOG/agent.log" | tail -2; exit 1; }
    echo "shadowsocks: removal and re-add applied as deltas (agent protocol $SS_PROTO, no rebuild)"
  else
    [ "$(snaps)" -gt "$SS_SNAPS" ] || { echo "FAIL: SS removal on a protocol $SS_PROTO agent was not a Snapshot"; exit 1; }
    echo "shadowsocks: removal is a Snapshot (agent protocol $SS_PROTO < 5)"
fi
[ "$(node_field last_error)" = "null" ] || { echo "FAIL: last_error after SS changes: $(node_field last_error)"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$USER_SS?confirm=true")" = "204" ] || { echo "FAIL: delete SS user"; exit 1; }
[ "$(put_inbound "$GOOD_IB")" = "200" ] || { echo "FAIL: restore inbound after SS"; exit 1; }
wait_users 1 15 "after SS inbound removed"
wait_port open 10
VLESS_A=$(account_of "$USER_ID")
fi

echo "== Sprint 3a: protocol + lease surfaced on the node =="
[ "$(node_field agent_protocol)" -ge 3 ] || { echo "FAIL: agent_protocol $(node_field agent_protocol)"; exit 1; }
LEASE=$(node_field lease_remaining_seconds)
[ "$LEASE" != "null" ] && [ "$LEASE" -gt 80000 ] || { echo "FAIL: lease_remaining_seconds '$LEASE'"; exit 1; }
echo "lease: ok (${LEASE}s left)"

echo "== node online + heartbeat =="
STATUS=$(docker compose exec -T postgres psql -U akari -d "$SMOKE_DB" -tAc "SELECT status FROM servers WHERE id='$SERVER_ID'")
[ "$STATUS" = "online" ] || { echo "FAIL: node status '$STATUS'"; exit 1; }
vk exists "akari:server:online:$SERVER_ID" | matches 1 \
  || { echo "FAIL: online key missing"; exit 1; }

echo "== W11: node form fields, multiplier billing, machine status, latency =="
# Agent-side assertions need the agent capabilities "metrics" / "latency"
# (W12 gates); the panel-side ones always run.
# xboard-style fields: display name, tags, multiplier, connect override.
# W28-a: multiplier and address belong to the (direct) entrance.
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"display_name":"冒烟 01","tags":["IPLC","0.5x"],"sort":1}')" = "200" ] \
  || { echo "FAIL: W11 node fields"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"traffic_rate":0.5}')" = "400" ] || { echo "FAIL: node-level multiplier accepted"; exit 1; }
[ "$(entrance_patch '{"rate":0.5,"connect_host":"127.0.0.1","connect_port":11443}')" = "200" ] \
  || { echo "FAIL: W11 entrance fields"; cat /tmp/akari-smoke/last; exit 1; }
last_json "(d['rate_permille'], d['connect_port'])" | matches -Fx '(500, 11443)' || { echo "FAIL: multiplier not stored"; exit 1; }
[ "$(entrance_patch '{"rate":0.0001}')" = "400" ] && last_json "d['code']" | matches -x 'entrance.rate_invalid' \
  || { echo "FAIL: bad multiplier accepted"; exit 1; }
[ "$(entrance_patch '{"connect_port":70000}')" = "400" ] || { echo "FAIL: bad connect port accepted"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='entrance.update' AND target_id='$DIRECT_ID' AND after->>'rate_permille' = '500'")" -ge 1 ] \
  || { echo "FAIL: W11 entrance update not audited"; exit 1; }
# Multiplier on a real transfer: user D on the 0.5x node bills half the
# bytes the node accepted for D (floor per row: never more).
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-user-d@smoke.test","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create user D"; exit 1; }
USER_D=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
SUB_D=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['sub_token'])")
grant "$USER_D"
VLESS_D=$(account_of "$USER_D")
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
RAW_D=$(psql_q "SELECT coalesce(sum(up_bytes + down_bytes), 0) FROM traffic_counters WHERE server_id='$SERVER_ID' AND user_id='$USER_D'")
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
# next07: the name does not carry the multiplier (a rename on every rate
# change made clients drop the user's selection) unless the operator turns
# on 订阅线路名显示倍率 (base multiplier only).
subrl; curl -s --noproxy '*' -A 'clash.meta' "$SUBBASE/$SUB_D" >"$LOG/w11-sub.yaml"
grep -q '"冒烟 01 | IPLC | 0.5x 直连"' "$LOG/w11-sub.yaml" || { echo "FAIL: subscription name"; head -20 "$LOG/w11-sub.yaml"; exit 1; }
grep -q 'server: 127.0.0.1' "$LOG/w11-sub.yaml" || { echo "FAIL: connect override not in subscription"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings (next07)"; exit 1; }
N07_VER=$(last_json "d['version']")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/subscription" -H 'Content-Type: application/json' \
    -d "{\"version\":$N07_VER,\"name_rate\":true}")" = "200" ] && last_json "d['subscription']['name_rate']" | matches -x 'True' \
  || { echo "FAIL: turn on multipliers in line names"; cat /tmp/akari-smoke/last; exit 1; }
for _ in $(seq 1 20); do subrl; curl -s --noproxy '*' -A 'clash.meta' "$SUBBASE/$SUB_D" | matches -F '"冒烟 01 | IPLC | 0.5x 直连 0.5x"' && break; sleep 0.25; done
subrl; curl -s --noproxy '*' -A 'clash.meta' "$SUBBASE/$SUB_D" | matches -F '"冒烟 01 | IPLC | 0.5x 直连 0.5x"' || { echo "FAIL: name_rate not served"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/subscription" -H 'Content-Type: application/json' \
    -d "{\"version\":$((N07_VER + 1)),\"name_rate\":false}")" = "200" ] || { echo "FAIL: name_rate off"; exit 1; }
subrl
# Portal: the user's node list (no ids/addresses).
DJAR="$LOG/w11-d.jar"
[ "$(code -c "$DJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-user-d@smoke.test","password":"user-password-123"}')" = "200" ] || { echo "FAIL: user D login"; exit 1; }
[ "$(code -b "$DJAR" "$BASE/api/v1/me/nodes")" = "200" ] || { echo "FAIL: /me/nodes"; exit 1; }
python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last'))
assert len(v) == 1 and v[0]['name'] == '冒烟 01' and v[0]['entrance'] == '直连' and v[0]['rate'] == 0.5 and v[0]['online'] is True, v
assert 'id' not in v[0] and 'connect_host' not in v[0], v
" || { echo "FAIL: /me/nodes content"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$DJAR" "$BASE/api/v1/servers/$SERVER_ID/status")" = "403" ] || { echo "FAIL: user reads node status"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"visible":false}')" = "200" ] || { echo "FAIL: hide node"; exit 1; }
code -b "$DJAR" "$BASE/api/v1/me/nodes" >/dev/null
[ "$(cat /tmp/akari-smoke/last)" = "[]" ] || { echo "FAIL: hidden node listed to the user"; exit 1; }
curl -s --noproxy '*' -A 'clash.meta' "$SUBBASE/$SUB_D" >"$LOG/w11-sub-hidden.yaml"
grep -q '冒烟' "$LOG/w11-sub-hidden.yaml" && { echo "FAIL: hidden node in subscription"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"visible":true}')" = "200" ] || { echo "FAIL: show node"; exit 1; }
echo "portal + subscription: ok"

# W22: traffic history. D's transfer above lands (after compaction, ~30 s)
# on today's day in the site time zone (Q3, default Asia/Shanghai) and the
# 0.5x node: the user's /me/traffic (names only, no ids) and the admin views
# show exactly what was settled; traffic_daily is partitioned by month.
TODAY_SITE=$(psql_q "SELECT akari_site_day(now())")
psql_q "SELECT count(*) FROM pg_inherits WHERE inhparent = 'traffic_daily'::regclass" | matches '^5$' \
  || { echo "FAIL: traffic_daily partitions (default + last month .. +2)"; exit 1; }
for _ in $(seq 1 75); do
  # Settled values now (a late final report may still have added a little).
  USED_D=$(psql_q "SELECT traffic_used_bytes FROM users WHERE id='$USER_D'")
  RAW_D=$(psql_q "SELECT coalesce(sum(up_bytes + down_bytes), 0) FROM traffic_counters WHERE server_id='$SERVER_ID' AND user_id='$USER_D'")
  code -b "$DJAR" "$BASE/api/v1/me/traffic" >/dev/null
  python3 -c "import json,sys; v=json.load(open('/tmp/akari-smoke/last')); sys.exit(0 if v['total']['billed_bytes'] == $USED_D else 1)" 2>/dev/null && break
  sleep 1
done
[ "$(code -b "$DJAR" "$BASE/api/v1/me/traffic")" = "200" ] || { echo "FAIL: /me/traffic"; exit 1; }
python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last')); t = v['total']
assert v['timezone'] == 'Asia/Shanghai' and v['to'] == '$TODAY_SITE', v
assert t['billed_bytes'] == $USED_D, ('billed', t, $USED_D)
assert t['up_bytes'] + t['down_bytes'] == $RAW_D, ('raw', t, $RAW_D)
assert t['up_bytes'] > 0 and t['down_bytes'] > 0, t
assert [d['day'] for d in v['days']] == ['$TODAY_SITE'], v['days']
e = v['entrances']
assert [(n['name'], n['entrance'], n['rate'], n['rules']) for n in e] == [('冒烟 01', '直连', 0.5, [])], e
assert 'node_id' not in json.dumps(v) and '$NODE_ID' not in json.dumps(v) and '$DIRECT_ID' not in json.dumps(v), v
" || { echo "FAIL: /me/traffic content"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT DISTINCT tableoid::regclass FROM traffic_daily WHERE user_id = '$USER_D'")" = "traffic_daily_$(echo "$TODAY_SITE" | tr -d '-' | cut -c1-6)" ] \
  || { echo "FAIL: today's rows outside this month's partition"; exit 1; }
[ "$(code -b "$DJAR" "$BASE/api/v1/me/traffic?group=node")" = "400" ] || { echo "FAIL: /me/traffic accepted group"; exit 1; }
for p in "users/$USER_D/traffic" "nodes/$NODE_ID/traffic" "entrances/$DIRECT_ID/traffic" "traffic/summary"; do
  [ "$(code -b "$DJAR" "$BASE/api/v1/$p")" = "403" ] || { echo "FAIL: user reads admin $p"; exit 1; }
  [ "$(code "$BASE/api/v1/$p")" = "401" ] || { echo "FAIL: anonymous reads $p"; exit 1; }
done
[ "$(code -b "$JAR" "$BASE/api/v1/users/$USER_D/traffic?group=entrance")" = "200" ] || { echo "FAIL: admin user traffic"; exit 1; }
python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last')); r = v['rows']
assert len(r) == 1 and r[0]['node_id'] == '$NODE_ID' and r[0]['entrance_id'] == '$DIRECT_ID', r
assert (r[0]['node'], r[0]['entrance'], r[0]['kind'], r[0]['rate_now']) == ('冒烟 01', '直连', 'direct', 0.5), r
assert r[0]['billed_bytes'] == $USED_D, r
" || { echo "FAIL: admin user traffic content"; cat /tmp/akari-smoke/last; exit 1; }
# next07: an entrance's own days and its multiplier changes (audit log).
[ "$(code -b "$JAR" "$BASE/api/v1/entrances/$DIRECT_ID/traffic")" = "200" ] || { echo "FAIL: admin entrance traffic"; exit 1; }
python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last'))
d = [x for x in v['days'] if x['day'] == '$TODAY_SITE']
assert d and d[0]['users'] >= 1 and d[0]['billed_bytes'] >= $USED_D, v['days']
c = [x for x in v['rate_changes'] if x['action'] == 'entrance.update']
assert c and (c[0]['rate_before'], c[0]['rate_after']) == (1.0, 0.5) and c[0]['actor_email'], v['rate_changes']
" || { echo "FAIL: admin entrance traffic content"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/entrances/00000000-0000-0000-0000-000000000000/traffic")" = "404" ] || { echo "FAIL: unknown entrance traffic"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/nodes/$NODE_ID/traffic")" = "200" ] || { echo "FAIL: admin node traffic"; exit 1; }
python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last'))
d = [x for x in v['days'] if x['day'] == '$TODAY_SITE']
assert d and d[0]['users'] >= 1 and d[0]['billed_bytes'] >= $USED_D, v['days']
u = [x for x in v['top_users'] if x['user_id'] == '$USER_D']
assert u and u[0]['email'] == 'smoke-user-d@smoke.test' and u[0]['billed_bytes'] == $USED_D, v['top_users']
" || { echo "FAIL: admin node traffic content"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/traffic/summary")" = "200" ] || { echo "FAIL: traffic summary"; exit 1; }
python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last'))
d = [x for x in v['days'] if x['day'] == '$TODAY_SITE']
assert d and d[0]['billed_bytes'] >= $USED_D, v
assert any(n['node_id'] == '$NODE_ID' for n in v['top_nodes']), v
" || { echo "FAIL: traffic summary content"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/traffic/summary?from=2026-13-01")" = "400" ] || { echo "FAIL: bad date accepted"; exit 1; }
echo "traffic history: ok (D billed $USED_D on $TODAY_SITE)"

echo "== W29: block rules (审计规则): API, per-node switch, agent routing + counters =="
# Panel side (any agent): built-ins, a custom rule, validation, admins only,
# and the switch neither bumps the node nor pushes a configuration.
[ "$(code -b "$JAR" "$BASE/api/v1/block-rules")" = "200" ] \
  && [ "$(last_json "[(r['builtin_key'], r['enabled']) for r in d['rules']]")" = "[('bittorrent', True), ('bt_tracker', True), ('xunlei_pt', False)]" ] \
  || { echo "FAIL: built-in block rules"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/block-rules" -H 'Content-Type: application/json' \
    -d '{"kind":"domain","name":"smoke","pattern":"full:LOCALHOST"}')" = "201" ] || { echo "FAIL: create block rule"; cat /tmp/akari-smoke/last; exit 1; }
W29_RULE=$(last_json "d['id']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/block-rules" -H 'Content-Type: application/json' \
    -d '{"kind":"ip","name":"bad","pattern":"10.0.0.0/33"}')" = "400" ] && [ "$(last_json "d['code']")" = "block_rule.entry_invalid" ] \
  || { echo "FAIL: bad block rule accepted"; exit 1; }
[ "$(code -b "$DJAR" "$BASE/api/v1/block-rules")" = "403" ] || { echo "FAIL: user lists block rules"; exit 1; }
[ "$(code "$BASE/api/v1/nodes/$NODE_ID/block-rules")" = "401" ] || { echo "FAIL: anonymous reads node block rules"; exit 1; }
W29_V0=$(psql_q "SELECT config_version || ' ' || user_version FROM servers WHERE id='$SERVER_ID'")
W29_SNAPS0=$(grep -c '"via":"snapshot"' "$LOG/agent.log" || true)
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/block-rules" -H 'Content-Type: application/json' \
    -d '{"enabled":true}')" = "200" ] && [ "$(last_json "d['changed']")" = "True" ] || { echo "FAIL: block rules switch"; exit 1; }
[ "$(psql_q "SELECT config_version || ' ' || user_version FROM servers WHERE id='$SERVER_ID'")" = "$W29_V0" ] \
  || { echo "FAIL: the block rules switch bumped the node"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='node.block_rules.set' AND target_id='$NODE_ID'")" = "1" ] \
  && [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='block_rule.create' AND target_id='$W29_RULE'")" = "1" ] \
  || { echo "FAIL: block rules audit"; exit 1; }
cat >"$LOG/w29-vless.py" <<'PY'
# VLESS to a local echo server, addressed by name (localhost) or by IP
# (argv 2), on the inbound at port argv 3 (default the direct one): prints "ok" on an echoed round trip, "blocked" when the node closes it.
import socket, struct, sys, threading, uuid
echo = socket.socket(); echo.bind(("127.0.0.1", 0)); echo.listen(1)
def serve():
    c, _ = echo.accept()
    for d in iter(lambda: c.recv(65536), b""): c.sendall(d)
threading.Thread(target=serve, daemon=True).start()
port = struct.pack(">H", echo.getsockname()[1])
addr = b"\x02\x09localhost" if sys.argv[2] == "name" else b"\x01" + socket.inet_aton("127.0.0.1")
s = socket.create_connection(("127.0.0.1", int(sys.argv[3]) if len(sys.argv) > 3 else 11443), timeout=10)
s.sendall(b"\x00" + uuid.UUID(sys.argv[1]).bytes + b"\x00\x01" + port + addr + b"w29-probe")
got = b""
try:
    while len(got) < 2 + 9:
        d = s.recv(65536)
        if not d: break
        got += d
except OSError:
    pass
print("ok" if got.endswith(b"w29-probe") else "blocked")
PY
w29_view() { code -b "$JAR" "$BASE/api/v1/nodes/$NODE_ID/block-rules" >/dev/null; }
if need_agent cap:block-rules "W29 block rules on the agent"; then
  for _ in $(seq 1 40); do w29_view; [ "$(last_json "d['in_sync']")" = "True" ] && break; sleep 1; done
  [ "$(last_json "d['in_sync'] and d['agent_supported'] and d['error'] is None")" = "True" ] \
    || { echo "FAIL: agent did not apply the block policy"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(python3 "$LOG/w29-vless.py" "$VLESS_D" name)" = "blocked" ] || { echo "FAIL: blocked domain reached its target"; exit 1; }
  [ "$(python3 "$LOG/w29-vless.py" "$VLESS_D" ip)" = "ok" ] || { echo "FAIL: unblocked destination failed"; exit 1; }
  # The hit reaches the daily counters (heartbeat every 15 s).
  for _ in $(seq 1 45); do
    w29_view; [ "$(last_json "sum(x['hits'] for x in d['days'] if x['rule_id'] == $W29_RULE)")" -ge 1 ] && break; sleep 1
  done
  [ "$(last_json "sum(x['hits'] for x in d['days'] if x['rule_id'] == $W29_RULE)")" -ge 1 ] \
    || { echo "FAIL: block counter did not increment"; cat /tmp/akari-smoke/last; exit 1; }
  # Changing the rule content swaps the routing live: no Snapshot, no rebuild.
  w29_view; W29_POLICY=$(last_json "d['policy_version']")
  [ "$(patch_code "$BASE/api/v1/block-rules/$W29_RULE" '{"pattern":"full:blocked.invalid"}')" = "204" ] || { echo "FAIL: edit block rule"; exit 1; }
  for _ in $(seq 1 40); do
    w29_view; [ "$(last_json "d['in_sync'] and d['policy_version'] != '$W29_POLICY'")" = "True" ] && break; sleep 1
  done
  [ "$(python3 "$LOG/w29-vless.py" "$VLESS_D" name)" = "ok" ] || { echo "FAIL: edited rule still blocks"; exit 1; }
  [ "$(grep -c '"via":"snapshot"' "$LOG/agent.log" || true)" = "$W29_SNAPS0" ] \
    || { echo "FAIL: block rule changes caused a Snapshot"; exit 1; }
  echo "block rules: ok (blocked by name, counted, edited live without a rebuild)"
fi
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/block-rules" -H 'Content-Type: application/json' \
    -d '{"enabled":false}')" = "200" ] || { echo "FAIL: block rules switch off"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/block-rules/$W29_RULE")" = "204" ] || { echo "FAIL: delete block rule"; exit 1; }
[ "$(psql_q "SELECT config_version || ' ' || user_version FROM servers WHERE id='$SERVER_ID'")" = "$W29_V0" ] \
  || { echo "FAIL: block rules bumped the node"; exit 1; }

echo "== W28-a: relay entrance (derived inbound, own credentials, per-entrance billing, removal isolation) =="
# A relay entrance of the node: its derived inbound listens on 11446 (the
# relay would forward there; here the client dials it directly from the
# allowed 127.0.0.1), with its own credential per user, billed at its own
# multiplier; the access plan grants it through a second group.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/node-groups" -H 'Content-Type: application/json' -d '{"name":"smoke-relay"}')" = "201" ] \
  || { echo "FAIL: create relay group"; exit 1; }
RELAY_GROUP=$(last_json "d['id']")
RELAY_BODY="{\"name\":\"IPLC\",\"connect_host\":\"127.0.0.1\",\"connect_port\":11446,\"listen_port\":11446,\"source_cidrs\":[\"127.0.0.1\"],\"rate\":2,\"group_ids\":[\"$RELAY_GROUP\"]}"
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes/$NODE_ID/entrances" -H 'Content-Type: application/json' -d "$RELAY_BODY")" = "201" ] \
  && last_json "(d['kind'], d['wire_no'], d['source_cidrs'])" | matches -Fx "('relay', 1, ['127.0.0.1/32'])" \
  || { echo "FAIL: create relay entrance"; cat /tmp/akari-smoke/last; exit 1; }
RELAY_ID=$(last_json "d['id']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes/$NODE_ID/entrances" -H 'Content-Type: application/json' \
    -d "$(echo "$RELAY_BODY" | sed 's/"IPLC"/"dup"/')")" = "400" ] && last_json "d['code']" | matches -x 'entrance.port_clash' \
  || { echo "FAIL: a relay on a taken port accepted"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/entrances/$DIRECT_ID")" = "409" ] || { echo "FAIL: direct entrance deletable"; exit 1; }
# 中-5: a plan edit changes new purchases unless applied to the existing
# subscribers (after the impact preview).
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/plans/$ACCESS_PLAN/impact" -H 'Content-Type: application/json' -d '{"traffic_quota_bytes": 1}')" = "200" ] \
  && [ "$(last_json "d['subscribers'] >= 1 and 0 <= d['over_quota'] <= d['subscribers']")" = "True" ] \
  || { echo "FAIL: plan impact preview"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(patch_code "$BASE/api/v1/plans/$ACCESS_PLAN" "{\"group_ids\":[\"$ACCESS_GROUP\",\"$RELAY_GROUP\"],\"apply_to_existing\":true}")" = "200" ] \
  || { echo "FAIL: access plan gains the relay group"; cat /tmp/akari-smoke/last; exit 1; }
relay_account() { psql_q "SELECT account->>'id' FROM entrance_users WHERE user_id='$1' AND entrance_id='$RELAY_ID'"; }
VLESS_DR=$(relay_account "$USER_D")
[ -n "$VLESS_DR" ] && [ "$VLESS_DR" != "$VLESS_D" ] || { echo "FAIL: no independent relay credential for D"; exit 1; }
for _ in $(seq 1 20); do (exec 3<>/dev/tcp/127.0.0.1/11446) 2>/dev/null && break; sleep 0.5; done
(exec 3<>/dev/tcp/127.0.0.1/11446) 2>/dev/null || { echo "FAIL: derived inbound not listening"; tail -5 "$LOG/agent.log"; exit 1; }
# The subscription lists the relay as its own proxy (next07: no multiplier in the name).
curl -s --noproxy '*' -A 'clash.meta' "$SUBBASE/$SUB_D" >"$LOG/relay-sub.yaml"
grep -q '"冒烟 01 | IPLC | 0.5x IPLC"' "$LOG/relay-sub.yaml" && grep -q 'port: 11446' "$LOG/relay-sub.yaml" \
  || { echo "FAIL: relay not in the subscription"; cat "$LOG/relay-sub.yaml"; exit 1; }
# The W11 client with a port and an attempt count (argv 2, 3).
sed -e 's/("127.0.0.1", 11443)/("127.0.0.1", int(sys.argv[2]))/' \
  -e 's/for attempt in range(40):/for attempt in range(int(sys.argv[3]) if len(sys.argv) > 3 else 40):/' \
  "$LOG/w11-vless.py" >"$LOG/w28-vless.py"
refused() { # credential port: the inbound refuses it (within 20 s)
  for _ in $(seq 1 20); do
    python3 "$LOG/w28-vless.py" "$1" "$2" 1 >/dev/null 2>&1 || return 0
    sleep 1
  done
  return 1
}
relay_raw() { psql_q "SELECT coalesce(sum(up_bytes + down_bytes), 0) FROM traffic_counters WHERE entrance_id='$RELAY_ID' AND user_id='$USER_D'"; }
# One snapshot of D's ledger: the relay's raw counters, D's usage, and the
# billed history per entrance (pending + compacted + rolled up: the flush
# writes the history in the same statement that bills the user, so the
# sums are exact). Traffic of earlier steps (e.g. the W29 probes on the
# direct entrance) may still land in this window: it is billed to the
# direct entrance and must not be confused with the relay's bill.
relay_ledger() {
  psql_q "WITH h AS (
      SELECT entrance_id, billed_bytes FROM traffic_daily_pending WHERE user_id='$USER_D'
      UNION ALL SELECT entrance_id, billed_bytes FROM traffic_daily WHERE user_id='$USER_D'
      UNION ALL SELECT entrance_id, billed_bytes FROM traffic_monthly WHERE user_id='$USER_D')
    SELECT (SELECT coalesce(sum(up_bytes + down_bytes), 0) FROM traffic_counters WHERE entrance_id='$RELAY_ID' AND user_id='$USER_D') || ' ' ||
      (SELECT coalesce(sum(up_bytes + down_bytes), 0) FROM traffic_counters WHERE entrance_id='$DIRECT_ID' AND user_id='$USER_D') || ' ' ||
      (SELECT traffic_used_bytes FROM users WHERE id='$USER_D') || ' ' ||
      (SELECT coalesce(sum(billed_bytes), 0) FROM h WHERE entrance_id='$RELAY_ID') || ' ' ||
      (SELECT coalesce(sum(billed_bytes), 0) FROM h)"
}
LEDGER_BEFORE=$(relay_ledger)
python3 "$LOG/w28-vless.py" "$VLESS_DR" 11446 || { echo "FAIL: vless round trip through the relay entrance"; exit 1; }
for _ in $(seq 1 40); do [ "$(relay_raw)" -ge 600000 ] && break; sleep 1; done
LEDGER_AFTER=$(relay_ledger)
RELAY_RAW=${LEDGER_AFTER%% *}
python3 -c "
(raw0, direct0, used0, relay0, all0), (raw, direct, used, relay, all1) = [map(int, l.split()) for l in ('$LEDGER_BEFORE', '$LEDGER_AFTER')]
assert raw0 == 0 and relay0 == 0 and raw >= 600000, (raw0, relay0, raw)
assert direct - direct0 < 1000, ('the relay traffic is not counted on the direct entrance', direct0, direct)
assert relay == 2 * raw, ('the relay entrance bills exactly 2x its own raw bytes', raw, relay)
assert used - used0 == all1 - all0, ('usage grows by exactly the billed history', used0, used, all0, all1)
" || { echo "FAIL: relay billing (relay raw/direct raw/used/relay billed/all billed: $LEDGER_BEFORE -> $LEDGER_AFTER)"; exit 1; }
# Credentials are per entrance: D's direct credential does not open the relay.
python3 "$LOG/w28-vless.py" "$VLESS_D" 11446 3 >/dev/null 2>&1 && { echo "FAIL: the direct credential works on the relay inbound"; exit 1; }
# Source filter: enforced in the kernel by agents with the capability;
# others are flagged on the node (credential isolation only).
SF_REQ="$LOG/state-main/update/source-filter-request.json"
SF_ROOT=""
sf_status() { vk get "akari:server:hb:$SERVER_ID" | python3 -c "import json,sys; print(json.load(sys.stdin).get('source_filter'))"; }
# R44: the agent has no CAP_NET_ADMIN; it hands the allowlist to its root
# updater (akari-agent-update), played here once per request with sudo.
sf_updater() {
  # The log is ours (the redirect is meant to run unprivileged).
  # shellcheck disable=SC2024
  sudo -n "$AGENT" -apply-update "$LOG/state-main" -updater-state "$SF_ROOT/state" >>"$LOG/sf-updater.log" 2>&1 \
    || { echo "FAIL: the root updater run"; tail -5 "$LOG/sf-updater.log"; exit 1; }
}
if need_agent cap:source-filter "W28-a relay source filter"; then
  for _ in $(seq 1 20); do [ -s "$SF_REQ" ] && break; sleep 0.5; done
  python3 - "$SF_REQ" <<'PY' || { echo "FAIL: source filter request"; cat "$SF_REQ"; exit 1; }
import json, sys
r = json.load(open(sys.argv[1]))
assert r["schema"] == 1 and [(f["port"], f["cidrs"]) for f in r["filters"]] == [(11446, ["127.0.0.1/32"])], r
PY
  for _ in $(seq 1 30); do vk get "akari:server:hb:$SERVER_ID" | matches '"source_filter":{"applied":' && break; sleep 1; done
  sf_status | matches -F "'error': 'pending: " || { echo "FAIL: no pending source filter status: $(sf_status)"; exit 1; }
  # Pending is not a node warning (the updater answers within seconds).
  [ "$(code -b "$JAR" "$BASE/api/v1/nodes/$NODE_ID")" = "200" ] && ! matches -F '来源 IP 过滤' </tmp/akari-smoke/last \
    || { echo "FAIL: node flagged while the allowlist is pending"; exit 1; }
  if sudo -n true 2>/dev/null && sudo -n sh -c 'command -v nft' >/dev/null 2>&1; then
    SF_ROOT=$(mktemp -d)
    sf_updater
    [ ! -e "$SF_REQ" ] || { echo "FAIL: request not consumed"; exit 1; }
    sudo -n nft list table inet akari_sources | matches -F 'tcp dport 11446 ct state new ip saddr != @s0_4 drop' \
      || { echo "FAIL: nft table"; sudo -n nft list table inet akari_sources; exit 1; }
    for _ in $(seq 1 20); do sf_status | matches -Fx "{'applied': True, 'error': None}" && break; sleep 1; done
    sf_status | matches -Fx "{'applied': True, 'error': None}" || { echo "FAIL: source filter status $(sf_status)"; exit 1; }
    # The kernel drops a new connection from outside the allowlist; the
    # relay's address still gets through.
    python3 - <<'PY' || { echo "FAIL: the allowlist does not drop other sources"; exit 1; }
import socket
s = socket.socket(); s.settimeout(2); s.bind(("127.0.0.3", 0))
try:
    s.connect(("127.0.0.1", 11446)); raise SystemExit("connected from 127.0.0.3")
except socket.timeout:
    pass
PY
    python3 "$LOG/w28-vless.py" "$VLESS_DR" 11446 || { echo "FAIL: the relay's address is filtered"; exit 1; }
    echo "source filter: applied by the root updater (nft), other sources dropped"
  else
    [ -n "${GITHUB_ACTIONS:-}" ] && { echo "FAIL: CI runner without passwordless sudo + nft"; exit 1; }
    echo "NOTE: no passwordless sudo/nft here: the root updater's nft step is akari-agent's systemd/openrc tests"
  fi
else
  [ "$(code -b "$JAR" "$BASE/api/v1/nodes/$NODE_ID")" = "200" ] && matches -F '来源 IP 过滤' </tmp/akari-smoke/last \
    || { echo "FAIL: node not flagged for the missing source filter"; exit 1; }
fi
# W29 on the relay: the block rules cover the relay's derived inbound like
# the direct one — also with the direct entrance disabled (regression: the
# policy listed direct entrances only, so a relay bypassed every rule).
if need_agent cap:block-rules "W29 block rules on a relay entrance"; then
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/block-rules" -H 'Content-Type: application/json' \
      -d '{"kind":"domain","name":"smoke-relay","pattern":"full:localhost"}')" = "201" ] \
    || { echo "FAIL: create the relay block rule"; cat /tmp/akari-smoke/last; exit 1; }
  W29R_RULE=$(last_json "d['id']")
  [ "$(entrance_patch '{"enabled":false}')" = "200" ] || { echo "FAIL: disable the direct entrance"; exit 1; }
  refused "$VLESS_D" 11443 || { echo "FAIL: the disabled direct entrance still serves"; exit 1; }
  [ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/block-rules" -H 'Content-Type: application/json' \
      -d '{"enabled":true}')" = "200" ] || { echo "FAIL: block rules switch on (relay)"; exit 1; }
  for _ in $(seq 1 40); do w29_view; [ "$(last_json "d['in_sync']")" = "True" ] && break; sleep 1; done
  [ "$(last_json "d['in_sync'] and d['error'] is None")" = "True" ] \
    || { echo "FAIL: agent did not apply the relay block policy"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(python3 "$LOG/w29-vless.py" "$VLESS_DR" name 11446)" = "blocked" ] || { echo "FAIL: blocked domain reached through the relay"; exit 1; }
  [ "$(python3 "$LOG/w29-vless.py" "$VLESS_DR" ip 11446)" = "ok" ] || { echo "FAIL: unblocked destination failed through the relay"; exit 1; }
  for _ in $(seq 1 45); do
    w29_view; [ "$(last_json "sum(x['hits'] for x in d['days'] if x['rule_id'] == $W29R_RULE)")" -ge 1 ] && break; sleep 1
  done
  [ "$(last_json "sum(x['hits'] for x in d['days'] if x['rule_id'] == $W29R_RULE)")" -ge 1 ] \
    || { echo "FAIL: relay block not counted"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(code -b "$JAR" -X PUT "$BASE/api/v1/nodes/$NODE_ID/block-rules" -H 'Content-Type: application/json' \
      -d '{"enabled":false}')" = "200" ] || { echo "FAIL: block rules switch off (relay)"; exit 1; }
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/block-rules/$W29R_RULE")" = "204" ] || { echo "FAIL: delete the relay block rule"; exit 1; }
  [ "$(entrance_patch '{"enabled":true}')" = "200" ] || { echo "FAIL: enable the direct entrance"; exit 1; }
  python3 "$LOG/w28-vless.py" "$VLESS_D" 11443 || { echo "FAIL: the direct entrance did not come back"; exit 1; }
  echo "block rules on the relay: ok (direct disabled, blocked by name through the relay, counted)"
fi
# Health: the panel TCP-tests the relay's address; an unreachable relay is
# hidden from the subscription after 3 failures and the node's
# entrance_down alert fires; once it answers again both come back.
for _ in $(seq 1 20); do [ "$(psql_q "SELECT health_ok FROM entrances WHERE id='$RELAY_ID'")" = "t" ] && break; sleep 1; done
[ "$(psql_q "SELECT health_ok FROM entrances WHERE id='$RELAY_ID'")" = "t" ] || { echo "FAIL: relay health never tested ok"; exit 1; }
[ "$(patch_code "$BASE/api/v1/entrances/$RELAY_ID" '{"connect_port":1}')" = "200" ] || { echo "FAIL: relay to a dead port"; exit 1; }
for _ in $(seq 1 30); do [ "$(psql_q "SELECT hidden_since IS NOT NULL FROM entrances WHERE id='$RELAY_ID'")" = "t" ] && break; sleep 1; done
[ "$(psql_q "SELECT health_failures >= 3 AND hidden_since IS NOT NULL FROM entrances WHERE id='$RELAY_ID'")" = "t" ] \
  || { echo "FAIL: unreachable relay not hidden"; psql_q "SELECT health_ok, health_failures, health_error FROM entrances WHERE id='$RELAY_ID'"; exit 1; }
rl_sub_clear() { vk EVAL "for _,k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1" 0 'akari:rl:sub:*' >/dev/null; }
rl_sub_clear
curl -s --noproxy '*' -A 'clash.meta' "$SUBBASE/$SUB_D" | matches -F '0.5x IPLC"' && { echo "FAIL: hidden relay still in the subscription"; exit 1; }
for _ in $(seq 1 20); do [ "$(psql_q "SELECT count(*) FROM server_alerts WHERE server_id='$SERVER_ID' AND kind='entrance_down' AND status='firing'")" = "1" ] && break; sleep 1; done
[ "$(psql_q "SELECT count(*) FROM server_alerts WHERE server_id='$SERVER_ID' AND kind='entrance_down' AND status='firing'")" = "1" ] \
  || { echo "FAIL: no entrance_down alert"; exit 1; }
[ "$(patch_code "$BASE/api/v1/entrances/$RELAY_ID" '{"connect_port":11446}')" = "200" ] || { echo "FAIL: relay port back"; exit 1; }
for _ in $(seq 1 20); do [ "$(psql_q "SELECT hidden_since IS NULL FROM entrances WHERE id='$RELAY_ID'")" = "t" ] && break; sleep 1; done
[ "$(psql_q "SELECT health_ok AND hidden_since IS NULL FROM entrances WHERE id='$RELAY_ID'")" = "t" ] || { echo "FAIL: relay not restored"; exit 1; }
rl_sub_clear
curl -s --noproxy '*' -A 'clash.meta' "$SUBBASE/$SUB_D" | matches -F '0.5x IPLC"' || { echo "FAIL: restored relay not in the subscription"; exit 1; }
for _ in $(seq 1 20); do [ "$(psql_q "SELECT count(*) FROM server_alerts WHERE server_id='$SERVER_ID' AND kind='entrance_down' AND status='resolved'")" = "1" ] && break; sleep 1; done
[ "$(psql_q "SELECT count(*) FROM server_alerts WHERE server_id='$SERVER_ID' AND kind='entrance_down' AND status='resolved'")" = "1" ] \
  || { echo "FAIL: entrance_down not resolved"; exit 1; }
echo "relay health: hidden after 3 failures, alert fired, restored and resolved"
# Removal isolation: the relay leaves the plan's groups; D keeps the direct
# entrance (and its credential), loses the relay at once.
[ "$(patch_code "$BASE/api/v1/entrances/$RELAY_ID" '{"group_ids":[]}')" = "200" ] || { echo "FAIL: relay leaves its group"; exit 1; }
[ -z "$(relay_account "$USER_D")" ] && [ "$(account_of "$USER_D")" = "$VLESS_D" ] \
  || { echo "FAIL: removal from the relay touched the direct entrance"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM entrance_users_departed WHERE user_id='$USER_D' AND entrance_id='$RELAY_ID'")" = "1" ] \
  || { echo "FAIL: no departed row for the relay"; exit 1; }
refused "$VLESS_DR" 11446 || { echo "FAIL: a removed relay credential still works"; exit 1; }
python3 "$LOG/w28-vless.py" "$VLESS_D" 11443 || { echo "FAIL: the direct entrance stopped working"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/entrances/$RELAY_ID")" = "204" ] || { echo "FAIL: delete relay"; exit 1; }
if [ -n "$SF_ROOT" ]; then
  # No relays left: the agent asks for the table's removal.
  sf_empty() { python3 -c "import json,sys; sys.exit(json.load(open(sys.argv[1]))['filters'] != [])" "$SF_REQ" 2>/dev/null; }
  for _ in $(seq 1 20); do sf_empty && break; sleep 0.5; done
  sf_empty || { echo "FAIL: no removal request"; exit 1; }
  sf_updater
  sudo -n nft list table inet akari_sources >/dev/null 2>&1 && { echo "FAIL: allowlist table not removed"; exit 1; }
  for _ in $(seq 1 20); do [ "$(sf_status)" = None ] && break; sleep 1; done
  [ "$(sf_status)" = None ] || { echo "FAIL: source filter status after removal: $(sf_status)"; exit 1; }
  sudo -n rm -rf "$SF_ROOT"
fi
[ "$(patch_code "$BASE/api/v1/plans/$ACCESS_PLAN" "{\"group_ids\":[\"$ACCESS_GROUP\"],\"apply_to_existing\":true}")" = "200" ] || { echo "FAIL: restore access plan"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/node-groups/$RELAY_GROUP")" = "204" ] || { echo "FAIL: delete relay group"; exit 1; }
# create; update x3 (dead port, port back, leaves its group); delete.
RELAY_AUDIT=$(psql_q "SELECT string_agg(action || '=' || n, ',' ORDER BY action) FROM (SELECT action, count(*) n FROM audit_log
  WHERE target_id='$RELAY_ID' AND action IN ('entrance.create','entrance.update','entrance.delete') GROUP BY action) a")
[ "$RELAY_AUDIT" = "entrance.create=1,entrance.delete=1,entrance.update=3" ] \
  || { echo "FAIL: relay entrance not audited: $RELAY_AUDIT"; exit 1; }
echo "relay entrance: ok (relay raw $RELAY_RAW billed at 2x, removal isolated)"

echo "== Q1: a second node on the same server (one agent, two inbounds) =="
# Agents before protocol 7 key a second node's users like relays (limits
# per entrance): the panel serves them, the section needs protocol 7.
if need_agent "protocol>=7" "Q1 two nodes on one server"; then
  Q1_IB='{"listen":"127.0.0.1","port":11447,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp"}}'
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' \
      -d "{\"server_id\":\"$SERVER_ID\",\"name\":\"test-node-b\",\"inbound\":$GOOD_IB}")" = "400" ] \
    && [ "$(last_json "d['code']")" = "entrance.port_clash" ] || { echo "FAIL: a second node on the first node's port"; exit 1; }
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' \
      -d "{\"server_id\":\"$SERVER_ID\",\"name\":\"test-node-b\",\"inbound\":$Q1_IB}")" = "201" ] \
    || { echo "FAIL: second node on the server"; cat /tmp/akari-smoke/last; exit 1; }
  NODE_B=$(last_json "d['id']")
  [ "$(code -b "$JAR" "$BASE/api/v1/nodes/$NODE_B")" = "200" ] || { echo "FAIL: GET node B"; exit 1; }
  DIRECT_B=$(last_json "[e['id'] for e in d['entrances'] if e['kind'] == 'direct'][0]")
  [ "$(last_json "[e['wire_no'] for e in d['entrances']]")" != "[0]" ] || { echo "FAIL: node B reuses entrance number 0"; exit 1; }
  [ "$(code -b "$JAR" "$BASE/api/v1/servers/$SERVER_ID")" = "200" ] \
    && [ "$(last_json "sorted(n['name'] for n in d['nodes'])")" = "['test-node', 'test-node-b']" ] \
    || { echo "FAIL: the server does not list both nodes"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(patch_code "$BASE/api/v1/entrances/$DIRECT_B" "{\"group_ids\":[\"$ACCESS_GROUP\"]}")" = "200" ] \
    || { echo "FAIL: node B joins the access group"; exit 1; }
  VLESS_DB=$(psql_q "SELECT account->>'id' FROM entrance_users WHERE user_id='$USER_D' AND entrance_id='$DIRECT_B'")
  [ -n "$VLESS_DB" ] && [ "$VLESS_DB" != "$VLESS_D" ] || { echo "FAIL: no own credential for D on node B"; exit 1; }
  for _ in $(seq 1 20); do (exec 3<>/dev/tcp/127.0.0.1/11447) 2>/dev/null && break; sleep 0.5; done
  python3 "$LOG/w28-vless.py" "$VLESS_DB" 11447 || { echo "FAIL: vless round trip on node B"; tail -5 "$LOG/agent.log"; exit 1; }
  python3 "$LOG/w28-vless.py" "$VLESS_D" 11447 3 >/dev/null 2>&1 && { echo "FAIL: node A's credential works on node B"; exit 1; }
  python3 "$LOG/w28-vless.py" "$VLESS_D" 11443 || { echo "FAIL: node A stopped working"; exit 1; }
  for _ in $(seq 1 30); do [ "$(psql_q "SELECT traffic_raw_bytes FROM nodes WHERE id='$NODE_B'")" -ge 200000 ] && break; sleep 1; done
  [ "$(psql_q "SELECT traffic_raw_bytes FROM nodes WHERE id='$NODE_B'")" -ge 200000 ] \
    && [ "$(psql_q "SELECT string_agg(DISTINCT server_id::text, ',') FROM traffic_counters WHERE entrance_id='$DIRECT_B'")" = "$SERVER_ID" ] \
    || { echo "FAIL: node B's traffic not billed to node B under its server"; exit 1; }
  # Deleting the node keeps the server (and node A) running.
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/nodes/$NODE_B")" = "204" ] || { echo "FAIL: delete node B"; exit 1; }
  for _ in $(seq 1 20); do (exec 3<>/dev/tcp/127.0.0.1/11447) 2>/dev/null || break; sleep 0.5; done
  (exec 3<>/dev/tcp/127.0.0.1/11447) 2>/dev/null && { echo "FAIL: node B's inbound still listening"; exit 1; }
  python3 "$LOG/w28-vless.py" "$VLESS_D" 11443 || { echo "FAIL: node A stopped after node B's deletion"; exit 1; }
  [ "$(psql_q "SELECT count(*) FROM servers WHERE id='$SERVER_ID' AND deleting_at IS NULL")" = "1" ] || { echo "FAIL: the server went with its node"; exit 1; }
  echo "q1 two nodes on one server: ok"
fi

echo "== D9: time-window multipliers =="
RULES='{"rules":[{"weekdays":[1,2,3,4,5,6,7],"start":"00:00","end":"24:00","rate":3},{"weekdays":[1],"start":"08:00","end":"09:00","rate":1.5}]}'
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/entrances/$DIRECT_ID/rate-rules" -H 'Content-Type: application/json' -d "$RULES")" = "200" ] \
  && [ "$(last_json "d['entrance']['rate_now'], len(d['entrance']['rate_rules']), len(d['warnings'])")" = "3.0 2 1" ] \
  || { echo "FAIL: set rate rules"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/entrances/$DIRECT_ID/rate-rules" -H 'Content-Type: application/json' \
    -d '{"rules":[{"weekdays":[8],"start":"00:00","end":"24:00","rate":1}]}')" = "400" ] \
  && [ "$(last_json "d['code']")" = "entrance.rate_rule_invalid" ] || { echo "FAIL: bad weekday accepted"; exit 1; }
rl_sub_clear
curl -s --noproxy '*' -A 'clash.meta' "$SUBBASE/$SUB_D" | matches '3\.0x' && { echo "FAIL: subscription name carries the rule's multiplier (names must stay stable)"; exit 1; }
[ "$(psql_q "SELECT akari_entrance_rate('$DIRECT_ID', now())")" = "3000" ] || { echo "FAIL: SQL rate"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/entrances/$DIRECT_ID/rate-rules" -H 'Content-Type: application/json' -d '{"rules":[]}')" = "200" ] \
  && [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='entrance.rate_rules.set' AND target_id='$DIRECT_ID'")" = "2" ] \
  || { echo "FAIL: clear rate rules / audit"; exit 1; }
echo "d9 time-window multipliers: ok"

echo "== D5: server traffic quota from the network interface =="
if need_agent cap:metrics "D5 server traffic quota"; then
  [ "$(patch_code "$BASE/api/v1/servers/$SERVER_ID" '{"traffic_quota_bytes":0}')" = "400" ] \
    && [ "$(last_json "d['code']")" = "server.quota_invalid" ] || { echo "FAIL: zero quota accepted"; exit 1; }
  # 1 byte, both directions, monthly on the 1st: the next heartbeats use it up.
  [ "$(patch_code "$BASE/api/v1/servers/$SERVER_ID" '{"traffic_quota_bytes":1,"traffic_quota_mode":"both","traffic_quota_reset_day":1}')" = "200" ] \
    && [ "$(last_json "d['traffic_quota']['bytes'], d['traffic_quota']['reset_day']")" = "1 1" ] \
    || { echo "FAIL: set the quota"; cat /tmp/akari-smoke/last; exit 1; }
  # Some bytes on the default-route interface (an idle runner may move none).
  for _ in $(seq 1 90); do
    [ "$(psql_q "SELECT traffic_quota_exceeded_at IS NOT NULL FROM servers WHERE id='$SERVER_ID'")" = "t" ] && break
    curl -s -m 3 -o /dev/null https://github.com/ 2>/dev/null || true
    sleep 1
  done
  [ "$(psql_q "SELECT traffic_quota_exceeded_at IS NOT NULL AND traffic_quota_rx_bytes + traffic_quota_tx_bytes > 0 FROM servers WHERE id='$SERVER_ID'")" = "t" ] \
    || { echo "FAIL: quota never ran out: $(psql_q "SELECT nic_name, nic_rx_last, traffic_quota_rx_bytes FROM servers WHERE id='$SERVER_ID'")"; exit 1; }
  # Every node of the server stops (the empty state); enabled stays as it was.
  for _ in $(seq 1 20); do (exec 3<>/dev/tcp/127.0.0.1/11443) 2>/dev/null || break; sleep 0.5; done
  (exec 3<>/dev/tcp/127.0.0.1/11443) 2>/dev/null && { echo "FAIL: the inbound still listens over the quota"; exit 1; }
  [ "$(psql_q "SELECT enabled FROM nodes WHERE id='$NODE_ID'")" = "t" ] || { echo "FAIL: the quota touched nodes.enabled"; exit 1; }
  [ "$(code -b "$JAR" "$BASE/api/v1/servers/$SERVER_ID")" = "200" ] && matches -F '流量额度已用完' </tmp/akari-smoke/last \
    || { echo "FAIL: no quota warning on the server"; exit 1; }
  for _ in $(seq 1 45); do [ "$(psql_q "SELECT count(*) FROM server_alerts WHERE server_id='$SERVER_ID' AND kind='traffic_quota' AND status='firing'")" = "1" ] && break; sleep 1; done
  [ "$(psql_q "SELECT count(*) FROM server_alerts WHERE server_id='$SERVER_ID' AND kind='traffic_quota' AND status='firing'")" = "1" ] \
    || { echo "FAIL: no traffic_quota alert"; exit 1; }
  # Removing the quota restores at once.
  [ "$(patch_code "$BASE/api/v1/servers/$SERVER_ID" '{"traffic_quota_bytes":null,"traffic_quota_reset_day":null}')" = "200" ] || { echo "FAIL: remove the quota"; exit 1; }
  for _ in $(seq 1 20); do (exec 3<>/dev/tcp/127.0.0.1/11443) 2>/dev/null && break; sleep 0.5; done
  python3 "$LOG/w28-vless.py" "$VLESS_D" 11443 || { echo "FAIL: not restored after the quota was removed"; exit 1; }
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='server.update' AND target_id='$SERVER_ID'")" -ge 2 ] || { echo "FAIL: quota changes not audited"; exit 1; }
  echo "d5 server traffic quota: ok"
fi

if need_agent cap:metrics "W11 machine status"; then
  # Machine status: the heartbeat blob carries metrics; history and
  # Prometheus fleet gauges follow.
  for _ in $(seq 1 30); do
    vk get "akari:server:hb:$SERVER_ID" | matches '"online_users"' && break; sleep 1
  done
  vk get "akari:server:hb:$SERVER_ID" | matches '"xray_version"' || { echo "FAIL: heartbeat lacks machine status"; vk get "akari:server:hb:$SERVER_ID"; exit 1; }
  [ "$(code -b "$JAR" "$BASE/api/v1/servers/$SERVER_ID/status")" = "200" ] || { echo "FAIL: node status API"; exit 1; }
  python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last')); m = v['heartbeat']['metrics']
assert v['online'] is True and v['heartbeat']['mem_total_bytes'] > 0, v
assert m['cpu_count'] >= 1 and m['disk_total_bytes'] > 0 and m['xray_version'], m
" || { echo "FAIL: node status content"; cat /tmp/akari-smoke/last; exit 1; }
  for _ in $(seq 1 15); do [ "$(psql_q "SELECT count(*) FROM server_metrics_1m WHERE server_id='$SERVER_ID'")" -ge 1 ] && break; sleep 1; done
  [ "$(code -b "$JAR" "$BASE/api/v1/servers/$SERVER_ID/metrics?range=1h")" = "200" ] || { echo "FAIL: metrics API"; exit 1; }
  python3 -c "import json; v = json.load(open('/tmp/akari-smoke/last')); assert v['points'] and v['points'][0]['mem_total'] > 0, v" \
    || { echo "FAIL: no metrics history"; cat /tmp/akari-smoke/last; exit 1; }
  # (to a file: `curl | matches` fails under pipefail when grep exits first)
  curl -s --noproxy '*' http://127.0.0.1:9109/metrics >"$LOG/w11-metrics.txt"
  grep -q '^akari_fleet{kind="nodes_reporting"} 1$' "$LOG/w11-metrics.txt" \
    || { echo "FAIL: fleet gauge"; grep akari_fleet "$LOG/w11-metrics.txt"; exit 1; }
  echo "machine status: ok"
fi
if need_agent cap:metrics-presence "W23 metrics presence (every value read, none unknown)"; then
  # An unsandboxed agent reads everything: no value is null (unknown), and
  # the first heartbeat's rates are the only ones that may be missing.
  for _ in $(seq 1 30); do
    code -b "$JAR" "$BASE/api/v1/servers/$SERVER_ID/status" >/dev/null
    python3 -c "import json,sys; m=json.load(open('/tmp/akari-smoke/last'))['heartbeat']['metrics']; sys.exit(m['net_rx_bytes_per_sec'] is None)" 2>/dev/null && break
    sleep 1
  done
  python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last')); hb = v['heartbeat']; m = hb['metrics']
nulls = [k for k in ('cpu_percent', 'mem_used_bytes', 'mem_total_bytes') if hb[k] is None]
nulls += [k for k, x in m.items() if x is None]
assert not nulls, nulls
" || { echo "FAIL: W23 unknown machine metrics from an unsandboxed agent"; cat /tmp/akari-smoke/last; exit 1; }
  echo "metrics presence: ok"
fi
if need_agent cap:latency "W11 latency test"; then
  # Latency: "立即测速" -> the agent tests the (local) URL from [probe], the
  # panel TCP-tests the inbound's connect address; a second request inside
  # the cooldown is refused.
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/servers/$SERVER_ID/probe")" = "202" ] || { echo "FAIL: probe request"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/servers/$SERVER_ID/probe")" = "429" ] || { echo "FAIL: probe cooldown"; exit 1; }
  for _ in $(seq 1 40); do
    [ "$(psql_q "SELECT count(*) FROM server_latency WHERE server_id='$SERVER_ID' AND source='agent' AND delay_ms IS NOT NULL AND target='http://127.0.0.1:18204/generate_204' AND measured_at > now() - interval '1 minute'")" = "1" ] \
      && [ "$(psql_q "SELECT count(*) FROM server_latency WHERE server_id='$SERVER_ID' AND source='panel' AND target='test-node / 直连' AND delay_ms IS NOT NULL")" = "1" ] && break
    sleep 1
  done
  [ "$(psql_q "SELECT count(*) FROM server_latency WHERE server_id='$SERVER_ID' AND source='agent' AND delay_ms IS NOT NULL")" -ge 1 ] \
    || { echo "FAIL: no agent latency result"; psql_q "SELECT * FROM server_latency"; grep latency "$LOG/agent.log" | tail -3; exit 1; }
  [ "$(psql_q "SELECT count(*) FROM server_latency WHERE server_id='$SERVER_ID' AND source='panel' AND delay_ms IS NOT NULL")" -ge 1 ] \
    || { echo "FAIL: no panel TCP latency"; psql_q "SELECT * FROM server_latency"; exit 1; }
  code -b "$DJAR" "$BASE/api/v1/me/nodes" >/dev/null
  python3 -c "import json; v = json.load(open('/tmp/akari-smoke/last')); assert v[0]['latency_status'] == 'ok' and v[0]['latency_ms'] >= 1, v" \
    || { echo "FAIL: portal latency"; cat /tmp/akari-smoke/last; exit 1; }
  echo "latency: ok ($(psql_q "SELECT source || ' ' || target || ' ' || delay_ms || 'ms' FROM server_latency WHERE server_id='$SERVER_ID' ORDER BY source" | tr '\n' ';'))"
fi
echo "-- W12: latency-test settings in 系统设置 (versioned, audited, reloaded on every instance) --"
put_probe() { code -b "$JAR" -X PUT "$BASE/api/v1/settings/probe" -H 'Content-Type: application/json' -d "$1"; }
[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings"; exit 1; }
SV=$(python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last')); p = v['probe']
assert p['urls']['source'] == 'settings' and p['urls']['effective'] == ['http://127.0.0.1:18204/generate_204'], p
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
    [ "$(code -b "$JAR" -X POST "$BASE/api/v1/servers/$SERVER_ID/probe")" = "202" ] && break; sleep 1
  done
  for _ in $(seq 1 30); do
    [ "$(psql_q "SELECT count(*) FROM server_latency WHERE server_id='$SERVER_ID' AND source='agent' AND delay_ms IS NOT NULL AND target='http://127.0.0.1:18204/generate_204?via=settings'")" = "1" ] && break
    sleep 1
  done
  [ "$(psql_q "SELECT count(*) FROM server_latency WHERE server_id='$SERVER_ID' AND source='agent' AND target='http://127.0.0.1:18204/generate_204?via=settings'")" = "1" ] \
    || { echo "FAIL: the agent did not test the URL from 系统设置"; psql_q "SELECT * FROM server_latency WHERE source='agent'"; exit 1; }
  echo "probe settings reached the agent: ok"
fi
# Back to the built-in defaults through the CLI (audited as cli; the
# running panel reloads through the notification).
"$PANEL" settings unset probe >"$LOG/unset-probe.out" || { echo "FAIL: settings unset probe"; cat "$LOG/unset-probe.out"; exit 1; }
"$PANEL" settings show >"$LOG/settings-show.out"
matches 'probe interval: *18000s \[Default\]' <"$LOG/settings-show.out" \
  || { echo "FAIL: settings show (probe)"; cat "$LOG/settings-show.out"; exit 1; }
for _ in $(seq 1 20); do
  code -b "$JAR" "$BASE/api/v1/settings" >/dev/null
  python3 -c "import json; p = json.load(open('/tmp/akari-smoke/last'))['probe']; assert p['urls']['source'] == 'default'" 2>/dev/null && break
  sleep 0.5
done
python3 -c "import json; p = json.load(open('/tmp/akari-smoke/last'))['probe']; assert p['urls']['source'] == 'default' and p['interval_secs']['effective'] == 18000, p" \
  || { echo "FAIL: running panel did not reload the unset probe settings"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='settings.probe.update' AND actor_label='cli'")" = "1" ] \
  || { echo "FAIL: CLI probe unset not audited"; exit 1; }
# Back to the defaults the rest of the smoke expects.
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"display_name":null,"tags":[],"sort":0}')" = "200" ] \
  && [ "$(entrance_patch '{"rate":1,"connect_host":"node1.example.test","connect_port":null}')" = "200" ] \
  || { echo "FAIL: reset W11 fields"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$USER_D?confirm=true")" = "204" ] || { echo "FAIL: delete D"; exit 1; }
# The test-URL server is done (background helpers inherit the caller's
# flock descriptor: never leave one running).
kill "$W11_PROBE_PID" 2>/dev/null || true

echo "== S4-1 login rate limit: failures only, per client; XFF only from trusted proxies =="
login_code() { # extra curl args..., then login, password (last two)
  local n=$#; local pw="${!n}"; local lg="${*:$((n-1)):1}@smoke.test"
  code "${@:1:$((n-2))}" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$lg\",\"password\":\"$pw\"}"
}
rl_clear() {
  vk EVAL \
    "for _,k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1" 0 'akari:rl:*' >/dev/null
}
rl_clear
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"rl-user@smoke.test","password":"rl-user-password"}')" = "201" ] || { echo "FAIL: create rl-user"; exit 1; }
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
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$USER_ID?confirm=true")" = "204" ] || { echo "FAIL: delete user"; exit 1; }
wait_users 0 10 "delete user"
echo "delete user: ok"

echo "== M3 operations model: group + plan -> automatic access; quota; period reset; cancel =="
last_json() { python3 -c "import json,sys; d=json.load(open('/tmp/akari-smoke/last')); print($1)"; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"region": "Smokeland"}')" = "200" ] || { echo "FAIL: set region"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/node-groups" -H 'Content-Type: application/json' \
    -d "{\"name\":\"smoke-group\",\"entrance_ids\":[\"$DIRECT_ID\"]}")" = "201" ] || { echo "FAIL: create group"; cat /tmp/akari-smoke/last; exit 1; }
GROUP_ID=$(last_json "d['id']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/node-groups" -H 'Content-Type: application/json' \
    -d '{"name":"x","nodes":[]}')" = "400" ] || { echo "FAIL: unknown group field not 400"; exit 1; }
[ "$(patch_code "$BASE/api/v1/node-groups/$GROUP_ID" '{"entrance_ids": null}')" = "400" ] || { echo "FAIL: entrance_ids null not 400"; exit 1; }
[ "$(patch_code "$BASE/api/v1/node-groups/$GROUP_ID" '{"node_ids": []}')" = "400" ] || { echo "FAIL: pre-W28 node_ids accepted"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/plans" -H 'Content-Type: application/json' \
    -d '{"name":"smoke-plan","traffic_quota_bytes":150000,"period":"weekly"}')" = "400" ] || { echo "FAIL: bad period not 400"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/plans" -H 'Content-Type: application/json' \
    -d "{\"name\":\"smoke-plan\",\"traffic_quota_bytes\":150000,\"period\":\"monthly\",\"speed_limit_mbps\":100,\"group_ids\":[\"$GROUP_ID\"]}")" = "201" ] \
  || { echo "FAIL: create plan"; cat /tmp/akari-smoke/last; exit 1; }
PLAN_ID=$(last_json "d['id']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-plan-user@smoke.test","password":"plan-password-123"}')" = "201" ] || { echo "FAIL: create plan user"; exit 1; }
PU=$(last_json "d['id']")
# D12: an assignment is plan + term (no expiry sent); the reset pack is no term.
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/users/$PU/plan" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PLAN_ID\",\"period\":\"reset\"}")" = "400" ] && last_json "d['code']" | matches '^user_plan.term_reset$' \
  || { echo "FAIL: reset pack accepted as a term"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/users/$PU/plan" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PLAN_ID\",\"period\":\"days\",\"days\":30}")" = "200" ] || { echo "FAIL: assign plan"; cat /tmp/akari-smoke/last; exit 1; }
wait_users 1 10 "plan grants the node (no manual assignment)"
[ "$(psql_q "SELECT count(*) FROM entrance_users WHERE user_id='$PU' AND entrance_id='$DIRECT_ID'")" = "1" ] \
  || { echo "FAIL: plan did not grant the entrance"; exit 1; }
[ "$(psql_q "SELECT traffic_limit_bytes FROM users WHERE id='$PU'")" = "150000" ] || { echo "FAIL: limit not derived from the plan"; exit 1; }
[ "$(patch_code "$BASE/api/v1/users/$PU" '{"traffic_limit_bytes": 1}')" = "400" ] || { echo "FAIL: limit editable (D12)"; exit 1; }
# D3: no manual (un)assignment.
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$PU/nodes/$NODE_ID")" = "404" ] || { echo "FAIL: manual unassign endpoint answers"; exit 1; }
# D12: the user detail carries the current subscription (the node-access
# view GET /users/{id}/nodes is gone: canonical rejection).
[ "$(code -b "$JAR" "$BASE/api/v1/users/$PU")" = "200" ] || { echo "FAIL: user detail"; cat /tmp/akari-smoke/last; exit 1; }
python3 -c "import json; s=json.load(open('/tmp/akari-smoke/last'))['subscription']; assert s['plan_name']=='smoke-plan' and s['period']=='days' and s['period_days']==30 and s['traffic_total_bytes']==150000 and s['reset_period']=='monthly' and s['next_reset_at'].endswith('+08:00') and s['timezone']=='Asia/Shanghai' and s['expires_at'] and s['status']=='active', s" \
  || { echo "FAIL: user detail subscription"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/users/00000000-0000-0000-0000-000000000000")" = "404" ] || { echo "FAIL: detail of no user not 404"; exit 1; }
[ "$(fp -b "$JAR" "$BASE/api/v1/users/$PU/nodes")" = "$REJ" ] || { echo "FAIL: /users/{id}/nodes still answers"; exit 1; }
# Renew one term / extend N days (from max(expiry, now)); one-time purchases
# are never extended by days.
EXP0=$(psql_q "SELECT extract(epoch FROM expires_at)::bigint FROM user_plans WHERE user_id='$PU' AND status='active'")
[ "$(patch_code "$BASE/api/v1/users/$PU/plan" '{"extend_days": 2}')" = "200" ] || { echo "FAIL: extend plan"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT extract(epoch FROM expires_at)::bigint - $EXP0 FROM user_plans WHERE user_id='$PU' AND status='active'")" = "172800" ] \
  || { echo "FAIL: extend by 2 days"; exit 1; }
[ "$(patch_code "$BASE/api/v1/users/$PU/plan" '{"period": "month", "extend_days": 2}')" = "400" ] || { echo "FAIL: two renewal modes not 400"; exit 1; }
[ "$(patch_code "$BASE/api/v1/users/$PU/plan" '{"period": "month"}')" = "200" ] || { echo "FAIL: renew one month"; exit 1; }
[ "$(psql_q "SELECT term_kind FROM user_plans WHERE user_id='$PU' AND status='active'")" = "month" ] || { echo "FAIL: renewal term not recorded"; exit 1; }
[ "$(psql_q "SELECT u.expires_at = up.expires_at FROM users u JOIN user_plans up ON up.user_id = u.id AND up.status='active' WHERE u.id='$PU'")" = "t" ] \
  || { echo "FAIL: enforced expiry not synced from the plan"; exit 1; }
code -b "$JAR" "$BASE/api/v1/users" >/dev/null
python3 -c "import json; u=[x for x in json.load(open('/tmp/akari-smoke/last'))['users'] if x['id']=='$PU'][0]; assert u['plan_name']=='smoke-plan' and u['next_reset_at']" \
  || { echo "FAIL: users list lacks plan/reset"; exit 1; }
PJAR="$LOG/plan-user-cookies"
[ "$(code -c "$PJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-plan-user@smoke.test","password":"plan-password-123"}')" = "200" ] || { echo "FAIL: plan user login"; exit 1; }
[ "$(code -b "$PJAR" "$BASE/api/v1/me/plan")" = "200" ] || { echo "FAIL: /me/plan"; exit 1; }
python3 -c "import json; d=json.load(open('/tmp/akari-smoke/last')); assert d['plan']['name']=='smoke-plan' and d['plan']['period']=='monthly' and d['plan']['next_reset_at'].endswith('+08:00') and d['nodes']==[{'name':'test-node','region':'Smokeland'}], d" \
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
    -d '{"email":"smoke-plan-user@smoke.test","password":"plan-password-456"}')" = "200" ] || { echo "FAIL: login with the new password"; exit 1; }
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
PU_VLESS=$(account_of "$PU")
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
    -d '{"email":"smoke-plan-user@smoke.test","password":"plan-password-456"}')" = "200" ] && grep -q '"quota_exhausted":true' /tmp/akari-smoke/last \
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
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='user.traffic.reset' AND actor_label='system' AND target_id='$PU'")" = "1" ] \
  || { echo "FAIL: reset not audited once as system"; exit 1; }
wait_users 1 10 "period reset re-enabled"
# Banned users are never re-enabled by a reset.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$PU/ban" -H 'Content-Type: application/json' \
    -d '{"reason": "smoke"}')" = "200" ] || { echo "FAIL: ban"; exit 1; }
wait_users 0 10 "banned"
psql_q "UPDATE user_plans SET next_reset_at = now() - interval '1 second' WHERE user_id='$PU' AND status='active'" >/dev/null
for _ in $(seq 1 20); do
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='user.traffic.reset' AND target_id='$PU'")" = "2" ] && break; sleep 1
done
[ "$(psql_q "SELECT enabled::text || '/' || disabled_reason FROM users WHERE id='$PU'")" = "false/admin" ] \
  || { echo "FAIL: reset re-enabled a banned user"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$PU/unban" -H 'Content-Type: application/json' -d '{}')" = "200" ] \
  || { echo "FAIL: unban"; exit 1; }
wait_users 1 10 "unbanned"
# D12 "重置套餐流量": needs confirm: true; zeroes the usage, audited.
psql_q "UPDATE users SET traffic_used_bytes = 1234 WHERE id='$PU'" >/dev/null
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$PU/plan/reset-traffic" -H 'Content-Type: application/json' \
    -d '{"confirm": false}')" = "400" ] && last_json "d['code']" | matches '^user_plan.confirm_required$' \
  || { echo "FAIL: unconfirmed traffic reset"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$PU/plan/reset-traffic" -H 'Content-Type: application/json' \
    -d '{"confirm": true}')" = "200" ] && last_json "d['subscription']['traffic_used_bytes']" | matches '^0$' \
  || { echo "FAIL: traffic reset"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='user.traffic.reset' AND actor_label <> 'system' AND target_id='$PU'")" = "1" ] \
  || { echo "FAIL: admin traffic reset not audited"; exit 1; }
# Cancel: plan access removed (departed row for the final counters).
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/plans/$PLAN_ID")" = "409" ] || { echo "FAIL: plan with a subscriber deleted"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$PU/plan")" = "204" ] || { echo "FAIL: cancel plan"; exit 1; }
wait_users 0 10 "plan cancelled"
[ "$(psql_q "SELECT count(*) FROM entrance_users_departed WHERE user_id='$PU' AND entrance_id='$DIRECT_ID'")" = "1" ] \
  || { echo "FAIL: no departed row after cancel"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$PU/plan")" = "409" ] || { echo "FAIL: second cancel not 409"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/audit?action=user.plan.&limit=10")" = "200" ] || { echo "FAIL: audit user.plan."; exit 1; }
for a in user.plan.set user.plan.renew user.plan.cancel; do
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
# A delivered message to $1 whose subject contains $2 and text contains $3
# (any position in the mailbox; waits up to 30 s).
mp_find() {
  python3 - "$MP_API" "$1" "$2" "$3" <<'PY'
import json, sys, time, urllib.parse, urllib.request
api, to, subj, text = sys.argv[1:5]
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(60):
    d = json.load(op.open(api + "/search?query=" + urllib.parse.quote("to:" + to)))
    for s in d["messages"]:
        if subj in s["Subject"]:
            m = json.load(op.open(api + "/message/" + s["ID"]))
            if text in m["Text"]:
                print(m["Subject"]); print(m["Text"]); sys.exit(0)
    time.sleep(0.5)
sys.exit("no message to %s with %r / %r" % (to, subj, text))
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
SIGNUP_ON='"register_enabled":true,"invite_required":false,"invite_single_use":false,"invite_codes_per_user":5,"email_domains":[],"trial_plan_id":null,"trial_days":3,"reset_enabled":true,"email_verify":true'
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/signup" -H "$J" -d "{\"version\":0,$SIGNUP_ON}")" = "409" ] \
  || { echo "FAIL: registration enabled without mail"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/mail" -H "$J" -d '{"version":0,"enabled":true,"host":"127.0.0.1","port":11025,"security":"none","username":null,"from_addr":"noreply@akari.test","from_name":"Akari Smoke","notify_order_paid":true,"notify_expiry_days":3,"notify_expired":true,"notify_quota":true}')" = "200" ] \
  || { echo "FAIL: save SMTP settings"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/mail/test" -H "$J" -d '{"to":"admin@akari.test"}')" = "200" ] \
  || { echo "FAIL: test mail"; cat /tmp/akari-smoke/last; exit 1; }
mp_mail admin@akari.test 1 | sed -n 1p | matches '^Akari Smoke 测试邮件$' || { echo "FAIL: test mail not delivered"; exit 1; }
# W31: the step-by-step diagnostic against the same relay (plaintext = warn,
# every step reported, the mail delivered), and the settings view's provider.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/mail/diagnose" -H "$J" -d '{"to":"diag@akari.test"}')" = "200" ] \
  && [ "$(last_json "d['ok'] and d['provider'] == 'smtp' and [s['step'] for s in d['steps']] == ['config','dns','tcp','tls','greeting','auth','send'] and d['steps'][0]['code'] == 'mail.diag.plaintext' and d['steps'][6]['status'] == 'ok'")" = "True" ] \
  || { echo "FAIL: mail diagnostic"; cat /tmp/akari-smoke/last; exit 1; }
mp_mail diag@akari.test 1 | sed -n 1p | matches '^Akari Smoke 测试邮件$' || { echo "FAIL: diagnostic mail not delivered"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/settings/mail")" = "200" ] \
  && [ "$(last_json "d['provider'] == 'smtp' and d['providers'] == ['smtp', 'resend'] and d['api_key_set'] is False")" = "True" ] \
  || { echo "FAIL: mail settings provider view"; cat /tmp/akari-smoke/last; exit 1; }
# Reset links need the main domain (never the request's Host): set it for
# this section only (IP literal; the host gate keeps accepting 127.0.0.1).
[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings"; exit 1; }
VER=$(last_json "d['version']")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings" -H "$J" \
    -d "{\"version\":$VER,\"main_domains\":[\"127.0.0.1:8080\"],\"sub_domains\":[],\"node_domains\":[\"127.0.0.1:8443\"],\"trust_cloudflare\":null}")" = "200" ] \
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
[ "$(code -X POST "$BASE/auth/login" -H "$J" -d "{\"email\":\"$(echo "$REG" | tr a-z A-Z)\",\"password\":\"reg-password-1\"}")" = "200" ] \
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
RESET_TOKEN=$(mp_mail "$REG" 3 | grep -oE '/reset#token=[A-Za-z0-9_-]{43}' | sed -n 1p | sed 's/.*token=//')
[ -n "$RESET_TOKEN" ] || { echo "FAIL: no reset link in the mail"; mp_mail "$REG" 3; exit 1; }
mp_mail "$REG" 3 | matches 'https\?://127\.0\.0\.1:8080/' || { echo "FAIL: reset link is not on the main domain"; exit 1; }
[ "$(code -X POST "$BASE/auth/password-reset" -H "$J" -d "{\"token\":\"$RESET_TOKEN\",\"password\":\"reg-password-2\"}")" = "200" ] \
  || { echo "FAIL: reset password"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$RJAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: session survived the password reset"; exit 1; }
[ "$(code -X POST "$BASE/auth/password-reset" -H "$J" -d "{\"token\":\"$RESET_TOKEN\",\"password\":\"reg-password-3\"}")" = "400" ] \
  || { echo "FAIL: reset link reused"; exit 1; }
[ "$(code -c "$RJAR" -X POST "$BASE/auth/login" -H "$J" -d "{\"email\":\"$REG\",\"password\":\"reg-password-2\"}")" = "200" ] \
  || { echo "FAIL: login with the new password"; exit 1; }
# Outbox: settled bodies cleared; codes/tokens never in the log; audited.
for _ in $(seq 1 20); do
  [ "$(psql_q "SELECT count(*) FROM mail_outbox WHERE status = 'pending'")" = "0" ] && break; sleep 0.5
done
[ "$(psql_q "SELECT count(*) FROM mail_outbox WHERE status <> 'sent' OR body_text <> '' OR body_html <> ''")" = "0" ] \
  || { echo "FAIL: outbox not drained / bodies kept"; psql_q "SELECT id, kind, status, last_error FROM mail_outbox"; exit 1; }
grep -qe "$RESET_TOKEN" -e "\"$REG_CODE\"" "$LOG/panel.log" && { echo "FAIL: a code or reset token in the panel log"; exit 1; }
# settings.mail.test twice: the test mail and the W31 diagnostic.
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action IN ('user.register', 'user.password.reset', 'settings.mail.update', 'settings.signup.update', 'settings.mail.test')")" = "6" ] \
  || { echo "FAIL: W15 audit rows"; psql_q "SELECT action FROM audit_log ORDER BY id DESC LIMIT 10"; exit 1; }
# The admin user list shows the address and its verification.
[ "$(code -b "$JAR" "$BASE/api/v1/users?limit=200")" = "200" ] \
  && python3 -c "import json; d=json.load(open('/tmp/akari-smoke/last')); u=[x for x in (d['users'] if isinstance(d, dict) else d) if x['email']=='$REG'][0]; assert u['email_verified'], u" \
  || { echo "FAIL: user list email"; exit 1; }

echo "== W24: registration without email verification: proof of work, generic refusal, unverified login, admin verify =="
# v0.4: verification is its own switch (SMTP stays on here).
psql_q "UPDATE signup_settings SET email_verify = false" >/dev/null
[ "$(code "$BASE/auth/options")" = "200" ] && last_json "d['register'] and not d['email_verify']" | matches True \
  || { echo "FAIL: options say verification while it is switched off"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(fp -X POST "$BASE/auth/register/code" -H "$J" -d '{"email":"x@akari.test"}')" = "$REJ" ] \
  || { echo "FAIL: code endpoint not the canonical rejection without verification"; exit 1; }
w24_register() { # email password -> HTTP code (body in /tmp/akari-smoke/last)
  [ "$(code "$BASE/auth/register/challenge")" = "200" ] || { echo "FAIL: challenge"; cat /tmp/akari-smoke/last; exit 1; }
  python3 - "$1" "$2" >/tmp/akari-smoke/w24-body <<'PY'
import hashlib, json, sys
d = json.load(open("/tmp/akari-smoke/last")); c = d["challenge"]; bits = d["bits"]; i = 0
while True:
    h = int.from_bytes(hashlib.sha256(f"{c}:{i}".encode()).digest(), "big")
    if h >> (256 - bits) == 0: break
    i += 1
print(json.dumps({"email": sys.argv[1], "password": sys.argv[2], "pow": {"challenge": c, "nonce": str(i)}}), end="")
PY
  code -c "$LOG/w24-cookies" -X POST "$BASE/auth/register" -H "$J" --data-binary @/tmp/akari-smoke/w24-body
}
W24="smoke-nov-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')@akari.test"
[ "$(w24_register "$W24" w24-password-1)" = "200" ] && last_json "d['email_verified']" | matches False \
  || { echo "FAIL: register without verification"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$LOG/w24-cookies" "$BASE/api/v1/me")" = "200" ] && last_json "d['email']=='$W24' and not d['email_verified']" | matches True \
  || { echo "FAIL: unverified account"; cat /tmp/akari-smoke/last; exit 1; }
# The same address again, or another account's verified address: one generic answer.
for a in "$W24" "$REG"; do
  [ "$(w24_register "$a" other-password-1)" = "400" ] && last_json "d['code']" | matches '^signup.unavailable$' \
    || { echo "FAIL: duplicate not the generic refusal ($a)"; cat /tmp/akari-smoke/last; exit 1; }
done
# A replayed or missing proof of work is refused.
[ "$(code -X POST "$BASE/auth/register" -H "$J" --data-binary @/tmp/akari-smoke/w24-body)" = "400" ] \
  && last_json "d['code']" | matches '^signup.challenge_invalid$' || { echo "FAIL: proof of work replayed"; exit 1; }
[ "$(code -X POST "$BASE/auth/register" -H "$J" -d "{\"email\":\"n$W24\",\"password\":\"w24-password-1\"}")" = "400" ] \
  || { echo "FAIL: registration without proof of work"; exit 1; }
# Login with the address (any case) works; the admin can vouch for it.
[ "$(code -X POST "$BASE/auth/login" -H "$J" -d "{\"email\":\"$(echo "$W24" | tr a-z A-Z)\",\"password\":\"w24-password-1\"}")" = "200" ] \
  || { echo "FAIL: login of the unverified account by its address"; exit 1; }
W24_ID=$(psql_q "SELECT id FROM users WHERE email = '$W24'")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$W24_ID/email/verify" -H "$J" -d '{}')" = "200" ] \
  && [ "$(psql_q "SELECT email_verified_at IS NOT NULL FROM users WHERE id = '$W24_ID'")" = "t" ] \
  || { echo "FAIL: admin marks the address verified"; cat /tmp/akari-smoke/last; exit 1; }
psql_q "UPDATE signup_settings SET email_verify = true" >/dev/null
[ "$(code "$BASE/auth/options")" = "200" ] && last_json "d['email_verify']" | matches True \
  || { echo "FAIL: verification switched back on"; exit 1; }
echo "W24 registration without verification: ok"

echo "== R18-3 Alipay F2F: price -> order (precreate) -> signed notify -> plan + node access; replay no-op; bad notify = rejection =="
# W24/R40: the mock gateway as an Alipay payment method, configured through
# the admin API (database only). Notify URLs derive from the main domain
# (still 127.0.0.1:8080 from the W15 section).
pay_body() { # enabled public-key-file -> JSON
  python3 - "$1" "$2" <<PY
import json, sys
print(json.dumps({"kind": "alipay_f2f", "display_name": "支付宝", "enabled": sys.argv[1] == "true",
  "config": {"environment": "custom", "gateway_url": "http://127.0.0.1:18089/gateway.do",
             "app_id": "2021000000000001", "seller_id": "2088000000000001",
             "app_private_key": open("$PAY/app-key.pem").read(), "alipay_public_key": open(sys.argv[2]).read(),
             "order_timeout_minutes": 15}}), end="")
PY
}
pay_body true "$PAY/app-pub.pem" >"$LOG/pay-bad.json"
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/payments" -H "$J" --data-binary @"$LOG/pay-bad.json")" = "400" ] \
  && last_json "d['code']" | matches '^payments.public_key_is_app_key$' || { echo "FAIL: app key as Alipay key accepted"; exit 1; }
pay_body true "$PAY/alipay-pub.pem" >"$LOG/pay.json"
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/payments" -H "$J" --data-binary @"$LOG/pay.json")" = "201" ] \
  || { echo "FAIL: add payment method"; cat /tmp/akari-smoke/last; exit 1; }
METHOD=$(last_json "d['id']")
grep -q 'PRIVATE' /tmp/akari-smoke/last && { echo "FAIL: private key in the method view"; exit 1; }
last_json "d['active'] and d['config']['app_private_key_set'] and d['notify_url'].endswith('/pay/$METHOD/notify')" | matches True \
  || { echo "FAIL: method view"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/payments/$METHOD/test" -H "$J" -d '{}')" = "200" ] \
  && last_json "d['ok'] and d['result']=='keys_ok'" | matches True || { echo "FAIL: 测试连接"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'payment_method.create' AND after::text LIKE '%changed%' AND after::text NOT LIKE '%PRIVATE%'")" = "1" ] \
  || { echo "FAIL: payment method audit"; exit 1; }
[ "$(psql_q "SELECT get_byte(secrets_enc, 0) = 1 AND position(convert_to('MII', 'UTF8') IN secrets_enc) = 0 FROM payment_methods WHERE id = '$METHOD'")" = "t" ] \
  || { echo "FAIL: payment secrets not sealed"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/node-groups" -H 'Content-Type: application/json' \
    -d "{\"name\":\"paid-group\",\"entrance_ids\":[\"$DIRECT_ID\"]}")" = "201" ] || { echo "FAIL: create paid group"; exit 1; }
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
  && [ "$(last_json "d['capacity']")/$(last_json "d['renew_off_sale']")" = "5/True" ] || { echo "FAIL: plan catalogue fields"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-buyer@smoke.test","password":"buyer-password-123"}')" = "201" ] || { echo "FAIL: create buyer"; exit 1; }
BUYER=$(last_json "d['id']")
BJAR="$LOG/buyer-cookies"
[ "$(code -c "$BJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-buyer@smoke.test","password":"buyer-password-123"}')" = "200" ] || { echo "FAIL: buyer login"; exit 1; }
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
# 中-2: the pending order reserves one of the plan's 5 slots (another
# customer's shop shows 4 left).
[ "$(psql_q "SELECT action FROM orders WHERE id='$ORDER'")" = "new" ] || { echo "FAIL: order action not stored"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-viewer@smoke.test","password":"viewer-password-123"}')" = "201" ] || { echo "FAIL: create viewer"; exit 1; }
VIEWER=$(last_json "d['id']"); VJAR="$LOG/viewer-cookies"
[ "$(code -c "$VJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-viewer@smoke.test","password":"viewer-password-123"}')" = "200" ] || { echo "FAIL: viewer login"; exit 1; }
[ "$(code -b "$VJAR" "$BASE/api/v1/me/shop")" = "200" ] \
  && [ "$(last_json "[x for x in d['plans'] if x['plan_id']=='$PAID_PLAN'][0]['remaining']")" = "4" ] \
  || { echo "FAIL: a pending order does not reserve its slot"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$VIEWER?confirm=true")" = "204" ] || { echo "FAIL: delete viewer"; exit 1; }
NOTIFY="$ROOT/pay/$METHOD/notify"
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
python3 -c "import json; d=json.load(open('/tmp/akari-smoke/last')); assert d['status']=='paid' and d['fulfilled'] and d['qr_code'] is None and d['action']=='new' and d['refund_route'] is None and d['refund_pending'] is False, d" \
  || { echo "FAIL: order not paid+fulfilled"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT plan_id FROM user_plans WHERE user_id='$BUYER' AND status='active'")" = "$PAID_PLAN" ] || { echo "FAIL: plan not active"; exit 1; }
wait_users 1 10 "purchased plan grants the node"
BUYER_VLESS=$(account_of "$BUYER")
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
  [ "$(api_json "$JAR" POST "$BASE/api/v1/users" "{\"email\":\"$who@smoke.test\",\"password\":\"$who-password-123\"}")" = "201" ] \
    || { echo "FAIL: create $who"; exit 1; }
  code -c "$LOG/$who-cookies" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$who@smoke.test\",\"password\":\"$who-password-123\"}" >/dev/null
done
INVITER=$(psql_q "SELECT id FROM users WHERE email='smoke-inviter@smoke.test'")
W16U=$(psql_q "SELECT id FROM users WHERE email='smoke-w16@smoke.test'")
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
# (The pre-R40 notify path still settles an order through its own method.)
[ "$(curl -s --noproxy '*' -X POST "$ROOT/pay/alipay/notify" --data-binary "$(python3 "$PAY/notify.py" "$PAY" "$COTN" 8.00 TRADE_SUCCESS)")" = "success" ] \
  || { echo "FAIL: coupon order notify"; exit 1; }
[ "$(psql_q "SELECT status, fulfilled_at IS NOT NULL FROM orders WHERE id='$CORDER'")" = "paid|t" ] || { echo "FAIL: coupon order not fulfilled"; exit 1; }
[ "$(psql_q "SELECT status || '/' || (SELECT used FROM coupons WHERE code='SMOKE20') FROM coupon_redemptions WHERE order_id='$CORDER'")" = "redeemed/1" ] \
  || { echo "FAIL: coupon not redeemed once"; exit 1; }
# High-2: the switch credit is what was paid (800), never the list price (1000).
[ "$(code -b "$WJAR" "$BASE/api/v1/me/shop")" = "200" ] && [ "$(last_json "d['credit_cents'] <= 800")" = "True" ] \
  || { echo "FAIL: the coupon's discount became switch credit"; cat /tmp/akari-smoke/last; exit 1; }
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
# Withdrawal (R46: USDT only): over the withdrawable amount refused; a bad
# address or a disabled chain refused; 60 held, approved by hand with the
# USDT sent and the transaction hash.
[ "$(api_json "$IJAR" POST "$BASE/api/v1/me/withdrawals" '{"amount_cents":100,"chain":"trc20","address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"}')" = "409" ] \
  || { echo "FAIL: withdrawal over the withdrawable amount"; exit 1; }
[ "$(api_json "$IJAR" POST "$BASE/api/v1/me/withdrawals" '{"amount_cents":60,"chain":"trc20","address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"}')" = "400" ] \
  && [ "$(last_json "d['code']")" = "withdrawal.address_invalid" ] \
  || { echo "FAIL: a bad TRC20 address was accepted"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$IJAR" POST "$BASE/api/v1/me/withdrawals" '{"amount_cents":60,"chain":"bitcoin","address":"x"}')" = "400" ] \
  && [ "$(last_json "d['code']")" = "withdrawal.chain_invalid" ] \
  || { echo "FAIL: an unknown chain was accepted"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$IJAR" POST "$BASE/api/v1/me/withdrawals" '{"amount_cents":60,"chain":"trc20","address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"}')" = "201" ] \
  || { echo "FAIL: withdrawal request"; cat /tmp/akari-smoke/last; exit 1; }
WD=$(last_json "d['id']")
[ "$(psql_q "SELECT balance_cents FROM user_balances WHERE user_id='$INVITER'")" = "20" ] || { echo "FAIL: withdrawal not held"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/withdrawals/$WD/approve" '{"usdt_amount":"8.1","txid":"short"}')" = "400" ] \
  || { echo "FAIL: approval without a transaction hash"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/withdrawals/$WD/approve" '{"usdt_amount":"0.08","txid":"4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f"}')" = "204" ] \
  || { echo "FAIL: approve withdrawal"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT chain || '/' || address || '/' || usdt_micros || '/' || txid FROM withdrawals WHERE id='$WD'")" = "trc20/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/80000/4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f" ] \
  || { echo "FAIL: the USDT payout was not recorded"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='withdrawal.approved' AND after->>'txid'='4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f' AND (after->>'usdt_micros')::bigint = 80000")" = "1" ] \
  || { echo "FAIL: the USDT payout was not audited"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/withdrawals/$WD/approve" '{"usdt_amount":"1","txid":"4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f4b0f"}')" = "409" ] \
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
# Admin refund of the coupon order to the balance. 中-4: its commission was
# credited (80) and partly withdrawn (60): the refund claws it back — the
# inviter's balance (20) now, the rest (60) owed and kept out of withdrawals.
# P1: the preview says what happens to the subscription the order created
# (cancelled: the user's access goes), and the refund does exactly that.
[ "$(code -b "$JAR" "$BASE/api/v1/orders/$CORDER/refund-preview")" = "200" ] \
  && [ "$(last_json "d['effect']['kind']")/$(last_json "d['amount_cents']")/$(last_json "d['coupon_released']")" = "cancel/800/SMOKE20" ] \
  || { echo "FAIL: refund preview"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/orders/$CORDER/refund" '{"reason":"smoke refund","to_balance":true}')" = "200" ] \
  && [ "$(last_json "d['refund_cents']")/$(last_json "d['commission']")/$(last_json "d['effect']['kind']")" = "800/clawed_back/cancel" ] \
  && [ "$(last_json "d['commission_clawback']['recovered_cents']")/$(last_json "d['commission_clawback']['outstanding_cents']")" = "20/60" ] \
  || { echo "FAIL: refund"; cat /tmp/akari-smoke/last; exit 1; }
# 低-2: the coupon's one use comes back with the refund.
[ "$(psql_q "SELECT status || '/' || (SELECT used FROM coupons WHERE code='SMOKE20') FROM coupon_redemptions WHERE order_id='$CORDER'")" = "released/0" ] \
  || { echo "FAIL: refund did not give the coupon use back"; exit 1; }
[ "$(code -b "$IJAR" "$BASE/api/v1/me/balance")" = "200" ] \
  && [ "$(last_json "d['balance_cents']")/$(last_json "d['withdrawable_cents']")/$(last_json "d['entries'][0]['kind']")" = "0/0/commission_clawback" ] \
  || { echo "FAIL: commission clawback on the inviter's balance"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT count(*) FROM user_plans WHERE user_id='$W16U' AND status='active'")/$(psql_q "SELECT count(*) FROM entrance_users WHERE user_id='$W16U'")" = "0/0" ] \
  || { echo "FAIL: the refunded subscription kept its access"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/orders/$CORDER/refund-preview")" = "409" ] || { echo "FAIL: preview of a refunded order"; exit 1; }
# 中-3: an Alipay-console refund is recorded with the amount the admin enters.
[ "$(api_json "$WJAR" POST "$BASE/api/v1/me/orders" "{\"plan_id\":\"$W16_PLAN\",\"period\":\"month\"}")" = "201" ] \
  || { echo "FAIL: order to refund out of band"; cat /tmp/akari-smoke/last; exit 1; }
XORDER=$(last_json "d['id']"); XOTN=$(last_json "d['out_trade_no']")
[ "$(curl -s --noproxy '*' -X POST "$ROOT/pay/alipay/notify" --data-binary "$(python3 "$PAY/notify.py" "$PAY" "$XOTN" 10.00 TRADE_SUCCESS)")" = "success" ] \
  || { echo "FAIL: out-of-band refund order notify"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/orders/$XORDER/refund" '{"reason":"支付宝后台已退"}')" = "400" ] \
  && last_json "d['code']" | matches '^order_admin.refund_external_required$' \
  || { echo "FAIL: out-of-band refund without its amount"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/orders/$XORDER/refund" '{"reason":"支付宝后台已退","external_cents":1000}')" = "200" ] \
  && [ "$(last_json "d['refund_cents']")/$(last_json "d['refund_balance_cents']")/$(last_json "d['refund_external_cents']")" = "1000/0/1000" ] \
  || { echo "FAIL: out-of-band refund"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT refund_cents || '/' || refund_external_cents FROM orders WHERE id='$XORDER'")" = "1000/1000" ] \
  || { echo "FAIL: out-of-band refund not recorded"; exit 1; }
# The customer is told (one refund notice per refund): amounts and the plan.
mp_find smoke-w16@smoke.test 订单已退款 "原路退回（支付渠道）：¥10.00" >"$LOG/refund-mail.txt" \
  && matches '已取消' <"$LOG/refund-mail.txt" \
  || { echo "FAIL: refund notice mail"; cat "$LOG/refund-mail.txt"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM mail_outbox WHERE kind='refund' AND to_addr='smoke-w16@smoke.test'")" = "2" ] \
  || { echo "FAIL: not one refund notice per refund"; exit 1; }
# 原路退款: a partial refund through the (mock) Alipay gateway, idempotent
# request number, recorded as refunded at the provider.
[ "$(api_json "$WJAR" POST "$BASE/api/v1/me/orders" "{\"plan_id\":\"$W16_PLAN\",\"period\":\"month\"}")" = "201" ] \
  || { echo "FAIL: order to refund through Alipay"; cat /tmp/akari-smoke/last; exit 1; }
OORDER=$(last_json "d['id']"); OOTN=$(last_json "d['out_trade_no']")
[ "$(curl -s --noproxy '*' -X POST "$ROOT/pay/alipay/notify" --data-binary "$(python3 "$PAY/notify.py" "$PAY" "$OOTN" 10.00 TRADE_SUCCESS)")" = "success" ] \
  || { echo "FAIL: original-route refund order notify"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/orders/$OORDER/refund-preview")" = "200" ] && last_json "d['original_available']" | matches '^True$' \
  || { echo "FAIL: original-route refund not offered"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/orders/$OORDER/refund" '{"reason":"原路退款","original":true,"original_cents":600}')" = "200" ] \
  && [ "$(last_json "d['original']['out_request_no']")/$(last_json "d['refund_external_cents']")" = "${OOTN}R1/600" ] \
  || { echo "FAIL: original-route refund: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(psql_q "SELECT refund_request->>'state' || '/' || refund_external_cents FROM orders WHERE id='$OORDER'")" = "done/600" ] \
  || { echo "FAIL: original-route refund not recorded"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'order.refund.request' AND target_id = '$OORDER'")" = "1" ] \
  || { echo "FAIL: original-route refund request not audited"; exit 1; }
[ "$(psql_q "SELECT balance_cents FROM user_balances WHERE user_id='$W16U'")" = "1100" ] || { echo "FAIL: refund not on the balance"; exit 1; }
# W36-b: the customer's order view says where each refund went (the three
# routes) and what it did to the subscription.
for o in "$CORDER:balance:800:0:cancel" "$XORDER:manual:0:1000:" "$OORDER:original:0:600:"; do
  IFS=: read -r oid route bal ext effect <<EOF
$o
EOF
  [ "$(code -b "$WJAR" "$BASE/api/v1/me/orders/$oid")" = "200" ] \
    && [ "$(last_json "d['refund_route']")/$(last_json "d['refund_balance_cents']")/$(last_json "d['refund_external_cents']")/$(last_json "d['refund_pending']")" = "$route/$bal/$ext/False" ] \
    && { [ -z "$effect" ] || [ "$(last_json "d['refund_effect']")" = "$effect" ]; } \
    || { echo "FAIL: /me/orders refund route ($route)"; cat /tmp/akari-smoke/last; exit 1; }
done
# The money invariants, over everything above.
[ "$(psql_q "SELECT count(*) FROM users u LEFT JOIN user_balances b ON b.user_id = u.id
             WHERE COALESCE(b.balance_cents, 0) <> COALESCE((SELECT sum(amount_cents) FROM balance_ledger l WHERE l.user_id = u.id), 0)")" = "0" ] \
  || { echo "FAIL: balance != sum(ledger)"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM balance_ledger")" = "$(psql_q "SELECT count(*) FROM audit_log WHERE action LIKE 'balance.%'")" ] \
  || { echo "FAIL: a ledger row without its audit row"; exit 1; }
psql_q "UPDATE user_balances SET balance_cents = balance_cents + 1" >/dev/null 2>&1 && { echo "FAIL: balance written outside the ledger"; exit 1; }
psql_q "DELETE FROM balance_ledger" >/dev/null 2>&1 && { echo "FAIL: ledger is not append-only"; exit 1; }
for a in coupon.create commission.create commission.settings.update balance.commission balance.withdrawal \
         withdrawal.approved balance.admin_adjust balance.order_payment balance.refund_to_balance order.refund \
         user.plan.refund commission.clawback balance.commission_clawback; do
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='$a'")" -ge 1 ] || { echo "FAIL: audit lacks $a"; exit 1; }
done
# Clean up: the W16 buyer holds w16-plan (the paid group's node); later
# sections expect the node to serve only the R18-3 buyer. The ledger,
# commission and withdrawal rows outlive the users (user_id -> NULL).
for u in "$W16U" "$INVITER"; do
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$u?confirm=true")" = "204" ] || { echo "FAIL: delete W16 user"; exit 1; }
done
[ "$(psql_q "SELECT count(*) FROM balance_ledger WHERE user_id IS NULL AND user_label IN ('u-${W16U:0:8}','u-${INVITER:0:8}')")" -ge 5 ] \
  || { echo "FAIL: ledger rows did not outlive the users"; exit 1; }
echo "w16: ok (coupon reserve/redeem + last use, commission pending -> credited, withdrawal, balance full/partial/refund, ledger invariants)"
echo "== Ops: batch user actions (job, resumable, audited), CSV exports, manual orders, batch coupons =="
OPSJ='Content-Type: application/json'
# A plan with a month price and no node groups (grants nothing: later
# sections keep their node users). Its name starts like a formula.
[ "$(api_json "$JAR" POST "$BASE/api/v1/plans" '{"name":"=ops-plan","period":"monthly","pricing":{"on_sale":true,"prices":[{"period":"month","price_cents":1500}]}}')" = "201" ] \
  || { echo "FAIL: create ops plan"; cat /tmp/akari-smoke/last; exit 1; }
OPS_PLAN=$(last_json "d['id']")
for i in 1 2 3; do
  [ "$(api_json "$JAR" POST "$BASE/api/v1/users" "{\"email\":\"smoke-ops-$i@akari.test\",\"password\":\"ops-password-$i\"}")" = "201" ] \
    || { echo "FAIL: create ops user $i"; cat /tmp/akari-smoke/last; exit 1; }
done
OPS1=$(psql_q "SELECT id FROM users WHERE email='smoke-ops-1@akari.test'")
OPS2=$(psql_q "SELECT id FROM users WHERE email='smoke-ops-2@akari.test'")
OPSF='{"filter":{"q":"smoke-ops-","role":"user"}}'
# wait_batch ID: until the job is done; prints done/failed/skipped.
wait_batch() {
  for _ in $(seq 1 60); do
    code -b "$JAR" "$BASE/api/v1/users/batch/$1" >/dev/null
    [ "$(last_json "d['job']['status']")" = "done" ] && { last_json "'%d/%d/%d' % (d['job']['done'], d['job']['failed'], d['job']['skipped'])"; return 0; }
    sleep 0.5
  done
  echo "FAIL: batch $1 not done"; cat /tmp/akari-smoke/last; exit 1
}
[ "$(api_json "$JAR" POST "$BASE/api/v1/users/batch/preview" "{\"selection\":$OPSF}")" = "200" ] \
  && [ "$(last_json "(d['total'], d['admins'])")" = "(3, 0)" ] || { echo "FAIL: batch preview"; cat /tmp/akari-smoke/last; exit 1; }
# Not for customers; coded refusals.
code -c "$LOG/ops-cookies" -X POST "$BASE/auth/login" -H "$OPSJ" -d '{"email":"smoke-ops-1@akari.test","password":"ops-password-1"}' >/dev/null
[ "$(api_json "$LOG/ops-cookies" POST "$BASE/api/v1/users/batch/preview" "{\"selection\":$OPSF}")" = "403" ] \
  || { echo "FAIL: customer reached batch preview"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/users/batch" "{\"selection\":$OPSF,\"action\":{\"kind\":\"extend_expiry\",\"days\":0}}")" = "400" ] \
  && [ "$(last_json "d['code']")" = "user_plan.extend_days_range" ] || { echo "FAIL: batch validation"; exit 1; }
# Balance: one ledger row + one audit row per user, exactly once.
LEDGER0=$(psql_q "SELECT count(*) FROM balance_ledger WHERE reason = 'ops-smoke'")
[ "$(api_json "$JAR" POST "$BASE/api/v1/users/batch" "{\"selection\":$OPSF,\"action\":{\"kind\":\"add_balance\",\"amount_cents\":250,\"reason\":\"ops-smoke\"}}")" = "202" ] \
  || { echo "FAIL: create balance batch"; cat /tmp/akari-smoke/last; exit 1; }
JOB=$(last_json "d['id']")
[ "$(wait_batch "$JOB")" = "3/0/0" ] || { echo "FAIL: balance batch result"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM balance_ledger WHERE reason = 'ops-smoke'")" = "$((LEDGER0 + 3))" ] \
  && [ "$(psql_q "SELECT balance_cents FROM user_balances WHERE user_id = '$OPS1'")" = "250" ] \
  && [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'balance.admin_adjust' AND after->>'reason' = 'ops-smoke'")" = "3" ] \
  && [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'user.batch.create' AND target_id = '$JOB'")" = "1" ] \
  || { echo "FAIL: balance batch ledger/audit"; exit 1; }
# Mail to the verified addresses through the outbox (Mailpit receives it).
[ "$(api_json "$JAR" POST "$BASE/api/v1/users/batch" "{\"selection\":{\"ids\":[\"$OPS1\",\"$OPS2\"]},\"action\":{\"kind\":\"send_email\",\"subject\":\"Ops smoke notice\",\"body\":\"Maintenance tonight.\"}}")" = "202" ] \
  || { echo "FAIL: create mail batch"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(wait_batch "$(last_json "d['id']")")" = "2/0/0" ] || { echo "FAIL: mail batch result"; exit 1; }
mp_mail "smoke-ops-2@akari.test" 1 | sed -n 1p | matches 'Ops smoke notice' || { echo "FAIL: batch mail not delivered"; exit 1; }
psql_q "SELECT count(*) FROM audit_log WHERE action = 'user.mail.send' AND after::text LIKE '%Maintenance%'" | matches '^0$' \
  || { echo "FAIL: mail body in the audit log"; exit 1; }
# Plan for everyone, then disable one: node bumps come from the mutators.
[ "$(api_json "$JAR" POST "$BASE/api/v1/users/batch" "{\"selection\":$OPSF,\"action\":{\"kind\":\"set_plan\",\"plan_id\":\"$OPS_PLAN\",\"period\":\"month\"}}")" = "202" ] \
  || { echo "FAIL: create plan batch"; exit 1; }
[ "$(wait_batch "$(last_json "d['id']")")" = "3/0/0" ] || { echo "FAIL: plan batch"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM user_plans WHERE plan_id = '$OPS_PLAN' AND status = 'active'")" = "3" ] || { echo "FAIL: plans not set"; exit 1; }
# (A plan change may end the customer's sessions: log in again.)
[ "$(code -c "$LOG/ops-cookies" -X POST "$BASE/auth/login" -H "$OPSJ" -d '{"email":"smoke-ops-1@akari.test","password":"ops-password-1"}')" = "200" ] \
  || { echo "FAIL: ops user login"; exit 1; }
# Users export (current filter): BOM, header + 3 rows, formula-safe plan name.
curl -s --noproxy '*' -b "$JAR" -D "$LOG/ops-users.h" -o "$LOG/ops-users.csv" "$BASE/api/v1/users/export.csv?q=smoke-ops-"
tr -d '\r' <"$LOG/ops-users.h" | matches -i '^content-disposition: attachment; filename="akari-users-' || { echo "FAIL: users export headers"; exit 1; }
python3 - "$LOG/ops-users.csv" <<'PY' || { echo "FAIL: users export body"; exit 1; }
import csv, io, sys
raw = open(sys.argv[1], "rb").read()
assert raw.startswith(b"\xef\xbb\xbf"), "BOM"
rows = list(csv.reader(io.StringIO(raw[3:].decode())))
assert len(rows) == 4 and rows[0][1] == "email", rows
assert all(r[7] == "'=ops-plan" for r in rows[1:]), [r[7] for r in rows]
assert all(r[13] == "250" for r in rows[1:]), [r[13] for r in rows]
PY
[ "$(code -b "$LOG/ops-cookies" "$BASE/api/v1/users/export.csv")" = "403" ] || { echo "FAIL: customer exported users"; exit 1; }
# Manual orders: through apply_mark_paid (paid_via manual); a gift is not revenue.
REV0=$(code -b "$JAR" "$BASE/api/v1/dashboard" >/dev/null; last_json "d['today']['manual_cents']")
GIFT0=$(last_json "d['today']['gift_cents']")
[ "$(api_json "$JAR" POST "$BASE/api/v1/orders/manual" "{\"user_id\":\"$OPS1\",\"plan_id\":\"$OPS_PLAN\",\"period\":\"month\",\"reason\":\"bank transfer\",\"amount_cents\":1}")" = "400" ] \
  || { echo "FAIL: manual order accepted an amount"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/orders/manual" "{\"user_id\":\"$OPS1\",\"plan_id\":\"$OPS_PLAN\",\"period\":\"month\",\"reason\":\"bank transfer\"}")" = "201" ] \
  || { echo "FAIL: manual order"; cat /tmp/akari-smoke/last; exit 1; }
MO=$(last_json "d['id']")
[ "$(api_json "$JAR" POST "$BASE/api/v1/orders/manual" "{\"user_id\":\"$OPS2\",\"plan_id\":\"$OPS_PLAN\",\"period\":\"month\",\"gift\":true,\"reason\":\"prize\"}")" = "201" ] \
  || { echo "FAIL: gift order"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT status || '/' || paid_via || '/' || amount_cents || '/' || (fulfilled_at IS NOT NULL) FROM orders WHERE id = '$MO'")" = "paid/manual/1500/true" ] \
  || { echo "FAIL: manual order row"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/orders/$MO/fulfil" '{"reason":"again"}')" = "409" ] || { echo "FAIL: manual order fulfilled twice"; exit 1; }
code -b "$JAR" "$BASE/api/v1/dashboard" >/dev/null
[ "$(last_json "(d['today']['manual_cents'] - $REV0, d['today']['gift_cents'] - $GIFT0)")" = "(1500, 1500)" ] \
  || { echo "FAIL: dashboard manual/gift flags"; cat /tmp/akari-smoke/last; exit 1; }
curl -s --noproxy '*' -b "$JAR" -o "$LOG/ops-orders.csv" "$BASE/api/v1/orders/export.csv?via=manual"
python3 - "$LOG/ops-orders.csv" <<'PY' || { echo "FAIL: orders export"; exit 1; }
import csv, io, sys
rows = list(csv.reader(io.StringIO(open(sys.argv[1], "rb").read()[3:].decode())))
h = rows[0]
ours = [r for r in rows[1:] if r[h.index("plan_name")] == "'=ops-plan"]
assert len(ours) == 2, rows
assert sorted(r[h.index("gift_cents")] for r in ours) == ["0", "1500"], ours
assert all(r[h.index("manual")] == "true" for r in ours)
PY
[ "$(code -b "$JAR" "$BASE/api/v1/orders/export.csv?from=2020-01-01&to=2026-01-01")" = "400" ] \
  && [ "$(last_json "d['code']")" = "export.range_too_long" ] || { echo "FAIL: orders export range"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/traffic/export.csv?group=node")" = "200" ] || { echo "FAIL: traffic export"; exit 1; }
# Batch coupons: N unique codes, export, the W16 reservation, revoke.
[ "$(api_json "$JAR" POST "$BASE/api/v1/coupon-batches" '{"name":"ops","prefix":"OPS-","count":20,"kind":"fixed","value":100}')" = "201" ] \
  && [ "$(last_json "d['count']")" = "20" ] || { echo "FAIL: coupon batch"; cat /tmp/akari-smoke/last; exit 1; }
CB=$(last_json "d['id']")
curl -s --noproxy '*' -b "$JAR" -o "$LOG/ops-coupons.csv" "$BASE/api/v1/coupon-batches/$CB/export.csv"
OPS_CODE=$(python3 - "$LOG/ops-coupons.csv" <<'PY'
import csv, io, re, sys
rows = list(csv.reader(io.StringIO(open(sys.argv[1], "rb").read()[3:].decode())))
codes = [r[0] for r in rows[1:]]
assert len(codes) == 20 and len(set(c.lower() for c in codes)) == 20, codes
assert all(re.fullmatch(r"OPS-[A-HJ-NP-Z2-9]{10}", c) for c in codes), codes
print(codes[0])
PY
) || { echo "FAIL: coupon batch export"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM coupons WHERE batch_id = '$CB' AND max_uses = 1")" = "20" ] || { echo "FAIL: batch codes"; exit 1; }
[ "$(code -b "$LOG/ops-cookies" "$BASE/api/v1/me/shop?coupon=$(echo "$OPS_CODE" | tr A-Z a-z)")" = "200" ] || { echo "FAIL: shop with batch code"; exit 1; }
python3 -c "
import json; d=json.load(open('/tmp/akari-smoke/last')); assert d['coupon']=={'code':'$OPS_CODE','refusal':None}, d
" || { echo "FAIL: batch code preview"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/coupon-batches/$CB/revoke" '{}')" = "200" ] && [ "$(last_json "d['disabled']")" = "20" ] \
  || { echo "FAIL: revoke batch"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/coupon-batches/$CB/revoke" '{}')" = "409" ] || { echo "FAIL: revoke twice"; exit 1; }
for a in export.users export.orders export.coupon_batch coupon.batch.create coupon.batch.revoke; do
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='$a'")" -ge 1 ] || { echo "FAIL: audit lacks $a"; exit 1; }
done
# Clean up: cancel the plans by batch (departed rows, audit), delete users + plan.
[ "$(api_json "$JAR" POST "$BASE/api/v1/users/batch" "{\"selection\":$OPSF,\"action\":{\"kind\":\"cancel_plan\"}}")" = "202" ] \
  || { echo "FAIL: cancel batch"; exit 1; }
[ "$(wait_batch "$(last_json "d['id']")")" = "3/0/0" ] || { echo "FAIL: cancel batch result"; exit 1; }
for u in $(psql_q "SELECT id FROM users WHERE email LIKE 'smoke-ops-%'"); do
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$u?confirm=true")" = "204" ] || { echo "FAIL: delete ops user"; exit 1; }
done
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/plans/$OPS_PLAN")" = "204" ] || { echo "FAIL: delete ops plan"; exit 1; }
echo "ops: ok (batch balance/mail/plan exactly once + audited, users/orders/traffic CSV, manual + gift orders, coupon batch)"
# W15: Mailpit is no longer needed; stop sending (nothing to deliver to).
psql_q "UPDATE mail_settings SET enabled = false" >/dev/null
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
  local uv; uv=$(psql_q "SELECT user_version FROM servers WHERE id='$SERVER_ID'")
  for _ in $(seq 1 15); do
    grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | matches "\"user_version\":${uv}[,}]" && break; sleep 1
  done
  grep '"msg":"state applied"' "$LOG/agent.log" | tail -1 | matches "\"via\":\"$1\".*\"user_version\":${uv}[,}]" \
    || { echo "FAIL: agent did not apply user_version $uv via $1"; grep 'state applied' "$LOG/agent.log" | tail -3; exit 1; }
}
if need_agent "protocol>=4" "W7 speed limit throughput"; then
  FAST=$(python3 "$LOG/vless_rate.py" "$BUYER_VLESS" 400000) || { echo "FAIL: unlimited transfer"; exit 1; }
  [ "$(patch_code "$BASE/api/v1/plans/$PAID_PLAN" '{"speed_limit_mbps": 1, "apply_to_existing": true}')" = "200" ] || { echo "FAIL: set speed limit"; exit 1; }
  wait_uv delta
  SLOW=$(python3 "$LOG/vless_rate.py" "$BUYER_VLESS" 400000) || { echo "FAIL: limited transfer"; exit 1; }
  [ "$(patch_code "$BASE/api/v1/plans/$PAID_PLAN" '{"speed_limit_mbps": null, "apply_to_existing": true}')" = "200" ] || { echo "FAIL: clear speed limit"; exit 1; }
  wait_uv delta
  AGAIN=$(python3 "$LOG/vless_rate.py" "$BUYER_VLESS" 400000) || { echo "FAIL: transfer after clearing the limit"; exit 1; }
  echo "speed limit: unlimited ${FAST}s, 1 Mbps ${SLOW}s (>= ~2.7s expected), cleared ${AGAIN}s for 400 kB each way"
  python3 -c "f,s,a=$FAST,$SLOW,$AGAIN; assert f < 1.5 and 2.0 <= s <= 15 and a < 1.5, (f,s,a)" \
    || { echo "FAIL: speed limit not enforced as expected"; exit 1; }
else
  # An agent older than protocol 4 (the panel CI runs agent main until the
  # agent PR lands) ignores the field: the node must say so.
  [ "$(patch_code "$BASE/api/v1/plans/$PAID_PLAN" '{"speed_limit_mbps": 1, "apply_to_existing": true}')" = "200" ] || { echo "FAIL: set speed limit"; exit 1; }
  [ "$(code -b "$JAR" "$BASE/api/v1/nodes")" = "200" ] && grep -q "不支持限速" /tmp/akari-smoke/last \
    || { echo "FAIL: no warning for an agent that cannot enforce speed limits"; cat /tmp/akari-smoke/last; exit 1; }
  [ "$(patch_code "$BASE/api/v1/plans/$PAID_PLAN" '{"speed_limit_mbps": null, "apply_to_existing": true}')" = "200" ] || { echo "FAIL: clear speed limit"; exit 1; }
  echo "speed limit: NodeView warning for the protocol $AGENT_PROTO agent present (throughput check skipped above)"
fi
# Admin views and audit.
[ "$(code -b "$JAR" "$BASE/api/v1/orders?email=$BUYER_MAIL")" = "200" ] || { echo "FAIL: admin orders"; exit 1; }
[ "$(last_json "len(d)")" = "3" ] || { echo "FAIL: admin order list"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/orders/$ORDER")" = "200" ] || { echo "FAIL: admin order detail"; exit 1; }
[ "$(code -b "$BJAR" "$BASE/api/v1/orders")" = "403" ] || { echo "FAIL: user reached admin orders"; exit 1; }
for a in order.create order.paid plan.price.set user.plan.set user.plan.renew; do
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='$a'")" -ge 1 ] || { echo "FAIL: audit lacks $a"; exit 1; }
done

echo "== W21: dashboard, user search + total, coded errors, plan + prices in one request, site name =="
[ "$(code -b "$JAR" "$BASE/api/v1/dashboard")" = "200" ] \
  && [ "$(last_json "d['d30']['orders'] >= 1 and d['users_total'] >= 1 and d['servers']['total'] >= 1 and isinstance(d['latest_orders'], list)")" = "True" ] \
  || { echo "FAIL: dashboard"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$BJAR" "$BASE/api/v1/dashboard")" = "403" ] || { echo "FAIL: user reached the dashboard"; exit 1; }

echo "== W31: system status =="
[ "$(code -b "$JAR" "$BASE/api/v1/system/status")" = "200" ] \
  && [ "$(last_json "d['postgres']['ok'] and d['valkey']['ok'] and any(i['this'] and i['alive'] for i in d['instances']) and [j['job'] for j in d['jobs']] == ['settlement','reconciliation','mail','alerts'] and next(j for j in d['jobs'] if j['job'] == 'settlement')['lag_secs'] is not None")" = "True" ] \
  || { echo "FAIL: system status"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$BJAR" "$BASE/api/v1/system/status")" = "403" ] || { echo "FAIL: user reached the system status"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/users?q=SMOKE-BUY&role=user")" = "200" ] \
  && [ "$(last_json "d['total'] == 1 and d['users'][0]['email'] == '$BUYER_MAIL'")" = "True" ] \
  || { echo "FAIL: user search"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/users?status=bogus")" = "400" ] \
  && [ "$(last_json "d['code'] + ' ' + str(sorted(d))")" = "user.status_filter_invalid ['code', 'error', 'params']" ] \
  || { echo "FAIL: coded error body"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/plans" -H 'Content-Type: application/json' \
    -d '{"name":"smoke-w21","period":"monthly","pricing":{"on_sale":true,"prices":[{"period":"month","price_cents":990}]}}')" = "201" ] \
  && [ "$(last_json "d['on_sale'] and d['prices'][0]['price_cents'] == 990")" = "True" ] \
  || { echo "FAIL: plan + prices in one request"; cat /tmp/akari-smoke/last; exit 1; }
W21_PLAN=$(last_json "d['id']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/plans" -H 'Content-Type: application/json' \
    -d '{"name":"smoke-w21-bad","period":"monthly","pricing":{"on_sale":true,"prices":[]}}')" = "400" ] \
  && [ "$(last_json "d['code']")" = "plan.on_sale_needs_price" ] \
  && [ "$(psql_q "SELECT count(*) FROM plans WHERE name='smoke-w21-bad'")" = "0" ] \
  || { echo "FAIL: rejected pricing created a plan"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/plans/$W21_PLAN")" = "204" ] || { echo "FAIL: delete smoke-w21 plan"; exit 1; }
code -b "$JAR" "$BASE/api/v1/settings" >/dev/null
SV=$(last_json "d['version']")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/site" -H 'Content-Type: application/json' \
    -d "{\"version\":$SV,\"site_name\":\"Smoke 站点\"}")" = "200" ] || { echo "FAIL: set site name"; cat /tmp/akari-smoke/last; exit 1; }
SV=$(last_json "d['version']")
ok=0; for _ in $(seq 1 20); do
  code "$BASE/auth/options" >/dev/null
  [ "$(last_json "d['site_name']")" = "Smoke 站点" ] && { ok=1; break; }
  sleep 0.25
done
[ "$ok" = 1 ] || { echo "FAIL: site name not in /auth/options"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/site" -H 'Content-Type: application/json' \
    -d "{\"version\":$SV,\"site_name\":null}")" = "200" ] || { echo "FAIL: clear site name"; exit 1; }
# Q3: the site time zone (IANA names only; absent = unchanged; null = the
# default Asia/Shanghai; audited) drives the days and the reset times.
SV=$(last_json "d['version']")
[ "$(last_json "d['timezone']['effective']")" = "Asia/Shanghai" ] || { echo "FAIL: default time zone"; cat /tmp/akari-smoke/last; exit 1; }
for tz in CST UTC+8 Mars/Base; do
  [ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/site" -H 'Content-Type: application/json' \
      -d "{\"version\":$SV,\"timezone\":\"$tz\"}")" = "400" ] && [ "$(last_json "d['code']")" = "settings.timezone_invalid" ] \
    || { echo "FAIL: time zone $tz accepted"; cat /tmp/akari-smoke/last; exit 1; }
done
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/site" -H 'Content-Type: application/json' \
    -d "{\"version\":$SV,\"timezone\":\"UTC\"}")" = "200" ] && [ "$(last_json "d['timezone']['value']")" = "UTC" ] \
  || { echo "FAIL: set time zone"; cat /tmp/akari-smoke/last; exit 1; }
SV=$(last_json "d['version']")
[ "$(psql_q "SELECT akari_site_tz(), akari_site_day(now()) = (now() AT TIME ZONE 'UTC')::date")" = "UTC|t" ] \
  || { echo "FAIL: SQL does not follow the time zone"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/traffic/summary")" = "200" ] && [ "$(last_json "d['timezone']")" = "UTC" ] \
  || { echo "FAIL: history not in the new time zone"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/site" -H 'Content-Type: application/json' \
    -d "{\"version\":$SV,\"timezone\":null}")" = "200" ] && [ "$(last_json "d['timezone']['source']")" = "default" ] \
  || { echo "FAIL: reset time zone"; cat /tmp/akari-smoke/last; exit 1; }
psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.site.update' AND after ? 'timezone' AND after->>'timezone' = 'UTC'" | matches '^1$' \
  || { echo "FAIL: time zone change not audited"; exit 1; }
# R21: expired and quota-disabled users (renewal scope) can shop, order,
# poll and cancel; a banned user cannot (portal scope: 403 account.banned).
for who in expired quota; do
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
      -d "{\"email\":\"smoke-renew-$who@smoke.test\",\"password\":\"renew-password-123\"}")" = "201" ] || { echo "FAIL: create $who user"; exit 1; }
  RU=$(last_json "d['id']")
  if [ "$who" = expired ]; then
    # Enforced in the same UPDATE: the enforce pass (5 s) setting
    # expiry_enforced later bumps session_ver and would end the session
    # below at a random request.
    psql_q "UPDATE users SET expires_at = now() - interval '1 minute', expiry_enforced = true WHERE id='$RU'" >/dev/null
  else
    psql_q "UPDATE users SET enabled = false, disabled_reason = 'quota' WHERE id='$RU'" >/dev/null
  fi
  RJAR="$LOG/renew-$who-cookies"
  [ "$(code -c "$RJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
      -d "{\"email\":\"smoke-renew-$who@smoke.test\",\"password\":\"renew-password-123\"}")" = "200" ] || { echo "FAIL: $who user login (R21)"; exit 1; }
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
# Banned (the quota user's session stays signed with the same session_ver:
# the reason alone must end the renewal scope).
psql_q "UPDATE users SET disabled_reason = 'admin', disabled_note = 'smoke' WHERE id='$RU'" >/dev/null
[ "$(code -b "$RJAR" "$BASE/api/v1/me/shop")" = "403" ] || { echo "FAIL: banned user listed the shop"; exit 1; }
[ "$(code -b "$RJAR" -X POST "$BASE/api/v1/me/orders" -H 'Content-Type: application/json' \
    -d "{\"plan_id\":\"$PAID_PLAN\",\"period\":\"days\"}")" = "403" ] || { echo "FAIL: banned user ordered"; exit 1; }
[ "$(code -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-renew-quota@smoke.test","password":"renew-password-123"}')" = "200" ] && last_json "d['banned']" | matches '^True$' \
  || { echo "FAIL: banned user not signed in to the portal scope"; exit 1; }
for who in expired quota; do
  RU=$(psql_q "SELECT id FROM users WHERE email='smoke-renew-$who@smoke.test'")
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$RU?confirm=true")" = "204" ] || { echo "FAIL: delete $who user"; exit 1; }
done
# Clean up for the following sections (the node serves nobody again).
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$BUYER?confirm=true")" = "204" ] || { echo "FAIL: delete buyer"; exit 1; }
wait_users 0 10 "buyer deleted"
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/plans/$PAID_PLAN")" = "204" ] || { echo "FAIL: delete paid plan"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/node-groups/$PAID_GROUP")" = "204" ] || { echo "FAIL: delete paid group"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM orders WHERE user_id IS NULL AND user_label='u-${BUYER:0:8}' AND plan_id IS NULL")" = "3" ] \
  || { echo "FAIL: orders not kept after user/plan deletion"; exit 1; }
echo "r18-3 payments: ok"
# Back to no main domain (later sections use the browser origin; orders
# that need the payment provider needed it until here).
"$PANEL" settings unset main >/dev/null || { echo "FAIL: settings unset main"; exit 1; }

echo "== W8 protocol matrix: every template -> agent -> three subscription formats -> real clients =="
# The agent's W8 matrix (SS2022, Hysteria 2, XHTTP, HTTPUpgrade, gRPC) came
# before protocol 4 bumped; protocol >= 4 implies it.
if need_agent "protocol>=4" "W8 protocol matrix"; then
  # shellcheck disable=SC2097,SC2098 # $LOG is the same value on both sides
  BASE="$BASE" SUB_PATH="$SUBP" JAR="$JAR" NODE_ID="$NODE_ID" ACCESS_PLAN="$ACCESS_PLAN" VALKEY_DB="$SMOKE_VALKEY_DB" LOG="$LOG" AGENT_LOG="$LOG/agent.log" \
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
  # shellcheck disable=SC2097,SC2098 # $LOG is the same value on both sides
  BASE="$BASE" SUB_PATH="$SUBP" JAR="$JAR" LOG="$LOG" AGENT="$AGENT" PEBBLE_API_ROOT="$LOG/acme/pebble-api.pem" \
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
last_json() { python3 -c "import json,sys; d=json.load(open('/tmp/akari-smoke/last')); print($1)"; }
api_json() { code -b "$1" -X "$2" "$3" -H 'Content-Type: application/json' -d "$4"; }
for who in smoke-tk-a smoke-tk-b; do
  [ "$(api_json "$JAR" POST "$BASE/api/v1/users" "{\"email\":\"$who@smoke.test\",\"password\":\"$who-password-123\"}")" = "201" ] \
    || { echo "FAIL: create $who"; cat /tmp/akari-smoke/last; exit 1; }
  code -c "$LOG/$who-cookies" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$who@smoke.test\",\"password\":\"$who-password-123\"}" >/dev/null
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
[ "$(code -b "$JAR" "$BASE/api/v1/tickets/$TK")" = "200" ] && last_json "d['thread'][0]['author_email']" | matches '^smoke-tk-a@smoke.test$' \
  || { echo "FAIL: staff ticket view"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/tickets/$TK/replies" '{"message":"smoke staff reply"}')" = "201" ] || { echo "FAIL: staff reply"; exit 1; }
[ "$(code -b "$TJA" "$BASE/api/v1/me/tickets")" = "200" ] \
  && [ "$(last_json "(d[0]['status'], d[0]['unread'])")" = "('answered', True)" ] || { echo "FAIL: customer list after reply"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$TJA" "$BASE/api/v1/me/tickets/$TK")" = "200" ] \
  && [ "$(last_json "[m['staff'] and 'author_email' not in m and 'author_label' not in m for m in d['messages']]")" = "[False, True]" ] \
  || { echo "FAIL: customer thread (staff identity must be hidden)"; cat /tmp/akari-smoke/last; exit 1; }
matches -F 'root@smoke.test' </tmp/akari-smoke/last && { echo "FAIL: staff address shown to a customer"; exit 1; }
[ "$(code -b "$TJA" -X POST "$BASE/api/v1/me/tickets/$TK/close")" = "204" ] || { echo "FAIL: customer close"; exit 1; }
[ "$(api_json "$TJA" POST "$BASE/api/v1/me/tickets/$TK/replies" '{"message":"x"}')" = "409" ] || { echo "FAIL: reply on a closed ticket"; exit 1; }
[ "$(psql_q "SELECT string_agg(action, ',' ORDER BY id) FROM audit_log WHERE target_id='$TK'")" = "ticket.create,ticket.reply,ticket.close" ] \
  || { echo "FAIL: ticket audit rows"; psql_q "SELECT action FROM audit_log WHERE target_id='$TK'"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE after::text LIKE '%smoke ticket body%'")" = "0" ] || { echo "FAIL: ticket text in the audit log"; exit 1; }
echo "tickets: ok"

echo "== Ops: announcements, knowledge base, branding, editable mail templates =="
# Announcements: visible one listed (sanitized HTML), a disabled one is the
# canonical rejection for the user; read state; customers refused on the admin API.
[ "$(api_json "$JAR" POST "$BASE/api/v1/announcements" '{"title_zh":"冒烟公告","body_zh":"**粗体** <script>x</script>","pinned":true}')" = "201" ] \
  || { echo "FAIL: create announcement"; cat /tmp/akari-smoke/last; exit 1; }
ANN=$(last_json "d['id']")
[ "$(api_json "$JAR" POST "$BASE/api/v1/announcements" '{"title_zh":"冒烟停用","body_zh":"x","enabled":false}')" = "201" ] || { echo "FAIL: create disabled announcement"; exit 1; }
ANN_OFF=$(last_json "d['id']")
[ "$(code -b "$TJA" "$BASE/api/v1/me/announcements")" = "200" ] \
  && [ "$(last_json "[(a['id'], a['read']) for a in d['announcements']] == [('$ANN', False)] and d['unread'] == 1")" = "True" ] \
  || { echo "FAIL: user announcement list"; cat /tmp/akari-smoke/last; exit 1; }
last_json "d['announcements'][0]['html_zh']" | matches -F '<strong>粗体</strong> &lt;script&gt;' || { echo "FAIL: announcement not sanitized"; cat /tmp/akari-smoke/last; exit 1; }
matches -F '<script>' </tmp/akari-smoke/last && { echo "FAIL: raw HTML in an announcement"; exit 1; }
[ "$(code -b "$TJA" -X POST "$BASE/api/v1/me/announcements/$ANN/read")" = "204" ] || { echo "FAIL: mark announcement read"; exit 1; }
[ "$(code -b "$TJA" "$BASE/api/v1/me/announcements")" = "200" ] && last_json "d['unread']" | matches -x 0 || { echo "FAIL: read state"; exit 1; }
for probe in "-X POST $BASE/api/v1/me/announcements/$ANN_OFF/read" "-X POST $BASE/api/v1/me/announcements/not-a-uuid/read"; do
  # shellcheck disable=SC2086
  [ "$(fp -b "$TJA" $probe)" = "$REJ" ] || { echo "FAIL: hidden announcement not the canonical rejection: $probe"; cat /tmp/akari-smoke/fphead; exit 1; }
done
[ "$(code -b "$TJA" "$BASE/api/v1/announcements")" = "403" ] || { echo "FAIL: customer reached the announcement admin"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/announcements/$ANN/mail" '{}')" = "409" ] && last_json "d['code']" | matches -x 'announcement.mail_unavailable' \
  || { echo "FAIL: mailing without SMTP"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/content/preview" '{"markdown":"[x](javascript:alert(1)) ![i](http://e/i.png)"}')" = "200" ] \
  && ! matches -F '<a ' </tmp/akari-smoke/last && ! matches -F '<img' </tmp/akari-smoke/last \
  || { echo "FAIL: preview let an unsafe link/image through"; cat /tmp/akari-smoke/last; exit 1; }
echo "announcements: ok"

# Knowledge base: published article searchable and readable; a draft is
# neither listed nor readable (canonical rejection).
[ "$(api_json "$JAR" POST "$BASE/api/v1/kb/categories" '{"name_zh":"冒烟分类","sort":1}')" = "201" ] || { echo "FAIL: create kb category"; exit 1; }
KBC=$(last_json "d['id']")
[ "$(api_json "$JAR" POST "$BASE/api/v1/kb/articles" '{"category_id":"'"$KBC"'","title_zh":"冒烟帮助","body_zh":"导入 *订阅* 的方法","published":true}')" = "201" ] || { echo "FAIL: create article"; exit 1; }
KBA=$(last_json "d['id']")
[ "$(api_json "$JAR" POST "$BASE/api/v1/kb/articles" '{"title_zh":"冒烟草稿","body_zh":"草稿","published":false}')" = "201" ] || { echo "FAIL: create draft"; exit 1; }
KBD=$(last_json "d['id']")
[ "$(code -b "$TJA" "$BASE/api/v1/me/help?q=%E8%AE%A2%E9%98%85")" = "200" ] \
  && [ "$(last_json "d['total']==1 and d['categories'][0]['articles'][0]['id']=='$KBA'")" = "True" ] \
  || { echo "FAIL: help search"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$TJA" "$BASE/api/v1/me/help")" = "200" ] && ! matches -F "$KBD" </tmp/akari-smoke/last || { echo "FAIL: draft listed"; exit 1; }
[ "$(code -b "$TJA" "$BASE/api/v1/me/help/$KBA")" = "200" ] && last_json "d['html_zh']" | matches -F '<em>订阅</em>' || { echo "FAIL: help article"; exit 1; }
[ "$(fp -b "$TJA" "$BASE/api/v1/me/help/$KBD")" = "$REJ" ] || { echo "FAIL: draft article not the canonical rejection"; cat /tmp/akari-smoke/fphead; exit 1; }
[ "$(code -b "$TJA" "$BASE/api/v1/kb/articles")" = "403" ] || { echo "FAIL: customer reached the kb admin"; exit 1; }
[ "$(psql_q "SELECT string_agg(action, ',' ORDER BY id) FROM audit_log WHERE target_id='$KBA'")" = "kb.article.create" ] || { echo "FAIL: kb audit"; exit 1; }
# W36-b: the portal's legal pages (public, no session): the published
# article with slug terms/privacy; a draft, another slug or none written =
# the canonical rejection (the portal then shows its neutral default).
[ "$(fp "$ROOT/api/v1/pages/terms")" = "$REJ" ] || { echo "FAIL: unwritten terms page not the canonical rejection"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/kb/articles" '{"title_zh":"冒烟条款","body_zh":"条款 *正文*","published":true,"slug":"terms"}')" = "201" ] || { echo "FAIL: create terms"; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/kb/articles" '{"title_zh":"冒烟隐私","body_zh":"草稿","published":false,"slug":"privacy"}')" = "201" ] || { echo "FAIL: create privacy draft"; exit 1; }
[ "$(code "$ROOT/api/v1/pages/terms")" = "200" ] && [ "$(last_json "d['title_zh']=='冒烟条款' and '<em>正文</em>' in d['html_zh']")" = "True" ] \
  || { echo "FAIL: public terms page"; cat /tmp/akari-smoke/last; exit 1; }
for p in privacy about; do
  [ "$(fp "$ROOT/api/v1/pages/$p")" = "$REJ" ] || { echo "FAIL: /pages/$p not the canonical rejection"; exit 1; }
done
[ "$(fp -X POST "$ROOT/api/v1/pages/terms")" = "$REJ" ] || { echo "FAIL: /pages/terms accepts POST"; exit 1; }
echo "knowledge base: ok"

# Branding: PNG only; served under the prefix with cache headers + ETag
# (304 on match); none stored = canonical rejection; public options carry it.
[ "$(fp "$BASE/brand/favicon")" = "$REJ" ] || { echo "FAIL: missing favicon is not the canonical rejection"; exit 1; }
python3 -c "import struct,sys; sys.stdout.buffer.write(b'\x89PNG\r\n\x1a\n'+struct.pack('>I',13)+b'IHDR'+struct.pack('>II',64,32)+bytes(9)+b'IEND'+bytes(64))" >"$LOG/logo.png"
[ "$(code -b "$JAR" -X PUT --data-binary 'GIF89a' -H 'Content-Type: application/octet-stream' "$BASE/api/v1/settings/branding/logo")" = "400" ] \
  && last_json "d['code']" | matches -x 'branding.image_not_png' || { echo "FAIL: non-PNG logo accepted"; exit 1; }
[ "$(code -b "$JAR" -X PUT --data-binary "@$LOG/logo.png" -H 'Content-Type: image/png' "$BASE/api/v1/settings/branding/logo")" = "200" ] \
  || { echo "FAIL: upload logo"; cat /tmp/akari-smoke/last; exit 1; }
BV=$(last_json "d['version']")
[ "$(code -D "$LOG/logo.h" "$BASE/brand/logo")" = "200" ] && cmp -s /tmp/akari-smoke/last "$LOG/logo.png" || { echo "FAIL: serve logo"; exit 1; }
tr -d '\r' <"$LOG/logo.h" | matches -ix 'cache-control: public, max-age=86400' || { echo "FAIL: logo cache headers"; cat "$LOG/logo.h"; exit 1; }
tr -d '\r' <"$LOG/logo.h" | matches -ix 'content-type: image/png' || { echo "FAIL: logo content type"; exit 1; }
LETAG=$(tr -d '\r' <"$LOG/logo.h" | awk -F': ' 'tolower($1)=="etag"{print $2}')
[ "$(code -H "If-None-Match: $LETAG" "$BASE/brand/logo")" = "304" ] || { echo "FAIL: logo 304"; exit 1; }
[ "$(api_json "$JAR" PUT "$BASE/api/v1/settings/branding" '{"version":'"$BV"',"footer_text":"冒烟页脚","tos_url":"javascript:x"}')" = "400" ] || { echo "FAIL: unsafe ToS link accepted"; exit 1; }
[ "$(api_json "$JAR" PUT "$BASE/api/v1/settings/branding" '{"version":'"$BV"',"footer_text":"冒烟页脚","tos_url":"https://example.com/tos","client_downloads":[{"platform":"android","url":"https://example.com/a.apk"}]}')" = "200" ] \
  || { echo "FAIL: save branding"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" PUT "$BASE/api/v1/settings/branding" '{"version":'"$BV"'}')" = "409" ] || { echo "FAIL: stale branding version accepted"; exit 1; }
[ "$(code "$BASE/auth/options")" = "200" ] \
  && [ "$(last_json "(d['branding']['footer_text'], d['branding']['logo_url'].startswith('brand/logo?v='), d['branding']['client_downloads'][0]['platform'])")" = "('冒烟页脚', True, 'android')" ] \
  || { echo "FAIL: public branding"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(code -b "$TJA" -X PUT --data-binary "@$LOG/logo.png" "$BASE/api/v1/settings/branding/logo")" = "403" ] || { echo "FAIL: customer uploaded a logo"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='settings.branding.logo' AND after ? 'bytes' AND length(after::text) < 400")" -ge 1 ] || { echo "FAIL: logo audit"; exit 1; }
echo "branding: ok"

# Editable mail templates: whitelist enforced, stored version used by the
# outbox (the registration code mail rendered for the next enqueue).
[ "$(code -b "$JAR" "$BASE/api/v1/settings/mail-templates")" = "200" ] && last_json "len(d)" | matches -x 32 || { echo "FAIL: template list"; exit 1; }
[ "$(api_json "$JAR" PUT "$BASE/api/v1/settings/mail-templates/password_reset/zh" '{"version":0,"subject":"x","body":"no link {nope}"}')" = "400" ] \
  && last_json "d['code']" | matches -x 'mail_template.placeholder_unknown' || { echo "FAIL: unknown placeholder accepted"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" PUT "$BASE/api/v1/settings/mail-templates/password_reset/zh" '{"version":0,"subject":"x","body":"没有链接"}')" = "400" ] \
  && last_json "d['code']" | matches -x 'mail_template.placeholder_missing' || { echo "FAIL: template without {link} accepted"; exit 1; }
[ "$(api_json "$JAR" PUT "$BASE/api/v1/settings/mail-templates/test/zh" '{"version":0,"subject":"冒烟模板 {site}","body":"冒烟自定义正文"}')" = "200" ] \
  || { echo "FAIL: save template"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(api_json "$JAR" POST "$BASE/api/v1/settings/mail-templates/preview" '{"kind":"test","locale":"zh","subject":"冒烟模板 {site}","body":"冒烟自定义正文"}')" = "200" ] \
  && last_json "d['text']" | matches -F '冒烟自定义正文' || { echo "FAIL: template preview"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/settings/mail-templates/test/zh")" = "200" ] && last_json "d['reset']" | matches True || { echo "FAIL: restore default"; exit 1; }
[ "$(psql_q "SELECT string_agg(action, ',' ORDER BY id) FROM audit_log WHERE target_id='test/zh'")" = "settings.mail_template.update,settings.mail_template.reset" ] \
  || { echo "FAIL: template audit"; exit 1; }
[ "$(code -b "$TJA" "$BASE/api/v1/settings/mail-templates")" = "403" ] || { echo "FAIL: customer reached the templates"; exit 1; }
echo "mail templates: ok"

# Node summary view: the list's columns only, ETag + 304.
[ "$(code -D "$LOG/sum.h" -b "$JAR" "$BASE/api/v1/nodes?view=summary")" = "200" ] || { echo "FAIL: summary view"; exit 1; }
ETAG=$(tr -d '\r' <"$LOG/sum.h" | awk -F': ' 'tolower($1)=="etag"{print $2}')
[ -n "$ETAG" ] || { echo "FAIL: summary view without ETag"; cat "$LOG/sum.h"; exit 1; }
tr -d '\r' <"$LOG/sum.h" | matches -i '^cache-control: private, no-cache$' || { echo "FAIL: summary cache-control"; exit 1; }
last_json "[n for n in d if n['id']=='$NODE_ID'][0]['online']" | matches True || { echo "FAIL: node not online in the summary"; exit 1; }
matches -F '"inbound"' </tmp/akari-smoke/last && { echo "FAIL: summary carries the inbound JSON"; exit 1; }
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
[ "$(code -b "$JAR" "$BASE/api/v1/nodes/$NODE_ID")" = "200" ] && matches -F '"inbound"' </tmp/akari-smoke/last \
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
    if h["x-akari-event"] == event and (d.get("alert") or {}).get("server_id") == node and d["alert"]["kind"] == "offline":
        print("ok"); sys.exit(0)
sys.exit(1)
PY
for _ in $(seq 1 60); do
  python3 "$LOG/hook-check.py" "$LOG/hook.jsonl" "$HOOK_SECRET" "$SERVER_ID" firing >/dev/null 2>&1 && break; sleep 2
done
python3 "$LOG/hook-check.py" "$LOG/hook.jsonl" "$HOOK_SECRET" "$SERVER_ID" firing \
  || { echo "FAIL: no signed firing webhook for the stopped agent"; cat "$LOG/hook.jsonl"; psql_q "SELECT * FROM server_alerts"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/alerts?status=firing&kind=offline&server=$SERVER_ID")" = "200" ] \
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
  python3 "$LOG/hook-check.py" "$LOG/hook.jsonl" "$HOOK_SECRET" "$SERVER_ID" resolved >/dev/null 2>&1 && break; sleep 1
done
python3 "$LOG/hook-check.py" "$LOG/hook.jsonl" "$HOOK_SECRET" "$SERVER_ID" resolved \
  || { echo "FAIL: no resolved webhook after the agent came back"; cat "$LOG/hook.jsonl"; exit 1; }
[ "$(psql_q "SELECT string_agg(status, ',') FROM server_alerts WHERE server_id='$SERVER_ID' AND kind='offline'")" = "resolved" ] \
  || { echo "FAIL: offline alert not resolved exactly once"; psql_q "SELECT * FROM server_alerts"; exit 1; }
# Later sections stop agents too: quiet channels again.
QUIET=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['version']=int(sys.argv[2]); d['webhook_enabled']=False; d.pop('webhook_secret'); print(json.dumps(d))" \
  "$ALERT_BODY" "$(psql_q "SELECT version FROM alert_settings")")
[ "$(api_json "$JAR" PUT "$BASE/api/v1/alerts/settings" "$QUIET")" = "200" ] || { echo "FAIL: quiet alert channels"; cat /tmp/akari-smoke/last; exit 1; }
kill "$HOOK_PID" 2>/dev/null || true
echo "alerts: ok (fired, signed webhook, resolved)"

echo "== Sprint 3b: server delete = empty state, then revoke + close; billing rows kept =="
# Some billed traffic on the node first (a user C with one VLESS round trip).
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-user-c@smoke.test","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create user C"; exit 1; }
USER_C=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
grant "$USER_C"
VLESS_C=$(account_of "$USER_C")
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
  [ "$(psql_q "SELECT count(*) FROM traffic_counters WHERE server_id='$SERVER_ID' AND user_id='$USER_C'")" -ge 1 ] && break; sleep 1
done
COUNTERS_BEFORE=$(psql_q "SELECT count(*) FROM traffic_counters WHERE server_id='$SERVER_ID'")
[ "$(psql_q "SELECT count(*) FROM traffic_counters WHERE server_id='$SERVER_ID' AND user_id='$USER_C'")" -ge 1 ] \
  || { echo "FAIL: user C's traffic never reached traffic_counters"; exit 1; }
[ "$(psql_q "SELECT traffic_used_bytes FROM users WHERE id='$USER_C'")" -ge 200000 ] \
  || { echo "FAIL: user C not billed: $(psql_q "SELECT traffic_used_bytes FROM users WHERE id='$USER_C'")"; exit 1; }
SERIAL=$(psql_q "SELECT cert_serial FROM servers WHERE id='$SERVER_ID'")
wait_port open 10
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/servers/$SERVER_ID")" = "202" ] || { echo "FAIL: delete server not 202"; cat /tmp/akari-smoke/last; exit 1; }
grep -q '"deleting":true' /tmp/akari-smoke/last || { echo "FAIL: delete response"; exit 1; }
[ "$(patch_code "$BASE/api/v1/nodes/$NODE_ID" '{"enabled": true}')" = "409" ] \
  && [ "$(last_json "d['code']")" = "server.deleting" ] || { echo "FAIL: node of a deleting server changed"; exit 1; }
wait_users 0 10 "server deleting"
wait_port closed 10
for _ in $(seq 1 40); do
  [ "$(psql_q "SELECT count(*) FROM servers WHERE id='$SERVER_ID'")" = "0" ] && break; sleep 1
done
[ "$(psql_q "SELECT count(*) FROM servers WHERE id='$SERVER_ID'")" = "0" ] || { echo "FAIL: server row not deleted"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM nodes WHERE id='$NODE_ID'")" = "0" ] || { echo "FAIL: its node outlived the server"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM revoked_certs WHERE cert_serial='$SERIAL' AND server_id='$SERVER_ID'")" = "1" ] \
  || { echo "FAIL: certificate not tombstoned"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM traffic_counters WHERE server_id='$SERVER_ID'")" = "$COUNTERS_BEFORE" ] \
  || { echo "FAIL: billing rows not kept"; exit 1; }
for _ in $(seq 1 15); do grep -q 'server deleted' "$LOG/agent.log" && break; sleep 1; done
grep '"msg":"channel closed"' "$LOG/agent.log" | matches 'Unauthenticated desc = server deleted' \
  || { echo "FAIL: agent stream not closed as deleted"; grep 'channel closed' "$LOG/agent.log" | tail -3; exit 1; }
# Reconnects with the same (revoked) certificate: accepted only to be closed.
for _ in $(seq 1 20); do grep -q 'certificate revoked' "$LOG/agent.log" && break; sleep 1; done
grep '"msg":"channel closed"' "$LOG/agent.log" | matches 'Unauthenticated desc = certificate revoked' \
  || { echo "FAIL: revoked certificate not closed on reconnect"; grep 'channel closed' "$LOG/agent.log" | tail -3; exit 1; }
port_open && { echo "FAIL: revoked agent serves again"; exit 1; }
vk exists "akari:server:online:$SERVER_ID" | matches 0 \
  || { echo "FAIL: online key left behind"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/servers/$SERVER_ID")" = "404" ] || { echo "FAIL: second delete not 404"; exit 1; }
code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
grep -q "$NODE_ID" /tmp/akari-smoke/last && { echo "FAIL: deleted node still listed"; exit 1; }
code -b "$JAR" "$BASE/api/v1/servers" >/dev/null
grep -q "$SERVER_ID" /tmp/akari-smoke/last && { echo "FAIL: deleted server still listed"; exit 1; }
# CLI: an offline server is deleted right away by the running panel.
# `--out -`: bootstrap on stdout (compose flow), progress on stderr.
"$PANEL" server add spare-node --out - >"$LOG/spare-bootstrap.toml" 2>"$LOG/spare-add.err"
grep -q '^enrollment_token = ' "$LOG/spare-bootstrap.toml" || { echo "FAIL: server add --out - lacks bootstrap on stdout"; exit 1; }
grep -q 'server registered' "$LOG/spare-add.err" || { echo "FAIL: server add --out - progress not on stderr"; exit 1; }
grep -q 'server registered' "$LOG/spare-bootstrap.toml" && { echo "FAIL: progress leaked into stdout bootstrap"; exit 1; }
SPARE_ID=$("$PANEL" server list | awk '$2=="spare-node"{print $1}')
"$PANEL" server delete "$SPARE_ID" | matches "deletion started" || { echo "FAIL: CLI server delete"; exit 1; }
for _ in $(seq 1 20); do
  [ "$(psql_q "SELECT count(*) FROM servers WHERE id='$SPARE_ID'")" = "0" ] && break; sleep 1
done
[ "$(psql_q "SELECT count(*) FROM servers WHERE id='$SPARE_ID'")" = "0" ] || { echo "FAIL: CLI-deleted offline server not reaped"; exit 1; }
# Never enrolled (pending, no certificate): nothing to revoke; its token died
# with the row.
[ "$(psql_q "SELECT count(*) FROM revoked_certs WHERE server_id='$SPARE_ID'")" = "0" ] || { echo "FAIL: pending server left a tombstone"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM server_enrollments WHERE server_id='$SPARE_ID'")" = "0" ] || { echo "FAIL: enrollment token outlived its server"; exit 1; }
kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
AGENT_PID=""
echo "server delete: ok (empty state, revoked, closed; $COUNTERS_BEFORE billing rows kept)"

echo "== M1-8 enrollment API, token reuse, certificate renewal (2nd instance, 60 s certificates) =="
# Admin API: create a node without server_id -> a server of its own with a
# one-time token + key-less bootstrap (201).
[ "$(code -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' -d '{"name":"api-node"}')" = "401" ] \
  || { echo "FAIL: anonymous node create"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' -d '{"name":"api-node"}')" = "201" ] \
  || { echo "FAIL: API node create"; cat /tmp/akari-smoke/last; exit 1; }
read -r API_NODE API_SERVER API_TOKEN < <(python3 -c "import json;d=json.load(open('/tmp/akari-smoke/last'));print(d['id'],d['server_id'],d['enrollment_token'])")
python3 -c "import json,sys;b=json.load(open('/tmp/akari-smoke/last'))['bootstrap'];sys.exit('PRIVATE KEY' in b or 'enrollment_token = \"$API_TOKEN\"' not in b)" \
  || { echo "FAIL: API bootstrap"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' -d '{"name":"api-node"}')" = "409" ] \
  || { echo "FAIL: duplicate node name not 409"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/servers/$API_SERVER/enroll-token")" = "200" ] || { echo "FAIL: API enroll-token"; exit 1; }
API_TOKEN2=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['enrollment_token'])")
[ "$API_TOKEN2" != "$API_TOKEN" ] || { echo "FAIL: enroll-token reused the token"; exit 1; }
code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
python3 -c "
import json; n=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$API_NODE'][0]
assert n['enrolled'] is False and n['enroll_token_expires_at'] and n['cert_not_after'] is None, n" \
  || { echo "FAIL: pending node view"; exit 1; }
[ "$(psql_q "SELECT encode(token_hash,'hex') FROM server_enrollments WHERE server_id='$API_SERVER'")" != "$API_TOKEN2" ] \
  || { echo "FAIL: token stored in clear"; exit 1; }

# Second panel instance (same DB/CA, multi-instance) issuing 60 s
# certificates: its agent must renew within about a minute.
cat >"$LOG/panel-b.toml" <<'TOML'
[web]
bind = "127.0.0.1:8081"
cookie_secure = false
[grpc]
bind = "127.0.0.1:8444"
TOML
# W25: certificate validity is a built-in constant (90 days); this
# instance shortens it with the TEST-ONLY limits variable.
AKARI_TEST_LIMITS="cert_validity_secs=60" "$PANEL" -c "$LOG/panel-b.toml" serve >"$LOG/panel-b.log" 2>&1 &
PANEL_B=$!
trap 'cleanup_upd; kill $PANEL_PID ${PANEL_B:+$PANEL_B} ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do [ "$(code "http://127.0.0.1:8081/$PREFIX/healthz")" = "200" ] && break; sleep 0.5; done
# W25: a setting saved on instance A applies on instance B as well
# (notify → reload on every instance): 安全 → 审计日志保留天数, read back as
# a second admin on B.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"admin2@smoke.test","password":"admin2-password","role":"admin"}')" = "201" ] || { echo "FAIL: create 2nd admin"; exit 1; }
ADMIN2=$(last_json "d['id']")
A2JAR="$LOG/admin2-cookies"
[ "$(code -c "$A2JAR" -X POST "http://127.0.0.1:8081/$PREFIX/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"admin2@smoke.test","password":"admin2-password"}')" = "200" ] || { echo "FAIL: 2nd admin login on B"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings"; exit 1; }
SV=$(last_json "d['version']")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/security" -H 'Content-Type: application/json' \
    -d "{\"version\":$SV,\"audit_retention_days\":30,\"extra_release_keys\":[\"$TEST_RELEASE_PUB TEST-ONLY\"]}")" = "200" ] \
  || { echo "FAIL: save security settings: $(cat /tmp/akari-smoke/last)"; exit 1; }
for _ in $(seq 1 20); do
  [ "$(code -b "$A2JAR" "http://127.0.0.1:8081/$PREFIX/api/v1/settings")" = "200" ] \
    && last_json "d['security']['audit_retention_days']['effective']" | matches '^30$' && break
  sleep 0.25
done
last_json "d['security']['audit_retention_days']['effective']" | matches '^30$' \
  || { echo "FAIL: a setting saved on A did not reach B"; cat /tmp/akari-smoke/last; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.security.update'")" = "1" ] || { echo "FAIL: security settings not audited"; exit 1; }
SV=$(psql_q "SELECT version FROM panel_settings")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/security" -H 'Content-Type: application/json' \
    -d "{\"version\":$SV,\"extra_release_keys\":[\"$TEST_RELEASE_PUB TEST-ONLY\"]}")" = "200" ] \
  || { echo "FAIL: default retention again: $(cat /tmp/akari-smoke/last)"; exit 1; }
# R47: only the owner (root) manages admins; ownership is handed over and
# back (admin2 on instance B).
ROOT_UID=$(psql_q "SELECT id FROM users WHERE email = 'root@smoke.test'")
B_API="http://127.0.0.1:8081/$PREFIX/api/v1"
[ "$(code -b "$A2JAR" -X DELETE "$B_API/users/$ROOT_UID?confirm=true")" = "403" ] \
  && last_json "d['code']" | matches '^user.owner_only$' || { echo "FAIL: a non-owner admin deleted the owner: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$ADMIN2/owner" -H 'Content-Type: application/json' -d '{"confirm":false}')" = "400" ] \
  && last_json "d['code']" | matches '^user.owner_confirm_required$' || { echo "FAIL: unconfirmed owner transfer"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$ADMIN2/owner" -H 'Content-Type: application/json' -d '{"confirm":true}')" = "204" ] \
  || { echo "FAIL: owner transfer: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(psql_q "SELECT email FROM users WHERE is_owner")" = "admin2@smoke.test" ] || { echo "FAIL: owner after transfer"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$ADMIN2?confirm=true")" = "403" ] \
  || { echo "FAIL: the former owner deleted the owner"; exit 1; }
[ "$(code -b "$A2JAR" -X POST "$B_API/users/$ROOT_UID/owner" -H 'Content-Type: application/json' -d '{"confirm":true}')" = "204" ] \
  || { echo "FAIL: owner transfer back: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'user.owner.transfer'")" = "2" ] || { echo "FAIL: owner transfers not audited"; exit 1; }
# Keep root the only admin (S4-2 assertions below).
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$ADMIN2?confirm=true")" = "204" ] || { echo "FAIL: delete 2nd admin"; exit 1; }
"$PANEL" -c "$LOG/panel-b.toml" server add renew-node --out "$LOG/renew-bootstrap.toml" >/dev/null
# The node domain is one database setting (instance A's port): this agent
# dials instance B (60 s certificates) under the same certificate name.
sed -i 's/^panel_addr = "127.0.0.1:8443"$/panel_addr = "127.0.0.1:8444"/' "$LOG/renew-bootstrap.toml"
grep -q '^panel_addr = "127.0.0.1:8444"$' "$LOG/renew-bootstrap.toml" || { echo "FAIL: renew bootstrap panel_addr"; cat "$LOG/renew-bootstrap.toml"; exit 1; }
RENEW_ID=$("$PANEL" server list | awk '$2=="renew-node"{print $1}')
"$AGENT" -config "$LOG/renew-bootstrap.toml" -state-dir "$LOG/state-renew" >"$LOG/renew-agent.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 15); do grep -q "channel established" "$LOG/renew-agent.log" && break; sleep 1; done
grep -q '"msg":"enrolled"' "$LOG/renew-agent.log" || { echo "FAIL: renew agent did not enroll"; cat "$LOG/renew-agent.log"; exit 1; }
for _ in $(seq 1 10); do [ "$(psql_q "SELECT status FROM servers WHERE id='$RENEW_ID'")" = "online" ] && break; sleep 1; done
[ "$(psql_q "SELECT status FROM servers WHERE id='$RENEW_ID'")" = "online" ] || { echo "FAIL: enrolled node not online"; exit 1; }
FIRST_SERIAL=$(psql_q "SELECT cert_serial FROM servers WHERE id='$RENEW_ID'")
# The same (used) token on a fresh state dir: refused, the agent exits.
REUSE_RC=0
timeout 20 "$AGENT" -config "$LOG/renew-bootstrap.toml" -state-dir "$LOG/state-reuse" >"$LOG/reuse-agent.log" 2>&1 || REUSE_RC=$?
[ "$REUSE_RC" = "1" ] && grep -q "enrollment refused" "$LOG/reuse-agent.log" \
  || { echo "FAIL: reused enrollment token not refused (rc $REUSE_RC)"; cat "$LOG/reuse-agent.log"; exit 1; }
[ "$(psql_q "SELECT cert_serial FROM servers WHERE id='$RENEW_ID'")" = "$FIRST_SERIAL" ] || { echo "FAIL: refused enrollment changed the server"; exit 1; }
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
[ "$(psql_q "SELECT cert_serial <> '$FIRST_SERIAL' AND cert_not_after > now() FROM servers WHERE id='$RENEW_ID'")" = "t" ] \
  || { echo "FAIL: server does not carry the renewed certificate"; exit 1; }
for a in server.enroll server.cert.renew server.cert.rotated; do
  [ "$(psql_q "SELECT count(*) > 0 FROM audit_log WHERE action='$a' AND actor_label='agent' AND target_id='$RENEW_ID'")" = "t" ] \
    || { echo "FAIL: $a not audited"; exit 1; }
done
grep -qE '"protocol":([3-9]|[1-9][0-9])' "$LOG/panel-b.log" || { echo "FAIL: agent does not speak protocol 3 (renewal + self-update)"; exit 1; }
code -b "$JAR" "$BASE/api/v1/servers" >/dev/null
python3 -c "
import json; n=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$RENEW_ID'][0]
assert n['enrolled'] and n['cert_not_after'] and n['enroll_token_expires_at'] is None, n
assert any('agent 证书将在' in w for w in n['warnings']), n['warnings']
assert n['heartbeat'] is None or 'uptime_seconds' in n['heartbeat'], n['heartbeat']" \
  || { echo "FAIL: enrolled server view"; exit 1; }
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
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/servers/$API_SERVER")" = "202" ] || { echo "FAIL: delete api-node's server"; exit 1; }
echo "enrollment + renewal: ok"

echo "== M1-7 audit log: admin view lists the actions, no secrets =="
[ "$(code -b "$JAR" "$BASE/api/v1/audit?limit=200")" = "200" ] || { echo "FAIL: audit list"; exit 1; }
for a in user.create node.create node.set_inbound node.update entrance.update user.plan.set user.ban user.unban user.delete \
         auth.login auth.login_failed user.sub_token.rotate server.create server.delete \
         server.enroll_token server.enroll server.cert.renew server.cert.rotated; do
  # (By database: the API's 200 newest rows no longer reach back to the
  # first actions since later sections (W21 …) audit more.)
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='$a'")" -ge 1 ] || { echo "FAIL: audit lacks $a"; exit 1; }
done
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE actor_label='cli'")" -ge 1 ] || { echo "FAIL: CLI actions not audited as cli"; exit 1; }
grep -q '"actor_label":' /tmp/akari-smoke/last || { echo "FAIL: audit rows lack the actor label"; exit 1; }
# Q4: no address in any snapshot label column.
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE actor_label LIKE '%@%'")" = "0" ] || { echo "FAIL: an address in audit_log.actor_label"; exit 1; }
for secret in "$ADMIN_PW" "$NEW_TOKEN" "$VLESS_A" "user-password-123" '$argon2' \
              "$TOKEN" "$API_TOKEN" "$API_TOKEN2"; do
  grep -qF -- "$secret" /tmp/akari-smoke/last && { echo "FAIL: audit log contains a secret"; exit 1; }
done
[ "$(code -b "$JAR" "$BASE/api/v1/audit?action=auth.&limit=5")" = "200" ] || { echo "FAIL: audit filter"; exit 1; }
python3 -c "import json; d=json.load(open('/tmp/akari-smoke/last')); assert d['entries'] and all(e['action'].startswith('auth.') for e in d['entries'])" \
  || { echo "FAIL: audit action filter"; exit 1; }
# smoke-user is gone by now; rl-user (role user) is the non-admin.
[ "$(code -c "$UJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"rl-user@smoke.test","password":"rl-user-password"}')" = "200" ] || { echo "FAIL: rl-user login"; exit 1; }
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
# vN+2 is broken: it exits at once (the updater must roll it back). It
# carries the installed release's units (W23: the updater reads them with
# -print-units before installing; a release without them is refused).
printf '#!/bin/sh\nif [ "$1" = -print-units ]; then exec /usr/local/bin/akari-agent -print-units; fi\necho "broken agent build" >&2\nexit 3\n' >"$UPD/v2/akari-agent"
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
  UPD_SRV=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['server_id'])")
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
  upd_node() { psql_q "SELECT $1 FROM servers WHERE id='$UPD_SRV'"; }
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
      -d "{\"version\":\"v900.0.1\",\"server_ids\":[\"$UPD_SRV\"],\"health_timeout_secs\":90}")" = "201" ] \
    || { echo "FAIL: rollout create"; cat /tmp/akari-smoke/last; exit 1; }
  RO1=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
  ro_status() { psql_q "SELECT status FROM rollouts WHERE id='$1'"; }
  for _ in $(seq 1 90); do [ "$(ro_status "$RO1")" = "completed" ] && break; sleep 1; done
  upd_logs
  [ "$(ro_status "$RO1")" = "completed" ] || { echo "FAIL: rollout to v900.0.1 not completed ($(ro_status "$RO1"))"; \
    psql_q "SELECT status, detail FROM rollout_servers WHERE rollout_id='$RO1'"; tail -20 "$LOG/upd-agent.log" "$LOG/upd-updater.log"; exit 1; }
  [ "$(upd_node agent_version)" = "v900.0.1" ] || { echo "FAIL: node not on v900.0.1"; exit 1; }
  [ "$(psql_q "SELECT status FROM rollout_servers WHERE rollout_id='$RO1'")" = "healthy" ] || { echo "FAIL: node not healthy"; exit 1; }
  for m in "update offer accepted" "agent update verified and staged" "switching to the new agent" "agent update passed its self-check"; do
    grep -q "$m" "$LOG/upd-agent.log" || { echo "FAIL: agent log lacks '$m'"; tail -20 "$LOG/upd-agent.log"; exit 1; }
  done
  # The panel's health gate can pass before the updater's next poll (1 s)
  # sees the agent's confirmation: wait for its verdict.
  for _ in $(seq 1 15); do grep -q "agent update passed its self-check" "$LOG/upd-updater.log" && break; sleep 1; upd_logs; done
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
  upd_closed() { udx 'cat /var/lib/akari-agent-update/updater.json' | python3 -c "import json,sys; s=json.load(sys.stdin); assert 'trial' not in s, s"; }
  for _ in $(seq 1 10); do upd_closed 2>/dev/null && break; sleep 1; done
  upd_closed || { echo "FAIL: updater probation not closed"; exit 1; }
  code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
  python3 -c "
import json; n=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$UPD_ID'][0]
assert n['update_status']['status']=='healthy' and n['agent_version']=='v900.0.1', n['update_status']
assert 'updater' in n['agent_capabilities'] and not any('重装命令' in w for w in n['warnings']), n" \
    || { echo "FAIL: node view update status"; exit 1; }
  echo "update to v900.0.1 (updater unit): ok"
  if need_agent cap:metrics-presence "W23 units from the release + machine metrics under the shipped unit"; then
    # The installer took the units from the release (-print-unit), the
    # update kept them in step, and under them every machine metric is
    # read (the pre-W23 ProcSubset=pid hid /proc: all 0).
    for u in akari-agent.service akari-agent-update.service akari-agent-update.path; do
      udx "/usr/local/bin/akari-agent -print-unit $u | cmp -s - /etc/systemd/system/$u" \
        || { echo "FAIL: $u on the node is not the release's"; exit 1; }
    done
    grep -q "this agent release does not carry its systemd units" "$LOG/upd-install.out" \
      && { echo "FAIL: installer fell back to its own unit copies"; exit 1; }
    upd_hb() {
      code -b "$JAR" "$BASE/api/v1/servers/$UPD_SRV/status" >/dev/null
      python3 -c "
import json; v = json.load(open('/tmp/akari-smoke/last')); hb = v['heartbeat'] or {}; m = hb.get('metrics') or {}
nulls = [k for k in ('cpu_percent', 'mem_total_bytes') if hb.get(k) is None]
nulls += [k for k in ('load1', 'cpu_count', 'swap_total_bytes', 'disk_total_bytes', 'net_rx_bytes_total',
                      'net_rx_bytes_per_sec', 'tcp_sockets', 'process_rss_bytes') if m.get(k) is None]
assert not nulls and hb['mem_total_bytes'] > 0 and m['cpu_count'] > 0, (nulls, hb)
"
    }
    for _ in $(seq 1 60); do upd_hb 2>/dev/null && break; sleep 1; done
    upd_hb || { echo "FAIL: machine metrics unknown under the shipped unit"; cat /tmp/akari-smoke/last; exit 1; }
    [ "$(psql_q "SELECT 'stale-units' = ANY(agent_capabilities) FROM servers WHERE id='$UPD_SRV'")" = "f" ] \
      || { echo "FAIL: fresh install reports stale units"; exit 1; }
    echo "w23 units + machine metrics on a systemd node: ok"
  fi

  # Broken vN+2: the binary dies on start; the updater sees the restarts,
  # puts v900.0.1 back; the agent reports ROLLED_BACK; the rollout halts.
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts" -H 'Content-Type: application/json' \
      -d "{\"version\":\"v900.0.2\",\"server_ids\":[\"$UPD_SRV\"],\"health_timeout_secs\":90}")" = "201" ] \
    || { echo "FAIL: rollout 2 create"; cat /tmp/akari-smoke/last; exit 1; }
  RO2=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
  for _ in $(seq 1 90); do [ "$(ro_status "$RO2")" = "halted" ] && break; sleep 1; done
  upd_logs
  [ "$(ro_status "$RO2")" = "halted" ] || { echo "FAIL: broken rollout not halted ($(ro_status "$RO2"))"; \
    psql_q "SELECT status, detail FROM rollout_servers WHERE rollout_id='$RO2'"; tail -20 "$LOG/upd-agent.log" "$LOG/upd-updater.log"; exit 1; }
  psql_q "SELECT detail FROM rollout_servers WHERE rollout_id='$RO2'" | matches "rolled back" \
    || { echo "FAIL: no rollback report: $(psql_q "SELECT status, detail FROM rollout_servers WHERE rollout_id='$RO2'")"; exit 1; }
  grep -q "broken agent build" "$LOG/upd-agent.log" || { echo "FAIL: broken build never ran"; exit 1; }
  grep -q "rolling back agent update" "$LOG/upd-updater.log" || { echo "FAIL: updater did not roll back"; exit 1; }
  for _ in $(seq 1 20); do [ "$(upd_node agent_version)" = "v900.0.1" ] && [ "$(upd_node status)" = "online" ] && break; sleep 1; done
  [ "$(upd_node agent_version)" = "v900.0.1" ] || { echo "FAIL: node not back on v900.0.1"; exit 1; }
  udx '/usr/local/bin/akari-agent -version' | matches "akari-agent v900.0.1 " || { echo "FAIL: binary not rolled back"; exit 1; }
  udx 'cat /var/lib/akari-agent-update/updater.json' | python3 -c "import json,sys; s=json.load(sys.stdin); assert 'v900.0.2' in s['rolled_back'] and 'trial' not in s, s" \
    || { echo "FAIL: updater state after rollback"; exit 1; }
  udx 'cat /var/lib/private/akari-agent/update/state.json' | python3 -c "import json,sys; s=json.load(sys.stdin); assert 'v900.0.2' in s['rolled_back'], s" \
    || { echo "FAIL: agent state after rollback"; exit 1; }
  [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action='rollout.halt' AND actor_label='system'")" = "1" ] \
    || { echo "FAIL: halt not audited"; exit 1; }
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts/$RO2/resume")" = "409" ] || { echo "FAIL: halted rollout resumed"; exit 1; }
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/rollouts/$RO2/abort")" = "200" ] || { echo "FAIL: abort"; exit 1; }
  [ "$(code -b "$JAR" "$BASE/api/v1/rollouts")" = "200" ] && grep -q '"aborted"' /tmp/akari-smoke/last || { echo "FAIL: rollout list"; exit 1; }
  for a in agent_release.create agent_release.upload rollout.create rollout.complete rollout.abort; do
    [ "$(psql_q "SELECT count(*) > 0 FROM audit_log WHERE action='$a'")" = "t" ] || { echo "FAIL: $a not audited"; exit 1; }
  done
  # W23: a hand-edited unit is reported (capability "stale-units" -> the
  # node view asks for the install command).
  if agent_has cap:metrics-presence; then
    udx "printf '# local edit\n' >>/etc/systemd/system/akari-agent.service && systemctl daemon-reload && systemctl restart akari-agent"
    for _ in $(seq 1 30); do [ "$(psql_q "SELECT 'stale-units' = ANY(agent_capabilities) FROM servers WHERE id='$UPD_SRV'")" = "t" ] && break; sleep 1; done
    code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
    python3 -c "
import json; n=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$UPD_ID'][0]
assert 'stale-units' in n['agent_capabilities'] and any('systemd 单元' in w and '重装命令' in w for w in n['warnings']), n['warnings']" \
      || { echo "FAIL: stale units not reported"; exit 1; }
  fi
  # W23: the reinstall (重装命令) supersedes the aborted rollout's failure:
  # the node view shows it as history. The installer serves the newest
  # release: drop the broken one first.
  REL2=$(psql_q "SELECT id FROM agent_releases WHERE version='v900.0.2'")
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/agent-releases/$REL2")" = "204" ] \
    || { echo "FAIL: delete broken release: $(cat /tmp/akari-smoke/last)"; exit 1; }
  code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
  python3 -c "
import json; n=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$UPD_ID'][0]
assert n['update_status']['rollout_status']=='aborted' and n['update_status']['superseded'] is False, n['update_status']" \
    || { echo "FAIL: update status before the reinstall"; exit 1; }
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/servers/$UPD_SRV/install" -H 'Content-Type: application/json' \
      -d '{"origin":"http://127.0.0.1:8080"}')" = "200" ] || { echo "FAIL: upd-node re-install link"; exit 1; }
  UPD_CMD2=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['command'])")
  udx "$UPD_CMD2" >"$LOG/upd-reinstall.out" 2>&1 || { echo "FAIL: reinstall (update node)"; cat "$LOG/upd-reinstall.out"; exit 1; }
  # As root on an image without sudo: the plain uninstall form.
  grep -q "uninstall later with (as root): /usr/local/sbin/akari-agent-uninstall" "$LOG/upd-reinstall.out" \
    || { echo "FAIL: uninstall hint"; cat "$LOG/upd-reinstall.out"; exit 1; }
  grep -q "sudo /usr/local/sbin" "$LOG/upd-reinstall.out" && { echo "FAIL: sudo hint without sudo"; exit 1; }
  code -b "$JAR" "$BASE/api/v1/nodes" >/dev/null
  python3 -c "
import json; n=[x for x in json.load(open('/tmp/akari-smoke/last')) if x['id']=='$UPD_ID'][0]
assert n['update_status']['superseded'] is True, n['update_status']" \
    || { echo "FAIL: aborted rollout not superseded by the reinstall"; exit 1; }
  if agent_has cap:metrics-presence; then
    for _ in $(seq 1 30); do [ "$(psql_q "SELECT 'stale-units' = ANY(agent_capabilities) FROM servers WHERE id='$UPD_SRV'")" = "f" ] && break; sleep 1; done
    [ "$(psql_q "SELECT 'stale-units' = ANY(agent_capabilities) FROM servers WHERE id='$UPD_SRV'")" = "f" ] \
      || { echo "FAIL: reinstall did not replace the edited unit"; exit 1; }
  fi
  echo "w23 reinstall: update status superseded, units current, uninstall hint: ok"
  # Uninstall removes the updater as well.
  udx 'akari-agent-uninstall' >>"$LOG/upd-install.out" 2>&1 || { echo "FAIL: uninstall (update node)"; exit 1; }
  udx 'test ! -e /etc/systemd/system/akari-agent-update.path && test ! -e /etc/systemd/system/akari-agent-update.service && test ! -e /var/lib/akari-agent-update && test ! -e /usr/local/bin/akari-agent.prev' \
    || { echo "FAIL: uninstall left the updater behind"; exit 1; }
  cleanup_upd
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/servers/$UPD_SRV")" = "202" ] || { echo "FAIL: delete upd-node's server"; exit 1; }
  echo "m6 self-update: ok (installer + updater unit on systemd 257, noexec state dir: v900.0.0 -> v900.0.1 healthy; broken v900.0.2 rolled back, rollout halted)"
else
  # The installer section below still needs the releases.
  upd_rel_store
  upd_upload "$UPD/v1/akari-agent" >/dev/null
  upd_upload "$UPD/v2/akari-agent" >/dev/null
fi

echo "== R18-2 node form + one-line installer: template inbounds, install link, Debian 13 container =="
# The newest complete release is what the installer serves: drop the broken
# v900.0.2 of the M6 section (its rollout is over; the M6 section already
# did when it ran), leaving v900.0.1.
REL2=$(psql_q "SELECT id FROM agent_releases WHERE version='v900.0.2'")
if [ -n "$REL2" ]; then
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/agent-releases/$REL2")" = "204" ] \
    || { echo "FAIL: delete broken release: $(cat /tmp/akari-smoke/last)"; exit 1; }
fi
[ "$(psql_q "SELECT count(*) FROM agent_releases WHERE version='v900.0.2'")" = "0" ] || { echo "FAIL: broken release kept"; exit 1; }
# Templates catalog + render (REALITY keys made by the panel).
[ "$(code -b "$JAR" "$BASE/api/v1/inbound-templates")" = "200" ] && grep -q '"www.apple.com"' /tmp/akari-smoke/last \
  || { echo "FAIL: template catalog"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/inbound-templates/render" -H 'Content-Type: application/json' \
    -d '{"template":{"template":"vless_reality","port":443},"taken_ports":[443]}')" = "400" ] \
  && last_json "d['code']" | matches -x 'template.port_clash' || { echo "FAIL: a taken template port accepted"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/inbound-templates/render" -H 'Content-Type: application/json' \
    -d '{"template":{"template":"vless_reality","port":443}}')" = "200" ] && last_json "d['inbound']['protocol']" | matches -x vless \
  || { echo "FAIL: render one template"; cat /tmp/akari-smoke/last; exit 1; }
INST_PORT_R=24443
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' \
    -d '{"name":"x-node","template":{"template":"vmess_tcp","port":1},"inbound":{"protocol":"vmess","port":1}}')" = "400" ] \
  && last_json "d['code']" | matches -x 'node.template_and_inbound' || { echo "FAIL: template + inbound accepted"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' \
    -d "{\"name\":\"inst-node\",\"region\":\"Smoke\",\"direct\":{\"connect_host\":\"127.0.0.1\",\"rate\":2},
         \"template\":{\"template\":\"vless_reality\",\"port\":$INST_PORT_R},
         \"install\":{\"origin\":\"http://127.0.0.1:8080\"}}")" = "201" ] \
  || { echo "FAIL: create node with a template: $(cat /tmp/akari-smoke/last)"; exit 1; }
cp /tmp/akari-smoke/last "$LOG/inst-create.json"
INST_ID=$(python3 -c "import json;print(json.load(open('$LOG/inst-create.json'))['id'])")
INST_SRV=$(python3 -c "import json;print(json.load(open('$LOG/inst-create.json'))['server_id'])")
INST_URL=$(python3 -c "import json;print(json.load(open('$LOG/inst-create.json'))['install']['url'])")
INST_CMD=$(python3 -c "import json;print(json.load(open('$LOG/inst-create.json'))['install']['command'])")
python3 - "$LOG/inst-create.json" "$INST_URL" <<'PY' || { echo "FAIL: create response"; exit 1; }
import base64, json, sys
v = json.load(open(sys.argv[1])); i = v["install"]
as_root = "sh -c '[ \"$(id -u)\" = 0 ] || exec sudo sh; exec sh'"
# A missing curl/wget stops with how to install it (test deployment P3).
need = lambda t: "sh -c 'command -v %s >/dev/null || { echo " % t
assert i["command"].startswith(need("curl")) and "apt-get install -y curl" in i["command"], i["command"]
assert i["command"].endswith("' && curl -fsSL '%s' | %s" % (sys.argv[2], as_root)), i["command"]
assert i["command_wget"].startswith(need("wget")), i["command_wget"]
assert i["command_wget"].endswith("' && wget -qO- '%s' | %s" % (sys.argv[2], as_root)), i["command_wget"]
assert i["pin"] is None
assert i["releases"]["amd64"]["version"] == "v900.0.1", i["releases"]
assert sys.argv[2].endswith("/install/" + v["enrollment_token"])
PY
psql_q "SELECT inbound FROM nodes WHERE id='$INST_ID'" | python3 -c "
import json, sys; ib = json.load(sys.stdin)
r = ib['streamSettings']['realitySettings']
assert ib['port'] == $INST_PORT_R and r['dest'] == 'www.apple.com:443' and len(r['privateKey']) == 43 and len(r['publicKey']) == 43
assert 'tag' not in ib" \
  || { echo "FAIL: template inbound not stored"; exit 1; }
[ "$(psql_q "SELECT kind || ' ' || connect_host || ' ' || rate_permille FROM entrances WHERE node_id='$INST_ID'")" = "direct 127.0.0.1 2000" ] \
  || { echo "FAIL: create did not set the direct entrance"; exit 1; }
# D4/D11: the install link is a public path of its own: neither the link
# nor the script carries the admin prefix.
case "$INST_URL" in "$ROOT/install/"*) ;; *) echo "FAIL: install link not at /install/: $INST_URL"; exit 1;; esac
# The script: complete, POSIX sh, shellcheck-clean.
[ "$(code "$INST_URL")" = "200" ] || { echo "FAIL: install script not served"; exit 1; }
cp /tmp/akari-smoke/last "$LOG/install.sh"
grep -qF "$PREFIX" "$LOG/install.sh" && { echo "FAIL: the install script carries the admin prefix"; exit 1; }
grep -q '@@' "$LOG/install.sh" && { echo "FAIL: placeholder left in the script"; exit 1; }
sh -n "$LOG/install.sh" || { echo "FAIL: script does not parse"; exit 1; }
if [ "${SMOKE_SHELLCHECK:-1}" = 1 ]; then
  docker run --rm -v "$LOG:/mnt:ro" koalaman/shellcheck:stable -s sh /mnt/install.sh \
    || { echo "FAIL: shellcheck"; exit 1; }
fi
# Unknown arch / bad token: the canonical rejection.
for p in "$INST_URL/agent/amd64" "$INST_URL/agent/$(printf "%064d" 0)" "${INST_URL%?}x" "$ROOT/install/short"; do
  [ "$(fp "$p")" = "$REJ" ] || { echo "FAIL: install rejection differs for $p"; exit 1; }
done
# W32: the installer turns on TCP BBR + fq where it can. The test nodes
# share the host's network namespace (--network host, privileged): what the
# installer sets is the host's, and the uninstaller must put it back. On
# GitHub's runners tcp_bbr is a module nobody loaded (containers cannot
# load modules): load it, as on a VPS whose kernel has BBR.
if [ -n "${GITHUB_ACTIONS:-}" ]; then sudo modprobe tcp_bbr 2>/dev/null || true; fi
host_cc() { echo "$(cat /proc/sys/net/core/default_qdisc 2>/dev/null) $(cat /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null)"; }
# bbr_installed CONTAINER OUTPUT: what the installer said matches the node
# and the host; prints "enabled" or "skipped".
bbr_installed() {
  if grep -q "BBR + fq: enabled (was " "$2"; then
    docker exec "$1" sh -c 'grep -q "^# akari-previous: net.core.default_qdisc=" /etc/sysctl.d/90-akari-bbr.conf &&
      grep -q "^net.ipv4.tcp_congestion_control = bbr$" /etc/sysctl.d/90-akari-bbr.conf &&
      grep -q "^tcp_bbr$" /etc/modules-load.d/akari-bbr.conf' || { echo "FAIL: BBR drop-in on $1" >&2; return 1; }
    [ "$(host_cc)" = "fq bbr" ] || { echo "FAIL: BBR + fq not in effect: $(host_cc)" >&2; return 1; }
    echo enabled
  elif matches -E "BBR \+ fq: (skipped|already enabled)" "$2"; then
    docker exec "$1" test ! -e /etc/sysctl.d/90-akari-bbr.conf || { echo "FAIL: BBR drop-in although skipped" >&2; return 1; }
    echo skipped
  else
    echo "FAIL: the installer said nothing about BBR" >&2; return 1
  fi
}
if [ "${SMOKE_INSTALL_CONTAINER:-1}" = 1 ]; then
  BBR_BEFORE=$(host_cc)
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
  BBR_STATE=$(bbr_installed akari-smoke-node "$LOG/install.out") || { cat "$LOG/install.out"; exit 1; }
  for _ in $(seq 1 20); do [ "$(psql_q "SELECT status FROM servers WHERE id='$INST_SRV'")" = "online" ] && break; sleep 1; done
  [ "$(psql_q "SELECT status FROM servers WHERE id='$INST_SRV'")" = "online" ] || { echo "FAIL: installed node not online"; exit 1; }
  for _ in $(seq 1 20); do [ "$(psql_q "SELECT agent_version FROM servers WHERE id='$INST_SRV'")" = "v900.0.1" ] && break; sleep 1; done
  [ "$(psql_q "SELECT agent_version || ' ' || coalesce(last_error, 'ok') FROM servers WHERE id='$INST_SRV'")" = "v900.0.1 ok" ] \
    || { echo "FAIL: installed agent: $(psql_q "SELECT agent_version, last_error FROM servers WHERE id='$INST_SRV'")"; exit 1; }
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
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/servers/$INST_SRV/install" -H 'Content-Type: application/json' \
      -d '{"origin":"http://127.0.0.1:8080"}')" = "200" ] || { echo "FAIL: re-install link"; exit 1; }
  INST_URL2=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['url'])")
  docker exec akari-smoke-node sh -c "curl -fsSL '$INST_URL2' | sh -s -- --uninstall" >>"$LOG/install.out" 2>&1 \
    || { echo "FAIL: uninstall"; tail -5 "$LOG/install.out"; exit 1; }
  docker exec akari-smoke-node sh -c 'test ! -e /usr/local/bin/akari-agent && test ! -e /etc/akari-agent && ! systemctl is-active -q akari-agent' \
    || { echo "FAIL: uninstall left files or a running agent"; exit 1; }
  # W32: the uninstaller removed the BBR drop-in and put the previous
  # settings back.
  docker exec akari-smoke-node sh -c 'test ! -e /etc/sysctl.d/90-akari-bbr.conf && test ! -e /etc/modules-load.d/akari-bbr.conf' \
    || { echo "FAIL: uninstall left the BBR drop-in"; exit 1; }
  [ "$(host_cc)" = "$BBR_BEFORE" ] || { echo "FAIL: uninstall did not restore '$BBR_BEFORE' ($(host_cc), BBR $BBR_STATE)"; exit 1; }
  # The reinstall without BBR (--no-bbr): nothing changed.
  docker exec akari-smoke-node sh -c "curl -fsSL '$INST_URL2' | sh -s -- --no-bbr" >"$LOG/install-nobbr.out" 2>&1 \
    || { echo "FAIL: reinstall"; tail -20 "$LOG/install-nobbr.out"; exit 1; }
  grep -q "BBR + fq: not changed (--no-bbr)" "$LOG/install-nobbr.out" || { echo "FAIL: --no-bbr"; cat "$LOG/install-nobbr.out"; exit 1; }
  docker exec akari-smoke-node test ! -e /etc/sysctl.d/90-akari-bbr.conf || { echo "FAIL: --no-bbr wrote the drop-in"; exit 1; }
  [ "$(host_cc)" = "$BBR_BEFORE" ] || { echo "FAIL: --no-bbr changed $(host_cc)"; exit 1; }
  cat "$LOG/install-nobbr.out" >>"$LOG/install.out"
  [ "$(fp "$INST_URL2")" = "$REJ" ] || { echo "FAIL: second link not burned"; exit 1; }
  docker exec akari-smoke-node akari-agent-uninstall >>"$LOG/install.out" 2>&1 || { echo "FAIL: uninstall helper"; exit 1; }
  docker rm -f akari-smoke-node >/dev/null
  eval "$PREV_EXIT_TRAP"
  echo "installer (container): ok (BBR + fq $BBR_STATE, restored by the uninstaller)"
else
  echo "installer container test skipped (SMOKE_INSTALL_CONTAINER=0)"
fi
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/servers/$INST_SRV")" = "202" ] || { echo "FAIL: delete inst-node's server"; exit 1; }
echo "r18-2 node install: ok"

echo "== W32 Alpine node: one-line installer under OpenRC, BBR + fq, reinstall without BBR, uninstall =="
# The same installer on Alpine: OpenRC scripts from the release
# (-print-unit), a system user, the state directory noexec, the updater
# service; the self-update path under OpenRC is akari-agent's openrc-test.
if need_agent "unit:akari-agent" "W32 Alpine install (OpenRC)" \
   && { [ "${SMOKE_INSTALL_CONTAINER:-1}" = 1 ] || { echo "Alpine container test skipped (SMOKE_INSTALL_CONTAINER=0)"; false; }; }; then
  ALP_PORT=26443
  # The sections above used up most of this address's install-link budget
  # (20 requests / 10 min per source, Valkey): start this node afresh.
  vk eval "for _, k in ipairs(redis.call('keys', 'akari:rl:install:*')) do redis.call('del', k) end" 0 >/dev/null
  # Its two enrollments come back at the end (later sections enroll from
  # the same address within the 10-minute window).
  ALP_RL=$(vk eval "local o = {} for _, k in ipairs(redis.call('keys', 'akari:rl:enroll:*')) do o[#o+1] = k .. '=' .. redis.call('get', k) end return table.concat(o, ' ')" 0)
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' \
      -d "{\"name\":\"alp-node\",\"direct\":{\"connect_host\":\"127.0.0.1\"},\"template\":{\"template\":\"vless_reality\",\"port\":$ALP_PORT},
           \"install\":{\"origin\":\"http://127.0.0.1:8080\"}}")" = "201" ] \
    || { echo "FAIL: create alp-node: $(cat /tmp/akari-smoke/last)"; exit 1; }
  ALP_ID=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['server_id'])")
  ALP_CMD=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['install']['command'])")
  BBR_BEFORE=$(host_cc)
  docker build -q -t akari-node-test:alpine3.22 scripts/install-test-alpine >/dev/null
  docker rm -f akari-smoke-alp >/dev/null 2>&1 || true
  docker run -d --init --name akari-smoke-alp --network host --privileged akari-node-test:alpine3.22 >/dev/null
  PREV_EXIT_TRAP=$(trap -p EXIT)
  trap 'docker rm -f akari-smoke-alp >/dev/null 2>&1 || true; cleanup_upd; kill $PANEL_PID ${PANEL_B:+$PANEL_B} ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT
  ax() { docker exec akari-smoke-alp sh -c "$1"; }
  for _ in $(seq 1 30); do ax 'test -e /run/openrc/softlevel && rc-status >/dev/null 2>&1' && break; sleep 0.5; done
  ax "$ALP_CMD" >"$LOG/alp-install.out" 2>&1 || { echo "FAIL: installer (Alpine)"; cat "$LOG/alp-install.out"; exit 1; }
  grep -q "SUCCESS: the agent enrolled and is connected" "$LOG/alp-install.out" || { echo "FAIL: Alpine installer output"; cat "$LOG/alp-install.out"; exit 1; }
  grep -q "uninstall later with (as root): /usr/local/sbin/akari-agent-uninstall" "$LOG/alp-install.out" \
    || { echo "FAIL: Alpine uninstall hint"; cat "$LOG/alp-install.out"; exit 1; }
  ALP_BBR=$(bbr_installed akari-smoke-alp "$LOG/alp-install.out") || { cat "$LOG/alp-install.out"; exit 1; }
  for _ in $(seq 1 20); do [ "$(psql_q "SELECT status || ' ' || coalesce(agent_version, '-') FROM servers WHERE id='$ALP_ID'")" = "online v900.0.1" ] && break; sleep 1; done
  [ "$(psql_q "SELECT status || ' ' || coalesce(agent_version, '-') || ' ' || coalesce(last_error, 'ok') FROM servers WHERE id='$ALP_ID'")" = "online v900.0.1 ok" ] \
    || { echo "FAIL: Alpine node: $(psql_q "SELECT status, agent_version, last_error FROM servers WHERE id='$ALP_ID'")"; exit 1; }
  for _ in $(seq 1 20); do (exec 3<>/dev/tcp/127.0.0.1/$ALP_PORT) 2>/dev/null && break; sleep 1; done
  (exec 3<>/dev/tcp/127.0.0.1/$ALP_PORT) 2>/dev/null || { echo "FAIL: Alpine REALITY inbound not listening"; exit 1; }
  # The release's scripts, both services in the default runlevel, the agent
  # as its own user, its state dir noexec, the updater detected.
  for u in akari-agent akari-agent-update; do
    ax "/usr/local/bin/akari-agent -print-unit $u | cmp -s - /etc/init.d/$u && test -x /etc/init.d/$u" \
      || { echo "FAIL: /etc/init.d/$u is not the release's"; exit 1; }
    ax "rc-update show default" | matches -E "^ *$u \|" || { echo "FAIL: $u not in the default runlevel"; exit 1; }
  done
  ax 'rc-service akari-agent status && rc-service akari-agent-update status' >/dev/null 2>&1 || { echo "FAIL: Alpine services not started"; exit 1; }
  ALP_PID=$(ax 'pgrep -P "$(cat /var/run/supervise-akari-agent.pid)" | sed -n 1p')
  [ -n "$ALP_PID" ] && [ "$(ax "stat -c %U /proc/$ALP_PID")" = akari-agent ] || { echo "FAIL: Alpine agent user"; exit 1; }
  ax "awk '\$5 == \"/var/lib/akari-agent\" { print \$6 }' /proc/$ALP_PID/mountinfo" | matches noexec || { echo "FAIL: Alpine state dir not noexec"; exit 1; }
  [ "$(ax 'stat -c "%a %U" /etc/akari-agent/bootstrap.toml')" = "600 root" ] || { echo "FAIL: Alpine bootstrap.toml mode"; exit 1; }
  ax 'cat /var/log/akari-agent/agent.log' | matches '"updater":true' || { echo "FAIL: Alpine agent does not see its updater"; exit 1; }
  ax 'cat /var/log/akari-agent/agent.log' | matches 'units are not the ones' && { echo "FAIL: Alpine agent reports stale scripts"; exit 1; }
  [ "$(psql_q "SELECT 'updater' = ANY(agent_capabilities) AND NOT 'stale-units' = ANY(agent_capabilities) FROM servers WHERE id='$ALP_ID'")" = "t" ] \
    || { echo "FAIL: Alpine node capabilities"; exit 1; }
  # Reinstall without BBR (AKARI_BBR=0): an earlier install's drop-in goes,
  # the previous settings come back; the node reconnects.
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/servers/$ALP_ID/install" -H 'Content-Type: application/json' \
      -d '{"origin":"http://127.0.0.1:8080"}')" = "200" ] || { echo "FAIL: alp-node re-install link"; exit 1; }
  ALP_CMD2=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['command'])")
  docker exec -e AKARI_BBR=0 akari-smoke-alp sh -c "$ALP_CMD2" >"$LOG/alp-reinstall.out" 2>&1 \
    || { echo "FAIL: Alpine reinstall"; cat "$LOG/alp-reinstall.out"; exit 1; }
  if [ "$ALP_BBR" = enabled ]; then
    grep -q "BBR + fq: removed /etc/sysctl.d/90-akari-bbr.conf" "$LOG/alp-reinstall.out" || { echo "FAIL: AKARI_BBR=0 kept BBR"; cat "$LOG/alp-reinstall.out"; exit 1; }
  else
    grep -q "BBR + fq: not changed (--no-bbr)" "$LOG/alp-reinstall.out" || { echo "FAIL: AKARI_BBR=0"; cat "$LOG/alp-reinstall.out"; exit 1; }
  fi
  ax 'test ! -e /etc/sysctl.d/90-akari-bbr.conf && test ! -e /etc/modules-load.d/akari-bbr.conf' || { echo "FAIL: BBR drop-in after AKARI_BBR=0"; exit 1; }
  [ "$(host_cc)" = "$BBR_BEFORE" ] || { echo "FAIL: AKARI_BBR=0 did not restore '$BBR_BEFORE' ($(host_cc))"; exit 1; }
  grep -q "SUCCESS: the agent enrolled and is connected" "$LOG/alp-reinstall.out" || { echo "FAIL: Alpine reinstall output"; cat "$LOG/alp-reinstall.out"; exit 1; }
  # Uninstall: services, scripts, user, mount, state, logs: all gone.
  ax 'akari-agent-uninstall' >>"$LOG/alp-install.out" 2>&1 || { echo "FAIL: Alpine uninstall"; exit 1; }
  ax 'test ! -e /etc/init.d/akari-agent && test ! -e /etc/init.d/akari-agent-update && test ! -e /usr/local/bin/akari-agent &&
      test ! -e /etc/akari-agent && test ! -e /var/lib/akari-agent && test ! -e /var/lib/akari-agent-update &&
      test ! -e /var/log/akari-agent && ! grep -q "^akari-agent:" /etc/passwd /etc/group &&
      ! awk "\$5 == \"/var/lib/akari-agent\" { f = 1 } END { exit !f }" /proc/self/mountinfo &&
      ! rc-update show default | grep akari >/dev/null' || { echo "FAIL: Alpine uninstall left something behind"; exit 1; }
  ax 'ps -o args' | matches '^/usr/local/bin/akari-agent ' && { echo "FAIL: Alpine agent still running after uninstall"; exit 1; }
  docker rm -f akari-smoke-alp >/dev/null
  eval "$PREV_EXIT_TRAP"
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/servers/$ALP_ID")" = "202" ] || { echo "FAIL: delete alp-node's server"; exit 1; }
  for kv in $ALP_RL; do vk set "${kv%%=*}" "${kv#*=}" KEEPTTL >/dev/null; done
  echo "w32 Alpine node: ok (OpenRC install, BBR + fq $ALP_BBR, AKARI_BBR=0 reinstall restored it, uninstall clean)"
fi

echo "== One-click agent update check: fake GitHub release server -> verified -> stored like an upload; refusals store nothing =="
# A local stand-in for api.github.com (plain http is accepted for loopback
# only): the latest-release document plus the release files, signed with the
# agent's TEST key (trusted by this panel) or, first, with another key.
UC="$LOG/updcheck"; UC_PORT=18207; UC_VER=v900.1.0
rm -rf "$UC"; mkdir -p "$UC/www/repos/akari-projectX/akari-agent/releases" "$UC/www/dl"
python3 -c "$TIE_PY"'
import functools, http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])),
    functools.partial(H, directory=sys.argv[2])).serve_forever()
' "$UC_PORT" "$UC/www" >/dev/null 2>&1 &
UC_PID=$!
uc_publish() { # $1 version, $2 signing key
  rm -f "$UC/www/dl/"*
  for a in amd64 arm64; do
    head -c $((1048576 + 4096)) /dev/urandom >"$UC/www/dl/akari-agent-linux-$a"
    "$UPD/akari-sign" sign -key "$2" -binary "$UC/www/dl/akari-agent-linux-$a" -version "$1" -os linux -arch "$a" >/dev/null
  done
  (cd "$UC/www/dl" && sha256sum akari-agent-linux-* >SHA256SUMS)
  python3 - "$UC/www" "$UC_PORT" "$1" <<'PY'
import json, os, sys
www, port, ver = sys.argv[1], sys.argv[2], sys.argv[3]
assets = [{"name": n, "size": os.path.getsize(os.path.join(www, "dl", n)),
           "browser_download_url": "http://127.0.0.1:%s/dl/%s" % (port, n)}
          for n in sorted(os.listdir(os.path.join(www, "dl")))]
json.dump({"tag_name": ver, "name": ver, "draft": False, "prerelease": False, "assets": assets},
          open(os.path.join(www, "repos/akari-projectX/akari-agent/releases/latest"), "w"))
PY
}
uc_check() { # -> the finished status in /tmp/akari-smoke/last
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/agent-updates/check")" = "202" ] \
    || { echo "FAIL: start update check: $(cat /tmp/akari-smoke/last)"; exit 1; }
  for _ in $(seq 1 60); do
    code -b "$JAR" "$BASE/api/v1/agent-updates" >/dev/null
    python3 -c "import json,sys; sys.exit(0 if json.load(open('/tmp/akari-smoke/last'))['checking'] is False else 1)" && return 0
    sleep 1
  done
  echo "FAIL: update check did not finish"; exit 1
}
uc_last() { python3 -c "import json; l=json.load(open('/tmp/akari-smoke/last'))['last_check']; print(l['result'], l['code'] or '-', l['version'] or '-', ','.join(l['stored']))"; }
code -b "$JAR" "$BASE/api/v1/agent-updates" >/dev/null
UC_V=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['version'])")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/agent-updates/settings" -H 'Content-Type: application/json' \
    -d "{\"version\":$UC_V,\"source_url\":\"http://example.com/latest\",\"auto_check\":false}")" = "400" ] \
  && matches -F '"agent_update.source_invalid"' /tmp/akari-smoke/last || { echo "FAIL: non-https source accepted"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/agent-updates/settings" -H 'Content-Type: application/json' \
    -d "{\"version\":$UC_V,\"source_url\":\"http://127.0.0.1:$UC_PORT/repos/akari-projectX/akari-agent/releases/latest\",\"auto_check\":false}")" = "200" ] \
  || { echo "FAIL: update source: $(cat /tmp/akari-smoke/last)"; exit 1; }
# Signed by a key the panel does not trust: refused, nothing stored.
uc_publish "$UC_VER" "$UPD/other.key"
uc_check
[ "$(uc_last)" = "failed release.signature_invalid - " ] || { echo "FAIL: untrusted release: $(uc_last)"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM agent_releases WHERE version='$UC_VER'")" = "0" ] || { echo "FAIL: refused release stored"; exit 1; }
# The release as published: both platforms stored, manifest bytes verbatim,
# binary = the file, audited like a manual upload.
uc_publish "$UC_VER" "$AD/testdata/TEST-ONLY-release.key"
uc_check
[ "$(uc_last)" = "stored - $UC_VER linux/amd64,linux/arm64" ] || { echo "FAIL: update check: $(uc_last)"; exit 1; }
for a in amd64 arm64; do
  f="$UC/www/dl/akari-agent-linux-$a"
  [ "$(psql_q "SELECT encode(manifest, 'hex') FROM agent_releases WHERE version='$UC_VER' AND arch='$a'")" = "$(od -An -v -tx1 "$f.manifest.json" | tr -d ' \n')" ] \
    || { echo "FAIL: $a manifest not stored verbatim"; exit 1; }
  [ "$(psql_q "SELECT encode(sha256(string_agg(c.data, ''::bytea ORDER BY c.idx)), 'hex') FROM agent_release_chunks c JOIN agent_releases r ON r.id = c.release_id WHERE r.version='$UC_VER' AND r.arch='$a'")" = "$(sha256sum "$f" | cut -d' ' -f1)" ] \
    || { echo "FAIL: $a binary differs"; exit 1; }
done
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action IN ('agent_release.create','agent_release.upload') AND after->>'version' = '$UC_VER'")" = "4" ] \
  && [ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'agent_update.check'")" = "2" ] || { echo "FAIL: update check audit"; exit 1; }
python3 -c "import json; s=json.load(open('/tmp/akari-smoke/last')); assert s['latest']['version']=='$UC_VER' and s['latest']['platforms']==['linux/amd64','linux/arm64'], s" \
  || { echo "FAIL: latest release not reported"; exit 1; }
uc_check
[ "$(uc_last)" = "up_to_date - $UC_VER " ] || { echo "FAIL: second check: $(uc_last)"; exit 1; }
# No downgrade.
uc_publish v900.0.5 "$AD/testdata/TEST-ONLY-release.key"
uc_check
[ "$(uc_last)" = "failed agent_update.downgrade - " ] || { echo "FAIL: downgrade: $(uc_last)"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM agent_releases WHERE version='v900.0.5'")" = "0" ] || { echo "FAIL: downgrade stored"; exit 1; }
# Back to the defaults; the checked releases go (later sections expect the
# M6 set).
code -b "$JAR" "$BASE/api/v1/agent-updates" >/dev/null
UC_V=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['version'])")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/agent-updates/settings" -H 'Content-Type: application/json' \
    -d "{\"version\":$UC_V,\"source_url\":null,\"auto_check\":false}")" = "200" ] || { echo "FAIL: reset update source"; exit 1; }
for id in $(psql_q "SELECT id FROM agent_releases WHERE version='$UC_VER'"); do
  [ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/agent-releases/$id")" = "204" ] || { echo "FAIL: delete checked release"; exit 1; }
done
kill "$UC_PID" 2>/dev/null || true
echo "agent update check: ok (untrusted key refused, both platforms stored verbatim, up to date, no downgrade)"

echo "== R22 系统设置: domains, Caddy on-demand ask, host gate, node domain + hot-swapped gRPC certificate =="
# Earlier sections (W15) may have audited settings changes of their own.
R22_AUDIT0=$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.update'")
R22_CLI0=$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.update' AND actor_label = 'cli'")
# An agent enrolled BEFORE the change (bootstrap server_name = the node
# domain imported from the old grpc.advertise, "127.0.0.1"): it must keep
# connecting afterwards.
"$PANEL" server add r22-old --out "$LOG/r22-old.toml" >/dev/null
grep -q '^server_name = "127.0.0.1"$' "$LOG/r22-old.toml" || { echo "FAIL: CLI bootstrap server_name"; exit 1; }
"$AGENT" -config "$LOG/r22-old.toml" -state-dir "$LOG/state-r22-old" >"$LOG/r22-old-agent.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 30); do grep -q "channel established" "$LOG/r22-old-agent.log" && break; sleep 0.5; done
grep -q "channel established" "$LOG/r22-old-agent.log" || { echo "FAIL: r22-old agent never connected"; exit 1; }
kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
AGENT_PID=""
[ "$(psql_q "SELECT server_name FROM servers WHERE name='r22-old'")" = "127.0.0.1" ] || { echo "FAIL: enrolled server name not recorded"; exit 1; }

[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings"; exit 1; }
VER=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['version'])")
# A node domain on Cloudflare is refused (422) unless forced: 104.16.0.1 is a
# Cloudflare edge address (IP literal: no DNS involved).
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings" -H 'Content-Type: application/json' \
    -d "{\"version\":$VER,\"main_domains\":[],\"sub_domains\":[],\"node_domains\":[\"104.16.0.1\"],\"trust_cloudflare\":null,\"confirm_removal\":true}")" = "422" ] \
  || { echo "FAIL: orange-clouded node domain accepted: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/dns-check" -H 'Content-Type: application/json' \
    -d '{"kind":"node","domain":"104.16.0.1"}')" = "200" ] && grep -q '"level":"block"' /tmp/akari-smoke/last \
  || { echo "FAIL: dns-check verdict: $(cat /tmp/akari-smoke/last)"; exit 1; }
# The real values. The request goes to 127.0.0.1 (an IP: still allowed by
# the host gate, so no confirmation needed).
R22_MAIN=myapp.test:8446
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings" -H 'Content-Type: application/json' \
    -d "{\"version\":$VER,\"main_domains\":[\"$R22_MAIN\"],\"sub_domains\":[\"sub.akari.test\"],
         \"node_domains\":[\"grpc.akari.test\"],\"trust_cloudflare\":true,\"confirm_removal\":true}")" = "200" ] \
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
# right prefix; D8: so do the subscription domain (subscriptions only) and
# the node communication name (gRPC only); main names and IP literals pass.
for h in evil.test grpc.akari.test www.myapp.test sub.akari.test; do
  [ "$(fp -H "Host: $h" "$BASE/healthz")" = "$REJ" ] || { echo "FAIL: Host $h not rejected canonically"; exit 1; }
done
for h in myapp.test:8446 127.0.0.1:8080; do
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
for p in "$BASE/app" "$ROOT/" "$ROOT/shop" "$ROOT/healthz"; do
  [ "$(fp -H "Host: sub.akari.test" "$p")" = "$REJ" ] || { echo "FAIL: D8: the sub domain serves $p"; exit 1; }
done
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
docker run -d --name akari-smoke-caddy --network host -e AKARI_DOMAIN=myapp.test \
  -e AKARI_UPSTREAM=127.0.0.1:8080 -e AKARI_ASK=http://127.0.0.1:8092/ask \
  -v "$LOG/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.11-alpine >/dev/null
PREV_EXIT_TRAP=$(trap -p EXIT)
trap 'docker rm -f akari-smoke-caddy akari-smoke-r22 >/dev/null 2>&1 || true; cleanup_upd; kill $PANEL_PID ${AGENT_PID:+$AGENT_PID} $MOCK_PID ${W11_PROBE_PID:+$W11_PROBE_PID} 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/8446) 2>/dev/null && break; sleep 0.5; done
RES=(--resolve myapp.test:8446:127.0.0.1 --resolve sub.akari.test:8446:127.0.0.1 --resolve evil.test:8446:127.0.0.1
     --resolve myapp.test:8447:127.0.0.1 --resolve evil.test:8447:127.0.0.1)
MAIN_URL="https://$R22_MAIN/$PREFIX"
# The listener is up before Caddy has issued the main domain's certificate
# (managed at start, asynchronously): until then the handshake fails.
for _ in $(seq 1 30); do [ "$(code -k "${RES[@]}" "$MAIN_URL/healthz")" = "200" ] && break; sleep 0.5; done
[ "$(code -k "${RES[@]}" "$MAIN_URL/healthz")" = "200" ] || { echo "FAIL: main domain through Caddy"; docker logs akari-smoke-caddy 2>&1 | tail -5; exit 1; }
# The on-demand certificate works (the handshake succeeds); D8: the admin
# prefix does not exist on the subscription domain.
[ "$(code -k "${RES[@]}" "https://sub.akari.test:8446/$PREFIX/healthz")" = "404" ] || { echo "FAIL: sub domain through Caddy (on demand)"; docker logs akari-smoke-caddy 2>&1 | tail -5; exit 1; }
# D11: everything reaches the panel; the portal is at /.
[ "$(code -k "${RES[@]}" "https://$R22_MAIN/")" = "200" ] || { echo "FAIL: the portal through Caddy"; exit 1; }
curl -sk --noproxy '*' "${RES[@]}" -o /dev/null "https://evil.test:8446/$PREFIX/healthz" \
  && { echo "FAIL: Caddy served a certificate for an unconfigured name"; exit 1; }
# No prefix oracle through Caddy: junk and the panel's rejections under the
# prefix are byte-identical (headers minus Date, body), on the main domain,
# the on-demand subscription domain and the bare IP (no SNI), with and
# without compression negotiated. Server/Via are stripped.
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
    -d '{"email":"r22-user@smoke.test","password":"r22-user-password"}')" = "201" ] || { echo "FAIL: create r22 user"; exit 1; }
python3 -c "import json,sys;v=json.load(open('/tmp/akari-smoke/last'));sys.exit(0 if v['sub_url']=='https://sub.akari.test/$SUBP/'+v['sub_token'] else 1)" \
  || { echo "FAIL: sub_url not on the subscription domain: $(cat /tmp/akari-smoke/last)"; exit 1; }
# D8: the subscription answers on the subscription and main domains, not on
# the node communication name.
R22_TOK=$(last_json "d['sub_token']")
subrl
for h in sub.akari.test myapp.test:8446; do
  [ "$(code -H "Host: $h" "$ROOT/$SUBP/$R22_TOK")" = "200" ] || { echo "FAIL: subscription on Host $h"; exit 1; }
done
[ "$(fp -H "Host: grpc.akari.test" "$ROOT/$SUBP/$R22_TOK")" = "$REJ" ] || { echo "FAIL: subscription on the node name"; exit 1; }
# D8 lists: a second main domain answers; removing it needs the impact
# preview's confirmation; per-user subscription domains.
[ "$(code -b "$JAR" "$BASE/api/v1/settings")" = "200" ] || { echo "FAIL: GET settings (D8)"; exit 1; }
VER=$(last_json "d['version']")
D8_LISTS='"main_domains":["myapp.test:8446","alt.akari.test"],"sub_domains":["sub.akari.test","sub2.akari.test"],"node_domains":["grpc.akari.test"]'
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings" -H 'Content-Type: application/json' \
    -d "{\"version\":$VER,$D8_LISTS,\"sub_domain_per_user\":true,\"trust_cloudflare\":true}")" = "200" ] \
  && last_json "len(d['main']['domains']) == 2 and d['sub_domain_per_user'] is True" | matches '^True$' \
  || { echo "FAIL: D8 domain lists: $(cat /tmp/akari-smoke/last)"; exit 1; }
VER=$(last_json "d['version']")
[ "$(code -H "Host: alt.akari.test" "$BASE/healthz")" = "200" ] || { echo "FAIL: the second main domain"; exit 1; }
[ "$(code "$ASK?domain=sub2.akari.test")" = "200" ] && [ "$(code "$ASK?domain=alt.akari.test")" = "200" ] \
  || { echo "FAIL: ask refuses a listed name"; exit 1; }
D8_BACK='"main_domains":["myapp.test:8446"],"sub_domains":["sub.akari.test"],"node_domains":["grpc.akari.test"]'
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/domains/impact" -H 'Content-Type: application/json' -d "{$D8_BACK}")" = "200" ] \
  && last_json "sorted((r['kind'], r['domain'], r['places'][0]['what']) for r in d['removed']) == [('main', 'alt.akari.test', 'portal_console'), ('sub', 'sub2.akari.test', 'subscription_links')]" | matches '^True$' \
  || { echo "FAIL: domains impact: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings" -H 'Content-Type: application/json' \
    -d "{\"version\":$VER,$D8_BACK,\"trust_cloudflare\":true}")" = "409" ] \
  && last_json "d['code']" | matches '^settings.domain_removal_unconfirmed$' || { echo "FAIL: removal without confirmation"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings" -H 'Content-Type: application/json' \
    -d "{\"version\":$VER,$D8_BACK,\"trust_cloudflare\":true,\"confirm_removal\":true}")" = "200" ] \
  || { echo "FAIL: confirmed removal: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(fp -H "Host: alt.akari.test" "$BASE/healthz")" = "$REJ" ] || { echo "FAIL: a removed main domain still answers"; exit 1; }

# Install command: main domain origin (browser origin ignored), pinned
# (Caddy's internal CA), script carries the node domain.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/nodes" -H 'Content-Type: application/json' \
    -d '{"name":"r22-new","install":{"origin":"http://127.0.0.1:8080"}}')" = "201" ] \
  || { echo "FAIL: create r22-new: $(cat /tmp/akari-smoke/last)"; exit 1; }
cp /tmp/akari-smoke/last "$LOG/r22-create.json"
R22_URL=$(python3 -c "import json;print(json.load(open('$LOG/r22-create.json'))['install']['url'])")
R22_PIN=$(python3 -c "import json;print(json.load(open('$LOG/r22-create.json'))['install']['pin'] or '')")
case "$R22_URL" in "https://$R22_MAIN/install/"*) ;; *) echo "FAIL: install URL not on the main domain (or carries the prefix): $R22_URL"; exit 1;; esac
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
R22_ID=$(python3 -c "import json;print(json.load(open('$LOG/r22-create.json'))['server_id'])")
for _ in $(seq 1 40); do [ "$(psql_q "SELECT status FROM servers WHERE id='$R22_ID'")" = "online" ] && break; sleep 0.5; done
[ "$(psql_q "SELECT status FROM servers WHERE id='$R22_ID'")" = "online" ] \
  || { echo "FAIL: agent with the new server name did not connect"; docker logs akari-smoke-r22 2>&1 | tail -8; exit 1; }
[ "$(psql_q "SELECT server_name FROM servers WHERE id='$R22_ID'")" = "grpc.akari.test" ] || { echo "FAIL: new server name not recorded"; exit 1; }
docker rm -f akari-smoke-r22 >/dev/null
# The agent enrolled before the change (server name 127.0.0.1) still connects.
"$AGENT" -config "$LOG/r22-old.toml" -state-dir "$LOG/state-r22-old" >"$LOG/r22-old-agent2.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 30); do grep -q "channel established" "$LOG/r22-old-agent2.log" && break; sleep 0.5; done
grep -q "channel established" "$LOG/r22-old-agent2.log" || { echo "FAIL: old-server-name agent lost after the change"; tail -5 "$LOG/r22-old-agent2.log"; exit 1; }
kill $AGENT_PID 2>/dev/null; wait $AGENT_PID 2>/dev/null || true
AGENT_PID=""
# The current node name cannot be removed; the built-in one neither.
for n in grpc.akari.test localhost; do
  [ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/server-names/remove" -H 'Content-Type: application/json' \
      -d "{\"name\":\"$n\",\"confirm\":true}")" = "400" ] || { echo "FAIL: locked server name $n removable"; exit 1; }
done
docker rm -f akari-smoke-caddy >/dev/null
eval "$PREV_EXIT_TRAP"
# CLI: show + unset (audited); the name history (certificate) stays.
"$PANEL" settings show | matches 'node domains: *grpc.akari.test' || { echo "FAIL: settings show"; "$PANEL" settings show; exit 1; }
"$PANEL" settings unset all >/dev/null || { echo "FAIL: settings unset"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.update' AND actor_label = 'cli'")" = "$((R22_CLI0 + 1))" ] || { echo "FAIL: CLI unset not audited"; exit 1; }
for _ in $(seq 1 20); do [ "$(code "$ASK?domain=myapp.test")" = "404" ] && break; sleep 0.25; done
[ "$(code "$ASK?domain=myapp.test")" = "404" ] || { echo "FAIL: running panel did not pick up the CLI change"; exit 1; }
[ "$(code -H 'Host: evil.test' "$BASE/healthz")" = "200" ] || { echo "FAIL: host gate still on after unset"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM grpc_server_names WHERE name = 'grpc.akari.test'")" = "1" ] || { echo "FAIL: server name dropped implicitly"; exit 1; }
# W25: no node domain = no tokens (no fallback); `settings set` (headless
# setup) fixes that, audited as cli.
"$PANEL" server add r22-none --out "$LOG/r22-none.toml" >"$LOG/r22-none.out" 2>&1 \
  && { echo "FAIL: a token without a node domain"; exit 1; }
matches '节点通信域名未设置' <"$LOG/r22-none.out" || { echo "FAIL: unset node domain error"; cat "$LOG/r22-none.out"; exit 1; }
"$PANEL" settings set node 203.0.113.9 >/dev/null || { echo "FAIL: settings set node"; exit 1; }
"$PANEL" settings show | matches 'node domains: *203.0.113.9 *-> 203.0.113.9:8443 / 203.0.113.9' \
  || { echo "FAIL: settings show after set"; "$PANEL" settings show; exit 1; }
"$PANEL" settings unset node >/dev/null || { echo "FAIL: settings unset node"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.update' AND actor_label = 'cli'")" = "$((R22_CLI0 + 3))" ] \
  || { echo "FAIL: CLI set/unset not audited"; exit 1; }
grep -qF "$PREFIX" "$LOG/panel.log" && { echo "FAIL: prefix in the panel log"; exit 1; }
echo "r22 settings: ok"

echo "== S4-2 sessions: revoke-sessions, the owner (R47), logout kills copies of the cookie =="
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "200" ] || { echo "FAIL: me failed"; exit 1; }
ROOT_ID=$(python3 -c "import json;print(json.load(open('/tmp/akari-smoke/last'))['id'])")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$ROOT_ID/ban" -H 'Content-Type: application/json' \
    -d '{"reason": "x"}')" = "400" ] && last_json "d['code']" | matches '^user.ban_self$' \
  || { echo "FAIL: self-ban not refused"; exit 1; }
[ "$(patch_code "$BASE/api/v1/users/$ROOT_ID" '{"role": "user"}')" = "409" ] \
  && last_json "d['code']" | matches '^user.owner_protected$' || { echo "FAIL: owner demote not 409"; exit 1; }
[ "$(code -b "$JAR" -X DELETE "$BASE/api/v1/users/$ROOT_ID?confirm=true")" = "409" ] \
  && last_json "d['code']" | matches '^user.owner_protected$' || { echo "FAIL: owner delete not 409"; exit 1; }
JAR2="$LOG/cookies2"
[ "$(code -c "$JAR2" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"root@smoke.test\",\"password\":\"$ADMIN_PW\"}")" = "200" ] || { echo "FAIL: second login"; exit 1; }
[ "$(code -b "$JAR2" "$BASE/api/v1/me")" = "200" ] || { echo "FAIL: second session"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users/$ROOT_ID/revoke-sessions")" = "204" ] || { echo "FAIL: revoke-sessions"; exit 1; }
[ "$(code -b "$JAR2" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: revoked session still works"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: own session survived revoke-sessions"; exit 1; }
[ "$(login_root)" = "200" ] || { echo "FAIL: login after revoke"; exit 1; }
cp "$JAR" "$LOG/stolen-cookies"
[ "$(code -b "$JAR" -c "$JAR" -X POST "$BASE/auth/logout")" = "200" ] || { echo "FAIL: logout failed"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: me after logout not 401"; exit 1; }
[ "$(code -b "$LOG/stolen-cookies" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: a copy of the cookie survived logout"; exit 1; }
echo "sessions: ok"

echo "== M1-9 CLI: admin passwd, rotate-jwt =="
[ "$(login_root)" = "200" ] || { echo "FAIL: login before passwd"; exit 1; }
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" admin passwd ROOT@smoke.test >"$LOG/passwd.out"
grep -q "password changed for root@smoke.test" "$LOG/passwd.out" || { echo "FAIL: CLI admin passwd"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: session survived admin passwd"; exit 1; }
"$PANEL" admin reset-2fa root@smoke.test >/dev/null 2>&1 && { echo "FAIL: CLI reset-2fa still exists"; exit 1; }
[ "$(login_root)" = "200" ] || { echo "FAIL: login after admin passwd"; exit 1; }
[ "$(code -b "$UJAR" "$BASE/api/v1/me")" = "200" ] || { echo "FAIL: user session before rotate-jwt"; exit 1; }
# Not piped into grep -q: grep exits at the first match and the CLI's next
# line then dies on EPIPE (pipefail turned that into a flaky FAIL).
"$PANEL" secrets rotate-jwt >"$LOG/rotate-jwt.out" && grep -q "revoked" "$LOG/rotate-jwt.out" || { echo "FAIL: CLI rotate-jwt"; exit 1; }
[ "$(code -b "$UJAR" "$BASE/api/v1/me")" = "401" ] || { echo "FAIL: session survived rotate-jwt"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE actor_label = 'cli' AND action IN ('user.update', 'secrets.rotate_jwt')")" -ge 2 ] \
  || { echo "FAIL: CLI secret actions not audited"; exit 1; }
echo "cli passwd/jwt: ok"

echo "== root + healthz =="
[ "$(code http://127.0.0.1:8080/)" = "200" ] || { echo "FAIL: / is not the portal (D11)"; exit 1; }
[ "$(code http://127.0.0.1:8080/definitely-not-here)" = "404" ] || { echo "FAIL: junk not 404"; exit 1; }
[ "$(code "$BASE/healthz")" = "200" ] || { echo "FAIL: healthz not 200"; exit 1; }

echo "== M1-3/M1-4: config check, version, metrics listener, request id =="
"$PANEL" -c "$LOG/panel.toml" config check >"$LOG/config-check.out" 2>&1 \
  || { echo "FAIL: config check on the smoke config"; cat "$LOG/config-check.out"; exit 1; }
grep -q 'configuration OK' "$LOG/config-check.out" || { echo "FAIL: config check output"; exit 1; }
# W24: the database payment methods are described, secrets redacted.
grep -qE '^# payment method .* kind=alipay_f2f enabled=true .*secrets=<redacted, set>' "$LOG/config-check.out" \
  || { echo "FAIL: config check lacks the payment methods"; cat "$LOG/config-check.out"; exit 1; }
grep -q 'PRIVATE' "$LOG/config-check.out" && { echo "FAIL: a key in config check"; exit 1; }
# W25: obsolete keys are warnings (never errors) naming where they went; the
# printed effective config holds none of them; the database side is listed.
matches 'warning: grpc.advertise is obsolete: it is set in 系统设置 → 节点通信' <"$LOG/config-check.out" \
  || { echo "FAIL: config check does not list the obsolete keys"; cat "$LOG/config-check.out"; exit 1; }
matches 'warning: grpc.lease_seconds is obsolete: the value is built in now' <"$LOG/config-check.out" \
  || { echo "FAIL: config check does not list the obsolete constants"; exit 1; }
matches -E '^(advertise|lease_seconds|release_keys|directory_url) *=' <"$LOG/config-check.out" \
  && { echo "FAIL: config check prints an obsolete key as configuration"; exit 1; }
matches -F '# --- 系统设置 (database; the only source of these values) ---' <"$LOG/config-check.out" \
  || { echo "FAIL: config check lacks the database settings"; exit 1; }
printf '[web]\nbind = "127.0.0.1:0"\n[grpc]\nlease_seconds = 5\n' >"$LOG/bad.toml"
"$PANEL" -c "$LOG/bad.toml" config check >"$LOG/bad.out" 2>&1 \
  && { echo "FAIL: invalid config accepted"; exit 1; }
grep -q 'web.bind: port 0' "$LOG/bad.out" || { echo "FAIL: invalid config error not readable"; cat "$LOG/bad.out"; exit 1; }
printf '[web]\nbnd = "127.0.0.1:1"\n' >"$LOG/typo.toml"
"$PANEL" -c "$LOG/typo.toml" config check >"$LOG/typo.out" 2>&1 \
  && { echo "FAIL: a typo in a kept section accepted"; exit 1; }
grep -q 'unknown field' "$LOG/typo.out" || { echo "FAIL: typo error not readable"; cat "$LOG/typo.out"; exit 1; }
# AKARI_CONFIG replaces -c (compose run/exec drop the service command).
AKARI_CONFIG="$LOG/bad.toml" "$PANEL" config check >"$LOG/bad-env.out" 2>&1 \
  && { echo "FAIL: AKARI_CONFIG ignored (invalid config accepted)"; exit 1; }
grep -q 'web.bind: port 0' "$LOG/bad-env.out" || { echo "FAIL: AKARI_CONFIG not honored"; cat "$LOG/bad-env.out"; exit 1; }
"$PANEL" --version | matches -E '^akari [0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)? \(([0-9a-f]+|unknown)\)' \
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

echo "== SPA (the portal at /, D11) =="
[ "$(code "$ROOT/")" = "200" ] || { echo "FAIL: portal / not 200"; exit 1; }
grep -q 'id="root"' /tmp/akari-smoke/last || { echo "FAIL: portal index has no root div"; exit 1; }
grep -q "$PREFIX" /tmp/akari-smoke/last && { echo "FAIL: portal index carries the admin prefix"; exit 1; }
JS=$(grep -o '"/assets/[^"]*\.js"' /tmp/akari-smoke/last | tr -d '"' | grep -v '/assets/boot-' | sed -n 1p)
[ -n "$JS" ] || { echo "FAIL: portal index references no /assets/ script"; exit 1; }
grep -q '"/assets/[^"]*\.css"' /tmp/akari-smoke/last || { echo "FAIL: portal index has no stylesheet"; exit 1; }
CT=$(curl -s --noproxy '*' -o /dev/null -w "%{content_type}" "$ROOT$JS")
echo "$CT" | matches javascript || { echo "FAIL: asset content-type '$CT'"; exit 1; }
# The portal's own stylesheet and script must be allowed by the CSP it is
# served with; Turnstile is off here, so nothing beyond 'self'.
CSP=$(curl -s --noproxy '*' -D - -o /dev/null "$ROOT/" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-security-policy"{print $2}')
[ "$CSP" = "default-src 'self'; style-src 'self' 'unsafe-inline'" ] || { echo "FAIL: portal CSP: $CSP"; exit 1; }
# Every client-side route answers the index (W36-b route table), deep paths too.
for r in shop orders orders/x wallet invite nodes traffic tickets help announcements account login register forgot reset terms privacy; do
  [ "$(code "$ROOT/$r")" = "200" ] || { echo "FAIL: portal route /$r"; exit 1; }
done
[ "$(fp "$ROOT/dashboard")" = "$REJ" ] || { echo "FAIL: an unknown portal path is not the rejection"; exit 1; }
[ "$(code "$ROOT/assets/missing.js")" = "404" ] || { echo "FAIL: missing asset not 404"; exit 1; }
# (Request paths: spa/src/api/adapter.test.ts runs the real API layer.)
# The portal as served carries no console code (R23, D4): every file the
# index loads, and every chunk those import, through the build-time guard.
SERVED_PORTAL="$LOG/served-portal"; rm -rf "$SERVED_PORTAL" && mkdir -p "$SERVED_PORTAL"
curl -s --noproxy '*' "$ROOT/" >"$SERVED_PORTAL/index.html"
todo=""
for a in $(grep -o '/assets/[A-Za-z0-9_.-]*\.\(js\|css\)' "$SERVED_PORTAL/index.html" | sort -u); do
  curl -s --noproxy '*' "$ROOT$a" >"$SERVED_PORTAL/$(basename "$a")"; todo="$todo $SERVED_PORTAL/$(basename "$a")"
done
while [ -n "$todo" ]; do
  next=""
  # shellcheck disable=SC2086
  for c in $(cat $todo | grep -ao '\(\./\|assets/\)[A-Za-z0-9_.-]*\.\(js\|css\)' | sed 's#.*/##' | sort -u); do
    f="$SERVED_PORTAL/$c"
    [ -e "$f" ] && continue
    [ "$(curl -s --noproxy '*' -o "$f" -w '%{http_code}' "$ROOT/assets/$c")" = "200" ] || { echo "FAIL: portal chunk $c not served"; exit 1; }
    next="$next $f"
  done
  todo="$next"
done
[ "$(ls "$SERVED_PORTAL"/*.js | wc -l)" -gt 10 ] || { echo "FAIL: portal chunks not found"; exit 1; }
node spa/scripts/check-bundles.mjs "$SERVED_PORTAL" || { echo "FAIL: served portal bundle carries admin code"; exit 1; }
# W33-b: the admin sign-in page under the prefix (its own bundle).
[ "$(code "$BASE/app")" = "200" ] || { echo "FAIL: /app not 200"; exit 1; }
grep -q 'id="root"' /tmp/akari-smoke/last || { echo "FAIL: sign-in page has no root div"; exit 1; }
LJS=$(grep -o "/$PREFIX/app/assets/[^\"]*\.js" /tmp/akari-smoke/last | sed -n 1p)
[ -n "$LJS" ] || { echo "FAIL: sign-in page did not reference prefixed assets"; exit 1; }
grep -q "/$PREFIX/app/assets/[^\"]*\.css" /tmp/akari-smoke/last || { echo "FAIL: sign-in page has no prefixed stylesheet"; exit 1; }
[ "$(code "$BASE/app/some-client-route")" = "200" ] || { echo "FAIL: sign-in page client-route fallback"; exit 1; }
[ "$(code "$BASE/app/assets/missing.js")" = "404" ] || { echo "FAIL: missing asset not 404"; exit 1; }
[ "$(code "http://127.0.0.1:8080/app/assets/missing.js")" = "404" ] || { echo "FAIL: sign-in assets reachable without prefix"; exit 1; }
[ "$(code "http://127.0.0.1:8080${LJS#/"$PREFIX"}")" = "404" ] || { echo "FAIL: sign-in asset reachable without prefix"; exit 1; }
# REVIEW P0 #1 regression guards: the shipped sign-in JS derives a
# `${prefix}/auth` base and never carries a bare "/auth/login" literal (that
# shape is what gets prefixed with /api/v1 by get/post).
curl -s --noproxy '*' "http://127.0.0.1:8080$LJS" >/tmp/akari-smoke/app.js
grep -q '}/auth[`"'"'"']' /tmp/akari-smoke/app.js || { echo "FAIL: bundle lacks the {prefix}/auth base"; exit 1; }
grep -qE '[`"'"'"']/auth/(login|logout)' /tmp/akari-smoke/app.js \
  && { echo "FAIL: bundle posts a bare /auth/* path (would be joined to /api/v1)"; exit 1; }
# The sign-in page's stylesheet and script must be allowed by its CSP too.
CSP=$(curl -s --noproxy '*' -D - -o /dev/null "$BASE/app" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-security-policy"{print $2}')
[ "$CSP" = "default-src 'self'; style-src 'self' 'unsafe-inline'" ] || { echo "FAIL: sign-in page CSP: $CSP"; exit 1; }
echo "spa: ok (portal $JS, sign-in $LJS)"

echo "== R23: separate admin bundle, served to admin sessions only =="
# Fresh sessions (rotate-jwt above revoked everything).
AJAR="$LOG/spa-admin-cookies"; SJAR="$LOG/spa-user-cookies"; RJAR="$LOG/spa-revoked-cookies"
[ "$(code -c "$AJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"root@smoke.test\",\"password\":\"$ADMIN_PW\"}")" = "200" ] || { echo "FAIL: admin login (R23)"; exit 1; }
[ "$(code -b "$AJAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-spa-user@smoke.test","password":"spa-user-password-1"}')" = "201" ] || { echo "FAIL: create spa user"; exit 1; }
[ "$(code -c "$SJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-spa-user@smoke.test","password":"spa-user-password-1"}')" = "200" ] || { echo "FAIL: spa user login"; exit 1; }
# A revoked admin session: log in, keep the cookie, log out (bumps session_ver).
code -c "$RJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"root@smoke.test\",\"password\":\"$ADMIN_PW\"}" >/dev/null
cp "$RJAR" "$RJAR.kept"
[ "$(code -b "$RJAR" -X POST "$BASE/auth/logout")" = "200" ] || { echo "FAIL: logout (R23 revoked session)"; exit 1; }
# Logging out bumped root's session_ver: the console session needs a fresh login too.
[ "$(code -c "$AJAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"root@smoke.test\",\"password\":\"$ADMIN_PW\"}")" = "200" ] || { echo "FAIL: admin re-login (R23)"; exit 1; }

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
[ "$(fp -b "$AJAR" "http://127.0.0.1:8080${AJS/\/admin\/assets\//\/app\/assets\/}")" = "$REJ" ] \
  || { echo "FAIL: console asset served under the sign-in page's asset path"; exit 1; }
# The portal never references the console's files, and the bundles as served
# pass the build-time guard (admin/scripts/check-bundles.mjs): no console
# marker in the portal or the public sign-in page.
SERVED="$LOG/served"; rm -rf "$SERVED" && mkdir -p "$SERVED/app" "$SERVED/admin/console" "$SERVED/admin/login"
curl -s --noproxy '*' -b "$SJAR" "$ROOT/" >"$SERVED/app/index.html"
grep -q '/admin/' "$SERVED/app/index.html" && { echo "FAIL: portal index references the console"; exit 1; }
for a in $(grep -o '"/assets/[^"]*\.\(js\|css\)' "$SERVED/app/index.html" | tr -d '"'); do
  curl -s --noproxy '*' "http://127.0.0.1:8080$a" >"$SERVED/app/$(basename "$a")"
done
curl -s --noproxy '*' -b "$AJAR" "$BASE/admin" >"$SERVED/admin/console/index.html"
for a in "$AJS" "$ACSS"; do curl -s --noproxy '*' -b "$AJAR" "http://127.0.0.1:8080$a" >"$SERVED/admin/console/$(basename "$a")"; done
curl -s --noproxy '*' "$BASE/app" >"$SERVED/admin/login/login.html"
for a in $(grep -o "/$PREFIX/app/assets/[^\"]*\.\(js\|css\)" "$SERVED/admin/login/login.html"); do
  curl -s --noproxy '*' "http://127.0.0.1:8080$a" >"$SERVED/admin/login/$(basename "$a")"
done
node admin/scripts/check-bundles.mjs "$SERVED/admin" "$SERVED/app" || { echo "FAIL: served bundles mix portal and console code"; exit 1; }
echo "admin bundle: ok"

echo "== S4-3 SIGTERM: agent streams end, final flush, clean exit =="
# R22 left no node domain (W25: no tokens without one): set it for this node.
"$PANEL" settings set node 127.0.0.1:8443 >/dev/null || { echo "FAIL: settings set node (S4-3)"; exit 1; }
"$PANEL" server add term-node --out "$LOG/term-bootstrap.toml" >/dev/null
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
# Back to no node domain: the restart below must not bring grpc.advertise back.
"$PANEL" settings unset node >/dev/null || { echo "FAIL: settings unset node (S4-3)"; exit 1; }
echo "sigterm: ok"

echo "== D4 admin prefix: CLI rotation (database: every instance), API rotation, allowlist; D11 subscription path =="
OLD_BASE="$BASE"
"$PANEL" secrets rotate-prefix | matches "new admin prefix" || { echo "FAIL: CLI rotate-prefix"; exit 1; }
PREFIX=$("$PANEL" info | awk '/admin prefix/{sub(/^\//,"",$3); print $3}')
BASE="$ROOT/$PREFIX"
[ "$BASE" != "$OLD_BASE" ] || { echo "FAIL: prefix unchanged"; exit 1; }
start_panel "$LOG/panel2.log"
for _ in $(seq 1 20); do [ "$(code "$BASE/healthz")" = "200" ] && break; sleep 0.5; done
[ "$(code "$BASE/healthz")" = "200" ] || { echo "FAIL: new prefix not served"; exit 1; }
# W25: a later start never imports again (even though `settings unset all`
# cleared the imported values meanwhile): the old keys are only warned about.
matches "panel.toml grpc.advertise is obsolete and ignored" <"$LOG/panel2.log" \
  || { echo "FAIL: second start does not warn about the obsolete keys"; grep -i obsolete "$LOG/panel2.log"; exit 1; }
matches "imported into 系统设置" <"$LOG/panel2.log" && { echo "FAIL: obsolete keys imported twice"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.import'")" = "1" ] || { echo "FAIL: a second import was audited"; exit 1; }
[ "$(psql_q "SELECT coalesce((SELECT domain FROM site_domains WHERE kind = 'node'), '-')")" = "-" ] || { echo "FAIL: unset node domain came back from panel.toml"; exit 1; }
[ "$(fp "$OLD_BASE/healthz")" = "$REJ" ] || { echo "FAIL: old prefix still answers"; exit 1; }
[ "$(psql_q "SELECT count(*) FROM audit_log WHERE action = 'settings.admin_prefix.rotate' AND actor_label = 'cli'")" = "1" ] || { echo "FAIL: rotate-prefix not audited"; exit 1; }
# The owner rotates through the API (confirmed); the old prefix dies at once,
# without a restart.
[ "$(login_root)" = "200" ] || { echo "FAIL: owner login under the new prefix"; exit 1; }
[ "$(code -b "$JAR" "$BASE/api/v1/settings/access")" = "200" ] && last_json "d['admin_prefix'] == '$PREFIX' and d['sub_path'] == '$SUBP'" | matches '^True$' \
  || { echo "FAIL: GET settings/access"; cat /tmp/akari-smoke/last; exit 1; }
AV=$(last_json "d['version']")
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/access/admin-prefix" -H 'Content-Type: application/json' -d "{\"version\":$AV}")" = "400" ] \
  && last_json "d['code']" | matches '^settings.confirm_required$' || { echo "FAIL: unconfirmed prefix rotation"; exit 1; }
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/settings/access/admin-prefix" -H 'Content-Type: application/json' \
    -d "{\"version\":$AV,\"confirm\":true,\"admin_prefix\":\"smoke-door-2026\"}")" = "200" ] \
  || { echo "FAIL: API prefix rotation: $(cat /tmp/akari-smoke/last)"; exit 1; }
OLD2="$BASE"; BASE="$ROOT/smoke-door-2026"
[ "$(fp "$OLD2/healthz")" = "$REJ" ] && [ "$(code "$BASE/healthz")" = "200" ] || { echo "FAIL: API rotation not effective at once"; exit 1; }
[ "$(psql_q "SELECT after->>'admin_prefix' FROM audit_log WHERE action = 'settings.admin_prefix.rotate' ORDER BY id DESC LIMIT 1")" = "changed" ] \
  || { echo "FAIL: the new prefix reached the audit log"; exit 1; }
# Allowlist: a list without the caller's address is refused; with it, saved;
# the CLI reopens the prefix.
AV=$(psql_q "SELECT version FROM access_settings")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/access/admin-allow" -H 'Content-Type: application/json' \
    -d "{\"version\":$AV,\"admin_allow_cidrs\":[\"10.0.0.0/8\"]}")" = "409" ] \
  && last_json "d['code']" | matches '^settings.allowlist_excludes_you$' || { echo "FAIL: allowlist without the caller accepted"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/access/admin-allow" -H 'Content-Type: application/json' \
    -d "{\"version\":$AV,\"admin_allow_cidrs\":[\"127.0.0.0/8\"]}")" = "200" ] || { echo "FAIL: allowlist: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(code "$BASE/healthz")" = "200" ] || { echo "FAIL: an allowed address shut out"; exit 1; }
"$PANEL" settings unset admin-allow | matches "admin-allow: cleared" || { echo "FAIL: settings unset admin-allow"; exit 1; }
[ "$(psql_q "SELECT cardinality(admin_allow_cidrs) FROM access_settings")" = "0" ] || { echo "FAIL: allowlist not cleared"; exit 1; }
# D11: a new subscription path; the old one dies at once.
[ "$(code -b "$JAR" -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d '{"email":"smoke-subpath@smoke.test","password":"user-password-123"}')" = "201" ] || { echo "FAIL: create sub-path user"; exit 1; }
SP_TOKEN=$(last_json "d['sub_token']")
last_json "d['sub_url']" | matches "^/$SUBP/$SP_TOKEN\$" || { echo "FAIL: root-relative sub_url without a domain"; cat /tmp/akari-smoke/last; exit 1; }
subrl
[ "$(code "$SUBBASE/$SP_TOKEN")" = "200" ] || { echo "FAIL: subscription on the sub path"; exit 1; }
AV=$(psql_q "SELECT version FROM access_settings")
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/access/sub-path" -H 'Content-Type: application/json' \
    -d "{\"version\":$AV,\"sub_path\":\"shop\",\"confirm\":true}")" = "400" ] \
  && last_json "d['code']" | matches '^settings.path_reserved$' || { echo "FAIL: reserved sub path accepted"; exit 1; }
[ "$(code -b "$JAR" -X PUT "$BASE/api/v1/settings/access/sub-path" -H 'Content-Type: application/json' \
    -d "{\"version\":$AV,\"sub_path\":\"feed-smoke\",\"confirm\":true,\"notify_users\":false}")" = "200" ] \
  && last_json "d['notify_job'] is None and d['access']['sub_path'] == 'feed-smoke'" | matches '^True$' \
  || { echo "FAIL: sub path change: $(cat /tmp/akari-smoke/last)"; exit 1; }
[ "$(fp "$SUBBASE/$SP_TOKEN")" = "$REJ" ] || { echo "FAIL: the old subscription path still answers"; exit 1; }
subrl
[ "$(code "$ROOT/feed-smoke/$SP_TOKEN")" = "200" ] || { echo "FAIL: the new subscription path"; exit 1; }
[ "$(psql_q "SELECT before->>'sub_path' || '>' || (after->>'sub_path') FROM audit_log WHERE action = 'settings.sub_path.update'")" = "$SUBP>feed-smoke" ] \
  || { echo "FAIL: sub path change not audited"; exit 1; }
for p in "$PREFIX" "${OLD_BASE##*/}" smoke-door-2026; do
  grep -qF "$p" "$LOG/panel.log" "$LOG/panel2.log" && { echo "FAIL: an admin prefix appears in the panel log"; exit 1; }
done
grep -qF "$NEW_TOKEN" "$LOG/panel.log" "$LOG/panel2.log" && { echo "FAIL: a subscription token appears in the panel log"; exit 1; }
kill $PANEL_PID 2>/dev/null; wait $PANEL_PID 2>/dev/null || true
echo "admin prefix, allowlist, subscription path: ok"

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
