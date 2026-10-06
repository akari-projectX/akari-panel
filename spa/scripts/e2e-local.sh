#!/usr/bin/env bash
# 门户端到端测试：起一个真实的面板（akari-panel 的二进制 + 一个空数据库），灌数据，再用 Playwright 跑。
#
#   PANEL_BIN=../akari-panel/target/debug/akari \
#   DATABASE_URL=postgres://akari:akari-dev@127.0.0.1:5432/akari_portal_e2e \
#   VALKEY_URL=redis://127.0.0.1:6379/7 \
#   PSQL="docker exec -i akari-panel-postgres-1 psql -U akari -d akari_portal_e2e" \
#   scripts/e2e-local.sh [playwright 参数…]
#
# 数据库必须是空的（脚本不建库、不删库）；Valkey 用一个没人用的库号。面板的数据目录（CA 私钥等）放在 .e2e/ 下，
# 跑完连同日志一起留着便于排查，下次运行前清掉。门户按过渡期的 prefixed 方式构建，由 scripts/e2e-server.mjs
# 和面板拼到同一个源上（面板 main 的门户位置）。W36-b PR2 并入面板仓库后，这一步改用面板自己下发门户。
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PANEL_BIN:?path to the akari binary}" "${DATABASE_URL:?}" "${VALKEY_URL:?}" "${PSQL:?}"
PANEL_BIN=$(realpath "$PANEL_BIN")
WORK=$PWD/.e2e
WEB=127.0.0.1:18480
PORT=18490
ADMIN_EMAIL=admin@e2e.test
ADMIN_PASSWORD=e2e-admin-password-123

rm -rf "$WORK" && mkdir -p "$WORK"
cat >"$WORK/panel.toml" <<TOML
data_dir = "$WORK/data"
database_url = "$DATABASE_URL"
valkey_url = "$VALKEY_URL"
[web]
bind = "$WEB"
cookie_secure = false
trusted_proxies = ["127.0.0.1/32"]
[grpc]
bind = "127.0.0.1:18443"
TOML

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

(cd "$WORK" && exec "$PANEL_BIN" -c "$WORK/panel.toml" serve >"$WORK/panel.log" 2>&1) &
pids+=($!)
for _ in $(seq 1 120); do curl -sf --noproxy '*' "http://$WEB/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
PREFIX=$(cd "$WORK" && "$PANEL_BIN" -c "$WORK/panel.toml" info | awk '/route prefix/{sub(/^\//,"",$3); print $3}')
curl -sf --noproxy '*' "http://$WEB/$PREFIX/healthz" >/dev/null || { echo "panel not up"; tail -20 "$WORK/panel.log"; exit 1; }
(cd "$WORK" && AKARI_ADMIN_PASSWORD=$ADMIN_PASSWORD "$PANEL_BIN" -c "$WORK/panel.toml" admin add "$ADMIN_EMAIL" >/dev/null)

# 支付宝当面付的模拟网关（临时密钥，从不用真凭据），面板通过后台接口把它配成支付方式
PAY=$WORK/pay && mkdir -p "$PAY"
for k in app alipay; do
  openssl genrsa -out "$PAY/$k-key.pem" 2048 2>/dev/null
  openssl rsa -in "$PAY/$k-key.pem" -pubout -out "$PAY/$k-pub.pem" 2>/dev/null
done
python3 e2e/mock-alipay.py "$PAY" 18489 >"$WORK/mock-alipay.log" 2>&1 &
pids+=($!)

PANEL_URL=http://$WEB PANEL_PREFIX=$PREFIX ADMIN_EMAIL=$ADMIN_EMAIL ADMIN_PASSWORD=$ADMIN_PASSWORD \
  PORTAL_HOST=127.0.0.1:$PORT PAY_DIR=$PAY MOCK_ALIPAY=http://127.0.0.1:18489 \
  node e2e/seed.mjs >"$WORK/seed.json"

VITE_PORTAL_MODE=prefixed npx vite build --logLevel warn
PANEL_URL=http://$WEB PANEL_PREFIX=$PREFIX PORT=$PORT node scripts/e2e-server.mjs >"$WORK/portal.log" 2>&1 &
pids+=($!)
sleep 0.5

E2E_BASE="http://127.0.0.1:$PORT/$PREFIX/app" E2E_SEED="$WORK/seed.json" npx playwright test "$@"
