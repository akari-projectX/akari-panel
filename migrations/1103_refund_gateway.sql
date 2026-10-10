-- next-version: net revenue on the dashboard.
--
-- Revenue is what came in through a payment channel (orders.amount_cents;
-- balance, credit, coupon and gift parts are not revenue). A refund gives
-- back up to two kinds of money: the balance part (never revenue) and the
-- channel part, either credited to the balance (to_balance) or refunded in
-- the channel (refund_external_cents). Only the channel part reverses
-- revenue, and refund_cents alone cannot tell the two apart once a balance
-- part was involved, so the refund records it.
--
-- refund_gateway_cents: the part of the refund that was channel money
-- (to_balance: the whole amount_cents; otherwise refund_external_cents).
-- Same-null as refunded_at, 0..amount_cents, ≤ refund_cents.

ALTER TABLE orders ADD COLUMN refund_gateway_cents bigint;

-- Existing refunds: refund_balance_cents = balance part + (to_balance ?
-- amount : 0); the balance part is balance_cents when the hold was given
-- back (balance_state 'refunded').
UPDATE orders SET refund_gateway_cents = refund_external_cents
    + LEAST(amount_cents - refund_external_cents,
            GREATEST(refund_balance_cents
                     - CASE WHEN balance_state = 'refunded' THEN balance_cents ELSE 0 END, 0))
 WHERE refunded_at IS NOT NULL;

ALTER TABLE orders ADD CONSTRAINT orders_refund_gateway CHECK (
    (refunded_at IS NULL) = (refund_gateway_cents IS NULL)
    AND (refunded_at IS NULL
         OR refund_gateway_cents BETWEEN 0 AND LEAST(amount_cents, refund_cents)));

-- The dashboard's refund windows stay index-only.
DROP INDEX orders_refunded_at;
CREATE INDEX orders_refunded_at ON orders USING btree (refunded_at)
    INCLUDE (refund_cents, refund_gateway_cents) WHERE (refunded_at IS NOT NULL);
