-- W17: node alerts (W11 follow-up). One evaluator at a time (advisory
-- lock `akari.alerts`, any instance) compares the fleet against the
-- thresholds and moves `node_alerts` through firing -> resolved; every
-- notification is a row of `alert_notifications` delivered by any instance
-- (claim + lease, at-least-once). Secrets (Telegram bot token, webhook
-- HMAC key) are stored sealed (AES-256-GCM, `totp::Keys::seal`), never in
-- clear and never returned by the API.

CREATE TABLE alert_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- Optimistic concurrency (PUT carries the version it edited).
    version BIGINT NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT true,
    -- Thresholds; NULL = that rule is off.
    offline_secs INT DEFAULT 300 CHECK (offline_secs BETWEEN 30 AND 86400),
    cpu_percent INT DEFAULT 90 CHECK (cpu_percent BETWEEN 1 AND 100),
    cpu_minutes INT NOT NULL DEFAULT 5 CHECK (cpu_minutes BETWEEN 1 AND 60),
    mem_percent INT DEFAULT 90 CHECK (mem_percent BETWEEN 1 AND 100),
    mem_minutes INT NOT NULL DEFAULT 5 CHECK (mem_minutes BETWEEN 1 AND 60),
    disk_percent INT DEFAULT 90 CHECK (disk_percent BETWEEN 1 AND 100),
    cert_days INT DEFAULT 14 CHECK (cert_days BETWEEN 1 AND 90),
    latency_failures BOOLEAN NOT NULL DEFAULT true,
    last_error BOOLEAN NOT NULL DEFAULT true,
    -- A re-fire of the same (node, kind) within this many minutes of the
    -- last notified one is recorded but not notified (flapping).
    cooldown_minutes INT NOT NULL DEFAULT 30 CHECK (cooldown_minutes BETWEEN 0 AND 1440),
    notify_resolved BOOLEAN NOT NULL DEFAULT true,
    -- Channels.
    telegram_enabled BOOLEAN NOT NULL DEFAULT false,
    telegram_chat_id TEXT CHECK (char_length(telegram_chat_id) BETWEEN 1 AND 64),
    telegram_token_enc BYTEA,
    webhook_enabled BOOLEAN NOT NULL DEFAULT false,
    webhook_url TEXT CHECK (char_length(webhook_url) BETWEEN 1 AND 512),
    webhook_secret_enc BYTEA,
    email_enabled BOOLEAN NOT NULL DEFAULT false,
    email_to TEXT[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(email_to) <= 5 AND array_position(email_to, NULL) IS NULL),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT telegram_enabled OR (telegram_chat_id IS NOT NULL AND telegram_token_enc IS NOT NULL)),
    CHECK (NOT webhook_enabled OR (webhook_url IS NOT NULL AND webhook_secret_enc IS NOT NULL)),
    CHECK (NOT email_enabled OR cardinality(email_to) > 0)
);
INSERT INTO alert_settings (id) VALUES (1);

-- Per-node overrides: NULL = the global value; `disabled` lists rule kinds
-- turned off for this node; `muted` = alerts are recorded, never notified.
CREATE TABLE node_alert_rules (
    node_id UUID PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    muted BOOLEAN NOT NULL DEFAULT false,
    disabled TEXT[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(disabled) <= 16 AND array_position(disabled, NULL) IS NULL),
    offline_secs INT CHECK (offline_secs BETWEEN 30 AND 86400),
    cpu_percent INT CHECK (cpu_percent BETWEEN 1 AND 100),
    cpu_minutes INT CHECK (cpu_minutes BETWEEN 1 AND 60),
    mem_percent INT CHECK (mem_percent BETWEEN 1 AND 100),
    mem_minutes INT CHECK (mem_minutes BETWEEN 1 AND 60),
    disk_percent INT CHECK (disk_percent BETWEEN 1 AND 100),
    cert_days INT CHECK (cert_days BETWEEN 1 AND 90),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE node_alerts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('offline', 'cpu', 'memory', 'disk', 'latency',
        'cert', 'agent_cert', 'last_error')),
    status TEXT NOT NULL CHECK (status IN ('firing', 'resolved')),
    fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    value TEXT NOT NULL DEFAULT '' CHECK (char_length(value) <= 200),
    detail TEXT NOT NULL DEFAULT '' CHECK (char_length(detail) <= 600),
    -- A firing notification was queued for this alert (cooldown and the
    -- resolved notification follow it).
    notified BOOLEAN NOT NULL DEFAULT false,
    acked_at TIMESTAMPTZ,
    acked_by TEXT,
    CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
    CHECK ((acked_at IS NULL) = (acked_by IS NULL))
);
-- Dedupe: at most one firing alert per (node, kind), whatever the writer.
CREATE UNIQUE INDEX node_alerts_one_firing ON node_alerts (node_id, kind) WHERE status = 'firing';
CREATE INDEX node_alerts_last ON node_alerts (node_id, kind, fired_at DESC);
CREATE INDEX node_alerts_resolved ON node_alerts (resolved_at) WHERE status = 'resolved';

CREATE TABLE alert_notifications (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    alert_id BIGINT REFERENCES node_alerts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('telegram', 'webhook', 'email')),
    event TEXT NOT NULL CHECK (event IN ('firing', 'resolved')),
    -- The message (webhook JSON body fields, rendered text); never secrets.
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead')),
    attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_until TIMESTAMPTZ,
    claim UUID,
    last_error TEXT CHECK (char_length(last_error) <= 300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX alert_notifications_due ON alert_notifications (next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX alert_notifications_recent ON alert_notifications (created_at DESC, id DESC);
