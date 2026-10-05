# Backup and restore

What must be backed up:

| What | Where | Why |
|---|---|---|
| PostgreSQL | `database_url` | the source of truth: users, nodes, traffic ledger, tombstones |
| `data_dir` | `/var/lib/akari`, compose volume `akari-data` | **route prefix, the CA private key (`ca.key`), `jwt.key` and `master.key`** |
| configuration | `panel.toml`; compose `.env`, `env/*.env`; `/etc/akari/install.env` | optional (`AKARI_CONFIG_FILES`): passwords, for reference — a restore generates its own |
| Valkey | -- | hot state only (liveness, rate-limit counters); not backed up |

## With the installer (`akari-ctl`)

```bash
age-keygen -o akari-backup.key        # once; keep the key OFFLINE, note the "public key: age1..."
echo 'AGE_RECIPIENT=age1...' >>/etc/akari/install.env     # every backup from now on is encrypted
akari-ctl backup                      # -> /var/backups/akari/akari-<UTC>/ (--out DIR elsewhere)
```

`akari-ctl backup` runs `scripts/backup.sh` (installed as `/usr/local/lib/akari/backup.sh`) with the
right dump command for the installation (bare metal: `pg_dump` of the local PostgreSQL 18 as
`postgres`; Docker: `docker compose exec -T postgres pg_dump`), the data dir (Docker: the
`akari_akari-data` volume) and the configuration files. `akari-ctl upgrade` takes the same backup
before every upgrade and `akari-ctl migrate` before every move. Without `AGE_RECIPIENT` the backup
is **plain** (`db.dump`, `data.tar`, `config.tar`; directory 0700, files 0600) and both commands
print a warning: fine as an on-host safety net, never to be copied off the host as is. Retention:
14 days, at least the 3 newest (`AKARI_KEEP_DAYS` / `AKARI_KEEP_MIN`). Schedule it, e.g.
`/etc/cron.d/akari-backup`: `17 3 * * * root /usr/local/sbin/akari-ctl backup --yes >/dev/null`, and
copy the encrypted directories off the host.

Restore = a fresh install from the backup (also the host-to-host move, docs/DEPLOY.md §8):

```bash
curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh \
  | sh -s -- --restore /path/akari-<UTC> --age-identity akari-backup.key   # plain backups: no key
```

The sections below are the same tooling by hand.

