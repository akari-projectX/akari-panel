-- Phase A PR ① (P1, SPRINT 2026-10-06 问题记录 P1): an admin refund also
-- revokes what the order did to the subscription, in the refund's
-- transaction (`billing::refund`): a new subscription ends (cancelled), a
-- renewal's added term is taken back (an expiry that would fall before now
-- ends it), a plan switch restores the previous plan, a traffic reset pack
-- is money only. `keep_plan` refunds the money alone.
--
-- `refund_effect` records what the refund did to the subscription (shown in
-- the console; the audit row has the same object). NULL until refunded.
ALTER TABLE orders ADD COLUMN refund_effect jsonb;
ALTER TABLE orders ADD CONSTRAINT orders_refund_effect
    CHECK ((refund_effect IS NULL) = (refunded_at IS NULL));
