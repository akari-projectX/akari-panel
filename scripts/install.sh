#!/bin/sh
# Akari panel installer / operations tool (akari panel installer).
#
#   curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh | sh
#
# One command installs the panel on a fresh Debian 12/13 or Ubuntu 22.04/24.04
# machine, either on bare metal (PostgreSQL 18 from PGDG, Valkey 9 from the
# upstream release builds, Caddy from its GitHub release, systemd units) or
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
#   * Valkey and Caddy are the upstream release builds, pinned by SHA-256 in
#     this file; the PGDG and Docker apt keys are pinned by fingerprint;
#   * generated passwords never appear on a command line or in the log
#     (/var/log/akari-install.log, 0600); the admin password is printed once
#     to the terminal, and the secret admin prefix only in the final summary
#     (and by `akari-ctl info`);
#   * data dir 0700 (admin prefix seed, CA key, jwt.key, master.key), panel.toml
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

# Caddy: the upstream release tarball from GitHub (its Cloudsmith apt
# repository answers 402 since 2026-10-09 and is not used). Bump = new
# version + the two SHA-256 of caddy_<version>_linux_{amd64,arm64}.tar.gz,
# checked against the release's caddy_<version>_checksums.txt (SHA-512).
CADDY_VERSION='2.11.7'
CADDY_SHA_amd64='727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b'
CADDY_SHA_arm64='d8fc6d179a5d283028a472a5618564f6ad8a86fed513e64f032b3b0b7cc45e42'
# An apt source of that repository (older installers added one): an apt-get
# update that fails only because of it turns it off (apt_update).
CADDY_APT_RE='dl\.cloudsmith\.io(:[0-9]+)?/public/caddy/'

PGDG_KEY_FPR='B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8'
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

LOG_READY=0
TMP=
NL='
'
STATUS='' CUR_VERSION='' LANG_OPT='' tag='' ADOPT_DIR='' ADOPT_BARE='' CADDY_OURS='' AGE_RECIPIENT='' BACKUP_SIGN_KEY='' OLD_DOCKER_DIR=''
MODE_GIVEN='' DOMAIN_GIVEN='' EMAIL_GIVEN='' ADMIN_GIVEN='' PORTS_GIVEN=''
# The log (plain text) the block's step failures quote; set once it exists.
UI_LOG=''
INTERACTIVE=0
YES=0

log() {
	[ "$LOG_READY" = 1 ] || return 0
	printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"
}
ui_log() { log "$*"; }

# >>> akari-ui >>>
# Presentation shared by the panel installer and the node installer (the
# same block, byte for byte: scripts/installer-test/ui-check.py). Language,
# locale, palette, banner, numbered steps with a spinner, prompts, summary
# card. Presentation only: nothing here decides what gets installed.
#
# A message is a KEY in the script's own table (msg_zh / msg_en): `msg KEY
# ARGS...` prints the entry of the current language with printf, so both
# translations of a key take the same arguments in the same order. Flag
# names, environment variables, paths and log keys stay ASCII.
#
# Output goes to the terminal and, as plain text, to the log (ui_log).
# Colour only on a terminal with NO_COLOR unset and TERM not dumb; the
# spinner needs only a terminal. In a non-UTF-8 locale (English fallback with
# LC_ALL=C) the glyphs are ASCII.

UI_LANG=zh UI_UTF=1 UI_TTY=0 UI_ANSI=0 UI_COLOR=0 UI_ECOLOR=0
UI_TOTAL=0 UI_N=0 UI_T0=0 UI_OPEN=0 UI_MARK=0 UI_LABEL='' UI_SHOWLOG=1
G_OK='✓' G_ERR='✗' G_DOT='·' G_ARROW='›' G_WARN='!' G_Q='?' G_EL='✗ '
c_accent='' c_dim='' c_ok='' c_warn='' c_err='' c_bold='' c_reset='' g1='' g2='' g3='' g4='' g5=''

msg_tab() {
	if [ "$UI_LANG" = zh ]; then msg_zh "$1"; else msg_en "$1"; fi
}
# shellcheck disable=SC2059 # the format is one of our own table entries
msg() {
	_f=$(msg_tab "$1")
	shift
	printf -- "$_f" "$@"
}
msg_has() { [ "$(msg_tab "$1")" != "$1" ]; }

# ui_init: decide glyphs and palette (after the locale step).
ui_init() {
	UI_TTY=0 UI_ANSI=0 UI_COLOR=0 UI_ECOLOR=0
	[ -t 1 ] && UI_TTY=1
	[ "$UI_TTY" = 1 ] && [ "${TERM:-dumb}" != dumb ] && UI_ANSI=1
	[ "$UI_ANSI" = 1 ] && [ -z "${NO_COLOR:-}" ] && UI_COLOR=1
	[ "$UI_COLOR" = 1 ] && [ -t 2 ] && UI_ECOLOR=1
	if [ "$UI_UTF" = 1 ]; then
		G_OK='✓' G_ERR='✗' G_DOT='·' G_ARROW='›' G_WARN='!' G_Q='?' G_EL='✗ '
	else
		G_OK='OK' G_ERR='FAIL' G_DOT='-' G_ARROW='>' G_WARN='!' G_Q='?' G_EL=''
	fi
	[ "$UI_COLOR" = 1 ] || return 0
	_e=$(printf '\033')
	c_reset="${_e}[0m" c_bold="${_e}[1m" c_dim="${_e}[2m"
	c_ok="${_e}[32m" c_warn="${_e}[33m" c_err="${_e}[31m"
	case "${COLORTERM:-}${TERM:-}" in
	*truecolor* | *24bit* | *256color*)
		c_accent="${_e}[38;5;33m"
		g1="${_e}[38;5;27m" g2="${_e}[38;5;33m" g3="${_e}[38;5;39m" g4="${_e}[38;5;75m" g5="${_e}[38;5;111m"
		;;
	*)
		c_accent="${_e}[94m"
		g1="${_e}[94m" g2="${_e}[94m" g3="${_e}[94m" g4="${_e}[94m" g5="${_e}[94m"
		;;
	esac
}

# ui_banner SUBTITLE: AKARI in ANSI Shadow letters, once, on a terminal.
ui_banner() {
	[ "$UI_TTY" = 1 ] && [ "${AKARI_NO_BANNER:-0}" != 1 ] || return 0
	printf '\n'
	if [ "$UI_UTF" = 1 ]; then
		printf '  %s █████╗ %s██╗  ██╗%s █████╗ %s██████╗ %s██╗%s\n' "$g1" "$g2" "$g3" "$g4" "$g5" "$c_reset"
		printf '  %s██╔══██╗%s██║ ██╔╝%s██╔══██╗%s██╔══██╗%s██║%s\n' "$g1" "$g2" "$g3" "$g4" "$g5" "$c_reset"
		printf '  %s███████║%s█████╔╝ %s███████║%s██████╔╝%s██║%s\n' "$g1" "$g2" "$g3" "$g4" "$g5" "$c_reset"
		printf '  %s██╔══██║%s██╔═██╗ %s██╔══██║%s██╔══██╗%s██║%s\n' "$g1" "$g2" "$g3" "$g4" "$g5" "$c_reset"
		printf '  %s██║  ██║%s██║  ██╗%s██║  ██║%s██║  ██║%s██║%s\n' "$g1" "$g2" "$g3" "$g4" "$g5" "$c_reset"
		printf '  %s╚═╝  ╚═╝%s╚═╝  ╚═╝%s╚═╝  ╚═╝%s╚═╝  ╚═╝%s╚═╝%s\n' "$g1" "$g2" "$g3" "$g4" "$g5" "$c_reset"
	else
		printf '%s' "$c_accent"
		cat <<'AKARI_BANNER_EOF'
    _    _  __    _    ____  ___
   / \  | |/ /   / \  |  _ \|_ _|
  / _ \ | ' /   / _ \ | |_) || |
 / ___ \| . \  / ___ \|  _ < | |
/_/   \_\_|\_\/_/   \_\_| \_\___|
AKARI_BANNER_EOF
		printf '%s' "$c_reset"
	fi
	printf '  %s%s%s\n' "$c_dim" "$1" "$c_reset"
}

# --- lines ---------------------------------------------------------------------

# say KEY ARGS...: a plain line.
say() {
	_m=$(msg "$@")
	printf '  %s\n' "$_m"
	ui_log "  $_m"
}
# note KEY ARGS...: a detail line inside a step.
note() {
	_m=$(msg "$@")
	printf '      %s%s%s %s\n' "$c_dim" "$G_DOT" "$c_reset" "$_m"
	ui_log "    - $_m"
}
# ok KEY ARGS...: a result line.
ok() {
	_m=$(msg "$@")
	printf '  %s%s%s %s%s%s\n' "$c_ok" "$G_OK" "$c_reset" "$c_bold" "$_m" "$c_reset"
	ui_log "OK: $_m"
}
warn() {
	_m=$(msg "$@")
	ui_log "WARNING: $_m"
	if [ "$UI_ECOLOR" = 1 ]; then
		printf '      %s%s %s%s %s\n' "$c_warn" "$G_WARN" "$(msg ui_warning)" "$c_reset" "$_m" >&2
	else
		printf '      %s %s %s\n' "$G_WARN" "$(msg ui_warning)" "$_m" >&2
	fi
}
die() {
	_m=$(msg "$@")
	ui_log "ERROR: $_m"
	_tail=0
	if [ "$UI_OPEN" = 1 ]; then
		_tail=1
		UI_OPEN=0
		printf '      %s%s%s %s%s%s\n' "$c_err" "$G_ERR" "$c_reset" "$c_dim" "$(ui_elapsed)" "$c_reset"
	fi
	if [ "$UI_ECOLOR" = 1 ]; then
		printf '\n  %s%s%s%s %s\n' "$c_err" "$G_EL" "$(msg ui_error)" "$c_reset" "$_m" >&2
	else
		printf '\n  %s%s %s\n' "$G_EL" "$(msg ui_error)" "$_m" >&2
	fi
	[ "$_tail" = 1 ] && ui_tail_log
	[ "$UI_SHOWLOG" = 1 ] && [ -n "${UI_LOG:-}" ] && [ "$UI_LOG" != /dev/null ] && printf '  %s%s %s%s\n' "$c_dim" "$(msg ui_log_is)" "$UI_LOG" "$c_reset" >&2
	exit 1
}

# ui_tail_log: the last lines the failed step wrote to the log.
ui_tail_log() {
	[ -n "${UI_LOG:-}" ] && [ "$UI_LOG" != /dev/null ] && [ -r "$UI_LOG" ] || return 0
	_t=$(tail -n +"$((UI_MARK + 1))" "$UI_LOG" 2>/dev/null | tail -n 20)
	[ -n "$_t" ] || return 0
	printf '  %s%s%s\n' "$c_dim" "$(msg ui_last_lines)" "$c_reset" >&2
	printf '%s\n' "$_t" | while IFS= read -r _l; do
		printf '  %s|%s %s\n' "$c_dim" "$c_reset" "$_l" >&2
	done
}

ui_elapsed() {
	_s=$(($(date +%s) - UI_T0))
	if [ "$_s" -ge 60 ]; then printf '%dm%02ds' $((_s / 60)) $((_s % 60)); else printf '%ds' "$_s"; fi
}

# --- steps -----------------------------------------------------------------------

# steps N: the next steps are numbered 1..N.
steps() {
	step_end
	UI_TOTAL=$1 UI_N=0
}
# step KEY ARGS...: a numbered phase; the previous one is closed first.
step() {
	step_end
	UI_N=$((UI_N + 1))
	_m=$(msg "$@")
	if [ "$UI_TOTAL" -gt 0 ]; then _p="[$UI_N/$UI_TOTAL]"; else _p=$G_ARROW; fi
	printf '\n%s%s%s %s%s%s\n' "$c_accent" "$_p" "$c_reset" "$c_bold" "$_m" "$c_reset"
	ui_log "==> $_p $_m"
	UI_OPEN=1 UI_T0=$(date +%s) UI_LABEL=$_m
	UI_MARK=$( { wc -l <"${UI_LOG:-/dev/null}"; } 2>/dev/null || echo 0)
	UI_MARK=$((UI_MARK + 0))
}
step_end() {
	[ "$UI_OPEN" = 1 ] || return 0
	UI_OPEN=0
	_d=$(ui_elapsed)
	printf '      %s%s%s %s%s%s\n' "$c_ok" "$G_OK" "$c_reset" "$c_dim" "$_d" "$c_reset"
	ui_log "    done ($_d)"
}

ui_frame() {
	if [ "$UI_UTF" = 1 ]; then
		case $(($1 % 10)) in
		0) printf '⠋' ;; 1) printf '⠙' ;; 2) printf '⠹' ;; 3) printf '⠸' ;; 4) printf '⠼' ;;
		5) printf '⠴' ;; 6) printf '⠦' ;; 7) printf '⠧' ;; 8) printf '⠇' ;; *) printf '⠏' ;;
		esac
	else
		case $(($1 % 4)) in
		0) printf '|' ;; 1) printf '/' ;; 2) printf -- '-' ;; *) printf '%s' "\\" ;;
		esac
	fi
}
ui_tick() { sleep 0.2 2>/dev/null || sleep 1; }

# ui_spin PID: animate the current step title until PID exits (terminal only).
ui_spin() {
	_i=0
	_s=$(date +%s)
	while kill -0 "$1" 2>/dev/null; do
		printf '\r\033[K      %s%s%s %s %s%ds%s' "$c_accent" "$(ui_frame "$_i")" "$c_reset" "$UI_LABEL" "$c_dim" $(($(date +%s) - _s)) "$c_reset"
		_i=$((_i + 1))
		ui_tick
	done
	ui_clear
}
# ui_pulse N: one spinner frame for a wait loop that ticks once a second.
ui_pulse() {
	[ "$UI_ANSI" = 1 ] || return 0
	printf '\r\033[K      %s%s%s %s %s%ds%s' "$c_accent" "$(ui_frame "$1")" "$c_reset" "$UI_LABEL" "$c_dim" $(($(date +%s) - UI_T0)) "$c_reset"
}
ui_clear() {
	[ "$UI_ANSI" = 1 ] && printf '\r\033[K'
	return 0
}

# ui_bg CMD...: run a command with its output in the log, children in the
# plain C locale (their messages are parsed here, ours come from the table),
# with a spinner on a terminal.
ui_bg() {
	if [ "$UI_ANSI" != 1 ] || [ "$UI_OPEN" != 1 ]; then
		(
			LC_ALL=C
			export LC_ALL
			"$@"
		) >>"${UI_LOG:-/dev/null}" 2>&1 </dev/null
		return
	fi
	(
		LC_ALL=C
		export LC_ALL
		"$@"
	) >>"${UI_LOG:-/dev/null}" 2>&1 </dev/null &
	_pid=$!
	ui_spin "$_pid"
	wait "$_pid"
}

# --- summary card -------------------------------------------------------------------

ui_rule() {
	_r=''
	_n=$1
	while [ "$_n" -gt 0 ]; do
		if [ "$UI_UTF" = 1 ]; then _r="$_r─"; else _r="$_r-"; fi
		_n=$((_n - 1))
	done
	printf '%s' "$_r"
}
# card_open KEY ARGS...: the top edge with a title; card_row/card_text/
# card_blank; card_close. Rows are never logged (they carry the one-time
# password and the secret admin prefix).
card_open() {
	_m=$(msg "$@")
	step_end
	if [ "$UI_UTF" = 1 ]; then _a='┌─'; else _a='+-'; fi
	printf '\n  %s%s%s %s%s%s%s %s%s%s\n' "$c_accent" "$_a" "$c_reset" "$c_ok" "$c_bold" "$_m" "$c_reset" "$c_accent" "$(ui_rule 24)" "$c_reset"
	ui_log "== $_m"
}
ui_bar() { if [ "$UI_UTF" = 1 ]; then printf '│'; else printf '|'; fi; }
card_blank() { printf '  %s%s%s\n' "$c_accent" "$(ui_bar)" "$c_reset"; }
# card_row LABELKEY VALUE: the label cell is padded in the table.
card_row() {
	printf '  %s%s%s  %s%s%s%s\n' "$c_accent" "$(ui_bar)" "$c_reset" "$c_dim" "$(msg "$1")" "$c_reset" "$2"
}
card_text() {
	_m=$(msg "$@")
	printf '  %s%s%s  %s\n' "$c_accent" "$(ui_bar)" "$c_reset" "$_m"
}
card_close() {
	if [ "$UI_UTF" = 1 ]; then _a='└─'; else _a='+-'; fi
	printf '  %s%s%s%s\n\n' "$c_accent" "$_a" "$(ui_rule 30)" "$c_reset"
}

# --- prompts (answers only from /dev/tty) --------------------------------------------

