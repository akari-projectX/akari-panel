# Throw-away "fresh VPS" for the panel installer's end-to-end test
# (scripts/installer-test/bare-e2e.sh, CI job installer-bare): Debian 13 or
# Ubuntu 24.04 with systemd as PID 1 and nothing else the installer would
# otherwise install itself. Test use only. Run it privileged; on a cgroup v2
# host with --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw (as the
# agent's systemd test). On a cgroup v1 host the command mounts a cgroup2
# hierarchy for systemd (no controllers; enough for these tests).
# Base images pinned by digest; BASE_KEY (debian-13, ubuntu-24-04) picks one.
ARG BASE_KEY=debian-13
FROM debian:13@sha256:4c25275446ca371766b8b093c696782eabce06263fccacb8d5d813b3dc44b308 AS base-debian-13
FROM ubuntu:24.04@sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c AS base-ubuntu-24-04

FROM base-${BASE_KEY}
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv curl ca-certificates sudo \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask systemd-firstboot.service getty.target console-getty.service \
      systemd-logind.service systemd-networkd.service systemd-resolved.service \
      systemd-timesyncd.service systemd-modules-load.service
STOPSIGNAL SIGRTMIN+3
# LoadCredential= (akari-valkey.service) needs shared mount propagation.
CMD ["/bin/sh", "-c", "mount --make-rshared /; if [ \"$(stat -fc %T /sys/fs/cgroup)\" != cgroup2fs ]; then umount -R /sys/fs/cgroup 2>/dev/null; mount -t cgroup2 none /sys/fs/cgroup; fi; exec /sbin/init"]
