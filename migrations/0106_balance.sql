-- W16 (M7): per-user balance (余额) with an append-only ledger.
--
-- Money is integer CNY fen. The balance is materialised in user_balances
-- and changes ONLY through an INSERT into balance_ledger: the ledger's
-- BEFORE INSERT trigger applies the amount to the balance row (creating
-- it at 0) under its row lock and refuses (SQLSTATE AK003, HTTP 409
-- "insufficient balance") when the result would be negative; a guard
-- trigger refuses any other write of user_balances.balance_cents. So for
-- every user, at every commit:
--
--     user_balances.balance_cents = sum(balance_ledger.amount_cents) >= 0
--
-- whatever writes (API, CLI, hand-written SQL). Ledger rows are never
-- updated or deleted (only user_id -> NULL when the user is deleted, by
-- the foreign key; the row keeps user_login).
--
-- Kinds (sign enforced):
--   commission           + an invite commission past its hold period
--   admin_adjust         ± an admin's adjustment (reason required)
--   order_payment        - the balance part of an order (held at order
--                          creation, or re-taken by a late payment)
--   refund_to_balance    + the balance part of an order that ended unpaid,
--                          or an admin refund of a paid order to balance
--   withdrawal           - a withdrawal request (funds held until decided)
--   withdrawal_reversal  + a rejected / cancelled withdrawal's funds back

CREATE TABLE user_balances (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE balance_ledger (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    user_login          TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('commission', 'admin_adjust',
                            'order_payment', 'refund_to_balance', 'withdrawal',
                            'withdrawal_reversal')),
    amount_cents        BIGINT NOT NULL CHECK (amount_cents <> 0
                            AND amount_cents BETWEEN -10000000000 AND 10000000000),
    -- Set by the trigger: the balance right after this entry.
    balance_after_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_after_cents >= 0),
    order_id            UUID REFERENCES orders(id),
    -- Foreign keys to commissions / withdrawals: 0108.
    commission_id       UUID,
    withdrawal_id       UUID,
    reason              TEXT CHECK (char_length(reason) <= 500),
    actor_login         TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (CASE kind
        WHEN 'admin_adjust' THEN reason IS NOT NULL
        WHEN 'commission' THEN amount_cents > 0 AND commission_id IS NOT NULL
        WHEN 'order_payment' THEN amount_cents < 0 AND order_id IS NOT NULL
        WHEN 'refund_to_balance' THEN amount_cents > 0 AND order_id IS NOT NULL
        WHEN 'withdrawal' THEN amount_cents < 0 AND withdrawal_id IS NOT NULL
        WHEN 'withdrawal_reversal' THEN amount_cents > 0 AND withdrawal_id IS NOT NULL
    END)
);
CREATE INDEX balance_ledger_user ON balance_ledger (user_id, id DESC);
CREATE INDEX balance_ledger_order ON balance_ledger (order_id) WHERE order_id IS NOT NULL;

-- The only writer of balance_cents.
CREATE FUNCTION akari_ledger_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.user_id IS NULL THEN
        RAISE EXCEPTION 'balance_ledger: user_id is required';
    END IF;
    INSERT INTO user_balances (user_id) VALUES (NEW.user_id) ON CONFLICT DO NOTHING;
    PERFORM set_config('akari.ledger', 'on', true);
    UPDATE user_balances SET balance_cents = balance_cents + NEW.amount_cents, updated_at = now()
        WHERE user_id = NEW.user_id AND balance_cents + NEW.amount_cents >= 0
        RETURNING balance_cents INTO NEW.balance_after_cents;
    -- (FOUND before the PERFORM below, which resets it.)
    IF NOT FOUND THEN
        RAISE EXCEPTION 'insufficient balance' USING ERRCODE = 'AK003';
    END IF;
    PERFORM set_config('akari.ledger', '', true);
    RETURN NEW;
END $$;
CREATE TRIGGER balance_ledger_apply BEFORE INSERT ON balance_ledger
    FOR EACH ROW EXECUTE FUNCTION akari_ledger_apply();

-- Append-only: no UPDATE (except the user deletion's SET NULL), no DELETE.
CREATE FUNCTION akari_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.user_id IS NULL AND OLD.user_id IS NOT NULL
       AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'balance_ledger is append-only';
END $$;
CREATE TRIGGER balance_ledger_append_only BEFORE UPDATE OR DELETE ON balance_ledger
    FOR EACH ROW EXECUTE FUNCTION akari_ledger_append_only();

-- user_balances.balance_cents changes only inside akari_ledger_apply.
CREATE FUNCTION akari_balance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('akari.ledger', true) IS DISTINCT FROM 'on' AND (
        (TG_OP = 'INSERT' AND NEW.balance_cents <> 0)
        OR (TG_OP = 'UPDATE' AND (NEW.balance_cents <> OLD.balance_cents
                                  OR NEW.user_id <> OLD.user_id))) THEN
        RAISE EXCEPTION 'balances change only through balance_ledger';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER user_balances_guard BEFORE INSERT OR UPDATE ON user_balances
    FOR EACH ROW EXECUTE FUNCTION akari_balance_guard();
