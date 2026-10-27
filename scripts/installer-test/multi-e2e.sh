#!/usr/bin/env bash
# Installer end-to-end test, several panel instances: two fresh systemd
# containers (A, B) on one docker network (CI job installer-multi;
# docs/DEPLOY.md "Installer tests").
#
#   multi-e2e.sh BASE_IMAGE RELEASES_DIR NEW_TAG UP1_TAG UP2_TAG AGENT_BIN
#
#   RELEASES_DIR  local releases (make-release.sh): NEW_TAG = the build under
#                 test; UP1_TAG / UP2_TAG = "newer" wrapper releases
#                 (--wrapper /opt/akari-real) with schema_compat_previous
#                 true / false
#   AGENT_BIN     a real akari-agent binary (runs on the host, dials B)
#
# Flow: install A (IP only) -> expose-data refusals (public / too wide
# networks) -> expose-data for a network that does NOT contain B (B is
# blocked by the firewall) -> again with B's network (B reaches TLS-only
# PostgreSQL / Valkey) -> join-bundle (passphrase printed once, never in the
# log) -> refusals on B: wrong passphrase, an expired bundle -> install.sh
# --join on B (the bundle is deleted) -> a session of A works on B (shared
# jwt.key) -> an agent enrolled on A converges through B's gRPC -> lb-config
# for caddy / haproxy / nginx validates with the real programs ->
# set-trusted-proxies -> info shows roles and peers -> rolling upgrades:
# refused without --rolling, a compatible release one instance at a time,
# an incompatible release only with the others stopped (A first, then B) ->
# the primary cannot be uninstalled while B uses its database.
set -euo pipefail

base=${1:?usage: multi-e2e.sh BASE_IMAGE RELEASES_DIR NEW_TAG UP1_TAG UP2_TAG AGENT_BIN}
rel=$(cd "${2:?}" && pwd)
new=${3:?}
up1=${4:?}
up2=${5:?}
agent_bin=$(readlink -f "${6:?}")
root=$(cd "$(dirname "$0")/../.." && pwd)
tag="$$"
net="akari-multi-$tag"
ca="akari-multi-a-$tag"
cb="akari-multi-b-$tag"
img="akari-installer-test:${base//[:]/-}"
pw="e2e-Admin-Pass-$(date +%s)"
work=$(mktemp -d)
log() { printf '\n\033[1;36m### %s\033[0m\n' "$*"; }
fail() {
	printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2
	for c in "$ca" "$cb"; do
		echo "--- $c" >&2
		docker exec "$c" sh -c 'tail -n 40 /var/log/akari-install.log; journalctl -u akari-panel -n 30 --no-pager -o cat; journalctl -u akari-valkey -u postgresql@18-main -n 15 --no-pager -o cat' >&2 || true
	done
	tail -n 30 "$work/agent.log" >&2 2>/dev/null || true
	exit 1
}
agent_pid=
cleanup() {
	[ -z "$agent_pid" ] || kill "$agent_pid" 2>/dev/null || true
	if [ "${KEEP:-0}" != 1 ]; then
		docker rm -f "$ca" "$cb" >/dev/null 2>&1 || true
		docker network rm "$net" >/dev/null 2>&1 || true
	fi
	rm -rf "$work"
}
trap cleanup EXIT

log "image $img ($base), network $net"
if [ "${REBUILD:-1}" = 1 ] || ! docker image inspect "$img" >/dev/null 2>&1; then
	docker build -q -t "$img" --build-arg "BASE=$base" "$root/scripts/installer-test" >/dev/null
fi
docker network create "$net" >/dev/null
subnet=$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$net")
echo "subnet $subnet"

cg=(--cgroupns=private)
if [ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ]; then
	cg=(--cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw)
fi
start() { # start NAME
	docker run -d --name "$1" --network "$net" --privileged "${cg[@]}" --tmpfs /run --tmpfs /run/lock \
		-v "$root:/src:ro" -v "$rel:/rel:ro" "$img" >/dev/null
	for _ in $(seq 60); do
		case $(docker exec "$1" systemctl is-system-running 2>/dev/null || true) in running | degraded) return 0 ;; esac
		sleep 1
	done
	fail "$1 did not boot"
}
start "$ca"
start "$cb"
ip_of() { docker inspect -f "{{(index .NetworkSettings.Networks \"$net\").IPAddress}}" "$1"; }
ipa=$(ip_of "$ca")
ipb=$(ip_of "$cb")
echo "A $ipa  B $ipb"

