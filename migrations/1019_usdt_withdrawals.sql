-- PR ③ (R46): commission withdrawals are paid in USDT only.
--
-- withdrawals: the user picks a chain the admin enabled and gives an
-- address (checked per chain, billing/usdt.rs; a TON memo is optional) —
-- the request keeps them with the CNY amount debited (`amount_cents`).
-- The admin pays by hand on the exchange and approves with the USDT
-- actually sent (`usdt_micros`, 6 decimals) and the transaction hash
-- (`txid`). The former payout methods (alipay/wechat/bank/other), the free
-- text account and payout_reference are gone.
--
-- commission_settings: `usdt_chains` (the chains offered; default all
-- seven), `usdt_rate_cents` (a reference rate, CNY fen per 1 USDT, shown
-- next to amounts only; NULL = none).
--
-- A v0.4 development database with withdrawal rows is refused (recreate
-- it): there is no faithful conversion of a free-text payout account.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM withdrawals) THEN
        RAISE EXCEPTION 'withdrawals exist: this v0.4 development database must be recreated (R46)';
    END IF;
END $$;

ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_method_check;
ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_account_check;
ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_approved_reference;
ALTER TABLE withdrawals DROP CONSTRAINT withdrawals_payout_reference_check;
ALTER TABLE withdrawals
    DROP COLUMN method,
    DROP COLUMN account,
    DROP COLUMN payout_reference,
    ADD COLUMN chain text NOT NULL,
    ADD COLUMN address text NOT NULL,
    ADD COLUMN memo text,
    ADD COLUMN usdt_micros bigint,
    ADD COLUMN txid text;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_chain
    CHECK ((chain = ANY (ARRAY['trc20'::text, 'plasma'::text, 'polygon'::text, 'arbitrum'::text, 'solana'::text, 'xlayer'::text, 'ton'::text])));
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_address
    CHECK (((char_length(address) >= 1) AND (char_length(address) <= 128)));
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_memo
    CHECK (((memo IS NULL) OR ((chain = 'ton'::text) AND (char_length(memo) >= 1) AND (char_length(memo) <= 120))));
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_approved_payout
    CHECK (((status = 'approved'::text) = ((usdt_micros IS NOT NULL) AND (txid IS NOT NULL))));
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_usdt_micros
    CHECK (((usdt_micros IS NULL) OR ((usdt_micros > 0) AND (usdt_micros <= 1000000000000000))));
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_txid
    CHECK (((txid IS NULL) OR ((char_length(txid) >= 8) AND (char_length(txid) <= 128))));

ALTER TABLE commission_settings
    ADD COLUMN usdt_chains text[] DEFAULT ARRAY['trc20', 'plasma', 'polygon', 'arbitrum', 'solana', 'xlayer', 'ton'] NOT NULL,
    ADD COLUMN usdt_rate_cents bigint;
ALTER TABLE commission_settings ADD CONSTRAINT commission_settings_usdt_chains
    CHECK ((usdt_chains <@ ARRAY['trc20', 'plasma', 'polygon', 'arbitrum', 'solana', 'xlayer', 'ton']));
ALTER TABLE commission_settings ADD CONSTRAINT commission_settings_usdt_rate
    CHECK (((usdt_rate_cents IS NULL) OR ((usdt_rate_cents >= 1) AND (usdt_rate_cents <= 1000000))));
