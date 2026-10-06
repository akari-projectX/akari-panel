#!/usr/bin/env bash
# Portal end-to-end (W36-b): a real panel serving the embedded portal at `/`
# with its real CSP, driven by Playwright (spa/e2e/, desktop + phone).
#
# Isolated from smoke and the dev panel: own database ($E2E_DB, dropped and
# recreated), own Valkey index ($E2E_VALKEY_DB, flushed), own data dir
# ($E2E_DIR), own ports (web 8090, TLS 8493, gRPC 8453, Mailpit
# 11026/18026, mock Alipay 18489). Needs `make dev-up`, a panel binary with
# the current portal (`make spa panel`, or `make e2e`; PANEL_BIN overrides)
# and `npx playwright install chromium` once.
#
# The browser opens https://portal.e2e.test:8493 (spa/e2e/tls-proxy.mjs with
# a throwaway certificate Chromium is told to trust, the name mapped to
# 127.0.0.1): the main domain is an https origin like in production, so
# passkeys (WebAuthn, a virtual authenticator) work end to end, and mail
# links point at it. API calls of the seed and the tests go straight to the
# panel on 127.0.0.1 (IP literals pass the host gate).
# Extra arguments go to `playwright test` (e.g. --project=mobile -g shop).
set -euo pipefail
cd "$(dirname "$0")/.."

PANEL=$(realpath "${PANEL_BIN:-./target/release/akari}")
E2E_DB=${E2E_DB:-akari_e2e}
E2E_VALKEY_DB=${E2E_VALKEY_DB:-15}
PORT=${E2E_PORT:-8090}
GRPC_PORT=${E2E_GRPC_PORT:-8453}
PAY_PORT=${E2E_PAY_PORT:-18489}
TLS_PORT=${E2E_TLS_PORT:-8493}
HOST=portal.e2e.test
DIR=${E2E_DIR:-/tmp/akari-e2e-portal}
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
cookie_secure = false
trusted_proxies = ["127.0.0.1/32"]
[grpc]
bind = "127.0.0.1:$GRPC_PORT"
TOML

PIDS=()
cleanup() {
  [ ${#PIDS[@]} -eq 0 ] || kill "${PIDS[@]}" 2>/dev/null || true
  wait 2>/dev/null || true
  docker rm -f "$MAILPIT" >/dev/null 2>&1 || true
}
MAILPIT=akari-e2e-mailpit
trap cleanup EXIT

# Mailpit: the SMTP sink (registration codes, reset links, email change).
docker rm -f "$MAILPIT" >/dev/null 2>&1 || true
docker run -d --name "$MAILPIT" --network host -e MP_SMTP_BIND_ADDR=127.0.0.1:11026 \
  -e MP_UI_BIND_ADDR=127.0.0.1:18026 axllent/mailpit:v1.27 >/dev/null

# Throwaway Alipay key pairs for the mock gateway (spa/e2e/mock-alipay.py).
PAY="$DIR/pay"
mkdir -p "$PAY"
for k in app alipay; do
  ( umask 077; openssl genrsa -out "$PAY/$k-key.pem" 2048 2>/dev/null )
  openssl rsa -in "$PAY/$k-key.pem" -pubout -out "$PAY/$k-pub.pem" 2>/dev/null
done
python3 spa/e2e/mock-alipay.py "$PAY" "$PAY_PORT" >"$DIR/mock-alipay.log" 2>&1 &
PAY_PID=$!
PIDS+=("$PAY_PID")

# The TLS front: a throwaway certificate for $HOST; Chromium trusts exactly
# its key (--ignore-certificate-errors-spki-list, playwright.config.ts).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj "/CN=$HOST" \
  -addext "subjectAltName=DNS:$HOST" -keyout "$DIR/tls-key.pem" -out "$DIR/tls-cert.pem" 2>/dev/null
E2E_TLS_SPKI=$(openssl x509 -in "$DIR/tls-cert.pem" -pubkey -noout | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | base64)
export E2E_TLS_SPKI E2E_TLS_HOST=$HOST
node spa/e2e/tls-proxy.mjs "$DIR/tls-cert.pem" "$DIR/tls-key.pem" "$TLS_PORT" "http://127.0.0.1:$PORT" >"$DIR/tls-proxy.log" 2>&1 &
TLS_PID=$!
PIDS+=("$TLS_PID")

# The relay entrance's address (spa/e2e/seed.ts): something must accept TCP
# there, or the panel's relay health check hides the entrance after 3 minutes.
python3 -m http.server --bind 127.0.0.1 21446 >"$DIR/relay.log" 2>&1 &
RELAY_PID=$!
PIDS+=("$RELAY_PID")

PREFIX=$("$PANEL" -c "$DIR/panel.toml" info | awk '/admin prefix/{sub(/^\//,"",$3); print $3}')
"$PANEL" -c "$DIR/panel.toml" serve >"$DIR/panel.log" 2>&1 &
PANEL_PID=$!
PIDS+=("$PANEL_PID")
for _ in $(seq 1 120); do
  [ "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/$PREFIX/healthz")" = "200" ] && break
  kill -0 $PANEL_PID 2>/dev/null || { echo "FAIL: panel exited"; cat "$DIR/panel.log"; exit 1; }
  sleep 0.5
done

ADMIN_PW="e2e-admin-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
AKARI_ADMIN_PASSWORD="$ADMIN_PW" "$PANEL" -c "$DIR/panel.toml" admin add admin@e2e.test >/dev/null

export E2E_ORIGIN="https://$HOST:$TLS_PORT" E2E_API="http://127.0.0.1:$PORT"
export E2E_ADMIN_BASE="$E2E_API/$PREFIX"
export E2E_ADMIN_EMAIL=admin@e2e.test E2E_ADMIN_PASSWORD="$ADMIN_PW"
export E2E_MOCK_ALIPAY="http://127.0.0.1:$PAY_PORT" E2E_PAY_DIR="$PAY"
export E2E_MAILPIT=http://127.0.0.1:18026/api/v1 E2E_SMTP_PORT=11026
export E2E_PSQL="docker compose -f $PWD/docker-compose.yml exec -T postgres psql -U akari -d $E2E_DB"
export E2E_SEED="$DIR/seed.json" NO_PROXY='*' no_proxy='*'
node spa/e2e/seed.ts >"$E2E_SEED"
[ -n "${E2E_SEED_HOOK:-}" ] && eval "$E2E_SEED_HOOK"

echo "e2e: $E2E_ORIGIN/"
cd spa
E2E_BASE="$E2E_ORIGIN" npx playwright test "$@"
