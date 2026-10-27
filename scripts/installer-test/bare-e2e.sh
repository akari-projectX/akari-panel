#!/usr/bin/env bash
# Installer end-to-end test, bare-metal mode, in a fresh systemd container
# (CI job installer-bare; docs/DEPLOY.md "Installer tests").
#
#   bare-e2e.sh BASE_IMAGE RELEASES_DIR NEW_TAG BROKEN_TAG
#
#   BASE_IMAGE    debian:13 | ubuntu:24.04 (| debian:12 | ubuntu:22.04)
#   RELEASES_DIR  local releases (make-release.sh): NEW_TAG = the build
#                 under test, BROKEN_TAG = a deliberately broken release
#
# Environment: ADDRESS=domain|ip (default domain: myapp.test with Caddy
# local_certs; ip = IP-only), KEEP=1 keeps the container, EXTRA_CA = a CA
# bundle to trust inside the container (TLS-intercepting proxies).
#
# Flow: install -> healthz through Caddy, admin login (API), user + subscription -> broken
# upgrade (backup, switch, failed health) rolls
# back -> uninstall keeps data -> reinstall: same prefix, same password,
# same subscription -> backup with the agent releases -> age-encrypted
# backup (releases left out) -> uninstall --purge removes
# everything but backups -> fresh install --restore from the encrypted
# backup (a host move): same prefix, password, subscription.
set -euo pipefail

base=${1:?usage: bare-e2e.sh BASE_IMAGE RELEASES_DIR NEW_TAG BROKEN_TAG}
rel=$(cd "${2:?}" && pwd)
new=${3:?}
broken=${4:?}
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

# Language and locale (installer UI): the image has no zh_CN locale.
# (1) apt cannot install `locales`: the run goes on in English, says why, and
# the machine is left without the locale. (2) The default run below then
# installs zh_CN.UTF-8 for itself and speaks Chinese.
log "locale: zh_CN.UTF-8 cannot be installed -> English"
cx sh -c '! locale -a | grep -i "^zh_cn\.utf-\?8$"' || fail "the image already has zh_CN.UTF-8"
default_locale() { cx sh -c 'ls /etc/default/locale /etc/locale.conf 2>&1; cat /etc/default/locale /etc/locale.conf 2>&1; cat /etc/environment 2>&1'; }
locale_before=$(default_locale)
cx sh -c 'mkdir -p /fakebin && printf "%s\n" "#!/bin/sh" "case \"\$*\" in *locales*) exit 100 ;; esac" "exec /usr/bin/apt-get \"\$@\"" >/fakebin/apt-get && chmod +x /fakebin/apt-get'
docker exec -e LANG=C.UTF-8 -e PATH=/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$c" \
	sh /src/scripts/install.sh info >/tmp/akari-en.out 2>&1 && fail "akari-ctl info succeeded without an installation"
cat /tmp/akari-en.out
grep -q 'continuing in English' /tmp/akari-en.out || fail "no English fallback message"
grep -q 'no installation found' /tmp/akari-en.out || fail "the English fallback run did not speak English"
cx sh -c '! locale -a | grep -i "^zh_cn\.utf-\?8$"' || fail "zh_CN.UTF-8 appeared although apt refused"
cx rm -rf /fakebin /var/log/akari-install.log

