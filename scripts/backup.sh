#!/usr/bin/env bash
# Encrypted backup of an Akari panel: PostgreSQL (custom format) + the data
# directory (admin prefix seed, CA private key, jwt.key, master.key). See docs/BACKUP.md.
#
# Output: $AKARI_BACKUP_DIR/akari-<UTC timestamp>/
#   db.dump.age     pg_dump --format=custom, age-encrypted
#   data.tar.age    tar of the data directory, age-encrypted
#   config.tar.age  the files in AKARI_CONFIG_FILES (optional), age-encrypted
#   MANIFEST        versions, timestamp, source host (no secrets)
#   SHA256SUMS      of the data files and MANIFEST
#   SHA256SUMS.sig  optional (AKARI_BACKUP_SIGN_KEY): ECDSA signature of SHA256SUMS
# Nothing sensitive is ever written to disk unencrypted (every stream is
# piped through age). Encryption is to PUBLIC age recipients, so the host
# that runs backups never holds a key that can read them.
#
# Plain mode (AKARI_BACKUP_PLAINTEXT=1, explicit; the installer's pre-upgrade
# backup when no recipient is configured, and its same-host migration):
# db.dump / data.tar / config.tar, unencrypted, directory 0700 and files
# 0600, with a warning. They hold the CA key, jwt.key, master.key and the
# database: never copy them off the host unencrypted.
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
#   AGE_RECIPIENTS_FILE    ... or a file of recipients (age -R)           [these,]
#   AKARI_BACKUP_PLAINTEXT=1  ... or plain files (see above)               [or this]
#   AKARI_CONFIG_FILES     space-separated config files to include (panel.toml,
#                          compose .env/env files: they hold passwords)
#   AKARI_VERSION_STRING   version for MANIFEST (default: `akari --version`)
#   AKARI_MANIFEST_EXTRA   one more MANIFEST line (no secrets)
#   AKARI_KEEP_DAYS        delete backups older than this (default 14) ...
#   AKARI_KEEP_MIN         ... but always keep at least this many (default 3)
#   AKARI_BACKUP_AGENT_RELEASES=1  include the agent release binaries stored
#                          in the database (tables agent_releases and
#                          agent_release_chunks; tens of MB each). Default:
#                          their rows are left out (the tables are restored
#                          empty; upload the releases again or use 检查更新)
#   AKARI_BACKUP_SIGN_KEY  optional PEM private key (EC prime256v1): SHA256SUMS
#                          is signed with it (openssl) so that a restore holding
#                          the public key (AKARI_BACKUP_VERIFY_KEY) can tell a
#                          backup made here from one written by anybody who can
#                          write to the backup storage and knows the age PUBLIC
#                          key. Keep this key away from the backup storage;
#                          docs/BACKUP.md "Authenticity".
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

need tar; need sha256sum
sign_key="${AKARI_BACKUP_SIGN_KEY:-}"
if [ -n "$sign_key" ]; then
  need openssl
  [ -r "$sign_key" ] || die "cannot read AKARI_BACKUP_SIGN_KEY $sign_key"
fi
age_args=()
plain=0
if [ -n "${AGE_RECIPIENTS_FILE:-}" ]; then
  [ -r "$AGE_RECIPIENTS_FILE" ] || die "cannot read AGE_RECIPIENTS_FILE"
  age_args=(-R "$AGE_RECIPIENTS_FILE")
elif [ -n "${AGE_RECIPIENT:-}" ]; then
  age_args=(-r "$AGE_RECIPIENT")
elif [ "${AKARI_BACKUP_PLAINTEXT:-0}" = 1 ]; then
  plain=1
  echo "backup: WARNING: plain (unencrypted) backup: it holds the CA key, jwt.key, master.key and the database; keep it on this host (0600) or encrypt it (AGE_RECIPIENT, docs/BACKUP.md)" >&2
else
  die "set AGE_RECIPIENT or AGE_RECIPIENTS_FILE (age public key), or AKARI_BACKUP_PLAINTEXT=1; see docs/BACKUP.md"
