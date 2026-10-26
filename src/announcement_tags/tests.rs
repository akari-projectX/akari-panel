//! Announcement tag tests (real database): text and colour rules, the
//! seeded presets, admin CRUD with one audit row per change, the
//! in-use / disabled rules, ordering, and what users and admins see on an
//! announcement.

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for};

const TAGS: &str = "/test/api/v1/announcement-tags";
const ANNS: &str = "/test/api/v1/announcements";

fn tag(name: &str, color: &str) -> Value {
    json!({ "name_zh": name, "color": color })
}

async fn make_tag(c: &Client, v: Value) -> Uuid {
    let r = c.post(TAGS, v).await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    r.json()["id"].as_str().unwrap().parse().unwrap()
}

async fn make_ann(c: &Client, title: &str, tag_id: Option<Uuid>) -> Uuid {
    let r = c
        .post(
            ANNS,
            json!({ "title_zh": title, "body_zh": "正文", "tag_id": tag_id }),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    r.json()["id"].as_str().unwrap().parse().unwrap()
}

async fn del(c: &Client, id: Uuid) -> crate::testdb::http::Resp {
    c.req(Method::DELETE, &format!("{TAGS}/{id}"), None).await
}

async fn put(c: &Client, id: Uuid, v: Value) -> crate::testdb::http::Resp {
    c.req(Method::PUT, &format!("{TAGS}/{id}"), Some(v)).await
}

async fn audit(db: &TestDb, like: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT action FROM audit_log WHERE action LIKE $1 ORDER BY id")
        .bind(like)
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

#[test]
fn text_and_colour_rules() {
    assert_eq!(clean_name("  活动 ").unwrap(), "活动");
    assert_eq!(
        clean_name(" ").unwrap_err().code(),
        "announcement_tag.name_required"
    );
    assert_eq!(
        clean_name("a\nb").unwrap_err().code(),
        "announcement_tag.name_multiline"
    );
    assert_eq!(
        clean_name(&"x".repeat(MAX_NAME + 1)).unwrap_err().code(),
        "announcement_tag.name_long"
    );
    assert!(clean_name(&"字".repeat(MAX_NAME)).is_ok());
    let ok: TagReq = serde_json::from_value(tag("活动", "pink")).unwrap();
    let c = check(&ok).unwrap();
    assert!(c.enabled && c.name_en.is_none());
    for color in COLORS {
        let mut r = ok.clone();
        r.color = color.into();
        assert!(check(&r).is_ok(), "{color}");
    }
    let mut r = ok.clone();
    r.color = "#ff0000".into();
    assert_eq!(
        check(&r).unwrap_err().code(),
        "announcement_tag.color_invalid"
    );
    let mut r = ok.clone();
    r.name_en = Some("  ".into());
    assert!(check(&r).unwrap().name_en.is_none());
    assert!(
        serde_json::from_value::<TagReq>(json!({ "name_zh": "a", "color": "red", "icon": "x" }))
            .is_err()
    );
}

/// The migration seeds the eight presets, in order, with English names;
/// customers cannot reach the admin endpoints.
#[tokio::test]
async fn presets_are_seeded_and_admin_only() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;
    let list = admin.get(TAGS).await.json();
    let rows = list.as_array().unwrap();
    let got: Vec<(&str, &str, &str)> = rows
        .iter()
        .map(|r| {
            (
                r["name_zh"].as_str().unwrap(),
                r["name_en"].as_str().unwrap(),
                r["color"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("活动", "Event", "pink"),
            ("维护", "Maintenance", "amber"),
            ("调整", "Change", "blue"),
            ("新功能", "New feature", "violet"),
            ("优惠", "Offer", "green"),
            ("重要", "Important", "red"),
            ("新线路", "New route", "teal"),
            ("通知", "Notice", "slate"),
        ]
    );
    assert!(rows.iter().all(|r| r["enabled"] == true && r["uses"] == 0));
    assert_eq!(user.get(TAGS).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        user.post(TAGS, tag("x", "red")).await.status,
        StatusCode::FORBIDDEN
    );
    let first: Uuid = rows[0]["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        put(&user, first, tag("x", "red")).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(del(&user, first).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        user.req(
            Method::PUT,
            &format!("{TAGS}/order"),
            Some(json!({ "ids": [] }))
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    db.drop().await;
}

/// CRUD: validation, 404s, one audit row per real change (a no-op PUT
/// writes none), new tags are appended last.
#[tokio::test]
async fn admin_crud_and_audit() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    for (b, code) in [
        (tag("", "red"), "announcement_tag.name_required"),
        (tag("a\nb", "red"), "announcement_tag.name_multiline"),
        (
            tag("一二三四五六七八九十一二三", "red"),
            "announcement_tag.name_long",
        ),
        (tag("活", "#fff"), "announcement_tag.color_invalid"),
    ] {
        let r = admin.post(TAGS, b).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        assert_eq!(r.json()["code"], code);
    }
    assert_eq!(
        admin
            .post(
                TAGS,
                json!({ "name_zh": "x", "color": "red", "icon": "star" })
            )
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    let id = make_tag(
        &admin,
        json!({ "name_zh": " 抽奖 ", "name_en": "Raffle", "color": "cyan" }),
    )
    .await;
    let list = admin.get(TAGS).await.json();
    let last = list.as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["id"], id.to_string());
    assert_eq!(last["name_zh"], "抽奖");
    assert_eq!(last["sort"], 8);

    let r = put(
        &admin,
        id,
        json!({ "name_zh": "抽奖", "name_en": "Raffle", "color": "cyan", "enabled": true }),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(
        audit(&db, "announcement_tag.%").await,
        vec!["announcement_tag.create"]
    );
    let r = put(
        &admin,
        id,
        json!({ "name_zh": "抽奖", "name_en": null, "color": "orange", "enabled": false }),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let after: Value =
        sqlx::query_scalar("SELECT after FROM audit_log WHERE action = 'announcement_tag.update'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        after,
        json!({ "name_zh": "抽奖", "name_en": null, "color": "orange", "enabled": false })
    );
    assert_eq!(
        put(&admin, Uuid::new_v4(), tag("x", "red")).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        put(&admin, id, tag("x", "nope")).await.status,
        StatusCode::BAD_REQUEST
    );

    assert_eq!(del(&admin, id).await.status, StatusCode::NO_CONTENT);
    assert_eq!(del(&admin, id).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        audit(&db, "announcement_tag.%").await,
        vec![
            "announcement_tag.create",
            "announcement_tag.update",
            "announcement_tag.delete"
        ]
    );
    db.drop().await;
}

/// A tag in use can only be disabled (409 with the count); a disabled tag
/// stays on its announcements but cannot be picked for another one; the
/// announcement's audit rows carry the tag.
#[tokio::test]
async fn in_use_and_disabled_rules() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let promo = make_tag(&admin, tag("促销", "green")).await;
    let other = make_tag(&admin, tag("其他", "slate")).await;
    let a1 = make_ann(&admin, "一", Some(promo)).await;
    let a2 = make_ann(&admin, "二", Some(promo)).await;
    let _a3 = make_ann(&admin, "三", None).await;

    let r = del(&admin, promo).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let j = r.json();
    assert_eq!(j["code"], "announcement_tag.in_use");
    assert_eq!(j["params"]["count"], 2);
    let uses = |list: &Value, id: Uuid| {
        list.as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id.to_string())
            .unwrap()["uses"]
            .clone()
    };
    assert_eq!(uses(&admin.get(TAGS).await.json(), promo), 2);

    // Disable: the announcements keep it, new ones cannot pick it.
    let off = json!({ "name_zh": "促销", "color": "green", "enabled": false });
    assert_eq!(put(&admin, promo, off).await.status, StatusCode::NO_CONTENT);
    let row = admin.get(&format!("{ANNS}/{a1}")).await.json();
    assert_eq!(row["tag_id"], promo.to_string());
    assert_eq!(row["tag_name_zh"], "促销");
    assert_eq!(row["tag_color"], "green");
    let r = admin
        .post(
            ANNS,
            json!({ "title_zh": "新", "body_zh": "x", "tag_id": promo }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "announcement.tag_disabled");
    // Re-saving an announcement that already has it is fine; moving
    // another one onto it is not.
    let same = json!({ "title_zh": "一（改）", "body_zh": "正文", "tag_id": promo });
    let r = admin
        .req(Method::PUT, &format!("{ANNS}/{a1}"), Some(same))
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = admin
        .req(
            Method::PUT,
            &format!("{ANNS}/{a2}"),
            Some(json!({ "title_zh": "二", "body_zh": "正文", "tag_id": null })),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = admin
        .req(
            Method::PUT,
            &format!("{ANNS}/{a2}"),
            Some(json!({ "title_zh": "二", "body_zh": "正文", "tag_id": promo })),
        )
        .await;
    assert_eq!(r.json()["code"], "announcement.tag_disabled");
    // Unknown tag.
    let r = admin
        .post(
            ANNS,
            json!({ "title_zh": "新", "body_zh": "x", "tag_id": Uuid::new_v4() }),
        )
        .await;
    assert_eq!(r.json()["code"], "announcement.tag_unknown");
    // Swapping to another enabled tag works and is audited with the ids.
    let r = admin
        .req(
            Method::PUT,
            &format!("{ANNS}/{a1}"),
            Some(json!({ "title_zh": "一（改）", "body_zh": "正文", "tag_id": other })),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let (before, after): (Value, Value) = sqlx::query_as(
        "SELECT before, after FROM audit_log WHERE action = 'announcement.update' AND target_id = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(a1.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(before["tag_id"], promo.to_string());
    assert_eq!(after["tag_id"], other.to_string());

    // Still used by a2? No: it was cleared above, and a1 moved away, so it deletes.
    assert_eq!(del(&admin, promo).await.status, StatusCode::NO_CONTENT);
    // Deleting the announcement frees the other tag.
    assert_eq!(del(&admin, other).await.status, StatusCode::CONFLICT);
    for a in [a1] {
        let r = admin
            .req(Method::DELETE, &format!("{ANNS}/{a}"), None)
            .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT);
    }
    assert_eq!(del(&admin, other).await.status, StatusCode::NO_CONTENT);
    db.drop().await;
}

/// The whole list in a new order; a stale or duplicated list is 409.
#[tokio::test]
async fn reorder() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let ids = |v: &Value| -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].as_str().unwrap().to_string())
            .collect()
    };
    let order = format!("{TAGS}/order");
    let mut want = ids(&admin.get(TAGS).await.json());
    // Same order: nothing happens, nothing is audited.
    let r = admin
        .req(Method::PUT, &order, Some(json!({ "ids": want })))
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(audit(&db, "announcement_tag.reorder").await.is_empty());
    want.reverse();
    let r = admin
        .req(Method::PUT, &order, Some(json!({ "ids": want })))
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(ids(&admin.get(TAGS).await.json()), want);
    assert_eq!(audit(&db, "announcement_tag.reorder").await.len(), 1);
    // A new tag goes last, after the reordered ones.
    let id = make_tag(&admin, tag("新", "red")).await;
    assert_eq!(
        ids(&admin.get(TAGS).await.json()).last().unwrap(),
        &id.to_string()
    );
    // The list from before the create is stale; a duplicate is stale too.
    for bad in [
        json!({ "ids": want }),
        json!({ "ids": [want[0], want[0]] }),
        json!({ "ids": [] }),
    ] {
        let r = admin.req(Method::PUT, &order, Some(bad)).await;
        assert_eq!(r.status, StatusCode::CONFLICT);
        assert_eq!(r.json()["code"], "announcement_tag.order_stale");
    }
    assert_eq!(audit(&db, "announcement_tag.reorder").await.len(), 1);
    db.drop().await;
}

/// Users get the tag on every announcement they see (both names + the
/// colour key), also after the tag is disabled; untagged ones carry null.
#[tokio::test]
async fn users_see_the_tag() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;
    let t = make_tag(
        &admin,
        json!({ "name_zh": "维护", "name_en": "Maintenance", "color": "amber" }),
    )
    .await;
    let tagged = make_ann(&admin, "带标签", Some(t)).await;
    let plain = make_ann(&admin, "没标签", None).await;
    let check = |v: &Value| {
        let rows = v["announcements"].as_array().unwrap();
        let by = |id: Uuid| {
            rows.iter()
                .find(|a| a["id"] == id.to_string())
                .unwrap()
                .clone()
        };
        let tg = by(tagged)["tag"].clone();
        assert_eq!(
            tg,
            json!({ "id": t.to_string(), "name_zh": "维护", "name_en": "Maintenance", "color": "amber" })
        );
        assert!(by(plain)["tag"].is_null());
    };
    check(&user.get("/test/api/v1/me/announcements").await.json());
    let off =
        json!({ "name_zh": "维护", "name_en": "Maintenance", "color": "amber", "enabled": false });
    assert_eq!(put(&admin, t, off).await.status, StatusCode::NO_CONTENT);
    check(&user.get("/test/api/v1/me/announcements").await.json());
    db.drop().await;
}
