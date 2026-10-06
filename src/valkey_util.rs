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

pub async fn set_online(state: &AppState, server_id: uuid::Uuid) {
    set_with_ttl(
        state,
        format!("akari:server:online:{server_id}"),
        "1".into(),
        60,
    )
    .await;
}

/// A server heartbeat: the status blob (600 s) and the liveness key (60 s)
/// in one pipelined round trip (review 2026-10-02 W9: the stream read loop
/// awaits this, so two sequential round trips delayed the agent's next
/// message, e.g. a TrafficReport, twice as long). Order is kept: the read
/// loop still awaits it, so a later delete (`grpc::forget_server`) cannot be
/// overtaken by an earlier heartbeat.
pub async fn store_heartbeat(state: &AppState, server_id: uuid::Uuid, blob: String) {
    let pipeline = state.valkey().next().pipeline();
    let queued: Result<(), Error> = async {
        let () = pipeline
            .set(
                format!("akari:server:hb:{server_id}"),
                blob,
                Some(Expiration::EX(600)),
                None,
                false,
            )
            .await?;
        let () = pipeline
            .set(
                format!("akari:server:online:{server_id}"),
                "1",
                Some(Expiration::EX(60)),
                None,
                false,
            )
            .await?;
        pipeline.all::<()>().await
    }
    .await;
    if let Err(e) = queued {
        tracing::warn!(error = %e, "valkey heartbeat write failed");
    }
}

/// Delete keys (best effort; they carry TTLs anyway).
pub async fn del(state: &AppState, keys: Vec<String>) {
    if let Err(e) = state.valkey().del::<(), _>(keys).await {
        tracing::warn!(error = %e, "valkey del failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// W9: one pipelined round trip writes both heartbeat keys, each with
    /// its own TTL.
    #[tokio::test]
    async fn heartbeat_writes_blob_and_liveness() {
        let Some(db) = crate::testdb::TestDb::new().await else {
            return;
        };
        let st = AppState::for_test(db.pool.clone()).await;
        let server = uuid::Uuid::new_v4();
        store_heartbeat(&st, server, "{\"cpu\":1}".into()).await;
        let (hb, on) = (
            format!("akari:server:hb:{server}"),
            format!("akari:server:online:{server}"),
        );
        let blob: Option<String> = st.valkey().get(&hb).await.unwrap();
        let live: Option<String> = st.valkey().get(&on).await.unwrap();
        assert_eq!(blob.as_deref(), Some("{\"cpu\":1}"));
        assert_eq!(live.as_deref(), Some("1"));
        let hb_ttl: i64 = st.valkey().ttl(&hb).await.unwrap();
        let on_ttl: i64 = st.valkey().ttl(&on).await.unwrap();
        assert!((590..=600).contains(&hb_ttl), "{hb_ttl}");
        assert!((50..=60).contains(&on_ttl), "{on_ttl}");
        del(&st, vec![hb, on]).await;
        db.drop().await;
    }
}
