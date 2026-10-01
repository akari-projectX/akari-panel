-- R18-3: paid plans via Alipay Face-to-Face (当面付, alipay.trade.precreate).
-- See src/billing/ and docs/PAYMENTS.md.
--
-- Money is integer CNY cents everywhere. The client never supplies an
-- amount: an order copies the plan's price at creation and that copy is the
-- only amount ever compared with Alipay's.

-- 1. Prices. A plan is purchasable only with a row here AND purchasable =
--    true AND plans.enabled. One purchase = period_days of access (renewal
--    extends the active same-plan subscription by period_days; buying a
--    different plan replaces it, M3 replace semantics).
CREATE TABLE plan_prices (
    plan_id      UUID PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
    -- <= 1,000,000.00 CNY (Alipay's per-trade ceiling is 100,000,000.00).
    price_cents  BIGINT NOT NULL CHECK (price_cents BETWEEN 1 AND 100000000),
    period_days  INTEGER NOT NULL CHECK (period_days BETWEEN 1 AND 3650),
    purchasable  BOOLEAN NOT NULL DEFAULT false,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Orders. Money records outlive users and plans: both references are
--    SET NULL on delete and the login/plan name are snapshotted.
--    status: pending -> paid | expired | cancelled; an expired or cancelled
--    order can still become paid (Alipay took the money late: we fulfil).
--    paid is terminal. Refunds are not supported (handled out of band).
CREATE TABLE orders (
    id                UUID PRIMARY KEY,
    -- 'AK' + yyyymmdd + 24 hex chars (96 random bits): unguessable.
    out_trade_no      TEXT NOT NULL UNIQUE CHECK (out_trade_no ~ '^[A-Za-z0-9_]{1,64}$'),
    user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
    user_login        TEXT NOT NULL,
    plan_id           UUID REFERENCES plans(id) ON DELETE SET NULL,
    plan_name         TEXT NOT NULL,
    amount_cents      BIGINT NOT NULL CHECK (amount_cents > 0),
    period_days       INTEGER NOT NULL CHECK (period_days BETWEEN 1 AND 3650),
    subject           TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
    -- The QR payload Alipay returned (a https://qr.alipay.com/... URL).
    qr_code           TEXT,
    trade_no          TEXT,
    paid_via          TEXT CHECK (paid_via IN ('notify', 'query', 'manual')),
    paid_amount_cents BIGINT,
    manual_reason     TEXT,
    -- Fulfilment (plan granted/extended) is in the paid transaction; a
    -- business failure (plan deleted/disabled, user gone or admin) leaves
    -- the order paid with fulfil_error for an admin to resolve.
    fulfilled_at      TIMESTAMPTZ,
    fulfil_result     JSONB,
    fulfil_error      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at        TIMESTAMPTZ NOT NULL,
    paid_at           TIMESTAMPTZ,
    ended_at          TIMESTAMPTZ,
    -- Remote close result of an expired/cancelled order (best effort).
    close_state       TEXT,
    -- Claim marker of the active query (status polling / reconcile): one
    -- instance queries an order at a time, at most every few seconds.
    last_query_at     TIMESTAMPTZ,
    CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
    CHECK (status <> 'paid' OR paid_via IS NOT NULL),
    CHECK ((status IN ('expired', 'cancelled')) = (ended_at IS NOT NULL)),
    CHECK (fulfilled_at IS NULL OR status = 'paid')
);
CREATE INDEX orders_user ON orders (user_id, created_at DESC);
CREATE INDEX orders_created ON orders (created_at DESC, id DESC);
CREATE INDEX orders_pending ON orders (expires_at) WHERE status = 'pending';
CREATE INDEX orders_unfulfilled ON orders (paid_at) WHERE status = 'paid' AND fulfilled_at IS NULL;
-- At most one open order per user (a new one cancels the previous).
CREATE UNIQUE INDEX orders_one_pending ON orders (user_id) WHERE status = 'pending';

-- 3. Payment events: every notify (verified or not), query, precreate,
--    close and manual action, with the outcome. params never contain the
--    signature or any key (sign is replaced by a marker); unverified rows
--    are pruned with the audit retention, verified ones are kept.
CREATE TABLE payment_events (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
    out_trade_no  TEXT,
    source        TEXT NOT NULL
                  CHECK (source IN ('notify', 'query', 'precreate', 'close', 'manual', 'expire')),
    verified      BOOLEAN NOT NULL,
    outcome       TEXT NOT NULL,
    trade_status  TEXT,
    params        JSONB,
    ip            TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_order ON payment_events (order_id, id);
CREATE INDEX payment_events_created ON payment_events (created_at);
