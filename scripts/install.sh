#!/bin/sh
# Akari panel installer / operations tool (akari panel installer).
#
#   curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh | sh
#
# One command installs the panel on a fresh Debian 12/13 or Ubuntu 22.04/24.04
# machine, either on bare metal (PostgreSQL 18 from PGDG, Valkey 9 from the
# upstream release builds, Caddy from its apt repository, systemd units) or
# with Docker Compose (Docker Engine from Docker's apt repository). It is
# interactive by default (Chinese or English prompts by locale, every prompt
# has a default) and fully scriptable with flags/environment (--yes).
# Installed, the same script is /usr/local/sbin/akari-ctl:
#
#   akari-ctl status                     what is installed, is it healthy
#   akari-ctl info                       the panel URLs (with the secret prefix)
#   akari-ctl upgrade [--version vX.Y.Z] backup, verify, switch, health check, auto rollback
#   akari-ctl backup [--out DIR]         database + data dir (+ config), age-encrypted if configured
#   akari-ctl migrate --to docker|bare   move this installation to the other mode on this host
#   akari-ctl uninstall [--purge]        remove services (keeps data unless --purge)
#   install.sh --restore DIR             install from a backup (host-to-host move)
#
# `install.sh --help` lists every option. docs/DEPLOY.md is the manual.
#
# Security properties (do not weaken):
#   * the panel binary / image reference / deploy bundle of a release are
#     checked against the release's SHA256SUMS, whose cosign keyless
#     signature must come from this repository's release workflow at that
#     tag (cosign itself is downloaded with a pinned SHA-256);
#   * Valkey is the upstream release build, pinned by SHA-256 in this file;
#     the PGDG, Caddy and Docker apt keys are pinned by fingerprint;
#   * generated passwords never appear on a command line or in the log
#     (/var/log/akari-install.log, 0600); the admin password is printed once
#     to the terminal, and the secret route prefix only in the final summary
#     (and by `akari-ctl info`);
#   * data dir 0700 (route prefix, CA key, jwt.key, master.key), panel.toml
#     0640 root:akari, env files 0600.
#
# The whole script is a set of functions and a last line that calls main:
# a download cut short runs nothing.

INSTALLER_VERSION='@@AKARI_INSTALLER_VERSION@@'

REPO='akari-projectX/akari-panel'
RELEASES_URL="${AKARI_RELEASES_URL:-https://github.com/$REPO/releases}"
COSIGN_IDENTITY_PREFIX="https://github.com/$REPO/.github/workflows/release.yml@refs/tags/"
COSIGN_ISSUER='https://token.actions.githubusercontent.com'

COSIGN_VERSION='v3.1.3'
COSIGN_SHA_amd64='4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71'
COSIGN_SHA_arm64='c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a'

# Valkey: distributions ship < 9 (Debian 13: 8.1, Ubuntu 24.04: 7.2) and
# Valkey has no apt repository; the upstream release builds (jammy = glibc
# 2.35, runs on Debian 12 / Ubuntu 22.04; noble = glibc 2.39, Debian 13 /
# Ubuntu 24.04) are pinned here. Bump = new version + the four checksums.
VALKEY_VERSION='9.0.6'
VALKEY_SHA_noble_x86_64='ef591b90b1922abce7e95ad238dbf17455393974f25ad131e7fd1c49566f5201'
VALKEY_SHA_noble_arm64='058508f7243c950e2c49a808e40db04e4386ea36ab6ddb1d1f2fe1a76eb341f6'
VALKEY_SHA_jammy_x86_64='b79800f433bc4f26177b437f63fc9e0b4a02b73049e927407fb1269d0d59d41b'
VALKEY_SHA_jammy_arm64='c8bcafe7351a40f4932d9c0522d9de26faba59905d86a731699b54c3bb4eb0aa'

PGDG_KEY_FPR='B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8'
CADDY_KEY_FPR='65760C51EDEA2017CEA2CA15155B6D79CA56EA34'
DOCKER_KEY_FPR='9DC858229FC7DD38854AE2D88D81803C0EBFCD88'

ETC=/etc/akari
STATE_ENV=$ETC/install.env
LIBDIR=/usr/local/lib/akari
CTL=/usr/local/sbin/akari-ctl
BIN=/usr/local/bin/akari
DATA=/var/lib/akari
BACKUP_ROOT=/var/backups/akari
LOG=/var/log/akari-install.log
VALKEY_ROOT=/opt/akari-valkey
DEFAULT_DOCKER_DIR=/opt/akari
# Bare metal: fixed loopback listeners behind Caddy.
WEB_PORT=8080
ASK_PORT=8082

# --- output, logging, prompts -----------------------------------------------

ZH=0
LOG_READY=0
TMP=
NL='
'
STATUS='' CUR_VERSION='' LANG_OPT='' tag='' ADOPT_DIR='' ADOPT_BARE='' CADDY_OURS='' AGE_RECIPIENT='' OLD_DOCKER_DIR=''
MODE_GIVEN='' DOMAIN_GIVEN='' EMAIL_GIVEN='' ADMIN_GIVEN='' PORTS_GIVEN=''

msg() {
	if [ "$ZH" = 1 ]; then printf '%s' "$1"; else printf '%s' "$2"; fi
}

log() {
	[ "$LOG_READY" = 1 ] || return 0
	printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"
}

# step ZH EN: a progress line (terminal + log).
step() {
	m=$(msg "$1" "$2")
	printf '\033[1;34m==>\033[0m %s\n' "$m"
	log "==> $m"
}

note() {
	m=$(msg "$1" "$2")
	printf '    %s\n' "$m"
	log "    $m"
}

warn() {
	m=$(msg "$1" "$2")
	printf '\033[1;33m%s\033[0m %s\n' "$(msg '警告:' 'WARNING:')" "$m" >&2
	log "WARNING: $m"
}

die() {
	m=$(msg "$1" "$2")
	printf '\033[1;31m%s\033[0m %s\n' "$(msg '错误:' 'ERROR:')" "$m" >&2
	log "ERROR: $m"
	[ "$LOG_READY" = 1 ] && printf '%s %s\n' "$(msg '日志:' 'log:')" "$LOG" >&2
	exit 1
}

# run CMD...: command output goes to the log only. Never pass a secret as an
# argument: the command line is logged (and visible in ps).
run() {
	log "+ $*"
	"$@" >>"$LOG" 2>&1 </dev/null
}

# run_q CMD...: like run, but the command line is not logged (it carries a
# secret prefix in a URL or similar non-password data).
run_q() {
	"$@" >>"$LOG" 2>&1 </dev/null
}

INTERACTIVE=0
YES=0

tty_ok() {
	[ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null
}

# ask VAR ZH EN DEFAULT: read a value from the terminal (default on empty).
ask() {
	_var=$1 _def=$4
	if [ "$INTERACTIVE" != 1 ]; then
		eval "$_var=\$_def"
		return
	fi
	if [ -n "$_def" ]; then
		printf '%s [%s]: ' "$(msg "$2" "$3")" "$_def" >/dev/tty
	else
		printf '%s: ' "$(msg "$2" "$3")" >/dev/tty
	fi
	_ans=
	IFS= read -r _ans </dev/tty || true
	[ -n "$_ans" ] || _ans=$_def
	eval "$_var=\$_ans"
}

# ask_secret VAR ZH EN: hidden input (empty allowed).
ask_secret() {
	_var=$1
	if [ "$INTERACTIVE" != 1 ]; then
		return
	fi
	printf '%s: ' "$(msg "$2" "$3")" >/dev/tty
	stty -echo </dev/tty 2>/dev/null || true
	_ans=
	IFS= read -r _ans </dev/tty || true
	stty echo </dev/tty 2>/dev/null || true
	printf '\n' >/dev/tty
	eval "$_var=\$_ans"
}

# confirm ZH EN DEFAULT(y|n): yes/no question; --yes answers the default.
confirm() {
	if [ "$INTERACTIVE" != 1 ]; then
		[ "$3" = y ]
		return
	fi
	if [ "$3" = y ]; then _h='Y/n'; else _h='y/N'; fi
	printf '%s [%s]: ' "$(msg "$1" "$2")" "$_h" >/dev/tty
	_ans=
	IFS= read -r _ans </dev/tty || true
	[ -n "$_ans" ] || _ans=$3
	case "$_ans" in [yY] | [yY][eE][sS] | 是 | 好) return 0 ;; *) return 1 ;; esac
}

# --- small utilities ----------------------------------------------------------

rand_pw() {
	# 32 alphanumerics (~190 bits): safe inside URLs and config files.
	LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-32}"
}

have() { command -v "$1" >/dev/null 2>&1; }
# Pattern test on a command's output that reads ALL of it (grep -q exits at
# the first match and the writer can die of SIGPIPE); same helper as
# smoke.sh, whose self-check rejects `| grep -q` and `| sed -n 1p` here too.
matches() { grep "$@" >/dev/null; }

port_busy() {
	ss -Hltn "sport = :$1" 2>/dev/null | matches .
}

# kv_get FILE KEY: value of KEY=... in a shell-style env file (no eval).
kv_get() {
	[ -f "$1" ] || return 0
	sed -n "s/^$2=//p" "$1" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/; s/^\"\(.*\)\"\$/\1/"
}

# kv_set FILE KEY VALUE: replace or append KEY=VALUE (file keeps its mode).
kv_set() {
	_f=$1 _k=$2 _v=$3
	[ -f "$_f" ] || : >"$_f"
	_t="$_f.tmp.$$"
	grep -v "^$_k=" "$_f" >"$_t" || true
	printf '%s=%s\n' "$_k" "$_v" >>"$_t"
	cat "$_t" >"$_f"
	rm -f "$_t"
}

# fetch URL OUT: download (https only, except a test release base).
fetch() {
	case "$1" in
	https://*) printf 'url = "%s"\noutput = "%s"\n' "$1" "$2" | curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -K - ;;
	*) printf 'url = "%s"\noutput = "%s"\n' "$1" "$2" | curl -fsSL --retry 3 -K - ;;
	esac
}

# http_status URL [RESOLVE]: status code of a GET; the URL (secret prefix)
# goes to curl on stdin, never on a command line.
http_status() {
	{
		printf 'url = "%s"\n' "$1"
		[ -z "${2:-}" ] || printf 'connect-to = "%s"\n' "$2"
	} | curl -sk -o /dev/null -w '%{http_code}' --max-time 5 -K - 2>/dev/null || true
}

sha_of() { sha256sum "$1" | awk '{ print $1 }'; }

cleanup() {
	[ -z "$TMP" ] || rm -rf "$TMP"
}

# --- platform -------------------------------------------------------------------

OS_ID='' OS_VER='' OS_CODENAME='' OS_PRETTY='' ARCH='' UARCH='' VALKEY_FLAVOR=''

detect_platform() {
	[ -r /etc/os-release ] || die '无法识别操作系统（缺少 /etc/os-release）' 'cannot identify the OS (no /etc/os-release)'
	# shellcheck disable=SC1091 # the system's file
	OS_ID=$(. /etc/os-release && printf '%s' "$ID")
	# shellcheck disable=SC1091
	OS_VER=$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")
	# shellcheck disable=SC1091
	OS_CODENAME=$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")
	# shellcheck disable=SC1091
	OS_PRETTY=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-$ID}")
	case "$OS_ID:$OS_VER" in
	debian:12 | ubuntu:22.04) VALKEY_FLAVOR=jammy ;;
	debian:13 | ubuntu:24.04) VALKEY_FLAVOR=noble ;;
	*)
		die "不支持的系统：$OS_PRETTY。支持 Debian 12/13、Ubuntu 22.04/24.04（其他系统请按 docs/DEPLOY.md 附录手动部署）" \
			"unsupported OS: $OS_PRETTY. Supported: Debian 12/13, Ubuntu 22.04/24.04 (elsewhere follow the manual steps in docs/DEPLOY.md, appendix)"
		;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) ARCH=amd64 UARCH=x86_64 ;;
	aarch64 | arm64) ARCH=arm64 UARCH=arm64 ;;
	*) die "不支持的 CPU 架构 $(uname -m)（仅 amd64、arm64）" "unsupported architecture $(uname -m) (amd64 and arm64 only)" ;;
	esac
}

check_systemd() {
	[ -d /run/systemd/system ] || die '本机没有运行 systemd（必需）' 'systemd is not running on this machine (required)'
}

check_ram() {
	kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)
	mb=$((kb / 1024))
	if [ "$mb" -lt 900 ]; then
		warn "内存 ${mb} MiB，建议 ≥ 1 GiB（PostgreSQL + 面板）" "${mb} MiB of RAM; at least 1 GiB is recommended (PostgreSQL + panel)"
	fi
	if [ "$mb" -lt 450 ]; then
		die "内存 ${mb} MiB 不足（至少 512 MiB）" "${mb} MiB of RAM is not enough (512 MiB minimum)"
	fi
}

