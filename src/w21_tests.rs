//! W21 (admin UX) route-level tests: user search/filters/total, plan +
//! prices in one transaction, the site name setting, and stable error
//! codes on real endpoints.

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for};

async fn setup() -> Option<(TestDb, AppState, Client)> {
    let db = TestDb::new().await?;
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = db.admin().await;
    let c = client_for(&state, admin).await;
    Some((db, state, c))
}

fn ids(v: &Value) -> Vec<String> {
    v["users"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| {
            let e = u["email"].as_str().unwrap();
            e.split('@').next().unwrap().to_string()
        })
        .collect()
}

/// An account `<local>@example.com`.
async fn user(db: &TestDb, local: &str, extra: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, email, created_at) VALUES ($1, $2, now() - interval '1 hour' * \
         (SELECT count(*) FROM users))",
    )
    .bind(id)
    .bind(format!("{local}@example.com"))
    .execute(&db.pool)
    .await
    .unwrap();
    if !extra.is_empty() {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE users SET {extra} WHERE id = $1"
        )))
        .bind(id)
        .execute(&db.pool)
        .await
        .unwrap();
    }
    id
}

#[tokio::test]
async fn users_search_filters_sort_and_total() {
    let Some((db, _state, c)) = setup().await else {
        return;
    };
    user(&db, "alice", "email_verified_at = now()").await;
    user(&db, "albert", "traffic_used_bytes = 500").await;
    user(&db, "bob", "expires_at = now() - interval '1 day'").await;
    user(&db, "carol", "enabled = false, disabled_reason = 'quota'").await;
    user(&db, "dave", "enabled = false, disabled_reason = 'admin'").await;
    let erin = user(&db, "erin", "email = 'zed@example.org'").await;
    // A plan held by erin.
    let plan = Uuid::new_v4();
    sqlx::query("INSERT INTO plans (id, name, reset_period) VALUES ($1, 'gold', 'none')")
        .bind(plan)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO user_plans (id, user_id, plan_id, status, period_anchor, term_kind) \
         VALUES ($1, $2, $3, 'active', now(), 'onetime')",
    )
    .bind(Uuid::new_v4())
    .bind(erin)
    .bind(plan)
    .execute(&db.pool)
    .await
    .unwrap();

    let get = |q: String| {
        let c = &c;
        async move {
            let r = c.get(&format!("/test/api/v1/users{q}")).await;
            assert_eq!(r.status, StatusCode::OK, "{q}: {:?}", r.json());
            r.json()
        }
    };
    // Everyone (the admin included), oldest first by default.
    let all = get(String::new()).await;
    assert_eq!(all["total"], 7);
    // Case-insensitive address prefix.
    let v = get("?q=AL&sort=email".into()).await;
    assert_eq!(ids(&v), ["albert", "alice"]);
    assert_eq!(v["total"], 2);
    assert_eq!(ids(&get("?q=zed@".into()).await), ["zed"]);
    // LIKE metacharacters are literal.
    assert_eq!(get("?q=%25".into()).await["total"], 0);
    assert_eq!(get("?q=_".into()).await["total"], 0);
    // Id prefix.
    let prefix = &erin.to_string()[..8];
    assert_eq!(ids(&get(format!("?q={prefix}")).await), ["zed"]);
    // Derived status (mutually exclusive) and role.
    assert_eq!(ids(&get("?status=expired".into()).await), ["bob"]);
    assert_eq!(ids(&get("?status=quota".into()).await), ["carol"]);
    assert_eq!(ids(&get("?status=banned".into()).await), ["dave"]);
    let active = get("?status=active&role=user&sort=email".into()).await;
    assert_eq!(ids(&active), ["albert", "alice", "zed"]);
    // Plan filter.
    assert_eq!(ids(&get(format!("?plan_id={plan}")).await), ["zed"]);
    assert_eq!(get("?plan_id=none&role=user".into()).await["total"], 5);
    // Sorts.
    assert_eq!(ids(&get("?sort=-traffic&limit=1".into()).await), ["albert"]);
    let newest = get("?sort=-created&role=user".into()).await;
    let oldest = get("?sort=created&role=user".into()).await;
    let mut rev = ids(&oldest);
    rev.reverse();
    assert_eq!(ids(&newest), rev);
    // Paging keeps the total.
    let p = get("?role=user&limit=2&offset=2&sort=email".into()).await;
    assert_eq!(ids(&p), ["bob", "carol"]);
    assert_eq!(p["total"], 6);
    // Bad input: coded 400s.
    for (q, code) in [
        ("?status=nope", "user.status_filter_invalid"),
        ("?sort=nope", "user.sort_invalid"),
        ("?plan_id=nope", "user.plan_filter_invalid"),
        ("?role=root", "user.role_invalid"),
    ] {
        let r = c.get(&format!("/test/api/v1/users{q}")).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{q}");
        assert_eq!(r.json()["code"], code, "{q}");
    }
    let long = "x".repeat(65);
    let r = c.get(&format!("/test/api/v1/users?q={long}")).await;
    assert_eq!(r.json()["code"], "user.query_too_long");
    assert_eq!(r.json()["params"], json!({ "max": 64 }));
    db.drop().await;
}

