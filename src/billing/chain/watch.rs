//! C2: the on-chain payment watcher. Every instance ticks; one wins each
//! round (advisory try-lock `akari.chain_watch.<schema>`, held by a lock
//! transaction that only serializes rounds — every write is its own short
//! transaction, so nothing waits on an RPC call).
//!
//! Per watched method (enabled, or still holding live reservations or
//! pending transfers — a disabled method's late payments are still seen):
//!
//! 1. `eth_blockNumber` → head; the confirmation depth N makes every block
//!    `≤ head + 1 − N` "safe".
//! 2. Logs of the token's `Transfer` to the address from the cursor to the
//!    head, in ranges of `log_range` blocks (halved when a node refuses a
//!    range), at most `MAX_CHUNKS` ranges per round. Every transfer of at
//!    least 0.01 USDT is recorded once per (chain, tx, log index)
//!    (`chain_transfers`, status pending; a re-read in another block —
//!    a reorg below the depth — moves it). The cursor only advances to
//!    the safe height, so the unconfirmed tail is read again next round.
//! 3. Pending transfers at the depth are re-checked: the receipt must
//!    exist, have succeeded, still sit in the recorded block (else the row
//!    follows the receipt's block and waits for the depth again) and
//!    contain the same log; the block's hash must match and gives the
//!    block time. Missing receipts for long → dropped (reorged out).
//! 4. Settlement (`settle`, one transaction under `entitle::lock`): the
//!    reservation of this method with exactly this amount whose window
//!    (`created_at − slack ..= reserved_until`) contains the block time →
//!    `apply_mark_paid` (late payment of an expired order still fulfils);
//!    no reservation, two, or an order already paid → `unmatched` for the
//!    admin. An event row and, for unmatched money, an audit row.
//!
//! RPC failures only delay: the cursor stays, the error is kept on the
//! method's cursor row (`failing_since`), the system status turns red
//! after `FAILING_RED`.

use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde_json::json;
use uuid::Uuid;

use super::rpc::{Log, Rpc, RpcError};
use super::{MIN_UNITS, Params};
use crate::audit::Actor;
use crate::billing::orders::{self, Paid, Via};
use crate::state::AppState;
use crate::sysstatus::{Job, Outcome};

/// Round cadence.
const TICK: Duration = Duration::from_secs(5);
/// Log ranges read per method per round (catch-up after an outage spreads
/// over rounds).
const MAX_CHUNKS: usize = 20;
/// Range halvings allowed per round (a node with a strict range limit).
const MAX_SPLITS: usize = 16;
/// Pending transfers re-checked per method per round.
const CONFIRM_BATCH: i64 = 50;
/// A receipt still unknown this long after the transfer was seen at the
/// depth = the transfer left the chain.
const DROP_AFTER_SECS: f64 = 900.0;
/// A reservation matches transfers from this long before its order was
/// created (chain clock vs database clock).
const MATCH_SLACK_SECS: f64 = 600.0;
/// A method failing this long turns the job red on 系统状态.
const FAILING_RED_SECS: f64 = 600.0;

const LOCK_SQL: &str = "SELECT pg_try_advisory_xact_lock(hashtextextended('akari.chain_watch.' || current_schema(), 0))";

/// actor_label of on-chain payments.
pub const ACTOR: &str = "chain";

pub fn actor() -> Actor {
    Actor {
        id: None,
        label: ACTOR.into(),
        ip: None,
    }
}

/// What one round did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Round {
    pub methods: usize,
    pub recorded: usize,
    pub credited: usize,
    pub unmatched: usize,
    pub dropped: usize,
    /// Methods whose RPC failed this round.
    pub failed: usize,
    /// Methods failing for longer than `FAILING_RED_SECS`.
    pub failing_long: usize,
}

/// The methods to watch with their parameters.
async fn watched(state: &AppState) -> anyhow::Result<Vec<(Uuid, Params)>> {
    let mut c = state.pg().acquire().await?;
    let rows = crate::billing::methods::load_all(&mut c).await?;
    let busy: Vec<Uuid> = sqlx::query_scalar(
        "SELECT pm.id FROM payment_methods pm WHERE pm.kind = $1 AND (pm.enabled \
         OR EXISTS (SELECT 1 FROM chain_payments cp WHERE cp.method_id = pm.id \
                    AND cp.active AND cp.reserved_until > now()) \
         OR EXISTS (SELECT 1 FROM chain_transfers t WHERE t.method_id = pm.id \
                    AND t.status = 'pending'))",
    )
    .bind(super::KIND)
    .fetch_all(&mut *c)
    .await?;
    let mut out = Vec::new();
    for row in rows.iter().filter(|r| busy.contains(&r.id)) {
        let secrets = crate::billing::methods::open_secrets(state.master_key(), row)
            .ok()
            .flatten()
            .unwrap_or_else(|| json!({}));
        match super::params_of(&row.config, &secrets) {
            Ok(p) => out.push((row.id, p)),
            Err(e) => {
                tracing::warn!(method = %row.id, error = e, "on-chain method not watchable");
                note_error(state, row.id, &format!("配置不完整：{e}")).await?;
            }
        }
    }
    Ok(out)
}