# check_ports PORT...: refuse ports something else listens on.
check_ports() {
	busy=
	for p in "$@"; do
		if port_busy "$p"; then busy="$busy $p"; fi
	done
	[ -z "$busy" ] || die "端口已被占用：$busy（ss -ltnp 查看占用者；或用 --http-port/--https-port/--grpc-port 换端口）" \
		"ports already in use:$busy (ss -ltnp shows by what; or choose others with --http-port/--https-port/--grpc-port)"
}

apt_install() {
	run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ||
		die "apt-get install $* 失败（见日志）" "apt-get install $* failed (see the log)"
}

apt_has() {
	apt-cache show "$1" >/dev/null 2>&1
}

APT_UPDATED=0
apt_update() {
	run env DEBIAN_FRONTEND=noninteractive apt-get update || die 'apt-get update 失败' 'apt-get update failed'
	APT_UPDATED=1
}

base_packages() {
	need=
	for c in curl:curl gpg:gnupg ss:iproute2 tar:tar sha256sum:coreutils; do
		have "${c%%:*}" || need="$need ${c#*:}"
	done
	[ -e /etc/ssl/certs/ca-certificates.crt ] || need="$need ca-certificates"
	if [ -n "$need" ]; then
		step "安装基础工具：$need" "installing base tools:$need"
		apt_update
		# shellcheck disable=SC2086 # a list of package names
		apt_install $need
	fi
}

# add_apt_key URL FPR NAME: download a repository key, check its primary
# fingerprint, store it as /etc/apt/keyrings/NAME.asc.
add_apt_key() {
	install -d -m 0755 /etc/apt/keyrings
	fetch "$1" "$TMP/$3.asc" || die "下载 $3 软件源密钥失败" "cannot download the $3 repository key"
	got=$(gpg --show-keys --with-colons "$TMP/$3.asc" 2>/dev/null | awk -F: '/^fpr/ { print $10; exit }')
	[ "$got" = "$2" ] || die "$3 软件源密钥指纹不符（期望 $2，得到 ${got:-无}）" "$3 repository key fingerprint mismatch (expected $2, got ${got:-none})"
	install -m 0644 "$TMP/$3.asc" "/etc/apt/keyrings/$3.asc"
}

# --- release download and verification -----------------------------------------

COSIGN=

ensure_cosign() {
	[ -z "$COSIGN" ] || return 0
	if [ -x "$LIBDIR/cosign-$COSIGN_VERSION" ]; then
		COSIGN="$LIBDIR/cosign-$COSIGN_VERSION"
		return
	fi
	case "$ARCH" in
	amd64) want=$COSIGN_SHA_amd64 ;;
	*) want=$COSIGN_SHA_arm64 ;;
	esac
	fetch "https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-$ARCH" "$TMP/cosign" ||
		die '下载 cosign 失败' 'cannot download cosign'
	[ "$(sha_of "$TMP/cosign")" = "$want" ] || die 'cosign 的 SHA-256 不符' 'SHA-256 mismatch for cosign'
	install -d -m 0755 "$LIBDIR"
	install -m 0755 "$TMP/cosign" "$LIBDIR/cosign-$COSIGN_VERSION"
	COSIGN="$LIBDIR/cosign-$COSIGN_VERSION"
}

# latest_tag: the newest release's tag (from its signed image reference
# file name pattern; verified again after download).
latest_tag() {
	fetch "$RELEASES_URL/latest/download/akari-panel-image.txt" "$TMP/latest-image.txt" ||
		die '无法获取最新版本号' 'cannot determine the latest release'
	v=$(sed -n 's/.*:\([0-9][0-9A-Za-z.+-]*\)@sha256:.*/\1/p' "$TMP/latest-image.txt" | sed -n 1p)
	[ -n "$v" ] || die '无法解析最新版本号' 'cannot parse the latest release version'
	printf 'v%s' "$v"
}

# resolve_tag [REQUESTED]: explicit tag, else this installer's own release,
# else the latest release.
resolve_tag() {
	if [ -n "${1:-}" ]; then
		case "$1" in v*) printf '%s' "$1" ;; *) printf 'v%s' "$1" ;; esac
	elif [ "$INSTALLER_VERSION" != '@@AKARI_INSTALLER_VERSION@@' ] && [ "${AKARI_PREFER_LATEST:-0}" != 1 ]; then
		printf '%s' "$INSTALLER_VERSION"
	else
		latest_tag
	fi
}

REL=

# fetch_release TAG: SHA256SUMS of TAG into $REL, signature checked.
fetch_release() {
	tag=$1
	REL="$TMP/release-$tag"
	mkdir -p "$REL"
	base="$RELEASES_URL/download/$tag"
	fetch "$base/SHA256SUMS" "$REL/SHA256SUMS" || die "下载 $tag 的 SHA256SUMS 失败（版本存在吗？）" "cannot download SHA256SUMS of $tag (does the release exist?)"
	fetch "$base/SHA256SUMS.sigstore.json" "$REL/SHA256SUMS.sigstore.json" || die "下载 $tag 的签名失败" "cannot download the signature of $tag"
	ensure_cosign
	if [ -n "${AKARI_COSIGN_KEY:-}" ]; then
		# Private mirror / CI: a cosign key pair instead of the keyless
		# GitHub identity. Still a signature check, never skipped.
		warn "使用自定义 cosign 公钥 $AKARI_COSIGN_KEY 验证（非官方发布）" "verifying with the custom cosign key $AKARI_COSIGN_KEY (not an official release)"
		run "$COSIGN" verify-blob --key "$AKARI_COSIGN_KEY" --insecure-ignore-tlog=true \
			--bundle "$REL/SHA256SUMS.sigstore.json" "$REL/SHA256SUMS" ||
			die "$tag 的签名验证失败" "signature verification failed for $tag"
	else
		run "$COSIGN" verify-blob --bundle "$REL/SHA256SUMS.sigstore.json" \
			--certificate-identity "$COSIGN_IDENTITY_PREFIX$tag" \
			--certificate-oidc-issuer "$COSIGN_ISSUER" "$REL/SHA256SUMS" ||
			die "$tag 的签名验证失败：SHA256SUMS 不是本仓库发布流程签署的" \
				"signature verification failed for $tag: SHA256SUMS was not signed by this repository's release workflow"
	fi
	note "已验证 $tag 的签名（cosign）" "verified the signature of $tag (cosign)"
}

release_has() {
	awk -v f="$1" '$2 == f || $2 == "*" f { found = 1 } END { exit !found }' "$REL/SHA256SUMS"
}

# release_file NAME: download NAME of the fetched release into $REL and
# check it against the signed SHA256SUMS.
release_file() {
	want=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1; exit }' "$REL/SHA256SUMS")
	[ -n "$want" ] || die "$1 不在该版本的 SHA256SUMS 中" "$1 is not listed in the release's SHA256SUMS"
	fetch "$RELEASES_URL/download/$tag/$1" "$REL/$1" || die "下载 $1 失败" "cannot download $1"
	[ "$(sha_of "$REL/$1")" = "$want" ] || die "$1 的 SHA-256 不符" "SHA-256 mismatch for $1"
}

# get_binary TAG -> $REL/akari (verified, runs, right version).
get_binary() {
	fetch_release "$1"
	release_file "akari-linux-$ARCH"
	install -m 0755 "$REL/akari-linux-$ARCH" "$REL/akari"
	v=$("$REL/akari" --version 2>/dev/null || true)
	case "$v" in
	"akari ${1#v} "* | "akari ${1#v}") ;;
	*) die "下载的二进制版本不符（$v，期望 ${1#v}）" "the downloaded binary reports '$v', expected ${1#v}" ;;
	esac
}

# get_image TAG -> IMAGE (tag@digest from the signed reference file).
IMAGE=
get_image() {
	fetch_release "$1"
	release_file akari-panel-image.txt
	IMAGE=$(head -n 1 "$REL/akari-panel-image.txt")
	case "$IMAGE" in
	*:"${1#v}"@sha256:*) ;;
	*) die "镜像引用与版本不符：$IMAGE" "image reference does not match the release: $IMAGE" ;;
	esac
}

# get_bundle: the deploy files (compose file, Caddyfile, units, backup
# scripts, this installer) -> $BUNDLE. From the fetched release when it
# carries akari-deploy.tar.gz, else from a source checkout (development,
# CI), else from this installer's own release.
BUNDLE=
get_bundle() {
	BUNDLE="$TMP/bundle"
	rm -rf "$BUNDLE"
	mkdir -p "$BUNDLE"
	if [ -n "$REL" ] && release_has akari-deploy.tar.gz; then
		release_file akari-deploy.tar.gz
		tar -xzf "$REL/akari-deploy.tar.gz" -C "$BUNDLE" || die '解压部署文件失败' 'cannot unpack the deploy bundle'
		return
	fi
	src=${AKARI_SOURCE_DIR:-$SELF_DIR}
	if [ -n "$src" ] && [ -f "$src/deploy/docker-compose.yml" ] && [ -f "$src/scripts/backup.sh" ]; then
		note "部署文件取自源码目录 $src" "deploy files from the source tree $src"
		cp -R "$src/deploy" "$BUNDLE/deploy"
		mkdir -p "$BUNDLE/scripts"
		cp "$src/scripts/backup.sh" "$src/scripts/restore.sh" "$src/scripts/install.sh" "$BUNDLE/scripts/"
		return
	fi
	if [ "$INSTALLER_VERSION" != '@@AKARI_INSTALLER_VERSION@@' ]; then
		saved_rel=$REL saved_tag=$tag
		fetch_release "$INSTALLER_VERSION"
		release_has akari-deploy.tar.gz || die '找不到部署文件' 'no deploy bundle available'
		release_file akari-deploy.tar.gz
		tar -xzf "$REL/akari-deploy.tar.gz" -C "$BUNDLE" || die '解压部署文件失败' 'cannot unpack the deploy bundle'
		REL=$saved_rel tag=$saved_tag
		return
	fi
	die '找不到部署文件（从源码运行时设置 AKARI_SOURCE_DIR）' 'no deploy bundle (set AKARI_SOURCE_DIR when running from a source tree)'
}

# install_tools: akari-ctl (this installer, from the bundle) and the backup
# scripts.
install_tools() {
	install -d -m 0755 "$LIBDIR" /usr/local/sbin
	install -m 0755 "$BUNDLE/scripts/backup.sh" "$LIBDIR/backup.sh"
	install -m 0755 "$BUNDLE/scripts/restore.sh" "$LIBDIR/restore.sh"
	install -m 0755 "$BUNDLE/scripts/install.sh" "$CTL.new"
	if [ "$INSTALLER_VERSION" != '@@AKARI_INSTALLER_VERSION@@' ] &&
		grep -q "^INSTALLER_VERSION='@@AKARI_INSTALLER_VERSION@@'" "$CTL.new"; then
		sed -i "s/^INSTALLER_VERSION='@@AKARI_INSTALLER_VERSION@@'/INSTALLER_VERSION='$INSTALLER_VERSION'/" "$CTL.new"
	fi
	mv -f "$CTL.new" "$CTL"
}

# --- settings of the installation ------------------------------------------------

MODE='' DOMAIN='' PUBLIC_IP='' EMAIL='' ADMIN='' ADMIN_PW='' HTTP_PORT='' HTTPS_PORT='' GRPC_PORT=''
VERSION_REQ='' DOCKER_DIR='' LOCAL_CERTS='' RESTORE_DIR='' AGE_IDENTITY='' AGE_RECIPIENT_OPT=''
BACKUP_SH='' NODE_ADDR='' PURGE=0 MIGRATE_TO='' BACKUP_OUT='' FORCE=0 CONFIRM_PURGE='' VALKEY_PORT=''

load_state() {
	[ -f "$STATE_ENV" ] || return 1
	MODE=$(kv_get "$STATE_ENV" MODE)
	CUR_VERSION=$(kv_get "$STATE_ENV" VERSION)
	DOMAIN=${DOMAIN:-$(kv_get "$STATE_ENV" DOMAIN)}
	DOCKER_DIR=$(kv_get "$STATE_ENV" DOCKER_DIR)
	HTTP_PORT=${HTTP_PORT:-$(kv_get "$STATE_ENV" HTTP_PORT)}
	HTTPS_PORT=${HTTPS_PORT:-$(kv_get "$STATE_ENV" HTTPS_PORT)}
	GRPC_PORT=${GRPC_PORT:-$(kv_get "$STATE_ENV" GRPC_PORT)}
	VALKEY_PORT=${VALKEY_PORT:-$(kv_get "$STATE_ENV" VALKEY_PORT)}
	PG_PORT=$(kv_get "$STATE_ENV" PG_PORT)
	EMAIL=${EMAIL:-$(kv_get "$STATE_ENV" EMAIL)}
	LOCAL_CERTS=${LOCAL_CERTS:-$(kv_get "$STATE_ENV" LOCAL_CERTS)}
	PUBLIC_IP=${PUBLIC_IP:-$(kv_get "$STATE_ENV" PUBLIC_IP)}
	AGE_RECIPIENT=$(kv_get "$STATE_ENV" AGE_RECIPIENT)
	CADDY_OURS=$(kv_get "$STATE_ENV" CADDY_OURS)
	STATUS=$(kv_get "$STATE_ENV" STATUS)
	[ -n "$MODE" ]
}

