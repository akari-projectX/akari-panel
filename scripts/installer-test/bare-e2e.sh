#!/usr/bin/env bash
# Installer end-to-end test, bare-metal mode, in a fresh systemd container
# (CI job installer-bare; docs/DEPLOY.md "Installer tests").
#
#   bare-e2e.sh BASE_IMAGE RELEASES_DIR NEW_TAG BROKEN_TAG [PREV_TAG]
#
#   BASE_IMAGE    debian:13 | ubuntu:24.04 (| debian:12 | ubuntu:22.04)
#   RELEASES_DIR  local releases (make-release.sh): NEW_TAG = the build
#                 under test, BROKEN_TAG = a deliberately broken release
#   PREV_TAG      a published v0.3.x release installed first from GitHub
#                 (real keyless cosign verification); the upgrade to
#                 NEW_TAG must be refused untouched (v0.4 baseline), then
#                 it is purged and NEW_TAG installed fresh; empty = install
#                 NEW_TAG directly
#
# Environment: ADDRESS=domain|ip (default domain: myapp.test with Caddy
# local_certs; ip = IP-only), KEEP=1 keeps the container, EXTRA_CA = a CA
# bundle to trust inside the container (TLS-intercepting proxies).
#
# Flow: a stale Caddy Cloudsmith apt source answering 402 (turned off by
# the installer; Caddy from its pinned GitHub release) -> [PREV_TAG install
# -> refused upgrade -> purge] -> install -> healthz through Caddy, admin login (API), user + subscription -> broken
# upgrade (backup, switch, failed health) rolls
# back -> uninstall keeps data -> reinstall: same prefix, same password,
# same subscription -> backup with the agent releases -> age-encrypted
# backup (releases left out) -> uninstall --purge removes
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
# dl.cloudsmith.io (Caddy's old apt repository) is unreachable: the
# installer must not need it.
docker run -d --name "$c" --privileged "${cg[@]}" --tmpfs /run --tmpfs /run/lock \
	--add-host myapp.test:127.0.0.1 --add-host dl.cloudsmith.io:127.0.0.1 \
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

# A host set up by an older installer: Caddy's Cloudsmith apt source, which
# answers 402 since 2026-10-09 (a local stand-in: same host name, plain
# HTTP on 8402). apt-get update fails on it; the installer must turn that
# source off and go on.
grep -q 'https://dl\.cloudsmith\.io' "$root/scripts/install.sh" && fail "install.sh still downloads from dl.cloudsmith.io"
# shellcheck disable=SC2016 # perl code
cx systemd-run --unit fake-cloudsmith perl -MIO::Socket::INET -e '
	my $s = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => 8402, Listen => 5, ReuseAddr => 1) or die;
	while (my $c = $s->accept) {
		while (<$c>) { last if /^\r?$/ }
		print $c "HTTP/1.1 402 Payment Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
		close $c;
	}' >/dev/null || fail "fake Cloudsmith"
