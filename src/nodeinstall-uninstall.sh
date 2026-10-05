# Shared by the installer and the uninstaller it writes (nodeinstall.rs).
BIN=/usr/local/bin/akari-agent
CONF_DIR=/etc/akari-agent
UNIT=/etc/systemd/system/akari-agent.service
UPDATE_SERVICE=/etc/systemd/system/akari-agent-update.service
UPDATE_PATH=/etc/systemd/system/akari-agent-update.path
DROPIN_DIR=/etc/systemd/system/akari-agent.service.d
# W32: OpenRC (Alpine): the agent and its updater as init scripts, a system
# user, the state directory bind-mounted noexec, logs in /var/log.
RC_AGENT=/etc/init.d/akari-agent
RC_UPDATE=/etc/init.d/akari-agent-update
RC_STATE=/var/lib/akari-agent
RC_LOG=/var/log/akari-agent
UNINSTALLER=/usr/local/sbin/akari-agent-uninstall
# W32: TCP BBR + fq (installer; --no-bbr / AKARI_BBR=0 skips it).
BBR_CONF=/etc/sysctl.d/90-akari-bbr.conf
BBR_MOD=/etc/modules-load.d/akari-bbr.conf

say() { printf 'akari-install: %s\n' "$*" >&2; }

# bbr_remove: drop what the installer added for BBR + fq and put the
# previous settings back while ours are still in effect (nothing else
# changed them since).
bbr_remove() {
	[ -f "$BBR_CONF" ] || return 0
	prev=$(sed -n 's/^# akari-previous: //p' "$BBR_CONF")
	rm -f "$BBR_CONF" "$BBR_MOD"
	for kv in $prev; do
		k=${kv%%=*}
		v=${kv#*=}
		case "$k" in
		net.core.default_qdisc) ours=fq ;;
		net.ipv4.tcp_congestion_control) ours=bbr ;;
		*) continue ;;
		esac
		case "$v" in
		'' | *[!a-z0-9_]*) continue ;;
		esac
		f=/proc/sys/$(printf '%s' "$k" | tr . /)
		if [ "$(cat "$f" 2>/dev/null)" = "$ours" ]; then
			printf '%s' "$v" >"$f" 2>/dev/null || true
		fi
	done
	say "BBR + fq: removed $BBR_CONF (previous settings put back: ${prev:-none recorded})"
}

uninstall() {
	if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
		systemctl disable --now akari-agent-update.path >/dev/null 2>&1 || true
		systemctl stop akari-agent-update.service >/dev/null 2>&1 || true
		systemctl disable --now akari-agent.service >/dev/null 2>&1 || true
	fi
	if command -v rc-service >/dev/null 2>&1; then
		for s in akari-agent-update akari-agent; do
			if [ -f "/etc/init.d/$s" ]; then
				rc-service "$s" stop >/dev/null 2>&1 || true
				rc-update del "$s" default >/dev/null 2>&1 || true
			fi
		done
	fi
	# The OpenRC script's noexec bind mount of the state directory.
	if awk -v d="$RC_STATE" '$5 == d { f = 1 } END { exit !f }' /proc/self/mountinfo 2>/dev/null; then
		umount "$RC_STATE" 2>/dev/null || umount -l "$RC_STATE" 2>/dev/null || true
	fi
	rm -f "$UNIT" "$UPDATE_SERVICE" "$UPDATE_PATH" "$RC_AGENT" "$RC_UPDATE" "$BIN" "$BIN.prev" "$UNINSTALLER"
	rm -rf "$DROPIN_DIR" "$CONF_DIR" /var/lib/private/akari-agent "$RC_STATE" /var/lib/akari-agent-update \
		"$RC_LOG" /run/credentials/akari-agent.service
	rm -f /var/log/akari-agent-update.log /var/log/akari-agent-update.log.1
	if grep -q '^akari-agent:' /etc/passwd 2>/dev/null && command -v deluser >/dev/null 2>&1; then
		deluser akari-agent >/dev/null 2>&1 || true
	fi
	if grep -q '^akari-agent:' /etc/group 2>/dev/null && command -v delgroup >/dev/null 2>&1; then
		delgroup akari-agent >/dev/null 2>&1 || true
	fi
	if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
		systemctl daemon-reload || true
	fi
	bbr_remove
	say "akari-agent removed (binary, services, /etc/akari-agent, state). Delete the node in the panel as well."
}