# The installer from the source tree (deploy files too); env passed by name.
inst() {
	docker exec -e LANG=C.UTF-8 -e AKARI_ADMIN_PASSWORD="$pw" -e AKARI_SOURCE_DIR=/src "$@"
}
# timed CMD...: runs it and prints the wall time (the IP-only job records the
# install and upgrade times here; the installer returns from its waits as soon
# as the condition holds).
timed() {
	local t0=$SECONDS rc=0
	"$@" || rc=$?
	echo "TIMING [$address] $2 ${3:-}: $((SECONDS - t0))s (exit $rc)"
	return "$rc"
}
local_rel=(-e AKARI_RELEASES_URL=file:///rel -e AKARI_COSIGN_KEY=/rel/cosign.pub)

# The installer's default admin (the e-mail is the login):
# admin@<domain>, or the reserved admin@akari.invalid on an IP-only install.
# --node-address: a host name (case folded) on the domain install, an
# [IPv6]:port on the IP-only one (validators.sh: GNU grep once rejected both).
if [ "$address" = ip ]; then
	node_addr='[::1]:9443'
	addr_args=(--node-address "$node_addr")
	ip=$(cx sh -c "hostname -I | awk '{print \$1}'")
	origin="https://$ip"
	admin_email=admin@akari.invalid
else
	node_addr=edge-node-communication.myapp.test
	addr_args=(--domain myapp.test --local-certs --node-address Edge-Node-Communication.MyApp.test)
	origin="https://myapp.test"
	admin_email=admin@myapp.test
fi

# The console URL: /{prefix}/app.
prefix() { cx akari-ctl info | sed -n -e '1s#.*://[^/]*/\([^/]*\)/app$#\1#p'; }
# GET/POST through Caddy (TLS) inside the container; prints the status.
https_code() {
	local url=$1
	shift
	cx curl -sk -o /tmp/last -w '%{http_code}' --resolve "myapp.test:443:127.0.0.1" "$@" "$url"
}
check_panel() {
	local want_version=$1 p ft
	p=$(prefix)
	[ -n "$p" ] || { cx akari-ctl info || true; fail "no prefix from akari-ctl info"; }
	[ "$(https_code "$origin/$p/healthz")" = 200 ] || fail "healthz through Caddy"
	# The portal at /; unknown paths stay the plain 404.
	[ "$(https_code "$origin/")" = 200 ] || fail "/ is not the portal"
	[ "$(https_code "$origin/no-such-page")" = 404 ] || fail "an unknown path is not the plain 404"
	# The form token from /auth/options, posted no sooner than the minimum
	# submit time (default 2 s) after it.
	local guard=""
	[ "$(https_code "$origin/$p/auth/options")" = 200 ] || fail "auth options"
	ft=$(cx sed -n 's/.*"form_token":"\([A-Za-z0-9_-]*\)".*/\1/p' /tmp/last)
	[ -z "$ft" ] || guard=",\"guard\":{\"form_token\":\"$ft\"}"
	sleep 3
	[ "$(https_code "$origin/$p/auth/login" -c /tmp/jar -X POST -H 'Content-Type: application/json' \
		-d "{\"email\":\"$admin_email\",\"password\":\"$pw\"$guard}")" = 200 ] || fail "admin login via the API"
	cx grep -q '"role":"admin"' /tmp/last || fail "login response"
	cx akari --version | grep -q "^akari ${want_version#v} " || fail "binary version is not $want_version"
	cx akari-ctl status >/dev/null || fail "akari-ctl status"
	echo "ok: $want_version healthy, login ok"
}

log "install $new — bare, $address"
timed inst "${local_rel[@]}" "$c" sh /src/scripts/install.sh --yes --mode bare --version "$new" "${addr_args[@]}" || fail "install $new"
PREFIX=$(prefix)
check_panel "$new"
# The default run: zh_CN.UTF-8 installed for the installer, Chinese output,
# and the system default locale untouched.
cx sh -c 'locale -a | grep -i "^zh_cn\.utf-\?8$"' >/dev/null || fail "zh_CN.UTF-8 was not installed"
cx grep -q '下载并验证' /var/log/akari-install.log || fail "the default run was not Chinese"
[ "$(default_locale)" = "$locale_before" ] || { default_locale; fail "the installer changed the system default locale"; }
cx sh -c '! grep -qs "zh_CN" /etc/environment /etc/profile /etc/profile.d/* /root/.profile /root/.bashrc' || fail "the installer wrote the locale into a profile"
echo "ok: locale: Chinese by default (zh_CN.UTF-8 installed), English fallback when it cannot be, system default untouched"
want_caddy=$(sed -n "s/^CADDY_VERSION='\(.*\)'$/\1/p" "$root/scripts/install.sh")
cx caddy version | grep -q "^v$want_caddy " || fail "Caddy is not the pinned release $want_caddy"
cx grep -qx 'source=release' /etc/caddy/.installed-by-akari || fail "Caddy's origin not recorded"
cx systemctl is-active caddy.service >/dev/null || fail "caddy.service is not active"
echo "ok: Caddy $want_caddy from the GitHub release"
cx stat -c '%a %U' /var/lib/akari | grep -qx '700 akari' || fail "data dir is not 0700 akari"
cx stat -c '%a %U:%G' /etc/akari/panel.toml | grep -qx '640 root:akari' || fail "panel.toml is not 0640 root:akari"
for f in /etc/akari/valkey.conf /etc/akari/caddy.env /etc/akari/install.env /var/log/akari-install.log; do
	cx stat -c '%a' "$f" | grep -qx 600 || fail "$f is not 0600"
done
cx sh -c "grep -F -e '$pw' -e '$PREFIX' /var/log/akari-install.log" && fail "a secret is in the install log"
cx sh -c "journalctl -u caddy --no-pager -o cat | grep -F '$PREFIX'" && fail "the prefix is in Caddy's journal"
settings=$(cx sh -c 'cd / && runuser -u akari -- akari -c /etc/akari/panel.toml settings show') ||
	fail "akari settings show"
case $(printf '%s\n' "$settings" | sed -n 's/^node domains: *//p') in
"$node_addr "*) ;;
*) fail "the node address is not $node_addr: $settings" ;;
esac
echo "ok: modes, ownership, no secrets in logs, node address $node_addr"

