-- 2026-10-23 (user decision): the USDT on-chain payment method (C2, 1111)
-- is removed completely: kind `usdt_chain`, its tables, paid_via and
-- payment event source 'chain'. USDT withdrawals of invite commission
-- (R46, `withdrawals`, `commission_settings.usdt_chains`) stay.
--
-- No production install ever had such a method; a development or test
-- database that did is cleaned up without losing an order:
-- * the watcher's tables go first (they reference orders and methods);
-- * orders of a removed method keep their row and money fields but lose
--   the method (payment_method_id NULL, as for an order whose method was
--   disabled: a pending one is ended by reconciliation after the close
--   grace with close_state 'method_unavailable', releasing its balance
--   hold and coupon the usual way);
-- * an order paid on chain becomes paid_via 'manual' (the closest
--   remaining meaning: paid outside the panel's gateways), its reason
--   saying so unless one was recorded;
-- * payment events from the watcher (source 'chain') are deleted; other
--   events of a removed method lose it (the FK is ON DELETE SET NULL).

DROP TABLE IF EXISTS chain_transfers;
DROP TABLE IF EXISTS chain_payments;
DROP TABLE IF EXISTS chain_cursors;
DROP INDEX IF EXISTS payment_methods_chain_receiver;

UPDATE orders SET payment_method_id = NULL
WHERE payment_method_id IN (SELECT id FROM payment_methods WHERE kind = 'usdt_chain');

UPDATE orders
SET paid_via = 'manual',
    manual_reason = coalesce(manual_reason, 'USDT on-chain payment (method removed)')
WHERE paid_via = 'chain';

DELETE FROM payment_events WHERE source = 'chain';
DELETE FROM payment_methods WHERE kind = 'usdt_chain';

ALTER TABLE payment_methods DROP CONSTRAINT payment_methods_kind_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_kind_check
    CHECK (kind IN ('alipay_f2f', 'epay'));

ALTER TABLE orders DROP CONSTRAINT orders_paid_via_check;
ALTER TABLE orders ADD CONSTRAINT orders_paid_via_check
    CHECK (paid_via = ANY (ARRAY['notify', 'query', 'manual', 'credit', 'balance', 'coupon']));

ALTER TABLE payment_events DROP CONSTRAINT payment_events_source_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_source_check
    CHECK (source = ANY (ARRAY['notify', 'query', 'precreate', 'close', 'manual', 'expire']));
