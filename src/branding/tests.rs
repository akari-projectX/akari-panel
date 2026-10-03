//! Ops branding tests (real database): PNG checks, link/label validation,
//! upload + public serving with cache headers + ETag, canonical rejection
//! without an image, audit rows without bytes, optimistic concurrency.

use axum::http::{Method, StatusCode};
use serde_json::json;

use super::*;
use crate::testdb::TestDb;
use crate::testdb::http::{Client, client_for, rand_ip};

/// A minimal PNG prefix (signature + IHDR) of the given size; the rest of
/// the file is padding (the panel reads the header only).
pub fn png(w: u32, h: u32, len: usize) -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    v.extend_from_slice(b"IHDR");
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&h.to_be_bytes());
    v.extend_from_slice(&[8, 6, 0, 0, 0]);
    v.extend_from_slice(&[0; 4]); // crc (unchecked)
    v.extend_from_slice(b"IEND");
    v.resize(len.max(v.len()), 0);
    v
}

#[test]
fn png_checks() {
    assert_eq!(png_dimensions(&png(3, 4, 64)), Some((3, 4)));
    assert_eq!(png_dimensions(b"\xff\xd8\xff"), None);
    let mut bad = png(3, 4, 64);
    bad[13] = b'X';
    assert_eq!(png_dimensions(&bad), None);
    assert_eq!(png_dimensions(&png(0, 4, 64)), None);
    assert_eq!(
        check_image(Image::Logo, &png(2048, 100, 100)).unwrap(),
        (2048, 100)
    );
    assert_eq!(
        check_image(Image::Logo, &png(2049, 1, 100))
            .unwrap_err()
            .code(),
        "branding.image_dimensions"
    );
    assert_eq!(
        check_image(Image::Favicon, &png(257, 1, 100))
            .unwrap_err()
            .code(),
        "branding.image_dimensions"
    );
    assert_eq!(
        check_image(Image::Favicon, &png(256, 256, 100)).unwrap(),
        (256, 256)
    );
    assert_eq!(
        check_image(Image::Logo, &png(1, 1, LOGO_MAX + 1))
            .unwrap_err()
            .code(),
        "branding.image_too_large"
    );
    assert_eq!(
        check_image(Image::Favicon, &png(1, 1, FAVICON_MAX + 1))
            .unwrap_err()
            .code(),
        "branding.image_too_large"
    );
    assert_eq!(
        check_image(Image::Logo, b"GIF89a").unwrap_err().code(),
        "branding.image_not_png"
    );
    assert_eq!(Image::parse("logo"), Some(Image::Logo));
    assert_eq!(Image::parse("svg"), None);
}