log "system status: host metrics readable under the panel unit"
# /proc/stat, meminfo and loadavg must be readable under the unit's sandbox
# (ProcSubset=pid would hide them: CPU / memory / load "unknown").
[ "$(https_code "$origin/$PREFIX/api/v1/system/status" -b /tmp/jar)" = 200 ] || fail "system status"
cx grep -q '"proc_hidden":false' /tmp/last || fail "the panel unit hides /proc: $(cx cat /tmp/last)"
cx grep -q '"mem_total_bytes":[1-9]' /tmp/last || fail "no memory total: $(cx cat /tmp/last)"
cx grep -q '"load":\[' /tmp/last || fail "no load average: $(cx cat /tmp/last)"
echo "ok: system status host metrics"

log "user + subscription"
[ "$(https_code "$origin/$PREFIX/api/v1/users" -b /tmp/jar -X POST -H 'Content-Type: application/json' \
	-d '{"email":"e2e-user@example.com","password":"user-password-123"}')" = 201 ] || fail "create user"
SUB=$(cx sh -c "sed -n 's/.*\"sub_token\":\"\([^\"]*\)\".*/\1/p' /tmp/last")
[ -n "$SUB" ] || fail "no subscription token"
# Subscriptions live at /<sub path>/<token> (outside the admin
# prefix); the path comes from the answer's sub_url.
SUBP=$(cx sh -c "sed -n 's/.*\"sub_url\":\"\([^\"]*\)\".*/\1/p' /tmp/last" | sed 's#^[a-z]*://[^/]*##')
[ -n "$SUBP" ] || fail "no subscription link"
[ "$(https_code "$origin$SUBP" -A clash.meta)" = 200 ] || fail "subscription fetch"
echo "ok: subscription"

log "broken release $broken: the upgrade must roll back"
if timed inst "${local_rel[@]}" "$c" akari-ctl upgrade --yes --version "$broken"; then
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
[ "$(https_code "$origin$SUBP" -A clash.meta)" = 200 ] || fail "subscription after reinstall"
echo "ok: data kept across uninstall/reinstall"

# psql_akari SQL: one value from the panel database (bare metal).
psql_akari() {
	# shellcheck disable=SC2016 # expanded by the container's shell
	cx sh -c 'cd / && runuser -u postgres -- psql -At -p "$(sed -n "s/^PG_PORT=//p" /etc/akari/install.env)" -d akari -c "$1"' sh "$1"
}

log "agent release binaries: left out of backups unless asked for"
psql_akari "INSERT INTO agent_releases (id, version, os, arch, sha256, size, manifest, signatures, key_id, min_panel_protocol, complete_at) \
	VALUES (gen_random_uuid(), 'v0.0.1-e2e', 'linux', 'amd64', repeat('a', 64), 1, '\\x00', '[]', 'k', 3, now())" >/dev/null || fail "insert a release"
