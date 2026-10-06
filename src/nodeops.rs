use std::io::Write as _;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};

use crate::audit::Actor;
use crate::config::PanelConfig;
use crate::install;

/// A small pool for one CLI command, migrations applied.
async fn connect(cfg: &PanelConfig) -> Result<sqlx::PgPool> {
    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&cfg.database_url)
        .await?;
    crate::db::migrate(&pg).await?;
    Ok(pg)
}

/// `akari settings show`: stored system settings (R22) and the effective
/// values (database wins over panel.toml).
pub async fn settings_show(cfg: PanelConfig) -> Result<()> {
    let pg = connect(&cfg).await?;
    crate::settings::cli_show(&cfg, &pg).await
}

/// `akari settings set <field> <value>`: a domain / trust switch from the
/// CLI (audited as cli), e.g. the node domain before the first login.
pub async fn settings_set(cfg: PanelConfig, field: String, value: String) -> Result<()> {
    let pg = connect(&cfg).await?;
    crate::settings::cli_set(&cfg, &pg, &field, &value).await
}

/// `akari settings unset <field>`: clear a database setting (audited as
/// cli), e.g. a mistyped main domain that the host gate now refuses.
pub async fn settings_unset(cfg: PanelConfig, field: String) -> Result<()> {
    let pg = connect(&cfg).await?;
    crate::settings::cli_unset(&cfg, &pg, &field).await
}

/// Creates the first admin (or any) account. Reads the password from
/// AKARI_ADMIN_PASSWORD or a hidden interactive prompt. The address is the
/// login name (D1) and counts as verified (the operator vouches for it).
pub async fn admin_add(cfg: PanelConfig, email: String, role: String) -> Result<()> {
    if role != "admin" && role != "user" {
        bail!("role must be 'admin' or 'user'");
    }
    let Some(email) = crate::signup::email::parse(email.trim()) else {
        bail!("not a valid email address: {email}");
    };
    let hash = read_password_hash()?;
    let pg = connect(&cfg).await?;
    let id = uuid::Uuid::new_v4();
    let mut tx = pg.begin().await?;
    // R47: the first admin (the installer's) is the owner. Serialized with
    // concurrent `admin add`s by the unique index users_one_owner.
    let owner: bool = role == "admin"
        && !sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM users WHERE is_owner)")
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query(
        "INSERT INTO users (id, email, email_verified_at, password_hash, role, is_owner) \
         VALUES ($1, $2, now(), $3, $4, $5)",
    )
    .bind(id)
    .bind(&email)
    .bind(&hash)
    .bind(&role)
    .bind(owner)
    .execute(&mut *tx)
    .await
    .with_context(|| format!("insert user {email}"))?;
    let after = serde_json::json!({
        "email": email, "role": role, "enabled": true, "password": crate::audit::CHANGED,
        "owner": owner,
    });
    crate::audit::record(
        &mut tx,
        &Actor::cli(),
        "user.create",
        "user",
        Some(id.to_string()),
        None,
        Some(after),
    )
    .await?;
    tx.commit().await?;
    if owner {
        println!("created the owner account: {email} ({id})");
    } else {
        println!("created {role} account: {email} ({id})");
    }
    Ok(())
}

/// `akari admin set-owner <email>` (R47 recovery): make an enabled admin
/// the owner (audited, actor cli).
pub async fn admin_set_owner(cfg: PanelConfig, email: String) -> Result<()> {
    let pg = connect(&cfg).await?;
    crate::owner::cli_set_owner(&pg, &email).await?;
    println!("{email} is now the owner");
    Ok(())
}

/// `akari admin reset-login <email>` (W27): a lost passkey.
pub async fn admin_reset_login(cfg: PanelConfig, email: String) -> Result<()> {
    let pg = connect(&cfg).await?;
    let n = crate::passkey::cli_reset_login(&pg, &email).await?;
    println!("{email}: {n} passkey(s) deleted; password login is on again");
    Ok(())
}

fn read_password_hash() -> Result<String> {
    let password = match std::env::var("AKARI_ADMIN_PASSWORD") {
        Ok(p) if !p.is_empty() => p,
        _ => rpassword::prompt_password("password: ")?,
    };
    if password.len() < 8 {
        bail!("password must be at least 8 characters");
    }
    crate::auth::hash_password(&password)
}

