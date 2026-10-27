# Presentation of the node installer and of the uninstaller it writes
# (nodeinstall.rs puts this in front of nodeinstall-uninstall.sh). The block
# between the markers is the same text as in scripts/install.sh
# (scripts/installer-test/ui-check.py --sync copies it, and checks it).
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

# The node installer is not interactive and keeps no log file: step failures
# quote the temporary log the installer sets up (UI_LOG), never its path.
INTERACTIVE=0
UI_LOG=''
UI_SHOWLOG=0
ui_log() { :; }

# The messages both scripts need; the installer's own come first in
# msg_zh / msg_en (nodeinstall.sh), the uninstaller's msg_zh / msg_en only
# fall back to these.
# shellcheck disable=SC2016 # the texts quote $ and ` literally
msg_zh_core() {
	case "$1" in
	ui_warning) m '警告：' ;;
	ui_error) m '错误：' ;;
	ui_log_is) m '日志：' ;;
	ui_last_lines) m '该步骤最近的输出：' ;;
	ui_default) m '默认' ;;
	ui_pick_number) m '请输入 1 到 %s 之间的编号' ;;
	unknown_language) m '不支持的语言：%s（可用 zh、en）' ;;
	cancelled) m '已取消' ;;
	uninstalling_agent) m '移除 Akari agent' ;;
	bbr_removed) m 'BBR + fq：已移除 %s（已恢复之前的设置：%s）' ;;
	agent_removed) m 'akari-agent 已移除（二进制、服务、/etc/akari-agent、状态目录）。请同时在面板中删除该节点。' ;;
	banner_uninstall) m '节点卸载器' ;;
	unknown_option) m '未知参数：%s' ;;
	run_as_root_plain) m '请以 root 运行' ;;
	refuse_without_yes) m '没有确认不会卸载：请加 --yes' ;;
	confirm_uninstall) m '从本机移除 Akari agent 及其数据？' ;;
	uninstall_usage) m '用法：akari-agent-uninstall [--yes] [--lang zh|en]

从本机移除 Akari agent：服务、二进制、/etc/akari-agent（引导文件、证书）、
状态目录，以及安装器添加的 BBR + fq 设置。请同时在面板中删除该节点。

选项：
  -y, --yes   不再询问确认（不在终端中运行时必须加）
  --lang      界面语言 zh 或 en（也可用 AKARI_LANG；默认中文，需要 UTF-8 终端）
  -h, --help  显示本帮助并退出' ;;
	*) m "$1" ;;
	esac
}
msg_en_core() {
	case "$1" in
	ui_warning) m 'WARNING:' ;;
	ui_error) m 'ERROR:' ;;
	ui_log_is) m 'log:' ;;
	ui_last_lines) m 'last output of this step:' ;;
	ui_default) m 'default' ;;
	ui_pick_number) m 'enter a number from 1 to %s' ;;
	unknown_language) m 'unsupported language: %s (zh or en)' ;;
	cancelled) m 'cancelled' ;;
	uninstalling_agent) m 'Removing the Akari agent' ;;
	bbr_removed) m 'BBR + fq: removed %s (previous settings put back: %s)' ;;
	agent_removed) m 'akari-agent removed (binary, services, /etc/akari-agent, state). Delete the node in the panel as well.' ;;
	banner_uninstall) m 'node uninstaller' ;;
	unknown_option) m 'unknown option: %s' ;;
	run_as_root_plain) m 'run as root' ;;
	refuse_without_yes) m 'refusing to uninstall without confirmation: pass --yes' ;;
	confirm_uninstall) m 'Remove the Akari agent and its data from this machine?' ;;
	uninstall_usage) m 'Usage: akari-agent-uninstall [--yes] [--lang zh|en]

Remove the Akari agent from this machine: its services, binary,
/etc/akari-agent (bootstrap, certificates), state directory and the
BBR + fq settings the installer added. Delete the node in the panel as well.

Options:
  -y, --yes   do not ask for confirmation (required when not on a terminal)
  --lang      language zh or en (or AKARI_LANG; default Chinese, needs a UTF-8 terminal)
  -h, --help  show this help and exit' ;;
	*) m "$1" ;;
	esac
}

m() { printf '%s' "$1"; }
