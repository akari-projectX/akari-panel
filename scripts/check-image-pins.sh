#!/bin/sh
# Every container image the repository pulls is pinned by digest
# (`name:tag@sha256:…`; the tag stays for humans and Dependabot's docker
# ecosystems). Checks Dockerfiles (FROM), compose files and workflow service
# images (`image:`), and `docker run` image arguments in the CI workflows.
# A stage of the same Dockerfile and `scratch` are not pulled.
set -eu
cd "$(dirname "$0")/.."
bad=0

dockerfiles=$(git ls-files 'Dockerfile' '*/Dockerfile')
for f in $dockerfiles; do
	stages=$(sed -n 's/^FROM .* [Aa][Ss] \([A-Za-z0-9_.-]*\)$/\1/p' "$f")
	sed -n 's/^FROM \(--[a-z]*=[^ ]* \)*\([^ ]*\).*/\2/p' "$f" | while read -r ref; do
		case "$ref" in
		scratch | *@sha256:*) continue ;;
		base-\$\{*) continue ;; # stage chosen by build arg: all candidate stages are pinned
		esac
		if ! printf '%s\n' "$stages" | grep -qx "$ref"; then
			echo "unpinned FROM in $f: $ref" >&2
			echo bad
		fi
	done
done | grep -q bad && bad=1

images=$(git ls-files '*compose*.yml' '.github/workflows/*.yml' |
	xargs grep -Hn -E '^[[:space:]]*image:[[:space:]]+[a-z]' 2>/dev/null |
	grep -v '@sha256:' | grep -v 'AKARI_IMAGE' || true)
if [ -n "$images" ]; then
	printf 'unpinned image: reference:\n%s\n' "$images" >&2
	bad=1
fi

# shellcheck disable=SC2016 # the awk program is single-quoted on purpose
runs=$(git ls-files '.github/workflows/*.yml' scripts smoke.sh |
	xargs awk '/docker run/ {
		for (i = 1; i <= NF; i++) {
			t = $i; gsub(/["'"'"']/, "", t)
			if (t ~ /^[a-z0-9.-]+(\/[a-z0-9._-]+)*:[A-Za-z0-9._-]+$/ && t !~ /^akari-/ && t !~ /^-/ && t !~ /^\// && t !~ /^[0-9]+:/ && t !~ /\.test:/)
				print FILENAME ":" FNR ": " t
		}
	}' || true)
if [ -n "$runs" ]; then
	printf 'unpinned docker run image:\n%s\n' "$runs" >&2
	bad=1
fi
[ "$bad" = 0 ] && echo "image pins: ok"
exit "$bad"