# inc CONTAINER CMD...: with the installer's environment; secrets by name.
inc() {
	local c=$1
	shift
	docker exec -e LANG=C.UTF-8 -e AKARI_LANG=en -e AKARI_ADMIN_PASSWORD="$pw" -e AKARI_SOURCE_DIR=/src \
		-e AKARI_RELEASES_URL=file:///rel -e AKARI_COSIGN_KEY=/rel/cosign.pub "$c" "$@"
}
ina() { inc "$ca" "$@"; }
inb() { inc "$cb" "$@"; }
# tcp_open CONTAINER HOST PORT: a TCP connection succeeds within 3 s.
tcp_open() { docker exec "$1" timeout 3 bash -c "exec 3<>/dev/tcp/$2/$3" 2>/dev/null; }
prefix_of() { ina akari-ctl info | sed -n '1s#.*://[^/]*/\([^/]*\)/app$#\1#p'; }
version_of() { docker exec "$1" sed -n 's/^VERSION=//p' /etc/akari/install.env; }
status_ok() { inc "$1" akari-ctl status >/dev/null; }

# --- 1. instance A ------------------------------------------------------------------------------
log "install $new on A (IP only)"
ina sh /src/scripts/install.sh --yes --mode bare --version "$new" --ip "$ipa" || fail "install A"
P=$(prefix_of)
[ -n "$P" ] || fail "no prefix on A"
ina cp /usr/local/bin/akari /opt/akari-real
[ "$(version_of "$ca")" = "$new" ] || fail "A is not at $new"
echo "ok: A installed, prefix known"

log "expose-data refuses public and too wide networks"
for net_bad in 8.8.8.0/24 0.0.0.0/0 10.0.0.0/7 172.32.0.0/16 192.169.0.0/16 not-a-cidr; do
	if ina akari-ctl expose-data --yes --allow "$net_bad" >"$work/refused.log" 2>&1; then
		cat "$work/refused.log"
		fail "expose-data accepted $net_bad"
	fi
	grep -qF "$net_bad" "$work/refused.log" || { cat "$work/refused.log"; fail "the refusal does not name $net_bad"; }
done
ina test -e /etc/akari/multi.env && fail "a refused expose-data left state"
ina test -e /etc/akari/data-firewall.nft && fail "a refused expose-data wrote a firewall"
ina akari-ctl join-bundle --yes >"$work/refused.log" 2>&1 && fail "join-bundle worked before expose-data"
echo "ok: refused"

log "expose-data for a network without B: B is blocked"
ina akari-ctl expose-data --yes --allow 10.99.0.0/16 --listen "$ipa" || fail "expose-data (wrong network)"
if tcp_open "$cb" "$ipa" 5432; then fail "B reached PostgreSQL through the firewall"; fi
if tcp_open "$cb" "$ipa" 6379; then fail "B reached Valkey through the firewall"; fi
echo "ok: B blocked"

log "expose-data for B's network"
ina akari-ctl expose-data --yes --allow "$subnet" || fail "expose-data"
tcp_open "$cb" "$ipa" 5432 || fail "B cannot reach PostgreSQL"
tcp_open "$cb" "$ipa" 6379 || fail "B cannot reach Valkey"
ina nft list table inet akari_data | grep -qF "${subnet%/*}" || fail "the firewall does not name the network"
ina nft list table inet akari_data | grep -qF 10.99.0.0 && fail "the old network is still in the firewall"
# Listening: loopback + the private address only, never every address.
for port in 5432 6379; do
	ina ss -Hltn "sport = :$port" | awk '{ print $4 }' | sort | tr '\n' ' ' >"$work/listen"
	[ "$(cat "$work/listen")" = "127.0.0.1:$port $ipa:$port " ] || fail "port $port listens on: $(cat "$work/listen")"
