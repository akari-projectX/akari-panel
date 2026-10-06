-- Phase A PR ① (ops-logic review 中-2): what an order does is decided and
-- stored when it is created (`action`: new / renew / switch / reset), so a
-- pending order that would take a slot of a limited plan (new, switch)
-- reserves it until it ends: order creation counts active subscribers plus
-- the live reservations of other users' pending orders, and fulfilment
-- checks the same (`orders_capacity_hold`). A payment that still finds the
-- plan full (a late payment after the reservation lapsed, a lowered
-- capacity) is refunded to the balance automatically, the customer is
-- mailed and the admins are alerted through the alert channels: new
-- notification event `billing`.
ALTER TABLE orders ADD COLUMN action text;
UPDATE orders SET action = CASE
    WHEN period = 'reset' THEN 'reset'
    WHEN fulfil_result->>'kind' IN ('new', 'renew', 'switch') THEN fulfil_result->>'kind'
    ELSE 'new' END;
ALTER TABLE orders ALTER COLUMN action SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_action CHECK (
    action IN ('new', 'renew', 'switch', 'reset') AND ((action = 'reset') = (period = 'reset')));
CREATE INDEX orders_capacity_hold ON orders USING btree (plan_id, expires_at)
    WHERE status = 'pending' AND action IN ('new', 'switch');

ALTER TABLE alert_notifications DROP CONSTRAINT alert_notifications_event_check;
ALTER TABLE alert_notifications ADD CONSTRAINT alert_notifications_event_check
    CHECK (event IN ('firing', 'resolved', 'billing'));
