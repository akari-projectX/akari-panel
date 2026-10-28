# Backup and restore（备份与恢复）

需要备份的内容：

| 内容 | 位置 | 原因 |
|---|---|---|
| PostgreSQL | `database_url` | 唯一数据源：用户、节点、流量账本、墓碑记录 |
| `data_dir` | `/var/lib/akari`, compose volume `akari-data` | **CA 私钥（`ca.key`）、`jwt.key`、`master.key`（以及 `state.json`：管理前缀的种子，前缀本身存在数据库中）** |
| configuration | `panel.toml`; compose `.env`, `env/*.env`; `/etc/akari/install.env` | 可选（`AKARI_CONFIG_FILES`）：含密码，仅供参考；恢复时会重新生成 |
| Valkey | -- | 仅存热状态（存活标记、限流计数）；不备份 |
| agent release binaries | PostgreSQL 表 `agent_releases`、`agent_release_chunks` | **默认不含**（见下） |

### Agent release binaries（agent 发布二进制，默认不含）

在「更新」页上传（或由「检查更新」拉取）的 agent 发布包存放在数据库中，每个发布几十 MB
（2026-10 测试部署中 6 个发布生成了 84 MB 的转储）。它们是 GitHub 上公开、已签名的发布资产的副本，
因此备份默认不含这些行：相关表只转储结构（`pg_dump --exclude-table-data`），MANIFEST 记为
`agent_releases=excluded`。恢复后面板中没有任何已存储的发布：到 更新 → **检查更新**（或手动上传）即可找回。
在此之前，节点一键安装会停下并提示取回发布，且只有重新存入发布后才能创建灰度发布（rollout）。已安装的 agent 不受影响（保留自己的二进制）。

如需包含：使用 `akari-ctl backup --with-agent-releases`，或为 `akari-ctl backup` / `scripts/backup.sh`
设置 `AKARI_BACKUP_AGENT_RELEASES=1`（MANIFEST：`agent_releases=included`）。
`akari-ctl migrate`（同机迁移）始终包含；`akari-ctl upgrade` 的升级前备份则不含。
两种备份的恢复方式相同。

## With the installer (`akari-ctl`)（使用安装器）

```bash
age-keygen -o akari-backup.key        # once; keep the key OFFLINE, note the "public key: age1..."
echo 'AGE_RECIPIENT=age1...' >>/etc/akari/install.env     # every backup from now on is encrypted
akari-ctl backup                      # -> /var/backups/akari/akari-<UTC>/ (--out DIR elsewhere)
```

`akari-ctl backup` 会运行 `scripts/backup.sh`（安装为 `/usr/local/lib/akari/backup.sh`），并按安装方式选择转储命令
（裸机：以 `postgres` 身份对本机 PostgreSQL 18 执行 `pg_dump`；Docker：`docker compose exec -T postgres pg_dump`）、
数据目录（Docker：`akari_akari-data` 卷）和配置文件。`akari-ctl upgrade` 在每次升级前、`akari-ctl migrate`
在每次迁移前都会做同样的备份。未设置 `AGE_RECIPIENT` 时备份为**明文**（`db.dump`、`data.tar`、`config.tar`；
目录 0700，文件 0600），两个命令都会打印警告：可作为本机的安全网，但绝不能原样复制到主机之外。
保留策略：14 天，且至少保留最新 3 份（`AKARI_KEEP_DAYS` / `AKARI_KEEP_MIN`）。可加入定时任务，例如
`/etc/cron.d/akari-backup`：`17 3 * * * root /usr/local/sbin/akari-ctl backup --yes >/dev/null`，
并把加密后的目录复制到主机之外。

恢复 = 用备份做一次全新安装（跨主机迁移同理，见 docs/DEPLOY.md §8）：

```bash
curl -fsSL https://github.com/akari-projectX/akari-panel/releases/latest/download/install.sh \
  | sh -s -- --restore /path/akari-<UTC> --age-identity akari-backup.key   # plain backups: no key
```

以下各节是手动使用同一套工具的方式。

> **警告：`data/` 中存放着 CA 私钥、`jwt.key` 和 `master.key`。** 持有它们的人可以签发 agent 证书
> （冒充任意节点、接收其用户的凭据）并伪造管理员会话；`master.key` 加上数据库副本即可解密所有加密存放的密钥
> （订阅链接、SMTP 密码、支付与告警渠道密钥）。
> 因此备份必须始终加密；解密密钥要离线保存，远离备份存储。切勿将 `data/` 以未加密形式提交或复制到任何地方。