done
# TLS only: PostgreSQL refuses an unencrypted login (hostssl), Valkey does not
# speak plain text.
if ina sh -c "cd / && runuser -u postgres -- psql -w \"host=$ipa port=5432 dbname=akari user=akari sslmode=disable\" -c 'select 1'" >"$work/plain.log" 2>&1; then
	fail "PostgreSQL accepted an unencrypted connection from the private address"
fi
grep -q 'no encryption\|SSL' "$work/plain.log" || { cat "$work/plain.log"; fail "the unencrypted refusal is not about encryption"; }
docker exec "$cb" bash -c "exec 3<>/dev/tcp/$ipa/6379; printf 'PING\r\n' >&3; timeout 2 head -c 64 <&3 || true" 2>/dev/null | grep -q PONG && fail "Valkey answered a plain-text PING"
ina stat -c '%a' /etc/akari/data-ca | grep -qx 700 || fail "data-ca is not 0700"
ina stat -c '%a %U' /etc/postgresql/18/main/akari-tls/server.key | grep -qx '600 postgres' || fail "the PostgreSQL key is not 0600 postgres"
ina stat -c '%a' /etc/akari/shared/ca.pem | grep -qx 644 || fail "the shared CA is not public"
ina grep -q 'rediss://' /etc/akari/panel.toml || fail "the local panel does not use TLS for Valkey"
ina sh -c 'cd / && runuser -u akari -- env SSL_CERT_FILE=/etc/akari/shared/ca.pem akari -c /etc/akari/panel.toml config check' >/dev/null || fail "config check"
status_ok "$ca" || fail "A is not healthy after expose-data"
echo "ok: TLS-only, private address only, firewall limited to $subnet"

# --- 2. the join bundle ----------------------------------------------------------------------------
log "join-bundle"
ina akari-ctl join-bundle --yes --out /root/join.age >"$work/bundle.out" || fail "join-bundle"
secret=$(grep -o 'AGE-SECRET-KEY-1[0-9A-Z]*' "$work/bundle.out" | sed -n 1p)
[ -n "$secret" ] || { cat "$work/bundle.out"; fail "no passphrase printed"; }
[ "$(grep -c 'AGE-SECRET-KEY-1' "$work/bundle.out")" = 1 ] || fail "the passphrase is printed more than once"
ina stat -c '%a' /root/join.age | grep -qx 600 || fail "the bundle is not 0600"
ina grep -qF "$secret" /var/log/akari-install.log && fail "the passphrase is in the install log"
ina grep -q 'AGE-SECRET-KEY' /etc/akari/multi.env /etc/akari/install.env && fail "the passphrase is in the state files"
# What is inside: the agent CA and the keys, the shared CA, URLs with TLS
# verification; NOT the data-services CA key.
ina sh -c "mkdir -p /root/jb && printf '%s\n' '$secret' >/root/jb.id && age -d -i /root/jb.id -o /root/jb.tar /root/join.age && tar -xf /root/jb.tar -C /root/jb" || fail "decrypt the bundle"
for f in META db.url valkey.url ca.pem data/ca.pem data/ca.key.pem data/jwt.key data/master.key; do
	ina test -s "/root/jb/$f" || fail "the bundle lacks $f"
done
ina grep -q "sslmode=verify-full" /root/jb/db.url || fail "the database URL does not verify the server"
ina grep -q "^rediss://" /root/jb/valkey.url || fail "the Valkey URL is not TLS"
ina grep -qF "$(ina sed -n 2p /etc/akari/data-ca/ca.key)" -r /root/jb && fail "the data CA private key is in the bundle"
# An expired copy (made 25 hours ago) and a bundle for another passphrase.
ina sh -c "sed -i \"s/^created_at=.*/created_at=\$(( \$(date +%s) - 90000 ))/\" /root/jb/META && tar -C /root/jb -cf /root/jb-old.tar META db.url valkey.url ca.pem data && age -r \"\$(age-keygen -y /root/jb.id)\" -o /root/join-expired.age /root/jb-old.tar" || fail "make the expired bundle"
ina sh -c 'rm -rf /root/jb /root/jb.id /root/jb.tar /root/jb-old.tar'
for f in join.age join-expired.age; do
	docker cp "$ca:/root/$f" "$work/$f"
	docker cp "$work/$f" "$cb:/root/$f"
