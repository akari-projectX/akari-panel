//! Red team 2026-10, area C (nodes, enrollment, update and install supply
//! chain): regression tests for what the review found. Each test fails on
//! the code before its fix.

use std::time::Duration;

use sha2::{Digest, Sha256};
use tonic::Code;
use uuid::Uuid;

use crate::pb::agent_channel_client::AgentChannelClient;
use crate::pb::agent_up::Msg as UpMsg;
use crate::pb::{AgentInfo, FetchArtifactRequest, Hello};
use crate::testdb::TestDb;
use crate::testdb::fake_agent::PanelHarness;

/// C-1: every string of a Hello is agent input. A compromised node used to
/// be able to park megabytes in `servers` per Hello (the admin API returns
/// these columns for every server on every list) and in the panel's log.
#[tokio::test]
async fn hello_text_is_bounded() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let panel = PanelHarness::start(&db).await;
    let server = db.server().await;
    let creds = panel.register(&db, server).await;
    let agent = panel.connect(&creds).await.expect("connect");
    let big = "a".repeat(1 << 20);
    agent
        .send_up(UpMsg::Hello(Hello {
            session_id: big.clone(),
            protocol_version: crate::grpc::MIN_AGENT_PROTOCOL,
            info: Some(AgentInfo {
                agent_version: big.clone(),
                core_version: big.clone(),
                os: big.clone(),
                arch: big,
            }),
            ..Default::default()
        }))
        .await;
    let mut lens: Option<Vec<i32>> = None;
    for _ in 0..250 {
        let row: Option<Vec<Option<i32>>> = sqlx::query_scalar(
            "SELECT ARRAY[length(agent_version), length(core_version), length(agent_os), \
                          length(agent_arch), coalesce(length(agent_session), 0)] \
             FROM servers WHERE id = $1 AND agent_version IS NOT NULL",
        )
        .bind(server)
        .fetch_optional(&db.pool)
        .await
        .unwrap();
        if let Some(r) = row {
            lens = Some(r.into_iter().map(|n| n.unwrap_or(0)).collect());
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let lens = lens.expect("the Hello was recorded");
    for (len, max, what) in [
        (lens[0], 64, "agent_version"),
        (lens[1], 64, "core_version"),
        (lens[2], 16, "agent_os"),
        (lens[3], 16, "agent_arch"),
        (lens[4], 128, "agent_session"),
    ] {
        assert!(len <= max, "{what} is {len} characters");
    }
    drop(agent);
    panel.stop().await;
    db.drop().await;
}

/// A complete release of `chunks` MiB (rows of 1 MiB, as the store writes
/// them); returns its digest.
async fn release_of(pg: &sqlx::PgPool, chunks: usize) -> String {
    let id = Uuid::new_v4();
    let data = vec![7u8; 1 << 20];
    let mut h = Sha256::new();
    for _ in 0..chunks {
        h.update(&data);
    }
    let sha = hex::encode(h.finalize());
    sqlx::query(
        "INSERT INTO agent_releases (id, version, os, arch, sha256, size, manifest, \
         signatures, key_id, min_panel_protocol, complete_at) \
         VALUES ($1, 'v1.0.0', 'linux', 'amd64', $2, $3, '\\x00', '[]', 'k', 3, now())",
    )
    .bind(id)
    .bind(&sha)
    .bind((chunks << 20) as i64)
    .execute(pg)
    .await
    .unwrap();
    for idx in 0..chunks {
        sqlx::query("INSERT INTO agent_release_chunks (release_id, idx, data) VALUES ($1, $2, $3)")
            .bind(id)
            .bind(idx as i32)
            .bind(&data)
            .execute(pg)
            .await
            .unwrap();
    }
    sha
}

/// C-2: the download slots of an instance are shared by every node and
/// every install link. One node that opens streams and stops reading used
/// to take all of them (a stalled reader holds its slot for a minute per
/// chunk), so no other node could fetch a self-update.
#[tokio::test]
async fn one_node_cannot_hold_every_download_slot() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let panel = PanelHarness::start_with(&db, |c| c.limits.max_concurrent_downloads = 2).await;
    let sha = release_of(&db.pool, 8).await;
    let (a, b) = (db.server().await, db.server().await);
    let creds_a = panel.register(&db, a).await;
    let creds_b = panel.register(&db, b).await;
    let request = FetchArtifactRequest {
        sha256: sha.clone(),
        offset: 0,
    };
    let mut hog = AgentChannelClient::new(panel.channel(Some(&creds_a)).await.unwrap());
    // Streams opened and never read.
    let mut held = Vec::new();
    for _ in 0..2 {
        if let Ok(s) = hog.fetch_artifact(request.clone()).await {
            held.push(s);
        }
    }
    let got = panel
        .fetch(Some(&creds_b), &sha, 0)
        .await
        .expect("another node still gets a download slot");
    assert_eq!(got.len(), 8 << 20);
    // The hog itself is told to wait, not queued behind itself.
    let again = hog.fetch_artifact(request).await.map(|_| ()).unwrap_err();
    assert_eq!(again.code(), Code::ResourceExhausted);
    drop(held);
    panel.stop().await;
    db.drop().await;
}
