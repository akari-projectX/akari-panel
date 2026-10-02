# Shared by the installer and the uninstaller it writes (nodeinstall.rs).
BIN=/usr/local/bin/akari-agent
CONF_DIR=/etc/akari-agent
UNIT=/etc/systemd/system/akari-agent.service
UPDATE_SERVICE=/etc/systemd/system/akari-agent-update.service
UPDATE_PATH=/etc/systemd/system/akari-agent-update.path
DROPIN_DIR=/etc/systemd/system/akari-agent.service.d
UNINSTALLER=/usr/local/sbin/akari-agent-uninstall

say() { printf 'akari-install: %s\n' "$*" >&2; }
uninstall() {
	if command -v systemctl >/dev/null 2>&1; then
		systemctl disable --now akari-agent-update.path >/dev/null 2>&1 || true
		systemctl stop akari-agent-update.service >/dev/null 2>&1 || true
		systemctl disable --now akari-agent.service >/dev/null 2>&1 || true
	fi
	rm -f "$UNIT" "$UPDATE_SERVICE" "$UPDATE_PATH" "$BIN" "$BIN.prev" "$UNINSTALLER"
	rm -rf "$DROPIN_DIR" "$CONF_DIR" /var/lib/private/akari-agent /var/lib/akari-agent /var/lib/akari-agent-update
	if command -v systemctl >/dev/null 2>&1; then
		systemctl daemon-reload || true
	fi
	say "akari-agent removed (binary, units, /etc/akari-agent, state). Delete the node in the panel as well."
}
