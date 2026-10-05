-- W28-a (PLAN-v0.4 D2, D3, section 5; research/db-schema-review.md "D2",
-- "D3", "D6"): one node = one inbound; access and accounting per entrance.
--
-- * D2: `nodes.inbound` (one xray inbound object) replaces the
--   `xray_inbounds` array. The panel sets the inbound's tag when it renders
--   the agent's config; the stored object has none.
-- * Section 5: an entrance is how clients reach a node. Every node has one
--   built-in `direct` entrance (created with the node, may be disabled):
--   its client-facing address (formerly `nodes.server_addr` /
--   `connect_overrides`) and traffic multiplier (formerly
--   `nodes.traffic_rate_permille`) live on it. Relay entrances follow in a
--   later migration of this block.
-- * Access = plans -> node groups -> entrances (`entrance_group_members`
--   replaces `node_group_members`); `entrance_users` (one independent
--   credential per user and entrance) replaces `node_users`; D3: there is
--   no manual assignment any more (`node_users.manual` is gone with its
--   table).
-- * Accounting (R43): live counters and the traffic history carry the
--   entrance; `traffic_entrance_daily` replaces `traffic_node_daily`.
--
-- v0.4 is a fresh install (1000_baseline): no deployed database holds
-- nodes or traffic yet, so nothing is converted; a development database
-- that does is refused (recreate it).

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM nodes) OR EXISTS (SELECT 1 FROM traffic_counters)
       OR EXISTS (SELECT 1 FROM traffic_daily) OR EXISTS (SELECT 1 FROM traffic_daily_pending)
       OR EXISTS (SELECT 1 FROM traffic_monthly) THEN
        RAISE EXCEPTION 'migration 1030 (entrances) needs a database without nodes or traffic: '
            'v0.4 development databases are recreated, not converted';
    END IF;
END $$;

-- -------------------------------------------------------------------------
-- D2: one inbound per node
-- -------------------------------------------------------------------------

ALTER TABLE nodes
    DROP COLUMN xray_inbounds,
    DROP COLUMN server_addr,
    DROP COLUMN connect_overrides,
    DROP COLUMN traffic_rate_permille,
    ADD COLUMN inbound jsonb,
    ADD CONSTRAINT nodes_inbound_object CHECK (inbound IS NULL OR jsonb_typeof(inbound) = 'object');

-- -------------------------------------------------------------------------
-- Entrances
-- -------------------------------------------------------------------------

CREATE TABLE entrances (
    id uuid NOT NULL,
    node_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    -- What clients dial. Direct: NULL host = the node's TLS domain (no
    -- address at all = left out of subscriptions), NULL port = the
    -- inbound's port.
    connect_host text,
    connect_port integer,
    -- Traffic multiplier (permille) billed for traffic through this
    -- entrance, applied by traffic::FLUSH_SQL at settlement.
    rate_permille integer DEFAULT 1000 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entrances_kind CHECK (kind = 'direct'),
    CONSTRAINT entrances_name CHECK (char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT entrances_connect_host CHECK (connect_host IS NULL OR char_length(connect_host) BETWEEN 1 AND 253),
    CONSTRAINT entrances_connect_port CHECK (connect_port IS NULL OR connect_port BETWEEN 1 AND 65535),
    CONSTRAINT entrances_rate CHECK (rate_permille BETWEEN 0 AND 100000),
    CONSTRAINT entrances_sort CHECK (sort BETWEEN -1000000 AND 1000000)
);

ALTER TABLE ONLY entrances ADD CONSTRAINT entrances_pkey PRIMARY KEY (id);
ALTER TABLE ONLY entrances ADD CONSTRAINT entrances_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY entrances ADD CONSTRAINT entrances_name_key UNIQUE (node_id, name);
CREATE UNIQUE INDEX entrances_one_direct ON entrances USING btree (node_id) WHERE (kind = 'direct');

-- Every node has exactly one built-in direct entrance from its creation
-- on (whatever inserts the node); it goes away only with the node.
CREATE FUNCTION akari_node_direct_entrance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO entrances (id, node_id, kind, name) VALUES (gen_random_uuid(), NEW.id, 'direct', '直连');
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_direct_entrance AFTER INSERT ON nodes FOR EACH ROW EXECUTE FUNCTION akari_node_direct_entrance();

-- Plans -> node groups -> entrances.
DROP TABLE node_group_members;

CREATE TABLE entrance_group_members (
    group_id uuid NOT NULL,
    entrance_id uuid NOT NULL
);

ALTER TABLE ONLY entrance_group_members ADD CONSTRAINT entrance_group_members_pkey PRIMARY KEY (group_id, entrance_id);
ALTER TABLE ONLY entrance_group_members ADD CONSTRAINT entrance_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES node_groups(id) ON DELETE CASCADE;
ALTER TABLE ONLY entrance_group_members ADD CONSTRAINT entrance_group_members_entrance_id_fkey FOREIGN KEY (entrance_id) REFERENCES entrances(id) ON DELETE CASCADE;
CREATE INDEX entrance_group_members_entrance ON entrance_group_members USING btree (entrance_id);

