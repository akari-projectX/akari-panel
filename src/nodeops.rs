use std::path::PathBuf;

use anyhow::{bail, Context, Result};

use crate::config::PanelConfig;
use crate::install;

/// Creates the first admin (or any) account. Reads the password from
/// AKARI_ADMIN_PASSWORD or a hidden interactive prompt.
pub async fn admin_add(cfg: PanelConfig, login: String, role: String) -> Result<()> {
    if role != "admin" && role != "user" {
        bail!("role must be 'admin' or 'user'");
    }
    let hash = read_password_hash()?;

    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&cfg.database_url)
        .await?;
    crate::db::migrate(&pg).await?;

    let id = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, login, password_hash, role) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(&login)
        .bind(&hash)
        .bind(&role)
        .execute(&pg)
        .await
        .with_context(|| format!("insert user {login}"))?;
    println!("created {role} account: {login} ({id})");
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
    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&cfg.database_url)
        .await?;
    crate::db::migrate(&pg).await?;
    let n = sqlx::query("UPDATE users SET password_hash = $2 WHERE login = $1")
        .bind(&login)
        .bind(&hash)
        .execute(&pg)
        .await
        .with_context(|| format!("update user {login}"))?
        .rows_affected();
    if n == 0 {
        bail!("no such account: {login}");
    }
    println!("password changed for {login}; its sessions are revoked");
    Ok(())
}

pub async fn node_add(cfg: PanelConfig, name: String, out: Option<PathBuf>) -> Result<()> {
    let inst = install::ensure(&cfg)?;
    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&cfg.database_url)
        .await?;
    crate::db::migrate(&pg).await?;

    let id = uuid::Uuid::new_v4();
    let (cert_pem, key_pem, serial) =
        install::issue_agent_cert(&inst.ca_pem, &inst.ca_key_pem, &id.to_string())?;

    sqlx::query("INSERT INTO nodes (id, name, cert_serial, status) VALUES ($1, $2, $3, 'pending')")
        .bind(id)
        .bind(&name)
        .bind(&serial)
        .execute(&pg)
        .await
        .with_context(|| format!("insert node {name}"))?;

    let bootstrap = format!(
        "# akari agent bootstrap for node '{name}'\n\
         # Contains the agent private key. Transfer securely and delete after provisioning.\n\
         panel_addr = \"{addr}\"\n\
         server_name = \"{server_name}\"\n\
         \n[identity]\nca_pem = '''{ca}'''\ncert_pem = '''{cert}'''\nkey_pem = '''{key}'''\n",
        addr = cfg.grpc.advertise,
        server_name = cfg.grpc.server_name,
        ca = inst.ca_pem,
        cert = cert_pem,
        key = key_pem,
    );

    let out_path = out.unwrap_or_else(|| PathBuf::from(format!("{name}-bootstrap.toml")));
    std::fs::write(&out_path, bootstrap)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(0o600))?;
    }

    println!("node registered:  {id}");
    println!("bootstrap file:   {}", out_path.display());
    Ok(())
}

/// Phase 1 of a node deletion (see api::apply_begin_delete_node); a running
/// panel (reaper) completes it.
pub async fn node_delete(cfg: PanelConfig, id: uuid::Uuid) -> Result<()> {
    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&cfg.database_url)
        .await?;
    crate::db::migrate(&pg).await?;
    let mut tx = pg.begin().await?;
    let started = crate::api::apply_begin_delete_node(&mut tx, id)
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
