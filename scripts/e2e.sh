#!/usr/bin/env bash
# Playwright end-to-end (OPUS-GUIDE A17): a real release panel serving the
# embedded SPA with its real CSP, driven by Chromium (spa/e2e/).
#
# Isolated from smoke and from the dev panel: own database ($E2E_DB, dropped
# and recreated), own Valkey index ($E2E_VALKEY_DB, flushed), own data dir
# (/tmp/akari-e2e), own ports (web 8090, gRPC 8453). Needs `make dev-up`, a
# release build with the current SPA (`make spa panel`, or `make e2e`), and
# `npx playwright install chromium` once.
#
# Host: myapp.test when it resolves (the dev machine maps it to 127.0.0.1,
# so the same URL opens from the Windows browser), else 127.0.0.1 (CI).
set -euo pipefail
cd "$(dirname "$0")/.."

PANEL=./target/release/akari
E2E_DB=${E2E_DB:-akari_e2e}
E2E_VALKEY_DB=${E2E_VALKEY_DB:-15}
PORT=${E2E_PORT:-8090}
GRPC_PORT=${E2E_GRPC_PORT:-8453}
DIR=/tmp/akari-e2e
if [ -z "${E2E_HOST:-}" ]; then
  if getent hosts myapp.test >/dev/null 2>&1; then E2E_HOST=myapp.test; else E2E_HOST=127.0.0.1; fi
fi
export DATABASE_URL="postgres://akari:akari-dev@localhost:5432/$E2E_DB"
export VALKEY_URL="redis://127.0.0.1:6379/$E2E_VALKEY_DB"

[ -x "$PANEL" ] || { echo "FAIL: $PANEL missing (make spa panel)"; exit 1; }
psql_admin() { docker compose exec -T postgres psql -U akari -d postgres -qc "$1" >/dev/null; }
psql_admin "DROP DATABASE IF EXISTS \"$E2E_DB\" WITH (FORCE)"
psql_admin "CREATE DATABASE \"$E2E_DB\""
docker compose exec -T valkey valkey-cli -n "$E2E_VALKEY_DB" flushdb >/dev/null

rm -rf "$DIR" && mkdir -p "$DIR"
# W25 (R39): web.advertised_names, grpc.advertise and [audit] are OBSOLETE —
# kept here on purpose (like [payments.alipay] below): the first start
# imports them once into 系统设置 (node domain, certificate names, audit
# retention), which the W25 test then sees in the console.
cat >"$DIR/panel.toml" <<TOML
data_dir = "$DIR/data"
[web]
bind = "127.0.0.1:$PORT"
advertised_names = ["localhost", "127.0.0.1", "myapp.test"]
cookie_secure = false
[grpc]
bind = "127.0.0.1:$GRPC_PORT"
advertise = "127.0.0.1:$GRPC_PORT"
[audit]
retention_days = 180
TOML

# W15: Mailpit as the SMTP sink (loopback; SMTP 11026, API 18026 — not
# smoke's ports). The registration/reset test reads codes and links from it.
MAILPIT=akari-e2e-mailpit
docker rm -f "$MAILPIT" >/dev/null 2>&1 || true
docker run -d --name "$MAILPIT" --network host -e MP_SMTP_BIND_ADDR=127.0.0.1:11026 \
  -e MP_UI_BIND_ADDR=127.0.0.1:18026 axllent/mailpit:v1.27 >/dev/null

# D4: the admin prefix (the first start imports data/state.json's into the
# database; `info` prints that one before the first start).
PREFIX=$("$PANEL" -c "$DIR/panel.toml" info | awk '/admin prefix/{sub(/^\//,"",$3); print $3}')
# W16: payments on (throwaway keys, a gateway nobody listens on) so the
# shop, coupons and balance can be driven; the e2e purchases are fully
# covered by a coupon / the balance and never reach the gateway.
# W24/R40: [payments.alipay] is OBSOLETE — kept here on purpose: the first
# start imports it once into 系统设置 → 支付 as a payment method (the
# upgrade path), which the W24 test then sees in the console.
( umask 077
  openssl genrsa -out "$DIR/app-key.pem" 2048 2>/dev/null
  openssl genrsa -out "$DIR/alipay-key.pem" 2048 2>/dev/null )
openssl rsa -in "$DIR/alipay-key.pem" -pubout -out "$DIR/alipay-pub.pem" 2>/dev/null
cat >>"$DIR/panel.toml" <<TOML
[payments.alipay]
enabled = true
app_id = "2021000000000000"
app_private_key_file = "$DIR/app-key.pem"
alipay_public_key_file = "$DIR/alipay-pub.pem"
gateway_url = "http://127.0.0.1:9/gateway.do"
notify_url = "http://$E2E_HOST:$PORT/pay/alipay/notify"
TOML
# One-click agent update check: a throwaway Ed25519 release key (trusted by
# this panel only: 系统设置 → 安全's extra keys, set in the database below) and a signed two-platform release behind a local stand-in
# for the GitHub API (plain http is accepted for loopback only).
REL_PORT=${E2E_RELEASE_PORT:-18097}
REL="$DIR/release"
mkdir -p "$REL/www/dl" "$REL/www/repos/akari-projectX/akari-agent/releases"
openssl genpkey -algorithm ed25519 -out "$REL/key.pem" 2>/dev/null
openssl pkey -in "$REL/key.pem" -pubout -outform DER 2>/dev/null | tail -c 32 >"$REL/pub.raw"
python3 - "$REL" "$REL_PORT" <<'PY'
import base64, hashlib, json, os, subprocess, sys
rel, port, ver = sys.argv[1], sys.argv[2], "v0.9.0"
dl = os.path.join(rel, "www", "dl")
key_id = hashlib.sha256(open(os.path.join(rel, "pub.raw"), "rb").read()).hexdigest()[:16]
for arch in ("amd64", "arm64"):
    name = "akari-agent-linux-" + arch
    binary = os.urandom(200_000)
    open(os.path.join(dl, name), "wb").write(binary)
    manifest = json.dumps({"schema": 1, "version": ver, "os": "linux", "arch": arch,
                           "sha256": hashlib.sha256(binary).hexdigest(), "size": len(binary),
                           "min_panel_protocol": 3, "created_at": "2026-10-03T00:00:00Z",
                           "rollback": False}, separators=(",", ":")).encode()
    open(os.path.join(dl, name + ".manifest.json"), "wb").write(manifest)
    msg = os.path.join(rel, name + ".msg")  # Ed25519 -rawin reads a file, not stdin (OpenSSL 3.0)
    open(msg, "wb").write(b"akari-agent-manifest-v1\n" + manifest)
    sig = subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", os.path.join(rel, "key.pem"), "-rawin", "-in", msg],
                         capture_output=True, check=True).stdout
    json.dump({"signatures": [{"key_id": key_id, "sig": base64.b64encode(sig).decode()}]},
              open(os.path.join(dl, name + ".manifest.sig"), "w"))
