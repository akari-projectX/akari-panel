-- C1 (v1-next, 2026-10-13): 易支付 (EPay) payment methods, kind `epay`
-- (billing/epay.rs). Only the kind CHECK changes: the configuration lives
-- in `config` (plain) and `secrets_enc` (the merchant key, sealed like the
-- Alipay private key), exactly like `alipay_f2f`.
ALTER TABLE payment_methods DROP CONSTRAINT payment_methods_kind_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_kind_check
    CHECK (kind IN ('alipay_f2f', 'epay'));
