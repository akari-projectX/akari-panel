-- Ops: admin-created ("manual") paid orders.
--
-- An admin may create an order for a user (plan + period) that is paid at
-- once through the ONE pay path (billing::orders::apply_mark_paid,
-- paid_via 'manual'). The amount is the period's list price (SQL), or 0
-- for a gift: gift_cents carries the forgiven part so the amount identity
-- still holds for every row and revenue reports can separate gifts.
ALTER TABLE orders
    ADD COLUMN gift_cents BIGINT NOT NULL DEFAULT 0 CHECK (gift_cents >= 0);
ALTER TABLE orders DROP CONSTRAINT orders_amount_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_amount_cents_check
    CHECK (amount_cents >= 0
           AND amount_cents = list_price_cents - credit_cents - discount_cents - balance_cents
                              - gift_cents
           AND (amount_cents > 0 OR credit_cents + discount_cents + balance_cents + gift_cents > 0));
-- Revenue reports: paid orders by how they were paid.
CREATE INDEX orders_paid_via_paid_at ON orders (paid_via, paid_at) WHERE status = 'paid';
