-- PR ③ (支付宝原路退款): refunds through the payment provider.
--
-- orders.refund_request: the refund the admin asked the provider for
-- (`refund::OriginalRequest`): its idempotent request number
-- (`out_request_no`), amount, state (pending = asked or unknown: the
-- reconcile loop queries and retries with the same number until the
-- provider confirms; done = refunded and recorded; failed = the provider
-- refused: nothing moved), attempts, last error, and what the refund
-- records when it completes (reason, keep_plan, the admin). The order's
-- refund columns are written once, when the provider confirms.

ALTER TABLE orders ADD COLUMN refund_request jsonb;
ALTER TABLE orders ADD CONSTRAINT orders_refund_request
    CHECK ((refund_request IS NULL) OR (jsonb_typeof(refund_request) = 'object'));
CREATE INDEX orders_refund_pending ON orders USING btree (id)
    WHERE ((refund_request ->> 'state') = 'pending');