fi
[ "$plain" = 1 ] || need age
if [ "$plain" = 1 ]; then
  ext=""
  seal() { cat; }
else
  ext=".age"
  seal() { age "${age_args[@]}"; }
fi
config_files=()
for f in ${AKARI_CONFIG_FILES:-}; do
  [ -f "$f" ] && config_files+=("$f")
done

# Agent release binaries: re-fetchable, and most of the dump's size.
case "${AKARI_BACKUP_AGENT_RELEASES:-0}" in
  1) exclude=() releases=included ;;
  0) exclude=(--exclude-table-data=agent_releases --exclude-table-data=agent_release_chunks) releases=excluded ;;
  *) die "AKARI_BACKUP_AGENT_RELEASES must be 0 or 1" ;;
esac

if [ -n "${AKARI_PG_DUMP_CMD:-}" ]; then
  # The options go after the command (pg_dump accepts them after the
  # database name).
  dump() { bash -c "$AKARI_PG_DUMP_CMD ${exclude[*]}"; }
else
  : "${DATABASE_URL:?set DATABASE_URL (or AKARI_PG_DUMP_CMD)}"
  need pg_dump
  dump() { pg_dump --format=custom --no-owner "${exclude[@]}" --dbname "$DATABASE_URL"; }
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$AKARI_BACKUP_DIR"
out="$AKARI_BACKUP_DIR/akari-$ts"
tmp="$out.partial"
[ ! -e "$out" ] || die "$out already exists"
mkdir "$tmp"
trap 'rm -rf "$tmp"' EXIT

chmod 700 "$tmp"
files=("db.dump$ext" "data.tar$ext")

echo "backup: database -> $out/db.dump$ext"
# pipefail: a failed pg_dump fails the backup (not just an empty file).
dump | seal >"$tmp/db.dump$ext"
[ -s "$tmp/db.dump$ext" ] || die "empty database dump"

echo "backup: data dir  -> $out/data.tar$ext"
tar -C "$AKARI_DATA_DIR" --numeric-owner -cf - . | seal >"$tmp/data.tar$ext"

if [ "${#config_files[@]}" -gt 0 ]; then
  echo "backup: config    -> $out/config.tar$ext"
  tar --numeric-owner -cPf - "${config_files[@]}" | seal >"$tmp/config.tar$ext"
  files+=("config.tar$ext")
fi

{
  echo "created_utc=$ts"
  echo "host=$(uname -n)"
  echo "akari=${AKARI_VERSION_STRING:-$(akari --version 2>/dev/null || echo unknown)}"
  if [ "$plain" = 1 ]; then
    echo "format=1 (db.dump: pg_dump -Fc; data.tar: tar of data_dir; config.tar: config files; NOT encrypted)"
  else
    echo "format=1 (db.dump.age: pg_dump -Fc; data.tar.age: tar of data_dir; config.tar.age: config files; age-encrypted)"
  fi
  echo "agent_releases=$releases"
  [ -z "$sign_key" ] || echo "signature=SHA256SUMS.sig (ecdsa-sha256)"
  [ -z "${AKARI_MANIFEST_EXTRA:-}" ] || echo "$AKARI_MANIFEST_EXTRA"
} >"$tmp/MANIFEST"
# MANIFEST is covered too: the sums bind the files and their description.
(cd "$tmp" && sha256sum "${files[@]}" MANIFEST >SHA256SUMS)
if [ -n "$sign_key" ]; then
  openssl dgst -sha256 -sign "$sign_key" -out "$tmp/SHA256SUMS.sig" "$tmp/SHA256SUMS" \
    || die "signing SHA256SUMS failed"
fi

if [ "$plain" = 1 ]; then
  # Custom-format dumps start with "PGDMP" (the host's pg_restore may be
  # older than the server's dump format).
  [ "$(head -c 5 "$tmp/db.dump")" = PGDMP ] || die "verification failed: not a pg_dump custom-format file"
  tar -tf "$tmp/data.tar" >/dev/null || die "verification failed: data archive unreadable"
elif [ -n "${AKARI_VERIFY_IDENTITY:-}" ]; then
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
