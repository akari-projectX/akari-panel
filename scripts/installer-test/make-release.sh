#!/bin/sh
# A local "GitHub release" for the installer tests: the layout the installer
# downloads from (AKARI_RELEASES_URL=file://OUT), signed with a test cosign
# key pair (AKARI_COSIGN_KEY=OUT/cosign.pub) instead of the release
# workflow's keyless identity.
#
#   make-release.sh OUT TAG [--binary FILE] [--image REF] [--broken] [--latest]
#                   [--wrapper REAL_BINARY] [--schema-compat true|false]
#
#   --binary FILE  the panel binary (akari-linux-amd64; arm64 gets the same
#                  bytes: these tests run on amd64)
#   --image REF    image reference with digest for akari-panel-image.txt
#                  (default: a placeholder; docker mode needs a real one)
#   --broken       the binary is a stub that reports TAG's version and
#                  passes `config check` but cannot serve (rollback test)
#   --latest       also make TAG the "latest" release
#   --wrapper REAL a stub that reports TAG's version and runs REAL (a path on
#                  the machine under test) instead of a binary: a "newer"
#                  release without a second build (multi-instance upgrades)
#   --schema-compat  schema_compat_previous of the release (deploy/release.meta)
#
# Needs: cosign (COSIGN, default `cosign`), git, sha256sum.
set -eu
out=${1:?usage}
tag=${2:?usage}
shift 2
bin='' image='' broken=0 latest=0 wrapper='' compat=''
while [ $# -gt 0 ]; do
	case "$1" in
	--binary) bin=$2 && shift ;;
	--image) image=$2 && shift ;;
	--broken) broken=1 ;;
	--latest) latest=1 ;;
	--wrapper) wrapper=$2 && shift ;;
	--schema-compat) compat=$2 && shift ;;
	*) echo "make-release: unknown option $1" >&2 && exit 1 ;;
	esac
	shift
done
root=$(cd "$(dirname "$0")/../.." && pwd)
cosign=${COSIGN:-cosign}
ver=${tag#v}
dir="$out/download/$tag"
rm -rf "$dir"
mkdir -p "$dir"

if [ "$broken" = 1 ]; then
	cat >"$dir/akari-linux-amd64" <<STUB
#!/bin/sh
# Deliberately broken release (installer rollback test).
case "\$*" in
*--version*) echo "akari $ver (broken)" ;;
*"config check"*) echo "configuration OK (0 warnings)" ;;
*) echo "this release is broken on purpose" >&2; exit 1 ;;
esac
STUB
	chmod 0755 "$dir/akari-linux-amd64"
elif [ -n "$wrapper" ]; then
	cat >"$dir/akari-linux-amd64" <<STUB
#!/bin/sh
# Test release: reports TAG's version and runs the real panel binary.
case "\$*" in
*--version*) echo "akari $ver (wrapper)" ;;
*) exec $wrapper "\$@" ;;
esac
STUB
	chmod 0755 "$dir/akari-linux-amd64"
else
	[ -n "$bin" ] || { echo "make-release: --binary, --wrapper or --broken" >&2; exit 1; }
	install -m 0755 "$bin" "$dir/akari-linux-amd64"
fi
cp "$dir/akari-linux-amd64" "$dir/akari-linux-arm64"
printf '%s\n' "${image:-localhost:5000/akari-panel:$ver@sha256:0000000000000000000000000000000000000000000000000000000000000000}" >"$dir/akari-panel-image.txt"
if [ -n "$compat" ]; then
	"$root/scripts/release-bundle.sh" "$tag" "$dir" --schema-compat "$compat" >/dev/null
else
	"$root/scripts/release-bundle.sh" "$tag" "$dir" >/dev/null
fi
(cd "$dir" && sha256sum akari-linux-amd64 akari-linux-arm64 akari-panel-image.txt install.sh akari-deploy.tar.gz >SHA256SUMS)

if [ ! -f "$out/cosign.key" ]; then
	(cd "$out" && COSIGN_PASSWORD='' "$cosign" generate-key-pair >/dev/null 2>&1)
fi
COSIGN_PASSWORD='' "$cosign" sign-blob --yes --key "$out/cosign.key" --use-signing-config=false \
	--tlog-upload=false --bundle "$dir/SHA256SUMS.sigstore.json" "$dir/SHA256SUMS" >/dev/null 2>&1
"$cosign" verify-blob --key "$out/cosign.pub" --insecure-ignore-tlog=true \
	--bundle "$dir/SHA256SUMS.sigstore.json" "$dir/SHA256SUMS" >/dev/null 2>&1
if [ "$latest" = 1 ]; then
	mkdir -p "$out/latest"
	ln -sfn "../download/$tag" "$out/latest/download"
fi
echo "make-release: $dir"