save_state() {
	install -d -m 0750 "$ETC"
	[ -f "$STATE_ENV" ] || install -m 0600 /dev/null "$STATE_ENV"
	chmod 0600 "$STATE_ENV"
	{
		echo "# Written by the Akari installer (akari-ctl). No secrets in this file."
		echo "MODE=$MODE"
		echo "STATUS=${STATUS:-installed}"
		echo "VERSION=$CUR_VERSION"
		echo "DOMAIN=$DOMAIN"
		echo "PUBLIC_IP=$PUBLIC_IP"
		echo "EMAIL=$EMAIL"
		echo "HTTP_PORT=$HTTP_PORT"
		echo "HTTPS_PORT=$HTTPS_PORT"
		echo "GRPC_PORT=$GRPC_PORT"
		echo "LOCAL_CERTS=$LOCAL_CERTS"
		echo "DOCKER_DIR=$DOCKER_DIR"
		echo "PG_PORT=${PG_PORT:-}"
		echo "VALKEY_PORT=${VALKEY_PORT:-}"
		echo "CADDY_OURS=${CADDY_OURS:-}"
		echo "# Backups: an age public key (age1...) encrypts them; empty = plain files (0600)."
		echo "AGE_RECIPIENT=${AGE_RECIPIENT:-}"
	} >"$STATE_ENV"
}

# detect_existing: an installation made by this tool (install.env), or a
# manual docs/DEPLOY.md §A compose checkout that can be adopted.
detect_existing() {
	if load_state; then return 0; fi
	# A compose directory counts when its panel container exists (a plain
	# `akari-ctl uninstall` removes the containers and keeps the directory
	# and volumes: installing again then reuses them).
	for d in /opt/akari-panel/deploy /opt/akari; do
		if [ -f "$d/docker-compose.yml" ] && [ -f "$d/.env" ] && grep -q '^AKARI_IMAGE=' "$d/.env" 2>/dev/null &&
			have docker && [ -n "$(cd "$d" && docker compose ps -a -q panel 2>/dev/null)" ]; then
			ADOPT_DIR=$d
			return 0
		fi
	done
	if [ -f /etc/systemd/system/akari-panel.service ] || [ -x "$BIN" ]; then
		ADOPT_BARE=1
		return 0
	fi
	return 1
}

adopt() {
	if [ -n "${ADOPT_DIR:-}" ]; then
		step "接管已有的 Docker Compose 部署 $ADOPT_DIR" "adopting the existing Docker Compose deployment in $ADOPT_DIR"
		MODE=docker DOCKER_DIR=$ADOPT_DIR
		DOMAIN=$(kv_get "$DOCKER_DIR/.env" AKARI_DOMAIN)
		img=$(kv_get "$DOCKER_DIR/.env" AKARI_IMAGE)
		CUR_VERSION=v$(printf '%s' "$img" | sed -n 's/.*:\([0-9][^@]*\)@.*/\1/p')
		HTTP_PORT=80 HTTPS_PORT=443 GRPC_PORT=8443
		case "$(kv_get "$DOCKER_DIR/.env" AKARI_CADDY_OPTIONS)" in *local_certs*) LOCAL_CERTS=1 ;; esac
		save_state
		return
	fi
	die "发现手动安装的裸机面板（$BIN / akari-panel.service），本工具不能接管它；请按 docs/DEPLOY.md 手动升级，或备份后用本工具重新安装（--restore）" \
		"found a hand-made bare-metal panel ($BIN / akari-panel.service) this tool cannot adopt; upgrade it by hand (docs/DEPLOY.md) or back it up and reinstall with this tool (--restore)"
}

# --- bare metal: components ------------------------------------------------------

PG_PORT=

install_postgres() {
	step '安装 PostgreSQL 18（PGDG 官方源）' 'installing PostgreSQL 18 (PGDG repository)'
	if ! dpkg -s postgresql-18 >/dev/null 2>&1; then
		# A host that already has the PGDG repository (another file, its
		# own key) keeps it: a second entry would make apt refuse both.
		if ! apt_has postgresql-18 && ! grep -rqs 'apt.postgresql.org' /etc/apt/sources.list /etc/apt/sources.list.d; then
			add_apt_key https://www.postgresql.org/media/keys/ACCC4CF8.asc "$PGDG_KEY_FPR" pgdg
			printf 'deb [signed-by=/etc/apt/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$OS_CODENAME" \
				>/etc/apt/sources.list.d/pgdg.list
		fi
		apt_update
		apt_install postgresql-18 postgresql-client-18
	fi
	PG_PORT=$(pg_lsclusters -h 2>/dev/null | awk '$1 == "18" && $2 == "main" { print $3; exit }')
	if [ -z "$PG_PORT" ]; then
		run pg_createcluster 18 main || die '创建 PostgreSQL 18 集群失败' 'cannot create the PostgreSQL 18 cluster'
		PG_PORT=$(pg_lsclusters -h | awk '$1 == "18" && $2 == "main" { print $3; exit }')
	fi
	run systemctl enable --now postgresql@18-main || run pg_ctlcluster 18 main start ||
		die 'PostgreSQL 18 无法启动' 'PostgreSQL 18 does not start'
	i=0
	until (cd / && runuser -u postgres -- pg_isready -q -p "$PG_PORT"); do
		i=$((i + 1))
		[ "$i" -lt 30 ] || die 'PostgreSQL 18 未就绪' 'PostgreSQL 18 is not ready'
		sleep 1
	done
	note "PostgreSQL 18 监听 127.0.0.1:$PG_PORT" "PostgreSQL 18 on 127.0.0.1:$PG_PORT"
}

psql_pg() {
	(cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$PG_PORT" "$@")
}

# setup_database PASSWORD: role + database (idempotent). The password goes
# to psql on stdin; errors are not echoed (they could quote the statement).
setup_database() {
	{
		echo "SELECT 'CREATE ROLE akari LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'akari') \\gexec"
		echo "ALTER ROLE akari WITH LOGIN PASSWORD '$1';"
		echo "SELECT 'CREATE DATABASE akari OWNER akari' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'akari') \\gexec"
	} | psql_pg -d postgres -f - >/dev/null 2>&1 ||
		die '创建数据库/角色失败' 'cannot create the database role/database'
}

install_valkey() {
	step "安装 Valkey $VALKEY_VERSION（官方构建，SHA-256 固定）" "installing Valkey $VALKEY_VERSION (upstream build, pinned SHA-256)"
	dir="$VALKEY_ROOT/valkey-$VALKEY_VERSION"
	if [ ! -x "$dir/bin/valkey-server" ]; then
		f="valkey-$VALKEY_VERSION-$VALKEY_FLAVOR-$UARCH.tar.gz"
		case "$VALKEY_FLAVOR-$UARCH" in
		noble-x86_64) want=$VALKEY_SHA_noble_x86_64 ;;
		noble-arm64) want=$VALKEY_SHA_noble_arm64 ;;
		jammy-x86_64) want=$VALKEY_SHA_jammy_x86_64 ;;
		*) want=$VALKEY_SHA_jammy_arm64 ;;
		esac
		fetch "https://download.valkey.io/releases/$f" "$TMP/$f" || die '下载 Valkey 失败' 'cannot download Valkey'
		[ "$(sha_of "$TMP/$f")" = "$want" ] || die 'Valkey 的 SHA-256 不符' 'SHA-256 mismatch for Valkey'
		install -d -m 0755 "$VALKEY_ROOT"
		mkdir -p "$TMP/vk"
		tar -xzf "$TMP/$f" -C "$TMP/vk"
		rm -rf "$dir"
		mv "$TMP/vk/valkey-$VALKEY_VERSION-$VALKEY_FLAVOR-$UARCH" "$dir"
		chown -R root:root "$dir"
		chmod -R go-w "$dir"
	fi
	ln -sfn "$dir" "$VALKEY_ROOT/current"
	"$VALKEY_ROOT/current/bin/valkey-server" --version >/dev/null 2>&1 ||
		die 'Valkey 无法在本机运行（缺少 libssl3？）' 'Valkey does not run on this machine (libssl3 missing?)'
}

# write_valkey_conf PASSWORD
write_valkey_conf() {
	umask 077
	{
		echo "# Written by the Akari installer. Hot state only: no persistence."
		echo "bind 127.0.0.1 -::1"
		echo "port $VALKEY_PORT"
		echo "protected-mode yes"
		echo "save \"\""
		echo "appendonly no"
		echo "requirepass $1"
	} >"$TMP/valkey.conf"
	install -m 0600 -o root -g root "$TMP/valkey.conf" "$ETC/valkey.conf"
	install -m 0644 "$BUNDLE/deploy/systemd/akari-valkey.service" /etc/systemd/system/akari-valkey.service
}

install_caddy() {
	step '安装 Caddy（官方源）' 'installing Caddy (its apt repository)'
	if ! have caddy; then
		if ! grep -rqs 'dl.cloudsmith.io/public/caddy' /etc/apt/sources.list /etc/apt/sources.list.d; then
			add_apt_key https://dl.cloudsmith.io/public/caddy/stable/gpg.key "$CADDY_KEY_FPR" caddy
			printf 'deb [signed-by=/etc/apt/keyrings/caddy.asc] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n' \
				>/etc/apt/sources.list.d/caddy-stable.list
		fi
		apt_update
		apt_install caddy
		# Remembered beside Caddy's config (install.env goes with a plain
		# uninstall): uninstalling stops a Caddy that came with the panel,
		# and restarts one that served something before.
		: >/etc/caddy/.installed-by-akari
	fi
	if [ -f /etc/caddy/.installed-by-akari ]; then CADDY_OURS=1; else CADDY_OURS=preexisting; fi
}

# caddy_options MODE SEP: global options for the Caddyfile placeholder
# AKARI_CADDY_OPTIONS, one per line (SEP: a newline for systemd, a literal
# \n for compose's .env). Caddy expands the placeholder into tokens,
# newlines included.
caddy_options() {
	o=
	[ "$1" != bare ] || o="admin off"
	[ -z "$EMAIL" ] || o="${o:+$o$2}email $EMAIL"
	[ "$LOCAL_CERTS" != 1 ] || o="${o:+$o$2}local_certs"
	# Compose maps other host ports onto the container's 80/443.
	[ "$1" != bare ] || [ "$HTTP_PORT" = 80 ] || o="${o:+$o$2}http_port $HTTP_PORT"
	[ "$1" != bare ] || [ "$HTTPS_PORT" = 443 ] || o="${o:+$o$2}https_port $HTTPS_PORT"
	printf '%s' "$o"
}

# configure_caddy PREFIX (bare metal): our Caddyfile, the environment (with
# the secret prefix) in a root-only file, and a drop-in that starts Caddy
# without --environ (it would print the prefix into the journal) and with
# the admin API off (it would serve the configuration to local users).
configure_caddy() {
	if [ -f /etc/caddy/Caddyfile ] && ! grep -q 'akari-installer' /etc/caddy/Caddyfile &&
		[ ! -f /etc/caddy/Caddyfile.pre-akari ]; then
		cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-akari
	fi
	{
		echo "# akari-installer: managed by akari-ctl; changes are overwritten on upgrade."
		cat "$BUNDLE/deploy/caddy/Caddyfile"
	} >"$TMP/Caddyfile"
	install -m 0644 "$TMP/Caddyfile" /etc/caddy/Caddyfile
	opts=$(caddy_options bare "$NL")
	{
		echo "AKARI_DOMAIN=${DOMAIN:-$PUBLIC_IP}"
		echo "AKARI_PREFIX=$1"
		echo "AKARI_UPSTREAM=127.0.0.1:$WEB_PORT"
		echo "AKARI_ASK=http://127.0.0.1:$ASK_PORT/ask"
		# systemd EnvironmentFile: a quoted value may span lines.
		printf 'AKARI_CADDY_OPTIONS="%s"\n' "$opts"
	} >"$TMP/caddy.env"
	install -m 0600 -o root -g root "$TMP/caddy.env" "$ETC/caddy.env"
	install -d -m 0755 /etc/systemd/system/caddy.service.d
	cat >"$TMP/caddy-dropin.conf" <<'EOF'
# Written by the Akari installer.
# AKARI_DOMAIN / AKARI_PREFIX (secret) / upstream / ask endpoint for
# /etc/caddy/Caddyfile. No --environ (it logs the environment), and the
# admin API is off (`admin off`), so restart instead of reload.
[Unit]
After=akari-panel.service
[Service]
EnvironmentFile=/etc/akari/caddy.env
ExecStart=
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=
ExecReload=/bin/systemctl --no-block restart caddy.service
EOF
	install -m 0644 "$TMP/caddy-dropin.conf" /etc/systemd/system/caddy.service.d/akari.conf
	run systemctl daemon-reload
	run /usr/bin/env -i PATH=/usr/bin:/bin sh -c "set -a; . $ETC/caddy.env; exec caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" ||
		die 'Caddy 配置校验失败（见日志）' 'the Caddy configuration does not validate (see the log)'
	run systemctl enable caddy.service
	run systemctl restart caddy.service || die 'Caddy 无法启动（journalctl -u caddy）' 'Caddy does not start (journalctl -u caddy)'
}

