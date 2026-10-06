-- Phase A PR ① (ops-logic review 中-4): a refund claws back the order's
-- invite commission even after the hold. A pending commission is reversed
-- (as before); a credited one is clawed back: `clawback_cents` = its amount,
-- taken from the inviter's balance as far as it goes (ledger kind
-- `commission_clawback`, negative, append-only like every ledger row) —
-- `clawback_recovered_cents` so far. The rest is a debt: later commissions
-- pay it first (the enforce pass that credits them), and the withdrawable
-- amount counts the whole clawback (credited commissions − clawbacks −
-- withdrawals), so it is never paid out. The balance itself never goes
-- negative (0106).
ALTER TABLE commissions ADD COLUMN clawback_cents bigint;
ALTER TABLE commissions ADD COLUMN clawback_recovered_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE commissions ADD COLUMN clawed_back_at timestamp with time zone;
ALTER TABLE commissions ADD CONSTRAINT commissions_clawback CHECK (
    (clawback_cents IS NULL) = (clawed_back_at IS NULL)
    AND (clawback_cents IS NULL OR (status = 'credited' AND clawback_cents = amount_cents))
    AND clawback_recovered_cents BETWEEN 0 AND COALESCE(clawback_cents, 0));
-- Outstanding clawbacks of an inviter (credit_due nets them first).
CREATE INDEX commissions_clawback_due ON commissions USING btree (inviter_id, id)
    WHERE clawback_cents > clawback_recovered_cents;

ALTER TABLE balance_ledger DROP CONSTRAINT balance_ledger_kind_check;
ALTER TABLE balance_ledger ADD CONSTRAINT balance_ledger_kind_check CHECK (kind IN (
    'commission', 'admin_adjust', 'order_payment', 'refund_to_balance', 'withdrawal',
    'withdrawal_reversal', 'commission_clawback'));
ALTER TABLE balance_ledger DROP CONSTRAINT balance_ledger_kind_shape;
ALTER TABLE balance_ledger ADD CONSTRAINT balance_ledger_kind_shape CHECK (
CASE kind
    WHEN 'admin_adjust' THEN (reason IS NOT NULL)
    WHEN 'commission' THEN ((amount_cents > 0) AND (commission_id IS NOT NULL))
    WHEN 'commission_clawback' THEN ((amount_cents < 0) AND (commission_id IS NOT NULL))
    WHEN 'order_payment' THEN ((amount_cents < 0) AND (order_id IS NOT NULL))
    WHEN 'refund_to_balance' THEN ((amount_cents > 0) AND (order_id IS NOT NULL))
    WHEN 'withdrawal' THEN ((amount_cents < 0) AND (withdrawal_id IS NOT NULL))
    WHEN 'withdrawal_reversal' THEN ((amount_cents > 0) AND (withdrawal_id IS NOT NULL))
    ELSE NULL::boolean
END);