ui_ask_head() {
	printf '\n  %s%s%s %s%s%s\n' "$c_accent" "$G_Q" "$c_reset" "$c_bold" "$1" "$c_reset" >/dev/tty
	if msg_has "$2_hint"; then
		printf '    %s%s%s\n' "$c_dim" "$(msg "$2_hint")" "$c_reset" >/dev/tty
	fi
}
ui_ask_line() {
	if [ -n "$1" ]; then
		printf '  %s%s%s [%s] ' "$c_accent" "$G_ARROW" "$c_reset" "$1" >/dev/tty
	else
		printf '  %s%s%s ' "$c_accent" "$G_ARROW" "$c_reset" >/dev/tty
	fi
}
ui_ask_error() {
	printf '    %s%s %s%s\n' "$c_err" "$G_ERR" "$1" "$c_reset" >/dev/tty
}

# ask VAR KEY DEFAULT [ARGS...]: one line; the default on an empty answer.
ask() {
	_av=$1 _ak=$2 _ad=$3
	shift 3
	ask_valid "$_av" "$_ak" "$_ad" '' '' "$@"
}
# ask_valid VAR KEY DEFAULT CHECK ERRKEY [ARGS...]: CHECK is a function that
# gets the answer; a bad answer shows ERRKEY and asks again. Without a
# terminal the default is taken and the caller's own checks apply.
ask_valid() {
	_av=$1 _ak=$2 _ad=$3 _ac=$4 _ae=$5
	shift 5
	if [ "$INTERACTIVE" != 1 ]; then
		eval "$_av=\$_ad"
		return
	fi
	ui_ask_head "$(msg "$_ak" "$@")" "$_ak"
	while :; do
		ui_ask_line "$_ad"
		_ans=
		IFS= read -r _ans </dev/tty || true
		[ -n "$_ans" ] || _ans=$_ad
		if [ -z "$_ac" ] || "$_ac" "$_ans"; then break; fi
		ui_ask_error "$(msg "$_ae" "$_ans")"
	done
	eval "$_av=\$_ans"
}
# ask_secret VAR KEY: hidden input (empty allowed).
ask_secret() {
	[ "$INTERACTIVE" = 1 ] || return 0
	_av=$1 _ak=$2
	ui_ask_head "$(msg "$_ak")" "$_ak"
	ui_ask_line ''
	stty -echo </dev/tty 2>/dev/null || true
	_ans=
	IFS= read -r _ans </dev/tty || true
	stty echo </dev/tty 2>/dev/null || true
	printf '\n' >/dev/tty
	eval "$_av=\$_ans"
}
# confirm KEY y|n [ARGS...]: yes/no; without a terminal the default answers.
confirm() {
	_ak=$1 _ad=$2
	shift 2
	if [ "$INTERACTIVE" != 1 ]; then
		[ "$_ad" = y ]
		return
	fi
	if [ "$_ad" = y ]; then _h='Y/n'; else _h='y/N'; fi
	_q=$(msg "$_ak" "$@")
	while :; do
		printf '\n  %s%s%s %s%s%s %s[%s]%s ' "$c_accent" "$G_Q" "$c_reset" "$c_bold" "$_q" "$c_reset" "$c_dim" "$_h" "$c_reset" >/dev/tty
		_ans=
		IFS= read -r _ans </dev/tty || true
		[ -n "$_ans" ] || _ans=$_ad
		case "$_ans" in
		[yY] | [yY][eE][sS] | 是 | 好) return 0 ;;
		[nN] | [nN][oO] | 否 | 不) return 1 ;;
		esac
	done
}
# menu VAR KEY DEFAULT_NUMBER VALUE=LABELKEY...: a numbered list. A number or
# a value is accepted. Without a terminal VAR is left as the caller set it.
menu() {
	[ "$INTERACTIVE" = 1 ] || return 0
	_av=$1 _ak=$2 _ad=$3
	shift 3
	ui_ask_head "$(msg "$_ak")" "$_ak"
	_n=0
	for _o in "$@"; do
		_n=$((_n + 1))
		_d=''
		[ "$_n" != "$_ad" ] || _d=" $c_dim($(msg ui_default))$c_reset"
		printf '    %s%d)%s %s%s\n' "$c_accent" "$_n" "$c_reset" "$(msg "${_o#*=}")" "$_d" >/dev/tty
	done
	while :; do
		ui_ask_line "$_ad"
		_ans=
		IFS= read -r _ans </dev/tty || true
		[ -n "$_ans" ] || _ans=$_ad
		_n=0
		for _o in "$@"; do
			_n=$((_n + 1))
			if [ "$_ans" = "$_n" ] || [ "$_ans" = "${_o%%=*}" ]; then
				eval "$_av=\${_o%%=*}"
				return 0
			fi
		done
		ui_ask_error "$(msg ui_pick_number "$#")"
	done
}

# --- language and locale -----------------------------------------------------------------
# Chinese is the default. The installer needs zh_CN.UTF-8 for it and makes
# sure it exists (Debian/Ubuntu: the locales package, generated only for the
# installer's own run through LC_ALL; the system default locale is never
# touched). Alpine/musl has UTF-8 built in. If the locale cannot be
# installed the whole run is English. --lang / AKARI_LANG choose explicitly
# (en skips the locale install). These lines are English: Chinese is not
# guaranteed yet.

ui_lang_name() {
	case "$1" in
	zh | zh_* | zh-* | cn) printf zh ;;
	en | en_* | en-*) printf en ;;
	esac
}
ui_has_zh_locale() {
	locale -a 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '-' | grep '^zh_cn\.utf8$' >/dev/null
}
ui_has_c_utf8() {
	locale -a 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '-' | grep '^c\.utf8$' >/dev/null
}
ui_os_id() {
	[ -r /etc/os-release ] || return 0
	# shellcheck disable=SC1091 # the system's file
	(. /etc/os-release && printf '%s' "${ID:-}")
}
# ui_use_english WHY: the run is English; UTF-8 where the system has it.
ui_use_english() {
	UI_LANG=en
	if [ "$(ui_os_id)" = alpine ] || ui_has_c_utf8; then
		LC_ALL=C.UTF-8 UI_UTF=1
	else
		LC_ALL=C UI_UTF=0
	fi
	export LC_ALL
	[ -z "$1" ] || printf '  %s %s\n' '-' "$1"
}
# ui_install_locale: the locales package, zh_CN.UTF-8 enabled and generated.
ui_install_locale() {
	command -v apt-get >/dev/null 2>&1 || return 1
	_l="${UI_LOG:-/dev/null}"
	if ! command -v locale-gen >/dev/null 2>&1; then
		(
			DEBIAN_FRONTEND=noninteractive
			export DEBIAN_FRONTEND
			apt-get install -y --no-install-recommends locales >>"$_l" 2>&1 </dev/null ||
				{
					# a source that fails (a dead repository on the host) must not stop the others
					apt-get update >>"$_l" 2>&1 </dev/null || true
					apt-get install -y --no-install-recommends locales >>"$_l" 2>&1 </dev/null
				}
		) || return 1
	fi
	if [ "$(ui_os_id)" = ubuntu ]; then
		locale-gen zh_CN.UTF-8 >>"$_l" 2>&1 </dev/null || return 1
	else
		if [ -f /etc/locale.gen ]; then
			if grep '^zh_CN\.UTF-8 UTF-8' /etc/locale.gen >/dev/null 2>&1; then
				:
			elif grep '^# *zh_CN\.UTF-8 UTF-8' /etc/locale.gen >/dev/null 2>&1; then
				sed -i 's/^# *\(zh_CN\.UTF-8 UTF-8\)/\1/' /etc/locale.gen || return 1
			else
				echo 'zh_CN.UTF-8 UTF-8' >>/etc/locale.gen || return 1
			fi
		else
			echo 'zh_CN.UTF-8 UTF-8' >/etc/locale.gen || return 1
		fi
		locale-gen >>"$_l" 2>&1 </dev/null || return 1
	fi
	ui_has_zh_locale
}
# ui_locale_setup WANT: WANT is zh, en or empty (default zh). Sets UI_LANG,
# UI_UTF and LC_ALL (exported to the installer and its children only).
ui_locale_setup() {
	if [ "$1" = en ]; then
		ui_use_english ''
		return 0
	fi
	if [ "$(ui_os_id)" = alpine ]; then
		UI_LANG=zh UI_UTF=1 LC_ALL=C.UTF-8
		export LC_ALL
		return 0
	fi
	if ui_has_zh_locale; then
		UI_LANG=zh UI_UTF=1 LC_ALL=zh_CN.UTF-8
		export LC_ALL
		return 0
	fi
	printf '  %s zh_CN.UTF-8 is not installed: installing it for this run (the locales package; the system default locale stays as it is)\n' '-'
	if [ "$(id -u)" -eq 0 ] && ui_install_locale; then
		UI_LANG=zh UI_UTF=1 LC_ALL=zh_CN.UTF-8
		export LC_ALL
		return 0
	fi
	ui_use_english 'zh_CN.UTF-8 could not be installed here: continuing in English'
}
# <<< akari-ui <<<

# run CMD...: command output goes to the log only. Never pass a secret as an
# argument: the command line is logged (and visible in ps).
run() {
	log "+ $*"
	ui_bg "$@"
}

# run_q CMD...: like run, but the command line is not logged (it carries a
# secret prefix in a URL or similar non-password data).
run_q() {
	ui_bg "$@"
}

tty_ok() {
	[ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null
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

# Input validators (scripts/installer-test/validators.sh runs them under GNU
# grep and busybox grep). Portable ERE only: no `\[` / `\]` inside a bracket
# expression (a backslash is literal there: `[a\]-]` is `[a\]` then `-]`;
# put `]` first and `-` last instead), no `\d`, `\w`, `\s`, no `\?` / `\|` in
# BRE: they only work with some greps (e.g. ugrep, the grep of WSL).
#
# re ERE VALUE: VALUE is one line (grep matches line by line) and matches.
re() { [ "$(printf '%s' "$2" | wc -l)" -eq 0 ] && printf '%s' "$2" | matches -E "$1"; }
LABEL_RE='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
valid_domain() { [ "${#1}" -le 253 ] && re "^($LABEL_RE\.)*$LABEL_RE\$" "$1"; }
valid_ip() { re '^[0-9A-Fa-f.:]+$' "$1"; }
valid_email() { re '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$' "$1"; }
valid_admin() { re '^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' "$1"; }
# valid_node_addr ADDR: the panel's node communication domain syntax
# (settings::Domain): HOST or HOST:PORT, HOST a DNS name of two labels or
# more, an IPv4 address or a [bracketed] IPv6 address; or a bare IPv6
# address (no port). Lowercase names (the caller folds the case).
valid_node_addr() {
	case "$1" in
	\[*\]) _h=${1#\[} _h=${_h%\]} _p=none ;;
	\[*\]:*) _h=${1%\]:*} _h=${_h#\[} _p=${1##*\]:} ;;
	*:*:*) _h=$1 _p=none ;;
	*:*) _h=${1%:*} _p=${1##*:} ;;
	*) _h=$1 _p=none ;;
	esac
	case "$_p" in
	none) ;;
	'' | *[!0-9]* | 0*) return 1 ;;
	*) [ "${#_p}" -le 5 ] && [ "$_p" -le 65535 ] || return 1 ;;
	esac
	case "$1" in
	\[* | *:*:*) re '^[0-9a-f.]*:[0-9a-f:.]*$' "$_h" ;;
	*) case "$_h" in *.*) valid_domain "$_h" ;; *) return 1 ;; esac ;;
	esac
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# norm_domain VALUE: what the domain prompt accepts, as a bare lower-case name.
norm_domain() { lower "$1" | sed 's|^http://||; s|^https://||; s|/.*$||'; }
ok_domain() { _d=$(norm_domain "$1") && { [ -z "$_d" ] || valid_domain "$_d"; }; }
ok_email_opt() { [ -z "$1" ] || valid_email "$1"; }
ok_admin() { valid_admin "$(lower "$1")"; }
ok_node_addr() { valid_node_addr "$(lower "$1")"; }
ok_port() {
	case "$1" in '' | *[!0-9]* | 0*) return 1 ;; esac
	[ "${#1}" -le 5 ] && [ "$1" -le 65535 ]
}

# Cloudflare edge ranges: the same list as src/cloudflare_ips.txt
# (installer-test/validators.sh checks they agree). Every IPv6 prefix is
# /32 or shorter (in_cidr compares the first 32 bits of IPv6).
CF_RANGES='173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18
108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15
104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32
2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32'

# ip_hi32 IP: IPv4 -> the address as a number; IPv6 -> its first 32 bits
# (the first two groups) as a number. Fails on anything else.
ip_hi32() {
	case "$1" in
	*:*)
		re '^[0-9A-Fa-f:.]+$' "$1" || return 1
		case "$1" in
		::*) _a=0 _b=0 ;;
		*)
			_a=${1%%:*} _r=${1#*:}
			case "$_r" in :*) _b=0 ;; *) _b=${_r%%:*} ;; esac
			;;
		esac
		[ -n "$_a" ] && [ -n "$_b" ] && [ "${#_a}" -le 4 ] && [ "${#_b}" -le 4 ] || return 1
		case "$_a$_b" in *.*) return 1 ;; esac
		echo $((0x$_a * 65536 + 0x$_b))
		;;
	*)
		re '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' "$1" || return 1
		_s=$IFS
		IFS=.
		# shellcheck disable=SC2086 # split on the dots
		set -- $1
		IFS=$_s
		for _o in "$@"; do
			# no leading zeros (sh arithmetic reads them as octal)
			case "$_o" in 0?*) return 1 ;; esac
			[ "$_o" -le 255 ] || return 1
		done
		echo $(((($1 * 256 + $2) * 256 + $3) * 256 + $4))
		;;
	esac
}

# in_cidr IP NET/BITS: IP lies in the range (same family; IPv6 /0../32).
in_cidr() {
	_net=${2%/*} _bits=${2#*/}
	case "$1" in *:*) _f1=6 ;; *) _f1=4 ;; esac
	case "$_net" in *:*) _f2=6 ;; *) _f2=4 ;; esac
	[ "$_f1" = "$_f2" ] || return 1
	case "$_bits" in '' | *[!0-9]*) return 1 ;; esac
	[ "$_bits" -le 32 ] || return 1
	_i=$(ip_hi32 "$1") && _n=$(ip_hi32 "$_net") || return 1
	_sh=$((32 - _bits))
	[ $((_i >> _sh)) -eq $((_n >> _sh)) ]
}

cloudflare_ip() {
	for _c in $CF_RANGES; do
		in_cidr "$1" "$_c" && return 0
	done
	return 1
}

# public_ipv4 IP: not loopback, private, CGNAT or link-local.
public_ipv4() {
	for _c in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16; do
		in_cidr "$1" "$_c" && return 1
	done
	ip_hi32 "$1" >/dev/null
}

# host_ips NAME: the addresses NAME resolves to here, one per line
# (nothing when it does not resolve).
host_ips() {
	getent ahosts "$1" 2>/dev/null | cut -d' ' -f1 | sort -u
}

# behind_cloudflare HOST: a host name that resolves into Cloudflare's edge
# (an orange-clouded record). IP literals and unresolved names: no.
behind_cloudflare() {
	valid_domain "$1" || return 1
	for _ip in $(host_ips "$1"); do
		cloudflare_ip "$_ip" && return 0
	done
	return 1
}

# node_host ADDR: the host part of a node address (valid_node_addr syntax).
node_host() {
	case "$1" in
	\[*) _h=${1#\[} && echo "${_h%%\]*}" ;;
	*:*:*) echo "$1" ;;
	*) echo "${1%:*}" ;;
	esac
}

# check_node_addr: the node address agents dial must reach the panel's gRPC
# port directly (mTLS end to end): never a Cloudflare-proxied name. With no
# --node-address the main domain is the default; when that is
# orange-clouded, ask for another one (DNS-only name or IP) or, without a
# terminal, stop with how to pass one.
check_node_addr() {
	if [ -n "$NODE_ADDR" ]; then
		behind_cloudflare "$(node_host "$NODE_ADDR")" || return 0
		_why=$(msg node_address_resolves_cloudflare_orange_cloud "$NODE_ADDR")
	elif [ -n "$DOMAIN" ] && behind_cloudflare "$DOMAIN"; then
		_why=$(msg main_domain_resolves_cloudflare_orange_cloud "$DOMAIN")
	else
		return 0
	fi
	warn node_agents_dial_panels_grpc_port "$_why" "$GRPC_PORT"
	if [ "$INTERACTIVE" != 1 ]; then
		die pass_node_address_with_node_address
	fi
	_def=
	[ -z "$PUBLIC_IP" ] || ! public_ipv4 "$PUBLIC_IP" || _def=$PUBLIC_IP
	while :; do
		ask_valid NODE_ADDR node_address_dns_only_name_or "$_def" ok_node_addr invalid_address
		NODE_ADDR=$(lower "$NODE_ADDR")
		if behind_cloudflare "$(node_host "$NODE_ADDR")"; then
			warn resolves_cloudflare_too_make_it_dns "$NODE_ADDR"
		else
			return 0
		fi
	done
}

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
	ui_clear
	[ -z "$TMP" ] || rm -rf "$TMP"
}