/// One round (None: another instance holds the round).
pub async fn round(state: &AppState) -> anyhow::Result<Option<Round>> {
    let mut lock = state.pg().begin().await?;
    let won: bool = sqlx::query_scalar(LOCK_SQL).fetch_one(&mut *lock).await?;
    if !won {
        return Ok(None);
    }
    let mut out = Round::default();
    for (id, p) in watched(state).await? {
        out.methods += 1;
        if let Err(e) = watch_method(state, id, &p, &mut out).await {
            out.failed += 1;
            tracing::warn!(method = %id, error = %e, "on-chain watch failed");
            note_error(state, id, &e.to_string()).await?;
        }
    }
    out.failing_long = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM chain_cursors c JOIN payment_methods pm ON pm.id = c.method_id \
         WHERE pm.enabled AND c.failing_since <= now() - make_interval(secs => $1)",
    )
    .bind(FAILING_RED_SECS)
    .fetch_one(state.pg())
    .await? as usize;
    lock.commit().await?;
    Ok(Some(out))
}

/// Keep a method's error (no URL in it: `RpcError` never carries one).
async fn note_error(state: &AppState, method: Uuid, error: &str) -> sqlx::Result<()> {
    let e: String = error.chars().take(300).collect();
    sqlx::query(
        "INSERT INTO chain_cursors (method_id, last_error, failing_since) VALUES ($1, $2, now()) \
         ON CONFLICT (method_id) DO UPDATE SET last_error = $2, \
         failing_since = COALESCE(chain_cursors.failing_since, now()), updated_at = now()",
    )
    .bind(method)
    .bind(e)
    .execute(state.pg())
    .await?;
    Ok(())
}

async fn watch_method(
    state: &AppState,
    method: Uuid,
    p: &Params,
    out: &mut Round,
) -> Result<(), RpcError> {
    let rpc = p.rpc();
    let head = rpc.block_number().await?;
    let depth = u64::from(p.confirmations);
    let safe = (head + 1).checked_sub(depth);
    let stored: Option<Option<i64>> =
        sqlx::query_scalar("SELECT next_block FROM chain_cursors WHERE method_id = $1")
            .bind(method)
            .fetch_optional(state.pg())
            .await
            .map_err(db)?;
    let mut next = match stored.flatten() {
        Some(n) => n as u64,
        None => head.saturating_sub(p.chain.lookback),
    };
    let mut from = next;
    let mut chunks = 0;
    let mut splits = 0;
    let mut range = p.log_range;
    while from <= head && chunks < MAX_CHUNKS {
        let to = head.min(from + range - 1);
        match rpc.logs(&p.token_lc(), &p.address_lc(), from, to).await {
            Ok(logs) => {
                for l in &logs {
                    out.recorded += record(state, method, p, l).await.map_err(db)?;
                }
                chunks += 1;
                // Only blocks at the depth are done with.
                if let Some(s) = safe {
                    next = next.max(to.min(s) + 1);
                }
                from = to + 1;
            }
            // A node refusing the range (too wide / too many results):
            // halve it and retry, a few times per round.
            Err(e) if range > 1 && splits < MAX_SPLITS && !matches!(e, RpcError::Transport(_)) => {
                range = range.div_ceil(2);
                splits += 1;
            }
            Err(e) => return Err(e),
        }
    }
    sqlx::query(
        "INSERT INTO chain_cursors (method_id, next_block, head, head_at) VALUES ($1, $2, $3, now()) \
         ON CONFLICT (method_id) DO UPDATE SET next_block = $2, head = $3, head_at = now(), \
         last_error = NULL, failing_since = NULL, updated_at = now()",
    )
    .bind(method)
    .bind(next as i64)
    .bind(head as i64)
    .execute(state.pg())
    .await
    .map_err(db)?;
    if let Some(s) = safe {
        confirm(state, method, p, &rpc, s, out).await?;
    }
    Ok(())
}

fn db(e: sqlx::Error) -> RpcError {
    // A database failure ends the method's round like an RPC failure (the
    // message is the database's, never a URL).
    RpcError::Transport(format!("database: {e}"))
}

