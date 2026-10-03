#!/bin/sh
# The installer's release assets (release.yml; the installer CI builds its
# fake releases the same way):
#
#   scripts/release-bundle.sh TAG OUTDIR
#
#   OUTDIR/install.sh            scripts/install.sh stamped with TAG (the
#                                installer of TAG installs TAG by default)
#   OUTDIR/akari-deploy.tar.gz   what the installer installs besides the
#                                binary/image: compose file, Caddyfile,
#                                systemd units, config examples, the backup
#                                scripts and the stamped installer
#                                (akari-ctl). Deterministic (sorted, fixed
#                                mtime/owner, gzip -n).
#
# Both are listed in the release's SHA256SUMS, which is cosign-signed.
set -eu
tag=${1:?usage: release-bundle.sh TAG OUTDIR}
out=${2:?usage: release-bundle.sh TAG OUTDIR}
case "$tag" in v[0-9]*) ;; *) echo "release-bundle: TAG must look like vX.Y.Z" >&2; exit 1 ;; esac
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sed "s/^INSTALLER_VERSION='@@AKARI_INSTALLER_VERSION@@'\$/INSTALLER_VERSION='$tag'/" \
	"$root/scripts/install.sh" >"$work/install.sh"
grep -q "^INSTALLER_VERSION='$tag'\$" "$work/install.sh" || { echo "release-bundle: cannot stamp install.sh" >&2; exit 1; }

mkdir -p "$work/b/deploy/caddy" "$work/b/deploy/systemd" "$work/b/deploy/env" "$work/b/deploy/nginx" "$work/b/scripts"
cp "$root/deploy/docker-compose.yml" "$root/deploy/.env.example" "$root/deploy/panel.toml.example" \
	"$root/deploy/panel.toml.compose.example" "$work/b/deploy/"
cp "$root/deploy/caddy/Caddyfile" "$work/b/deploy/caddy/"
cp "$root/deploy/nginx/akari.conf" "$work/b/deploy/nginx/"
cp "$root/deploy/env/"*.example "$work/b/deploy/env/"
cp "$root/deploy/systemd/akari-panel.service" "$root/deploy/systemd/akari.sysusers" \
	"$root/deploy/systemd/akari-valkey.service" "$work/b/deploy/systemd/"
cp "$root/scripts/backup.sh" "$root/scripts/restore.sh" "$work/b/scripts/"
cp "$work/install.sh" "$work/b/scripts/install.sh"
chmod 0755 "$work/b/scripts/"*.sh
find "$work/b" -type f ! -name '*.sh' -exec chmod 0644 {} +
find "$work/b" -type d -exec chmod 0755 {} +

epoch=${SOURCE_DATE_EPOCH:-$(git -C "$root" log -1 --format=%ct 2>/dev/null || echo 0)}
(cd "$work/b" && tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
	-cf - deploy scripts) | gzip -9n >"$out/akari-deploy.tar.gz"
install -m 0644 "$work/install.sh" "$out/install.sh"
echo "release-bundle: $out/install.sh $out/akari-deploy.tar.gz ($tag)"