# --- platform -------------------------------------------------------------------

OS_ID='' OS_VER='' OS_CODENAME='' OS_PRETTY='' ARCH='' UARCH='' VALKEY_FLAVOR=''

detect_platform() {
	[ -r /etc/os-release ] || die cannot_identify_os_no_etc_os
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
		die unsupported_os_supported_debian_12_13 "$OS_PRETTY"
		;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) ARCH=amd64 UARCH=x86_64 ;;
	aarch64 | arm64) ARCH=arm64 UARCH=arm64 ;;
	*) die unsupported_architecture_amd64_and_arm64_only "$(uname -m)" ;;
	esac
}

check_systemd() {
	[ -d /run/systemd/system ] || die systemd_not_running_on_this_machine
}

check_ram() {
	kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)
	mb=$((kb / 1024))
	if [ "$mb" -lt 900 ]; then
		warn mib_ram_at_least_1_gib "${mb}"
	fi
	if [ "$mb" -lt 450 ]; then
		die mib_ram_not_enough_512_mib "${mb}"
	fi
}

# check_ports PORT...: refuse ports something else listens on.
check_ports() {
	busy=
	for p in "$@"; do
		if port_busy "$p"; then busy="$busy $p"; fi
	done
	[ -z "$busy" ] || die ports_already_in_use_ss_ltnp "$busy"
}

apt_install() {
	run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ||
		die apt_get_install_failed_see_log
}

apt_has() {
	apt-cache show "$1" >/dev/null 2>&1
}

APT_UPDATED=0
apt_update() {
	if ! apt_update_once; then
		disable_caddy_apt_source || die apt_get_update_failed
		apt_update_once || die apt_get_update_failed
	fi
	APT_UPDATED=1
}

apt_update_once() {
	log "+ apt-get update"
	if env LC_ALL=C DEBIAN_FRONTEND=noninteractive apt-get update >"$TMP/apt-update.out" 2>&1 </dev/null; then
		cat "$TMP/apt-update.out" >>"$LOG"
		return 0
	fi
	cat "$TMP/apt-update.out" >>"$LOG"
	return 1
}

# disable_caddy_apt_source: after a failed apt-get update whose every error
# is about Caddy's Cloudsmith repository, rename the sources.list.d files
# that use it to *.akari.disabled (apt ignores them). Fails otherwise.
disable_caddy_apt_source() {
	grep -q '^E:' "$TMP/apt-update.out" || return 1
	grep '^E:' "$TMP/apt-update.out" >"$TMP/apt-update.errors"
	! grep -qvE "$CADDY_APT_RE" "$TMP/apt-update.errors" || return 1
	if grep -qsE "^[^#]*$CADDY_APT_RE" /etc/apt/sources.list; then
		die etc_apt_sources_list_has_caddys
	fi
	found=
	for f in /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
		[ -f "$f" ] && grep -qE "^[^#]*$CADDY_APT_RE" "$f" || continue
		mv -f "$f" "$f.akari.disabled"
		warn disabled_caddys_cloudsmith_apt_repository_unavailable "$f" "$f"
		found=1
	done
	[ -n "$found" ]
}

base_packages() {
	need=
	for c in curl:curl gpg:gnupg ss:iproute2 tar:tar sha256sum:coreutils openssl:openssl; do
		have "${c%%:*}" || need="$need ${c#*:}"
	done
	[ -e /etc/ssl/certs/ca-certificates.crt ] || need="$need ca-certificates"
	if [ -n "$need" ]; then
		step installing_base_tools "$need"
		apt_update
		# shellcheck disable=SC2086 # a list of package names
		apt_install $need
		step_end
	fi
}

# add_apt_key URL FPR NAME: download a repository key, check its primary
# fingerprint, store it as /etc/apt/keyrings/NAME.asc.
add_apt_key() {
	install -d -m 0755 /etc/apt/keyrings
	fetch "$1" "$TMP/$3.asc" || die cannot_download_repository_key "$3"
	got=$(gpg --show-keys --with-colons "$TMP/$3.asc" 2>/dev/null | awk -F: '/^fpr/ { print $10; exit }')
	[ "$got" = "$2" ] || die repository_key_fingerprint_mismatch "$3" "$2" "${got:-?}"
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
		die cannot_download_cosign
	[ "$(sha_of "$TMP/cosign")" = "$want" ] || die sha_256_mismatch_for_cosign
	install -d -m 0755 "$LIBDIR"
	install -m 0755 "$TMP/cosign" "$LIBDIR/cosign-$COSIGN_VERSION"
	COSIGN="$LIBDIR/cosign-$COSIGN_VERSION"
}

# latest_tag: the newest release's tag (from its signed image reference
# file name pattern; verified again after download).
latest_tag() {
	fetch "$RELEASES_URL/latest/download/akari-panel-image.txt" "$TMP/latest-image.txt" ||
		die cannot_determine_latest_release
	v=$(sed -n 's/.*:\([0-9][0-9A-Za-z.+-]*\)@sha256:.*/\1/p' "$TMP/latest-image.txt" | sed -n 1p)
	[ -n "$v" ] || die cannot_parse_latest_release_version
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
	fetch "$base/SHA256SUMS" "$REL/SHA256SUMS" || die cannot_download_sha256sums_does_release_exist "$tag"
	fetch "$base/SHA256SUMS.sigstore.json" "$REL/SHA256SUMS.sigstore.json" || die cannot_download_signature "$tag"
	ensure_cosign
	if [ -n "${AKARI_COSIGN_KEY:-}" ]; then
		# Private mirror / CI: a cosign key pair instead of the keyless
		# GitHub identity. Still a signature check, never skipped.
		warn verifying_with_custom_cosign_key_not "$AKARI_COSIGN_KEY"
		run "$COSIGN" verify-blob --key "$AKARI_COSIGN_KEY" --insecure-ignore-tlog=true \
			--bundle "$REL/SHA256SUMS.sigstore.json" "$REL/SHA256SUMS" ||
			die signature_verification_failed_for "$tag"
	else
		run "$COSIGN" verify-blob --bundle "$REL/SHA256SUMS.sigstore.json" \
			--certificate-identity "$COSIGN_IDENTITY_PREFIX$tag" \
			--certificate-oidc-issuer "$COSIGN_ISSUER" "$REL/SHA256SUMS" ||
			die signature_verification_failed_for_sha256sums_was "$tag"
	fi
	note verified_signature_cosign "$tag"
}

release_has() {
	awk -v f="$1" '$2 == f || $2 == "*" f { found = 1 } END { exit !found }' "$REL/SHA256SUMS"
}

# release_file NAME: download NAME of the fetched release into $REL and
# check it against the signed SHA256SUMS.
release_file() {
	want=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1; exit }' "$REL/SHA256SUMS")
	[ -n "$want" ] || die not_listed_in_releases_sha256sums "$1"
	fetch "$RELEASES_URL/download/$tag/$1" "$REL/$1" || die cannot_download "$1"
	[ "$(sha_of "$REL/$1")" = "$want" ] || die sha_256_mismatch_for "$1"
}

# get_binary TAG -> $REL/akari (verified, runs, right version).
get_binary() {
	fetch_release "$1"
	release_file "akari-linux-$ARCH"
	install -m 0755 "$REL/akari-linux-$ARCH" "$REL/akari"
	v=$("$REL/akari" --version 2>/dev/null || true)
	case "$v" in
	"akari ${1#v} "* | "akari ${1#v}") ;;
	*) die downloaded_binary_reports_expected "$v" "${1#v}" ;;
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
	*) die image_reference_does_not_match_release "$IMAGE" ;;
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
		tar -xzf "$REL/akari-deploy.tar.gz" -C "$BUNDLE" || die cannot_unpack_deploy_bundle
		return
	fi
	src=${AKARI_SOURCE_DIR:-$SELF_DIR}
	if [ -n "$src" ] && [ -f "$src/deploy/docker-compose.yml" ] && [ -f "$src/scripts/backup.sh" ]; then
		note deploy_files_from_source_tree "$src"
		cp -R "$src/deploy" "$BUNDLE/deploy"
		mkdir -p "$BUNDLE/scripts"
		cp "$src/scripts/backup.sh" "$src/scripts/restore.sh" "$src/scripts/install.sh" "$BUNDLE/scripts/"
		return
	fi
	if [ "$INSTALLER_VERSION" != '@@AKARI_INSTALLER_VERSION@@' ]; then
		saved_rel=$REL saved_tag=$tag
		fetch_release "$INSTALLER_VERSION"
		release_has akari-deploy.tar.gz || die no_deploy_bundle_available
		release_file akari-deploy.tar.gz
		tar -xzf "$REL/akari-deploy.tar.gz" -C "$BUNDLE" || die cannot_unpack_deploy_bundle
		REL=$saved_rel tag=$saved_tag
		return
	fi
	die no_deploy_bundle_set_akari_source
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
VERSION_REQ='' DOCKER_DIR='' LOCAL_CERTS='' RESTORE_DIR='' AGE_IDENTITY='' AGE_RECIPIENT_OPT='' VERIFY_KEY=''
BACKUP_SH='' WITH_RELEASES='' NODE_ADDR='' PURGE=0 MIGRATE_TO='' BACKUP_OUT='' FORCE=0 CONFIRM_PURGE='' VALKEY_PORT=''

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
	BACKUP_SIGN_KEY=$(kv_get "$STATE_ENV" BACKUP_SIGN_KEY)
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
		echo "UI_LANG=$UI_LANG"
		echo "LOCAL_CERTS=$LOCAL_CERTS"
		echo "DOCKER_DIR=$DOCKER_DIR"
		echo "PG_PORT=${PG_PORT:-}"
		echo "VALKEY_PORT=${VALKEY_PORT:-}"
		echo "CADDY_OURS=${CADDY_OURS:-}"
		echo "# Backups: an age public key (age1...) encrypts them; empty = plain files (0600)."
		echo "AGE_RECIPIENT=${AGE_RECIPIENT:-}"
		echo "# Backups: path of the EC (prime256v1) PEM private key every backup is signed with (made by the installer; docs/BACKUP.md, Authenticity)."
		echo "BACKUP_SIGN_KEY=${BACKUP_SIGN_KEY:-}"
	} >"$STATE_ENV"
}

# --- backup signing key -----------------------------------------------------------------

# ensure_backup_key: every backup is signed (docs/BACKUP.md, Authenticity).
# The key is an EC prime256v1 key made once by the installer, root-only
# (0600) in $ETC next to install.env, kept out of the backups themselves.
# openssl writes it straight to the file: it is never on a command line
# or in the log. A path set in install.env that cannot be read is an error
# (a new key would silently change who the backups are signed by).
ensure_backup_key() {
	if [ -n "${BACKUP_SIGN_KEY:-}" ]; then
		[ -r "$BACKUP_SIGN_KEY" ] ||
			die backup_signing_key_backup_sign_key "$BACKUP_SIGN_KEY"
		return 0
	fi
	have openssl || {
		[ "$APT_UPDATED" = 1 ] || apt_update
		apt_install openssl
	}
	key=$ETC/backup-sign.pem
	if [ ! -s "$key" ]; then
		install -d -m 0750 "$ETC"
		(
			umask 077
			openssl ecparam -name prime256v1 -genkey -noout -out "$key.new" 2>>"$LOG"
		) || die cannot_generate_backup_signing_key
		chmod 0600 "$key.new"
		mv -f "$key.new" "$key"
		note generated_backup_signing_key_root_only "$key"
	fi
	BACKUP_SIGN_KEY=$key
	# The public half, for a restore on another host (not secret).
	openssl ec -in "$key" -pubout -out "$ETC/backup-sign.pub" 2>/dev/null && chmod 0644 "$ETC/backup-sign.pub"
}

# backup_public_key: the verification key (PEM) matching BACKUP_SIGN_KEY.
backup_public_key() {
	[ -n "${BACKUP_SIGN_KEY:-}" ] && [ -r "$BACKUP_SIGN_KEY" ] || return 0
	openssl ec -in "$BACKUP_SIGN_KEY" -pubout 2>/dev/null
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
		note adopting_existing_docker_compose_deployment_in "$ADOPT_DIR"
		MODE=docker DOCKER_DIR=$ADOPT_DIR
		DOMAIN=$(kv_get "$DOCKER_DIR/.env" AKARI_DOMAIN)
		img=$(kv_get "$DOCKER_DIR/.env" AKARI_IMAGE)
		CUR_VERSION=v$(printf '%s' "$img" | sed -n 's/.*:\([0-9][^@]*\)@.*/\1/p')
		HTTP_PORT=80 HTTPS_PORT=443 GRPC_PORT=8443
		case "$(kv_get "$DOCKER_DIR/.env" AKARI_CADDY_OPTIONS)" in *local_certs*) LOCAL_CERTS=1 ;; esac
		save_state
		return
	fi
	die found_hand_made_bare_metal_panel "$BIN"
}

# --- bare metal: components ------------------------------------------------------

PG_PORT=

install_postgres() {
	step installing_postgresql_18_pgdg_repository
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
		run pg_createcluster 18 main || die cannot_create_postgresql_18_cluster
		PG_PORT=$(pg_lsclusters -h | awk '$1 == "18" && $2 == "main" { print $3; exit }')
	fi
	run systemctl enable --now postgresql@18-main || run pg_ctlcluster 18 main start ||
		die postgresql_18_does_not_start
	i=0
	until (cd / && runuser -u postgres -- pg_isready -q -p "$PG_PORT"); do
		i=$((i + 1))
		[ "$i" -lt 30 ] || die postgresql_18_not_ready
		sleep 1
	done
	note postgresql_18_on_127_0_0 "$PG_PORT"
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
		die cannot_create_database_role_database
}

install_valkey() {
	step installing_valkey_upstream_build_pinned_sha "$VALKEY_VERSION"
	dir="$VALKEY_ROOT/valkey-$VALKEY_VERSION"
	if [ ! -x "$dir/bin/valkey-server" ]; then
		f="valkey-$VALKEY_VERSION-$VALKEY_FLAVOR-$UARCH.tar.gz"
		case "$VALKEY_FLAVOR-$UARCH" in
		noble-x86_64) want=$VALKEY_SHA_noble_x86_64 ;;
		noble-arm64) want=$VALKEY_SHA_noble_arm64 ;;
		jammy-x86_64) want=$VALKEY_SHA_jammy_x86_64 ;;
		*) want=$VALKEY_SHA_jammy_arm64 ;;
		esac
		fetch "https://download.valkey.io/releases/$f" "$TMP/$f" || die cannot_download_valkey
		[ "$(sha_of "$TMP/$f")" = "$want" ] || die sha_256_mismatch_for_valkey
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
		die valkey_does_not_run_on_this
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

# install_caddy: a Caddy already on the host (e.g. the Debian package) is
# used as it is; otherwise the pinned release binary goes to /usr/bin/caddy
# with the user, directory and unit of Caddy's own package.
install_caddy() {
	if have caddy; then
		step caddy_already_installed_using_it
	else
		step installing_caddy_upstream_build_pinned_sha "$CADDY_VERSION"
		f="caddy_${CADDY_VERSION}_linux_$ARCH.tar.gz"
		case "$ARCH" in
		amd64) want=$CADDY_SHA_amd64 ;;
		*) want=$CADDY_SHA_arm64 ;;
		esac
		fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/$f" "$TMP/$f" ||
			die cannot_download_caddy
		[ "$(sha_of "$TMP/$f")" = "$want" ] || die sha_256_mismatch_for_caddy
		mkdir -p "$TMP/caddy"
		tar -xzf "$TMP/$f" -C "$TMP/caddy" caddy || die cannot_unpack_caddy
		install -m 0755 -o root -g root "$TMP/caddy/caddy" /usr/bin/caddy
		getent group caddy >/dev/null || run groupadd --system caddy || die cannot_create_caddy_group
		getent passwd caddy >/dev/null || run useradd --system --gid caddy --create-home --home-dir /var/lib/caddy \
			--shell /usr/sbin/nologin --comment 'Caddy web server' caddy || die cannot_create_caddy_user
		install -d -m 0755 /etc/caddy
		cat >"$TMP/caddy.service" <<'UNIT'
# Written by the Akari installer: the unit of Caddy's Debian package
# (caddyserver/dist init/caddy.service) for the release binary.
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
		install -m 0644 "$TMP/caddy.service" /etc/systemd/system/caddy.service
		run systemctl daemon-reload
		# Remembered beside Caddy's config (install.env goes with a plain
		# uninstall): uninstalling stops a Caddy that came with the panel,
		# and restarts one that served something before; source=release
		# = our binary and unit, which --purge removes.
		echo 'source=release' >/etc/caddy/.installed-by-akari
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

