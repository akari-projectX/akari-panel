#!/bin/sh
# Copy/paste detection (jscpd) over the three code trees, each against its own
# ceiling: the duplicated-lines share at the time the gate was introduced,
# (two decimals, rounded up). A change that adds duplicated code pushes a tree over
# its ceiling and fails; lower a ceiling in the same PR that removes
# duplication (never raise one: extract the shared code instead).
#
# Baseline (2026-10-28, jscpd 5.4.2, default min tokens/lines):
#   src        rust        2.67 % (2700 of ~101000 lines)
#   portal/src svelte + ts 0.71 % (144 of 20385 lines)
#   admin/src  ts + css    1.27 % (rounded up: 1.28) (754 of 59339 lines)
#
# Usage: scripts/jscpd.sh   (needs node/npx; make jscpd, part of make check)
set -eu
cd "$(dirname "$0")/.."

JSCPD="npx --yes jscpd@5.4.2"
# Tests (Rust test modules in their own files, vitest files), golden files,
# testdata and the portal dictionary are left out: they repeat by design.
IGNORE='**/tests/**,**/tests.rs,**/*_tests.rs,**/*.golden,**/testdata/**,**/dict.ts,**/*.test.ts,**/*.test.tsx'

scan() {
  tree=$1 formats=$2 ceiling=$3
  echo "== jscpd $tree (ceiling $ceiling %)"
  # shellcheck disable=SC2086
  $JSCPD "$tree" --format "$formats" --ignore "$IGNORE" --reporters console --silent \
    --no-colors --threshold "$ceiling"
}

scan src rust 2.67
scan portal/src typescript,javascript,svelte,css 0.71
scan admin/src typescript,tsx,javascript,css 1.28
