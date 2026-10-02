-- W16 (M7): coupons, and how an order's amount is split.
--
-- An order's list price is covered, in this order (docs/PAYMENTS.md
-- "Coupons, balance and the amount"):
--   1. discount_cents  the coupon, computed on the LIST price
--                      (akari_coupon_discount: percent floors to the fen,
--                      fixed is capped at the list price);
--   2. credit_cents    the W7 switch credit, applied to what is left
--                      (any excess is forfeited, as before);
--   3. balance_cents   the user's balance (余额) if they chose to use it,
--                      up to what is left; debited from the ledger when the
--                      order is created (balance_state 'held'), returned when
--                      the order ends unpaid ('refunded'), re-taken by a
--                      late payment;
--   4. amount_cents    the rest: what Alipay is asked for (0 = paid at
--                      creation through apply_mark_paid, paid_via
--                      'balance' / 'credit' / 'coupon').
-- All four are computed by the server in SQL (akari_split) and the CHECK
-- below makes the identity hold for every row.

CREATE TABLE coupons (
    id               UUID PRIMARY KEY,
    -- Case-insensitive unique (index below); shown as entered.
    code             TEXT NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{3,32}$'),
    name             TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 100),
    kind             TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
    -- percent: 1..100 (% off the list price); fixed: fen off, 1..1e8.
    value            BIGINT NOT NULL,
    -- NULL = every plan / every period kind.
    plan_ids         UUID[] CHECK (cardinality(plan_ids) BETWEEN 1 AND 200
                                   AND array_position(plan_ids, NULL) IS NULL),
    periods          TEXT[] CHECK (cardinality(periods) BETWEEN 1 AND 9
                                   AND array_position(periods, NULL) IS NULL
                                   AND periods <@ ARRAY['month', 'quarter', 'half_year', 'year',
                                       'two_year', 'three_year', 'days', 'onetime', 'reset']),
    -- The list price must be at least this (0 = any).
    min_amount_cents BIGINT NOT NULL DEFAULT 0 CHECK (min_amount_cents BETWEEN 0 AND 100000000),
    starts_at        TIMESTAMPTZ,
    ends_at          TIMESTAMPTZ,
    -- NULL = unlimited.
    max_uses         INTEGER CHECK (max_uses BETWEEN 1 AND 100000000),
    per_user_limit   INTEGER CHECK (per_user_limit BETWEEN 1 AND 100000000),
    -- Only for users without any paid order yet.
    new_users_only   BOOLEAN NOT NULL DEFAULT false,
    enabled          BOOLEAN NOT NULL DEFAULT true,
    -- Reservations held by pending orders + redemptions of paid ones. The
    -- reservation is a conditional UPDATE under the coupon's row lock, so
    -- two buyers racing for the last use cannot both get it; the CHECK is
    -- the backstop.
    used             INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind = 'percent' AND value BETWEEN 1 AND 100)
           OR (kind = 'fixed' AND value BETWEEN 1 AND 100000000)),
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
    CHECK (max_uses IS NULL OR used <= max_uses)
);
CREATE UNIQUE INDEX coupons_code ON coupons (lower(code));

-- One row per order that used a coupon.
--   reserved  the order is pending (counted in coupons.used)
--   redeemed  the order was paid (counted, unless over_limit)
--   released  the order ended unpaid (no longer counted)
-- A late payment of an ended order re-reserves; when the coupon is used
-- up by then the payment is still honoured (Alipay took the discounted
-- amount): status redeemed, over_limit = true, not counted.
CREATE TABLE coupon_redemptions (
    order_id       UUID PRIMARY KEY REFERENCES orders(id),
    coupon_id      UUID NOT NULL REFERENCES coupons(id),
    user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    status         TEXT NOT NULL CHECK (status IN ('reserved', 'redeemed', 'released')),
    over_limit     BOOLEAN NOT NULL DEFAULT false,
    discount_cents BIGINT NOT NULL CHECK (discount_cents > 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT over_limit OR status = 'redeemed')
);
CREATE INDEX coupon_redemptions_user ON coupon_redemptions (coupon_id, user_id);

ALTER TABLE orders
    ADD COLUMN discount_cents BIGINT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
    ADD COLUMN coupon_id      UUID REFERENCES coupons(id) ON DELETE SET NULL,
    ADD COLUMN coupon_code    TEXT,
    ADD COLUMN balance_cents  BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    -- none: no balance part; held: debited (ledger order_payment);
    -- refunded: returned (ledger refund_to_balance).
    ADD COLUMN balance_state  TEXT NOT NULL DEFAULT 'none'
                              CHECK (balance_state IN ('none', 'held', 'refunded')),
    -- Admin refund of a paid order (POST /orders/{id}/refund).
    ADD COLUMN refunded_at    TIMESTAMPTZ,
    ADD COLUMN refund_cents   BIGINT CHECK (refund_cents >= 0),
    ADD COLUMN refund_reason  TEXT,
    ADD CONSTRAINT orders_balance_state CHECK ((balance_cents = 0) = (balance_state = 'none')),
    ADD CONSTRAINT orders_coupon CHECK ((discount_cents > 0) <= (coupon_code IS NOT NULL)),
    ADD CONSTRAINT orders_refund CHECK ((refunded_at IS NULL) = (refund_cents IS NULL)
                                        AND (refunded_at IS NULL OR status = 'paid'));
ALTER TABLE orders DROP CONSTRAINT orders_amount_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_amount_cents_check
    CHECK (amount_cents >= 0
           AND amount_cents = list_price_cents - credit_cents - discount_cents - balance_cents
           AND (amount_cents > 0 OR credit_cents + discount_cents + balance_cents > 0));
ALTER TABLE orders DROP CONSTRAINT orders_paid_via_check;
ALTER TABLE orders ADD CONSTRAINT orders_paid_via_check
    CHECK (paid_via IN ('notify', 'query', 'manual', 'credit', 'balance', 'coupon'));

-- The coupon discount in fen: percent floors (the buyer never gets more
-- than the stated percentage), fixed never exceeds the list price; never
-- negative. NULL kind (no coupon) = 0.
CREATE FUNCTION akari_coupon_discount(list_cents BIGINT, kind TEXT, value BIGINT) RETURNS BIGINT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN list_cents IS NULL OR list_cents <= 0 OR value IS NULL OR value <= 0 THEN 0
        WHEN kind = 'percent' THEN (list_cents * LEAST(value, 100)) / 100
        WHEN kind = 'fixed' THEN LEAST(value, list_cents)
        ELSE 0
    END
$$;

-- How the list price is covered (see the top of this file): each part is
-- clamped to what is left, so the amount is never negative.
CREATE FUNCTION akari_split(list_cents BIGINT, discount BIGINT, credit BIGINT, balance BIGINT,
                            OUT discount_cents BIGINT, OUT credit_cents BIGINT,
                            OUT balance_cents BIGINT, OUT amount_cents BIGINT)
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF list_cents IS NULL OR list_cents <= 0 THEN
        RAISE EXCEPTION 'akari_split: bad list price %', list_cents;
    END IF;
    discount_cents := LEAST(GREATEST(COALESCE(discount, 0), 0), list_cents);
    credit_cents := LEAST(GREATEST(COALESCE(credit, 0), 0), list_cents - discount_cents);
    balance_cents := LEAST(GREATEST(COALESCE(balance, 0), 0),
                           list_cents - discount_cents - credit_cents);
    amount_cents := list_cents - discount_cents - credit_cents - balance_cents;
END $$;