# configure_caddy PREFIX (bare metal): our Caddyfile, the environment in a
# root-only file, and a drop-in that starts Caddy without --environ (it
# would print the environment into the journal) and with the admin API off
# (it would serve the configuration to local users).
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
		# Only the Caddyfile of releases before v0.4 D4/D11 (which forwarded
		# just the prefix) reads it; the current one forwards everything.
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
# AKARI_DOMAIN / AKARI_PREFIX (secret; older releases) / upstream / ask endpoint for
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
		die caddy_configuration_does_not_validate_see
	run systemctl enable caddy.service
	run systemctl restart caddy.service || die caddy_does_not_start_journalctl_u
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
	run systemd-sysusers /usr/lib/sysusers.d/akari.conf || die cannot_create_akari_user
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

# The admin prefix (v0.4 D4: kept in the database; `akari info` falls back
# to data/state.json, which the first start imports, before that).
prefix_bare() {
	akari_cli info 2>/dev/null | sed -n -e 's|^admin prefix: *\/||p' -e 's|^route prefix: *\/||p'
}

# --- health checks ------------------------------------------------------------------

# wait_health URL SECONDS: 200 from /<prefix>/healthz (served under the
# admin prefix by every version; v0.4 also answers /healthz). Polls every
# second and returns the moment it answers; on bare metal it gives up at once
# when systemd has marked the panel unit failed (a crash loop that hit its
# start limit) instead of waiting out the budget.
wait_health() {
	i=0
	while [ "$i" -lt "$2" ]; do
		[ "$(http_status "$1")" = 200 ] && return 0
		if [ "$MODE" = bare ] && systemctl is-failed --quiet akari-panel.service 2>/dev/null; then
			return 1
		fi
		sleep 1
		i=$((i + 1))
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

# check_proxy PREFIX: healthz through Caddy (TLS, the public path). Returns
# as soon as it answers. Without a domain (IP only) the certificate comes from
# Caddy's internal CA and nothing waits on DNS or the ACME order, so a short
# budget is enough; on bare metal a Caddy that is not running fails at once.
check_proxy() {
	url="$(origin)/$1/healthz"
	budget=60
	[ -n "$DOMAIN" ] || budget=15
	i=0
	while [ "$i" -lt "$budget" ]; do
		if [ "$MODE" = bare ] && ! systemctl is-active --quiet caddy.service 2>/dev/null; then
			return 1
		fi
		# Through this host's Caddy whatever DNS says (NAT, DNS not yet set).
		[ "$(http_status "$url" "::127.0.0.1:")" = 200 ] && return 0
		sleep 1
		i=$((i + 1))
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
		step docker_present "$(docker --version 2>/dev/null)"
		return
	fi
	step installing_docker_engine_compose_v2_docker
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
	docker info >/dev/null 2>&1 || die docker_does_not_start
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
	run dc pull panel || die cannot_pull_see_log "$IMAGE"
	pull_infra
}

pull_infra() {
	for svc in postgres valkey caddy; do
		run dc pull "$svc" && continue
		img=$(dc config --images "$svc" 2>/dev/null | sed -n 1p)
		docker image inspect "$img" >/dev/null 2>&1 || die cannot_pull_see_log "$img"
		warn could_not_pull_using_local_copy "$img"
	done
}

docker_prefix() {
	dc run --rm --no-deps -T panel info 2>/dev/null | sed -n -e 's|^admin prefix: *\/||p' -e 's|^route prefix: *\/||p'
}

# Over TCP, not the Unix socket: on a fresh volume the image's entrypoint runs
# initdb behind a temporary server that listens only on the socket, then
# restarts it; a socket probe passes during that window and the restore that
# follows hits "the database system is starting up".
wait_docker_pg() {
	i=0
	until dc exec -T postgres pg_isready -q -h 127.0.0.1 -U akari -d akari >/dev/null 2>&1; do
		i=$((i + 1))
		[ "$i" -lt 60 ] || die postgresql_container_not_ready
		sleep 1
	done
}

# --- backup / restore ---------------------------------------------------------------

# do_backup OUT_PARENT PLAIN(0|1) [RELEASES(0|1)]: one backup directory via
# backup.sh; sets BACKUP_PATH. PLAIN=1 forces plain files (migration on
# this host, deleted afterwards). RELEASES=1 keeps the agent release
# binaries stored in the database (default: left out, docs/BACKUP.md).
BACKUP_PATH=
do_backup() {
	parent=$1 plain=$2 releases=${3:-0}
	install -d -m 0700 "$parent"
	ensure_backup_key
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
		[ "$plain" = 1 ] || warn backup_not_encrypted_plain_files_0600 "$STATE_ENV"
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
	out=$(env "$recip_env" "$plain_env" AKARI_BACKUP_SIGN_KEY="$BACKUP_SIGN_KEY" AKARI_BACKUP_AGENT_RELEASES="$releases" AKARI_PG_DUMP_CMD="$dump_cmd" AKARI_DATA_DIR="$data_dir" \
		AKARI_BACKUP_DIR="$parent" AKARI_CONFIG_FILES="$config_files" AKARI_VERSION_STRING="$ver" \
		AKARI_MANIFEST_EXTRA="mode=$MODE" bash "${BACKUP_SH:-$LIBDIR/backup.sh}" 2>>"$LOG") ||
		die backup_failed_see "$LOG"
	printf '%s\n' "$out" >>"$LOG"
	BACKUP_PATH=$(printf '%s\n' "$out" | sed -n 's/^backup: done: \(.*\) (.*)$/\1/p' | tail -n 1)
	[ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ] || die backup_failed
}

# check_restore_dir DIR: a backup.sh directory, readable with what we have.
check_restore_dir() {
	[ -d "$1" ] || die no_such_backup_directory "$1"
	if [ -n "$VERIFY_KEY" ]; then
		have openssl || die verifying_signature_needs_openssl
		[ -r "$VERIFY_KEY" ] || die cannot_read "$VERIFY_KEY"
		[ -f "$1/SHA256SUMS.sig" ] || die backup_has_no_sha256sums_sig_but
		openssl dgst -sha256 -verify "$VERIFY_KEY" -signature "$1/SHA256SUMS.sig" "$1/SHA256SUMS" >/dev/null 2>&1 ||
			die backup_signature_mismatch_sha256sums_was_not
	elif [ -z "$MIGRATE_TO" ]; then
		warn no_backup_verify_key_this_backup
	fi
	(cd "$1" && sha256sum --check --quiet SHA256SUMS >/dev/null 2>&1) ||
		die backup_checksum_mismatch_damaged_or_modified "$1"
	if [ -f "$1/db.dump.age" ]; then
		[ -n "$AGE_IDENTITY" ] || die backup_encrypted_pass_age_identity_key
		have age || {
			[ "$APT_UPDATED" = 1 ] || apt_update
			apt_install age
		}
	fi
}

# restore_into: database + data dir from $RESTORE_DIR into this
# installation. The database is recreated empty first (a database kept
# from an earlier install of this mode, e.g. a move back, is replaced):
# pg_restore --clean cannot drop the partitions of a partitioned table
# (traffic_daily, migration 1033). The data dir is moved aside.
restore_into() {
	step restoring_from_backup "$RESTORE_DIR"
	recreate_db='DROP DATABASE IF EXISTS akari WITH (FORCE);
CREATE DATABASE akari OWNER akari;'
	if [ "$MODE" = bare ]; then
		printf '%s\n' "$recreate_db" | psql_pg -d postgres -f - >>"$LOG" 2>&1 ||
			die cannot_recreate_database_akari
		load_cmd="cd / && runuser -u postgres -- pg_restore -p $PG_PORT -d akari --no-owner --role=akari --exit-on-error --single-transaction"
		data_dir=$DATA owner=akari:akari
	else
		printf '%s\n' "$recreate_db" | dc exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U akari -d postgres -f - >>"$LOG" 2>&1 ||
			die cannot_recreate_database_akari
		load_cmd="cd '$DOCKER_DIR' && docker compose exec -T postgres pg_restore -U akari -d akari --no-owner --exit-on-error --single-transaction"
		data_dir=$(docker_volume_dir akari-data) owner=65532:65532
		[ -n "$data_dir" ] || die no_akari_akari_data_volume
	fi
	run env AGE_IDENTITY_FILE="${AGE_IDENTITY:-}" AKARI_BACKUP_VERIFY_KEY="${VERIFY_KEY:-}" AKARI_PG_RESTORE_CMD="$load_cmd" AKARI_DATA_DIR="$data_dir" \
		AKARI_OWNER="$owner" bash "$LIBDIR/restore.sh" --force "$RESTORE_DIR" ||
		die restore_failed_see "$LOG"
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
		die database_from_v0_3_x_fresh
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
		note admin_account_exists_not_creating_one
		return
	fi
	[ -n "$ADMIN_PW" ] || ADMIN_PW=$(rand_pw 20)
	note creating_admin_account "$ADMIN"
	if [ "$MODE" = bare ]; then
		(
			# shellcheck disable=SC2030 # exported to the CLI only
			AKARI_ADMIN_PASSWORD=$ADMIN_PW
			export AKARI_ADMIN_PASSWORD
			run_q akari_cli admin add "$ADMIN"
		) || die cannot_create_admin_account_see_log
	else
		(
			# shellcheck disable=SC2030 # exported to the CLI only
			AKARI_ADMIN_PASSWORD=$ADMIN_PW
			export AKARI_ADMIN_PASSWORD
			run_q dc exec -T -e AKARI_ADMIN_PASSWORD panel /akari admin add "$ADMIN"
		) || die cannot_create_admin_account_see_log
	fi
	ADMIN_CREATED=1
}

# apply_settings: main domain and node address on a fresh database.
apply_settings() {
	if ! panel_cli settings --help 2>/dev/null | matches '^ *set '; then
		note this_release_has_no_settings_command
		return
	fi
	if [ -n "$DOMAIN" ]; then
		run panel_cli settings set main "$DOMAIN" || warn could_not_set_main_domain_set
	fi
	node=${NODE_ADDR:-${DOMAIN:-$PUBLIC_IP}}
	if [ -n "$node" ]; then
		# A port only where none is given; a bare IPv6 address takes brackets.
		[ "$GRPC_PORT" = 8443 ] || case "$node" in
		\[*\]:*) ;;
		\[*\]) node="$node:$GRPC_PORT" ;;
		*:*:*) node="[$node]:$GRPC_PORT" ;;
		*:*) ;;
		*) node="$node:$GRPC_PORT" ;;
		esac
		run panel_cli settings set node "$node" || warn could_not_set_node_address_set
	fi
}

# --- install -------------------------------------------------------------------------

gather_input() {
	MODE=${MODE:-docker}
	if [ "$INTERACTIVE" = 1 ] && [ -z "${MODE_GIVEN:-}" ]; then
		if [ "$MODE" = bare ]; then d=2; else d=1; fi
		menu MODE install_mode "$d" docker=install_mode_docker bare=install_mode_bare
	fi
	case "$MODE" in bare | docker) ;; *) die mode_must_be_bare_or_docker ;; esac

	[ -n "$PUBLIC_IP" ] || PUBLIC_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | sed -n 1p)
	if [ -z "${DOMAIN_GIVEN:-}" ]; then
		ask_valid DOMAIN main_domain_dns_pointing_here_empty "$DOMAIN" ok_domain invalid_domain
	fi
	DOMAIN=$(norm_domain "$DOMAIN")
	if [ -z "$DOMAIN" ]; then
		ask_valid PUBLIC_IP public_ip_this_machine "$PUBLIC_IP" valid_ip invalid_ip
		[ -n "$PUBLIC_IP" ] || die cannot_determine_public_ip_pass_ip
	elif [ -z "${EMAIL_GIVEN:-}" ]; then
		ask_valid EMAIL e_mail_for_certificate_notices_optional "$EMAIL" ok_email_opt invalid_e_mail
	fi
	if [ -z "${ADMIN_GIVEN:-}" ]; then
		ask_valid ADMIN admin_e_mail_login_name "${ADMIN:-$(default_admin)}" ok_admin invalid_admin_e_mail
	fi
	ADMIN=$(lower "${ADMIN:-$(default_admin)}")
	if [ -z "$ADMIN_PW" ]; then
		ask_secret ADMIN_PW admin_password_empty_generate_one
		while [ "$INTERACTIVE" = 1 ] && [ -n "$ADMIN_PW" ] && [ "${#ADMIN_PW}" -lt 8 ]; do
			ui_ask_error "$(msg admin_password_needs_at_least_8)"
			ADMIN_PW=''
			ask_secret ADMIN_PW admin_password_empty_generate_one
		done
	fi
	if [ -n "$ADMIN_PW" ] && [ "${#ADMIN_PW}" -lt 8 ]; then
		die admin_password_needs_at_least_8
	fi
	HTTP_PORT=${HTTP_PORT:-80} HTTPS_PORT=${HTTPS_PORT:-443} GRPC_PORT=${GRPC_PORT:-8443}
	if [ -z "${PORTS_GIVEN:-}" ] && confirm customize_ports_default_80_443_8443 n; then
		ask_valid HTTP_PORT http_port "$HTTP_PORT" ok_port invalid_port
		ask_valid HTTPS_PORT https_port "$HTTPS_PORT" ok_port invalid_port
		ask_valid GRPC_PORT node_grpc_port "$GRPC_PORT" ok_port invalid_port
	fi
	for p in "$HTTP_PORT" "$HTTPS_PORT" "$GRPC_PORT"; do
		ok_port "$p" || die invalid_port "$p"
	done
	# These end up in config files: plain names only.
	[ -z "$DOMAIN" ] || valid_domain "$DOMAIN" || die invalid_domain "$DOMAIN"
	[ -z "$PUBLIC_IP" ] || valid_ip "$PUBLIC_IP" || die invalid_ip "$PUBLIC_IP"
	[ -z "$EMAIL" ] || valid_email "$EMAIL" || die invalid_e_mail "$EMAIL"
	valid_admin "$ADMIN" || die invalid_admin_e_mail "$ADMIN"
	NODE_ADDR=$(lower "$NODE_ADDR")
	[ -z "$NODE_ADDR" ] || valid_node_addr "$NODE_ADDR" || die invalid_node_address_host_name_ipv4 "$NODE_ADDR"
	# A restore keeps the backup's node address.
	[ -n "$RESTORE_DIR" ] || check_node_addr
	if [ "$MODE" = docker ] && [ -z "$DOCKER_DIR" ]; then DOCKER_DIR=$DEFAULT_DOCKER_DIR; fi
	VALKEY_PORT=${VALKEY_PORT:-6379}

	if [ "$MODE" = bare ]; then m=$(msg bare_metal_systemd); else m='Docker Compose'; fi
	if [ -n "$DOMAIN" ]; then addr=$DOMAIN; else addr="$PUBLIC_IP $(msg ip_only_self_signed_certificate)"; fi
	card_open about_install
	card_blank
	card_row lbl_mode "$m"
	card_row lbl_version "$TAG"
	card_row lbl_address "$addr"
	card_row lbl_admin "$ADMIN"
	card_row lbl_ports "$HTTP_PORT / $HTTPS_PORT / $GRPC_PORT"
	[ -n "$RESTORE_DIR" ] || card_row lbl_node "${NODE_ADDR:-${DOMAIN:-$PUBLIC_IP}}"
	[ -z "$RESTORE_DIR" ] || card_row lbl_restore "$RESTORE_DIR"
	card_blank
	card_close
	if ! confirm continue y; then
		die cancelled
	fi
}

# install_total MODE RESTORE_DIR: the numbered steps of an installation.
install_total() {
	if [ "$1" = bare ]; then _n=7; else _n=6; fi
	[ -z "$2" ] || _n=$((_n + 1))
	echo "$_n"
}

cmd_install() {
	if detect_existing && [ "$STATUS" = installing ]; then
		# An earlier run stopped half way: run the installation again
		# (every step is idempotent); our own services may hold the ports.
		say resuming_unfinished_installation "$MODE"
		stop_mode "$MODE" 2>/dev/null || true
	elif [ "$FORCE" != 1 ] && detect_existing; then
		if [ -n "${ADOPT_DIR:-}${ADOPT_BARE:-}" ]; then
			say found_existing_installation
		else
			say already_installed "$MODE" "$CUR_VERSION"
		fi
		if confirm upgrade_it_instead y; then
			cmd_upgrade
			return
		fi
		die already_installed_use_akari_ctl_upgrade
	fi
	check_ram
	base_packages
	TAG=$(resolve_tag "$VERSION_REQ")
	gather_input
	[ "$MODE" != bare ] || check_systemd
	[ -z "$RESTORE_DIR" ] || check_restore_dir "$RESTORE_DIR"
	check_ports "$HTTP_PORT" "$HTTPS_PORT" "$GRPC_PORT"
	steps "$(install_total "$MODE" "$RESTORE_DIR")"
	if [ "$MODE" = bare ]; then
		check_ports "$WEB_PORT" "$ASK_PORT" "$VALKEY_PORT"
		install_bare
	else
		install_docker_mode
	fi
}