#[test]
fn fields_validation() {
    let base = BrandingReq {
        version: 1,
        footer_text: Some(" © 2026 Akari \n 第二行 ".into()),
        footer_links: vec![FooterLink {
            label: " 状态页 ".into(),
            url: "https://status.example/".into(),
        }],
        tos_url: Some("/app/help/x".into()),
        privacy_url: Some("".into()),
        client_downloads: vec![Download {
            platform: "android".into(),
            label: None,
            url: "https://dl.example/a.apk".into(),
        }],
    };
    let f = check(&base).unwrap();
    assert_eq!(f.footer_text.as_deref(), Some("© 2026 Akari \n 第二行"));
    assert_eq!(f.footer_links[0].label, "状态页");
    assert_eq!(f.tos_url.as_deref(), Some("/app/help/x"));
    assert!(f.privacy_url.is_none());
    for (code, req) in [
        (
            "branding.url_invalid",
            BrandingReq {
                tos_url: Some("javascript:alert(1)".into()),
                ..base.clone()
            },
        ),
        (
            "branding.url_invalid",
            BrandingReq {
                tos_url: Some("mailto:x@y".into()),
                ..base.clone()
            },
        ),
        (
            "branding.url_invalid",
            BrandingReq {
                tos_url: Some("#top".into()),
                ..base.clone()
            },
        ),
        (
            "branding.url_invalid",
            BrandingReq {
                tos_url: Some("//evil".into()),
                ..base.clone()
            },
        ),
        (
            "branding.label_invalid",
            BrandingReq {
                footer_links: vec![FooterLink {
                    label: "".into(),
                    url: "https://x".into(),
                }],
                ..base.clone()
            },
        ),
        (
            "branding.label_invalid",
            BrandingReq {
                footer_links: vec![FooterLink {
                    label: "a\nb".into(),
                    url: "https://x".into(),
                }],
                ..base.clone()
            },
        ),
        (
            "branding.platform_invalid",
            BrandingReq {
                client_downloads: vec![Download {
                    platform: "amiga".into(),
                    label: None,
                    url: "https://x".into(),
                }],
                ..base.clone()
            },
        ),
        (
            "branding.footer_invalid",
            BrandingReq {
                footer_text: Some("x".repeat(MAX_FOOTER + 1)),
                ..base.clone()
            },
        ),
        (
            "branding.footer_invalid",
            BrandingReq {
                footer_text: Some("a\u{1}b".into()),
                ..base.clone()
            },
        ),
        (
            "branding.too_many_links",
            BrandingReq {
                footer_links: vec![
                    FooterLink {
                        label: "a".into(),
                        url: "https://x".into()
                    };
                    MAX_LINKS + 1
                ],
                ..base.clone()
            },
        ),
        (
            "branding.too_many_downloads",
            BrandingReq {
                client_downloads: vec![
                    Download {
                        platform: "ios".into(),
                        label: None,
                        url: "https://x".into()
                    };
                    MAX_DOWNLOADS + 1
                ],
                ..base.clone()
            },
        ),
    ] {
        assert_eq!(check(&req).unwrap_err().code(), code);
    }
    assert!(serde_json::from_value::<BrandingReq>(json!({ "version": 1, "zz": 1 })).is_err());
    assert!(
        serde_json::from_value::<FooterLink>(json!({ "label": "a", "url": "b", "x": 1 })).is_err()
    );
}

