-- C1 (billing review 2026-10-09): commission money spent on orders is no
-- longer withdrawable.
--
-- The withdrawable amount used to be min(balance, credited commissions −
-- clawbacks − withdrawals). Spending on orders did not lower it, so a
-- commission spent on an order became withdrawable again as soon as any
-- other money reached the balance (an admin credit, a refund to balance):
-- money that can only be spent turned into cash.
--
-- akari_withdrawable_part(user) replays the user's ledger in order and
-- keeps the balance in two parts: W (commission money, withdrawable) and
-- N (everything else, spendable only). Their sum is the balance.
--   commission            → W
--   withdrawal_reversal   → W (a withdrawal only ever takes W)
--   admin_adjust > 0      → N
--   refund_to_balance     → back to W up to what that order took from W
--                           (an unpaid order's released hold, the balance
--                           part of a refund), the rest (Alipay part) → N
--   order_payment         → from N first, then W (the user's favour); what
--                           came from W is remembered per order
--   admin_adjust < 0      → from N first, then W
--   withdrawal            → from W, then N (cannot happen: requests are
--                           checked against the withdrawable amount)
--   commission_clawback   → from W first, then N
-- The result is W (never more than the balance). billing::ledger::
-- WITHDRAWABLE_SQL still applies the older cap too (outstanding clawbacks
-- that are owed but not recovered are not in the ledger).
CREATE FUNCTION akari_withdrawable_part(uid uuid) RETURNS bigint
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    w bigint := 0;
    n bigint := 0;
    took jsonb := '{}';
    e record;
    a bigint;
    t bigint;
    k text;
BEGIN
    FOR e IN SELECT kind, amount_cents, order_id FROM balance_ledger
             WHERE user_id = uid ORDER BY id LOOP
        a := abs(e.amount_cents);
        IF e.kind IN ('commission', 'withdrawal_reversal') THEN
            w := w + a;
        ELSIF e.kind = 'admin_adjust' AND e.amount_cents > 0 THEN
            n := n + a;
        ELSIF e.kind = 'refund_to_balance' THEN
            k := e.order_id::text;
            t := LEAST(a, COALESCE((took ->> k)::bigint, 0));
            IF t > 0 THEN
                took := jsonb_set(took, ARRAY[k], to_jsonb((took ->> k)::bigint - t));
            END IF;
            w := w + t;
            n := n + (a - t);
        ELSIF e.kind IN ('order_payment', 'admin_adjust') THEN
            t := GREATEST(a - n, 0);
            n := n - (a - t);
            w := w - t;
            IF e.kind = 'order_payment' AND t > 0 THEN
                k := e.order_id::text;
                took := jsonb_set(took, ARRAY[k],
                                  to_jsonb(COALESCE((took ->> k)::bigint, 0) + t));
            END IF;
        ELSIF e.kind IN ('withdrawal', 'commission_clawback') THEN
            t := LEAST(a, GREATEST(w, 0));
            w := w - t;
            n := n - (a - t);
        END IF;
    END LOOP;
    RETURN GREATEST(LEAST(w, w + n), 0);
END
$$;
