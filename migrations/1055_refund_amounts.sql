-- Phase A PR ① (ops-logic review 中-3): a refund records where the money
-- went. `refund_balance_cents` = credited to the balance (the order's held
-- balance part, plus the gateway amount with "to balance");
-- `refund_external_cents` = refunded out of band in the provider's console
-- (the admin enters it: 0..amount_cents). `refund_cents` stays the total
-- (dashboard, CSV). Before this, an out-of-band refund was recorded as 0.
ALTER TABLE orders ADD COLUMN refund_balance_cents bigint;
ALTER TABLE orders ADD COLUMN refund_external_cents bigint;
UPDATE orders SET refund_balance_cents = refund_cents, refund_external_cents = 0
    WHERE refunded_at IS NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_refund_split CHECK (
    (refunded_at IS NULL) = (refund_balance_cents IS NULL)
    AND (refunded_at IS NULL) = (refund_external_cents IS NULL)
    AND (refunded_at IS NULL
         OR (refund_balance_cents >= 0 AND refund_external_cents BETWEEN 0 AND amount_cents
             AND refund_cents = refund_balance_cents + refund_external_cents)));