-- -------------------------------------------------------------------------
-- Access: one credential per (entrance, user); written only by
-- entitle::apply_reconcile (D3: no manual assignment).
-- -------------------------------------------------------------------------

DROP TABLE node_users;
DROP TABLE node_users_departed;

CREATE TABLE entrance_users (
    entrance_id uuid NOT NULL,
    user_id uuid NOT NULL,
    -- The account's protocol (the node inbound's at issue time) and the
    -- xray account sent to the agent verbatim.
    protocol text NOT NULL,
    account jsonb NOT NULL,
    CONSTRAINT entrance_users_account_object CHECK (jsonb_typeof(account) = 'object')
);

ALTER TABLE ONLY entrance_users ADD CONSTRAINT entrance_users_pkey PRIMARY KEY (entrance_id, user_id);
ALTER TABLE ONLY entrance_users ADD CONSTRAINT entrance_users_entrance_id_fkey FOREIGN KEY (entrance_id) REFERENCES entrances(id) ON DELETE CASCADE;
ALTER TABLE ONLY entrance_users ADD CONSTRAINT entrance_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX entrance_users_user ON entrance_users USING btree (user_id);

-- The user still exists but lost this entrance: its final counters
-- (reported after the removal) stay billable for the departed grace.
CREATE TABLE entrance_users_departed (
    entrance_id uuid NOT NULL,
    user_id uuid NOT NULL,
    departed_at timestamp with time zone DEFAULT now() NOT NULL,
    billed_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT entrance_users_departed_billed_nonneg CHECK (billed_bytes >= 0)
);

ALTER TABLE ONLY entrance_users_departed ADD CONSTRAINT entrance_users_departed_pkey PRIMARY KEY (entrance_id, user_id);
ALTER TABLE ONLY entrance_users_departed ADD CONSTRAINT entrance_users_departed_entrance_id_fkey FOREIGN KEY (entrance_id) REFERENCES entrances(id) ON DELETE CASCADE;
ALTER TABLE ONLY entrance_users_departed ADD CONSTRAINT entrance_users_departed_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX entrance_users_departed_at ON entrance_users_departed USING btree (departed_at);
CREATE INDEX entrance_users_departed_user ON entrance_users_departed USING btree (user_id);

-- -------------------------------------------------------------------------
-- Accounting per entrance (R43)
-- -------------------------------------------------------------------------

ALTER TABLE traffic_counters DROP CONSTRAINT traffic_counters_pkey;
ALTER TABLE traffic_counters ADD COLUMN entrance_id uuid NOT NULL;
ALTER TABLE ONLY traffic_counters ADD CONSTRAINT traffic_counters_pkey PRIMARY KEY (node_id, entrance_id, user_id, session_id);

ALTER TABLE traffic_daily_pending ADD COLUMN entrance_id uuid NOT NULL;

ALTER TABLE traffic_daily DROP CONSTRAINT traffic_daily_pkey;
ALTER TABLE traffic_daily ADD COLUMN entrance_id uuid NOT NULL;
ALTER TABLE ONLY traffic_daily ADD CONSTRAINT traffic_daily_pkey PRIMARY KEY (user_id, day, entrance_id);

ALTER TABLE traffic_monthly DROP CONSTRAINT traffic_monthly_pkey;
ALTER TABLE traffic_monthly ADD COLUMN entrance_id uuid NOT NULL;
ALTER TABLE ONLY traffic_monthly ADD CONSTRAINT traffic_monthly_pkey PRIMARY KEY (user_id, month, entrance_id);

DROP TABLE traffic_node_daily;

-- Per entrance and day (node = the entrance's node then, kept so a node's
-- total is a sum over its rows even after the entrance is gone). No
-- foreign keys, like the rest of the history.
CREATE TABLE traffic_entrance_daily (
    entrance_id uuid NOT NULL,
    day date NOT NULL,
    node_id uuid NOT NULL,
    up_bytes bigint DEFAULT 0 NOT NULL,
    down_bytes bigint DEFAULT 0 NOT NULL,
    billed_bytes bigint DEFAULT 0 NOT NULL,
    users integer DEFAULT 0 NOT NULL,
    CONSTRAINT traffic_entrance_daily_billed_bytes_check CHECK (billed_bytes >= 0),
    CONSTRAINT traffic_entrance_daily_down_bytes_check CHECK (down_bytes >= 0),
    CONSTRAINT traffic_entrance_daily_up_bytes_check CHECK (up_bytes >= 0),
    CONSTRAINT traffic_entrance_daily_users_check CHECK (users >= 0)
)
WITH (fillfactor='70');

ALTER TABLE ONLY traffic_entrance_daily ADD CONSTRAINT traffic_entrance_daily_pkey PRIMARY KEY (entrance_id, day);
CREATE INDEX traffic_entrance_daily_day ON traffic_entrance_daily USING btree (day);
CREATE INDEX traffic_entrance_daily_node ON traffic_entrance_daily USING btree (node_id, day);
