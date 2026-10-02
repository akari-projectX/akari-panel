-- R24/W7: the plan catalogue (xboard-equivalent): multi-period prices,
-- description, stock and sale rules, plan switching with proration, and an
-- enforced speed limit. See docs/PAYMENTS.md ("Periods", "Switching plans")
-- and src/billing/.
--
-- Money stays integer CNY cents (fen). Every amount a user pays is computed
-- by the server at order creation (here: akari_prorate for the credit) and
-- copied into the order; the client never submits an amount.

-- 1. Plan catalogue fields.
--    description: Markdown-lite text shown on the purchase page (plain
--      lines and "- " bullets; rendered as text, never as HTML).
--    on_sale: offered in the shop (also needs plans.enabled and a price);
--      replaces plan_prices.purchasable.
--    capacity: max active subscribers (NULL = unlimited). Checked when an
--      order is created and again, authoritatively, at fulfilment under
--      entitle::lock (full at fulfilment = paid + fulfil_error, never a
--      lost payment). Renewals and reset packs never count against it.
--    renewal_only: hidden from new buyers; current subscribers can still
--      renew it (and buy its reset pack).
--    allow_switch_in: users holding ANOTHER plan may switch to this one.
--    speed_limit_mbps (0020) is now enforced by the agent (protocol 4).
ALTER TABLE plans
    ADD COLUMN description     TEXT NOT NULL DEFAULT ''
                               CHECK (char_length(description) <= 4000),
    ADD COLUMN on_sale         BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN capacity        INTEGER CHECK (capacity >= 0),
    ADD COLUMN renewal_only    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN allow_switch_in BOOLEAN NOT NULL DEFAULT true;