丢失 `data/` 但保留数据库的后果：需要新建 CA；每个 agent 都需要新的注册令牌
（`akari server enroll-token <id>`，并生成新的 bootstrap 文件）；所有用 master key 加密的密钥都无法再解密，
需要重新填写 SMTP 密码、支付方式密钥和告警渠道密钥；订阅链接仍可使用，但在用户重置之前无法显示。
`master.key` 与数据库属于同一份备份：必须一起恢复。
丢失数据库则意味着丢失其余一切。

agent 的密钥和证书保存在它自己的状态目录中（按随附 unit 为 `/var/lib/private/akari-agent`）。
丢失后需要用新令牌重新注册该节点；它不属于面板备份的范围。

## Tooling (age)（工具：age）

`scripts/backup.sh` 把 `pg_dump --format=custom` 的输出和 `data/` 的 `tar` 通过
[age](https://github.com/FiloSottile/age) 加密给**公钥**接收方：备份主机上没有任何能读取自己备份的密钥
（gpg 需要在主机上放密钥环；age 只是一个静态二进制）。敏感内容不会以明文落盘。每次备份的输出：
`akari-<UTC>/{db.dump.age,data.tar.age,[config.tar.age,]MANIFEST,SHA256SUMS,SHA256SUMS.sig}`
（设置了 `AKARI_CONFIG_FILES` 才有 `config.tar.age`）。明文模式（`AKARI_BACKUP_PLAINTEXT=1`，须显式指定；
也是安装器在没有接收方时的回退）改为写出 `db.dump`、`data.tar`、`config.tar`，目录 0700、文件 0600，并给出警告；
`restore.sh` 两种都能读（仅 `.age` 文件需要 `AGE_IDENTITY_FILE`）。

```bash
age-keygen -o akari-backup.key          # keep this file OFFLINE (password manager, safe)
# prints "Public key: age1..."
AGE_RECIPIENT=age1... AKARI_DATA_DIR=/var/lib/akari AKARI_BACKUP_DIR=/var/backups/akari \
DATABASE_URL=postgres://... scripts/backup.sh
```

变量：见 `scripts/backup.sh` 的文件头：保留策略用 `AKARI_KEEP_DAYS`（默认 14）和 `AKARI_KEEP_MIN`（默认 3）；
多个接收方用 `AGE_RECIPIENTS_FILE`；主机上没有匹配的 `pg_dump` 时用 `AKARI_PG_DUMP_CMD`，
例如 `docker compose exec -T postgres pg_dump -U akari -Fc akari`（需要 PostgreSQL >= 18 的客户端；
脚本会在其后追加 `--exclude-table-data` 选项）；`AKARI_BACKUP_AGENT_RELEASES=1` 保留 agent 发布包；
`AKARI_VERIFY_IDENTITY` 用于在备份完成后立即解密并校验。
请用 cron / systemd timer 定时执行，并把目录复制到主机之外（文件均为密文）。

## Authenticity（真实性：校验和与签名，默认开启）

`SHA256SUMS`（也包含 `MANIFEST`）与备份文件放在同一目录，**只能证明备份完好（未损坏），不能证明它出自你的备份主机**。
age 的接收方是**公钥**：任何能写备份目录或对象存储、并且知道公钥的人，都可以加密出自己的 `data.tar`（含 `ca.key`、
`jwt.key`、`master.key`）和 `db.dump`，再重算 `SHA256SUMS`，恢复时它们完全合法。把校验和也放进 age 信封没有用，
因为攻击者同样能加密出一份。所以备份**默认签名**：

- **安装器自动处理**：`install.sh` 安装（以及升级、`backup`、`migrate`）时，如果还没有签名密钥，就在 `/etc/akari/backup-sign.pem`
  生成一把（EC prime256v1，root、0600，与 `install.env` 同目录；不进备份、不进命令行、不进日志），路径记在
  `install.env` 的 `BACKUP_SIGN_KEY`。此后 `akari-ctl backup`、升级前备份、`migrate` 的备份目录里都有 `SHA256SUMS.sig`
  （对 `SHA256SUMS` 的 ECDSA-SHA256 签名）。**不要把私钥放到备份存储上**：能写备份存储的人拿不到它，才有意义。
- **验证公钥**：`akari-ctl info` 会打印（`/etc/akari/backup-sign.pub` 是同一份，公钥不是机密）。**请离线保存一份**
  （与 age 私钥放在一起）：灾难恢复到新主机时，旧主机和它的私钥可能都没了，新主机会生成自己的新密钥。
  换签名密钥（删除 `backup-sign.pem` 后再运行 `akari-ctl backup`）之后，旧备份仍须用旧公钥验证，请一并保留。
- **恢复时验证**：

```bash
akari-ctl ... --restore <备份目录> --age-identity akari-backup.key --backup-verify-key backup-sign.pub
AKARI_BACKUP_VERIFY_KEY=backup-sign.pub AGE_IDENTITY_FILE=akari-backup.key scripts/restore.sh <备份目录>
```

给了公钥就是**强制验证**：没有 `SHA256SUMS.sig`、签名不符、或校验和不符，一律**拒绝恢复**。
没给公钥时恢复仍会继续，但会打印醒目的警告“备份未经验证：只证明完好（integrity only），不证明出处（not authenticity）”——
备份存储可能被别人写过时，请停下来用公钥重试。恢复会装入备份里的 CA 私钥、`jwt.key` 和 `master.key`。
威胁模型：能写备份存储但拿不到签名私钥的人无法伪造能通过验证的备份；备份主机本身被攻破则不在此列（它本来就能写任何内容）。

直接使用 `scripts/backup.sh`（cron）时同样必须指定签名密钥：`AKARI_BACKUP_SIGN_KEY=/etc/akari/backup-sign.pem`
（手动生成：`openssl ecparam -name prime256v1 -genkey -noout -out backup-sign.pem && chmod 600 backup-sign.pem`，
公钥 `openssl ec -in backup-sign.pem -pubout -out backup-sign.pub`）。没有密钥时脚本**停止**；确实不要签名要显式写
`AKARI_BACKUP_UNSIGNED=1`（与 `AKARI_BACKUP_PLAINTEXT=1` 一样是明确的选择，会打印警告）。

## Restore（恢复）

1. 停止面板（`systemctl stop akari-panel` / `docker compose stop panel`）。agent 保持运行，会自行重连。
2. 准备一个空数据库（`createdb`；要复用旧库须先 `dropdb`，因为 `pg_restore --clean` 无法删除 `traffic_daily`
   的月度分区），服务器须为 PostgreSQL >= 18。
3. ```bash
   AGE_IDENTITY_FILE=akari-backup.key AKARI_DATA_DIR=/var/lib/akari AKARI_OWNER=akari:akari \
   DATABASE_URL=postgres://... scripts/restore.sh /var/backups/akari/akari-<UTC>
   ```
   脚本会校验校验和，解出 `data/`（已有的非空数据目录会被拒绝，除非加 `--force`，此时旧目录会被移开），
   并在一个事务中载入数据库。compose 部署请使用
   `AKARI_PG_RESTORE_CMD='docker compose exec -T postgres pg_restore -U akari -d akari --no-owner --single-transaction'`
   （恢复到空数据库）。`akari-ctl --restore` 和迁移会自行重建数据库。
4. 启动面板；`akari info` 显示的是**同一个管理前缀**；登录后，随着 agent 重连，节点会变为 `online`
   （它们的证书由恢复后的 CA 签发）。
5. 备份之后到故障之前统计的流量会丢失（用户用量回退到备份时的值）；数据库中的其余内容均为备份时的状态。

## Restore drill (run it quarterly and after changing the procedure)（恢复演练：每季度一次，流程变更后也要做）

`scripts/restore-drill.sh` 在开发栈上自动执行演练，使用独立的数据库（`DRILL_DB`，默认 `akari_drill`，会被删除重建）
和 Valkey db 编号（`DRILL_VALKEY_DB`，默认 14）；它绑定面板的默认端口，因此要与 smoke 串行运行。
流程：安装 -> 创建管理员、用户和带在线 agent 的节点 -> 备份 -> 停止面板、清空数据库和数据目录 -> 恢复 ->
启动面板 -> 断言：前缀不变、登录不变、用户仍在、用户加密存放的订阅链接仍可解密（master key 已恢复）、
未做任何改动的 agent 能重连且节点在线。

演练通过时脚本打印 `DRILL PASS`。重连耗时主要是面板停机期间 agent 的重连退避，并非恢复耗时。