inst "$c" akari-ctl backup --yes --out /root/full --with-agent-releases || fail "backup with releases"
cx sh -c 'grep -qx agent_releases=included /root/full/akari-*/MANIFEST && pg_restore --data-only --table=agent_releases -f - /root/full/akari-*/db.dump | grep -q v0.0.1-e2e' \
	|| fail "--with-agent-releases did not keep the release"
echo "ok: backup with the agent releases"

log "encrypted backup for a host move (age)"
cx sh -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq age >/dev/null 2>&1 && age-keygen -o /root/move.key 2>/dev/null' || fail "age"
recipient=$(cx sh -c "sed -n 's/^# public key: //p' /root/move.key")
inst "$c" akari-ctl backup --yes --out /root/moved --age-recipient "$recipient" || fail "encrypted backup"
cx sh -c 'ls /root/moved/akari-*/db.dump.age /root/moved/akari-*/data.tar.age /root/moved/akari-*/config.tar.age' >/dev/null || fail "backup is not encrypted"
cx sh -c 'ls /root/moved/akari-*/db.dump' >/dev/null 2>&1 && fail "plain dump next to the encrypted one"
cx sh -c 'grep -qx agent_releases=excluded /root/moved/akari-*/MANIFEST' || fail "MANIFEST does not say the releases were left out"
echo "ok: age-encrypted backup"

log "backups are signed by default; akari-ctl info prints the verification key"
# shellcheck disable=SC2016 # expanded by the container's shell
cx sh -c 'test -s /root/moved/akari-*/SHA256SUMS.sig && test "$(stat -c %a /etc/akari/backup-sign.pem)" = 600' || fail "the backup is not signed with a 0600 key"
cx sh -c 'akari-ctl info | sed -n "/BEGIN PUBLIC KEY/,/END PUBLIC KEY/p" >/root/backup-sign.pub && openssl dgst -sha256 -verify /root/backup-sign.pub -signature /root/moved/akari-*/SHA256SUMS.sig /root/moved/akari-*/SHA256SUMS' >/dev/null \
	|| fail "the public key printed by akari-ctl info does not verify the backup"
cx sh -c 'grep -rl "BEGIN EC PRIVATE KEY" /var/log/akari-install.log /root/moved' && fail "the signing key leaked into the log or the backup"
echo "ok: signed backup, key printed by akari-ctl info"

log "uninstall --purge"
inst "$c" akari-ctl uninstall --yes --purge && fail "purge without confirmation succeeded"
inst "$c" sh /src/scripts/install.sh uninstall --yes --purge --confirm purge || fail "purge"
cx test -e /var/lib/akari && fail "data dir still there"
cx test -e /etc/akari && fail "/etc/akari still there"
cx sh -c 'cd / && runuser -u postgres -- psql -At -c "SELECT 1 FROM pg_database WHERE datname = '"'akari'"'"' | grep -q 1 && fail "database still there"
cx sh -c 'ls -d /var/backups/akari/akari-*' >/dev/null || fail "purge removed the backups"
cx test -e /usr/bin/caddy && fail "purge left the Caddy release binary"
cx test -e /etc/systemd/system/caddy.service && fail "purge left caddy.service"
echo "ok: purged (backups kept)"

log "host move: fresh install from the encrypted backup (--restore)"
moved=$(cx sh -c 'ls -d /root/moved/akari-* | tail -n 1')
inst "${local_rel[@]}" "$c" sh /src/scripts/install.sh --yes --mode bare --version "$new" "${addr_args[@]}" \
	--restore "$moved" --age-identity /root/move.key --backup-verify-key /root/backup-sign.pub || fail "install --restore"
check_panel "$new"
[ "$(prefix)" = "$PREFIX" ] || fail "the prefix changed across the move"
[ "$(https_code "$origin$SUBP" -A clash.meta)" = 200 ] || fail "subscription after the move"
[ "$(psql_akari "SELECT count(*) FROM agent_releases")" = 0 ] || fail "the default backup restored agent releases"
echo "ok: restored: same prefix, keys, admin password, subscription (agent releases left out)"

log "PASS: bare installer e2e on $base ($address)"