/// Record a seen transfer (pending), or move a pending one to the block it
/// is in now. Returns 1 when a new row was written.
async fn record(state: &AppState, method: Uuid, p: &Params, l: &Log) -> sqlx::Result<usize> {
    let Some(units) = l
        .value
        .and_then(|v| i64::try_from(v).ok())
        .filter(|v| *v >= MIN_UNITS)
    else {
        return Ok(0);
    };
    let inserted: Option<bool> = sqlx::query_scalar(
        "INSERT INTO chain_transfers (method_id, chain, tx_hash, log_index, block_number, \
         block_hash, from_address, amount_units, order_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, \
           (SELECT order_id FROM chain_payments WHERE method_id = $1 AND amount_units = $8 \
            AND active AND reserved_until > now())) \
         ON CONFLICT (chain, tx_hash, log_index) DO UPDATE \
           SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash \
           WHERE chain_transfers.status = 'pending' AND chain_transfers.method_id = EXCLUDED.method_id \
           AND chain_transfers.block_hash <> EXCLUDED.block_hash \
         RETURNING xmax = 0",
    )
    .bind(method)
    .bind(p.chain.id)
    .bind(&l.tx_hash)
    .bind(l.log_index as i32)
    .bind(l.block_number as i64)
    .bind(&l.block_hash)
    .bind(&l.from)
    .bind(units)
    .fetch_optional(state.pg())
    .await?;
    Ok(usize::from(inserted == Some(true)))
}

#[derive(sqlx::FromRow)]
struct PendingTransfer {
    id: i64,
    tx_hash: String,
    log_index: i32,
    block_number: i64,
    block_hash: String,
    from_address: String,
    amount_units: i64,
    /// Seen long enough ago that a missing receipt means it is gone.
    stale: bool,
}

async fn confirm(
    state: &AppState,
    method: Uuid,
    p: &Params,
    rpc: &Rpc,
    safe: u64,
    out: &mut Round,
) -> Result<(), RpcError> {
    let due: Vec<PendingTransfer> = sqlx::query_as(
        "SELECT id, tx_hash, log_index, block_number, block_hash, from_address, amount_units, \
         seen_at <= now() - make_interval(secs => $4) AS stale \
         FROM chain_transfers WHERE method_id = $1 AND status = 'pending' AND block_number <= $2 \
         ORDER BY block_number, id LIMIT $3",
    )
    .bind(method)
    .bind(safe as i64)
    .bind(CONFIRM_BATCH)
    .bind(DROP_AFTER_SECS)
    .fetch_all(state.pg())
    .await
    .map_err(db)?;
    let (token, to) = (p.token_lc(), p.address_lc());
    for t in due {
        let Some(r) = rpc.receipt(&t.tx_hash, &token, &to).await? else {
            if t.stale {
                out.dropped += drop_transfer(state, t.id, "missing").await.map_err(db)?;
            }
            continue;
        };
        let same_log = r.logs.iter().any(|l| {
            i64::from(l.log_index) == i64::from(t.log_index)
                && l.from == t.from_address
                && l.value == u128::try_from(t.amount_units).ok()
        });
        if !r.success || !same_log {
            out.dropped += drop_transfer(state, t.id, "reverted").await.map_err(db)?;
            continue;
        }
        if r.block_hash != t.block_hash || r.block_number as i64 != t.block_number {
            // Re-included elsewhere: follow it and wait for the depth.
            sqlx::query(
                "UPDATE chain_transfers SET block_number = $2, block_hash = $3 \
                 WHERE id = $1 AND status = 'pending'",
            )
            .bind(t.id)
            .bind(r.block_number as i64)
            .bind(&r.block_hash)
            .execute(state.pg())
            .await
            .map_err(db)?;
            continue;
        }
        // Same block as recorded, which is at the depth (selected so).
        let Some(block) = rpc.block(r.block_number).await? else {
            continue;
        };
        if block.hash != r.block_hash {
            // The node's view moved under us: next round.
            continue;
        }
        let Some(at) = DateTime::<Utc>::from_timestamp(block.timestamp, 0) else {
            continue;
        };
        match settle(state, method, t.id, at)
            .await
            .map_err(|e| RpcError::Transport(format!("settlement: {}", e.message())))?
        {
            Settled::Credited => out.credited += 1,
            Settled::Unmatched => out.unmatched += 1,
            Settled::Gone => {}
        }
    }
    Ok(())
}

async fn drop_transfer(state: &AppState, id: i64, reason: &str) -> sqlx::Result<usize> {
    let r = sqlx::query(
        "UPDATE chain_transfers SET status = 'dropped', reason = $2, order_id = NULL \
         WHERE id = $1 AND status = 'pending'",
    )
    .bind(id)
    .bind(reason)
    .execute(state.pg())
    .await?;
    Ok(r.rows_affected() as usize)
}

/// What `settle` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    Credited,
    Unmatched,
    /// Not pending any more (settled elsewhere).
    Gone,
}

#[derive(sqlx::FromRow)]
struct Claimed {
    tx_hash: String,
    log_index: i32,
    amount_units: i64,
    from_address: String,
    block_number: i64,
}