write_panel_toml() {
	db_pw=$1 vk_pw=$2
	{
		echo "# /etc/akari/panel.toml, written by the Akari installer (root:akari 0640:"
		echo "# it holds the database and Valkey passwords). Only what the process needs"
		echo "# to start (R39); everything else is set in the admin console (系统设置)."
		echo "# Validate: sudo -u akari akari -c /etc/akari/panel.toml config check"
		echo
		echo "data_dir = \"$DATA\""
		echo "database_url = \"postgres://akari:$db_pw@127.0.0.1:$PG_PORT/akari\""
		echo "valkey_url = \"redis://:$vk_pw@127.0.0.1:$VALKEY_PORT\""
		echo
		echo "[web]"
		echo "# Behind Caddy on this host: loopback only."
		echo "bind = \"127.0.0.1:$WEB_PORT\""
		echo "cookie_secure = true"
		echo "trusted_proxies = [\"127.0.0.1/32\"]"
		echo
		echo "[grpc]"
		echo "# Agents dial this directly (mTLS)."
		echo "bind = \"0.0.0.0:$GRPC_PORT\""
		echo
		echo "[tls_ask]"
		echo "# Caddy on-demand TLS ask endpoint (loopback only)."
		echo "bind = \"127.0.0.1:$ASK_PORT\""
		echo
		echo "# [metrics]"
		echo "# bind = \"127.0.0.1:9100\""
	} >"$TMP/panel.toml"
	install -m 0640 -o root -g akari "$TMP/panel.toml" "$ETC/panel.toml"
}

akari_cli() {
	(cd / && runuser -u akari -- "$BIN" -c "$ETC/panel.toml" "$@")
}

install_panel_units() {
	install -m 0644 "$BUNDLE/deploy/systemd/akari.sysusers" /usr/lib/sysusers.d/akari.conf
	run systemd-sysusers /usr/lib/sysusers.d/akari.conf || die '创建 akari 用户失败' 'cannot create the akari user'
	install -d -m 0750 -o root -g akari "$ETC"
	install -d -m 0700 -o akari -g akari "$DATA"
	install -m 0644 "$BUNDLE/deploy/systemd/akari-panel.service" /etc/systemd/system/akari-panel.service
	install -d -m 0755 /etc/systemd/system/akari-panel.service.d
	cat >"$TMP/panel-dropin.conf" <<'EOF'
# Written by the Akari installer: start after the local database and Valkey.
[Unit]
After=postgresql@18-main.service akari-valkey.service
Wants=postgresql@18-main.service akari-valkey.service
EOF
	install -m 0644 "$TMP/panel-dropin.conf" /etc/systemd/system/akari-panel.service.d/installer.conf
	run systemctl daemon-reload
}

prefix_bare() {
	akari_cli info 2>/dev/null | sed -n 's|^route prefix: *\/||p'
}

# --- health checks ------------------------------------------------------------------

# wait_health URL SECONDS: 200 from /<prefix>/healthz.
wait_health() {
	i=0
	while [ "$i" -lt "$2" ]; do
		[ "$(http_status "$1")" = 200 ] && return 0
		sleep 2
		i=$((i + 2))
	done
	return 1
}

panel_health_url() {
	if [ "$MODE" = bare ]; then
		printf 'http://127.0.0.1:%s/%s/healthz' "$WEB_PORT" "$1"
	else
		ip=$(docker_panel_ip)
		printf 'http://%s:8080/%s/healthz' "${ip:-0.0.0.0}" "$1"
	fi
}

# check_proxy PREFIX: healthz through Caddy (TLS, the public path).
check_proxy() {
	url="$(origin)/$1/healthz"
	i=0
	while [ "$i" -lt 60 ]; do
		# Through this host's Caddy whatever DNS says (NAT, DNS not yet set).
		[ "$(http_status "$url" "::127.0.0.1:")" = 200 ] && return 0
		sleep 2
		i=$((i + 2))
	done
	return 1
}

# --- docker -----------------------------------------------------------------------

dc() {
	(cd "$DOCKER_DIR" && docker compose "$@")
}

docker_panel_ip() {
	id=$(dc ps -q panel 2>/dev/null | sed -n 1p)
	[ -n "$id" ] || return 0
	docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{if eq $k "akari_frontend"}}{{$v.IPAddress}}{{end}}{{end}}' "$id" 2>/dev/null
}

install_docker() {
	if docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
		note "Docker 已就绪：$(docker --version 2>/dev/null)" "Docker present: $(docker --version 2>/dev/null)"
		return
	fi
	step '安装 Docker Engine + compose v2（Docker 官方源）' 'installing Docker Engine + compose v2 (Docker apt repository)'
	if ! docker compose version >/dev/null 2>&1; then
		if ! grep -rqs 'download.docker.com' /etc/apt/sources.list /etc/apt/sources.list.d; then
			add_apt_key "https://download.docker.com/linux/$OS_ID/gpg" "$DOCKER_KEY_FPR" docker
			printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
				"$ARCH" "$OS_ID" "$OS_CODENAME" >/etc/apt/sources.list.d/docker.list
		fi
		apt_update
		apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	fi
	run systemctl enable --now docker.service || true
	docker info >/dev/null 2>&1 || die 'Docker 无法启动' 'Docker does not start'
}

docker_volume_dir() {
	docker volume inspect -f '{{.Mountpoint}}' "akari_$1" 2>/dev/null
}

