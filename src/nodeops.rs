use std::io::Write as _;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};

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

/// `akari settings unset <field>`: clear a database setting (audited as
/// cli), e.g. a mistyped main domain that the host gate now refuses.
pub async fn settings_unset(cfg: PanelConfig, field: String) -> Result<()> {
    let pg = connect(&cfg).await?;
    crate::settings::cli_unset(&cfg, &pg, &field).await
}

/// Creates the first admin (or any) account. Reads the password from
/// AKARI_ADMIN_PASSWORD or a hidden interactive prompt.
pub async fn admin_add(cfg: PanelConfig, login: String, role: String) -> Result<()> {
    if role != "admin" && role != "user" {
        bail!("role must be 'admin' or 'user'");
    }
    let hash = read_password_hash()?;
    let pg = connect(&cfg).await?;
    let id = uuid::Uuid::new_v4();
    let mut tx = pg.begin().await?;
    sqlx::query("INSERT INTO users (id, login, password_hash, role) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(&login)
        .bind(&hash)
        .bind(&role)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("insert user {login}"))?;
    let after = serde_json::json!({
        "login": login, "role": role, "enabled": true, "password": crate::audit::CHANGED,
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
    println!("created {role} account: {login} ({id})");
    if role == "admin" {
        print_2fa_hint(&cfg);
    }
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
pub async fn admin_passwd(cfg: PanelConfig, login: String) -> Result<()> {
    let hash = read_password_hash()?;
    let pg = connect(&cfg).await?;
    let mut tx = pg.begin().await?;
    let id: Option<uuid::Uuid> =
        sqlx::query_scalar("UPDATE users SET password_hash = $2 WHERE login = $1 RETURNING id")
            .bind(&login)
            .bind(&hash)
            .fetch_optional(&mut *tx)
            .await
            .with_context(|| format!("update user {login}"))?;
    let Some(id) = id else {
        bail!("no such account: {login}");
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
    println!("password changed for {login}; its sessions are revoked");
    Ok(())
}

/// `akari node add <name>`: create the node with a one-time enrollment
/// token and write the bootstrap file (panel address, server name, CA,
/// token — no private key: the agent generates its key and enrolls, M1-8).
pub async fn node_add(cfg: PanelConfig, name: String, out: Option<PathBuf>) -> Result<()> {
    let inst = install::ensure(&cfg)?;
    let pg = connect(&cfg).await?;
    let mut tx = pg.begin().await?;
    let endpoint = crate::settings::node_endpoint(&mut tx, &cfg).await?;
    let (id, token, expires) = crate::enroll::apply_create_node(
        &mut tx,
        &Actor::cli(),
        &name,
        cfg.agent.enroll_token_ttl_secs,
        None,
        &endpoint,
    )
    .await
    .map_err(|e| anyhow::anyhow!("node {name}: {}", e.message()))?;
    let out_path = out.unwrap_or_else(|| PathBuf::from(format!("{name}-bootstrap.toml")));
    // Written before the commit: a committed node always has its file.
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
    writeln!(say, "node registered:  {id}")?;
    writeln!(say, "bootstrap file:   {}", out_path.display())?;
    writeln!(say, "enrollment token expires {}", expires.to_rfc3339())?;
    Ok(())
}

/// `akari node enroll-token <id>`: a new one-time enrollment token for an
/// existing node (the first one expired, or the agent's state was lost)
/// and its bootstrap file. Once the agent enrolls with it, the node's
/// previous certificates are revoked.
pub async fn node_enroll_token(
    cfg: PanelConfig,
    id: uuid::Uuid,
    out: Option<PathBuf>,
) -> Result<()> {
    let inst = install::ensure(&cfg)?;
    let pg = connect(&cfg).await?;
    let mut tx = pg.begin().await?;
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM nodes WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(name) = name else {
        bail!("no such node: {id}");
    };
    let endpoint = crate::settings::node_endpoint(&mut tx, &cfg).await?;
    let (token, expires) = crate::enroll::apply_issue_token(
        &mut tx,
        &Actor::cli(),
        id,
        cfg.agent.enroll_token_ttl_secs,
        None,
        &endpoint,
    )
    .await
    .map_err(|e| anyhow::anyhow!("node {id}: {}", e.message()))?;
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
    writeln!(say, "new enrollment token for node {id}")?;
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

/// Phase 1 of a node deletion (see api::apply_begin_delete_node); a running
/// panel (reaper) completes it.
pub async fn node_delete(cfg: PanelConfig, id: uuid::Uuid) -> Result<()> {
    let pg = connect(&cfg).await?;
    let mut tx = pg.begin().await?;
    let started = crate::api::apply_begin_delete_node(&mut tx, &Actor::cli(), id)
        .await
        .map_err(|e| anyhow::anyhow!("node {id}: {}", e.message()))?;
    tx.commit().await?;
    if started {
        println!("node {id}: deletion started (disabled; certificate is revoked and the node");
        println!("removed by the running panel once the agent runs the empty state)");
    } else {
        println!("node {id}: deletion already in progress");
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct NodeListRow {
    id: uuid::Uuid,
    name: String,
    status: String,
    agent_version: Option<String>,
    core_version: Option<String>,
    last_seen_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn node_list(cfg: PanelConfig) -> Result<()> {
    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&cfg.database_url)
        .await?;
    let rows = sqlx::query_as::<_, NodeListRow>(
        "SELECT id, name, CASE WHEN deleting_at IS NOT NULL THEN 'deleting' \
         WHEN NOT enabled THEN 'disabled' ELSE status END AS status, agent_version, \
         core_version, last_seen_at FROM nodes ORDER BY created_at",
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

fn print_2fa_hint(cfg: &PanelConfig) {
    if cfg.auth.require_admin_2fa {
        println!("two-factor authentication is required (auth.require_admin_2fa): set up an");
        println!("authenticator app at the first login.");
    } else {
        println!("two-factor authentication is recommended: set it up in the console");
        println!("(账户 / Account) after logging in.");
    }
}

/// `akari admin reset-2fa <login>`: remove the account's 2FA (it logs in
/// with the password alone until it sets 2FA up again) and end its
/// sessions.
pub async fn admin_reset_2fa(cfg: PanelConfig, login: String) -> Result<()> {
    let pg = connect(&cfg).await?;
    let was = reset_2fa(&pg, &login).await?;
    println!("two-factor authentication of {login} reset (was: {was}); its sessions are revoked");
    Ok(())
}

async fn reset_2fa(pg: &sqlx::PgPool, login: &str) -> Result<&'static str> {
    let mut tx = pg.begin().await?;
    let id: Option<uuid::Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE login = $1")
        .bind(login)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(id) = id else {
        bail!("no such account: {login}");
    };
    let was = crate::api::apply_reset_totp(&mut tx, &Actor::cli(), id)
        .await
        .map_err(|e| anyhow::anyhow!("{login}: {}", e.message()))?;
    tx.commit().await?;
    Ok(was)
}

/// `akari secrets rotate-prefix`.
pub async fn secrets_rotate_prefix(cfg: PanelConfig) -> Result<()> {
    let pg = connect(&cfg).await?;
    let prefix = rotate_prefix(&pg, &cfg.data_dir).await?;
    println!("new route prefix: /{prefix}");
    println!("restart every panel instance to apply it; until then the old prefix keeps working.");
    println!("every subscription URL changes with it: users need their new URL (portal).");
    Ok(())
}

/// Audit row and file write: the new prefix is written before the commit,
/// so a committed row always means the file changed. The prefix itself is
/// never recorded.
async fn rotate_prefix(pg: &sqlx::PgPool, data_dir: &std::path::Path) -> Result<String> {
    let mut tx = pg.begin().await?;
    crate::audit::record(
        &mut tx,
        &Actor::cli(),
        "secrets.rotate_prefix",
        "install",
        None,
        None,
        Some(serde_json::json!({ "route_prefix": crate::audit::CHANGED })),
    )
    .await?;
    let prefix = install::rotate_prefix(data_dir)?;
    tx.commit()
        .await
        .context("prefix rotated, but recording it in the audit log failed")?;
    Ok(prefix)
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
            panel_addr: cfg.grpc.advertise.clone(),
            server_name: cfg.grpc.server_name.clone(),
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
        sqlx::query_as("SELECT actor_login, action FROM audit_log ORDER BY id")
            .fetch_all(&db.pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn rotations_and_reset_are_audited_and_effective() {
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

        // Prefix: the next start serves the new one.
        let p = rotate_prefix(&db.pool, &dir).await.unwrap();
        assert_ne!(p, before.route_prefix);
        assert_eq!(install::ensure(&cfg).unwrap().route_prefix, p);

        // reset-2fa by login: rows gone, sessions revoked.
        let login: String = sqlx::query_scalar("SELECT login FROM users WHERE id = $1")
            .bind(a)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        // db.admin() has an active TOTP.
        sqlx::query("INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, 'h')")
            .bind(a)
            .execute(&db.pool)
            .await
            .unwrap();
        let a1 = sv(a).await;
        let was = reset_2fa(&db.pool, &login).await.unwrap();
        assert_eq!(was, "active");
        assert_eq!(sv(a).await, a1 + 1);
        let left: i64 = sqlx::query_scalar(
            "SELECT (SELECT count(*) FROM user_totp) + (SELECT count(*) FROM user_recovery_codes)",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(left, 0);
        assert!(reset_2fa(&db.pool, "no-such-login").await.is_err());

        let rows = audit_actions(&db).await;
        let want: Vec<(String, String)> = [
            "secrets.rotate_jwt",
            "secrets.rotate_prefix",
            "user.totp.reset",
        ]
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
