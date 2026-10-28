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

# qdisc_refresh: put the kernel's current default qdisc on the interfaces
# the default routes use now, not at the next boot (net.core.default_qdisc
# only applies to qdiscs created after it changes). Only interfaces whose
# egress qdiscs are all the kernel's own (handle 0:, nobody configured
# them): grafting a configured root and deleting it makes the kernel attach
# its defaults again (mq with one child per queue on multiqueue NICs);
# queued packets are dropped once, which TCP recovers from. Sets QDISC_DONE
# (interfaces changed), QDISC_LEFT (interfaces that keep the old qdisc
# until a reboot: configured by hand, or a failed change) and QDISC_NO_TC
# (1: no tc/ip here, nothing looked at).
# shellcheck disable=SC2034 # QDISC_NO_TC is read by the installer (bbr_qdisc)
qdisc_refresh() {
	QDISC_DONE=
	QDISC_LEFT=
	QDISC_NO_TC=
	q_want=$(cat /proc/sys/net/core/default_qdisc 2>/dev/null) || return 0
	if ! command -v tc >/dev/null 2>&1 || ! command -v ip >/dev/null 2>&1; then
		QDISC_NO_TC=1
		return 0
	fi
	for q_dev in $({ ip -o -4 route show default; ip -o -6 route show default; } 2>/dev/null |
		awk '{ for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1) }' | sort -u); do
		case "$q_dev" in
		'' | *[!A-Za-z0-9_.-]*) continue ;;
		esac
		q_show=$(LC_ALL=C tc qdisc show dev "$q_dev" 2>/dev/null) || continue
		# 0 = nothing to do (already the default, or no queue at all:
		# tunnels and other virtual interfaces), 1 = kernel defaults to
		# refresh, 2 = configured by someone: left alone.
		q_state=$(printf '%s\n' "$q_show" | awk -v w="$q_want" '
			$1 != "qdisc" || $2 == "ingress" || $2 == "clsact" || $2 == "noqueue" { next }
			{ n++ }
			$3 != "0:" { bad = 1 }
			$2 != "mq" && $2 != w { stale = 1 }
			END { print (!n || bad) ? (stale ? 2 : 0) : (stale ? 1 : 0) }')
		case "$q_state" in
		1)
			if tc qdisc replace dev "$q_dev" root pfifo >/dev/null 2>&1 &&
				tc qdisc del dev "$q_dev" root >/dev/null 2>&1; then
				QDISC_DONE="${QDISC_DONE:+$QDISC_DONE }$q_dev"
			else
				QDISC_LEFT="${QDISC_LEFT:+$QDISC_LEFT }$q_dev"
			fi
			;;
		2) QDISC_LEFT="${QDISC_LEFT:+$QDISC_LEFT }$q_dev" ;;
		esac
	done
}

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
	note bbr_removed "$BBR_CONF" "${prev:--}"
	qdisc_refresh
	if [ -n "$QDISC_DONE" ]; then
		note qdisc_now "$QDISC_DONE" "$(cat /proc/sys/net/core/default_qdisc 2>/dev/null)"
	fi
}

uninstall() {
	step uninstalling_agent
	if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
		systemctl disable --now akari-agent-update.path >/dev/null 2>&1 || true
		systemctl stop akari-agent-update.service >/dev/null 2>&1 || true
		systemctl disable --now akari-agent.service >/dev/null 2>&1 || true
	fi
	# W28-a: the relay entrances' source allowlists (the agent's own table).
	if command -v nft >/dev/null 2>&1; then
		nft delete table inet akari_sources >/dev/null 2>&1 || true
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
	step_end
	ok agent_removed
}
