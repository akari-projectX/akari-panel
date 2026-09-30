use fred::prelude::*;

use crate::state::AppState;

/// Small helpers for the hot-path Valkey keys (liveness + heartbeat blobs).
/// All failures are logged and swallowed: cache writes must never take down
/// the control stream.
pub async fn set_with_ttl(state: &AppState, key: String, value: String, ttl_secs: u64) {
    if let Err(e) = state
        .valkey()
        .set::<(), _, _>(
            key,
            value,
            Some(Expiration::EX(ttl_secs as i64)),
            None,
            false,
        )
        .await
    {
        tracing::warn!(error = %e, "valkey set failed");
    }
}

pub async fn set_online(state: &AppState, node_id: uuid::Uuid) {
    set_with_ttl(
        state,
        format!("akari:node:online:{node_id}"),
        "1".into(),
        60,
    )
    .await;
}
