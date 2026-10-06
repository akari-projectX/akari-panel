#!/usr/bin/env bash
# W37 tiered CI: which heavy job groups a change needs.
#
#   scripts/ci-changes.sh full              every group (push to main, nightly,
#                                           dispatch, release, `full-ci` label)
#   scripts/ci-changes.sh <base> <head>     groups touched by `git diff base head`
#
# Prints `<group>=true|false` lines (appended to $GITHUB_OUTPUT in Actions).
# The ci/fuzz workflows run a group's job for real when it is true and skip
# it otherwise (a skipped job satisfies a required check). Changes to CI
# itself (.github/, this script) select every group: they validate
# themselves. Fail-safe: the jobs also run when this script fails.
set -euo pipefail

GROUPS_ALL="rust smoke e2e installer docker fuzz"

# rust: the Rust code and what it compiles in (coverage gate, bench crate).
# smoke: the panel backend + the cross-repo contract (smoke.sh).
# e2e: the portal, the admin app and the backend that serves them
#   (Playwright, real CSP).
# installer: install/upgrade/backup/restore scripts and the deploy bundle.
# docker: the image and its dependency inputs (lockfiles, toolchain).
# fuzz: what the fuzz targets compile.
groups_of() {
  case "$1" in
    .github/* | scripts/ci-changes.sh) echo "$GROUPS_ALL" ;;
  esac
  case "$1" in
    src/* | tests/* | migrations/* | proto/* | testdata/* | bench/* | build.rs | \
      Cargo.toml | Cargo.lock | rust-toolchain.toml | deny.toml | scripts/coverage-gate.py)
      echo rust ;;
  esac
  case "$1" in
    src/* | migrations/* | proto/* | build.rs | Cargo.toml | Cargo.lock | rust-toolchain.toml | \
      smoke.sh | scripts/smoke-* | Makefile | docker-compose.yml | deploy/systemd/* | \
      deploy/panel.toml.example | scripts/install-test/* | scripts/install-test-alpine/*)
      echo smoke ;;
  esac
  case "$1" in
    spa/* | admin/* | src/spa.rs | src/console.rs | src/web.rs | scripts/e2e.sh | Makefile | docker-compose.yml)
      echo e2e ;;
  esac
  case "$1" in
    scripts/install.sh | scripts/installer-test/* | scripts/install-test/* | scripts/install-test-alpine/* | \
      scripts/backup.sh | \
      scripts/restore.sh | scripts/release-bundle.sh | deploy/* | Dockerfile | .dockerignore)
      echo installer ;;
  esac
  case "$1" in
    Dockerfile | .dockerignore | Cargo.toml | Cargo.lock | rust-toolchain.toml | \
      spa/package.json | spa/package-lock.json | admin/package.json | admin/package-lock.json | \
      deploy/prometheus/* | deploy/grafana/* | \
      scripts/monitoring-check.sh)
      echo docker ;;
  esac
  case "$1" in
    src/* | fuzz/* | Cargo.toml | Cargo.lock | rust-toolchain.toml)
      echo fuzz ;;
  esac
}

if [ "${1:-}" = full ]; then
  selected="$GROUPS_ALL"
else
  [ $# -eq 2 ] || { echo "usage: $0 full | <base> <head>" >&2; exit 2; }
  files="$(git diff --name-only "$1" "$2")"
  selected=""
  while IFS= read -r f; do
    [ -n "$f" ] && selected="$selected $(groups_of "$f" | tr '\n' ' ')"
  done <<<"$files"
  echo "changed files: $(printf '%s\n' "$files" | grep -c . || true)" >&2
fi

for g in $GROUPS_ALL; do
  case " $selected " in
    *" $g "*) echo "$g=true" ;;
    *) echo "$g=false" ;;
  esac
done | tee -a "${GITHUB_OUTPUT:-/dev/null}"