install_bare() {
	step downloading_and_verifying_akari "$TAG" "$ARCH"
	get_binary "$TAG"
	get_bundle
	install_tools
	install_postgres
	install_valkey
	install_caddy
	step configuring_services
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
	run systemctl enable --now akari-valkey.service || die valkey_does_not_start_journalctl_u

	install -m 0755 "$REL/akari" "$BIN.new"
	mv -f "$BIN.new" "$BIN"
	ensure_backup_key
	CUR_VERSION=$TAG STATUS=installing
	save_state

	if [ -n "$RESTORE_DIR" ]; then
		restore_into
	fi
	# A database kept from a v0.3.x install, or a v0.3.x backup just restored.
	refuse_pre_baseline
	run akari_cli config check || die configuration_check_failed_akari_config_check
	prefix=$(prefix_bare)
	[ -n "$prefix" ] || die cannot_read_admin_prefix

	step starting_panel
	run systemctl enable akari-panel.service
	run systemctl restart akari-panel.service
	wait_health "$(panel_health_url "$prefix")" 120 ||
		die panel_did_not_become_healthy_journalctl
	step admin_account_and_https
	[ -n "$RESTORE_DIR" ] || apply_settings
	create_admin
	configure_caddy "$prefix"
	open_firewall
	finish "$prefix"
}

install_docker_mode() {
	install_docker
	step fetching_and_verifying_image_reference "$TAG"
	get_image "$TAG"
	step writing_deployment_files
	get_bundle
	install_tools
	write_docker_files
	ensure_backup_key
	CUR_VERSION=$TAG STATUS=installing
	save_state
	step pulling "$IMAGE"
	pull_images
	run dc run --rm --no-deps -T panel config check || die configuration_check_failed_see_log
	if [ -n "$RESTORE_DIR" ]; then
		run dc up --no-start
		run dc up -d postgres valkey
		wait_docker_pg
		restore_into
		refuse_pre_baseline
	fi
	prefix=$(docker_prefix)
	[ -n "$prefix" ] || die cannot_read_admin_prefix
	# Read only by the compose file of releases before v0.4 D4/D11.
	kv_set "$DOCKER_DIR/.env" AKARI_PREFIX "$prefix"
	step starting_containers
	run dc up -d || die docker_compose_up_failed_see_log
	wait_health "$(panel_health_url "$prefix")" 180 ||
		die panel_did_not_become_healthy_docker
	step admin_account
	[ -n "$RESTORE_DIR" ] || apply_settings
	create_admin
	finish "$prefix"
}

open_firewall() {
	if have ufw && LC_ALL=C ufw status 2>/dev/null | matches '^Status: active'; then
		for p in "$HTTP_PORT/tcp" "$HTTPS_PORT/tcp" "$GRPC_PORT/tcp"; do
			run ufw allow "$p" || true
		done
		note firewall_ufw_allowed "$HTTP_PORT" "$HTTPS_PORT" "$GRPC_PORT"
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
	ctl=akari-ctl
	[ -z "${SUDO_USER:-}" ] || ctl="sudo akari-ctl"
	card_open installation_complete
	card_blank
	card_row lbl_console "$o/$prefix/app"
	card_row lbl_portal "$o/"
	if [ "$ADMIN_CREATED" = 1 ]; then
		card_row lbl_admin_login "$ADMIN"
		card_row lbl_password "$ADMIN_PW"
		card_text shown_only_this_once_save_it
	fi
	card_blank
	card_text admin_prefix_secret_only_those_who
	card_blank
	card_text next_steps
	card_text next_log_in_settings
	card_text next_add_node
	card_text next_backup "$ctl" "$STATE_ENV" "$ctl" "$ctl"
	card_text next_signed_backups "$ctl"
	card_blank
	card_close
	[ "$proxy_ok" = 1 ] || warn https_check_through_caddy_did_not "$HTTP_PORT" "$HTTPS_PORT"
	[ -n "$DOMAIN" ] || note ip_only_certificate_comes_from_caddy
	say install_log "$LOG"
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
	note running_upgrade_with_installer "$1"
	step_end
	cp "$BUNDLE/scripts/install.sh" "$TMP/next-install.sh"
	sed -i "s/^INSTALLER_VERSION='@@AKARI_INSTALLER_VERSION@@'/INSTALLER_VERSION='$1'/" "$TMP/next-install.sh"
	set -- upgrade --version "$1"
	[ "$FORCE" != 1 ] || set -- "$@" --force
	set -- "$@" --lang "$UI_LANG"
	AKARI_NO_BANNER=1 AKARI_NO_REEXEC=1 sh "$TMP/next-install.sh" "$@"
	exit $?
}

cmd_upgrade() {
	if [ -z "$MODE" ]; then
		detect_existing || die no_installation_found_install_first
		[ -n "$MODE" ] || adopt
	fi
	[ "$MODE" != bare ] || check_systemd
	refuse_pre_baseline
	base_packages
	TAG=$(resolve_tag "$VERSION_REQ")
	if [ "$TAG" = "$CUR_VERSION" ] && [ "$FORCE" != 1 ]; then
		ok already_at_nothing_do_force_reinstalls "$TAG"
		return 0
	fi
	steps 3
	if [ "$MODE" = bare ]; then
		step downloading_and_verifying_akari_2 "$TAG"
		get_binary "$TAG"
	else
		step fetching_and_verifying_image_reference "$TAG"
		get_image "$TAG"
	fi
	maybe_reexec "$TAG"
	get_bundle
	# akari-ctl and the backup scripts of the new release are installed only
	# once it runs (a failed upgrade keeps the old tools).
	BACKUP_SH="$BUNDLE/scripts/backup.sh"

	step backup_before_upgrade
	do_backup "$BACKUP_ROOT" 0
	note backup "$BACKUP_PATH"
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

# The admin prefix from the running panel (rotations happen in its
# database), else from a one-off container.
docker_prefix_env() {
	p=$(dc exec -T panel /akari info 2>/dev/null | sed -n -e 's|^admin prefix: *\/||p' -e 's|^route prefix: *\/||p')
	[ -n "$p" ] || p=$(docker_prefix)
	printf '%s' "$p"
}

upgrade_failed() {
	mig_after=$(migration_version | tr -dc 0-9)
	if [ "${mig_after:-0}" != "${mig_before:-0}" ]; then
		warn new_release_migrated_database_migrations_are "$mig_before" "$mig_after" "$BACKUP_PATH"
	fi
}

upgrade_bare() {
	prefix=$(prefix_bare)
	step switching "$TAG"
	# Previous binary kept as akari.prev (hard link: the rename below keeps
	# it intact); the new one lands with an atomic rename.
	rm -f "$BIN.prev"
	ln "$BIN" "$BIN.prev"
	install -m 0755 "$REL/akari" "$BIN.new"
	refresh_bare_files
	run akari_cli_new config check || {
		rm -f "$BIN.new"
		die new_release_rejects_configuration_not_switched
	}
	mv -f "$BIN.new" "$BIN"
	run systemctl restart akari-panel.service || true
	if wait_health "$(panel_health_url "$prefix")" 120; then
		CUR_VERSION=$TAG
		save_state
		install_tools
		run systemctl restart caddy.service || true
		ok upgraded_health_check_passed "$TAG"
		note previous_binary_kept_as_prev_pre "$BIN" "$BACKUP_PATH"
		return 0
	fi
	warn failed_health_check_rolling_back_previous "$TAG"
	journalctl -u akari-panel.service -n 20 --no-pager -o cat >>"$LOG" 2>&1 || true
	mv -f "$BIN.prev" "$BIN"
	ln "$BIN" "$BIN.prev" 2>/dev/null || true
	run systemctl restart akari-panel.service || true
	if wait_health "$(panel_health_url "$prefix")" 120; then
		upgrade_failed
		die upgrade_failed_rolled_back_panel_healthy "$CUR_VERSION"
	fi
	upgrade_failed
	die upgrade_failed_and_rolled_back_panel "$BACKUP_PATH"
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
	step switching "$IMAGE"
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
		die cannot_pull_new_image_not_switched
	fi
	pull_infra
	run dc up -d --force-recreate panel caddy || true
	if wait_health "$(panel_health_url "$prefix")" 180; then
		CUR_VERSION=$TAG
		save_state
		install_tools
		ok upgraded_health_check_passed "$TAG"
		note pre_upgrade_backup "$BACKUP_PATH"
		return 0
	fi
	warn failed_health_check_rolling_back "$TAG" "$old_image"
	dc logs --no-color --tail 30 panel >>"$LOG" 2>&1 || true
	kv_set "$DOCKER_DIR/.env" AKARI_IMAGE "$old_image"
	install -m 0644 "$TMP/compose.prev" "$DOCKER_DIR/docker-compose.yml"
	install -m 0644 "$TMP/Caddyfile.prev" "$DOCKER_DIR/caddy/Caddyfile"
	run dc up -d --force-recreate panel caddy || true
	if wait_health "$(panel_health_url "$prefix")" 180; then
		upgrade_failed
		die upgrade_failed_rolled_back_panel_healthy_2 "$old_image"
	fi
	upgrade_failed
	die upgrade_failed_and_rolled_back_panel "$BACKUP_PATH"
}

# --- uninstall ----------------------------------------------------------------------------

cmd_uninstall() {
	detect_existing || die no_installation_found
	[ -n "$MODE" ] || adopt
	if [ "$PURGE" = 1 ]; then
		warn purge_permanently_deletes_database_data_dir
		if [ "$INTERACTIVE" = 1 ] && [ -z "$CONFIRM_PURGE" ]; then
			ask CONFIRM_PURGE type_purge_confirm ''
		fi
		[ "$CONFIRM_PURGE" = purge ] || die not_confirmed_nothing_removed_non_interactive
	elif ! confirm remove_panel_services_data_and_configuration y; then
		die cancelled
	fi
	steps 0
	if [ "$MODE" = bare ]; then uninstall_bare; else uninstall_docker; fi
	step_end
	rm -f "$CTL"
	if [ "$PURGE" = 1 ]; then
		rm -rf "$ETC" "$LIBDIR"
		ok purged_backups_kept_in "$BACKUP_ROOT"
	else
		rm -f "$STATE_ENV"
		if [ "$MODE" = bare ]; then kept="$DATA, $ETC, PostgreSQL database akari"; else kept="$DOCKER_DIR, docker volumes akari_*"; fi
		ok services_removed_kept "$kept"
	fi
}

uninstall_bare() {
	step stopping_and_removing_panel_services
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
				warn could_not_drop_database
		fi
		rm -rf "$DATA" "$VALKEY_ROOT"
		rm -f /usr/lib/sysusers.d/akari.conf
		run userdel akari || true
		if grep -qs '^source=release' /etc/caddy/.installed-by-akari; then
			# Our release binary and unit; Caddy's data (/var/lib/caddy) stays.
			rm -f /usr/bin/caddy /etc/systemd/system/caddy.service /etc/caddy/.installed-by-akari
			run systemctl daemon-reload
		fi
		note packages_postgresql_18_and_apt_installed
	fi
}

uninstall_docker() {
	step stopping_and_removing_containers
	if [ "$PURGE" = 1 ]; then
		run dc down -v --remove-orphans || true
		rm -rf "$DOCKER_DIR"
	else
		run dc down --remove-orphans || true
	fi
}

# --- backup command ---------------------------------------------------------------------

cmd_backup() {
	detect_existing || die no_installation_found
	[ -n "$MODE" ] || adopt
	[ -x "$LIBDIR/backup.sh" ] || {
		get_bundle
		install_tools
	}
	out=${BACKUP_OUT:-$BACKUP_ROOT}
	[ -z "$AGE_RECIPIENT_OPT" ] || AGE_RECIPIENT=$AGE_RECIPIENT_OPT
	steps 0
	step backing_up_database_data_dir_and
	case "${WITH_RELEASES:-${AKARI_BACKUP_AGENT_RELEASES:-0}}" in 1) rel=1 ;; *) rel=0 ;; esac
	do_backup "$out" 0 "$rel"
	ok backup_written "$BACKUP_PATH"
	note moving_hosts_copy_this_directory_and
}

# --- migrate (same host) -----------------------------------------------------------------

cmd_migrate() {
	detect_existing || die no_installation_found
	[ -n "$MODE" ] || adopt
	case "$MIGRATE_TO" in bare | docker) ;; *) die pass_bare_or_docker ;; esac
	[ "$MIGRATE_TO" != "$MODE" ] || die already_in_mode "$MODE"
	check_systemd
	base_packages
	TAG=${CUR_VERSION:-$(resolve_tag "$VERSION_REQ")}
	[ -z "$VERSION_REQ" ] || TAG=$(resolve_tag "$VERSION_REQ")
	[ -x "$LIBDIR/backup.sh" ] || {
		fetch_release "$TAG"
		get_bundle
		install_tools
	}
	confirm move_panel_from_on_this_host y "$MODE" "$MIGRATE_TO" ||
		die cancelled

	steps $(($(install_total "$MIGRATE_TO" 1) + 2))
	step safety_backup_kept
	do_backup "$BACKUP_ROOT" 0
	safety=$BACKUP_PATH
	step dump_for_move_local_temporary_files
	do_backup "$TMP/migrate" 1 1
	move=$BACKUP_PATH

	from=$MODE
	stop_mode "$from"
	saved_domain=$DOMAIN saved_ip=$PUBLIC_IP saved_email=$EMAIL
	MODE=$MIGRATE_TO RESTORE_DIR=$move VERIFY_KEY='' AGE_IDENTITY=
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
		warn move_failed_bringing_services_back "$from"
		MODE=$MIGRATE_TO
		stop_mode "$MIGRATE_TO" || true
		MODE=$from
		start_mode "$from"
		load_state || true
		die move_failed_back_on_safety_backup "$from" "$safety"
	fi
	MODE=$MIGRATE_TO
	load_state || true
	retire_mode "$from"
	ok moved_now_safety_backup "$MIGRATE_TO" "$safety"
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
		note old_bare_metal_data_kept_postgresql "$DATA" "$ETC"
	else
		old=${OLD_DOCKER_DIR:-$DEFAULT_DOCKER_DIR}
		(cd "$old" && run docker compose down --remove-orphans) || true
		note old_docker_data_kept_volumes_akari "$old" "$old"
	fi
}

# --- status / info ------------------------------------------------------------------------

cmd_status() {
	detect_existing || die no_installation_found
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
	detect_existing || die no_installation_found
	[ -n "$MODE" ] || adopt
	if [ "$MODE" = bare ]; then prefix=$(prefix_bare); else prefix=$(docker_prefix_env); fi
	o=$(origin)
	printf '%s/%s/app\n%s/\n' "$o" "$prefix" "$o"
	pub=$(backup_public_key)
	if [ -n "$pub" ]; then
		printf '\n%s\n%s\n' "$(msg backup_verification_public_key_keep_it "$BACKUP_SIGN_KEY")" "$pub"
	fi
}

# --- arguments, main ---------------------------------------------------------------------

usage() {
	printf '%s%s%s\n\n' "$c_bold" "$(msg help_title)" "$c_reset"
	printf '%s\n\n' "$(msg help_usage)"
	printf '%s%s%s\n%s\n\n' "$c_accent" "$(msg help_options_heading)" "$c_reset" "$(msg help_options)"
	printf '%s%s%s\n%s\n' "$c_accent" "$(msg help_testing_heading)" "$c_reset" "$(msg help_testing)"
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
			[ -r "$2" ] || die cannot_read "$2"
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
		--backup-verify-key) VERIFY_KEY=$2 && shift ;;
		--age-recipient) AGE_RECIPIENT_OPT=$2 && shift ;;
		--with-agent-releases) WITH_RELEASES=1 ;;
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
		*) die unknown_option_help "$1" ;;
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

# prescan_lang ARGS...: --lang / AKARI_LANG before the arguments are parsed,
# so that --help and usage errors speak the right language.
prescan_lang() {
	_w=${AKARI_LANG:-}
	_prev=''
	for _a in "$@"; do
		[ "$_prev" != --lang ] || _w=$_a
		_prev=$_a
	done
	[ "$(ui_lang_name "$_w")" != en ] || UI_LANG=en
}

# resolve_lang: --lang, else AKARI_LANG, else the language recorded at
# install time, else Chinese (empty). Sets LANG_WANT.
LANG_WANT=''
resolve_lang() {
	LANG_WANT=$(ui_lang_name "${LANG_OPT:-${AKARI_LANG:-}}")
	[ -n "$LANG_WANT" ] || LANG_WANT=$(ui_lang_name "$(kv_get "$STATE_ENV" UI_LANG)")
	return 0
}

