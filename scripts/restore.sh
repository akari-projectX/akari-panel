#!/usr/bin/env bash
# Restore an Akari backup made by scripts/backup.sh. See docs/BACKUP.md.
#
#   restore.sh [--force] <backup dir>
#
# Stop the panel first. The target database should be empty (a fresh
# `createdb`); with --force an existing database is cleaned (objects present
# in the dump are dropped and recreated) and a non-empty data dir is
# replaced (the old one is moved aside to <data dir>.pre-restore-<ts>).
#
# Configuration (environment):
#   AGE_IDENTITY_FILE      age private key able to decrypt the backup   [required]
#   DATABASE_URL           target PostgreSQL URL                         [required*]
#   AKARI_PG_RESTORE_CMD   alternative command reading a custom-format dump
#                          on stdin, e.g.
#                          'docker compose exec -T postgres pg_restore -U akari -d akari --clean --if-exists --no-owner --single-transaction'
#   AKARI_DATA_DIR         target data_dir                               [required]
#   AKARI_OWNER            user:group to chown the data dir to (needs root)
set -euo pipefail
umask 077

die() { echo "restore: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found in PATH"; }

force=0
if [ "${1:-}" = "--force" ]; then force=1; shift; fi
src="${1:-}"
[ -n "$src" ] && [ -d "$src" ] || die "usage: restore.sh [--force] <backup dir>"
: "${AGE_IDENTITY_FILE:?set AGE_IDENTITY_FILE}"
: "${AKARI_DATA_DIR:?set AKARI_DATA_DIR}"
need age; need tar; need sha256sum

echo "restore: checking checksums"
(cd "$src" && sha256sum --check --quiet SHA256SUMS) || die "checksum mismatch: the backup is damaged or tampered with"

if [ -n "${AKARI_PG_RESTORE_CMD:-}" ]; then
  load() { bash -c "$AKARI_PG_RESTORE_CMD"; }
else
  : "${DATABASE_URL:?set DATABASE_URL (or AKARI_PG_RESTORE_CMD)}"
  need pg_restore
  load() { pg_restore --clean --if-exists --no-owner --single-transaction --dbname "$DATABASE_URL"; }
fi

if [ -d "$AKARI_DATA_DIR" ] && [ -n "$(ls -A "$AKARI_DATA_DIR" 2>/dev/null)" ]; then
  [ "$force" = 1 ] || die "$AKARI_DATA_DIR is not empty (use --force to move it aside and restore)"
  aside="$AKARI_DATA_DIR.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "restore: moving existing data dir to $aside"
  mv "$AKARI_DATA_DIR" "$aside"
fi

echo "restore: data dir -> $AKARI_DATA_DIR"
mkdir -p "$AKARI_DATA_DIR"
chmod 700 "$AKARI_DATA_DIR"
age -d -i "$AGE_IDENTITY_FILE" "$src/data.tar.age" | tar -C "$AKARI_DATA_DIR" -xpf -
[ -z "${AKARI_OWNER:-}" ] || chown -R "$AKARI_OWNER" "$AKARI_DATA_DIR"

echo "restore: database"
age -d -i "$AGE_IDENTITY_FILE" "$src/db.dump.age" | load

echo "restore: done. Start the panel and check 'akari info' shows the same route prefix."
