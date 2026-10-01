#!/usr/bin/env bash
# Encrypted backup of an Akari panel: PostgreSQL (custom format) + the data
# directory (route prefix, CA private key, jwt.key). See docs/BACKUP.md.
#
# Output: $AKARI_BACKUP_DIR/akari-<UTC timestamp>/
#   db.dump.age     pg_dump --format=custom, age-encrypted
#   data.tar.age    tar of the data directory, age-encrypted
#   MANIFEST        versions, timestamp, source host (no secrets)
#   SHA256SUMS      of the two .age files
# Nothing sensitive is ever written to disk unencrypted (both streams are
# piped through age). Encryption is to PUBLIC age recipients, so the host
# that runs backups never holds a key that can read them.
#
# Configuration (environment):
#   DATABASE_URL           PostgreSQL URL (as for the panel)             [required*]
#   AKARI_PG_DUMP_CMD      alternative command that writes a custom-format
#                          dump to stdout, e.g.
#                          'docker compose exec -T postgres pg_dump -U akari -Fc akari'
#                          (use when pg_dump on the host is older than the server)
#   AKARI_DATA_DIR         the panel's data_dir                           [required]
#   AKARI_BACKUP_DIR       where backups go                               [required]
#   AGE_RECIPIENT          an age public key (age1...) ...                [one of]
#   AGE_RECIPIENTS_FILE    ... or a file of recipients (age -R)           [these]
#   AKARI_KEEP_DAYS        delete backups older than this (default 14) ...
#   AKARI_KEEP_MIN         ... but always keep at least this many (default 3)
#   AKARI_VERIFY_IDENTITY  optional age identity file: when set, the fresh
#                          backup is decrypted and checked (pg_restore --list,
#                          tar -t) before success is reported
#   * not needed when AKARI_PG_DUMP_CMD is set.
set -euo pipefail
umask 077

die() { echo "backup: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found in PATH"; }

: "${AKARI_DATA_DIR:?set AKARI_DATA_DIR}"
: "${AKARI_BACKUP_DIR:?set AKARI_BACKUP_DIR}"
KEEP_DAYS="${AKARI_KEEP_DAYS:-14}"
KEEP_MIN="${AKARI_KEEP_MIN:-3}"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ && "$KEEP_MIN" =~ ^[0-9]+$ ]] || die "AKARI_KEEP_DAYS / AKARI_KEEP_MIN must be integers"
[ -d "$AKARI_DATA_DIR" ] || die "data dir $AKARI_DATA_DIR does not exist"

need age; need tar; need sha256sum
age_args=()
if [ -n "${AGE_RECIPIENTS_FILE:-}" ]; then
  [ -r "$AGE_RECIPIENTS_FILE" ] || die "cannot read AGE_RECIPIENTS_FILE"
  age_args=(-R "$AGE_RECIPIENTS_FILE")
elif [ -n "${AGE_RECIPIENT:-}" ]; then
  age_args=(-r "$AGE_RECIPIENT")
else
  die "set AGE_RECIPIENT or AGE_RECIPIENTS_FILE (age public key); see docs/BACKUP.md"
fi

if [ -n "${AKARI_PG_DUMP_CMD:-}" ]; then
  dump() { bash -c "$AKARI_PG_DUMP_CMD"; }
else
  : "${DATABASE_URL:?set DATABASE_URL (or AKARI_PG_DUMP_CMD)}"
  need pg_dump
  dump() { pg_dump --format=custom --no-owner --dbname "$DATABASE_URL"; }
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$AKARI_BACKUP_DIR"
out="$AKARI_BACKUP_DIR/akari-$ts"
tmp="$out.partial"
[ ! -e "$out" ] || die "$out already exists"
mkdir "$tmp"
trap 'rm -rf "$tmp"' EXIT

echo "backup: database -> $out/db.dump.age"
dump | age "${age_args[@]}" >"$tmp/db.dump.age"
[ -s "$tmp/db.dump.age" ] || die "empty database dump"

echo "backup: data dir  -> $out/data.tar.age"
tar -C "$AKARI_DATA_DIR" --numeric-owner -cf - . | age "${age_args[@]}" >"$tmp/data.tar.age"

{
  echo "created_utc=$ts"
  echo "host=$(uname -n)"
  echo "akari=$(akari --version 2>/dev/null || echo unknown)"
  echo "format=1 (db.dump.age: pg_dump -Fc; data.tar.age: tar of data_dir; age-encrypted)"
} >"$tmp/MANIFEST"
(cd "$tmp" && sha256sum db.dump.age data.tar.age >SHA256SUMS)

if [ -n "${AKARI_VERIFY_IDENTITY:-}" ]; then
  need pg_restore
  echo "backup: verifying (decrypt + list)"
  age -d -i "$AKARI_VERIFY_IDENTITY" "$tmp/db.dump.age" | pg_restore --list >/dev/null \
    || die "verification failed: database dump unreadable"
  age -d -i "$AKARI_VERIFY_IDENTITY" "$tmp/data.tar.age" | tar -tf - >/dev/null \
    || die "verification failed: data archive unreadable"
fi

mv "$tmp" "$out"
trap - EXIT
echo "backup: done: $out ($(du -sh "$out" | cut -f1))"

# Retention: drop backups older than KEEP_DAYS, never below KEEP_MIN newest.
mapfile -t all < <(find "$AKARI_BACKUP_DIR" -maxdepth 1 -type d -name 'akari-????????T??????Z' | sort -r)
idx=0
for d in "${all[@]}"; do
  idx=$((idx + 1))
  [ "$idx" -le "$KEEP_MIN" ] && continue
  if [ -n "$(find "$d" -maxdepth 0 -mtime "+$KEEP_DAYS")" ]; then
    echo "backup: retention: removing $d"
    rm -rf "$d"
  fi
done
