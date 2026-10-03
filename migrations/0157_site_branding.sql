-- Ops (site branding, 系统设置 → 站点): logo and favicon (PNG bytes, served
-- under the secret prefix at /{prefix}/brand/{logo,favicon} with cache
-- headers; the SHA-256 is the ETag and cache-busting key), footer text and
-- links, terms / privacy links and client download links shown on the
-- portal's subscription card. One row (id = 1), `version` for optimistic
-- concurrency like panel_settings; writes are audited (bytes never are).
-- Database only: no panel.toml keys (R39).

CREATE TABLE site_branding (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
    logo BYTEA CHECK (logo IS NULL OR octet_length(logo) BETWEEN 8 AND 262144),
    logo_sha256 BYTEA CHECK ((logo IS NULL) = (logo_sha256 IS NULL)),
    favicon BYTEA CHECK (favicon IS NULL OR octet_length(favicon) BETWEEN 8 AND 65536),
    favicon_sha256 BYTEA CHECK ((favicon IS NULL) = (favicon_sha256 IS NULL)),
    footer_text TEXT CHECK (footer_text IS NULL OR char_length(footer_text) BETWEEN 1 AND 500),
    -- [{"label": "...", "url": "https://..."}], at most 8.
    footer_links JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(footer_links) = 'array'),
    tos_url TEXT CHECK (tos_url IS NULL OR char_length(tos_url) BETWEEN 1 AND 2048),
    privacy_url TEXT CHECK (privacy_url IS NULL OR char_length(privacy_url) BETWEEN 1 AND 2048),
    -- [{"platform": "windows", "label": "...", "url": "https://..."}], at most 12.
    client_downloads JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(client_downloads) = 'array'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO site_branding (id) VALUES (1);