# become_root ARGS...: re-run as root through sudo. From a file: the same
# file; piped (curl | sh): download the installer again (same release).
become_root() {
	[ "$(id -u)" -ne 0 ] || return 0
	have sudo || die run_as_root_or_install_sudo
	keep='AKARI_MODE,AKARI_DOMAIN,AKARI_PUBLIC_IP,AKARI_EMAIL,AKARI_ADMIN,AKARI_ADMIN_PASSWORD,AKARI_NODE_ADDRESS,AKARI_VERSION,AKARI_DOCKER_DIR,AKARI_RELEASES_URL,AKARI_COSIGN_KEY,AKARI_SOURCE_DIR,AKARI_BACKUP_AGENT_RELEASES,AKARI_LANG,AKARI_NO_BANNER,LANG,LC_ALL,LC_MESSAGES'
	if [ -n "$SELF_FILE" ]; then
		exec sudo --preserve-env="$keep" sh "$SELF_FILE" "$@"
	fi
	if [ "$INSTALLER_VERSION" != '@@AKARI_INSTALLER_VERSION@@' ]; then
		url="$RELEASES_URL/download/$INSTALLER_VERSION/install.sh"
	else
		url="$RELEASES_URL/latest/download/install.sh"
	fi
	note re_running_through_sudo
	t=$(mktemp)
	fetch "$url" "$t" || die cannot_download_installer "$url"
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
	prescan_lang "$@"
	ui_init
	parse_args "$@"
	[ -z "$LANG_OPT" ] || [ -n "$(ui_lang_name "$LANG_OPT")" ] || die unknown_language "$LANG_OPT"
	become_root "$@"

	install -d -m 0755 "$(dirname "$LOG")"
	[ -f "$LOG" ] || install -m 0600 /dev/null "$LOG"
	chmod 0600 "$LOG"
	LOG_READY=1 UI_LOG=$LOG
	log "akari installer $INSTALLER_VERSION: $CMD (pid $$)"

	# First of all, before the banner: the language and its locale. LC_ALL
	# applies to this process and its children only (children that are parsed
	# run in the C locale, ui_bg); the system default locale is not touched.
	resolve_lang
	ui_locale_setup "$LANG_WANT"
	ui_init
	log "language: $UI_LANG, locale: ${LC_ALL:-unset}"
	if [ "$YES" != 1 ] && tty_ok; then INTERACTIVE=1; fi
	case "$CMD" in
	install | upgrade | uninstall | migrate | backup)
		_v=$INSTALLER_VERSION
		[ "$_v" != '@@AKARI_INSTALLER_VERSION@@' ] || _v=dev
		ui_banner "$(msg banner_subtitle "$_v")"
		;;
	esac

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
	step_end
}

# --- messages -------------------------------------------------------------------
# The two tables carry the same keys (scripts/installer-test/ui-check.py).

m() { printf '%s' "$1"; }

# shellcheck disable=SC2016 # the texts quote $ and ` literally
msg_zh() {
	case "$1" in
	node_address_resolves_cloudflare_orange_cloud) m '节点通信地址 %s 解析到 Cloudflare（橙色云代理）' ;;
	main_domain_resolves_cloudflare_orange_cloud) m '主域名 %s 解析到 Cloudflare（橙色云代理），默认会被用作节点通信地址' ;;
	node_agents_dial_panels_grpc_port) m '%s：节点 agent 必须直连面板的 gRPC 端口 %s（双向 TLS），经过 Cloudflare 或其他反向代理就连不上。请使用一个仅 DNS 解析（灰色云）、指向本机的域名，或本机公网 IP' ;;
	pass_node_address_with_node_address) m '用 --node-address <仅 DNS 的域名或公网 IP>（或 AKARI_NODE_ADDRESS）指定节点通信地址' ;;
	node_address_dns_only_name_or) m '节点通信地址（仅 DNS 的域名或公网 IP，可带 :端口）' ;;
	invalid_address) m '地址无效：%s' ;;
	resolves_cloudflare_too_make_it_dns) m '%s 也解析到 Cloudflare：请把它设为仅 DNS（灰色云），或填 IP' ;;
	cannot_identify_os_no_etc_os) m '无法识别操作系统（缺少 /etc/os-release）' ;;
	unsupported_os_supported_debian_12_13) m '不支持的系统：%s。支持 Debian 12/13、Ubuntu 22.04/24.04（其他系统请按 docs/DEPLOY.md 附录手动部署）' ;;
	unsupported_architecture_amd64_and_arm64_only) m '不支持的 CPU 架构 %s（仅 amd64、arm64）' ;;
	systemd_not_running_on_this_machine) m '本机没有运行 systemd（必需）' ;;
	mib_ram_at_least_1_gib) m '内存 %s MiB，建议 ≥ 1 GiB（PostgreSQL + 面板）' ;;
	mib_ram_not_enough_512_mib) m '内存 %s MiB 不足（至少 512 MiB）' ;;
	ports_already_in_use_ss_ltnp) m '端口已被占用：%s（ss -ltnp 查看占用者；或用 --http-port/--https-port/--grpc-port 换端口）' ;;
	apt_get_install_failed_see_log) m 'apt-get install $* 失败（见日志）' ;;
	apt_get_update_failed) m 'apt-get update 失败' ;;
	etc_apt_sources_list_has_caddys) m '/etc/apt/sources.list 含 Caddy 的 Cloudsmith 软件源（已失效，402），请删除该行后重试' ;;
	disabled_caddys_cloudsmith_apt_repository_unavailable) m '已停用 Caddy 的 Cloudsmith 软件源（不可用，402）：%s → %s.akari.disabled（docs/DEPLOY.md）' ;;
	installing_base_tools) m '安装基础工具：%s' ;;
	cannot_download_repository_key) m '下载 %s 软件源密钥失败' ;;
	cannot_download_cosign) m '下载 cosign 失败' ;;
	sha_256_mismatch_for_cosign) m 'cosign 的 SHA-256 不符' ;;
	cannot_determine_latest_release) m '无法获取最新版本号' ;;
	cannot_parse_latest_release_version) m '无法解析最新版本号' ;;
	cannot_download_sha256sums_does_release_exist) m '下载 %s 的 SHA256SUMS 失败（版本存在吗？）' ;;
	cannot_download_signature) m '下载 %s 的签名失败' ;;
	verifying_with_custom_cosign_key_not) m '使用自定义 cosign 公钥 %s 验证（非官方发布）' ;;
	signature_verification_failed_for) m '%s 的签名验证失败' ;;
	signature_verification_failed_for_sha256sums_was) m '%s 的签名验证失败：SHA256SUMS 不是本仓库发布流程签署的' ;;
	verified_signature_cosign) m '已验证 %s 的签名（cosign）' ;;
	not_listed_in_releases_sha256sums) m '%s 不在该版本的 SHA256SUMS 中' ;;
	cannot_download) m '下载 %s 失败' ;;
	sha_256_mismatch_for) m '%s 的 SHA-256 不符' ;;
	downloaded_binary_reports_expected) m '下载的二进制版本不符（%s，期望 %s）' ;;
	image_reference_does_not_match_release) m '镜像引用与版本不符：%s' ;;
	cannot_unpack_deploy_bundle) m '解压部署文件失败' ;;
	deploy_files_from_source_tree) m '部署文件取自源码目录 %s' ;;
	no_deploy_bundle_available) m '找不到部署文件' ;;
	no_deploy_bundle_set_akari_source) m '找不到部署文件（从源码运行时设置 AKARI_SOURCE_DIR）' ;;
	backup_signing_key_backup_sign_key) m '备份签名密钥 %s（install.env 的 BACKUP_SIGN_KEY）不可读' ;;
	cannot_generate_backup_signing_key) m '无法生成备份签名密钥' ;;
	generated_backup_signing_key_root_only) m '已生成备份签名密钥 %s（仅 root 可读；公钥见 akari-ctl info，请离线保存一份）' ;;
	adopting_existing_docker_compose_deployment_in) m '接管已有的 Docker Compose 部署 %s' ;;
	found_hand_made_bare_metal_panel) m '发现手动安装的裸机面板（%s / akari-panel.service），本工具不能接管它；请按 docs/DEPLOY.md 手动升级，或备份后用本工具重新安装（--restore）' ;;
	installing_postgresql_18_pgdg_repository) m '安装 PostgreSQL 18（PGDG 官方源）' ;;
	cannot_create_postgresql_18_cluster) m '创建 PostgreSQL 18 集群失败' ;;
	postgresql_18_does_not_start) m 'PostgreSQL 18 无法启动' ;;
	postgresql_18_not_ready) m 'PostgreSQL 18 未就绪' ;;
	postgresql_18_on_127_0_0) m 'PostgreSQL 18 监听 127.0.0.1:%s' ;;
	cannot_create_database_role_database) m '创建数据库/角色失败' ;;
	installing_valkey_upstream_build_pinned_sha) m '安装 Valkey %s（官方构建，SHA-256 固定）' ;;
	cannot_download_valkey) m '下载 Valkey 失败' ;;
	sha_256_mismatch_for_valkey) m 'Valkey 的 SHA-256 不符' ;;
	valkey_does_not_run_on_this) m 'Valkey 无法在本机运行（缺少 libssl3？）' ;;
	caddy_already_installed_using_it) m 'Caddy 已安装，沿用' ;;
	installing_caddy_upstream_build_pinned_sha) m '安装 Caddy %s（官方构建，SHA-256 固定）' ;;
	cannot_download_caddy) m '下载 Caddy 失败' ;;
	sha_256_mismatch_for_caddy) m 'Caddy 的 SHA-256 不符' ;;
	cannot_unpack_caddy) m '解压 Caddy 失败' ;;
	cannot_create_caddy_group) m '创建 caddy 组失败' ;;
	cannot_create_caddy_user) m '创建 caddy 用户失败' ;;
	caddy_configuration_does_not_validate_see) m 'Caddy 配置校验失败（见日志）' ;;
	caddy_does_not_start_journalctl_u) m 'Caddy 无法启动（journalctl -u caddy）' ;;
	cannot_create_akari_user) m '创建 akari 用户失败' ;;
	docker_present) m 'Docker 已就绪：%s' ;;
	installing_docker_engine_compose_v2_docker) m '安装 Docker Engine + compose v2（Docker 官方源）' ;;
	docker_does_not_start) m 'Docker 无法启动' ;;
	cannot_pull_see_log) m '拉取 %s 失败（见日志）' ;;
	could_not_pull_using_local_copy) m '拉取 %s 失败，使用本机已有的副本' ;;
	postgresql_container_not_ready) m 'PostgreSQL 容器未就绪' ;;
	backup_not_encrypted_plain_files_0600) m '备份未加密（0600 明文文件）：在 %s 设置 AGE_RECIPIENT=age1… 以加密（docs/BACKUP.md）' ;;
	backup_failed_see) m '备份失败（见 %s）' ;;
	backup_failed) m '备份失败' ;;
	no_such_backup_directory) m '备份目录不存在：%s' ;;
	verifying_signature_needs_openssl) m '验证签名需要 openssl' ;;
	cannot_read) m '无法读取 %s' ;;
	backup_has_no_sha256sums_sig_but) m '备份没有签名（SHA256SUMS.sig），但指定了 --backup-verify-key：拒绝恢复' ;;
	backup_signature_mismatch_sha256sums_was_not) m '备份签名不符：SHA256SUMS 不是该公钥对应的签名者所签（或已被修改）：拒绝恢复' ;;
	no_backup_verify_key_this_backup) m '未指定 --backup-verify-key：备份内容未经验证来源，只能证明完好（integrity only），不能证明它出自你的备份主机（not authenticity）。若该备份可能被他人改写，请停止并用 akari-ctl info 打印的公钥重试（docs/BACKUP.md「真实性」）' ;;
	backup_checksum_mismatch_damaged_or_modified) m '备份校验失败（文件与 SHA256SUMS 不符，已损坏或被改动）：%s' ;;
	backup_encrypted_pass_age_identity_key) m '备份已加密：用 --age-identity <私钥文件> 指定解密密钥' ;;
	restoring_from_backup) m '从备份恢复：%s' ;;
	cannot_recreate_database_akari) m '无法重建数据库 akari' ;;
	no_akari_akari_data_volume) m '找不到数据卷 akari_akari-data' ;;
	restore_failed_see) m '恢复失败（见 %s）' ;;
	database_from_v0_3_x_fresh) m '数据库来自 v0.3.x：需要全新安装，见 docs/DEPLOY.md（未做任何改动）' ;;
	admin_account_exists_not_creating_one) m '已有管理员账户，跳过创建' ;;
	creating_admin_account) m '创建管理员账户 %s' ;;
	cannot_create_admin_account_see_log) m '创建管理员失败（见日志）' ;;
	this_release_has_no_settings_command) m '该版本没有 settings 命令：请在 系统设置 中设置主域名与节点通信域名' ;;
	could_not_set_main_domain_set) m '设置主域名失败（可在 系统设置 中设置）' ;;
	could_not_set_node_address_set) m '设置节点通信域名失败（可在 系统设置 中设置）' ;;
	mode_must_be_bare_or_docker) m '--mode 只能是 bare 或 docker' ;;
	main_domain_dns_pointing_here_empty) m '主域名（DNS 已指向本机；留空 = 仅用 IP 访问）' ;;
	public_ip_this_machine) m '本机公网 IP' ;;
	cannot_determine_public_ip_pass_ip) m '无法确定公网 IP：用 --ip 指定' ;;
	e_mail_for_certificate_notices_optional) m '证书通知邮箱（可留空）' ;;
	admin_e_mail_login_name) m '管理员邮箱（登录名）' ;;
	admin_password_empty_generate_one) m '管理员密码（留空 = 自动生成）' ;;
	admin_password_needs_at_least_8) m '管理员密码至少 8 个字符' ;;
	customize_ports_default_80_443_8443) m '自定义端口？（默认 80/443/8443）' ;;
	http_port) m 'HTTP 端口' ;;
	https_port) m 'HTTPS 端口' ;;
	node_grpc_port) m '节点 gRPC 端口' ;;
	invalid_port) m '端口无效：%s' ;;
	invalid_domain) m '域名无效：%s' ;;
	invalid_ip) m 'IP 无效：%s' ;;
	invalid_e_mail) m '邮箱无效：%s' ;;
	invalid_admin_e_mail) m '管理员邮箱无效：%s' ;;
	invalid_node_address_host_name_ipv4) m '节点地址无效（主机名、IPv4 或 [IPv6]，可带 :端口）：%s' ;;
	bare_metal_systemd) m '裸机（systemd）' ;;
	about_install) m '即将安装：' ;;
	ip_only_self_signed_certificate) m '（仅 IP，自签证书）' ;;
	continue) m '继续？' ;;
	cancelled) m '已取消' ;;
	resuming_unfinished_installation) m '继续上次未完成的安装（%s）' ;;
	found_existing_installation) m '发现已有的安装。' ;;
	already_installed) m '已安装（%s，%s）。' ;;
	upgrade_it_instead) m '改为升级？' ;;
	already_installed_use_akari_ctl_upgrade) m '已有安装：用 akari-ctl upgrade / uninstall' ;;
	downloading_and_verifying_akari) m '下载并验证 akari %s（%s）' ;;
	valkey_does_not_start_journalctl_u) m 'Valkey 无法启动（journalctl -u akari-valkey）' ;;
	configuration_check_failed_akari_config_check) m '配置校验失败（akari config check，见日志）' ;;
	cannot_read_admin_prefix) m '无法读取后台前缀' ;;
	starting_panel) m '启动面板' ;;
	panel_did_not_become_healthy_journalctl) m '面板未通过健康检查（journalctl -u akari-panel）' ;;
	fetching_and_verifying_image_reference) m '获取并验证 %s 的镜像引用' ;;
	pulling) m '拉取镜像 %s' ;;
	configuration_check_failed_see_log) m '配置校验失败（见日志）' ;;
	starting_containers) m '启动容器' ;;
	docker_compose_up_failed_see_log) m 'docker compose up 失败（见日志）' ;;
	panel_did_not_become_healthy_docker) m '面板未通过健康检查（docker compose logs panel）' ;;
	firewall_ufw_allowed) m '防火墙（ufw）已放行 %s/%s/%s' ;;
	installation_complete) m '安装完成' ;;
	shown_only_this_once_save_it) m '（密码只显示这一次，请立即保存）' ;;
	admin_prefix_secret_only_those_who) m '后台地址中的前缀是机密：只有知道它的人才能进入后台（可在系统设置中更换或限制来源 IP）。' ;;
	https_check_through_caddy_did_not) m '经 Caddy 的 HTTPS 检查未通过：确认 DNS 已指向本机、端口 %s/%s 已放行（云防火墙/安全组），证书签发可能需要几分钟' ;;
	ip_only_certificate_comes_from_caddy) m '仅 IP：证书由 Caddy 内部 CA 签发，浏览器会警告；正式使用请绑定域名（docs/DEPLOY.md）。' ;;
	next_steps) m '下一步：' ;;
	running_upgrade_with_installer) m '使用 %s 的安装器执行升级' ;;
	no_installation_found_install_first) m '没有找到安装（先运行安装）' ;;
	already_at_nothing_do_force_reinstalls) m '已是 %s，无需升级（--force 重新安装同一版本）' ;;
	downloading_and_verifying_akari_2) m '下载并验证 akari %s' ;;
	backup_before_upgrade) m '升级前备份' ;;
	backup) m '备份：%s' ;;
	new_release_migrated_database_migrations_are) m '新版本已执行数据库迁移（%s → %s）；迁移只能前进，回滚到旧版本需要从升级前的备份恢复数据库：%s（docs/DEPLOY.md「回滚」）' ;;
	switching) m '切换到 %s' ;;
	new_release_rejects_configuration_not_switched) m '新版本的配置校验失败，未切换（见日志）' ;;
	upgraded_health_check_passed) m '已升级到 %s（健康检查通过）' ;;
	previous_binary_kept_as_prev_pre) m '上一版本保留为 %s.prev；升级前备份：%s' ;;
	failed_health_check_rolling_back_previous) m '%s 未通过健康检查，自动回滚到上一版本' ;;
	upgrade_failed_rolled_back_panel_healthy) m '升级失败，已回滚到 %s（面板正常运行）。日志：journalctl -u akari-panel' ;;
	upgrade_failed_and_rolled_back_panel) m '升级失败，回滚后面板仍不健康：从备份恢复 %s（docs/BACKUP.md）' ;;
	cannot_pull_new_image_not_switched) m '拉取新镜像失败，未切换' ;;
	pre_upgrade_backup) m '升级前备份：%s' ;;
	failed_health_check_rolling_back) m '%s 未通过健康检查，自动回滚到 %s' ;;
	upgrade_failed_rolled_back_panel_healthy_2) m '升级失败，已回滚到 %s（面板正常运行）' ;;
	no_installation_found) m '没有找到安装' ;;
	purge_permanently_deletes_database_data_dir) m '--purge 会永久删除数据库、数据目录（路由前缀、CA 私钥、jwt.key、master.key）与配置。所有节点都需要重新注册。备份目录保留。' ;;
	type_purge_confirm) m '输入 purge 确认：' ;;
	not_confirmed_nothing_removed_non_interactive) m '未确认，未删除任何东西（非交互：--confirm purge）' ;;
	remove_panel_services_data_and_configuration) m '卸载面板服务？（数据与配置保留）' ;;
	purged_backups_kept_in) m '已彻底卸载（备份保留在 %s）' ;;
	stopping_and_removing_panel_services) m '停止并移除面板服务' ;;
	could_not_drop_database) m '删除数据库失败' ;;
	packages_postgresql_18_and_apt_installed) m '保留软件包 postgresql-18 与 apt 装的 caddy（apt purge 可删除）' ;;
	stopping_and_removing_containers) m '停止并移除容器' ;;
	backing_up_database_data_dir_and) m '备份数据库、数据目录与配置' ;;
	backup_written) m '备份完成：%s' ;;
	moving_hosts_copy_this_directory_and) m '迁移到新主机：复制该目录，在新主机上运行  install.sh --restore <目录>' ;;
	pass_bare_or_docker) m '用 --to bare 或 --to docker' ;;
	move_panel_from_on_this_host) m '把面板从 %s 迁移到 %s（同一主机，保留前缀、密钥、数据）？期间面板停机。' ;;
	safety_backup_kept) m '安全备份（保留）' ;;
	dump_for_move_local_temporary_files) m '迁移用的转储（本机临时文件，完成后删除）' ;;
	move_failed_bringing_services_back) m '迁移失败，恢复 %s 服务' ;;
	move_failed_back_on_safety_backup) m '迁移失败，已恢复为 %s（安全备份：%s）' ;;
	moved_now_safety_backup) m '迁移完成：现在是 %s（安全备份：%s）' ;;
	old_bare_metal_data_kept_postgresql) m '旧的裸机数据保留：%s、PostgreSQL 数据库 akari、%s/panel.toml（确认无误后可删除）' ;;
	old_docker_data_kept_volumes_akari) m '旧的 Docker 数据保留：卷 akari_*、%s（确认无误后：cd %s && docker compose down -v）' ;;
	backup_verification_public_key_keep_it) m '备份验证公钥（离线保存；恢复时用 --backup-verify-key <文件> 验证备份出自本机，docs/BACKUP.md「真实性」；对应的私钥 %s 不要放进备份存储）：' ;;
	unknown_option_help) m '未知参数：%s（--help）' ;;
	run_as_root_or_install_sudo) m '请以 root 运行（或安装 sudo）' ;;
	re_running_through_sudo) m '以 sudo 重新运行' ;;
	cannot_download_installer) m '下载安装器失败：%s' ;;
	ui_warning) m '警告：' ;;
	ui_error) m '错误：' ;;
	ui_log_is) m '日志：' ;;
	ui_last_lines) m '该步骤最近写入日志的内容：' ;;
	ui_default) m '默认' ;;
	ui_pick_number) m '请输入 1 到 %s 之间的编号' ;;
	unknown_language) m '不支持的语言：%s（可用 zh、en）' ;;
	banner_subtitle) m '面板安装器 %s' ;;
	configuring_services) m '配置数据库、Valkey 与面板服务' ;;
	admin_account_and_https) m '创建管理员账户并启用 HTTPS 反向代理' ;;
	admin_account) m '创建管理员账户' ;;
	writing_deployment_files) m '获取部署文件并写入配置' ;;
	already_in_mode) m '已经是 %s' ;;
	install_mode) m '安装方式' ;;
	install_mode_docker) m 'Docker Compose（推荐：隔离、易升级/卸载）' ;;
	install_mode_bare) m '裸机（systemd：PostgreSQL 18 + Valkey 9 + Caddy）' ;;
	install_log) m '安装日志（不含机密）：%s' ;;
	lbl_mode) m '方式          ' ;;
	lbl_version) m '版本          ' ;;
	lbl_address) m '地址          ' ;;
	lbl_admin) m '管理员        ' ;;
	lbl_ports) m '端口          ' ;;
	lbl_node) m '节点通信      ' ;;
	lbl_restore) m '恢复自        ' ;;
	lbl_console) m '管理后台      ' ;;
	lbl_portal) m '用户门户      ' ;;
	lbl_admin_login) m '管理员账号    ' ;;
	lbl_password) m '密码          ' ;;
	next_log_in_settings) m '1. 登录后台 → 系统设置：确认主域名、订阅域名、节点通信域名' ;;
	next_add_node) m '2. 节点 → 添加节点 → 复制一键安装命令到节点执行' ;;
	next_backup) m '3. 备份：%s backup（在 %s 设置 AGE_RECIPIENT 以加密）；升级：%s upgrade；状态：%s status' ;;
	next_signed_backups) m '4. 备份已默认签名：把 %s info 打印的备份验证公钥离线保存（恢复到新主机时需要）' ;;
	services_removed_kept) m '已卸载服务；保留：数据与配置（%s）' ;;
	repository_key_fingerprint_mismatch) m '%s 软件源密钥指纹不符（期望 %s，得到 %s）' ;;
	help_title) m 'Akari 面板安装器 / akari-ctl' ;;
	help_usage) m '用法：
  install.sh [install] [选项]          安装（不加 --yes 则交互）
  install.sh upgrade [--version vX]    升级（备份、验证、切换、健康检查、自动回滚）
  install.sh backup [--out DIR] [--age-recipient age1...] [--with-agent-releases]
  install.sh migrate --to docker|bare  把本机安装迁移到另一种方式
  install.sh uninstall [--purge [--confirm purge]]
  install.sh status | info