/// Reset an account's password. The users trigger (migration 0009) bumps
/// session_ver, so every existing session of the account ends.
pub async fn admin_passwd(cfg: PanelConfig, email: String) -> Result<()> {
    let email = email.trim().to_lowercase();
    let hash = read_password_hash()?;
    let pg = connect(&cfg).await?;
    let mut tx = pg.begin().await?;
    let id: Option<uuid::Uuid> =
        sqlx::query_scalar("UPDATE users SET password_hash = $2 WHERE email = $1 RETURNING id")
            .bind(&email)
            .bind(&hash)
            .fetch_optional(&mut *tx)
            .await
            .with_context(|| format!("update user {email}"))?;
    let Some(id) = id else {
        bail!("no such account: {email}");
    };
    crate::audit::record(
        &mut tx,
        &Actor::cli(),
        "user.update",
        "user",
        Some(id.to_string()),
        None,
        Some(serde_json::json!({ "password": crate::audit::CHANGED })),
    )
    .await?;
    tx.commit().await?;
    println!("password changed for {email}; its sessions are revoked");
    Ok(())
}

/// `akari server add <name>`: create the server with a one-time enrollment
/// token and write the bootstrap file (panel address, server name, CA,
/// token — no private key: the agent generates its key and enrolls, M1-8).
pub async fn server_add(cfg: PanelConfig, name: String, out: Option<PathBuf>) -> Result<()> {
    let inst = install::ensure(&cfg)?;
    let pg = connect(&cfg).await?;
    let mut tx = pg.begin().await?;
    let endpoint = crate::settings::node_endpoint(&mut tx, &cfg)
        .await
        .map_err(|e| anyhow::anyhow!("{} (akari settings set node <host[:port]>)", e.message()))?;
    let (id, token, expires) = crate::enroll::apply_create_server(
        &mut tx,
        &Actor::cli(),
        &name,
        cfg.limits.enroll_token_ttl_secs,
        None,
        &endpoint,
    )
    .await
    .map_err(|e| anyhow::anyhow!("server {name}: {}", e.message()))?;
    let out_path = out.unwrap_or_else(|| PathBuf::from(format!("{name}-bootstrap.toml")));
    // Written before the commit: a committed server always has its file.
    write_bootstrap(
        &endpoint,
        &inst,
        &out_path,
        &name,
        &token,
        expires,
        &mut std::io::stdout(),
    )?;
    tx.commit().await?;
    let mut say = progress(&out_path);
    writeln!(say, "server registered: {id}")?;
    writeln!(say, "bootstrap file:   {}", out_path.display())?;
    writeln!(say, "enrollment token expires {}", expires.to_rfc3339())?;
    Ok(())
}

/// `akari server enroll-token <id>`: a new one-time enrollment token for
/// an existing server (the first one expired, or the agent's state was
/// lost) and its bootstrap file. Once the agent enrolls with it, the
/// server's previous certificates are revoked.
pub async fn server_enroll_token(
    cfg: PanelConfig,
    id: uuid::Uuid,
    out: Option<PathBuf>,
) -> Result<()> {
    let inst = install::ensure(&cfg)?;
    let pg = connect(&cfg).await?;
    let mut tx = pg.begin().await?;
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM servers WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(name) = name else {
        bail!("no such server: {id}");
    };
    let endpoint = crate::settings::node_endpoint(&mut tx, &cfg)
        .await
        .map_err(|e| anyhow::anyhow!("{} (akari settings set node <host[:port]>)", e.message()))?;
    let (token, expires) = crate::enroll::apply_issue_token(
        &mut tx,
        &Actor::cli(),
        id,
        cfg.limits.enroll_token_ttl_secs,
        None,
        &endpoint,
    )
    .await
    .map_err(|e| anyhow::anyhow!("server {id}: {}", e.message()))?;
    let out_path = out.unwrap_or_else(|| PathBuf::from(format!("{name}-bootstrap.toml")));
    write_bootstrap(
        &endpoint,
        &inst,
        &out_path,
        &name,
        &token,
        expires,
        &mut std::io::stdout(),
    )?;
    tx.commit().await?;
    let mut say = progress(&out_path);
    writeln!(say, "new enrollment token for server {id}")?;
    writeln!(say, "bootstrap file:   {}", out_path.display())?;
    writeln!(say, "enrollment token expires {}", expires.to_rfc3339())?;
    Ok(())
}

