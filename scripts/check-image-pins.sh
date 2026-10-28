#!/bin/sh
# Every container image the repository pulls is pinned by digest
# (`name:tag@sha256:…`; the tag stays for humans and Dependabot's docker
# ecosystems). Checks Dockerfiles (FROM), compose files and workflow service
# images (`image:`), BuildKit `# syntax=` directives, and `docker run` image arguments in the CI workflows.
# A stage of the same Dockerfile and `scratch` are not pulled.
set -eu
cd "$(dirname "$0")/.."
bad=0

# FROM lines: a stage of the same Dockerfile, scratch and a stage picked by
# a build arg (base-${...}: every candidate stage is itself pinned) are fine.
for f in $(git ls-files 'Dockerfile' '*/Dockerfile'); do
	stages=$(sed -n 's/^FROM .* [Aa][Ss] \([A-Za-z0-9_.-]*\)$/\1/p' "$f" | tr '\n' ' ')
	refs=$(sed -n 's/^FROM \(--[a-z]*=[^ ]* \)*\([^ ]*\).*/\2/p' "$f")
	for ref in $refs; do
		case "$ref" in
		scratch | *@sha256:* | base-\$\{*) continue ;;
		esac
		case " $stages " in
		*" $ref "*) continue ;;
		esac
		echo "unpinned FROM in $f: $ref" >&2
		bad=1
	done
done

# BuildKit frontend directives (`# syntax=…`) are pulled images too.
for f in $(git ls-files 'Dockerfile' '*/Dockerfile'); do
	syntax=$(sed -n '1,/^[^#]/s/^# *syntax=\([^ ]*\).*/\1/p' "$f")
	case "$syntax" in
	'' | *@sha256:*) ;;
	*)
		echo "unpinned syntax directive in $f: $syntax" >&2
		bad=1
		;;
	esac
done

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