界面默认简体中文，需要 UTF-8 终端（SSH 客户端须设为 UTF-8）。本机缺少 zh_CN.UTF-8 时，
安装器会为本次运行安装它（不改系统默认语言）；装不上就自动改用英文。--lang en 直接用英文。' ;;
	help_options_heading) m '选项（括号内为环境变量）' ;;
	help_options) m '  -y, --yes                 非交互：未给出的项一律用默认值
  --mode bare|docker        [AKARI_MODE]       默认 docker
  --domain NAME             [AKARI_DOMAIN]     主域名；留空 = 仅用 IP
  --ip ADDRESS              [AKARI_PUBLIC_IP]  公网地址（仅 IP 安装）
  --email ADDRESS           [AKARI_EMAIL]      ACME 账户邮箱（可选）
  --admin EMAIL             [AKARI_ADMIN]      管理员登录名（默认 --email，否则 admin@<域名>）
  --admin-password-file F   [AKARI_ADMIN_PASSWORD] 默认自动生成，只显示一次
  --node-address HOST[:P]   [AKARI_NODE_ADDRESS] 节点 agent 连接的地址（默认域名 / IP；
                            域名在 Cloudflare 后面时必须另给：仅 DNS 的域名或 IP）
  --http-port N --https-port N --grpc-port N   默认 80 / 443 / 8443
  --version vX.Y.Z          [AKARI_VERSION]    默认：本安装器所属版本 / 最新版本
  --dir DIR                 [AKARI_DOCKER_DIR] compose 目录（默认 /opt/akari）
  --local-certs             Caddy 内部 CA 为所有名称签证书（测试 / 内网名称）
  --restore DIR             从 `backup` 生成的备份安装（换机）
  --age-identity FILE       解密加密备份的 age 私钥（--restore）
  --backup-verify-key FILE  备份 SHA256SUMS.sig 必须通过验证的公钥（PEM，--restore）
  --lang zh|en              [AKARI_LANG]       界面语言（默认中文；en 不安装 zh_CN 语言包）
  --force                   重新安装 / 重新执行同一版本的升级' ;;
	help_testing_heading) m '测试 / 私有镜像' ;;
	help_testing) m '  AKARI_RELEASES_URL（发布基址）、AKARI_COSIGN_KEY（用 cosign 公钥代替 keyless 发布身份验证）、
  AKARI_SOURCE_DIR（部署文件取自源码目录）、AKARI_NO_BANNER=1（不显示横幅）。' ;;
	*) m "$1" ;;
	esac
}

