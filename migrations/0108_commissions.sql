-- W16 (M7): invite commissions and withdrawals.
--
-- Settings (single row, audited `commission.settings.update`):
--   enabled            commissions are created for newly paid orders
--   rate_percent       0..100 of the order's Alipay amount (amount_cents:
--                      balance, credit and coupon parts earn nothing)
--   first_order_only   only the invitee's first paid order with a
--                      non-zero amount earns a commission
--   hold_days          a commission becomes balance this many days after
--                      the payment (0..365); refunded within the hold =
--                      reversed, never credited
--   min_withdrawal_cents  smallest withdrawal request
CREATE TABLE commission_settings (
    id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled              BOOLEAN NOT NULL DEFAULT false,
    rate_percent         INTEGER NOT NULL DEFAULT 10 CHECK (rate_percent BETWEEN 0 AND 100),
    first_order_only     BOOLEAN NOT NULL DEFAULT true,
    hold_days            INTEGER NOT NULL DEFAULT 7 CHECK (hold_days BETWEEN 0 AND 365),
    min_withdrawal_cents BIGINT NOT NULL DEFAULT 10000
                         CHECK (min_withdrawal_cents BETWEEN 1 AND 100000000),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO commission_settings (id) VALUES (1);

-- One commission per paid order at most (UNIQUE order_id: replayed and
-- concurrent payment reports create it once; it is written inside
-- apply_mark_paid's transaction).
--   pending   in the hold period (available_at in the future)
--   credited  added to the inviter's balance (ledger_id, kind commission)
--   reversed  the order was refunded within the hold (or the inviter is
--             gone): never credited
CREATE TABLE commissions (
    id             UUID PRIMARY KEY,
    order_id       UUID NOT NULL UNIQUE REFERENCES orders(id),
    inviter_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    inviter_login  TEXT NOT NULL,
    invitee_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    invitee_login  TEXT NOT NULL,
    base_cents     BIGINT NOT NULL CHECK (base_cents > 0),
    rate_percent   INTEGER NOT NULL CHECK (rate_percent BETWEEN 1 AND 100),
    amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0 AND amount_cents <= base_cents),
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'credited', 'reversed')),
    available_at   TIMESTAMPTZ NOT NULL,
    credited_at    TIMESTAMPTZ,
    ledger_id      BIGINT REFERENCES balance_ledger(id),
    reversed_at    TIMESTAMPTZ,
    reverse_reason TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((status = 'credited') = (credited_at IS NOT NULL AND ledger_id IS NOT NULL)),
    CHECK ((status = 'reversed') = (reversed_at IS NOT NULL)),
    CHECK (amount_cents = (base_cents * rate_percent) / 100)
);
CREATE INDEX commissions_inviter ON commissions (inviter_id, created_at DESC);
CREATE INDEX commissions_due ON commissions (available_at) WHERE status = 'pending';

-- Withdrawal requests: the amount is debited from the balance when the
-- request is made (ledger withdrawal, funds held); an admin approves it
-- after paying out by hand (payout_reference) or rejects it (ledger
-- withdrawal_reversal); the user may cancel while pending (same reversal).
-- Withdrawable = min(balance, credited commissions - withdrawals not
-- rejected/cancelled): refunds and admin credits are spendable, not cash.
CREATE TABLE withdrawals (
    id               UUID PRIMARY KEY,
    user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
    user_login       TEXT NOT NULL,
    amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
    method           TEXT NOT NULL CHECK (method IN ('alipay', 'wechat', 'bank', 'other')),
    account          TEXT NOT NULL CHECK (char_length(account) BETWEEN 1 AND 200),
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    payout_reference TEXT CHECK (char_length(payout_reference) <= 200),
    note             TEXT CHECK (char_length(note) <= 500),
    decided_at       TIMESTAMPTZ,
    decided_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((status = 'pending') = (decided_at IS NULL)),
    CHECK (status <> 'approved' OR payout_reference IS NOT NULL)
);
-- One open request per user.
CREATE UNIQUE INDEX withdrawals_one_pending ON withdrawals (user_id) WHERE status = 'pending';
CREATE INDEX withdrawals_created ON withdrawals (created_at DESC, id DESC);

ALTER TABLE balance_ledger
    ADD CONSTRAINT balance_ledger_commission FOREIGN KEY (commission_id) REFERENCES commissions(id),
    ADD CONSTRAINT balance_ledger_withdrawal FOREIGN KEY (withdrawal_id) REFERENCES withdrawals(id);