cx sh -c 'echo "deb [signed-by=/etc/apt/keyrings/caddy.asc] http://dl.cloudsmith.io:8402/public/caddy/stable/deb/debian any-version main" >/etc/apt/sources.list.d/caddy-stable.list'
# The installer from the source tree (deploy files too); env passed by name.
inst() {
	docker exec -e LANG=C.UTF-8 -e AKARI_ADMIN_PASSWORD="$pw" -e AKARI_SOURCE_DIR=/src "$@"
}
local_rel=(-e AKARI_RELEASES_URL=file:///rel -e AKARI_COSIGN_KEY=/rel/cosign.pub)

# The installer's default admin (v0.4 D1: the e-mail is the login):
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

# The console URL: /{prefix}/app (v0.4) or /{prefix}/admin (v0.3.x).
prefix() { cx akari-ctl info | sed -n -e '1s#.*://[^/]*/\([^/]*\)/admin$#\1#p' -e '1s#.*://[^/]*/\([^/]*\)/app$#\1#p'; }
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
	# v0.4 (D11): the portal at /; unknown paths stay the plain 404.
	# (Told apart by akari-ctl info: a v0.3.x console is /{prefix}/admin; the
	# CI build of this tree is called <version>-ci.N.)
	case $(cx akari-ctl info | sed -n 1p) in
	*/admin) [ "$(https_code "$origin/")" = 404 ] || fail "/ is not the plain 404" ;;
	*)
		[ "$(https_code "$origin/")" = 200 ] || fail "/ is not the portal"
		[ "$(https_code "$origin/no-such-page")" = 404 ] || fail "an unknown path is not the plain 404"
		;;
	esac
	# A v0.3.x panel (the refused-upgrade check) still takes {"login"}.
	# v0.4 (W27): the form token from /auth/options, posted no sooner than
	# the minimum submit time (default 2 s) after it.
	local guard=""
	[ "$(https_code "$origin/$p/auth/options")" = 200 ] || fail "auth options"
	ft=$(cx sed -n 's/.*"form_token":"\([A-Za-z0-9_-]*\)".*/\1/p' /tmp/last)
	[ -z "$ft" ] || guard=",\"guard\":{\"form_token\":\"$ft\"}"
	sleep 3
	[ "$(https_code "$origin/$p/auth/login" -c /tmp/jar -X POST -H 'Content-Type: application/json' \
		-d "{\"email\":\"$admin_email\",\"password\":\"$pw\"$guard}")" = 200 ] ||
		[ "$(https_code "$origin/$p/auth/login" -c /tmp/jar -X POST -H 'Content-Type: application/json' \
			-d "{\"login\":\"$admin_email\",\"password\":\"$pw\"}")" = 200 ] || fail "admin login via the API"
	cx grep -q '"role":"admin"' /tmp/last || fail "login response"
	cx akari --version | grep -q "^akari ${want_version#v} " || fail "binary version is not $want_version"
	cx akari-ctl status >/dev/null || fail "akari-ctl status"
	echo "ok: $want_version healthy, login ok"
}

if [ -n "$prev" ]; then
	# v0.4 squashed the v0.3.x migrations (1000_baseline): upgrading a v0.3.x
	# install must be refused before anything changes; then purge and
	# install fresh.
	log "install $prev from GitHub (keyless cosign) — bare, $address"
	inst "$c" sh /src/scripts/install.sh --yes --mode bare --version "$prev" "${addr_args[@]}" || fail "install $prev"
	check_panel "$prev"
	log "upgrade $prev -> $new must be refused"
	if inst "${local_rel[@]}" "$c" akari-ctl upgrade --yes --version "$new" >/tmp/akari-refused.log 2>&1; then
		cat /tmp/akari-refused.log
		fail "the upgrade from $prev was not refused"
	fi
	cat /tmp/akari-refused.log
	grep -q 'fresh install required; see docs/DEPLOY.md' /tmp/akari-refused.log || fail "no clear refusal message"
	cx sh -c 'ls -d /var/backups/akari/akari-* >/dev/null 2>&1' && fail "the refused upgrade made a backup"
	cx grep -q "^VERSION=$prev\$" /etc/akari/install.env || fail "install.env changed by the refused upgrade"
	check_panel "$prev"
	echo "ok: upgrade from $prev refused cleanly"
	inst "$c" sh /src/scripts/install.sh uninstall --yes --purge --confirm purge || fail "purge $prev"
fi
log "install $new — bare, $address"
inst "${local_rel[@]}" "$c" sh /src/scripts/install.sh --yes --mode bare --version "$new" "${addr_args[@]}" || fail "install $new"
PREFIX=$(prefix)
check_panel "$new"
cx test -e /etc/apt/sources.list.d/caddy-stable.list && fail "the dead Cloudsmith source is still on"
cx test -f /etc/apt/sources.list.d/caddy-stable.list.akari.disabled || fail "the Cloudsmith source was not kept as *.akari.disabled"
cx grep -q 'disabled Caddy.s Cloudsmith apt repository' /var/log/akari-install.log || fail "no message about the Cloudsmith source"
cx apt-get update >/dev/null 2>&1 || fail "apt-get update still fails"
want_caddy=$(sed -n "s/^CADDY_VERSION='\(.*\)'$/\1/p" "$root/scripts/install.sh")
cx caddy version | grep -q "^v$want_caddy " || fail "Caddy is not the pinned release $want_caddy"
cx grep -qx 'source=release' /etc/caddy/.installed-by-akari || fail "Caddy's origin not recorded"
cx systemctl is-active caddy.service >/dev/null || fail "caddy.service is not active"
echo "ok: Caddy $want_caddy from the GitHub release, the dead Cloudsmith source turned off"
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

log "user + subscription"
[ "$(https_code "$origin/$PREFIX/api/v1/users" -b /tmp/jar -X POST -H 'Content-Type: application/json' \
	-d '{"email":"e2e-user@example.com","password":"user-password-123"}')" = 201 ] || fail "create user"
SUB=$(cx sh -c "sed -n 's/.*\"sub_token\":\"\([^\"]*\)\".*/\1/p' /tmp/last")
[ -n "$SUB" ] || fail "no subscription token"
# v0.4 D11: subscriptions live at /<sub path>/<token> (outside the admin
# prefix); the path comes from the answer's sub_url.
SUBP=$(cx sh -c "sed -n 's/.*\"sub_url\":\"\([^\"]*\)\".*/\1/p' /tmp/last" | sed 's#^[a-z]*://[^/]*##')
[ -n "$SUBP" ] || fail "no subscription link"
[ "$(https_code "$origin$SUBP" -A clash.meta)" = 200 ] || fail "subscription fetch"
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
	--restore "$moved" --age-identity /root/move.key || fail "install --restore"
check_panel "$new"
[ "$(prefix)" = "$PREFIX" ] || fail "the prefix changed across the move"
[ "$(https_code "$origin$SUBP" -A clash.meta)" = 200 ] || fail "subscription after the move"
[ "$(psql_akari "SELECT count(*) FROM agent_releases")" = 0 ] || fail "the default backup restored agent releases"
echo "ok: restored: same prefix, keys, admin password, subscription (agent releases left out)"

log "PASS: bare installer e2e on $base ($address)"