#[tokio::test]
async fn create_user_with_email() {
    let Some((db, _state, c)) = setup().await else {
        return;
    };
    let r = c
        .post(
            "/test/api/v1/users",
            json!({ "password": "password-123", "email": " Mail@Example.COM " }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    assert_eq!(r.json()["email"], "mail@example.com");
    assert_eq!(r.json()["email_verified"], true);
    // The same address again: 409 with its own code.
    let r = c
        .post(
            "/test/api/v1/users",
            json!({ "password": "password-123", "email": "MAIL@example.com" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "user.email_exists");
    let r = c
        .post("/test/api/v1/users", json!({ "password": "password-123" }))
        .await;
    assert_eq!(
        r.status,
        StatusCode::BAD_REQUEST,
        "D1: the address is required"
    );
    let r = c
        .post(
            "/test/api/v1/users",
            json!({ "password": "password-123", "email": "not-an-address" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "signup.invalid_email");
    let r = c
        .post(
            "/test/api/v1/users",
            json!({ "email": "xx4@example.com", "password": "short" }),
        )
        .await;
    assert_eq!(
        (r.json()["code"].clone(), r.json()["error"].clone()),
        (
            json!("account.password_too_short"),
            json!("password must be at least 8 characters")
        )
    );
    db.drop().await;
}

async fn audit_actions(db: &TestDb, plan: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id")
        .bind(plan)
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn plan_and_prices_in_one_transaction() {
    let Some((db, _state, c)) = setup().await else {
        return;
    };
    let prices = json!({ "on_sale": true, "prices": [
        { "period": "month", "price_cents": 990 },
        { "period": "days", "days": 7, "price_cents": 300 },
    ]});
    let r = c
        .post(
            "/test/api/v1/plans",
            json!({ "name": "one-save", "period": "monthly", "pricing": prices }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{:?}", r.json());
    let v = r.json();
    let id = v["id"].as_str().unwrap().to_string();
    assert_eq!(v["on_sale"], true);
    assert_eq!(v["prices"].as_array().unwrap().len(), 2);
    assert_eq!(
        audit_actions(&db, &id).await,
        ["plan.create", "plan.price.set"]
    );

    // Bad prices: nothing is created (one transaction, checked up front).
    let r = c
        .post(
            "/test/api/v1/plans",
            json!({ "name": "rolled-back", "period": "monthly",
                    "pricing": { "on_sale": true, "prices": [{ "period": "reset", "price_cents": 100 }] } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "plan.on_sale_needs_price");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM plans WHERE name = 'rolled-back'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    // A failure after the plan write (duplicate name) rolls the prices back
    // with it: the existing plan keeps its prices.
    let r = c
        .post(
            "/test/api/v1/plans",
            json!({ "name": "one-save", "period": "monthly",
                    "pricing": { "on_sale": false, "prices": [] } }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "plan.name_exists");

    // PATCH fields + prices together; a price error rolls the fields back.
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/plans/{id}"),
            Some(json!({ "description": "new text",
                         "pricing": { "on_sale": true, "prices": [{ "period": "year", "price_cents": 0 }] } })),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "plan.price_range");
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/plans/{id}"),
            Some(json!({ "description": "new text",
                         "pricing": { "on_sale": false, "prices": [{ "period": "year", "price_cents": 9900 }] } })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["description"], "new text");
    assert_eq!(r.json()["on_sale"], false);
    assert_eq!(r.json()["prices"][0]["period"], "year");
    // Pricing alone is a valid PATCH; nothing at all is not.
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/plans/{id}"),
            Some(json!({ "pricing": { "on_sale": true, "prices": [{ "period": "month", "price_cents": 100 }] } })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/plans/{id}"),
            Some(json!({})),
        )
        .await;
    assert_eq!(r.json()["code"], "request.no_fields");
    assert_eq!(
        audit_actions(&db, &id).await,
        [
            "plan.create",
            "plan.price.set",
            "plan.update",
            "plan.price.set",
            "plan.price.set"
        ]
    );
    db.drop().await;
}

#[tokio::test]
async fn site_name_setting() {
    let Some((db, state, c)) = setup().await else {
        return;
    };
    crate::settings::init(&state).await.unwrap();
    let v = c.get("/test/api/v1/settings").await.json();
    assert_eq!(v["site_name"], Value::Null);
    let version = v["version"].as_i64().unwrap();
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/settings/site",
            Some(json!({ "version": version, "site_name": "  星云加速  " })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    assert_eq!(r.json()["site_name"], "星云加速");
    // Stale version.
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/settings/site",
            Some(json!({ "version": version, "site_name": "x" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "settings.version_conflict");
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/settings/site",
            Some(json!({ "version": version + 1, "site_name": "a\u{7}b" })),
        )
        .await;
    assert_eq!(r.json()["code"], "settings.site_name_invalid");
    // Templates use it.
    let mut conn = db.pool.acquire().await.unwrap();
    let smtp = crate::mail::load(&mut conn).await.unwrap();
    assert_eq!(smtp.site(), "星云加速");
    assert_eq!(smtp.sender_name(), "星云加速");
    drop(conn);
    // Login page options carry it (after the reload every save triggers).
    crate::settings::reload(&state).await.unwrap();
    let anon = Client::new(&state, crate::testdb::http::rand_ip());
    assert_eq!(
        anon.get("/test/auth/options").await.json()["site_name"],
        "星云加速"
    );
    // Clearing restores the default.
    let r = c
        .req(
            Method::PUT,
            "/test/api/v1/settings/site",
            Some(json!({ "version": version + 1, "site_name": "" })),
        )
        .await;
    assert_eq!(r.json()["site_name"], Value::Null);
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action = 'settings.site.update'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(n, 2);
    db.drop().await;
}

#[tokio::test]
async fn error_bodies_carry_codes() {
    let Some((db, state, c)) = setup().await else {
        return;
    };
    // Unauthenticated and forbidden.
    let anon = Client::new(&state, crate::testdb::http::rand_ip());
    let r = anon.get("/test/api/v1/users").await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.json()["code"], "auth.unauthorized");
    let u = db.user().await;
    let r = client_for(&state, u).await.get("/test/api/v1/users").await;
    assert_eq!(r.json()["code"], "auth.forbidden");
    // Malformed body.
    let r = c
        .post_raw("/test/api/v1/plans", "application/json", b"{nope".to_vec())
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "request.invalid_body");
    assert!(r.json()["params"]["detail"].is_string());
    // Params of a range error.
    let r = c
        .post(
            "/test/api/v1/plans",
            json!({ "name": "p", "period": "monthly", "speed_limit_mbps": 0 }),
        )
        .await;
    assert_eq!(
        r.json(),
        json!({
            "error": "speed_limit_mbps must be 1..=100000",
            "code": "plan.speed_limit_range",
            "params": { "max_speed_mbps": 100000 },
        })
    );
    // A conflict from the database guard (last enabled admin).
    let me: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE role = 'admin'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let r = c
        .req(
            Method::PATCH,
            &format!("/test/api/v1/users/{me}"),
            Some(json!({ "role": "user" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "user.last_admin");
    db.drop().await;
}
