-- Ops: batch-generated coupons.
--
-- A batch is N coupons rows sharing one template (type, value, scope,
-- validity, per-code use limit) whose codes are random (unambiguous
-- alphabet, configurable prefix). Each code is an ordinary coupons row,
-- so redemption, reservation and release reuse the W16 path unchanged;
-- uniqueness is the existing lower(code) unique index. Revoking a batch
-- disables all its codes (orders that already used one keep it).
CREATE TABLE coupon_batches (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 100),
    prefix      TEXT NOT NULL CHECK (prefix ~ '^[A-Za-z0-9_-]{0,16}$'),
    count       INTEGER NOT NULL CHECK (count BETWEEN 1 AND 5000),
    -- The template the codes were created from (audit/display only; the
    -- coupons rows are authoritative).
    template    JSONB NOT NULL,
    actor_login TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ
);
ALTER TABLE coupons ADD COLUMN batch_id UUID REFERENCES coupon_batches(id) ON DELETE SET NULL;
CREATE INDEX coupons_batch ON coupons (batch_id) WHERE batch_id IS NOT NULL;
