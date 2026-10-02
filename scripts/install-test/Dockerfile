# Throw-away "node" for the one-line installer and self-update tests
# (smoke.sh, R18-2 / M6 + W18): Debian 13 with systemd as PID 1 and curl.
# Run it privileged with --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw
# and --tmpfs /var/lib/private:mode=0700 (the container's overlayfs cannot
# be idmapped, so without it systemd would NOT mount the agent's
# StateDirectory noexec,idmapped as it does on a real VPS). Test use only.
FROM debian:13
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask systemd-firstboot.service getty.target console-getty.service \
      systemd-logind.service systemd-networkd.service systemd-resolved.service \
      systemd-timesyncd.service
STOPSIGNAL SIGRTMIN+3
# systemd credentials (LoadCredential=, used by the agent unit) need shared
# mount propagation; docker makes / private.
CMD ["/bin/sh", "-c", "mount --make-rshared / && exec /sbin/init"]
