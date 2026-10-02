-- W21 (admin UX): indexes for the dashboard and the user search, and the
-- site name setting.
--
-- Dashboard revenue windows (src/dashboard.rs): paid orders by paid_at and
-- refunds by refunded_at, index-only range scans over the last 30 days
-- (the amounts are included; orders are rarely updated after payment, so
-- the visibility map stays set).
CREATE INDEX orders_paid_at ON orders (paid_at) INCLUDE (amount_cents) WHERE status = 'paid';
CREATE INDEX orders_refunded_at ON orders (refunded_at) INCLUDE (refund_cents)
    WHERE refunded_at IS NOT NULL;

-- GET /users?q= (login / email prefix, case-insensitive; emails are stored
-- lower-case, 0110). text_pattern_ops: LIKE 'prefix%' uses the index under
-- any collation. Neither column is written by billing, so the HOT updates
-- of users.traffic_used_bytes (0012) are unaffected.
CREATE INDEX users_login_prefix ON users (lower(login) text_pattern_ops);
CREATE INDEX users_email_prefix ON users (email text_pattern_ops) WHERE email IS NOT NULL;

-- 系统设置 → 站点: the site name shown in browser titles and mail headers
-- (NULL = "Akari"). Same row, `version` and reload trigger as 0060/0091.
ALTER TABLE panel_settings
    ADD COLUMN site_name TEXT
        CHECK (site_name IS NULL OR (length(site_name) BETWEEN 1 AND 64 AND site_name !~ '[[:cntrl:]]'));
