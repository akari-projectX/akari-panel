#!/usr/bin/env bash
# Installer end-to-end test, bare-metal mode, in a fresh systemd container
# (CI job installer-bare; docs/DEPLOY.md "Installer tests").
#
#   bare-e2e.sh BASE_IMAGE RELEASES_DIR NEW_TAG BROKEN_TAG [PREV_TAG]
#
#   BASE_IMAGE    debian:13 | ubuntu:24.04 (| debian:12 | ubuntu:22.04)
#   RELEASES_DIR  local releases (make-release.sh): NEW_TAG = the build
#                 under test, BROKEN_TAG = a deliberately broken release
#   PREV_TAG      a published release installed first from GitHub (real
#                 keyless cosign verification), then upgraded to NEW_TAG;
#                 empty = install NEW_TAG directly
#
# Environment: ADDRESS=domain|ip (default domain: myapp.test with Caddy
# local_certs; ip = IP-only), KEEP=1 keeps the container, EXTRA_CA = a CA
# bundle to trust inside the container (TLS-intercepting proxies).
#
# Flow: install -> healthz through Caddy, admin login (API), user +
# subscription -> upgrade (backup, switch, health) -> broken upgrade rolls
# back -> uninstall keeps data -> reinstall: same prefix, same password,
# same subscription -> age-encrypted backup -> uninstall --purge removes
# everything but backups -> fresh install --restore from the encrypted
# backup (a host move): same prefix, password, subscription.
set -euo pipefail

base=${1:?usage: bare-e2e.sh BASE_IMAGE RELEASES_DIR NEW_TAG BROKEN_TAG [PREV_TAG]}
rel=$(cd "${2:?}" && pwd)
new=${3:?}
broken=${4:?}
prev=${5:-}
address=${ADDRESS:-domain}
root=$(cd "$(dirname "$0")/../.." && pwd)
c="akari-installer-${base//[:.]/-}-$$"
img="akari-installer-test:${base//[:]/-}"
pw="e2e-Admin-Pass-$(date +%s)"
log() { printf '\n\033[1;36m### %s\033[0m\n' "$*"; }
fail() {
	printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2
	docker exec "$c" sh -c 'tail -n 60 /var/log/akari-install.log; journalctl -u akari-panel -n 40 --no-pager -o cat' >&2 || true
	exit 1
}

cleanup() {
	if [ "${KEEP:-0}" != 1 ]; then docker rm -f "$c" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

log "image $img ($base)"
if [ "${REBUILD:-1}" = 1 ] || ! docker image inspect "$img" >/dev/null 2>&1; then
	docker build -q -t "$img" --build-arg "BASE=$base" "$root/scripts/installer-test" >/dev/null
fi

cg=(--cgroupns=private)
if [ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ]; then
	cg=(--cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw)
fi
docker run -d --name "$c" --privileged "${cg[@]}" --tmpfs /run --tmpfs /run/lock \
	--add-host myapp.test:127.0.0.1 \
	-v "$root:/src:ro" -v "$rel:/rel:ro" "$img" >/dev/null
for _ in $(seq 60); do
	s=$(docker exec "$c" systemctl is-system-running 2>/dev/null || true)
	case "$s" in running | degraded) break ;; esac
	sleep 1
done
if [ -n "${EXTRA_CA:-}" ]; then
	docker cp "$EXTRA_CA" "$c:/usr/local/share/ca-certificates/extra-ca.crt"
	docker exec "$c" update-ca-certificates >/dev/null 2>&1
fi

