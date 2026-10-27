# Throw-away Alpine "node" for the one-line installer under OpenRC
# (smoke.sh, W32): Alpine 3.22, OpenRC started as the container's init
# system (rc_sys="docker"; run with --init so something reaps what
# supervise-daemon leaves) and curl. Run it privileged: the agent's OpenRC
# script bind-mounts its state directory noexec, as on a VM. The same image
# as akari-agent's scripts/openrc-test. Test use only.
FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache openrc curl ca-certificates \
 && sed -i 's/^#\?rc_sys=.*/rc_sys="docker"/' /etc/rc.conf
CMD ["/bin/sh", "-c", "mkdir -p /run/openrc && touch /run/openrc/softlevel && openrc default >/dev/null 2>&1; exec sleep infinity"]
