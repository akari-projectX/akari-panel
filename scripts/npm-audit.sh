#!/usr/bin/env bash
# `npm audit --audit-level=high`, retried (up to 3 attempts) only when the
# registry's audit endpoint itself failed. A real finding fails at once.
# Run from portal/ or admin/.
set -uo pipefail

out="$(mktemp)"
trap 'rm -f "$out"' EXIT
for attempt in 1 2 3; do
  if npm audit --audit-level=high >"$out" 2>&1; then
    cat "$out"
    exit 0
  fi
  cat "$out"
  if [ "$attempt" -lt 3 ] && grep -qiE 'audit endpoint returned an error|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up' "$out"; then
    echo "npm audit: registry/network error, retrying ($attempt/3)" >&2
    sleep $((attempt * 10))
    continue
  fi
  exit 1
done
