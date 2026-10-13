//! Real-database tests of the subscription routing (2026-10-13
//! `sub-service-groups`): each user's subscription carries only the lines
//! their plan grants (pinned lines and backups the user lacks are skipped,
//! a service with nothing left points at the default proxy), lines are
//! pinned by id (renames follow, disabled lines drop out), the catalog
//! endpoint, and the 1107 migration of W30 rules.

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::state::AppState;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

async fn post_id(c: &Client, path: &str, body: Value) -> String {
    let r = c.post(path, body).await;
    assert!(
        r.status.is_success(),
        "{path}: {} {}",
        r.status,
        String::from_utf8_lossy(&r.body)
    );
    r.json()["id"].as_str().unwrap().to_string()
}

/// A node with a direct entrance named `line` in `region`, in `group`.
async fn line(
    db: &TestDb,
    admin: &Client,
    name: &str,
    region: &str,
    host: &str,
    group: &str,
    tags: &[&str],
) -> Uuid {
    let node: Uuid = post_id(
        admin,
        "/test/api/v1/nodes",
        json!({
            "name": name,
            "region": region,
            "inbound": {"protocol": "vless", "port": 443,
                        "settings": {"clients": [], "decryption": "none"}},
            "direct": {"connect_host": host, "group_ids": [group]}
        }),
    )
    .await
    .parse()
    .unwrap();
    let e = db.direct(node).await;
    let r = admin
        .req(
            Method::PATCH,
            &format!("/test/api/v1/entrances/{e}"),
            Some(json!({"name": name, "tags": tags})),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    e
}

async fn subscriber(db: &TestDb, state: &AppState, admin: &Client, group: &str) -> String {
    let plan = post_id(
        admin,
        "/test/api/v1/plans",
        json!({"name": format!("p-{group}"), "period": "monthly", "group_ids": [group]}),
    )
    .await;
    let u = db.user().await;
    let r = admin
        .put(
            &format!("/test/api/v1/users/{u}/plan"),
            json!({"plan_id": plan, "period": "month"}),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let mut tx = db.pool.begin().await.unwrap();
    let t = crate::sub::rotate_token(&mut tx, state.master_key(), &crate::audit::Actor::test(), u)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    t
}

async fn fetch(state: &AppState, token: &str, format: &str) -> String {
    let c = Client::new(state, rand_ip());
    let r = c.get(&format!("/sub/{token}?format={format}")).await;
    assert_eq!(r.status, StatusCode::OK);
    String::from_utf8(r.body).unwrap()
}

/// The sing-box profile's groups: tag -> member tags.
async fn groups(state: &AppState, token: &str) -> Vec<(String, String, Vec<String>)> {
    let v: Value = serde_json::from_str(fetch(state, token, "sing-box").await.trim_end()).unwrap();
    v["outbounds"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["type"] == "selector" || o["type"] == "urltest")
        .map(|o| {
            (
                o["tag"].as_str().unwrap().to_string(),
                o["type"].as_str().unwrap().to_string(),
                o["outbounds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|m| m.as_str().unwrap().to_string())
                    .collect(),
            )
        })
        .collect()
}

fn members<'a>(g: &'a [(String, String, Vec<String>)], tag: &str) -> &'a [String] {
    &g.iter()
        .find(|(t, _, _)| t == tag)
        .unwrap_or_else(|| panic!("no group {tag} in {g:?}"))
        .2
}

#[tokio::test]
async fn per_user_lines_failover_and_renames() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test_with(db.pool.clone(), |c| {
        c.limits.sub_rate_per_token = 1000;
        c.limits.sub_rate_per_ip = 1000;
    })
    .await;
    let admin = client_for(&state, db.admin().await).await;
    let ga = post_id(&admin, "/test/api/v1/node-groups", json!({"name": "a"})).await;
    let gb = post_id(&admin, "/test/api/v1/node-groups", json!({"name": "b"})).await;
    let hk = line(&db, &admin, "HK", "香港", "1.1.1.1", &ga, &[]).await;
    let jp1 = line(&db, &admin, "JP1", "日本", "2.2.2.2", &ga, &[]).await;
    let jp2 = line(&db, &admin, "JP2", "日本", "3.3.3.3", &gb, &["解锁"]).await;
    let u1 = subscriber(&db, &state, &admin, &ga).await; // HK + JP1
    let u2 = subscriber(&db, &state, &admin, &gb).await; // JP2

    let version = admin.get("/test/api/v1/settings").await.json()["version"]
        .as_i64()
        .unwrap();
    let mut routing = serde_json::to_value(crate::sub::routing::recommended()).unwrap();
    routing["services"][0]["primary"] = json!(jp1);
    routing["services"][0]["backups"] = json!([{"entrance": hk}, {"region": "日本"}]);
    routing["services"][1]["primary"] = json!(jp2);
    routing["services"][1]["backups"] = json!([{"tag": "解锁"}]);
    routing["rest"] = json!({"region": "香港"});
    let r = admin
        .put(
            "/test/api/v1/settings/subscription",
            json!({"version": version, "routing": routing}),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    assert_eq!(
        r.json()["subscription"]["routing"]["value"]["services"][0]["primary"],
        json!(jp1)
    );

    // User 1: Netflix = JP1 → HK → 日本 (JP1); Google's lines are not
    // theirs: the default proxy, preselected on 香港.
    let g1 = groups(&state, &u1).await;
    assert_eq!(members(&g1, "♻️ Netflix 推荐"), ["JP1", "HK", "🌐 日本"]);
    assert_eq!(members(&g1, "🔍 Google")[0], "🚀 默认代理");
    assert!(!g1.iter().any(|(t, _, _)| t == "♻️ Google 推荐"));
    assert_eq!(members(&g1, "🚀 默认代理")[0], "🌐 香港");
    assert!(!g1.iter().any(|(t, _, _)| t.contains("解锁")), "{g1:?}");
    let all: Vec<&str> = g1
        .iter()
        .flat_map(|(_, _, m)| m.iter().map(String::as_str))
        .collect();
    assert!(!all.contains(&"JP2 | 解锁"), "another plan's line: {all:?}");
    let clash = fetch(&state, &u1, "clash").await;
    assert!(
        clash.contains("  - name: \"♻️ Netflix 推荐\"\n    type: fallback\n    hidden: true\n")
    );
    assert!(clash.contains("  - RULE-SET,geosite-netflix,🎬 Netflix\n"));

    // User 2: Netflix falls back to the region (JP2 is in 日本); Google =
    // JP2 → the 解锁 tag group; no 香港 line: the default is all lines.
    let g2 = groups(&state, &u2).await;
    assert_eq!(members(&g2, "♻️ Netflix 推荐"), ["🌐 日本"]);
    assert_eq!(members(&g2, "♻️ Google 推荐"), ["JP2 | 解锁", "🏷 解锁"]);
    assert_eq!(members(&g2, "🚀 默认代理")[0], "♻️ 全部节点");

    // Lines are pinned by id: a rename follows, a disabled line drops out
    // (and with it user 1's only 日本 line: the region group goes too).
    let r = admin
        .req(
            Method::PATCH,
            &format!("/test/api/v1/entrances/{jp1}"),
            Some(json!({"name": "东京新"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let g1 = groups(&state, &u1).await;
    assert_eq!(members(&g1, "♻️ Netflix 推荐"), ["东京新", "HK", "🌐 日本"]);
    let r = admin
        .req(
            Method::PATCH,
            &format!("/test/api/v1/entrances/{jp1}"),
            Some(json!({"enabled": false})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let g1 = groups(&state, &u1).await;
    assert_eq!(members(&g1, "♻️ Netflix 推荐"), ["HK"]);
    assert!(!g1.iter().any(|(t, _, _)| t == "🌐 日本"));

    // The catalog: categories, services, every entrance with its region.
    let r = admin
        .get("/test/api/v1/settings/subscription/catalog")
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(
        v["categories"].as_array().unwrap().len(),
        crate::sub::catalog::CATEGORIES.len()
    );
    assert_eq!(v["categories"][0]["geosite"], json!(["category-ads-all"]));
    assert_eq!(v["services"][0]["key"], "netflix");
    let mut regions: Vec<&str> = v["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_str().unwrap())
        .collect();
    regions.sort();
    assert_eq!(regions, ["日本", "香港"]);
    assert_eq!(v["tags"], json!(["解锁"]));
    let e = v["entrances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == json!(jp1))
        .unwrap();
    assert_eq!(
        (
            e["name"].as_str(),
            e["region"].as_str(),
            e["enabled"].as_bool()
        ),
        (Some("东京新"), Some("日本"), Some(false))
    );
    let user = client_for(&state, db.user().await).await;
    assert_eq!(
        user.get("/test/api/v1/settings/subscription/catalog")
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    db.drop().await;
}

/// 1107: W30 rules move into the new model (reject → block, direct →
/// direct, proxy → one service on the default proxy), in order, without
/// losing a rule; the built-in default (NULL) stays NULL (= recommended).
#[tokio::test]
async fn migration_moves_w30_rules() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let sql = include_str!("../../migrations/1107_subscription_service_routing.sql");
    let update = sql
        .split(';')
        .map(|s| {
            s.lines()
                .filter(|l| !l.trim_start().starts_with("--"))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .find(|s| s.contains("UPDATE panel_settings SET sub_routing"))
        .unwrap();
    sqlx::query("ALTER TABLE panel_settings ADD COLUMN sub_rules jsonb")
        .execute(&db.pool)
        .await
        .unwrap();
    let run = |rules: Option<Value>| {
        let (pool, update) = (db.pool.clone(), update.clone());
        async move {
            sqlx::query("UPDATE panel_settings SET sub_routing = NULL, sub_rules = $1")
                .bind(rules)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(sqlx::AssertSqlSafe(update))
                .execute(&pool)
                .await
                .unwrap();
            let v: Option<Value> = sqlx::query_scalar("SELECT sub_routing FROM panel_settings")
                .fetch_one(&pool)
                .await
                .unwrap();
            v
        }
    };
    assert_eq!(run(None).await, None, "the built-in default stays NULL");
    let old = json!([
        {"type": "geosite", "value": "category-ads-all", "action": "reject"},
        {"type": "geosite", "value": "private", "action": "direct"},
        {"type": "domain_suffix", "value": "example.org", "action": "proxy"},
        {"type": "geoip", "value": "private", "action": "direct"},
        {"type": "domain_keyword", "value": "tracker", "action": "reject"},
        {"type": "geosite", "value": "geolocation-!cn", "action": "proxy"},
        {"type": "ip_cidr", "value": "10.8.0.0/16", "action": "direct"}
    ]);
    let v = run(Some(old)).await.unwrap();
    let stored = crate::settings::Stored {
        sub_routing: Some(v.clone()),
        ..Default::default()
    };
    let r = crate::sub::routing::Routing::of(&stored).config;
    assert_eq!(
        serde_json::to_value(&r.block).unwrap(),
        json!([{"type": "geosite", "value": "category-ads-all"},
               {"type": "domain_keyword", "value": "tracker"}])
    );
    assert_eq!(
        serde_json::to_value(&r.direct).unwrap(),
        json!([{"type": "geosite", "value": "private"}, {"type": "geoip", "value": "private"},
               {"type": "ip_cidr", "value": "10.8.0.0/16"}])
    );
    assert_eq!(r.services.len(), 1);
    assert_eq!(
        (r.services[0].key.as_str(), r.services[0].name.as_str()),
        ("proxy", "代理")
    );
    assert_eq!(
        serde_json::to_value(&r.services[0].items).unwrap(),
        json!([{"type": "domain_suffix", "value": "example.org"},
               {"type": "geosite", "value": "geolocation-!cn"}])
    );
    assert!(r.services[0].primary.is_none() && r.services[0].backups.is_empty());
    // It is exactly what the API would store (it parses unchanged).
    assert_eq!(r.clone().parse().unwrap(), r);
    // No rules at all and no proxy rules: empty sections, no service.
    let v = run(Some(json!([]))).await.unwrap();
    assert_eq!(v["block"], json!([]));
    assert_eq!(v["services"], json!([]));
    let v = run(Some(
        json!([{"type": "geoip", "value": "cn", "action": "direct"}]),
    ))
    .await
    .unwrap();
    assert_eq!(v["services"], json!([]));
    assert_eq!(v["direct"], json!([{"type": "geoip", "value": "cn"}]));
    sqlx::query("ALTER TABLE panel_settings DROP COLUMN sub_rules")
        .execute(&db.pool)
        .await
        .unwrap();
    db.drop().await;
}