names = sorted(os.listdir(dl))
with open(os.path.join(dl, "SHA256SUMS"), "w") as f:
    for n in names:
        f.write("%s  %s\n" % (hashlib.sha256(open(os.path.join(dl, n), "rb").read()).hexdigest(), n))
assets = [{"name": n, "size": os.path.getsize(os.path.join(dl, n)),
           "browser_download_url": "http://127.0.0.1:%s/dl/%s" % (port, n)} for n in sorted(os.listdir(dl))]
json.dump({"tag_name": ver, "name": ver, "draft": False, "prerelease": False, "assets": assets},
          open(os.path.join(rel, "www/repos/akari-projectX/akari-agent/releases/latest"), "w"))
PY
python3 -m http.server --bind 127.0.0.1 --directory "$REL/www" "$REL_PORT" >"$REL/server.log" 2>&1 &
REL_PID=$!
"$PANEL" -c "$DIR/panel.toml" serve >"$DIR/panel.log" 2>&1 &
PANEL_PID=$!
trap 'kill $PANEL_PID $REL_PID 2>/dev/null || true; wait $PANEL_PID 2>/dev/null || true; docker rm -f "$MAILPIT" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  [ "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/$PREFIX/healthz")" = "200" ] && break
  kill -0 $PANEL_PID 2>/dev/null || { echo "FAIL: panel exited"; cat "$DIR/panel.log"; exit 1; }
  sleep 0.5
done

# The throwaway release key as an extra trusted key (W25: in the database,
# not panel.toml; the settings trigger reloads the running panel).
docker compose exec -T postgres psql -U akari -d "$E2E_DB" -qc \
  "UPDATE panel_settings SET extra_release_keys = ARRAY['$(base64 -w0 "$REL/pub.raw") e2e'], version = version + 1" >/dev/null

ADMIN_PW="e2e-admin-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
USER_PW="e2e-user-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" -c "$DIR/panel.toml" admin add e2e-admin@e2e.test >/dev/null
AKARI_ADMIN_PASSWORD="$USER_PW" "$PANEL" -c "$DIR/panel.toml" admin add e2e-user@e2e.test --role user >/dev/null
# W20: a second user that the spec drives into quota exhaustion.
AKARI_ADMIN_PASSWORD="$USER_PW" "$PANEL" -c "$DIR/panel.toml" admin add e2e-quota@e2e.test --role user >/dev/null
# W22: two UTC days of traffic history for e2e-user on a node that no
# longer exists (portal: "其他节点 / Other nodes"; console: "已删除的节点").
docker compose exec -T postgres psql -U akari -d "$E2E_DB" -qc "
  INSERT INTO traffic_daily (user_id, day, node_id, entrance_id, up_bytes, down_bytes, billed_bytes)
  SELECT id, (now() AT TIME ZONE 'UTC')::date - d, '00000000-0000-4000-8000-0000000000e2',
         '00000000-0000-4000-8000-0000000000e3',
         (2 - d) * 536870912, (2 - d) * 536870912, (2 - d) * 536870912
  FROM users CROSS JOIN generate_series(0, 1) d WHERE email = 'e2e-user@e2e.test';
  INSERT INTO traffic_entrance_daily (entrance_id, day, node_id, up_bytes, down_bytes, billed_bytes, users)
  SELECT entrance_id, day, node_id, up_bytes, down_bytes, billed_bytes, 1 FROM traffic_daily;" >/dev/null

echo "e2e: http://$E2E_HOST:$PORT/$PREFIX/app"
cd spa
E2E_BASE="http://$E2E_HOST:$PORT/$PREFIX/app" \
  E2E_ADMIN=e2e-admin@e2e.test E2E_ADMIN_PW="$ADMIN_PW" \
  E2E_USER=e2e-user@e2e.test E2E_USER_PW="$USER_PW" \
  E2E_QUOTA_USER=e2e-quota@e2e.test E2E_DB="$E2E_DB" E2E_PAY_DIR="$DIR" \
  E2E_MAILPIT=http://127.0.0.1:18026/api/v1 E2E_SMTP_PORT=11026 \
  E2E_RELEASE_SOURCE="http://127.0.0.1:$REL_PORT/repos/akari-projectX/akari-agent/releases/latest" \
  NO_PROXY='*' no_proxy='*' \
  npx playwright test "$@"
