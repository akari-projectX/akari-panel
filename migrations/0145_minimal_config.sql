-- W25 (R39): panel.toml keeps only what the process needs to start. Every
-- setting an operator changes lives here (系统设置), the rest are built-in
-- constants. NULL = the built-in default (never a file value: there is no
-- file fallback any more). Same row, same `version` and trigger as 0060.
ALTER TABLE panel_settings
    -- Cloudflare edge ranges ("trust Cloudflare"); NULL = the list shipped
    -- in the binary (src/cloudflare_ips.txt).
    ADD COLUMN cloudflare_ranges TEXT[]
        CHECK (cardinality(cloudflare_ranges) BETWEEN 1 AND 256
               AND array_position(cloudflare_ranges, NULL) IS NULL),
    -- Install command: SPKI pin of the panel's web certificate
    -- ("sha256//<base64>"); NULL = probed when a command is issued.
    ADD COLUMN install_tls_pin TEXT
        CHECK (install_tls_pin ~ '^sha256//[A-Za-z0-9+/]{43}=$'),
    -- Agent download fallback of the install script (https, contains
    -- {arch}); '' = no fallback; NULL = the official GitHub release.
    ADD COLUMN install_fallback_url TEXT
        CHECK (length(install_fallback_url) <= 2048),
    -- ACME (W10) told to agents: directory URL (NULL = Let's Encrypt) and
    -- contact e-mail (NULL = none).
    ADD COLUMN acme_directory_url TEXT
        CHECK (length(acme_directory_url) BETWEEN 9 AND 2048),
    ADD COLUMN acme_email TEXT
        CHECK (length(acme_email) BETWEEN 3 AND 254),
    -- Audit log retention (days, 0 = forever; NULL = 365).
    ADD COLUMN audit_retention_days INTEGER
        CHECK (audit_retention_days BETWEEN 0 AND 36500),
    -- W22 per-day traffic history kept before the monthly roll-up
    -- (0 = forever, else >= 32; NULL = 400).
    ADD COLUMN traffic_daily_retention_days INTEGER
        CHECK (traffic_daily_retention_days = 0
               OR traffic_daily_retention_days BETWEEN 32 AND 36500),
    -- R18 opt-in: admins without 2FA get an enrollment-only session
    -- (NULL = false).
    ADD COLUMN require_admin_2fa BOOLEAN,
    -- R10 fallback switch pushed with every LeaseGrant (NULL = gate).
    ADD COLUMN remove_mode TEXT
        CHECK (remove_mode IN ('gate', 'rebuild')),
    -- M6: release public keys trusted IN ADDITION to the official ones
    -- compiled into the panel ("<base64> [label]").
    ADD COLUMN extra_release_keys TEXT[]
        CHECK (cardinality(extra_release_keys) BETWEEN 1 AND 16
               AND array_position(extra_release_keys, NULL) IS NULL);

-- Telegram Bot API origin for alert notifications (a self-hosted Bot API
-- server where api.telegram.org is blocked); NULL = https://api.telegram.org.
ALTER TABLE alert_settings
    ADD COLUMN telegram_api_url TEXT
        CHECK (length(telegram_api_url) BETWEEN 9 AND 2048);

-- Obsolete panel.toml keys already handled: each is imported (or found
-- unusable / already set in the database) at most once, on the first start
-- that sees it; afterwards it is only warned about. An admin who unsets a
-- value later therefore never gets the file's value back.
CREATE TABLE legacy_config_imports (
    key        TEXT PRIMARY KEY,
    outcome    TEXT NOT NULL CHECK (outcome IN ('imported', 'kept', 'unusable')),
    handled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