# shellcheck disable=SC2016 # the texts quote $ and ` literally
msg_en() {
	case "$1" in
	node_address_resolves_cloudflare_orange_cloud) m 'the node address %s resolves to Cloudflare (orange-cloud proxy)' ;;
	main_domain_resolves_cloudflare_orange_cloud) m 'the main domain %s resolves to Cloudflare (orange-cloud proxy) and would be the node address' ;;
	node_agents_dial_panels_grpc_port) m '%s: node agents dial the panel'\''s gRPC port %s directly (mutual TLS) and cannot connect through Cloudflare or any other reverse proxy. Use a DNS-only (grey-cloud) name pointing at this machine, or its public IP' ;;
	pass_node_address_with_node_address) m 'pass the node address with --node-address <DNS-only name or public IP> (or AKARI_NODE_ADDRESS)' ;;
	node_address_dns_only_name_or) m 'node address (DNS-only name or public IP, optional :port)' ;;
	invalid_address) m 'invalid address: %s' ;;
	resolves_cloudflare_too_make_it_dns) m '%s resolves to Cloudflare too: make it DNS-only (grey cloud) or enter an IP' ;;
	cannot_identify_os_no_etc_os) m 'cannot identify the OS (no /etc/os-release)' ;;
	unsupported_os_supported_debian_12_13) m 'unsupported OS: %s. Supported: Debian 12/13, Ubuntu 22.04/24.04 (elsewhere follow the manual steps in docs/DEPLOY.md, appendix)' ;;
	unsupported_architecture_amd64_and_arm64_only) m 'unsupported architecture %s (amd64 and arm64 only)' ;;
	systemd_not_running_on_this_machine) m 'systemd is not running on this machine (required)' ;;
	mib_ram_at_least_1_gib) m '%s MiB of RAM; at least 1 GiB is recommended (PostgreSQL + panel)' ;;
	mib_ram_not_enough_512_mib) m '%s MiB of RAM is not enough (512 MiB minimum)' ;;
	ports_already_in_use_ss_ltnp) m 'ports already in use:%s (ss -ltnp shows by what; or choose others with --http-port/--https-port/--grpc-port)' ;;
	apt_get_install_failed_see_log) m 'apt-get install $* failed (see the log)' ;;
	apt_get_update_failed) m 'apt-get update failed' ;;
	etc_apt_sources_list_has_caddys) m '/etc/apt/sources.list has Caddy'\''s Cloudsmith repository (unavailable: 402); remove that line and retry' ;;
	disabled_caddys_cloudsmith_apt_repository_unavailable) m 'disabled Caddy'\''s Cloudsmith apt repository (unavailable: 402): %s -> %s.akari.disabled (docs/DEPLOY.md)' ;;
	installing_base_tools) m 'installing base tools:%s' ;;
	cannot_download_repository_key) m 'cannot download the %s repository key' ;;
	cannot_download_cosign) m 'cannot download cosign' ;;
	sha_256_mismatch_for_cosign) m 'SHA-256 mismatch for cosign' ;;
	cannot_determine_latest_release) m 'cannot determine the latest release' ;;
	cannot_parse_latest_release_version) m 'cannot parse the latest release version' ;;
	cannot_download_sha256sums_does_release_exist) m 'cannot download SHA256SUMS of %s (does the release exist?)' ;;
	cannot_download_signature) m 'cannot download the signature of %s' ;;
	verifying_with_custom_cosign_key_not) m 'verifying with the custom cosign key %s (not an official release)' ;;
	signature_verification_failed_for) m 'signature verification failed for %s' ;;
	signature_verification_failed_for_sha256sums_was) m 'signature verification failed for %s: SHA256SUMS was not signed by this repository'\''s release workflow' ;;
	verified_signature_cosign) m 'verified the signature of %s (cosign)' ;;
	not_listed_in_releases_sha256sums) m '%s is not listed in the release'\''s SHA256SUMS' ;;
	cannot_download) m 'cannot download %s' ;;
	sha_256_mismatch_for) m 'SHA-256 mismatch for %s' ;;
	downloaded_binary_reports_expected) m 'the downloaded binary reports '\''%s'\'', expected %s' ;;
	image_reference_does_not_match_release) m 'image reference does not match the release: %s' ;;
	cannot_unpack_deploy_bundle) m 'cannot unpack the deploy bundle' ;;
	deploy_files_from_source_tree) m 'deploy files from the source tree %s' ;;
	no_deploy_bundle_available) m 'no deploy bundle available' ;;
	no_deploy_bundle_set_akari_source) m 'no deploy bundle (set AKARI_SOURCE_DIR when running from a source tree)' ;;
	backup_signing_key_backup_sign_key) m 'the backup signing key %s (BACKUP_SIGN_KEY in install.env) is not readable' ;;
	cannot_generate_backup_signing_key) m 'cannot generate the backup signing key' ;;
	generated_backup_signing_key_root_only) m 'generated the backup signing key %s (root only; the public key is in akari-ctl info, keep a copy offline)' ;;
	adopting_existing_docker_compose_deployment_in) m 'adopting the existing Docker Compose deployment in %s' ;;
	found_hand_made_bare_metal_panel) m 'found a hand-made bare-metal panel (%s / akari-panel.service) this tool cannot adopt; upgrade it by hand (docs/DEPLOY.md) or back it up and reinstall with this tool (--restore)' ;;
	installing_postgresql_18_pgdg_repository) m 'installing PostgreSQL 18 (PGDG repository)' ;;
	cannot_create_postgresql_18_cluster) m 'cannot create the PostgreSQL 18 cluster' ;;
	postgresql_18_does_not_start) m 'PostgreSQL 18 does not start' ;;
	postgresql_18_not_ready) m 'PostgreSQL 18 is not ready' ;;
	postgresql_18_on_127_0_0) m 'PostgreSQL 18 on 127.0.0.1:%s' ;;
	cannot_create_database_role_database) m 'cannot create the database role/database' ;;
	installing_valkey_upstream_build_pinned_sha) m 'installing Valkey %s (upstream build, pinned SHA-256)' ;;
	cannot_download_valkey) m 'cannot download Valkey' ;;
	sha_256_mismatch_for_valkey) m 'SHA-256 mismatch for Valkey' ;;
	valkey_does_not_run_on_this) m 'Valkey does not run on this machine (libssl3 missing?)' ;;
	caddy_already_installed_using_it) m 'Caddy is already installed, using it' ;;
	installing_caddy_upstream_build_pinned_sha) m 'installing Caddy %s (upstream build, pinned SHA-256)' ;;
	cannot_download_caddy) m 'cannot download Caddy' ;;
	sha_256_mismatch_for_caddy) m 'SHA-256 mismatch for Caddy' ;;
	cannot_unpack_caddy) m 'cannot unpack Caddy' ;;
	cannot_create_caddy_group) m 'cannot create the caddy group' ;;
	cannot_create_caddy_user) m 'cannot create the caddy user' ;;
	caddy_configuration_does_not_validate_see) m 'the Caddy configuration does not validate (see the log)' ;;
	caddy_does_not_start_journalctl_u) m 'Caddy does not start (journalctl -u caddy)' ;;
	cannot_create_akari_user) m 'cannot create the akari user' ;;
	docker_present) m 'Docker present: %s' ;;
	installing_docker_engine_compose_v2_docker) m 'installing Docker Engine + compose v2 (Docker apt repository)' ;;
	docker_does_not_start) m 'Docker does not start' ;;
	cannot_pull_see_log) m 'cannot pull %s (see the log)' ;;
	could_not_pull_using_local_copy) m 'could not pull %s; using the local copy' ;;
	postgresql_container_not_ready) m 'the PostgreSQL container is not ready' ;;
	backup_not_encrypted_plain_files_0600) m 'the backup is NOT encrypted (plain files, 0600): set AGE_RECIPIENT=age1... in %s to encrypt (docs/BACKUP.md)' ;;
	backup_failed_see) m 'backup failed (see %s)' ;;
	backup_failed) m 'backup failed' ;;
	no_such_backup_directory) m 'no such backup directory: %s' ;;
	verifying_signature_needs_openssl) m 'verifying the signature needs openssl' ;;
	cannot_read) m 'cannot read %s' ;;
	backup_has_no_sha256sums_sig_but) m 'the backup has no SHA256SUMS.sig but --backup-verify-key was given: refusing to restore' ;;
	backup_signature_mismatch_sha256sums_was_not) m 'backup signature mismatch: SHA256SUMS was not signed by the holder of that key (or was modified): refusing to restore' ;;
	no_backup_verify_key_this_backup) m 'NO --backup-verify-key: this backup is NOT verified, integrity only, not authenticity - the checksums prove it is intact, not that your backup host made it. If anybody else could have written to the backup storage, stop and retry with the public key printed by akari-ctl info (docs/BACKUP.md, Authenticity)' ;;
	backup_checksum_mismatch_damaged_or_modified) m 'backup checksum mismatch (damaged or modified): %s' ;;
	backup_encrypted_pass_age_identity_key) m 'the backup is encrypted: pass --age-identity <key file>' ;;
	restoring_from_backup) m 'restoring from the backup %s' ;;
	cannot_recreate_database_akari) m 'cannot recreate the database akari' ;;
	no_akari_akari_data_volume) m 'no akari_akari-data volume' ;;
	restore_failed_see) m 'restore failed (see %s)' ;;
	database_from_v0_3_x_fresh) m 'database from v0.3.x — fresh install required; see docs/DEPLOY.md (nothing was changed)' ;;
	admin_account_exists_not_creating_one) m 'an admin account exists; not creating one' ;;
	creating_admin_account) m 'creating the admin account %s' ;;
	cannot_create_admin_account_see_log) m 'cannot create the admin account (see the log)' ;;
	this_release_has_no_settings_command) m 'this release has no settings command: set the main domain and node address in 系统设置' ;;
	could_not_set_main_domain_set) m 'could not set the main domain (set it in 系统设置)' ;;
	could_not_set_node_address_set) m 'could not set the node address (set it in 系统设置)' ;;
	mode_must_be_bare_or_docker) m '--mode must be bare or docker' ;;
	main_domain_dns_pointing_here_empty) m 'main domain (DNS pointing here; empty = IP only)' ;;
	public_ip_this_machine) m 'public IP of this machine' ;;
	cannot_determine_public_ip_pass_ip) m 'cannot determine the public IP: pass --ip' ;;
	e_mail_for_certificate_notices_optional) m 'e-mail for certificate notices (optional)' ;;
	admin_e_mail_login_name) m 'admin e-mail (the login name)' ;;
	admin_password_empty_generate_one) m 'admin password (empty = generate one)' ;;
	admin_password_needs_at_least_8) m 'the admin password needs at least 8 characters' ;;
	customize_ports_default_80_443_8443) m 'customize ports? (default 80/443/8443)' ;;
	http_port) m 'HTTP port' ;;
	https_port) m 'HTTPS port' ;;
	node_grpc_port) m 'node gRPC port' ;;
	invalid_port) m 'invalid port: %s' ;;
	invalid_domain) m 'invalid domain: %s' ;;
	invalid_ip) m 'invalid IP: %s' ;;
	invalid_e_mail) m 'invalid e-mail: %s' ;;
	invalid_admin_e_mail) m 'invalid admin e-mail: %s' ;;
	invalid_node_address_host_name_ipv4) m 'invalid node address (host name, IPv4 or [IPv6], optional :port): %s' ;;
	bare_metal_systemd) m 'bare metal (systemd)' ;;
	about_install) m 'About to install:' ;;
	ip_only_self_signed_certificate) m '(IP only, self-signed certificate)' ;;
	continue) m 'continue?' ;;
	cancelled) m 'cancelled' ;;
	resuming_unfinished_installation) m 'resuming the unfinished installation (%s)' ;;
	found_existing_installation) m 'found an existing installation.' ;;
	already_installed) m 'already installed (%s, %s).' ;;
	upgrade_it_instead) m 'upgrade it instead?' ;;
	already_installed_use_akari_ctl_upgrade) m 'already installed: use akari-ctl upgrade / uninstall' ;;
	downloading_and_verifying_akari) m 'downloading and verifying akari %s (%s)' ;;
	valkey_does_not_start_journalctl_u) m 'Valkey does not start (journalctl -u akari-valkey)' ;;
	configuration_check_failed_akari_config_check) m 'configuration check failed (akari config check, see the log)' ;;
	cannot_read_admin_prefix) m 'cannot read the admin prefix' ;;
	starting_panel) m 'starting the panel' ;;
	panel_did_not_become_healthy_journalctl) m 'the panel did not become healthy (journalctl -u akari-panel)' ;;
	fetching_and_verifying_image_reference) m 'fetching and verifying the image reference of %s' ;;
	pulling) m 'pulling %s' ;;
	configuration_check_failed_see_log) m 'configuration check failed (see the log)' ;;
	starting_containers) m 'starting the containers' ;;
	docker_compose_up_failed_see_log) m 'docker compose up failed (see the log)' ;;
	panel_did_not_become_healthy_docker) m 'the panel did not become healthy (docker compose logs panel)' ;;
	firewall_ufw_allowed) m 'firewall (ufw): allowed %s/%s/%s' ;;
	installation_complete) m 'Installation complete' ;;
	shown_only_this_once_save_it) m '(shown only this once: save it now)' ;;
	admin_prefix_secret_only_those_who) m 'The admin prefix is secret: only those who know it reach the console (rotate it or restrict source IPs in 系统设置).' ;;
	https_check_through_caddy_did_not) m 'the HTTPS check through Caddy did not pass yet: make sure DNS points here and ports %s/%s are open (cloud firewall / security group); the certificate can take a few minutes' ;;
	ip_only_certificate_comes_from_caddy) m 'IP only: the certificate comes from Caddy'\''s internal CA (browser warning); bind a domain for production (docs/DEPLOY.md).' ;;
	next_steps) m 'Next steps:' ;;
	running_upgrade_with_installer) m 'running the upgrade with the installer of %s' ;;
	no_installation_found_install_first) m 'no installation found (install first)' ;;
	already_at_nothing_do_force_reinstalls) m 'already at %s; nothing to do (--force reinstalls it)' ;;
	downloading_and_verifying_akari_2) m 'downloading and verifying akari %s' ;;
	backup_before_upgrade) m 'backup before the upgrade' ;;
	backup) m 'backup: %s' ;;
	new_release_migrated_database_migrations_are) m 'the new release migrated the database (%s -> %s); migrations are forward-only, so running the old release needs the database from the pre-upgrade backup: %s (docs/DEPLOY.md "Rollback")' ;;
	switching) m 'switching to %s' ;;
	new_release_rejects_configuration_not_switched) m 'the new release rejects the configuration; not switched (see the log)' ;;
	upgraded_health_check_passed) m 'upgraded to %s (health check passed)' ;;
	previous_binary_kept_as_prev_pre) m 'previous binary kept as %s.prev; pre-upgrade backup: %s' ;;
	failed_health_check_rolling_back_previous) m '%s failed the health check; rolling back to the previous binary' ;;
	upgrade_failed_rolled_back_panel_healthy) m 'upgrade failed; rolled back to %s (the panel is healthy). Log: journalctl -u akari-panel' ;;
	upgrade_failed_and_rolled_back_panel) m 'upgrade failed and the rolled-back panel is not healthy either: restore %s (docs/BACKUP.md)' ;;
	cannot_pull_new_image_not_switched) m 'cannot pull the new image; not switched' ;;
	pre_upgrade_backup) m 'pre-upgrade backup: %s' ;;
	failed_health_check_rolling_back) m '%s failed the health check; rolling back to %s' ;;
	upgrade_failed_rolled_back_panel_healthy_2) m 'upgrade failed; rolled back to %s (the panel is healthy)' ;;
	no_installation_found) m 'no installation found' ;;
	purge_permanently_deletes_database_data_dir) m '--purge permanently deletes the database, the data dir (CA key, jwt.key, master.key) and the configuration. Every node would need re-enrolling. Backups are kept.' ;;
	type_purge_confirm) m 'type purge to confirm:' ;;
	not_confirmed_nothing_removed_non_interactive) m 'not confirmed; nothing removed (non-interactive: --confirm purge)' ;;
	remove_panel_services_data_and_configuration) m 'remove the panel services? (data and configuration are kept)' ;;
	purged_backups_kept_in) m 'purged (backups kept in %s)' ;;
	stopping_and_removing_panel_services) m 'stopping and removing the panel services' ;;
	could_not_drop_database) m 'could not drop the database' ;;
	packages_postgresql_18_and_apt_installed) m 'the packages postgresql-18 and an apt-installed caddy are left installed (apt purge removes them)' ;;
	stopping_and_removing_containers) m 'stopping and removing the containers' ;;
	backing_up_database_data_dir_and) m 'backing up the database, data dir and configuration' ;;
	backup_written) m 'backup written: %s' ;;
	moving_hosts_copy_this_directory_and) m 'moving hosts: copy this directory and run  install.sh --restore <dir>  on the new host' ;;
	pass_bare_or_docker) m 'pass --to bare or --to docker' ;;
	move_panel_from_on_this_host) m 'move the panel from %s to %s on this host (same prefix, keys, data)? The panel is down meanwhile.' ;;
	safety_backup_kept) m 'safety backup (kept)' ;;
	dump_for_move_local_temporary_files) m 'dump for the move (local temporary files, deleted afterwards)' ;;
	move_failed_bringing_services_back) m 'the move failed; bringing the %s services back' ;;
	move_failed_back_on_safety_backup) m 'the move failed; back on %s (safety backup: %s)' ;;
	moved_now_safety_backup) m 'moved: now %s (safety backup: %s)' ;;
	old_bare_metal_data_kept_postgresql) m 'the old bare-metal data is kept: %s, PostgreSQL database akari, %s/panel.toml (delete once satisfied)' ;;
	old_docker_data_kept_volumes_akari) m 'the old Docker data is kept: volumes akari_*, %s (once satisfied: cd %s && docker compose down -v)' ;;
	backup_verification_public_key_keep_it) m 'Backup verification public key (keep it offline; pass it as --backup-verify-key <file> when restoring to prove a backup came from this host, docs/BACKUP.md Authenticity; never put the private key %s on the backup storage):' ;;
	unknown_option_help) m 'unknown option: %s (--help)' ;;
	run_as_root_or_install_sudo) m 'run as root (or install sudo)' ;;
	re_running_through_sudo) m 're-running through sudo' ;;
	cannot_download_installer) m 'cannot download the installer: %s' ;;
	ui_warning) m 'WARNING:' ;;
	ui_error) m 'ERROR:' ;;
	ui_log_is) m 'log:' ;;
	ui_last_lines) m 'last lines this step wrote to the log:' ;;
	ui_default) m 'default' ;;
	ui_pick_number) m 'enter a number from 1 to %s' ;;
	unknown_language) m 'unsupported language: %s (zh or en)' ;;
	banner_subtitle) m 'panel installer %s' ;;
	configuring_services) m 'Configuring the database, Valkey and the panel service' ;;
	admin_account_and_https) m 'Admin account and HTTPS reverse proxy' ;;
	admin_account) m 'Admin account' ;;
	writing_deployment_files) m 'Fetching the deployment files and writing the configuration' ;;
	already_in_mode) m 'already %s' ;;
	install_mode) m 'Installation mode' ;;
	install_mode_docker) m 'Docker Compose (recommended: isolated, easy upgrade/removal)' ;;
	install_mode_bare) m 'bare metal (systemd: PostgreSQL 18 + Valkey 9 + Caddy)' ;;
	install_log) m 'install log (no secrets): %s' ;;
	lbl_mode) m 'mode          ' ;;
	lbl_version) m 'version       ' ;;
	lbl_address) m 'address       ' ;;
	lbl_admin) m 'admin         ' ;;
	lbl_ports) m 'ports         ' ;;
	lbl_node) m 'node address  ' ;;
	lbl_restore) m 'restore from  ' ;;
	lbl_console) m 'admin console ' ;;
	lbl_portal) m 'user portal   ' ;;
	lbl_admin_login) m 'admin login   ' ;;
	lbl_password) m 'password      ' ;;
	next_log_in_settings) m '1. log in → 系统设置 (settings): check the main, subscription and node domains' ;;
	next_add_node) m '2. nodes → add a node → run its one-line install command on the node' ;;
	next_backup) m '3. backups: %s backup (set AGE_RECIPIENT in %s to encrypt); upgrades: %s upgrade; health: %s status' ;;
	next_signed_backups) m '4. backups are signed by default: keep the backup verification public key printed by %s info offline (you need it to restore on a new host)' ;;
	services_removed_kept) m 'services removed; kept: data and configuration (%s)' ;;
	repository_key_fingerprint_mismatch) m '%s repository key fingerprint mismatch (expected %s, got %s)' ;;
	help_title) m 'Akari panel installer / akari-ctl' ;;
	help_usage) m 'Usage:
  install.sh [install] [options]       install (interactive unless --yes)
  install.sh upgrade [--version vX]    upgrade (backup, verify, switch, health check, rollback)
  install.sh backup [--out DIR] [--age-recipient age1...] [--with-agent-releases]
  install.sh migrate --to docker|bare  move this installation to the other mode
  install.sh uninstall [--purge [--confirm purge]]
  install.sh status | info

The interface is Simplified Chinese by default and needs a UTF-8 terminal (set your SSH
client to UTF-8). If zh_CN.UTF-8 is missing the installer installs it for this run (the
system default locale is not changed); if that fails the run is English. --lang en = English.' ;;
	help_options_heading) m 'Options (environment variable in brackets)' ;;
	help_options) m '  -y, --yes                 non-interactive: defaults for everything not given
  --mode bare|docker        [AKARI_MODE]       default docker
  --domain NAME             [AKARI_DOMAIN]     main domain; empty = IP only
  --ip ADDRESS              [AKARI_PUBLIC_IP]  public address (IP-only installs)
  --email ADDRESS           [AKARI_EMAIL]      ACME account e-mail (optional)
  --admin EMAIL             [AKARI_ADMIN]      admin login (default: --email, else admin@<domain>)
  --admin-password-file F   [AKARI_ADMIN_PASSWORD] default: generated, printed once
  --node-address HOST[:P]   [AKARI_NODE_ADDRESS] address agents dial (default: domain / IP;
                            required when the domain is behind Cloudflare: DNS-only name or IP)
  --http-port N --https-port N --grpc-port N   default 80 / 443 / 8443
  --version vX.Y.Z          [AKARI_VERSION]    default: this installer'\''s release / latest
  --dir DIR                 [AKARI_DOCKER_DIR] compose directory (default /opt/akari)
  --local-certs             Caddy'\''s internal CA for every name (test / LAN names)
  --restore DIR             install from a backup made by `backup` (host moves)
  --age-identity FILE       age key to decrypt an encrypted backup (--restore)
  --backup-verify-key FILE  public key (PEM) the backup'\''s SHA256SUMS.sig must verify with (--restore)
  --lang zh|en              [AKARI_LANG]       language (default Chinese; en skips the zh_CN locale install)
  --force                   reinstall / re-run the upgrade of the same version' ;;
	help_testing_heading) m 'Testing / private mirrors' ;;
	help_testing) m '  AKARI_RELEASES_URL (release base), AKARI_COSIGN_KEY (verify with a cosign public key instead
  of the keyless release identity), AKARI_SOURCE_DIR (deploy files from a source tree),
  AKARI_NO_BANNER=1 (no banner).' ;;
	*) m "$1" ;;
	esac
}

# AKARI_INSTALL_LIB=1: define the functions only (installer-test/validators.sh).
[ "${AKARI_INSTALL_LIB:-}" = 1 ] || main "$@"
