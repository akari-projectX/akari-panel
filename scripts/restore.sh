#!/usr/bin/env bash
# Restore an Akari backup made by scripts/backup.sh. See docs/BACKUP.md.
#
#   restore.sh [--force] <backup dir>
#
# Stop the panel first. The target database must be empty (a fresh
# `createdb`: pg_restore --clean cannot drop the partitions of the
# partitioned traffic_daily, so an existing database is not cleaned); with
# --force a non-empty data dir is replaced (the old one is moved aside to
# <data dir>.pre-restore-<ts>).
#
# Plain backups (backup.sh AKARI_BACKUP_PLAINTEXT=1: db.dump, data.tar) need
# no key. config.tar(.age), when present, is not restored (the target's
# configuration is its own; the installer generates it).
#
# Configuration (environment):
#   AGE_IDENTITY_FILE      age private key able to decrypt the backup   [.age backups]
#   AKARI_BACKUP_VERIFY_KEY  PEM public key matching the backup's
#                          AKARI_BACKUP_SIGN_KEY: when set, the backup must
#                          carry a valid SHA256SUMS.sig, else the restore stops.
#                          Without it the checksums prove integrity only (the
#                          backup is not damaged), not who made it.
#   DATABASE_URL           target PostgreSQL URL                         [required*]
#   AKARI_PG_RESTORE_CMD   alternative command reading a custom-format dump
#                          on stdin, e.g.
#                          'docker compose exec -T postgres pg_restore -U akari -d akari --no-owner --single-transaction'
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
: "${AKARI_DATA_DIR:?set AKARI_DATA_DIR}"
need tar; need sha256sum
if [ -f "$src/db.dump.age" ]; then
  ext=.age
  : "${AGE_IDENTITY_FILE:?set AGE_IDENTITY_FILE (the backup is age-encrypted)}"
  need age
  open() { age -d -i "$AGE_IDENTITY_FILE" "$1"; }
elif [ -f "$src/db.dump" ]; then
  ext=
  open() { cat "$1"; }
else
  die "$src holds no db.dump(.age): not a backup.sh directory"
fi

if [ -n "${AKARI_BACKUP_VERIFY_KEY:-}" ]; then
  need openssl
  [ -r "$AKARI_BACKUP_VERIFY_KEY" ] || die "cannot read AKARI_BACKUP_VERIFY_KEY"
  [ -f "$src/SHA256SUMS.sig" ] || die "the backup carries no SHA256SUMS.sig but AKARI_BACKUP_VERIFY_KEY is set: refusing to restore an unsigned backup"
  openssl dgst -sha256 -verify "$AKARI_BACKUP_VERIFY_KEY" -signature "$src/SHA256SUMS.sig" "$src/SHA256SUMS" >/dev/null 2>&1 \
    || die "signature mismatch: SHA256SUMS was not signed by the holder of AKARI_BACKUP_VERIFY_KEY (not made by the backup host, or modified): refusing to restore"
  echo "restore: signature verified"
fi
echo "restore: checking checksums"
(cd "$src" && sha256sum --check --quiet SHA256SUMS) || die "checksum mismatch: the backup files differ from SHA256SUMS (damaged or modified)"
if [ -z "${AKARI_BACKUP_VERIFY_KEY:-}" ]; then
  echo "restore: NOTE: checksums give integrity only, not authenticity (the files are intact, nothing more): anyone who can write to the backup storage can rewrite them together with SHA256SUMS. Set AKARI_BACKUP_VERIFY_KEY to check the signature (docs/BACKUP.md)" >&2
fi

if [ -n "${AKARI_PG_RESTORE_CMD:-}" ]; then
  load() { bash -c "$AKARI_PG_RESTORE_CMD"; }
else
  : "${DATABASE_URL:?set DATABASE_URL (or AKARI_PG_RESTORE_CMD)}"
  need pg_restore
  load() { pg_restore --no-owner --exit-on-error --single-transaction --dbname "$DATABASE_URL"; }
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
open "$src/data.tar$ext" | tar -C "$AKARI_DATA_DIR" -xpf -
[ -z "${AKARI_OWNER:-}" ] || chown -R "$AKARI_OWNER" "$AKARI_DATA_DIR"

echo "restore: database"
open "$src/db.dump$ext" | load

echo "restore: done. Start the panel and check 'akari info' shows the same admin prefix."
