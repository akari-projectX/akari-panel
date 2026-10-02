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
cat >"$DIR/panel.toml" <<TOML
data_dir = "$DIR/data"
[web]
bind = "127.0.0.1:$PORT"
advertised_names = ["localhost", "127.0.0.1", "myapp.test"]
cookie_secure = false
[grpc]
bind = "127.0.0.1:$GRPC_PORT"
advertise = "127.0.0.1:$GRPC_PORT"
TOML

PREFIX=$("$PANEL" -c "$DIR/panel.toml" info | awk '/route prefix/{sub(/^\//,"",$3); print $3}')
# W16: payments on (throwaway keys, a gateway nobody listens on) so the
# shop, coupons and balance can be driven; the e2e purchases are fully
# covered by a coupon / the balance and never reach the gateway.
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
notify_url = "http://$E2E_HOST:$PORT/$PREFIX/pay/alipay/notify"
TOML
"$PANEL" -c "$DIR/panel.toml" serve >"$DIR/panel.log" 2>&1 &
PANEL_PID=$!
trap 'kill $PANEL_PID 2>/dev/null || true; wait $PANEL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  [ "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/$PREFIX/healthz")" = "200" ] && break
  kill -0 $PANEL_PID 2>/dev/null || { echo "FAIL: panel exited"; cat "$DIR/panel.log"; exit 1; }
  sleep 0.5
done

ADMIN_PW="e2e-admin-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
USER_PW="e2e-user-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" -c "$DIR/panel.toml" admin add e2e-admin >/dev/null
AKARI_ADMIN_PASSWORD="$USER_PW" "$PANEL" -c "$DIR/panel.toml" admin add e2e-user --role user >/dev/null

echo "e2e: http://$E2E_HOST:$PORT/$PREFIX/app"
cd spa
E2E_BASE="http://$E2E_HOST:$PORT/$PREFIX/app" \
  E2E_ADMIN=e2e-admin E2E_ADMIN_PW="$ADMIN_PW" \
  E2E_USER=e2e-user E2E_USER_PW="$USER_PW" \
  NO_PROXY='*' no_proxy='*' \
  npx playwright test "$@"