# write_docker_files: compose file, Caddyfile, panel.toml, .env and the env
# files (passwords kept when they exist: re-running is safe).
write_docker_files() {
	install -d -m 0750 "$DOCKER_DIR" "$DOCKER_DIR/caddy"
	install -d -m 0700 "$DOCKER_DIR/env"
	install -m 0644 "$BUNDLE/deploy/docker-compose.yml" "$DOCKER_DIR/docker-compose.yml"
	install -m 0644 "$BUNDLE/deploy/caddy/Caddyfile" "$DOCKER_DIR/caddy/Caddyfile"
	[ -f "$DOCKER_DIR/panel.toml" ] || install -m 0644 "$BUNDLE/deploy/panel.toml.compose.example" "$DOCKER_DIR/panel.toml"
	db_pw=$(kv_get "$DOCKER_DIR/env/postgres.env" POSTGRES_PASSWORD)
	vk_pw=$(kv_get "$DOCKER_DIR/env/valkey.env" VALKEY_PASSWORD)
	[ -n "$db_pw" ] || db_pw=$(rand_pw)
	[ -n "$vk_pw" ] || vk_pw=$(rand_pw)
	umask 077
	printf 'POSTGRES_USER=akari\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=akari\n' "$db_pw" >"$DOCKER_DIR/env/postgres.env"
	printf 'VALKEY_PASSWORD=%s\n' "$vk_pw" >"$DOCKER_DIR/env/valkey.env"
	printf 'DATABASE_URL=postgres://akari:%s@postgres:5432/akari\nVALKEY_URL=redis://:%s@valkey:6379\n' "$db_pw" "$vk_pw" >"$DOCKER_DIR/env/panel.env"
	chmod 0600 "$DOCKER_DIR"/env/*.env
	[ -f "$DOCKER_DIR/.env" ] || install -m 0600 /dev/null "$DOCKER_DIR/.env"
	chmod 0600 "$DOCKER_DIR/.env"
	kv_set "$DOCKER_DIR/.env" AKARI_IMAGE "$IMAGE"
	kv_set "$DOCKER_DIR/.env" AKARI_DOMAIN "${DOMAIN:-$PUBLIC_IP}"
	kv_set "$DOCKER_DIR/.env" AKARI_HTTP_PORT "$HTTP_PORT"
	kv_set "$DOCKER_DIR/.env" AKARI_HTTPS_PORT "$HTTPS_PORT"
	kv_set "$DOCKER_DIR/.env" AKARI_GRPC_PORT "$GRPC_PORT"
	# Compose's .env: a double-quoted value turns \n into newlines.
	kv_set "$DOCKER_DIR/.env" AKARI_CADDY_OPTIONS "\"$(caddy_options docker '\n')\""
}

# pull_images: the panel image (pinned by digest) must come; PostgreSQL,
# Valkey and Caddy follow their major-version tags (patch updates) and a
# failed pull of those is fine when a copy is present (registry rate limits).
pull_images() {
	run dc pull panel || die "拉取 $IMAGE 失败（见日志）" "cannot pull $IMAGE (see the log)"
	pull_infra
}

pull_infra() {
	for svc in postgres valkey caddy; do
		run dc pull "$svc" && continue
		img=$(dc config --images "$svc" 2>/dev/null | sed -n 1p)
		docker image inspect "$img" >/dev/null 2>&1 || die "拉取 $img 失败（见日志）" "cannot pull $img (see the log)"
		warn "拉取 $img 失败，使用本机已有的副本" "could not pull $img; using the local copy"
	done
}

docker_prefix() {
	dc run --rm --no-deps -T panel info 2>/dev/null | sed -n 's|^route prefix: *\/||p'
}

# Over TCP, not the Unix socket: on a fresh volume the image's entrypoint runs
# initdb behind a temporary server that listens only on the socket, then
# restarts it; a socket probe passes during that window and the restore that
# follows hits "the database system is starting up".
wait_docker_pg() {
	i=0
	until dc exec -T postgres pg_isready -q -h 127.0.0.1 -U akari -d akari >/dev/null 2>&1; do
		i=$((i + 1))
		[ "$i" -lt 60 ] || die 'PostgreSQL 容器未就绪' 'the PostgreSQL container is not ready'
		sleep 1
	done
}

# --- backup / restore ---------------------------------------------------------------

# do_backup OUT_PARENT PLAIN(0|1): one backup directory via backup.sh; sets
# BACKUP_PATH. PLAIN=1 forces plain files (migration on this host, deleted
# afterwards).
BACKUP_PATH=
do_backup() {
	parent=$1 plain=$2
	install -d -m 0700 "$parent"
	if [ "$plain" != 1 ] && [ -n "${AGE_RECIPIENT:-}" ]; then
		have age || {
			[ "$APT_UPDATED" = 1 ] || apt_update
			apt_install age
		}
		recip_env="AGE_RECIPIENT=$AGE_RECIPIENT"
		plain_env="AKARI_BACKUP_PLAINTEXT=0"
	else
		recip_env="AGE_RECIPIENT="
		plain_env="AKARI_BACKUP_PLAINTEXT=1"
		[ "$plain" = 1 ] || warn "备份未加密（0600 明文文件）：在 $STATE_ENV 设置 AGE_RECIPIENT=age1… 以加密（docs/BACKUP.md）" \
			"the backup is NOT encrypted (plain files, 0600): set AGE_RECIPIENT=age1... in $STATE_ENV to encrypt (docs/BACKUP.md)"
	fi
	if [ "$MODE" = bare ]; then
		dump_cmd="cd / && runuser -u postgres -- pg_dump -p $PG_PORT --format=custom --no-owner akari"
		data_dir=$DATA
		config_files="$ETC/panel.toml $STATE_ENV $ETC/caddy.env $ETC/valkey.conf"
		ver=$("$BIN" --version 2>/dev/null || echo unknown)
	else
		dump_cmd="cd '$DOCKER_DIR' && docker compose exec -T postgres pg_dump -U akari --format=custom --no-owner akari"
		data_dir=$(docker_volume_dir akari-data)
		config_files="$DOCKER_DIR/.env $DOCKER_DIR/panel.toml $DOCKER_DIR/env/panel.env $DOCKER_DIR/env/postgres.env $DOCKER_DIR/env/valkey.env $STATE_ENV"
		ver=$(kv_get "$DOCKER_DIR/.env" AKARI_IMAGE)
	fi
	out=$(env "$recip_env" "$plain_env" AKARI_PG_DUMP_CMD="$dump_cmd" AKARI_DATA_DIR="$data_dir" \
		AKARI_BACKUP_DIR="$parent" AKARI_CONFIG_FILES="$config_files" AKARI_VERSION_STRING="$ver" \
		AKARI_MANIFEST_EXTRA="mode=$MODE" bash "${BACKUP_SH:-$LIBDIR/backup.sh}" 2>>"$LOG") ||
		die "备份失败（见 $LOG）" "backup failed (see $LOG)"
	printf '%s\n' "$out" >>"$LOG"
	BACKUP_PATH=$(printf '%s\n' "$out" | sed -n 's/^backup: done: \(.*\) (.*)$/\1/p' | tail -n 1)
	[ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ] || die '备份失败' 'backup failed'
}

# check_restore_dir DIR: a backup.sh directory, readable with what we have.
check_restore_dir() {
	[ -d "$1" ] || die "备份目录不存在：$1" "no such backup directory: $1"
	(cd "$1" && sha256sum --check --quiet SHA256SUMS >/dev/null 2>&1) ||
		die "备份校验失败：$1" "backup checksum mismatch: $1"
	if [ -f "$1/db.dump.age" ]; then
		[ -n "$AGE_IDENTITY" ] || die '备份已加密：用 --age-identity <私钥文件> 指定解密密钥' 'the backup is encrypted: pass --age-identity <key file>'
		have age || {
			[ "$APT_UPDATED" = 1 ] || apt_update
			apt_install age
		}
	fi
}

# restore_into: database + data dir from $RESTORE_DIR into this (fresh)
# installation. The database must be empty, the data dir empty.
restore_into() {
	step "从备份恢复：$RESTORE_DIR" "restoring from the backup $RESTORE_DIR"
	if [ "$MODE" = bare ]; then
		load_cmd="cd / && runuser -u postgres -- pg_restore -p $PG_PORT -d akari --clean --if-exists --no-owner --role=akari --exit-on-error --single-transaction"
		data_dir=$DATA owner=akari:akari
	else
		load_cmd="cd '$DOCKER_DIR' && docker compose exec -T postgres pg_restore -U akari -d akari --clean --if-exists --no-owner --exit-on-error --single-transaction"
		data_dir=$(docker_volume_dir akari-data) owner=65532:65532
		[ -n "$data_dir" ] || die '找不到数据卷 akari_akari-data' 'no akari_akari-data volume'
	fi
	run env AGE_IDENTITY_FILE="${AGE_IDENTITY:-}" AKARI_PG_RESTORE_CMD="$load_cmd" AKARI_DATA_DIR="$data_dir" \
		AKARI_OWNER="$owner" bash "$LIBDIR/restore.sh" --force "$RESTORE_DIR" ||
		die "恢复失败（见 $LOG）" "restore failed (see $LOG)"
	chmod 0700 "$data_dir"
}

migration_version() {
	if [ "$MODE" = bare ]; then
		psql_pg -At -d akari -c 'SELECT coalesce(max(version), 0) FROM _sqlx_migrations' 2>/dev/null || echo 0
	else
		dc exec -T postgres psql -X -At -U akari -d akari -c 'SELECT coalesce(max(version), 0) FROM _sqlx_migrations' 2>/dev/null || echo 0
	fi
}

# migration_min_version: the oldest applied migration (0 = none / unreadable).
migration_min_version() {
	if [ "$MODE" = bare ]; then
		psql_pg -At -d akari -c 'SELECT coalesce(min(version), 0) FROM _sqlx_migrations' 2>/dev/null || echo 0
	else
		dc exec -T postgres psql -X -At -U akari -d akari -c 'SELECT coalesce(min(version), 0) FROM _sqlx_migrations' 2>/dev/null || echo 0
	fi
}

# refuse_pre_baseline: v0.4 squashed migrations 0001-0168 into 1000_baseline;
# a database created by v0.3.x cannot be upgraded in place (the panel would
# refuse it at start too, db::migrate). Checked before anything is changed.
refuse_pre_baseline() {
	v=$(migration_min_version | tr -dc 0-9)
	if [ -n "$v" ] && [ "$v" -ge 1 ] && [ "$v" -lt 1000 ]; then
		die "数据库来自 v0.3.x：需要全新安装，见 docs/DEPLOY.md（未做任何改动）" \
			"database from v0.3.x — fresh install required; see docs/DEPLOY.md (nothing was changed)"
	fi
	return 0
}

# default_admin: the admin's e-mail when none is given: the certificate
# e-mail if any, else admin@<main domain> (IP-only installs: a reserved
# .invalid address; change it in the console after logging in).
default_admin() {
	if [ -n "$EMAIL" ]; then
		printf '%s' "$EMAIL"
	else
		printf 'admin@%s' "${DOMAIN:-akari.invalid}"
	fi
}

admin_count() {
	if [ "$MODE" = bare ]; then
		psql_pg -At -d akari -c "SELECT count(*) FROM users WHERE role = 'admin'" 2>/dev/null || echo 0
	else
		dc exec -T postgres psql -X -At -U akari -d akari -c "SELECT count(*) FROM users WHERE role = 'admin'" 2>/dev/null || echo 0
	fi
}

panel_cli() {
	if [ "$MODE" = bare ]; then
		akari_cli "$@"
	else
		dc exec -T panel /akari "$@"
	fi
}

# create_admin: the first admin, when there is none. The password reaches
# the CLI through the environment only.
ADMIN_CREATED=0
create_admin() {
	n=$(admin_count | tr -dc 0-9)
	if [ "${n:-0}" -gt 0 ]; then
		note '已有管理员账户，跳过创建' 'an admin account exists; not creating one'
		return
	fi
	[ -n "$ADMIN_PW" ] || ADMIN_PW=$(rand_pw 20)
	step "创建管理员账户 $ADMIN" "creating the admin account $ADMIN"
	if [ "$MODE" = bare ]; then
		(
			# shellcheck disable=SC2030 # exported to the CLI only
			AKARI_ADMIN_PASSWORD=$ADMIN_PW
			export AKARI_ADMIN_PASSWORD
			run_q akari_cli admin add "$ADMIN"
		) || die '创建管理员失败（见日志）' 'cannot create the admin account (see the log)'
	else
		(
			# shellcheck disable=SC2030 # exported to the CLI only
			AKARI_ADMIN_PASSWORD=$ADMIN_PW
			export AKARI_ADMIN_PASSWORD
			run_q dc exec -T -e AKARI_ADMIN_PASSWORD panel /akari admin add "$ADMIN"
		) || die '创建管理员失败（见日志）' 'cannot create the admin account (see the log)'
	fi
	ADMIN_CREATED=1
}

# apply_settings: main domain and node address on a fresh database.
apply_settings() {
	if ! panel_cli settings --help 2>/dev/null | matches '^ *set '; then
		note '该版本没有 settings 命令：请在 系统设置 中设置主域名与节点通信域名' \
			'this release has no settings command: set the main domain and node address in 系统设置'
		return
	fi
	if [ -n "$DOMAIN" ]; then
		run panel_cli settings set main "$DOMAIN" || warn '设置主域名失败（可在 系统设置 中设置）' 'could not set the main domain (set it in 系统设置)'
	fi
	node=${NODE_ADDR:-${DOMAIN:-$PUBLIC_IP}}
	if [ -n "$node" ]; then
		[ "$GRPC_PORT" = 8443 ] || case "$node" in *:*) ;; *) node="$node:$GRPC_PORT" ;; esac
		run panel_cli settings set node "$node" || warn '设置节点通信域名失败（可在 系统设置 中设置）' 'could not set the node address (set it in 系统设置)'
	fi
}

# --- install -------------------------------------------------------------------------

gather_input() {
	mode_def=${MODE:-docker}
	if [ "$INTERACTIVE" = 1 ] && [ -z "${MODE_GIVEN:-}" ]; then
		printf '%s\n' "$(msg '安装方式：' 'Installation mode:')" >/dev/tty
		printf '  1) %s\n' "$(msg 'Docker Compose（推荐：隔离、易升级/卸载）' 'Docker Compose (recommended: isolated, easy upgrade/removal)')" >/dev/tty
		printf '  2) %s\n' "$(msg '裸机（systemd：PostgreSQL 18 + Valkey 9 + Caddy）' 'bare metal (systemd: PostgreSQL 18 + Valkey 9 + Caddy)')" >/dev/tty
		[ "$mode_def" = bare ] && d=2 || d=1
		ask m '选择' 'choose' "$d"
		case "$m" in 2 | bare) MODE=bare ;; *) MODE=docker ;; esac
	else
		MODE=$mode_def
	fi
	case "$MODE" in bare | docker) ;; *) die "--mode 只能是 bare 或 docker" "--mode must be bare or docker" ;; esac

	[ -n "$PUBLIC_IP" ] || PUBLIC_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | sed -n 1p)
	if [ -z "${DOMAIN_GIVEN:-}" ]; then
		ask DOMAIN '主域名（DNS 已指向本机；留空 = 仅用 IP 访问）' 'main domain (DNS pointing here; empty = IP only)' "$DOMAIN"
	fi
	DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's|^https\?://||; s|/.*$||')
	if [ -z "$DOMAIN" ]; then
		ask PUBLIC_IP '本机公网 IP' 'public IP of this machine' "$PUBLIC_IP"
		[ -n "$PUBLIC_IP" ] || die '无法确定公网 IP：用 --ip 指定' 'cannot determine the public IP: pass --ip'
	elif [ -z "${EMAIL_GIVEN:-}" ]; then
		ask EMAIL '证书通知邮箱（可留空）' 'e-mail for certificate notices (optional)' "$EMAIL"
	fi
	if [ -z "${ADMIN_GIVEN:-}" ]; then
		ask ADMIN '管理员邮箱（登录名）' 'admin e-mail (the login name)' "${ADMIN:-$(default_admin)}"
	fi
	ADMIN=$(printf '%s' "${ADMIN:-$(default_admin)}" | tr '[:upper:]' '[:lower:]')
	if [ -z "$ADMIN_PW" ]; then
		ask_secret ADMIN_PW '管理员密码（留空 = 自动生成）' 'admin password (empty = generate one)'
	fi
	if [ -n "$ADMIN_PW" ] && [ "${#ADMIN_PW}" -lt 8 ]; then
		die '管理员密码至少 8 个字符' 'the admin password needs at least 8 characters'
	fi
	HTTP_PORT=${HTTP_PORT:-80} HTTPS_PORT=${HTTPS_PORT:-443} GRPC_PORT=${GRPC_PORT:-8443}
	if [ -z "${PORTS_GIVEN:-}" ] && confirm '自定义端口？（默认 80/443/8443）' 'customize ports? (default 80/443/8443)' n; then
		ask HTTP_PORT 'HTTP 端口' 'HTTP port' "$HTTP_PORT"
		ask HTTPS_PORT 'HTTPS 端口' 'HTTPS port' "$HTTPS_PORT"
		ask GRPC_PORT '节点 gRPC 端口' 'node gRPC port' "$GRPC_PORT"
	fi
	for p in "$HTTP_PORT" "$HTTPS_PORT" "$GRPC_PORT"; do
		case "$p" in '' | *[!0-9]*) die "端口无效：$p" "invalid port: $p" ;; esac
		[ "$p" -ge 1 ] && [ "$p" -le 65535 ] || die "端口无效：$p" "invalid port: $p"
	done
	# These end up in config files: plain names only.
	[ -z "$DOMAIN" ] || printf '%s' "$DOMAIN" | matches -E '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$' ||
		die "域名无效：$DOMAIN" "invalid domain: $DOMAIN"
	[ -z "$PUBLIC_IP" ] || printf '%s' "$PUBLIC_IP" | matches -E '^[0-9A-Fa-f.:]*$' || die "IP 无效：$PUBLIC_IP" "invalid IP: $PUBLIC_IP"
	[ -z "$EMAIL" ] || printf '%s' "$EMAIL" | matches -E '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$' || die "邮箱无效：$EMAIL" "invalid e-mail: $EMAIL"
	printf '%s' "$ADMIN" | matches -E '^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' ||
		die "管理员邮箱无效：$ADMIN" "invalid admin e-mail: $ADMIN"
	[ -z "$NODE_ADDR" ] || printf '%s' "$NODE_ADDR" | matches -E '^[A-Za-z0-9.:\[\]-]*$' || die "节点地址无效：$NODE_ADDR" "invalid node address: $NODE_ADDR"
	if [ "$MODE" = docker ] && [ -z "$DOCKER_DIR" ]; then DOCKER_DIR=$DEFAULT_DOCKER_DIR; fi
	VALKEY_PORT=${VALKEY_PORT:-6379}

	if [ "$MODE" = bare ]; then m=$(msg '裸机（systemd）' 'bare metal (systemd)'); else m='Docker Compose'; fi
	printf '\n%s\n' "$(msg '即将安装：' 'About to install:')"
	printf '  %s %s\n' "$(msg '方式：  ' 'mode:        ')" "$m"
	printf '  %s %s\n' "$(msg '版本：  ' 'version:     ')" "$TAG"
	printf '  %s %s\n' "$(msg '地址：  ' 'address:     ')" "${DOMAIN:-$PUBLIC_IP $(msg '（仅 IP，自签证书）' '(IP only, self-signed certificate)')}"
	printf '  %s %s\n' "$(msg '管理员：' 'admin:       ')" "$ADMIN"
	printf '  %s %s/%s/%s\n' "$(msg '端口：  ' 'ports:       ')" "$HTTP_PORT" "$HTTPS_PORT" "$GRPC_PORT"
	[ -z "$RESTORE_DIR" ] || printf '  %s %s\n' "$(msg '恢复自：' 'restore from:')" "$RESTORE_DIR"
	if ! confirm '继续？' 'continue?' y; then
		die '已取消' 'cancelled'
	fi
}

cmd_install() {
	if detect_existing && [ "$STATUS" = installing ]; then
		# An earlier run stopped half way: run the installation again
		# (every step is idempotent); our own services may hold the ports.
		step "继续上次未完成的安装（$MODE）" "resuming the unfinished installation ($MODE)"
		stop_mode "$MODE" 2>/dev/null || true
	elif [ "$FORCE" != 1 ] && detect_existing; then
		if [ -n "${ADOPT_DIR:-}${ADOPT_BARE:-}" ]; then
			msg '发现已有的安装。' 'found an existing installation.'
			printf '\n'
		else
			printf '%s\n' "$(msg "已安装（$MODE，$CUR_VERSION）。" "already installed ($MODE, $CUR_VERSION).")"
		fi
		if confirm '改为升级？' 'upgrade it instead?' y; then
			cmd_upgrade
			return
		fi
		die '已有安装：用 akari-ctl upgrade / uninstall' 'already installed: use akari-ctl upgrade / uninstall'
	fi
	check_ram
	base_packages
	TAG=$(resolve_tag "$VERSION_REQ")
	gather_input
	[ "$MODE" != bare ] || check_systemd
	[ -z "$RESTORE_DIR" ] || check_restore_dir "$RESTORE_DIR"
	check_ports "$HTTP_PORT" "$HTTPS_PORT" "$GRPC_PORT"
	if [ "$MODE" = bare ]; then
		check_ports "$WEB_PORT" "$ASK_PORT" "$VALKEY_PORT"
		install_bare
	else
		install_docker_mode
	fi
}

install_bare() {
	step "下载并验证 akari $TAG（$ARCH）" "downloading and verifying akari $TAG ($ARCH)"
	get_binary "$TAG"
	get_bundle
	install_tools
	install_postgres
	install_valkey
	install_caddy
	install_panel_units

	if [ -f "$ETC/panel.toml" ]; then
		db_pw=$(sed -n 's|^database_url = "postgres://akari:\([^@]*\)@.*|\1|p' "$ETC/panel.toml")
		vk_pw=$(sed -n 's|^valkey_url = "redis://:\([^@]*\)@.*|\1|p' "$ETC/panel.toml")
	fi
	[ -n "${db_pw:-}" ] || db_pw=$(rand_pw)
	[ -n "${vk_pw:-}" ] || vk_pw=$(rand_pw)
	setup_database "$db_pw"
	write_valkey_conf "$vk_pw"
	write_panel_toml "$db_pw" "$vk_pw"
	run systemctl daemon-reload
	run systemctl enable --now akari-valkey.service || die 'Valkey 无法启动（journalctl -u akari-valkey）' 'Valkey does not start (journalctl -u akari-valkey)'

	install -m 0755 "$REL/akari" "$BIN.new"
	mv -f "$BIN.new" "$BIN"
	CUR_VERSION=$TAG STATUS=installing
	save_state

	if [ -n "$RESTORE_DIR" ]; then
		restore_into
	fi
	# A database kept from a v0.3.x install, or a v0.3.x backup just restored.
	refuse_pre_baseline
	run akari_cli config check || die '配置校验失败（akari config check，见日志）' 'configuration check failed (akari config check, see the log)'
	prefix=$(prefix_bare)
	[ -n "$prefix" ] || die '无法读取路由前缀' 'cannot read the route prefix'

	step '启动面板' 'starting the panel'
	run systemctl enable akari-panel.service
	run systemctl restart akari-panel.service
	wait_health "$(panel_health_url "$prefix")" 120 ||
		die '面板未通过健康检查（journalctl -u akari-panel）' 'the panel did not become healthy (journalctl -u akari-panel)'
	[ -n "$RESTORE_DIR" ] || apply_settings
	create_admin
	configure_caddy "$prefix"
	open_firewall
	finish "$prefix"
}

install_docker_mode() {
	install_docker
	step "获取并验证 $TAG 的镜像引用" "fetching and verifying the image reference of $TAG"
	get_image "$TAG"
	get_bundle
	install_tools
	write_docker_files
	CUR_VERSION=$TAG STATUS=installing
	save_state
	step "拉取镜像 $IMAGE" "pulling $IMAGE"
	pull_images
	run dc run --rm --no-deps -T panel config check || die '配置校验失败（见日志）' 'configuration check failed (see the log)'
	if [ -n "$RESTORE_DIR" ]; then
		run dc up --no-start
		run dc up -d postgres valkey
		wait_docker_pg
		restore_into
		refuse_pre_baseline
	fi
	prefix=$(docker_prefix)
	[ -n "$prefix" ] || die '无法读取路由前缀' 'cannot read the route prefix'
	kv_set "$DOCKER_DIR/.env" AKARI_PREFIX "$prefix"
	step '启动容器' 'starting the containers'
	run dc up -d || die 'docker compose up 失败（见日志）' 'docker compose up failed (see the log)'
	wait_health "$(panel_health_url "$prefix")" 180 ||
		die '面板未通过健康检查（docker compose logs panel）' 'the panel did not become healthy (docker compose logs panel)'
	[ -n "$RESTORE_DIR" ] || apply_settings
	create_admin
	finish "$prefix"
}

open_firewall() {
	if have ufw && ufw status 2>/dev/null | matches '^Status: active'; then
		for p in "$HTTP_PORT/tcp" "$HTTPS_PORT/tcp" "$GRPC_PORT/tcp"; do
			run ufw allow "$p" || true
		done
		note "防火墙（ufw）已放行 $HTTP_PORT/$HTTPS_PORT/$GRPC_PORT" "firewall (ufw): allowed $HTTP_PORT/$HTTPS_PORT/$GRPC_PORT"
	fi
}

origin() {
	name=${DOMAIN:-$PUBLIC_IP}
	if [ "$HTTPS_PORT" = 443 ]; then printf 'https://%s' "$name"; else printf 'https://%s:%s' "$name" "$HTTPS_PORT"; fi
}

finish() {
	prefix=$1
	if check_proxy "$prefix"; then
		proxy_ok=1
	else
		proxy_ok=0
	fi
	STATUS=installed
	save_state
	o=$(origin)
	printf '\n\033[1;32m%s\033[0m\n\n' "$(msg '安装完成。' 'Installation complete.')"
	printf '  %s %s/%s/admin\n' "$(msg '管理后台：' 'admin console: ')" "$o" "$prefix"
	printf '  %s %s/%s/app\n' "$(msg '用户门户：' 'user portal:   ')" "$o" "$prefix"
	if [ "$ADMIN_CREATED" = 1 ]; then
		printf '  %s %s\n' "$(msg '管理员：  ' 'admin login:   ')" "$ADMIN"
		printf '  %s %s\n' "$(msg '密码：    ' 'password:      ')" "$ADMIN_PW"
		printf '  %s\n' "$(msg '（密码只显示这一次，请立即保存）' '(shown only this once: save it now)')"
	fi
	printf '\n  %s\n' "$(msg '路由前缀是机密：只有知道它的人才能访问面板。' 'The route prefix is secret: the panel is reachable only with it.')"
	[ "$proxy_ok" = 1 ] || warn "经 Caddy 的 HTTPS 检查未通过：确认 DNS 已指向本机、端口 $HTTP_PORT/$HTTPS_PORT 已放行（云防火墙/安全组），证书签发可能需要几分钟" \
		"the HTTPS check through Caddy did not pass yet: make sure DNS points here and ports $HTTP_PORT/$HTTPS_PORT are open (cloud firewall / security group); the certificate can take a few minutes"
	[ -n "$DOMAIN" ] || note '仅 IP：证书由 Caddy 内部 CA 签发，浏览器会警告；正式使用请绑定域名（docs/DEPLOY.md）。' \
		'IP only: the certificate comes from Caddy'"'"'s internal CA (browser warning); bind a domain for production (docs/DEPLOY.md).'
	printf '\n%s\n' "$(msg '下一步：' 'Next steps:')"
	printf '  1. %s\n' "$(msg '登录后台 → 系统设置：确认主域名、订阅域名、节点通信域名' 'log in → 系统设置 (settings): check the main, subscription and node domains')"
	printf '  2. %s\n' "$(msg '节点 → 添加节点 → 复制一键安装命令到节点执行' 'nodes → add a node → run its one-line install command on the node')"
	ctl=akari-ctl
	[ -z "${SUDO_USER:-}" ] || ctl="sudo akari-ctl"
	printf '  3. %s\n' "$(msg "备份：$ctl backup（在 $STATE_ENV 设置 AGE_RECIPIENT 以加密）；升级：$ctl upgrade；状态：$ctl status" "backups: $ctl backup (set AGE_RECIPIENT in $STATE_ENV to encrypt); upgrades: $ctl upgrade; health: $ctl status")"
	printf '  %s %s\n\n' "$(msg '安装日志（不含机密）：' 'install log (no secrets):')" "$LOG"
	log "install finished: mode=$MODE version=$CUR_VERSION"
}

# --- upgrade ----------------------------------------------------------------------------

# maybe_reexec TAG: run the target release's own installer for the upgrade
# (newer upgrade logic), once.
maybe_reexec() {
	[ "${AKARI_NO_REEXEC:-0}" != 1 ] || return 0
	[ "$INSTALLER_VERSION" != "$1" ] || return 0
	[ "$INSTALLER_VERSION" != '@@AKARI_INSTALLER_VERSION@@' ] || return 0
	release_has akari-deploy.tar.gz || return 0
	get_bundle
	[ -f "$BUNDLE/scripts/install.sh" ] || return 0
	note "使用 $1 的安装器执行升级" "running the upgrade with the installer of $1"
	cp "$BUNDLE/scripts/install.sh" "$TMP/next-install.sh"
	sed -i "s/^INSTALLER_VERSION='@@AKARI_INSTALLER_VERSION@@'/INSTALLER_VERSION='$1'/" "$TMP/next-install.sh"
	set -- upgrade --version "$1"
	[ "$FORCE" != 1 ] || set -- "$@" --force
	[ -z "$LANG_OPT" ] || set -- "$@" --lang "$LANG_OPT"
	AKARI_NO_REEXEC=1 sh "$TMP/next-install.sh" "$@"
	exit $?
}

cmd_upgrade() {
	if [ -z "$MODE" ]; then
		detect_existing || die '没有找到安装（先运行安装）' 'no installation found (install first)'
		[ -n "$MODE" ] || adopt
	fi
	[ "$MODE" != bare ] || check_systemd
	refuse_pre_baseline
	base_packages
	TAG=$(resolve_tag "$VERSION_REQ")
	if [ "$TAG" = "$CUR_VERSION" ] && [ "$FORCE" != 1 ]; then
		step "已是 $TAG，无需升级（--force 重新安装同一版本）" "already at $TAG; nothing to do (--force reinstalls it)"
		return 0
	fi
	if [ "$MODE" = bare ]; then
		step "下载并验证 akari $TAG" "downloading and verifying akari $TAG"
		get_binary "$TAG"
	else
		step "获取并验证 $TAG 的镜像引用" "fetching and verifying the image reference of $TAG"
		get_image "$TAG"
	fi
	maybe_reexec "$TAG"
	get_bundle
	# akari-ctl and the backup scripts of the new release are installed only
	# once it runs (a failed upgrade keeps the old tools).
	BACKUP_SH="$BUNDLE/scripts/backup.sh"

	step "升级前备份" "backup before the upgrade"
	do_backup "$BACKUP_ROOT" 0
	note "备份：$BACKUP_PATH" "backup: $BACKUP_PATH"
	mig_before=$(migration_version | tr -dc 0-9)

	if [ "$MODE" = bare ]; then
		upgrade_bare
	else
		upgrade_docker
	fi
}

prefix_current() {
	if [ "$MODE" = bare ]; then prefix_bare; else docker_prefix_env; fi
}

docker_prefix_env() {
	kv_get "$DOCKER_DIR/.env" AKARI_PREFIX
}

upgrade_failed() {
	mig_after=$(migration_version | tr -dc 0-9)
	if [ "${mig_after:-0}" != "${mig_before:-0}" ]; then
		warn "新版本已执行数据库迁移（$mig_before → $mig_after）；迁移只能前进，回滚到旧版本需要从升级前的备份恢复数据库：$BACKUP_PATH（docs/DEPLOY.md「回滚」）" \
			"the new release migrated the database ($mig_before -> $mig_after); migrations are forward-only, so running the old release needs the database from the pre-upgrade backup: $BACKUP_PATH (docs/DEPLOY.md \"Rollback\")"
	fi
}

upgrade_bare() {
	prefix=$(prefix_bare)
	step "切换到 $TAG" "switching to $TAG"
	# Previous binary kept as akari.prev (hard link: the rename below keeps
	# it intact); the new one lands with an atomic rename.
	rm -f "$BIN.prev"
	ln "$BIN" "$BIN.prev"
	install -m 0755 "$REL/akari" "$BIN.new"
	refresh_bare_files
	run akari_cli_new config check || {
		rm -f "$BIN.new"
		die "新版本的配置校验失败，未切换（见日志）" "the new release rejects the configuration; not switched (see the log)"
	}
	mv -f "$BIN.new" "$BIN"
	run systemctl restart akari-panel.service || true
	if wait_health "$(panel_health_url "$prefix")" 120; then
		CUR_VERSION=$TAG
		save_state
		install_tools
		run systemctl restart caddy.service || true
		step "已升级到 $TAG（健康检查通过）" "upgraded to $TAG (health check passed)"
		note "上一版本保留为 $BIN.prev；升级前备份：$BACKUP_PATH" "previous binary kept as $BIN.prev; pre-upgrade backup: $BACKUP_PATH"
		return 0
	fi
	warn "$TAG 未通过健康检查，自动回滚到上一版本" "$TAG failed the health check; rolling back to the previous binary"
	journalctl -u akari-panel.service -n 20 --no-pager -o cat >>"$LOG" 2>&1 || true
	mv -f "$BIN.prev" "$BIN"
	ln "$BIN" "$BIN.prev" 2>/dev/null || true
	run systemctl restart akari-panel.service || true
	if wait_health "$(panel_health_url "$prefix")" 120; then
		upgrade_failed
		die "升级失败，已回滚到 $CUR_VERSION（面板正常运行）。日志：journalctl -u akari-panel" \
			"upgrade failed; rolled back to $CUR_VERSION (the panel is healthy). Log: journalctl -u akari-panel"
	fi
	upgrade_failed
	die "升级失败，回滚后面板仍不健康：从备份恢复 $BACKUP_PATH（docs/BACKUP.md）" \
		"upgrade failed and the rolled-back panel is not healthy either: restore $BACKUP_PATH (docs/BACKUP.md)"
}

akari_cli_new() {
	(cd / && runuser -u akari -- "$BIN.new" -c "$ETC/panel.toml" "$@")
}

# refresh_bare_files: units and Caddyfile of the installer's bundle.
refresh_bare_files() {
	install -m 0644 "$BUNDLE/deploy/systemd/akari-panel.service" /etc/systemd/system/akari-panel.service
	install -m 0644 "$BUNDLE/deploy/systemd/akari-valkey.service" /etc/systemd/system/akari-valkey.service
	if grep -q 'akari-installer' /etc/caddy/Caddyfile 2>/dev/null; then
		{
			echo "# akari-installer: managed by akari-ctl; changes are overwritten on upgrade."
			cat "$BUNDLE/deploy/caddy/Caddyfile"
		} >"$TMP/Caddyfile"
		install -m 0644 "$TMP/Caddyfile" /etc/caddy/Caddyfile
	fi
	run systemctl daemon-reload
}

upgrade_docker() {
	prefix=$(docker_prefix_env)
	[ -n "$prefix" ] || prefix=$(docker_prefix)
	old_image=$(kv_get "$DOCKER_DIR/.env" AKARI_IMAGE)
	step "切换到 $IMAGE" "switching to $IMAGE"
	cp -p "$DOCKER_DIR/docker-compose.yml" "$TMP/compose.prev"
	cp -p "$DOCKER_DIR/caddy/Caddyfile" "$TMP/Caddyfile.prev"
	install -m 0644 "$BUNDLE/deploy/docker-compose.yml" "$DOCKER_DIR/docker-compose.yml"
	install -m 0644 "$BUNDLE/deploy/caddy/Caddyfile" "$DOCKER_DIR/caddy/Caddyfile"
	for k in AKARI_HTTP_PORT:"$HTTP_PORT" AKARI_HTTPS_PORT:"$HTTPS_PORT" AKARI_GRPC_PORT:"$GRPC_PORT"; do
		[ -n "$(kv_get "$DOCKER_DIR/.env" "${k%%:*}")" ] || kv_set "$DOCKER_DIR/.env" "${k%%:*}" "${k#*:}"
	done
	kv_set "$DOCKER_DIR/.env" AKARI_IMAGE "$IMAGE"
	if ! run dc pull panel; then
		kv_set "$DOCKER_DIR/.env" AKARI_IMAGE "$old_image"
		die '拉取新镜像失败，未切换' 'cannot pull the new image; not switched'
	fi
	pull_infra
	run dc up -d --force-recreate panel caddy || true
	if wait_health "$(panel_health_url "$prefix")" 180; then
		CUR_VERSION=$TAG
		save_state
		install_tools
		step "已升级到 $TAG（健康检查通过）" "upgraded to $TAG (health check passed)"
		note "升级前备份：$BACKUP_PATH" "pre-upgrade backup: $BACKUP_PATH"
		return 0
	fi
	warn "$TAG 未通过健康检查，自动回滚到 $old_image" "$TAG failed the health check; rolling back to $old_image"
	dc logs --no-color --tail 30 panel >>"$LOG" 2>&1 || true
	kv_set "$DOCKER_DIR/.env" AKARI_IMAGE "$old_image"
	install -m 0644 "$TMP/compose.prev" "$DOCKER_DIR/docker-compose.yml"
	install -m 0644 "$TMP/Caddyfile.prev" "$DOCKER_DIR/caddy/Caddyfile"
	run dc up -d --force-recreate panel caddy || true
	if wait_health "$(panel_health_url "$prefix")" 180; then
		upgrade_failed
		die "升级失败，已回滚到 $old_image（面板正常运行）" "upgrade failed; rolled back to $old_image (the panel is healthy)"
	fi
	upgrade_failed
	die "升级失败，回滚后面板仍不健康：从备份恢复 $BACKUP_PATH（docs/BACKUP.md）" \
		"upgrade failed and the rolled-back panel is not healthy either: restore $BACKUP_PATH (docs/BACKUP.md)"
}

# --- uninstall ----------------------------------------------------------------------------

cmd_uninstall() {
	detect_existing || die '没有找到安装' 'no installation found'
	[ -n "$MODE" ] || adopt
	if [ "$PURGE" = 1 ]; then
		warn '--purge 会永久删除数据库、数据目录（路由前缀、CA 私钥、jwt.key、master.key）与配置。所有节点都需要重新注册。备份目录保留。' \
			'--purge permanently deletes the database, the data dir (route prefix, CA key, jwt.key, master.key) and the configuration. Every node would need re-enrolling. Backups are kept.'
		if [ "$INTERACTIVE" = 1 ] && [ -z "$CONFIRM_PURGE" ]; then
			printf '%s ' "$(msg '输入 purge 确认：' 'type purge to confirm:')" >/dev/tty
			IFS= read -r CONFIRM_PURGE </dev/tty || true
		fi
		[ "$CONFIRM_PURGE" = purge ] || die '未确认，未删除任何东西（非交互：--confirm purge）' 'not confirmed; nothing removed (non-interactive: --confirm purge)'
	elif ! confirm '卸载面板服务？（数据与配置保留）' 'remove the panel services? (data and configuration are kept)' y; then
		die '已取消' 'cancelled'
	fi
	if [ "$MODE" = bare ]; then uninstall_bare; else uninstall_docker; fi
	rm -f "$CTL"
	if [ "$PURGE" = 1 ]; then
		rm -rf "$ETC" "$LIBDIR"
		step '已彻底卸载（备份保留在 '"$BACKUP_ROOT"'）' "purged (backups kept in $BACKUP_ROOT)"
	else
		rm -f "$STATE_ENV"
		step "已卸载服务；保留：数据与配置（$( [ "$MODE" = bare ] && echo "$DATA, $ETC, PostgreSQL akari" || echo "$DOCKER_DIR, docker volumes akari_*")）" \
			"services removed; kept: data and configuration ($( [ "$MODE" = bare ] && echo "$DATA, $ETC, PostgreSQL database akari" || echo "$DOCKER_DIR, docker volumes akari_*"))"
	fi
}

uninstall_bare() {
	step '停止并移除面板服务' 'stopping and removing the panel services'
	run systemctl disable --now akari-panel.service || true
	run systemctl disable --now akari-valkey.service || true
	rm -f /etc/systemd/system/akari-panel.service /etc/systemd/system/akari-valkey.service
	rm -rf /etc/systemd/system/akari-panel.service.d
	rm -f "$BIN" "$BIN.prev" "$BIN.new"
	# Caddy: back to what it was before us.
	if [ -f /etc/systemd/system/caddy.service.d/akari.conf ]; then
		rm -f /etc/systemd/system/caddy.service.d/akari.conf
		rmdir /etc/systemd/system/caddy.service.d 2>/dev/null || true
		[ ! -f /etc/caddy/Caddyfile.pre-akari ] || mv -f /etc/caddy/Caddyfile.pre-akari /etc/caddy/Caddyfile
		run systemctl daemon-reload
		if [ ! -f /etc/caddy/.installed-by-akari ]; then
			# It served something before us: back to that.
			run systemctl restart caddy.service || true
		else
			# Installed for the panel: stopped (the package stays).
			run systemctl disable --now caddy.service || true
		fi
	fi
	run systemctl daemon-reload
	rm -f "$ETC/caddy.env"
	if [ "$PURGE" = 1 ]; then
		PG_PORT=${PG_PORT:-$(pg_lsclusters -h 2>/dev/null | awk '$1 == "18" && $2 == "main" { print $3; exit }')}
		if [ -n "$PG_PORT" ]; then
			printf 'DROP DATABASE IF EXISTS akari;\nDROP ROLE IF EXISTS akari;\n' | psql_pg -d postgres -f - >>"$LOG" 2>&1 ||
				warn '删除数据库失败' 'could not drop the database'
		fi
		rm -rf "$DATA" "$VALKEY_ROOT"
		rm -f /usr/lib/sysusers.d/akari.conf
		run userdel akari || true
		note '保留软件包 postgresql-18、caddy（apt purge 可删除）' 'packages postgresql-18 and caddy are left installed (apt purge removes them)'
	fi
}

uninstall_docker() {
	step '停止并移除容器' 'stopping and removing the containers'
	if [ "$PURGE" = 1 ]; then
		run dc down -v --remove-orphans || true
		rm -rf "$DOCKER_DIR"
	else
		run dc down --remove-orphans || true
	fi
}

# --- backup command ---------------------------------------------------------------------

cmd_backup() {
	detect_existing || die '没有找到安装' 'no installation found'
	[ -n "$MODE" ] || adopt
	[ -x "$LIBDIR/backup.sh" ] || {
		get_bundle
		install_tools
	}
	out=${BACKUP_OUT:-$BACKUP_ROOT}
	[ -z "$AGE_RECIPIENT_OPT" ] || AGE_RECIPIENT=$AGE_RECIPIENT_OPT
	step '备份数据库、数据目录与配置' 'backing up the database, data dir and configuration'
	do_backup "$out" 0
	step "备份完成：$BACKUP_PATH" "backup written: $BACKUP_PATH"
	note '迁移到新主机：复制该目录，在新主机上运行  install.sh --restore <目录>' \
		'moving hosts: copy this directory and run  install.sh --restore <dir>  on the new host'
}

# --- migrate (same host) -----------------------------------------------------------------

cmd_migrate() {
	detect_existing || die '没有找到安装' 'no installation found'
	[ -n "$MODE" ] || adopt
	case "$MIGRATE_TO" in bare | docker) ;; *) die '用 --to bare 或 --to docker' 'pass --to bare or --to docker' ;; esac
	[ "$MIGRATE_TO" != "$MODE" ] || die "已经是 $MODE" "already $MODE"
	check_systemd
	base_packages
	TAG=${CUR_VERSION:-$(resolve_tag "$VERSION_REQ")}
	[ -z "$VERSION_REQ" ] || TAG=$(resolve_tag "$VERSION_REQ")
	[ -x "$LIBDIR/backup.sh" ] || {
		fetch_release "$TAG"
		get_bundle
		install_tools
	}
	confirm "把面板从 $MODE 迁移到 $MIGRATE_TO（同一主机，保留前缀、密钥、数据）？期间面板停机。" \
		"move the panel from $MODE to $MIGRATE_TO on this host (same prefix, keys, data)? The panel is down meanwhile." y ||
		die '已取消' 'cancelled'

	step '安全备份（保留）' 'safety backup (kept)'
	do_backup "$BACKUP_ROOT" 0
	safety=$BACKUP_PATH
	step '迁移用的转储（本机临时文件，完成后删除）' 'dump for the move (local temporary files, deleted afterwards)'
	do_backup "$TMP/migrate" 1
	move=$BACKUP_PATH

	from=$MODE
	stop_mode "$from"
	saved_domain=$DOMAIN saved_ip=$PUBLIC_IP saved_email=$EMAIL
	MODE=$MIGRATE_TO RESTORE_DIR=$move AGE_IDENTITY=
	DOMAIN=$saved_domain PUBLIC_IP=$saved_ip EMAIL=$saved_email
	[ "$MODE" != docker ] || DOCKER_DIR=${DOCKER_DIR:-$DEFAULT_DOCKER_DIR}
	[ -n "$DOCKER_DIR" ] || DOCKER_DIR=$DEFAULT_DOCKER_DIR
	HTTP_PORT=${HTTP_PORT:-80} HTTPS_PORT=${HTTPS_PORT:-443} GRPC_PORT=${GRPC_PORT:-8443} VALKEY_PORT=${VALKEY_PORT:-6379}
	ADMIN=${ADMIN:-$(default_admin)}
	OLD_DOCKER_DIR=$DOCKER_DIR
	set +e
	(
		set -e
		migrate_install
	)
	rc=$?
	set -e
	if [ "$rc" -ne 0 ]; then
		warn "迁移失败，恢复 $from 服务" "the move failed; bringing the $from services back"
		MODE=$MIGRATE_TO
		stop_mode "$MIGRATE_TO" || true
		MODE=$from
		start_mode "$from"
		load_state || true
		die "迁移失败，已恢复为 $from（安全备份：$safety）" "the move failed; back on $from (safety backup: $safety)"
	fi
	MODE=$MIGRATE_TO
	load_state || true
	retire_mode "$from"
	step "迁移完成：现在是 $MIGRATE_TO（安全备份：$safety）" "moved: now $MIGRATE_TO (safety backup: $safety)"
}

migrate_install() {
	check_ports "$HTTP_PORT" "$HTTPS_PORT" "$GRPC_PORT"
	if [ "$MODE" = bare ]; then
		check_ports "$WEB_PORT" "$ASK_PORT" "$VALKEY_PORT"
		install_bare
	else
		install_docker_mode
	fi
}

stop_mode() {
	if [ "$1" = bare ]; then
		run systemctl stop akari-panel.service caddy.service akari-valkey.service || true
	else
		run dc stop || true
	fi
}

start_mode() {
	if [ "$1" = bare ]; then
		run systemctl start akari-valkey.service akari-panel.service caddy.service || true
	else
		run dc up -d || true
	fi
}

# retire_mode OLD: after a successful move, remove the old services but
# keep their data (database / volumes / data dir) until the operator purges.
retire_mode() {
	if [ "$1" = bare ]; then
		run systemctl disable --now akari-panel.service akari-valkey.service || true
		rm -f /etc/systemd/system/akari-panel.service /etc/systemd/system/akari-valkey.service
		rm -rf /etc/systemd/system/akari-panel.service.d
		rm -f /etc/systemd/system/caddy.service.d/akari.conf
		run systemctl disable --now caddy.service || true
		run systemctl daemon-reload
		rm -f "$BIN.prev"
		mv -f "$BIN" "$BIN.retired" 2>/dev/null || true
		note "旧的裸机数据保留：$DATA、PostgreSQL 数据库 akari、$ETC/panel.toml（确认无误后可删除）" \
			"the old bare-metal data is kept: $DATA, PostgreSQL database akari, $ETC/panel.toml (delete once satisfied)"
	else
		old=${OLD_DOCKER_DIR:-$DEFAULT_DOCKER_DIR}
		(cd "$old" && run docker compose down --remove-orphans) || true
		note "旧的 Docker 数据保留：卷 akari_*、$old（确认无误后：cd $old && docker compose down -v）" \
			"the old Docker data is kept: volumes akari_*, $old (once satisfied: cd $old && docker compose down -v)"
	fi
}

# --- status / info ------------------------------------------------------------------------

cmd_status() {
	detect_existing || die '没有找到安装' 'no installation found'
	[ -n "$MODE" ] || adopt
	printf '%-10s %s\n' mode "$MODE" version "$CUR_VERSION" address "${DOMAIN:-$PUBLIC_IP}"
	if [ "$MODE" = bare ]; then
		for u in akari-panel akari-valkey postgresql@18-main caddy; do
			printf '%-10s %s\n' "$u" "$(systemctl is-active "$u.service" 2>/dev/null || true)"
		done
		prefix=$(prefix_bare)
	else
		dc ps
		prefix=$(docker_prefix_env)
	fi
	if [ -n "$prefix" ] && [ "$(http_status "$(panel_health_url "$prefix")")" = 200 ]; then
		printf '%-10s %s\n' healthz ok
	else
		printf '%-10s %s\n' healthz FAILED
		return 1
	fi
}

cmd_info() {
	detect_existing || die '没有找到安装' 'no installation found'
	[ -n "$MODE" ] || adopt
	if [ "$MODE" = bare ]; then prefix=$(prefix_bare); else prefix=$(docker_prefix_env); fi
	o=$(origin)
	printf '%s/%s/admin\n%s/%s/app\n' "$o" "$prefix" "$o" "$prefix"
}

# --- arguments, main ---------------------------------------------------------------------

usage() {
	cat <<'EOF'
Akari panel installer / akari-ctl

  install.sh [install] [options]      install (interactive unless --yes)
  install.sh upgrade [--version vX]   upgrade (backup, verify, switch, health check, rollback)
  install.sh backup [--out DIR] [--age-recipient age1...]
  install.sh migrate --to docker|bare move this installation to the other mode
  install.sh uninstall [--purge [--confirm purge]]
  install.sh status | info

Options (environment variable in brackets):
  -y, --yes                 non-interactive: defaults for everything not given
  --mode bare|docker        [AKARI_MODE]       default docker
  --domain NAME             [AKARI_DOMAIN]     main domain; empty = IP only
  --ip ADDRESS              [AKARI_PUBLIC_IP]  public address (IP-only installs)
  --email ADDRESS           [AKARI_EMAIL]      ACME account e-mail (optional)
  --admin EMAIL             [AKARI_ADMIN]      admin login (default: --email, else admin@<domain>)
  --admin-password-file F   [AKARI_ADMIN_PASSWORD] default: generated, printed once
  --node-address HOST[:P]   [AKARI_NODE_ADDRESS] address agents dial (default: domain / IP)
  --http-port N --https-port N --grpc-port N   default 80 / 443 / 8443
  --version vX.Y.Z          [AKARI_VERSION]    default: this installer's release / latest
  --dir DIR                 [AKARI_DOCKER_DIR] compose directory (default /opt/akari)
  --local-certs             Caddy's internal CA for every name (test / LAN names)
  --restore DIR             install from a backup made by `backup` (host moves)
  --age-identity FILE       age key to decrypt an encrypted backup (--restore)
  --lang zh|en              prompts/messages language (default: from the locale)
  --force                   reinstall / re-run the upgrade of the same version

Testing / private mirrors: AKARI_RELEASES_URL (release base),
AKARI_COSIGN_KEY (verify with a cosign public key instead of the keyless
release identity), AKARI_SOURCE_DIR (deploy files from a source tree).
EOF
}

parse_args() {
	CMD=install
	while [ $# -gt 0 ]; do
		case "$1" in
		install | upgrade | uninstall | migrate | backup | status | info) CMD=$1 ;;
		-y | --yes) YES=1 ;;
		--mode) MODE=$2 MODE_GIVEN=1 && shift ;;
		--domain) DOMAIN=$2 DOMAIN_GIVEN=1 && shift ;;
		--ip) PUBLIC_IP=$2 && shift ;;
		--email) EMAIL=$2 EMAIL_GIVEN=1 && shift ;;
		--admin) ADMIN=$2 ADMIN_GIVEN=1 && shift ;;
		--admin-password-file)
			[ -r "$2" ] || die "无法读取 $2" "cannot read $2"
			ADMIN_PW=$(head -n 1 "$2")
			shift
			;;
		--node-address) NODE_ADDR=$2 && shift ;;
		--http-port) HTTP_PORT=$2 PORTS_GIVEN=1 && shift ;;
		--https-port) HTTPS_PORT=$2 PORTS_GIVEN=1 && shift ;;
		--grpc-port) GRPC_PORT=$2 PORTS_GIVEN=1 && shift ;;
		--version) VERSION_REQ=$2 && shift ;;
		--dir) DOCKER_DIR=$2 && shift ;;
		--local-certs) LOCAL_CERTS=1 ;;
		--restore) RESTORE_DIR=$2 && shift ;;
		--age-identity) AGE_IDENTITY=$2 && shift ;;
		--age-recipient) AGE_RECIPIENT_OPT=$2 && shift ;;
		--out) BACKUP_OUT=$2 && shift ;;
		--to) MIGRATE_TO=$2 && shift ;;
		--purge) PURGE=1 ;;
		--confirm) CONFIRM_PURGE=$2 && shift ;;
		--force) FORCE=1 ;;
		--lang) LANG_OPT=$2 && shift ;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "未知参数：$1（--help）" "unknown option: $1 (--help)" ;;
		esac
		shift
	done
	# Environment (automation); flags win.
	[ -n "$MODE" ] || { [ -z "${AKARI_MODE:-}" ] || MODE=$AKARI_MODE MODE_GIVEN=1; }
	[ -n "$DOMAIN" ] || { [ -z "${AKARI_DOMAIN+x}" ] || DOMAIN=$AKARI_DOMAIN DOMAIN_GIVEN=1; }
	[ -n "$PUBLIC_IP" ] || PUBLIC_IP=${AKARI_PUBLIC_IP:-}
	[ -n "$EMAIL" ] || { [ -z "${AKARI_EMAIL+x}" ] || EMAIL=$AKARI_EMAIL EMAIL_GIVEN=1; }
	[ -n "$ADMIN" ] || { [ -z "${AKARI_ADMIN:-}" ] || ADMIN=$AKARI_ADMIN ADMIN_GIVEN=1; }
	# shellcheck disable=SC2031 # the caller's environment
	[ -n "$ADMIN_PW" ] || ADMIN_PW=${AKARI_ADMIN_PASSWORD:-}
	[ -n "$NODE_ADDR" ] || NODE_ADDR=${AKARI_NODE_ADDRESS:-}
	[ -n "$VERSION_REQ" ] || VERSION_REQ=${AKARI_VERSION:-}
	[ -n "$DOCKER_DIR" ] || DOCKER_DIR=${AKARI_DOCKER_DIR:-}
	if [ "$YES" = 1 ]; then
		DOMAIN_GIVEN=1 EMAIL_GIVEN=1 ADMIN_GIVEN=1 PORTS_GIVEN=1 MODE_GIVEN=1
	fi
}

set_lang() {
	case "${LANG_OPT:-}" in
	zh*) ZH=1 ;;
	en*) ZH=0 ;;
	*)
		case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
		zh*) ZH=1 ;;
		*) ZH=0 ;;
		esac
		;;
	esac
}

# become_root ARGS...: re-run as root through sudo. From a file: the same
# file; piped (curl | sh): download the installer again (same release).
become_root() {
	[ "$(id -u)" -ne 0 ] || return 0
	have sudo || die '请以 root 运行（或安装 sudo）' 'run as root (or install sudo)'
	keep='AKARI_MODE,AKARI_DOMAIN,AKARI_PUBLIC_IP,AKARI_EMAIL,AKARI_ADMIN,AKARI_ADMIN_PASSWORD,AKARI_NODE_ADDRESS,AKARI_VERSION,AKARI_DOCKER_DIR,AKARI_RELEASES_URL,AKARI_COSIGN_KEY,AKARI_SOURCE_DIR,LANG,LC_ALL,LC_MESSAGES'
	if [ -n "$SELF_FILE" ]; then
		exec sudo --preserve-env="$keep" sh "$SELF_FILE" "$@"
	fi
	if [ "$INSTALLER_VERSION" != '@@AKARI_INSTALLER_VERSION@@' ]; then
		url="$RELEASES_URL/download/$INSTALLER_VERSION/install.sh"
	else
		url="$RELEASES_URL/latest/download/install.sh"
	fi
	note '以 sudo 重新运行' 're-running through sudo'
	t=$(mktemp)
	fetch "$url" "$t" || die "下载安装器失败：$url" "cannot download the installer: $url"
	chmod 0644 "$t"
	sudo --preserve-env="$keep" sh "$t" "$@"
	rc=$?
	rm -f "$t"
	exit "$rc"
}

SELF_FILE=
SELF_DIR=

main() {
	set -eu
	umask 077
	export LC_NUMERIC=C
	# The panel binary lets DATABASE_URL / VALKEY_URL override panel.toml;
	# a caller's (CI job, a developer shell) must never redirect the CLI
	# calls below away from the installed database (pool timeouts).
	unset DATABASE_URL VALKEY_URL
	case "$0" in
	*install.sh | *akari-ctl)
		if [ -f "$0" ]; then
			SELF_FILE=$0
			SELF_DIR=$(cd "$(dirname "$0")/.." && pwd)
		fi
		;;
	esac
	set_lang
	parse_args "$@"
	set_lang
	become_root "$@"
	# Child tools (perl's pg_lsclusters, apt) in the plain C locale: the
	# messages are ours, whatever locales the machine has.
	LC_ALL=C
	export LC_ALL
	if [ "$YES" != 1 ] && tty_ok; then INTERACTIVE=1; fi

	install -d -m 0755 "$(dirname "$LOG")"
	[ -f "$LOG" ] || install -m 0600 /dev/null "$LOG"
	chmod 0600 "$LOG"
	LOG_READY=1
	log "akari installer $INSTALLER_VERSION: $CMD (pid $$)"

	TMP=$(mktemp -d)
	trap cleanup EXIT
	trap 'cleanup; exit 130' INT TERM
	detect_platform

	case "$CMD" in
	install) cmd_install ;;
	upgrade) cmd_upgrade ;;
	uninstall) cmd_uninstall ;;
	migrate) cmd_migrate ;;
	backup) cmd_backup ;;
	status) cmd_status ;;
	info) cmd_info ;;
	esac
}

main "$@"