done
echo "ok: bundle ($(wc -c <"$work/join.age") bytes), secret shown once and not logged"

log "join refusals on B: wrong passphrase, expired bundle"
wrong=$(ina age-keygen 2>/dev/null | sed -n '/^AGE-SECRET-KEY-/p')
if docker exec -e AKARI_JOIN_PASSPHRASE="$wrong" -e AKARI_LANG=en -e LANG=C.UTF-8 -e AKARI_SOURCE_DIR=/src -e AKARI_RELEASES_URL=file:///rel -e AKARI_COSIGN_KEY=/rel/cosign.pub \
	"$cb" sh /src/scripts/install.sh --join /root/join.age --yes >"$work/refused.log" 2>&1; then
	fail "a wrong passphrase was accepted"
fi
grep -qi 'cannot decrypt\|wrong passphrase' "$work/refused.log" || { cat "$work/refused.log"; fail "no clear message for a wrong passphrase"; }
if docker exec -e AKARI_JOIN_PASSPHRASE="$secret" -e AKARI_LANG=en -e LANG=C.UTF-8 -e AKARI_SOURCE_DIR=/src -e AKARI_RELEASES_URL=file:///rel -e AKARI_COSIGN_KEY=/rel/cosign.pub \
	"$cb" sh /src/scripts/install.sh --join /root/join-expired.age --yes >"$work/refused.log" 2>&1; then
	fail "an expired bundle was accepted"
fi
grep -qi 'expired' "$work/refused.log" || { cat "$work/refused.log"; fail "no clear message for an expired bundle"; }
docker exec "$cb" test -e /etc/akari && fail "a refused join left /etc/akari behind"
docker exec "$cb" test -e /usr/local/bin/akari && fail "a refused join installed the panel"
docker exec "$cb" test -f /root/join.age || fail "a refused join deleted the bundle"
echo "ok: refused, nothing installed"

# --- 3. instance B ----------------------------------------------------------------------------------
log "join B"
docker exec -e AKARI_JOIN_PASSPHRASE="$secret" -e AKARI_LANG=en -e LANG=C.UTF-8 -e AKARI_SOURCE_DIR=/src -e AKARI_RELEASES_URL=file:///rel -e AKARI_COSIGN_KEY=/rel/cosign.pub \
	"$cb" sh /src/scripts/install.sh --join /root/join.age --yes || fail "join"
