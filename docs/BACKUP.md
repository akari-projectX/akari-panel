# Backup and restore

What must be backed up:

| What | Where | Why |
|---|---|---|
| PostgreSQL | `database_url` | the source of truth: users, nodes, traffic ledger, tombstones |
| `data_dir` | `/var/lib/akari`, compose volume `akari-data` | **route prefix, the CA private key (`ca.key`) and `jwt.key`** |
| Valkey | -- | hot state only (liveness, rate-limit counters); not backed up |

> **WARNING: `data/` holds the CA private key and `jwt.key`.** Whoever has them can mint agent
> certificates (impersonate any node, receive its users' credentials) and forge admin sessions.
> Backups are therefore always encrypted; keep the decryption key offline, away from the
> backup storage. Never commit or copy `data/` anywhere unencrypted.

Losing `data/` while keeping the database means: new route prefix, new CA, every agent
needs a re-issued bootstrap file. Losing the database means losing everything else.

## Tooling (age)

`scripts/backup.sh` pipes `pg_dump --format=custom` and a `tar` of `data/` through
[age](https://github.com/FiloSottile/age) to **public** recipients: the backup host holds no key
that can read its own backups (gpg would need a keyring on the host; age is one static binary).
Nothing sensitive touches disk unencrypted. Output per backup:
`akari-<UTC>/{db.dump.age,data.tar.age,MANIFEST,SHA256SUMS}`.

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

`scripts/restore-drill.sh` automates it on the dev stack (destroys the dev database):
install -> admin + user + node with a live agent -> backup -> stop panel, wipe database and
data dir -> restore -> start panel -> assert same prefix, same login, user present, the
unchanged agent reconnects and the node is online.

Result, 2026-10-01 (WSL2 dev stack, PostgreSQL 18.6, age 1.2.1, dump via `docker compose exec`):

```
DRILL PASS: prefix kept, logins and users restored, agent reconnected in 1 s (panel start to online)
```

Backup size for the drill data: 404 KiB (db 390 KiB, data 10 KiB). A first run of the drill
found a bug in the drill script itself (the "stopped" panel was an orphan process), not in
backup/restore; the pass above is the run after that fix.