> **WARNING: `data/` holds the CA private key, `jwt.key` and `master.key`.** Whoever has them can
> mint agent certificates (impersonate any node, receive its users' credentials) and forge admin
> sessions; `master.key` together with a database copy decrypts every sealed secret
> (subscription links, the SMTP password, payment and alert channel secrets).
> Backups are therefore always encrypted; keep the decryption key offline, away from the
> backup storage. Never commit or copy `data/` anywhere unencrypted.

Losing `data/` while keeping the database means: new route prefix, new CA, every agent
needs a new enrollment token (`akari node enroll-token <id>`, a new bootstrap file), and every
secret sealed with the master key can no longer be decrypted: enter the SMTP password, payment
method keys and alert channel secrets again; subscription links keep working but cannot be
shown until users reset them. `master.key` (named `totp.key` before v0.4; the panel renames it
once) and the database belong to the same backup: restore them together. Losing the database means losing everything else.

Agents keep their own key and certificate in their state directory (`/var/lib/private/akari-agent`
under the shipped unit). Losing it means re-enrolling that node with a new token; it is not part of
the panel backup.

## Tooling (age)

`scripts/backup.sh` pipes `pg_dump --format=custom` and a `tar` of `data/` through
[age](https://github.com/FiloSottile/age) to **public** recipients: the backup host holds no key
that can read its own backups (gpg would need a keyring on the host; age is one static binary).
Nothing sensitive touches disk unencrypted. Output per backup:
`akari-<UTC>/{db.dump.age,data.tar.age,[config.tar.age,]MANIFEST,SHA256SUMS}` (`config.tar.age`
when `AKARI_CONFIG_FILES` names files). Plain mode (`AKARI_BACKUP_PLAINTEXT=1`, explicit; the
installer's fallback without a recipient) writes `db.dump`, `data.tar`, `config.tar` instead, 0600 in
a 0700 directory, with a warning; `restore.sh` reads both kinds (an `AGE_IDENTITY_FILE` only for
`.age`).

```bash
age-keygen -o akari-backup.key          # keep this file OFFLINE (password manager, safe)
# prints "Public key: age1..."
AGE_RECIPIENT=age1... AKARI_DATA_DIR=/var/lib/akari AKARI_BACKUP_DIR=/var/backups/akari \
DATABASE_URL=postgres://... scripts/backup.sh
```

Variables: see the header of `scripts/backup.sh` (`AKARI_KEEP_DAYS` default 14 and
`AKARI_KEEP_MIN` default 3 for retention; `AGE_RECIPIENTS_FILE` for several recipients;
`AKARI_PG_DUMP_CMD` e.g. `docker compose exec -T postgres pg_dump -U akari -Fc akari` when the host
has no matching `pg_dump` (needs the client of PostgreSQL >= 18); `AKARI_VERIFY_IDENTITY`
to decrypt-and-check each backup right away). Schedule it (cron/systemd timer) and copy the
directory off the host (the files are ciphertext).

## Restore

**Backups made by v0.3.x cannot be restored into v0.4**: v0.4 squashed the migrations into a new
baseline (`migrations/1000_baseline.sql`) and the panel refuses a database whose history predates
it (`database from v0.3.x — fresh install required`; docs/DEPLOY.md §5). Restore such a backup
only with a v0.3.x binary.

1. Stop the panel (`systemctl stop akari-panel` / `docker compose stop panel`). Agents keep
   running and reconnect by themselves.
2. Provide an empty database (`createdb`) and a PostgreSQL >= 18 server.
3. ```bash
   AGE_IDENTITY_FILE=akari-backup.key AKARI_DATA_DIR=/var/lib/akari AKARI_OWNER=akari:akari \
   DATABASE_URL=postgres://... scripts/restore.sh /var/backups/akari/akari-<UTC>
   ```
   It checks the checksums, extracts `data/` (an existing non-empty data dir is refused unless
   `--force`, then moved aside) and loads the database in one transaction. For compose use
   `AKARI_PG_RESTORE_CMD='docker compose exec -T postgres pg_restore -U akari -d akari --clean --if-exists --no-owner --single-transaction'`.
4. Start the panel; `akari info` shows the **same route prefix**; log in; nodes turn `online` as
   the agents reconnect (their certificates are signed by the restored CA).
5. Traffic counted between the backup and the failure is lost (users' usage reverts to the
   backup's values); everything else in the database is as of the backup.

## Restore drill (run it quarterly and after changing the procedure)

`scripts/restore-drill.sh` automates it on the dev stack, in its own database (`DRILL_DB`,
default `akari_drill`, dropped and recreated) and Valkey db index (`DRILL_VALKEY_DB`, default
14); it binds the panel's default ports, so serialise it with smoke:
install -> admin + user + node with a live agent -> backup -> stop panel, wipe database and
data dir -> restore -> start panel -> assert same prefix, same login, user present, the
user's sealed subscription link still decrypts (the master key came back), the unchanged agent
reconnects and the node is online.

Result, 2026-10-01 (WSL2 dev stack, PostgreSQL 18.6, age 1.2.1, dump via `docker compose exec`):

```
DRILL PASS: prefix kept, logins and users restored, agent reconnected in 1 s (panel start to online)
```

Re-run 2026-10-02 (W14) on the current schema (migrations through 0091, PostgreSQL 18, age 1.2.1):

```
DRILL PASS: prefix kept, logins (with TOTP) and users restored, agent reconnected in 9 s (panel start to online)
```

The 9 s (1 s in the first run) is the agent's reconnect backoff after the panel was down for
the restore, not restore time. Backup 108 KiB (db 86 KiB, data 10 KiB).

Backup size for the first drill's data: 404 KiB (db 390 KiB, data 10 KiB). A first run of the drill
found a bug in the drill script itself (the "stopped" panel was an orphan process), not in
backup/restore; the pass above is the run after that fix.
