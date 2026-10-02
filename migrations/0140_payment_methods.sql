-- W24 / R40: pluggable payment methods (系统设置 → 支付). Payments are
-- configured ONLY here (the old panel.toml [payments.alipay] is obsolete:
-- imported once into an Alipay method by billing::methods::import_legacy,
-- otherwise ignored). One row per configured method; several per kind are
-- allowed (two Alipay merchants). Written only by billing::methods::apply_*
-- (audited in the same transaction; optimistic concurrency on `version`).
-- The 0060 trigger function wakes every instance (payload 'settings'),
-- which rebuilds its provider clients and swaps them atomically.
CREATE TABLE payment_methods (
    id           UUID PRIMARY KEY,
    -- billing::provider::KINDS (a new kind = a new migration widening this).
    kind         TEXT NOT NULL CHECK (kind IN ('alipay_f2f')),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
    -- A short icon keyword for the checkout (SPA maps it); NULL = by kind.
    icon         TEXT CHECK (icon ~ '^[a-z0-9_-]{1,32}$'),
    sort         INTEGER NOT NULL DEFAULT 0 CHECK (sort BETWEEN -1000000 AND 1000000),
    enabled      BOOLEAN NOT NULL DEFAULT false,
    version      BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
    -- Non-secret configuration (validated by the kind; public keys,
    -- fingerprints, ids). Never holds a secret.
    config       JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
    -- 0x01‖nonce‖AES-256-GCM(JSON object of the secret fields), key from
    -- data/totp.key (label akari/payment-secrets-aead/v1), AAD = id: a blob
    -- copied to another method does not open. Never returned by the API,
    -- never audited (secret fields appear as "changed").
    secrets_enc  BYTEA,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payment_methods_enabled_has_secrets CHECK (NOT enabled OR secrets_enc IS NOT NULL)
);
CREATE INDEX payment_methods_order ON payment_methods (sort, created_at);

CREATE TRIGGER payment_methods_notify
    AFTER INSERT OR UPDATE OR DELETE ON payment_methods
    FOR EACH STATEMENT EXECUTE FUNCTION akari_settings_notify();

-- The method an order is paid with (NULL: orders paid in full by balance /
-- credit / coupon, and orders created before 0140 until the legacy import
-- assigns them to the imported Alipay method). Only that method may settle
-- the order. `trade_no` (0040) is the provider's trade number. `pay_url`:
-- a redirect checkout (providers that do not use a QR code).
ALTER TABLE orders
    ADD COLUMN payment_method_id UUID REFERENCES payment_methods(id),
    ADD COLUMN pay_url TEXT CHECK (length(pay_url) <= 2048);
CREATE INDEX orders_payment_method_pending ON orders (payment_method_id) WHERE status = 'pending';
ALTER TABLE payment_events
    ADD COLUMN payment_method_id UUID REFERENCES payment_methods(id) ON DELETE SET NULL;