/// `--out -`: the bootstrap file goes to stdout (so it can be redirected on
/// the host, e.g. out of a distroless container), progress goes to stderr.
fn to_stdout(path: &std::path::Path) -> bool {
    path.as_os_str() == "-"
}

/// Where the human-readable progress lines go.
fn progress(out_path: &std::path::Path) -> Box<dyn std::io::Write> {
    if to_stdout(out_path) {
        Box::new(std::io::stderr())
    } else {
        Box::new(std::io::stdout())
    }
}

fn write_bootstrap(
    endpoint: &crate::settings::NodeEndpoint,
    inst: &install::Install,
    path: &std::path::Path,
    name: &str,
    token: &str,
    expires: chrono::DateTime<chrono::Utc>,
    stdout: &mut dyn std::io::Write,
) -> Result<()> {
    let body = crate::enroll::bootstrap_toml(
        name,
        &endpoint.panel_addr,
        &endpoint.server_name,
        &inst.ca_pem,
        token,
        expires,
    );
    if to_stdout(path) {
        stdout
            .write_all(body.as_bytes())
            .and_then(|()| stdout.flush())
            .context("write bootstrap to stdout")?;
        return Ok(());
    }
    // 0600: the token is a credential until used or expired.
    install::write_secret(path, body.as_bytes())
        .with_context(|| format!("write {}", path.display()))
}

/// Phase 1 of a server deletion (see servers::apply_begin_delete); a
/// running panel (reaper) completes it.
pub async fn server_delete(cfg: PanelConfig, id: uuid::Uuid) -> Result<()> {
    let pg = connect(&cfg).await?;
    let mut tx = pg.begin().await?;
    let started = crate::servers::apply_begin_delete(&mut tx, &Actor::cli(), id)
        .await
        .map_err(|e| anyhow::anyhow!("server {id}: {}", e.message()))?;
    tx.commit().await?;
    if started {
        println!("server {id}: deletion started (it serves nothing; its certificate is revoked");
        println!("and it is removed with its nodes by the running panel once the agent runs the");
        println!("empty state)");
    } else {
        println!("server {id}: deletion already in progress");
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct ServerListRow {
    id: uuid::Uuid,
    name: String,
    status: String,
    agent_version: Option<String>,
    core_version: Option<String>,
    last_seen_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn server_list(cfg: PanelConfig) -> Result<()> {
    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&cfg.database_url)
        .await?;
    let rows = sqlx::query_as::<_, ServerListRow>(
        "SELECT id, name, CASE WHEN deleting_at IS NOT NULL THEN 'deleting' ELSE status END \
         AS status, agent_version, core_version, last_seen_at FROM servers ORDER BY created_at",
    )
    .fetch_all(&pg)
    .await?;

    println!(
        "{:<38} {:<14} {:<9} {:<12} {:<12} LAST SEEN",
        "ID", "NAME", "STATUS", "AGENT", "CORE"
    );
    for r in rows {
        println!(
            "{:<38} {:<14} {:<9} {:<12} {:<12} {}",
            r.id,
            r.name,
            r.status,
            r.agent_version.unwrap_or_default(),
            r.core_version.unwrap_or_default(),
            r.last_seen_at
                .map(|t| t.to_rfc3339())
                .unwrap_or_else(|| "-".into()),
        );
    }
    Ok(())
}

/// `akari secrets rotate-prefix`.
pub async fn secrets_rotate_prefix(cfg: PanelConfig) -> Result<()> {
    let pg = connect(&cfg).await?;
    let prefix = crate::access::cli_rotate_prefix(&pg).await?;
    println!("new admin prefix: /{prefix}");
    println!("every panel instance switches at once; the old prefix no longer works.");
    Ok(())
}

/// `akari info`: the stored admin prefix and subscription path (None
/// before the first start imports them; no database = None).
pub async fn stored_access(cfg: &PanelConfig) -> Option<(Option<String>, Option<String>)> {
    let pg = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&cfg.database_url),
    )
    .await
    .ok()?
    .ok()?;
    crate::access::cli_read(&pg).await.ok()
}

/// `akari secrets rotate-jwt`.
pub async fn secrets_rotate_jwt(cfg: PanelConfig) -> Result<()> {
    let pg = connect(&cfg).await?;
    let n = rotate_jwt(&pg, &cfg.data_dir).await?;
    println!("new jwt.key written; all sessions of {n} accounts revoked now.");
    println!("restart every panel instance to sign new sessions with the new key.");
    Ok(())
}