#[derive(sqlx::FromRow)]
struct Candidate {
    order_id: Uuid,
    status: String,
    amount_cents: i64,
    out_trade_no: String,
}

/// Settle a confirmed transfer (block time `at`): pay its order exactly
/// once, or leave it unmatched for the admin. One transaction.
pub async fn settle(
    state: &AppState,
    method: Uuid,
    transfer: i64,
    at: DateTime<Utc>,
) -> Result<Settled, crate::auth::ApiError> {
    let mut tx = state.pg().begin().await?;
    // Lock order: entitle first (apply_mark_paid takes it again).
    crate::entitle::lock(&mut tx).await?;
    let claimed: Option<Claimed> = sqlx::query_as(
        "UPDATE chain_transfers SET block_time = $3, confirmed_at = now() \
         WHERE id = $1 AND method_id = $2 AND status = 'pending' \
         RETURNING tx_hash, log_index, amount_units, from_address, block_number",
    )
    .bind(transfer)
    .bind(method)
    .bind(at)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(t) = claimed else {
        return Ok(Settled::Gone);
    };
    let found: Vec<Candidate> = sqlx::query_as(
        "SELECT cp.order_id, o.status, o.amount_cents, o.out_trade_no \
         FROM chain_payments cp JOIN orders o ON o.id = cp.order_id \
         WHERE cp.method_id = $1 AND cp.amount_units = $2 \
         AND $3 >= cp.created_at - make_interval(secs => $4) AND $3 <= cp.reserved_until \
         ORDER BY cp.created_at LIMIT 2 FOR UPDATE OF o",
    )
    .bind(method)
    .bind(t.amount_units)
    .bind(at)
    .bind(MATCH_SLACK_SECS)
    .fetch_all(&mut *tx)
    .await?;
    let params = json!({
        "tx_hash": t.tx_hash, "log_index": t.log_index, "block_number": t.block_number,
        "from": t.from_address, "amount_units": t.amount_units,
        "amount": super::format_units(t.amount_units),
    });
    let actor = actor();
    let (status, reason, order) = match found.as_slice() {
        [o] if o.status != "paid" => {
            let r = orders::apply_mark_paid(
                &mut tx,
                &actor,
                o.order_id,
                Via::Chain,
                Some(&t.tx_hash),
                Some(o.amount_cents),
                None,
            )
            .await?;
            // The order row is locked and unpaid: this flips it (a
            // concurrent payment would show as already paid).
            let now = r != Paid::Already;
            (
                if now { "credited" } else { "unmatched" },
                (!now).then_some("order_paid"),
                Some(o),
            )
        }
        [o] => ("unmatched", Some("order_paid"), Some(o)),
        [] => ("unmatched", Some("no_order"), None),
        _ => ("unmatched", Some("ambiguous"), None),
    };
    sqlx::query("UPDATE chain_transfers SET status = $2, reason = $3, order_id = $4 WHERE id = $1")
        .bind(transfer)
        .bind(status)
        .bind(reason)
        .bind(order.map(|o| o.order_id))
        .execute(&mut *tx)
        .await?;
    orders::record_event(
        &mut tx,
        order.map(|o| o.order_id),
        order.map(|o| o.out_trade_no.as_str()),
        "chain",
        true,
        if status == "credited" {
            "paid"
        } else {
            reason.unwrap_or("unmatched")
        },
        Some(status),
        Some(params.clone()),
        None,
    )
    .await?;
    if status == "unmatched" {
        // Money arrived that paid nothing: on the record for the admin.
        crate::audit::record(
            &mut tx,
            &actor,
            "chain_transfer.unmatched",
            "chain_transfer",
            Some(transfer.to_string()),
            None,
            Some(json!({ "method_id": method, "reason": reason,
                         "order_id": order.map(|o| o.order_id), "transfer": params })),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(if status == "credited" {
        Settled::Credited
    } else {
        Settled::Unmatched
    })
}

/// The watcher loop (every instance; one wins each round).
pub async fn run(state: AppState) {
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let started = Instant::now();
        let st = state.sysstatus();
        match round(&state).await {
            Ok(None) => st.record(Job::ChainPayments, started, Outcome::Skipped, None),
            Ok(Some(r)) if r.failing_long > 0 => st.record(
                Job::ChainPayments,
                started,
                Outcome::Error,
                Some(&format!(
                    "{} 个链上收款方式的 RPC 持续失败（系统设置 → 支付查看错误）",
                    r.failing_long
                )),
            ),
            Ok(Some(_)) => st.record(Job::ChainPayments, started, Outcome::Ok, None),
            Err(e) => {
                tracing::warn!(error = %e, "on-chain watch round failed");
                st.record(
                    Job::ChainPayments,
                    started,
                    Outcome::Error,
                    Some(&e.to_string()),
                );
            }
        }
    }
}
