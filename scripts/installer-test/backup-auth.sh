#!/usr/bin/env bash
# Backup authenticity (audit 2026-10 P2-4), no database, no age, no docker:
# backup.sh signs SHA256SUMS (AKARI_BACKUP_SIGN_KEY), restore.sh checks the
# signature when it is given the public key (AKARI_BACKUP_VERIFY_KEY).
#   - a signed backup restores with the right key
#   - a backup rewritten together with its SHA256SUMS (what anybody who can
#     write the backup storage can do) is refused with the key, and passes
#     the checksums alone (which prove integrity only; restore.sh says so)
#   - an unsigned backup is refused when a key is required; a wrong key too
#   - MANIFEST is covered by SHA256SUMS
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
scripts=$(cd "$here/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir data bak
echo secret >data/master.key
openssl ecparam -name prime256v1 -genkey -noout -out sign.pem 2>/dev/null
openssl ec -in sign.pem -pubout -out sign.pub 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out other.pem 2>/dev/null
openssl ec -in other.pem -pubout -out other.pub 2>/dev/null

common=(AKARI_DATA_DIR="$work/data" AKARI_BACKUP_DIR="$work/bak" AKARI_BACKUP_PLAINTEXT=1
  AKARI_PG_DUMP_CMD='printf PGDMP-fake-dump' AKARI_VERSION_STRING=test)
env "${common[@]}" AKARI_BACKUP_SIGN_KEY="$work/sign.pem" bash "$scripts/backup.sh" >/dev/null 2>&1
signed=$(echo bak/akari-*)
[ -f "$signed/SHA256SUMS.sig" ] || fail "no SHA256SUMS.sig"
case $(cat "$signed/SHA256SUMS") in *" MANIFEST"*) ;; *) fail "MANIFEST is not covered by SHA256SUMS" ;; esac

# restore DIR [VAR=value...]: restore.sh output (stdout+stderr) in $out,
# its status in $status. (No `| grep -q`: EPIPE under pipefail.)
restore() {
  local dir=$1
  shift
  rm -rf "$work/out"
  status=0
  out=$(env AKARI_DATA_DIR="$work/out" AKARI_PG_RESTORE_CMD='cat >/dev/null' "$@" \
    bash "$scripts/restore.sh" "$dir" 2>&1) || status=$?
}
# expect OK|REFUSED TEXT: the last restore's status and output.
expect() {
  case "$out" in *"$2"*) ;; *) fail "$3: output lacks '$2': $out" ;; esac
  if [ "$1" = OK ] && [ "$status" != 0 ]; then fail "$3: refused: $out"; fi
  if [ "$1" = REFUSED ] && [ "$status" = 0 ]; then fail "$3: accepted"; fi
}

restore "$signed" AKARI_BACKUP_VERIFY_KEY="$work/sign.pub"
expect OK "signature verified" "signed backup refused with the right key"
[ "$(cat "$work/out/master.key")" = secret ] || fail "data not restored"

# Without a key: restores, and says it is integrity only.
restore "$signed"
expect OK "integrity only, not authenticity" "unsigned use"

# A wrong key refuses.
restore "$signed" AKARI_BACKUP_VERIFY_KEY="$work/other.pub"
expect REFUSED "signature mismatch" "wrong key"

# Forged: new data, new SHA256SUMS (no signing key available to the writer).
forged="$work/bak/akari-19990101T000000Z"
cp -r "$signed" "$forged"
echo evil >"$work/evil.key"
(cd "$work" && mkdir -p evil && cp evil.key evil/master.key && tar -C evil --numeric-owner -cf "$forged/data.tar" .)
(cd "$forged" && sha256sum db.dump data.tar MANIFEST >SHA256SUMS)
restore "$forged"
expect OK "integrity only" "forged backup passes the checksums alone"
restore "$forged" AKARI_BACKUP_VERIFY_KEY="$work/sign.pub"
expect REFUSED "signature mismatch" "forged backup"

# Unsigned backup with a key required.
sleep 1 # backup directories are named by the second
env "${common[@]}" bash "$scripts/backup.sh" >/dev/null 2>&1
unsigned=""
for d in bak/akari-2*; do unsigned=$d; done # the newest: names sort by time
[ "$unsigned" != "$signed" ] || fail "second backup was not created"
[ ! -f "$unsigned/SHA256SUMS.sig" ] || fail "unsigned backup has a signature"
restore "$unsigned" AKARI_BACKUP_VERIFY_KEY="$work/sign.pub"
expect REFUSED "no SHA256SUMS.sig" "unsigned backup"

# Damage: a flipped byte in the data fails the checksums.
echo x >>"$signed/data.tar"
restore "$signed" AKARI_BACKUP_VERIFY_KEY="$work/sign.pub"
expect REFUSED "checksum mismatch" "damaged backup"
echo "backup-auth: ok"