-- 2. Prices: one optional price per (plan, period kind).
--    month/quarter/half_year/year/two_year/three_year: calendar months
--      (1/3/6/12/24/36, UTC, day clamped to the month's end).
--    days: a custom N-day period (the R18-3 single price migrates to it).
--    onetime: a one-off purchase; days NULL = no expiry, else N days.
--    reset: traffic reset pack — zeroes the used traffic of the CURRENT
--      plan; no period change; only for current subscribers of the plan.
CREATE TABLE plan_period_prices (
    plan_id     UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    period      TEXT NOT NULL CHECK (period IN ('month', 'quarter', 'half_year', 'year',
                    'two_year', 'three_year', 'days', 'onetime', 'reset')),
    days        INTEGER CHECK (days BETWEEN 1 AND 3650),
    -- <= 1,000,000.00 CNY (Alipay's per-trade ceiling is 100,000,000.00).
    price_cents BIGINT NOT NULL CHECK (price_cents BETWEEN 1 AND 100000000),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plan_id, period),
    CHECK (period <> 'days' OR days IS NOT NULL),
    CHECK (period IN ('days', 'onetime') OR days IS NULL)
);

-- Lossless: the single price becomes the custom-days price, and its
-- purchasable flag the plan's on_sale.
INSERT INTO plan_period_prices (plan_id, period, days, price_cents, updated_at)
    SELECT plan_id, 'days', period_days, price_cents, updated_at FROM plan_prices;
UPDATE plans p SET on_sale = pp.purchasable FROM plan_prices pp WHERE pp.plan_id = p.id;
DROP TABLE plan_prices;

-- 3. Orders record what was bought and how the amount came about.
--    period/period_days: the kind and (days/onetime) length bought;
--      legacy rows are 'days' with their period_days.
--    list_price_cents: the period's price at creation;
--    credit_cents: proration credit applied (switching plans), from
--      credit_order_id (the latest paid order of the plan being left);
--    amount_cents = list_price_cents - credit_cents (what Alipay is asked
--      for). 0 only when the credit covers the whole price: such an order
--      is paid at creation through the same apply_mark_paid path
--      (paid_via 'credit') and never reaches Alipay.
ALTER TABLE orders
    ADD COLUMN period           TEXT NOT NULL DEFAULT 'days'
                                CHECK (period IN ('month', 'quarter', 'half_year', 'year',
                                    'two_year', 'three_year', 'days', 'onetime', 'reset')),
    ADD COLUMN list_price_cents BIGINT CHECK (list_price_cents > 0),
    ADD COLUMN credit_cents     BIGINT NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
    ADD COLUMN credit_order_id  UUID REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE orders ALTER COLUMN period DROP DEFAULT;
UPDATE orders SET list_price_cents = amount_cents;
ALTER TABLE orders ALTER COLUMN list_price_cents SET NOT NULL;
ALTER TABLE orders ALTER COLUMN period_days DROP NOT NULL;
ALTER TABLE orders DROP CONSTRAINT orders_amount_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_amount_cents_check
    CHECK (amount_cents >= 0 AND amount_cents = list_price_cents - credit_cents
           AND (amount_cents > 0 OR credit_cents > 0));
ALTER TABLE orders ADD CONSTRAINT orders_period_days_kind
    CHECK ((period = 'days') <= (period_days IS NOT NULL)
           AND (period IN ('days', 'onetime') OR period_days IS NULL));
ALTER TABLE orders DROP CONSTRAINT orders_paid_via_check;
ALTER TABLE orders ADD CONSTRAINT orders_paid_via_check
    CHECK (paid_via IN ('notify', 'query', 'manual', 'credit'));
-- Credit lookups: a user's paid orders of a plan, newest first.
CREATE INDEX orders_user_plan_paid ON orders (user_id, plan_id, fulfilled_at DESC)
    WHERE status = 'paid';

-- 4. Period arithmetic, in SQL only (DB clock, no client input).

-- The nominal length of a period in days: the proration rate's
-- denominator. NULL = no time value (reset pack, permanent one-time).
CREATE FUNCTION akari_period_nominal_days(period TEXT, days INTEGER) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE period
        WHEN 'month' THEN 30 WHEN 'quarter' THEN 90 WHEN 'half_year' THEN 180
        WHEN 'year' THEN 365 WHEN 'two_year' THEN 730 WHEN 'three_year' THEN 1095
        WHEN 'days' THEN days WHEN 'onetime' THEN days
        ELSE NULL END
$$;

-- The expiry after adding one `period` to `base`. Calendar periods add
-- UTC months (PostgreSQL clamps the day: Jan 31 + 1 month = Feb 28/29);
-- days/onetime add exact multiples of 86400 s. NULL = no expiry (onetime
-- without days). Reset packs have no period.
CREATE FUNCTION akari_period_end(base TIMESTAMPTZ, period TEXT, days INTEGER) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    m INTEGER := CASE period
        WHEN 'month' THEN 1 WHEN 'quarter' THEN 3 WHEN 'half_year' THEN 6
        WHEN 'year' THEN 12 WHEN 'two_year' THEN 24 WHEN 'three_year' THEN 36
        ELSE NULL END;
BEGIN
    IF base IS NULL THEN
        RAISE EXCEPTION 'akari_period_end: NULL base';
    ELSIF m IS NOT NULL THEN
        RETURN ((base AT TIME ZONE 'UTC') + make_interval(months => m)) AT TIME ZONE 'UTC';
    ELSIF period = 'onetime' AND days IS NULL THEN
        RETURN NULL;
    ELSIF period IN ('days', 'onetime') AND days BETWEEN 1 AND 3650 THEN
        RETURN base + make_interval(secs => days::bigint * 86400);
    END IF;
    RAISE EXCEPTION 'akari_period_end: bad period % (days %)', period, days;
END $$;

-- Proration credit in integer cents, floored: value_cents x remaining /
-- (nominal_days x 86400 s), never negative and never above cap_cents.
-- Anything unknown (NULL value, no nominal length, no expiry, nothing
-- remaining) is 0.
CREATE FUNCTION akari_prorate(value_cents BIGINT, nominal_days INTEGER,
                              remaining_secs NUMERIC, cap_cents BIGINT) RETURNS BIGINT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN value_cents IS NULL OR value_cents <= 0 OR nominal_days IS NULL
             OR nominal_days <= 0 OR remaining_secs IS NULL OR remaining_secs <= 0
             OR cap_cents IS NULL OR cap_cents <= 0 THEN 0
        ELSE LEAST(cap_cents,
                   floor(value_cents::numeric * remaining_secs
                         / (nominal_days::numeric * 86400)))::bigint
    END
$$;