cx() { docker exec -e LANG=C.UTF-8 "$c" "$@"; }
# The installer from the source tree (deploy files too); env passed by name.
inst() {
	docker exec -e LANG=C.UTF-8 -e AKARI_ADMIN_PASSWORD="$pw" -e AKARI_SOURCE_DIR=/src "$@"
}
local_rel=(-e AKARI_RELEASES_URL=file:///rel -e AKARI_COSIGN_KEY=/rel/cosign.pub)

if [ "$address" = ip ]; then
	addr_args=()
	ip=$(cx sh -c "hostname -I | awk '{print \$1}'")
	origin="https://$ip"
else
	addr_args=(--domain myapp.test --local-certs)
	origin="https://myapp.test"
fi

prefix() { cx akari-ctl info | sed -n '1s|.*://[^/]*/\([^/]*\)/admin$|\1|p'; }
# GET/POST through Caddy (TLS) inside the container; prints the status.
https_code() {
	local url=$1
	shift
	cx curl -sk -o /tmp/last -w '%{http_code}' --resolve "myapp.test:443:127.0.0.1" "$@" "$url"
}
check_panel() {
	local want_version=$1 p
	p=$(prefix)
	[ -n "$p" ] || fail "no prefix from akari-ctl info"
	[ "$(https_code "$origin/$p/healthz")" = 200 ] || fail "healthz through Caddy"
	[ "$(https_code "$origin/")" = 404 ] || fail "/ is not the plain 404"
	[ "$(https_code "$origin/$p/auth/login" -c /tmp/jar -X POST -H 'Content-Type: application/json' \
		-d "{\"login\":\"admin\",\"password\":\"$pw\"}")" = 200 ] || fail "admin login via the API"
	cx grep -q '"role":"admin"' /tmp/last || fail "login response"
	cx akari --version | grep -q "^akari ${want_version#v} " || fail "binary version is not $want_version"
	cx akari-ctl status >/dev/null || fail "akari-ctl status"
	echo "ok: $want_version healthy, login ok"
}

if [ -n "$prev" ]; then
	log "install $prev from GitHub (keyless cosign) — bare, $address"
	inst "$c" sh /src/scripts/install.sh --yes --mode bare --version "$prev" "${addr_args[@]}" || fail "install $prev"
	check_panel "$prev"
	PREFIX=$(prefix)
	log "upgrade $prev -> $new"
	inst "${local_rel[@]}" "$c" akari-ctl upgrade --yes --version "$new" || fail "upgrade to $new"
else
	log "install $new — bare, $address"
	inst "${local_rel[@]}" "$c" sh /src/scripts/install.sh --yes --mode bare --version "$new" "${addr_args[@]}" || fail "install $new"
	PREFIX=$(prefix)
fi
check_panel "$new"
[ "$(prefix)" = "$PREFIX" ] || fail "the prefix changed"
cx sh -c 'ls /var/backups/akari/akari-*/db.dump >/dev/null 2>&1' || [ -z "$prev" ] || fail "no pre-upgrade backup"
cx stat -c '%a %U' /var/lib/akari | grep -qx '700 akari' || fail "data dir is not 0700 akari"
cx stat -c '%a %U:%G' /etc/akari/panel.toml | grep -qx '640 root:akari' || fail "panel.toml is not 0640 root:akari"
for f in /etc/akari/valkey.conf /etc/akari/caddy.env /etc/akari/install.env /var/log/akari-install.log; do
	cx stat -c '%a' "$f" | grep -qx 600 || fail "$f is not 0600"
done
cx sh -c "grep -F -e '$pw' -e '$PREFIX' /var/log/akari-install.log" && fail "a secret is in the install log"
cx sh -c "journalctl -u caddy --no-pager -o cat | grep -F '$PREFIX'" && fail "the prefix is in Caddy's journal"
echo "ok: modes, ownership, no secrets in logs"

log "user + subscription"
[ "$(https_code "$origin/$PREFIX/api/v1/users" -b /tmp/jar -X POST -H 'Content-Type: application/json' \
	-d '{"login":"e2e-user","password":"user-password-123"}')" = 201 ] || fail "create user"
SUB=$(cx sh -c "sed -n 's/.*\"sub_token\":\"\([^\"]*\)\".*/\1/p' /tmp/last")
[ -n "$SUB" ] || fail "no subscription token"
[ "$(https_code "$origin/$PREFIX/sub/$SUB" -A clash.meta)" = 200 ] || fail "subscription fetch"
echo "ok: subscription"

log "broken release $broken: the upgrade must roll back"
if inst "${local_rel[@]}" "$c" akari-ctl upgrade --yes --version "$broken"; then
	fail "the broken upgrade reported success"
fi
cx grep -q 'rolling back\|自动回滚' /var/log/akari-install.log || fail "no rollback in the log"
check_panel "$new"
cx grep -q "^VERSION=$new\$" /etc/akari/install.env || fail "install.env does not say $new after the rollback"
echo "ok: rolled back to $new"

log "uninstall (keep data) and reinstall"
inst "$c" akari-ctl uninstall --yes || fail "uninstall"
cx systemctl is-active akari-panel.service >/dev/null && fail "akari-panel still running"
cx test -s /var/lib/akari/ca.key.pem || fail "data dir not kept"
inst "${local_rel[@]}" "$c" sh /src/scripts/install.sh --yes --mode bare --version "$new" "${addr_args[@]}" || fail "reinstall"
check_panel "$new"
[ "$(prefix)" = "$PREFIX" ] || fail "the prefix changed across uninstall/reinstall"
[ "$(https_code "$origin/$PREFIX/sub/$SUB" -A clash.meta)" = 200 ] || fail "subscription after reinstall"
echo "ok: data kept across uninstall/reinstall"

log "encrypted backup for a host move (age)"
cx sh -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq age >/dev/null 2>&1 && age-keygen -o /root/move.key 2>/dev/null' || fail "age"
recipient=$(cx sh -c "sed -n 's/^# public key: //p' /root/move.key")
inst "$c" akari-ctl backup --yes --out /root/moved --age-recipient "$recipient" || fail "encrypted backup"
cx sh -c 'ls /root/moved/akari-*/db.dump.age /root/moved/akari-*/data.tar.age /root/moved/akari-*/config.tar.age' >/dev/null || fail "backup is not encrypted"
cx sh -c 'ls /root/moved/akari-*/db.dump' >/dev/null 2>&1 && fail "plain dump next to the encrypted one"
echo "ok: age-encrypted backup"

log "uninstall --purge"
inst "$c" akari-ctl uninstall --yes --purge && fail "purge without confirmation succeeded"
inst "$c" sh /src/scripts/install.sh uninstall --yes --purge --confirm purge || fail "purge"
cx test -e /var/lib/akari && fail "data dir still there"
cx test -e /etc/akari && fail "/etc/akari still there"
cx sh -c 'cd / && runuser -u postgres -- psql -At -c "SELECT 1 FROM pg_database WHERE datname = '"'akari'"'"' | grep -q 1 && fail "database still there"
cx sh -c 'ls -d /var/backups/akari/akari-*' >/dev/null || fail "purge removed the backups"
echo "ok: purged (backups kept)"

log "host move: fresh install from the encrypted backup (--restore)"
moved=$(cx sh -c 'ls -d /root/moved/akari-* | tail -n 1')
inst "${local_rel[@]}" "$c" sh /src/scripts/install.sh --yes --mode bare --version "$new" "${addr_args[@]}" \
	--restore "$moved" --age-identity /root/move.key || fail "install --restore"
check_panel "$new"
[ "$(prefix)" = "$PREFIX" ] || fail "the prefix changed across the move"
[ "$(https_code "$origin/$PREFIX/sub/$SUB" -A clash.meta)" = 200 ] || fail "subscription after the move"
echo "ok: restored: same prefix, keys, admin password, subscription"

log "PASS: bare installer e2e on $base ($address)"