docker exec "$cb" test -e /root/join.age && fail "the bundle was not deleted after the join"
docker exec "$cb" grep -qF "$secret" /var/log/akari-install.log && fail "the passphrase is in B's install log"
inb cp /usr/local/bin/akari /opt/akari-real
[ "$(version_of "$cb")" = "$new" ] || fail "B is not at $new"
inb grep -qx 'ROLE=joined' /etc/akari/multi.env || fail "B's role"
inb systemctl is-active postgresql@18-main.service >/dev/null 2>&1 && fail "B runs a PostgreSQL"
inb systemctl is-active akari-valkey.service >/dev/null 2>&1 && fail "B runs a Valkey"
inb sh -c 'command -v caddy' >/dev/null 2>&1 && fail "B installed Caddy"
inb stat -c '%a %U:%G' /etc/akari/panel.toml | grep -qx '640 root:akari' || fail "panel.toml permissions on B"
inb grep -q "^bind = \"$ipb:8080\"" /etc/akari/panel.toml || fail "B's web bind"
status_ok "$cb" || fail "B is not healthy"
for ip in "$ipa" "$ipb"; do
	[ "$(docker exec "$ca" curl -s -o /dev/null -w '%{http_code}' "http://$ip:8080/healthz")" = 200 ] || fail "healthz of $ip:8080"
done
echo "ok: B joined: no local PostgreSQL / Valkey / Caddy, bundle deleted, healthy"

log "a session of A works on B (shared jwt.key)"
http() { # http CONTAINER URL ARGS...: status code, body in /tmp/last there
	local c=$1 url=$2
	shift 2
	docker exec "$c" curl -s -o /tmp/last -w '%{http_code}' "$@" "$url"
}
[ "$(http "$ca" "http://$ipa:8080/$P/auth/options")" = 200 ] || fail "auth options"
ft=$(docker exec "$ca" sed -n 's/.*"form_token":"\([A-Za-z0-9_-]*\)".*/\1/p' /tmp/last)
guard=""
[ -z "$ft" ] || guard=",\"guard\":{\"form_token\":\"$ft\"}"
sleep 3
[ "$(http "$ca" "http://$ipa:8080/$P/auth/login" -c /tmp/jar -X POST -H 'Content-Type: application/json' \
	-d "{\"email\":\"admin@akari.invalid\",\"password\":\"$pw\"$guard}")" = 200 ] || fail "login on A"
cookie=$(docker exec "$ca" awk '!/^$/ { sub(/^#HttpOnly_/, ""); if ($0 !~ /^#/) printf "%s=%s; ", $6, $7 }' /tmp/jar)
[ -n "$cookie" ] || fail "no session cookie"
[ "$(http "$ca" "http://$ipa:8080/$P/api/v1/users" -H "Cookie: $cookie")" = 200 ] || fail "the session does not work on A"
[ "$(http "$ca" "http://$ipb:8080/$P/api/v1/users" -H "Cookie: $cookie")" = 200 ] || fail "the session of A does not work on B"
[ "$(http "$ca" "http://$ipb:8080/$P/api/v1/users" -H "Cookie: ${cookie}x")" != 200 ] || fail "a damaged session works on B"
echo "ok: the same session answers on A and B"

log "an agent enrolled on A converges through B's gRPC"
ina sh -c 'cd / && runuser -u akari -- akari -c /etc/akari/panel.toml server add e2e-node --out -' >"$work/bootstrap.toml" 2>/dev/null || fail "server add"
chmod 600 "$work/bootstrap.toml"
sed -i "s|^panel_addr = .*|panel_addr = \"$ipb:8443\"|" "$work/bootstrap.toml"
"$agent_bin" -config "$work/bootstrap.toml" -state-dir "$work/agent-state" >"$work/agent.log" 2>&1 &
agent_pid=$!
online=0
for _ in $(seq 90); do
	http "$ca" "http://$ipb:8080/$P/api/v1/system/status" -H "Cookie: $cookie" >/dev/null
	if docker exec "$ca" cat /tmp/last | python3 -c '
import json, sys
d = json.load(sys.stdin)
sys.exit(0 if any(i.get("this") and i.get("agent_sessions", 0) >= 1 for i in d["instances"]) else 1)'; then
		online=1
		break
	fi
	sleep 2
done
[ "$online" = 1 ] || fail "B holds no agent session"
http "$ca" "http://$ipa:8080/$P/api/v1/system/status" -H "Cookie: $cookie" >/dev/null
docker exec "$ca" cat /tmp/last | python3 -c '
import json, sys
d = json.load(sys.stdin)
inst = [i for i in d["instances"] if i["alive"]]
assert len(inst) == 2, inst
assert sum(i["agent_sessions"] for i in inst) == 1, inst' || fail "A's status page does not show both instances and one agent session"
echo "ok: the agent is served by B; A's status page sees both instances"

# --- 4. load balancer configs, trusted proxies, info ---------------------------------------------------
log "lb-config validates with the real programs"
lbip="${ipa%.*}.250"
lbcmd=(akari-ctl lb-config)
for kind in caddy haproxy nginx; do
	ina "${lbcmd[@]}" "$kind" --instances "$ipa,$ipb" --domain myapp.test --lb-address "$lbip" >"$work/lb-$kind.conf" || fail "lb-config $kind"
	for needle in "$ipa:8080" "$ipb:8080" "$ipa:8443" "$ipb:8443" /healthz "akari-ctl set-trusted-proxies $lbip"; do
		grep -qF -- "$needle" "$work/lb-$kind.conf" || fail "lb-config $kind lacks $needle"
	done
done
ina akari-ctl lb-config caddy --instances 'a b' --domain myapp.test >/dev/null 2>&1 && fail "lb-config accepted a bad instance"
docker cp "$work/lb-caddy.conf" "$ca:/root/lb-caddy.conf"
ina caddy validate --config /root/lb-caddy.conf --adapter caddyfile >/dev/null 2>"$work/validate.log" || { cat "$work/validate.log"; fail "caddy rejects the Caddy config"; }
ina sh -c 'printf "#!/bin/sh\nexit 101\n" >/usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq haproxy nginx libnginx-mod-stream >/dev/null 2>&1' || fail "install haproxy and nginx"
ina sh -c 'mkdir -p /etc/haproxy/certs /etc/letsencrypt/live/myapp.test && cd /tmp && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout k.pem -out c.pem -subj /CN=myapp.test -days 2 2>/dev/null && cat c.pem k.pem >/etc/haproxy/certs/myapp.test.pem && cp c.pem /etc/letsencrypt/live/myapp.test/fullchain.pem && cp k.pem /etc/letsencrypt/live/myapp.test/privkey.pem'
docker cp "$work/lb-haproxy.conf" "$ca:/root/lb-haproxy.conf"
docker cp "$work/lb-nginx.conf" "$ca:/root/lb-nginx.conf"
ina haproxy -c -f /root/lb-haproxy.conf >/dev/null 2>"$work/validate.log" || { cat "$work/validate.log"; fail "haproxy rejects the HAProxy config"; }
ina nginx -t -c /root/lb-nginx.conf >/dev/null 2>"$work/validate.log" || { cat "$work/validate.log"; fail "nginx rejects the nginx config"; }
echo "ok: caddy validate, haproxy -c, nginx -t accept the generated configs"

log "set-trusted-proxies"
ina akari-ctl set-trusted-proxies 0.0.0.0/0 >/dev/null 2>&1 && fail "set-trusted-proxies accepted 0.0.0.0/0"
ina akari-ctl set-trusted-proxies --yes "$lbip" || fail "set-trusted-proxies on A"
inb akari-ctl set-trusted-proxies --yes "$lbip" || fail "set-trusted-proxies on B"
ina grep -qx "trusted_proxies = \[\"127.0.0.1/32\", \"$lbip\"\]" /etc/akari/panel.toml || fail "A's trusted_proxies: $(ina grep trusted_proxies /etc/akari/panel.toml)"
inb grep -qx "trusted_proxies = \[\"$lbip\"\]" /etc/akari/panel.toml || fail "B's trusted_proxies: $(inb grep trusted_proxies /etc/akari/panel.toml)"
status_ok "$ca" && status_ok "$cb" || fail "an instance is unhealthy after set-trusted-proxies"
echo "ok: trusted proxies set on both"

log "info: role, shared services, peers"
ina akari-ctl info >"$work/info-a.txt" || fail "info on A"
inb akari-ctl info >"$work/info-b.txt" || fail "info on B"
grep -q 'role: primary' "$work/info-a.txt" || { cat "$work/info-a.txt"; fail "A's role in info"; }
grep -q 'role: joined' "$work/info-b.txt" || { cat "$work/info-b.txt"; fail "B's role in info"; }
for f in info-a info-b; do
	[ "$(grep -c ' online ' "$work/$f.txt")" -ge 2 ] || { cat "$work/$f.txt"; fail "$f does not list two online instances"; }
	grep -q "PostgreSQL $ipa:5432" "$work/$f.txt" || { cat "$work/$f.txt"; fail "$f does not name the shared PostgreSQL"; }
done
grep -qF "$pw" "$work/info-a.txt" "$work/info-b.txt" && fail "a password is in info"
grep -q 'postgres://\|rediss://' "$work/info-a.txt" "$work/info-b.txt" && fail "a URL with credentials is in info"
echo "ok: info"

# --- 5. rolling upgrades ----------------------------------------------------------------------------------
log "upgrade without --rolling is refused"
if inb akari-ctl upgrade --yes --version "$up1" >"$work/refused.log" 2>&1; then fail "B upgraded without --rolling"; fi
grep -q -- '--rolling' "$work/refused.log" || { cat "$work/refused.log"; fail "the refusal does not name --rolling"; }
if ina akari-ctl upgrade --yes --version "$up1" >"$work/refused.log" 2>&1; then fail "A upgraded without --rolling while B is online"; fi
grep -q -- '--rolling' "$work/refused.log" || { cat "$work/refused.log"; fail "A's refusal does not name --rolling"; }
[ "$(version_of "$ca")" = "$new" ] && [ "$(version_of "$cb")" = "$new" ] || fail "a refused upgrade changed a version"
ina sh -c 'ls -d /var/backups/akari/akari-*' >/dev/null 2>&1 && fail "a refused upgrade made a backup"
echo "ok: refused"

log "rolling upgrade to $up1 (schema compatible): A first, B stays up meanwhile"
ina akari-ctl upgrade --yes --rolling --version "$up1" >"$work/up1a.log" 2>&1 || { cat "$work/up1a.log"; fail "rolling upgrade of A"; }
grep -q 'compatible' "$work/up1a.log" || fail "no compatibility note on A"
[ "$(version_of "$ca")" = "$up1" ] || fail "A is not at $up1"
status_ok "$ca" && status_ok "$cb" || fail "an instance is unhealthy after A's upgrade"
[ "$(http "$ca" "http://$ipb:8080/$P/api/v1/users" -H "Cookie: $cookie")" = 200 ] || fail "B stopped answering during A's upgrade"
ina sh -c 'ls -d /var/backups/akari/akari-*' >/dev/null 2>&1 || fail "A made no backup"
inb akari-ctl upgrade --yes --rolling --version "$up1" >"$work/up1b.log" 2>&1 || { cat "$work/up1b.log"; fail "rolling upgrade of B"; }
[ "$(version_of "$cb")" = "$up1" ] || fail "B is not at $up1"
inb sh -c 'ls -d /var/backups/akari/akari-*' >/dev/null 2>&1 && fail "B made a backup (it does not own the database)"
status_ok "$ca" && status_ok "$cb" || fail "an instance is unhealthy after B's upgrade"
inb akari-ctl backup --yes >/dev/null 2>&1 && fail "backup worked on a joined instance"
echo "ok: A then B at $up1, backup on A only"

log "rolling upgrade to $up2 (schema NOT compatible): needs the others stopped"
if ina akari-ctl upgrade --yes --rolling --version "$up2" >"$work/refused.log" 2>&1; then fail "A upgraded to an incompatible schema with B online"; fi
grep -q 'stop' "$work/refused.log" || { cat "$work/refused.log"; fail "the refusal does not tell to stop the others"; }
[ "$(version_of "$ca")" = "$up1" ] || fail "the refused upgrade changed A"
echo "ok: refused while B is online; stopping B"
inb systemctl stop akari-panel.service
# The status page forgets a stopped instance 30 s after its last heartbeat.
for _ in $(seq 40); do
	n=$(ina akari-ctl info | grep -c ' online ' || true)
	[ "$n" -le 1 ] && break
	sleep 3
done
ina akari-ctl upgrade --yes --rolling --version "$up2" >"$work/up2a.log" 2>&1 || { cat "$work/up2a.log"; fail "upgrade of A with B stopped"; }
[ "$(version_of "$ca")" = "$up2" ] || fail "A is not at $up2"
inb akari-ctl upgrade --yes --rolling --version "$up2" >"$work/up2b.log" 2>&1 || { cat "$work/up2b.log"; fail "upgrade of B after A (A online)"; }
[ "$(version_of "$cb")" = "$up2" ] || fail "B is not at $up2"
status_ok "$ca" && status_ok "$cb" || fail "an instance is unhealthy after the incompatible upgrade"
echo "ok: A upgraded alone, B followed while A runs"

log "the primary cannot be uninstalled while B uses its database"
if ina akari-ctl uninstall --yes >"$work/refused.log" 2>&1; then fail "A uninstalled while B is online"; fi
status_ok "$ca" || fail "A is unhealthy after the refused uninstall"
echo "ok: refused"

log "PASS: multi-instance installer e2e on $base"