#[tokio::test]
async fn upload_serve_and_audit() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::for_test(db.pool.clone()).await;
    let admin = client_for(&state, db.admin().await).await;
    let user = client_for(&state, db.user().await).await;
    let anon = Client::new(&state, rand_ip());
    let canonical = anon.get("/test/no-such-path").await.fingerprint();
    // Nothing stored: the public image paths are the canonical rejection.
    for p in ["/test/brand/logo", "/test/brand/favicon", "/test/brand/svg"] {
        assert_eq!(anon.get(p).await.fingerprint(), canonical, "{p}");
    }
    let opts = anon
        .req(Method::GET, "/test/auth/options", None)
        .await
        .json();
    assert!(opts["branding"]["logo_url"].is_null());
    assert_eq!(opts["branding"]["footer_links"], json!([]));
    // Uploads: admins only, PNG only, within the caps.
    assert_eq!(
        user.put_raw("/test/api/v1/settings/branding/logo", png(10, 10, 100))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let r = admin
        .put_raw(
            "/test/api/v1/settings/branding/logo",
            b"\xff\xd8\xffJPEG".to_vec(),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "branding.image_not_png");
    let r = admin
        .put_raw(
            "/test/api/v1/settings/branding/logo",
            png(10, 10, LOGO_MAX + 1),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.json()["code"], "branding.image_too_large");
    assert_eq!(
        admin
            .put_raw("/test/api/v1/settings/branding/icon", png(10, 10, 100))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let logo = png(120, 40, 2000);
    let r = admin
        .put_raw("/test/api/v1/settings/branding/logo", logo.clone())
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    let v = r.json();
    let logo_url = v["logo_url"].as_str().unwrap().to_string();
    assert!(logo_url.starts_with("brand/logo?v=") && logo_url.len() == "brand/logo?v=".len() + 16);
    assert!(v["favicon_url"].is_null());
    assert_eq!(v["version"], 2);
    // Served publicly with cache headers and a strong ETag; 304 on a match.
    let r = anon.get("/test/brand/logo").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body, logo);
    assert_eq!(r.headers.get("content-type").unwrap(), "image/png");
    assert_eq!(
        r.headers.get("cache-control").unwrap(),
        "public, max-age=86400"
    );
    let etag = r.headers.get("etag").unwrap().to_str().unwrap().to_string();
    assert!(etag.starts_with('"') && etag.len() == 66);
    assert!(logo_url.ends_with(&etag[1..17]));
    let mut c = Client::new(&state, rand_ip());
    c.headers.push(("if-none-match".into(), etag.clone()));
    let r = c.get("/test/brand/logo").await;
    assert_eq!(r.status, StatusCode::NOT_MODIFIED);
    assert!(r.body.is_empty());
    assert_eq!(r.headers.get("etag").unwrap().to_str().unwrap(), etag);
    c.headers.clear();
    c.headers.push(("if-none-match".into(), "\"stale\"".into()));
    assert_eq!(c.get("/test/brand/logo").await.status, StatusCode::OK);
    // Still no favicon.
    assert_eq!(
        anon.get("/test/brand/favicon").await.fingerprint(),
        canonical
    );
    let opts = anon
        .req(Method::GET, "/test/auth/options", None)
        .await
        .json();
    assert_eq!(opts["branding"]["logo_url"], logo_url);
    // Text fields: version conflict, then saved and public.
    let fields = json!({
        "version": 1, "footer_text": "© Akari", "footer_links": [{ "label": "状态", "url": "https://status.example" }],
        "tos_url": "https://x.example/tos", "privacy_url": null,
        "client_downloads": [{ "platform": "windows", "label": "Clash Verge", "url": "https://dl.example/w.exe" }]
    });
    let r = admin
        .req(
            Method::PUT,
            "/test/api/v1/settings/branding",
            Some(fields.clone()),
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["code"], "branding.version_conflict");
    let mut ok = fields.clone();
    ok["version"] = json!(2);
    let r = admin
        .req(
            Method::PUT,
            "/test/api/v1/settings/branding",
            Some(ok.clone()),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.body)
    );
    assert_eq!(r.json()["version"], 3);
    assert_eq!(r.json()["client_downloads"][0]["platform"], "windows");
    assert_eq!(
        user.req(
            Method::PUT,
            "/test/api/v1/settings/branding",
            Some(ok.clone())
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        user.get("/test/api/v1/settings/branding").await.status,
        StatusCode::FORBIDDEN
    );
    let opts = anon
        .req(Method::GET, "/test/auth/options", None)
        .await
        .json();
    assert_eq!(opts["branding"]["footer_text"], "© Akari");
    assert_eq!(opts["branding"]["tos_url"], "https://x.example/tos");
    assert_eq!(
        opts["branding"]["client_downloads"][0]["label"],
        "Clash Verge"
    );
    let mut bad = ok.clone();
    bad["version"] = json!(3);
    bad["tos_url"] = json!("javascript:x");
    assert_eq!(
        admin
            .req(Method::PUT, "/test/api/v1/settings/branding", Some(bad))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    // Favicon, then remove both.
    let r = admin
        .put_raw("/test/api/v1/settings/branding/favicon", png(32, 32, 300))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(
        r.json()["favicon_url"]
            .as_str()
            .unwrap()
            .starts_with("brand/favicon?v=")
    );
    assert_eq!(anon.get("/test/brand/favicon").await.status, StatusCode::OK);
    assert_eq!(
        admin
            .req(Method::DELETE, "/test/api/v1/settings/branding/logo", None)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(anon.get("/test/brand/logo").await.fingerprint(), canonical);
    // Deleting again changes nothing (no audit row).
    assert_eq!(
        admin
            .req(Method::DELETE, "/test/api/v1/settings/branding/logo", None)
            .await
            .status,
        StatusCode::OK
    );
    let actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM audit_log WHERE target_id = 'branding' ORDER BY id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        actions,
        [
            "settings.branding.logo",
            "settings.branding.update",
            "settings.branding.favicon",
            "settings.branding.logo",
        ]
    );
    // The audit log never holds image bytes (sizes and hashes only).
    let (after,): (serde_json::Value,) = sqlx::query_as(
        "SELECT after FROM audit_log WHERE action = 'settings.branding.logo' ORDER BY id LIMIT 1",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(after["bytes"], 2000);
    assert_eq!(after["width"], 120);
    assert!(after.to_string().len() < 300);
    db.drop().await;
}