/// Bump every account's session_ver (all sessions die at once, on every
/// running instance, even before the restart that loads the new key),
/// write the new key, commit with the audit row.
async fn rotate_jwt(pg: &sqlx::PgPool, data_dir: &std::path::Path) -> Result<u64> {
    let mut tx = pg.begin().await?;
    let n = sqlx::query("UPDATE users SET session_ver = session_ver + 1")
        .execute(&mut *tx)
        .await?
        .rows_affected();
    crate::audit::record(
        &mut tx,
        &Actor::cli(),
        "secrets.rotate_jwt",
        "install",
        None,
        None,
        Some(
            serde_json::json!({ "jwt_key": crate::audit::CHANGED, "sessions_revoked_accounts": n }),
        ),
    )
    .await?;
    install::rotate_jwt_key(data_dir)?;
    tx.commit()
        .await
        .context("jwt key rotated, but revoking sessions / auditing failed")?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb::TestDb;

    /// `--out -` writes the bootstrap to the given stdout writer and leaves
    /// no file behind (distroless images cannot delete one).
    #[test]
    fn bootstrap_out_dash_goes_to_stdout_without_a_file() {
        let dir = std::env::temp_dir().join(format!("akari-boot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = PanelConfig {
            data_dir: dir.clone(),
            ..Default::default()
        };
        let inst = install::ensure(&cfg).unwrap();
        let expires = chrono::Utc::now();
        let ep = crate::settings::NodeEndpoint {
            panel_addr: "127.0.0.1:8443".into(),
            server_name: "localhost".into(),
        };

        let mut buf = Vec::new();
        write_bootstrap(
            &ep,
            &inst,
            std::path::Path::new("-"),
            "vps-1",
            "tok-123",
            expires,
            &mut buf,
        )
        .unwrap();
        let text = String::from_utf8(buf).unwrap();
        assert!(text.contains("tok-123") && text.contains("BEGIN CERTIFICATE"));
        assert!(!std::path::Path::new("-").exists());

        // A file path still writes a 0600 file and nothing to stdout.
        let file = dir.join("b.toml");
        let mut buf = Vec::new();
        write_bootstrap(&ep, &inst, &file, "vps-1", "tok-123", expires, &mut buf).unwrap();
        assert!(buf.is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        std::fs::remove_dir_all(&dir).ok();
    }

    async fn audit_actions(db: &TestDb) -> Vec<(String, String)> {
        sqlx::query_as("SELECT actor_label, action FROM audit_log ORDER BY id")
            .fetch_all(&db.pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn rotations_are_audited_and_effective() {
        let Some(db) = TestDb::new().await else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("akari-rot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = PanelConfig {
            data_dir: dir.clone(),
            ..Default::default()
        };
        let before = install::ensure(&cfg).unwrap();
        let u = db.user().await;
        let a = db.admin().await;
        let sv = |id: uuid::Uuid| {
            let pool = db.pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>("SELECT session_ver FROM users WHERE id = $1")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };
        let (u0, a0) = (sv(u).await, sv(a).await);

        // JWT: new key on disk, every session_ver bumped now.
        assert_eq!(rotate_jwt(&db.pool, &dir).await.unwrap(), 2);
        assert_eq!((sv(u).await, sv(a).await), (u0 + 1, a0 + 1));
        let after = install::ensure(&cfg).unwrap();
        assert_ne!(after.jwt_secret, before.jwt_secret);

        // Admin prefix (D4: in the database, effective at once).
        let p = crate::access::cli_rotate_prefix(&db.pool).await.unwrap();
        assert_ne!(p, before.route_prefix);
        assert_eq!(
            crate::access::cli_read(&db.pool)
                .await
                .unwrap()
                .0
                .as_deref(),
            Some(p.as_str())
        );

        let rows = audit_actions(&db).await;
        let want: Vec<(String, String)> = ["secrets.rotate_jwt", "settings.admin_prefix.rotate"]
            .iter()
            .map(|a| ("cli".to_string(), a.to_string()))
            .collect();
        assert_eq!(rows, want);
        // No secret material in the rows.
        let text: String = sqlx::query_scalar("SELECT string_agg(after::text, ' ') FROM audit_log")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert!(
            !text.contains(&p) && !text.contains(&after.jwt_secret),
            "{text}"
        );
        std::fs::remove_dir_all(&dir).ok();
        db.drop().await;
    }
}
