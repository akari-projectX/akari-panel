-- C2 (v1-next, 2026-10-13): USDT on-chain payments (Polygon, Plasma), kind
-- `usdt_chain` (billing/chain/). One method = one chain + one receiving
-- address + the token contract; the RPC endpoints are its sealed secret.
-- Orders get a unique exact token amount on the shared address; a
-- watcher reads the token's Transfer logs and pays matching orders
-- through apply_mark_paid (paid_via 'chain').
ALTER TABLE payment_methods DROP CONSTRAINT payment_methods_kind_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_kind_check
    CHECK (kind IN ('alipay_f2f', 'epay', 'usdt_chain'));

-- One receiving address per chain across methods: a transfer can only
-- ever belong to one method (the API maps a violation to
-- 409 payments.chain_address_in_use).
CREATE UNIQUE INDEX payment_methods_chain_receiver
    ON payment_methods ((config->>'chain'), lower(config->>'address'))
    WHERE kind = 'usdt_chain' AND config->>'address' IS NOT NULL;

ALTER TABLE orders DROP CONSTRAINT orders_paid_via_check;
ALTER TABLE orders ADD CONSTRAINT orders_paid_via_check
    CHECK (paid_via = ANY (ARRAY['notify', 'query', 'manual', 'credit', 'balance', 'coupon', 'chain']));

ALTER TABLE payment_events DROP CONSTRAINT payment_events_source_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_source_check
    CHECK (source = ANY (ARRAY['notify', 'query', 'precreate', 'close', 'manual', 'expire', 'chain']));

-- The exact amount of an on-chain order (snapshot of what the payer was
-- shown). `active` rows reserve their amount on the method: unique among
-- active rows (partial unique index); a row stops reserving once
-- `reserved_until` (= order expiry + the method's grace) has passed and a
-- new order needs the amount (`chain::reserve` sets active = false). Old
-- rows stay (matching checks the block time against each row's window).
CREATE TABLE chain_payments (
    order_id uuid PRIMARY KEY REFERENCES orders (id),
    method_id uuid NOT NULL REFERENCES payment_methods (id),
    chain text NOT NULL CHECK (chain IN ('polygon', 'plasma')),
    token text NOT NULL CHECK (token ~ '^0x[0-9A-Fa-f]{40}$'),
    address text NOT NULL CHECK (address ~ '^0x[0-9A-Fa-f]{40}$'),
    amount_units bigint NOT NULL CHECK (amount_units > 0),
    rate_cents integer NOT NULL CHECK (rate_cents BETWEEN 1 AND 100000),
    confirmations integer NOT NULL CHECK (confirmations BETWEEN 1 AND 1000),
    created_at timestamptz NOT NULL DEFAULT now(),
    reserved_until timestamptz NOT NULL,
    active boolean NOT NULL DEFAULT true,
    CONSTRAINT chain_payments_window CHECK (reserved_until > created_at)
);
CREATE UNIQUE INDEX chain_payments_amount ON chain_payments (method_id, amount_units) WHERE active;
CREATE INDEX chain_payments_match ON chain_payments (method_id, amount_units, created_at);
CREATE INDEX chain_payments_expiry ON chain_payments (method_id, reserved_until) WHERE active;

-- The watcher's position per method: blocks below `next_block` were read
-- at the confirmation depth (NULL = never read the chain head yet).
CREATE TABLE chain_cursors (
    method_id uuid PRIMARY KEY REFERENCES payment_methods (id) ON DELETE CASCADE,
    next_block bigint CHECK (next_block >= 0),
    head bigint CHECK (head >= 0),
    head_at timestamptz,
    last_error text CHECK (char_length(last_error) <= 300),
    failing_since timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chain_cursors_failing CHECK ((last_error IS NULL) = (failing_since IS NULL))
);

-- Every token transfer to a watched address (at least 0.01 USDT):
-- pending (waiting for confirmations; `order_id` = the tentative match for
-- the payer's page) → credited (paid its order) | unmatched (no order,
-- the order was already paid, or ambiguous: the admin assigns or ignores
-- it) | dropped (gone from the chain: reorg / failed transaction).
-- One row per (chain, tx, log): a transfer is recorded and credited once.
CREATE TABLE chain_transfers (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    method_id uuid NOT NULL REFERENCES payment_methods (id),
    chain text NOT NULL CHECK (chain IN ('polygon', 'plasma')),
    tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index integer NOT NULL CHECK (log_index >= 0),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    block_time timestamptz,
    from_address text NOT NULL CHECK (from_address ~ '^0x[0-9a-f]{40}$'),
    amount_units bigint NOT NULL CHECK (amount_units > 0),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'credited', 'unmatched', 'assigned', 'ignored', 'dropped')),
    reason text CHECK (reason IN ('no_order', 'order_paid', 'ambiguous', 'reverted', 'missing')),
    order_id uuid REFERENCES orders (id),
    note text CHECK (char_length(note) BETWEEN 1 AND 500),
    seen_at timestamptz NOT NULL DEFAULT now(),
    confirmed_at timestamptz,
    resolved_at timestamptz,
    resolved_by uuid REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT chain_transfers_once UNIQUE (chain, tx_hash, log_index),
    CONSTRAINT chain_transfers_paid CHECK (status NOT IN ('credited', 'assigned') OR order_id IS NOT NULL),
    CONSTRAINT chain_transfers_confirmed CHECK (status IN ('pending', 'dropped') OR confirmed_at IS NOT NULL),
    CONSTRAINT chain_transfers_resolved CHECK ((status IN ('assigned', 'ignored')) = (resolved_at IS NOT NULL))
);
CREATE INDEX chain_transfers_pending ON chain_transfers (method_id, block_number) WHERE status = 'pending';
CREATE INDEX chain_transfers_status ON chain_transfers (status, id);
CREATE INDEX chain_transfers_order ON chain_transfers (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX chain_transfers_method ON chain_transfers (method_id, id);
