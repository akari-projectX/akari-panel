-- Crypto gateways (2026-10-27): payment method kinds `coinpayments`
-- (billing/coinpayments.rs) and `coinbase` (billing/coinbase.rs). Only the
-- kind CHECK changes: the configuration lives in `config` (plain) and the
-- secrets (client secret / API private key / webhook secret) in
-- `secrets_enc` (sealed like the Alipay private key), exactly like
-- `alipay_f2f` and `epay`. No other table changes: the gateways settle
-- through the one `apply_mark_paid` path with paid_via 'notify' / 'query'.
ALTER TABLE payment_methods DROP CONSTRAINT payment_methods_kind_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_kind_check
    CHECK (kind IN ('alipay_f2f', 'epay', 'coinpayments', 'coinbase'));
