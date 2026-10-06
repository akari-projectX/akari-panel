//! Ops knowledge-base tests (real database): text rules, what users see
//! (published only, grouped, searched; anything else is the canonical
//! rejection) and the admin CRUD with audit rows.

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use uuid::Uuid;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for};

async fn created(r: crate::testdb::http::Resp) -> Uuid {
    assert_eq!(
        r.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    r.json()["id"].as_str().unwrap().parse().unwrap()
}

async fn category(c: &Client, name: &str, sort: i32) -> Uuid {
    created(
        c.post(
            "/test/api/v1/kb/categories",
            json!({ "name_zh": name, "name_en": format!("{name}-en"), "sort": sort }),
        )
        .await,
    )
    .await
}

async fn article(
    c: &Client,
    cat: Option<Uuid>,
    title: &str,
    published: bool,
    extra: Value,
) -> Uuid {
    let mut v = json!({ "category_id": cat, "title_zh": title, "body_zh": format!("{title} 的 **正文**"), "published": published });
    for (k, val) in extra.as_object().cloned().unwrap_or_default() {
        v[k] = val;
    }
    created(c.post("/test/api/v1/kb/articles", v).await).await
}

async fn audit_actions(db: &TestDb, target: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id")
        .bind(target.to_string())
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

#[test]
fn text_rules() {
    assert_eq!(clean_name(" 常见问题 ").unwrap(), "常见问题");
    assert_eq!(clean_name("").unwrap_err().code(), "kb.name_required");
    assert_eq!(clean_name("a\tb").unwrap_err().code(), "kb.name_multiline");
    assert_eq!(
        clean_name(&"x".repeat(MAX_NAME + 1)).unwrap_err().code(),
        "kb.name_long"
    );
    assert_eq!(clean_query(None).unwrap(), None);
    assert_eq!(clean_query(Some("  ")).unwrap(), None);
    assert_eq!(
        clean_query(Some(" 节点 ")).unwrap().as_deref(),
        Some("节点")
    );
    assert_eq!(
        clean_query(Some(&"x".repeat(65))).unwrap_err().code(),
        "kb.query_long"
    );
    assert_eq!(like_pattern("50%_\\"), "%50\\%\\_\\\\%");
    let c = CategoryReq {
        name_zh: "a".into(),
        name_en: Some(" ".into()),
        sort: MAX_SORT + 1,
    };
    assert_eq!(check_category(&c).unwrap_err().code(), "kb.sort_range");
    let c = CategoryReq { sort: -5, ..c };
    assert_eq!(check_category(&c).unwrap().name_en, None);
    let a = ArticleReq {
        category_id: None,
        title_zh: "t".into(),
        title_en: None,
        body_zh: "b".into(),
        body_en: Some("".into()),
        sort: 0,
        published: true,
        slug: Some(" ".into()),
    };
    assert!(check_article(&a).unwrap().body_en.is_none());
    assert_eq!(check_article(&a).unwrap().slug, None, "blank slug = none");
    let bad = ArticleReq {
        body_zh: " ".into(),
        ..a
    };
    assert_eq!(
        check_article(&bad).unwrap_err().code(),
        "announcement.body_required"
    );
}

#[tokio::test]
async fn users_see_published_only() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;
    let c2 = category(&admin, "进阶", 20).await;
    let c1 = category(&admin, "入门", 10).await;
    let empty = category(&admin, "空分类", 30).await;
    let a1 = article(
        &admin,
        Some(c1),
        "如何导入订阅",
        true,
        json!({ "title_en": "Import the subscription", "body_en": "Open the *client*", "sort": 2 }),
    )
    .await;
    let a0 = article(&admin, Some(c1), "第一步", true, json!({ "sort": 1 })).await;
    let draft = article(&admin, Some(c1), "草稿", false, json!({})).await;
    let loose = article(&admin, None, "未分类的问题", true, json!({})).await;
    let _hidden_loose = article(&admin, None, "未分类草稿", false, json!({})).await;
    let in2 = article(&admin, Some(c2), "进阶技巧", true, json!({})).await;

    let v = user.get("/test/api/v1/me/help").await.json();
    assert_eq!(v["total"], 4);
    let cats = v["categories"].as_array().unwrap();
    // Ordered by sort; the empty category is omitted.
    assert_eq!(cats.len(), 2);
    assert_eq!(cats[0]["id"], c1.to_string());
    assert_eq!(cats[0]["name_en"], "入门-en");
    let titles: Vec<&str> = cats[0]["articles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["title_zh"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["第一步", "如何导入订阅"]);
    assert_eq!(cats[0]["articles"][0]["id"], a0.to_string());
    assert_eq!(cats[1]["articles"][0]["id"], in2.to_string());
    assert_eq!(v["uncategorized"][0]["id"], loose.to_string());
    assert!(cats.iter().all(|c| c["id"] != empty.to_string()));
    // No bodies in the list.
    assert!(!v.to_string().contains("正文"));

    // Search: Chinese body, English title, unknown text, too long.
    let v = user
        .get("/test/api/v1/me/help?q=%E8%AE%A2%E9%98%85")
        .await
        .json(); // 订阅
    assert_eq!(v["total"], 1);
    assert_eq!(v["categories"][0]["articles"][0]["id"], a1.to_string());
    let v = user.get("/test/api/v1/me/help?q=import").await.json();
    assert_eq!(v["total"], 1);
    let v = user.get("/test/api/v1/me/help?q=client").await.json();
    assert_eq!(v["total"], 1, "English body matches");
    let v = user
        .get("/test/api/v1/me/help?q=%E8%8D%89%E7%A8%BF")
        .await
        .json(); // 草稿
    assert_eq!(v["total"], 0, "drafts are never searched");
    assert_eq!(
        user.get(&format!("/test/api/v1/me/help?q={}", "x".repeat(65)))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        user.get("/test/api/v1/me/help?zz=1").await.status,
        StatusCode::BAD_REQUEST
    );

    // One article, rendered.
    let r = user.get(&format!("/test/api/v1/me/help/{a1}")).await;
    assert_eq!(r.status, StatusCode::OK);
    let v = r.json();
    assert_eq!(v["category_zh"], "入门");
    assert!(
        v["html_zh"]
            .as_str()
            .unwrap()
            .contains("<strong>正文</strong>")
    );
    assert!(v["html_en"].as_str().unwrap().contains("<em>client</em>"));
    let canonical = user.get("/test/no-such-path").await.fingerprint();
    for id in [draft.to_string(), Uuid::new_v4().to_string(), "nope".into()] {
        assert_eq!(
            user.get(&format!("/test/api/v1/me/help/{id}"))
                .await
                .fingerprint(),
            canonical,
            "{id}"
        );
    }
    // Admins and the renewal scope may read help too.
    assert_eq!(
        admin.get("/test/api/v1/me/help").await.status,
        StatusCode::OK
    );
    db.drop().await;
}

#[tokio::test]
async fn admin_crud_and_audit() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;
    assert_eq!(
        user.get("/test/api/v1/kb/articles").await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        user.post("/test/api/v1/kb/categories", json!({ "name_zh": "x" }))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let cat = category(&admin, "分类", 1).await;
    let r = admin
        .post(
            "/test/api/v1/kb/articles",
            json!({ "category_id": Uuid::new_v4(), "title_zh": "t", "body_zh": "b" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "kb.category_unknown");
    let art = article(&admin, Some(cat), "文章", false, json!({})).await;
    let list = admin.get("/test/api/v1/kb/articles").await.json();
    let row = list
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == art.to_string())
        .unwrap();
    assert_eq!(row["category_name"], "分类");
    assert_eq!(row["published"], false);
    let cats = admin.get("/test/api/v1/kb/categories").await.json();
    assert_eq!(cats[0]["articles"], 1);
    // Update (and a no-op update: no audit row).
    let put = json!({ "category_id": cat, "title_zh": "文章 2", "body_zh": "b", "published": true, "sort": 3 });
    assert_eq!(
        admin
            .req(
                Method::PUT,
                &format!("/test/api/v1/kb/articles/{art}"),
                Some(put.clone())
            )
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        admin
            .req(
                Method::PUT,
                &format!("/test/api/v1/kb/articles/{art}"),
                Some(put)
            )
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        admin
            .get(&format!("/test/api/v1/kb/articles/{art}"))
            .await
            .json()["title_zh"],
        "文章 2"
    );
    assert_eq!(
        admin
            .req(
                Method::PUT,
                &format!("/test/api/v1/kb/articles/{}", Uuid::new_v4()),
                Some(json!({ "title_zh": "t", "body_zh": "b" }))
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        admin
            .req(
                Method::PUT,
                &format!("/test/api/v1/kb/categories/{cat}"),
                Some(json!({ "name_zh": "分类 2", "sort": 1 }))
            )
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    // Deleting the category leaves the article uncategorized.
    assert_eq!(
        admin
            .req(
                Method::DELETE,
                &format!("/test/api/v1/kb/categories/{cat}"),
                None
            )
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        admin
            .req(
                Method::DELETE,
                &format!("/test/api/v1/kb/categories/{cat}"),
                None
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let v = admin
        .get(&format!("/test/api/v1/kb/articles/{art}"))
        .await
        .json();
    assert!(v["category_id"].is_null() && v["category_name"].is_null());
    assert_eq!(
        admin
            .req(
                Method::DELETE,
                &format!("/test/api/v1/kb/articles/{art}"),
                None
            )
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        admin
            .get(&format!("/test/api/v1/kb/articles/{art}"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        audit_actions(&db, art).await,
        [
            "kb.article.create",
            "kb.article.update",
            "kb.article.delete"
        ]
    );
    assert_eq!(
        audit_actions(&db, cat).await,
        [
            "kb.category.create",
            "kb.category.update",
            "kb.category.delete"
        ]
    );
    db.drop().await;
}

/// W33-b: the slug — format, unique (409), cleared by "", in the list and
/// the audit row.
#[tokio::test]
async fn article_slugs() {
    assert_eq!(
        clean_slug(Some(" terms ")).unwrap().as_deref(),
        Some("terms")
    );
    for bad in ["Terms", "-x", "a_b", "a b", &"x".repeat(65)] {
        assert_eq!(
            clean_slug(Some(bad)).unwrap_err().code(),
            "kb.slug_invalid",
            "{bad}"
        );
    }
    assert_eq!(clean_slug(None).unwrap(), None);
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let terms = article(
        &admin,
        None,
        "服务条款",
        true,
        json!({ "slug": LEGAL_SLUGS[0] }),
    )
    .await;
    let r = admin
        .post(
            "/test/api/v1/kb/articles",
            json!({ "title_zh": "x", "body_zh": "b", "slug": "terms" }),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "kb.slug_taken");
    let other = article(&admin, None, "其他", true, json!({})).await;
    let r = admin
        .req(
            Method::PUT,
            &format!("/test/api/v1/kb/articles/{other}"),
            Some(json!({ "title_zh": "其他", "body_zh": "b", "slug": "terms" })),
        )
        .await;
    assert_eq!(r.json()["code"], "kb.slug_taken");
    let r = admin
        .post(
            "/test/api/v1/kb/articles",
            json!({ "title_zh": "x", "body_zh": "b", "slug": "Bad Slug" }),
        )
        .await;
    assert_eq!(r.json()["code"], "kb.slug_invalid");
    let row = admin
        .get(&format!("/test/api/v1/kb/articles/{terms}"))
        .await
        .json();
    assert_eq!(row["slug"], "terms");
    // "" clears it; the slug is then free for another article.
    let r = admin
        .req(
            Method::PUT,
            &format!("/test/api/v1/kb/articles/{terms}"),
            Some(json!({ "title_zh": "服务条款", "body_zh": "服务条款 的 **正文**", "published": true, "slug": "" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = admin
        .req(
            Method::PUT,
            &format!("/test/api/v1/kb/articles/{other}"),
            Some(json!({ "title_zh": "其他", "body_zh": "b", "slug": "terms" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let after: Value = sqlx::query_scalar(
        "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'kb.article.update' \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(other.to_string())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(after["slug"], "terms");
    db.drop().await;
}
