//! Red team 2026-10 (area B, money): regression tests of the findings.

use axum::http::StatusCode;

use super::*;

/// A notify body above the framework's body limit is a refusal like any
/// other: the canonical rejection (404, empty), not a 413 that names the
/// route.
#[tokio::test]
async fn oversized_notify_is_the_canonical_rejection() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mock = Mock::start().await;
    let state = paid_state(&db, &mock).await;
    let baseline = post_notify(&state, rand_ip(), b"x=1".to_vec()).await;
    assert_eq!(baseline.status, StatusCode::NOT_FOUND);
    for size in [20_000usize, 3 << 20] {
        let r = post_notify(&state, rand_ip(), vec![b'a'; size]).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{size} bytes");
        assert!(r.body.is_empty(), "{size} bytes");
        let names = |h: &axum::http::HeaderMap| {
            let mut v: Vec<String> = h.keys().map(|k| k.as_str().to_string()).collect();
            v.retain(|k| k != "date");
            v.sort();
            v
        };
        assert_eq!(names(&r.headers), names(&baseline.headers), "{size} bytes");
    }
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM payment_events WHERE outcome = 'oversized' AND NOT verified",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(n, 2, "both oversized notifies leave an event");
    drop(state);
    db.drop().await;
}
