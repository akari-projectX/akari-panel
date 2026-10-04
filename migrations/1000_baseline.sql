-- v0.4 baseline: the schema of migrations 0001-0168 (panel v0.3.x), squashed
-- into one file (research/db-schema-review.md section 7). A database created
-- by the old chain cannot be upgraded: db::migrate refuses any
-- _sqlx_migrations version < 1000 (fresh install, docs/DEPLOY.md).
--
-- Generated from pg_dump of the old chain, then reorganised by domain. The only
-- intended differences from the 0168 schema:
--   * no pgcrypto extension (unused; gen_random_uuid() is core);
--   * the 37 anonymous CHECK constraints (<table>_check, <table>_checkN) have
--     descriptive names;
--   * indexes for foreign keys that lacked one (section 4.1 of the review);
--     orders_payment_method replaces orders_payment_method_pending.
-- Per-table notes and invariants: migrations/CLAUDE.md. History of individual
-- changes: git history up to v0.3.2.
--
-- No schema qualification and no search_path changes: tests migrate each into
-- its own schema (src/testdb.rs).

-- =========================================================================
-- Types
-- =========================================================================

CREATE TYPE user_disabled_reason AS ENUM (
    'admin',
    'quota',
    'expiry'
);

CREATE TYPE user_plan_status AS ENUM (
    'active',
    'replaced',
    'cancelled',
    'expired'
);

-- =========================================================================
-- Functions (billing arithmetic, reset/period calendar, guard and NOTIFY
-- triggers)
-- =========================================================================

CREATE FUNCTION akari_balance_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF current_setting('akari.ledger', true) IS DISTINCT FROM 'on' AND (
        (TG_OP = 'INSERT' AND NEW.balance_cents <> 0)
        OR (TG_OP = 'UPDATE' AND (NEW.balance_cents <> OLD.balance_cents
                                  OR NEW.user_id <> OLD.user_id))) THEN
        RAISE EXCEPTION 'balances change only through balance_ledger';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION akari_coupon_discount(list_cents bigint, kind text, value bigint) RETURNS bigint
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT CASE
        WHEN list_cents IS NULL OR list_cents <= 0 OR value IS NULL OR value <= 0 THEN 0
        WHEN kind = 'percent' THEN (list_cents * LEAST(value, 100)) / 100
        WHEN kind = 'fixed' THEN LEAST(value, list_cents)
        ELSE 0
    END
$$;

CREATE FUNCTION akari_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.user_id IS NULL AND OLD.user_id IS NOT NULL
       AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'balance_ledger is append-only';
END $$;

CREATE FUNCTION akari_ledger_apply() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.user_id IS NULL THEN
        RAISE EXCEPTION 'balance_ledger: user_id is required';
    END IF;
    INSERT INTO user_balances (user_id) VALUES (NEW.user_id) ON CONFLICT DO NOTHING;
    PERFORM set_config('akari.ledger', 'on', true);
    UPDATE user_balances SET balance_cents = balance_cents + NEW.amount_cents, updated_at = now()
        WHERE user_id = NEW.user_id AND balance_cents + NEW.amount_cents >= 0
        RETURNING balance_cents INTO NEW.balance_after_cents;
    -- (FOUND before the PERFORM below, which resets it.)
    IF NOT FOUND THEN
        RAISE EXCEPTION 'insufficient balance' USING ERRCODE = 'AK003';
    END IF;
    PERFORM set_config('akari.ledger', '', true);
    RETURN NEW;
END $$;

CREATE FUNCTION akari_next_reset(anchor timestamp with time zone, period text, days integer, after timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    a TIMESTAMP := anchor AT TIME ZONE 'UTC';
    f TIMESTAMP := after AT TIME ZONE 'UTC';
    k BIGINT;
    t TIMESTAMPTZ;
BEGIN
    IF period = 'none' OR anchor IS NULL OR after IS NULL THEN
        RETURN NULL;
    ELSIF period = 'days' THEN
        IF days IS NULL OR days < 1 THEN
            RAISE EXCEPTION 'akari_next_reset: bad days %', days;
        END IF;
        IF after < anchor THEN
            RETURN anchor;
        END IF;
        k := floor(extract(epoch FROM after - anchor) / (days::numeric * 86400))::bigint + 1;
        RETURN anchor + make_interval(secs => k * days::bigint * 86400);
    ELSIF period = 'monthly' THEN
        IF after < anchor THEN
            RETURN anchor;
        END IF;
        k := GREATEST(1, (extract(year FROM f)::bigint - extract(year FROM a)::bigint) * 12
                         + extract(month FROM f)::bigint - extract(month FROM a)::bigint - 1);
        LOOP
            t := (a + make_interval(months => k::int)) AT TIME ZONE 'UTC';
            EXIT WHEN t > after;
            k := k + 1;
        END LOOP;
        RETURN t;
    END IF;
    RAISE EXCEPTION 'akari_next_reset: bad period %', period;
END $$;

CREATE FUNCTION akari_notify_node_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('akari_change', 'del:' || OLD.id::text);
        RETURN OLD;
    END IF;
    PERFORM pg_notify('akari_change', NEW.id::text);
    RETURN NEW;
END;
$$;

CREATE FUNCTION akari_period_end(base timestamp with time zone, period text, days integer) RETURNS timestamp with time zone
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    m INTEGER := CASE period
        WHEN 'month' THEN 1 WHEN 'quarter' THEN 3 WHEN 'half_year' THEN 6
        WHEN 'year' THEN 12 WHEN 'two_year' THEN 24 WHEN 'three_year' THEN 36
        ELSE NULL END;
BEGIN
    IF base IS NULL THEN
        RAISE EXCEPTION 'akari_period_end: NULL base';
    ELSIF m IS NOT NULL THEN
        RETURN ((base AT TIME ZONE 'UTC') + make_interval(months => m)) AT TIME ZONE 'UTC';
    ELSIF period = 'onetime' AND days IS NULL THEN
        RETURN NULL;
    ELSIF period IN ('days', 'onetime') AND days BETWEEN 1 AND 3650 THEN
        RETURN base + make_interval(secs => days::bigint * 86400);
    END IF;
    RAISE EXCEPTION 'akari_period_end: bad period % (days %)', period, days;
END $$;

CREATE FUNCTION akari_period_nominal_days(period text, days integer) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT CASE period
        WHEN 'month' THEN 30 WHEN 'quarter' THEN 90 WHEN 'half_year' THEN 180
        WHEN 'year' THEN 365 WHEN 'two_year' THEN 730 WHEN 'three_year' THEN 1095
        WHEN 'days' THEN days WHEN 'onetime' THEN days
        ELSE NULL END
$$;

CREATE FUNCTION akari_prorate(value_cents bigint, nominal_days integer, remaining_secs numeric, cap_cents bigint) RETURNS bigint
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT CASE
        WHEN value_cents IS NULL OR value_cents <= 0 OR nominal_days IS NULL
             OR nominal_days <= 0 OR remaining_secs IS NULL OR remaining_secs <= 0
             OR cap_cents IS NULL OR cap_cents <= 0 THEN 0
        ELSE LEAST(cap_cents,
                   floor(value_cents::numeric * remaining_secs
                         / (nominal_days::numeric * 86400)))::bigint
    END
$$;

CREATE FUNCTION akari_refuse_revoked_serial() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (NEW.cert_serial IS NOT NULL
        AND EXISTS (SELECT 1 FROM revoked_certs WHERE cert_serial = NEW.cert_serial))
       OR (NEW.prev_cert_serial IS NOT NULL
        AND EXISTS (SELECT 1 FROM revoked_certs WHERE cert_serial = NEW.prev_cert_serial)) THEN
        RAISE EXCEPTION 'certificate serial is revoked'
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION akari_settings_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('akari_change', 'settings');
    RETURN NULL;
END $$;

CREATE FUNCTION akari_split(list_cents bigint, discount bigint, credit bigint, balance bigint, OUT discount_cents bigint, OUT credit_cents bigint, OUT balance_cents bigint, OUT amount_cents bigint) RETURNS record
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
    IF list_cents IS NULL OR list_cents <= 0 THEN
        RAISE EXCEPTION 'akari_split: bad list price %', list_cents;
    END IF;
    discount_cents := LEAST(GREATEST(COALESCE(discount, 0), 0), list_cents);
    credit_cents := LEAST(GREATEST(COALESCE(credit, 0), 0), list_cents - discount_cents);
    balance_cents := LEAST(GREATEST(COALESCE(balance, 0), 0),
                           list_cents - discount_cents - credit_cents);
    amount_cents := list_cents - discount_cents - credit_cents - balance_cents;
END $$;

CREATE FUNCTION akari_sub_token_enc_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.sub_token_hash IS DISTINCT FROM OLD.sub_token_hash
       AND NEW.sub_token_enc IS NOT DISTINCT FROM OLD.sub_token_enc THEN
        NEW.sub_token_enc := NULL;
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION akari_users_inviter_acyclic() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    cur UUID := NEW.inviter_id;
    depth INTEGER := 0;
BEGIN
    IF NEW.inviter_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.inviter_id = NEW.id THEN
        RAISE EXCEPTION 'a user cannot be their own inviter' USING ERRCODE = 'AK002';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('akari.inviter'));
    WHILE cur IS NOT NULL AND depth < 100000 LOOP
        SELECT inviter_id INTO cur FROM users WHERE id = cur;
        IF cur = NEW.id THEN
            RAISE EXCEPTION 'inviter chain would form a cycle' USING ERRCODE = 'AK002';
        END IF;
        depth := depth + 1;
    END LOOP;
    RETURN NEW;
END $$;

CREATE FUNCTION users_bump_session_ver() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
       OR NEW.role IS DISTINCT FROM OLD.role
       OR (OLD.enabled AND NOT NEW.enabled)
       OR (NEW.expiry_enforced AND NOT OLD.expiry_enforced) THEN
        NEW.session_ver := OLD.session_ver + 1;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION users_disabled_reason() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.enabled THEN
        NEW.disabled_reason := NULL;
    ELSIF NEW.disabled_reason IS NULL THEN
        NEW.disabled_reason := 'admin';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION users_keep_last_admin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('akari.last_enabled_admin', 0));
    IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND enabled) THEN
        RAISE EXCEPTION 'cannot remove the last enabled admin'
            USING ERRCODE = 'AK001';
    END IF;
    RETURN NULL;
END $$;

SET default_tablespace = '';

SET default_table_access_method = heap;

-- =========================================================================
-- Nodes, enrollment, certificates, node groups
-- =========================================================================

CREATE TABLE nodes (
    id uuid NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    status text DEFAULT 'offline'::text NOT NULL,
    xray_inbounds jsonb DEFAULT '[]'::jsonb NOT NULL,
    config_version bigint DEFAULT 1 NOT NULL,
    user_version bigint DEFAULT 0 NOT NULL,
    cert_serial text,
    agent_version text,
    core_version text,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    server_addr text,
    last_error text,
    last_error_at timestamp with time zone,
    failed_config_version bigint,
    failed_user_version bigint,
    online_session uuid,
    failed_reason text,
    failed_held_config_version bigint,
    failed_held_user_version bigint,
    agent_protocol integer,
    lease_expires_at timestamp with time zone,
    deleting_at timestamp with time zone,
    delete_acked_at timestamp with time zone,
    traffic_tat timestamp with time zone,
    traffic_max_rate_bytes_per_sec bigint,
    traffic_credit_floor timestamp with time zone,
    traffic_credit_until timestamp with time zone,
    prev_cert_serial text,
    cert_not_after timestamp with time zone,
    agent_session text,
    agent_session_at timestamp with time zone,
    finals_drained_session text,
    finals_drained_at timestamp with time zone,
    region text,
    agent_os text,
    agent_arch text,
    server_name text,
    tls_domain text,
    agent_addr inet,
    display_name text,
    sort integer DEFAULT 0 NOT NULL,
    visible boolean DEFAULT true NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    traffic_rate_permille integer DEFAULT 1000 NOT NULL,
    connect_overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    traffic_raw_bytes bigint DEFAULT 0 NOT NULL,
    traffic_billed_bytes bigint DEFAULT 0 NOT NULL,
    probe_requested_at timestamp with time zone,
    panel_probe_next_at timestamp with time zone,
    agent_capabilities text[],
    enrolled_at timestamp with time zone,
    CONSTRAINT nodes_connect_overrides_check CHECK ((jsonb_typeof(connect_overrides) = 'object'::text)),
    CONSTRAINT nodes_display_name_check CHECK (((display_name IS NULL) OR (char_length(display_name) BETWEEN 1 AND 64))),
    CONSTRAINT nodes_sort_check CHECK ((sort BETWEEN '-1000000'::integer AND 1000000)),
    CONSTRAINT nodes_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'online'::text, 'offline'::text]))),
    CONSTRAINT nodes_tags_check CHECK (((cardinality(tags) <= 8) AND (array_position(tags, NULL::text) IS NULL))),
    CONSTRAINT nodes_tls_domain_check CHECK (((tls_domain IS NULL) OR ((length(tls_domain) <= 253) AND (tls_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'::text) AND (tls_domain !~ '^[0-9.]+$'::text)))),
    CONSTRAINT nodes_traffic_billed_bytes_check CHECK ((traffic_billed_bytes >= 0)),
    CONSTRAINT nodes_traffic_max_rate_bytes_per_sec_check CHECK (((traffic_max_rate_bytes_per_sec IS NULL) OR (traffic_max_rate_bytes_per_sec > 0))),
    CONSTRAINT nodes_traffic_rate_permille_check CHECK ((traffic_rate_permille BETWEEN 0 AND 100000)),
    CONSTRAINT nodes_traffic_raw_bytes_check CHECK ((traffic_raw_bytes >= 0))
);

ALTER TABLE ONLY nodes ADD CONSTRAINT nodes_cert_serial_key UNIQUE (cert_serial);
ALTER TABLE ONLY nodes ADD CONSTRAINT nodes_name_key UNIQUE (name);
ALTER TABLE ONLY nodes ADD CONSTRAINT nodes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY nodes ADD CONSTRAINT nodes_prev_cert_serial_key UNIQUE (prev_cert_serial);
CREATE TRIGGER nodes_notify_delete AFTER DELETE ON nodes FOR EACH ROW EXECUTE FUNCTION akari_notify_node_change();
CREATE TRIGGER nodes_notify_versions AFTER UPDATE ON nodes FOR EACH ROW WHEN (((old.config_version IS DISTINCT FROM new.config_version) OR (old.user_version IS DISTINCT FROM new.user_version))) EXECUTE FUNCTION akari_notify_node_change();
CREATE TRIGGER nodes_refuse_revoked_serial BEFORE INSERT OR UPDATE OF cert_serial, prev_cert_serial ON nodes FOR EACH ROW EXECUTE FUNCTION akari_refuse_revoked_serial();

CREATE TABLE revoked_certs (
    cert_serial text NOT NULL,
    node_id uuid NOT NULL,
    revoked_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text DEFAULT 'deleted'::text NOT NULL,
    CONSTRAINT revoked_certs_reason_check CHECK ((reason = ANY (ARRAY['deleted'::text, 'rotated'::text])))
);

ALTER TABLE ONLY revoked_certs ADD CONSTRAINT revoked_certs_pkey PRIMARY KEY (cert_serial);

CREATE TABLE node_enrollments (
    node_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    install_origin text,
    install_pin text,
    panel_addr text,
    server_name text,
    CONSTRAINT node_enrollments_pin_needs_origin CHECK (((install_pin IS NULL) OR (install_origin IS NOT NULL)))
);

ALTER TABLE ONLY node_enrollments ADD CONSTRAINT node_enrollments_pkey PRIMARY KEY (node_id);
ALTER TABLE ONLY node_enrollments ADD CONSTRAINT node_enrollments_token_hash_key UNIQUE (token_hash);

CREATE TABLE grpc_server_names (
    name text NOT NULL,
    source text NOT NULL,
    first_used_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grpc_server_names_source_check CHECK ((source = ANY (ARRAY['settings'::text, 'config'::text, 'enrollment'::text])))
);

ALTER TABLE ONLY grpc_server_names ADD CONSTRAINT grpc_server_names_pkey PRIMARY KEY (name);
CREATE TRIGGER grpc_server_names_notify AFTER INSERT OR DELETE OR UPDATE ON grpc_server_names FOR EACH ROW EXECUTE FUNCTION akari_settings_notify();

CREATE TABLE node_groups (
    id uuid NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY node_groups ADD CONSTRAINT node_groups_name_key UNIQUE (name);
ALTER TABLE ONLY node_groups ADD CONSTRAINT node_groups_pkey PRIMARY KEY (id);

CREATE TABLE node_group_members (
    group_id uuid NOT NULL,
    node_id uuid NOT NULL
);

ALTER TABLE ONLY node_group_members ADD CONSTRAINT node_group_members_pkey PRIMARY KEY (group_id, node_id);
CREATE INDEX node_group_members_node ON node_group_members USING btree (node_id);

-- =========================================================================
-- Users and authentication
-- =========================================================================

CREATE TABLE users (
    id uuid NOT NULL,
    login text NOT NULL,
    password_hash text,
    role text DEFAULT 'user'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    traffic_limit_bytes bigint,
    traffic_used_bytes bigint DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sub_token_hash text,
    expiry_enforced boolean DEFAULT false NOT NULL,
    session_ver bigint DEFAULT 0 NOT NULL,
    disabled_reason user_disabled_reason,
    inviter_id uuid,
    email text,
    email_verified_at timestamp with time zone,
    locale text DEFAULT 'zh'::text NOT NULL,
    sub_token_enc bytea,
    invite_autocreated boolean DEFAULT false NOT NULL,
    CONSTRAINT users_disabled_reason_matches CHECK ((enabled = (disabled_reason IS NULL))),
    CONSTRAINT users_email_check CHECK (((email = lower(email)) AND (length(email) BETWEEN 3 AND 254))),
    CONSTRAINT users_locale_check CHECK ((locale = ANY (ARRAY['zh'::text, 'en'::text]))),
    CONSTRAINT users_role_valid CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text]))),
    CONSTRAINT users_sub_token_enc_has_hash CHECK (((sub_token_enc IS NULL) OR (sub_token_hash IS NOT NULL))),
    CONSTRAINT users_traffic_limit_nonneg CHECK (((traffic_limit_bytes IS NULL) OR (traffic_limit_bytes >= 0))),
    CONSTRAINT users_traffic_used_nonneg CHECK ((traffic_used_bytes >= 0)),
    CONSTRAINT users_verified_email CHECK (((email_verified_at IS NULL) OR (email IS NOT NULL)))
)
WITH (fillfactor='85');

ALTER TABLE ONLY users ADD CONSTRAINT users_login_key UNIQUE (login);
ALTER TABLE ONLY users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY users ADD CONSTRAINT users_sub_token_hash_key UNIQUE (sub_token_hash);
CREATE INDEX users_created_at ON users USING btree (created_at, id);
CREATE INDEX users_email_prefix ON users USING btree (email text_pattern_ops) WHERE (email IS NOT NULL);
CREATE UNIQUE INDEX users_email_verified ON users USING btree (email) WHERE (email_verified_at IS NOT NULL);
CREATE INDEX users_inviter ON users USING btree (inviter_id) WHERE (inviter_id IS NOT NULL);
CREATE INDEX users_login_prefix ON users USING btree (lower(login) text_pattern_ops);
CREATE TRIGGER users_bump_session_ver BEFORE UPDATE OF password_hash, role, enabled, expiry_enforced ON users FOR EACH ROW EXECUTE FUNCTION users_bump_session_ver();
CREATE TRIGGER users_disabled_reason BEFORE INSERT OR UPDATE OF enabled, disabled_reason ON users FOR EACH ROW EXECUTE FUNCTION users_disabled_reason();
CREATE TRIGGER users_inviter_acyclic BEFORE INSERT OR UPDATE OF inviter_id ON users FOR EACH ROW EXECUTE FUNCTION akari_users_inviter_acyclic();
CREATE TRIGGER users_keep_last_admin_delete AFTER DELETE ON users FOR EACH ROW WHEN (((old.role = 'admin'::text) AND old.enabled)) EXECUTE FUNCTION users_keep_last_admin();
CREATE TRIGGER users_keep_last_admin_update AFTER UPDATE OF role, enabled ON users FOR EACH ROW WHEN (((old.role = 'admin'::text) AND old.enabled AND (NOT ((new.role = 'admin'::text) AND new.enabled)))) EXECUTE FUNCTION users_keep_last_admin();
CREATE TRIGGER users_sub_token_enc_guard BEFORE UPDATE OF sub_token_hash, sub_token_enc ON users FOR EACH ROW EXECUTE FUNCTION akari_sub_token_enc_guard();

CREATE TABLE user_totp (
    user_id uuid NOT NULL,
    secret_enc bytea NOT NULL,
    enabled_at timestamp with time zone,
    last_step bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY user_totp ADD CONSTRAINT user_totp_pkey PRIMARY KEY (user_id);

CREATE TABLE user_recovery_codes (
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone
);

ALTER TABLE ONLY user_recovery_codes ADD CONSTRAINT user_recovery_codes_pkey PRIMARY KEY (user_id, code_hash);

CREATE TABLE email_codes (
    purpose text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    user_id uuid,
    code_hash text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT email_codes_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT email_codes_user_iff_change_email CHECK (((purpose = 'change_email'::text) = (user_id IS NOT NULL))),
    CONSTRAINT email_codes_purpose_check CHECK ((purpose = ANY (ARRAY['register'::text, 'change_email'::text])))
);

ALTER TABLE ONLY email_codes ADD CONSTRAINT email_codes_pkey PRIMARY KEY (purpose, subject);
CREATE INDEX email_codes_expires ON email_codes USING btree (expires_at);

CREATE TABLE password_resets (
    token_hash bytea NOT NULL,
    user_id uuid NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT password_resets_token_hash_check CHECK ((length(token_hash) = 32))
);

ALTER TABLE ONLY password_resets ADD CONSTRAINT password_resets_pkey PRIMARY KEY (token_hash);
CREATE INDEX password_resets_expires ON password_resets USING btree (expires_at);
CREATE INDEX password_resets_user ON password_resets USING btree (user_id);

CREATE TABLE invite_codes (
    code text NOT NULL,
    user_id uuid NOT NULL,
    uses integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invite_codes_code_check CHECK ((code ~ '^[a-z2-9]{8,32}$'::text)),
    CONSTRAINT invite_codes_uses_check CHECK ((uses >= 0))
);

ALTER TABLE ONLY invite_codes ADD CONSTRAINT invite_codes_pkey PRIMARY KEY (code);
CREATE INDEX invite_codes_user ON invite_codes USING btree (user_id, created_at);

CREATE TABLE user_notices (
    user_id uuid NOT NULL,
    kind text NOT NULL,
    key text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_notices_kind_check CHECK ((kind = ANY (ARRAY['expiry_soon'::text, 'expired'::text, 'quota_80'::text, 'quota_100'::text])))
);

ALTER TABLE ONLY user_notices ADD CONSTRAINT user_notices_pkey PRIMARY KEY (user_id, kind);

-- =========================================================================
-- Access (who may use which node) and live traffic
-- =========================================================================

CREATE TABLE node_users (
    node_id uuid NOT NULL,
    user_id uuid NOT NULL,
    credentials jsonb NOT NULL,
    manual boolean DEFAULT true NOT NULL,
    CONSTRAINT node_users_credentials_array CHECK ((jsonb_typeof(credentials) = 'array'::text))
);

ALTER TABLE ONLY node_users ADD CONSTRAINT node_users_pkey PRIMARY KEY (node_id, user_id);
CREATE INDEX idx_node_users_user ON node_users USING btree (user_id);

CREATE TABLE node_users_departed (
    node_id uuid NOT NULL,
    user_id uuid NOT NULL,
    departed_at timestamp with time zone DEFAULT now() NOT NULL,
    billed_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT node_users_departed_billed_nonneg CHECK ((billed_bytes >= 0))
);

ALTER TABLE ONLY node_users_departed ADD CONSTRAINT node_users_departed_pkey PRIMARY KEY (node_id, user_id);
CREATE INDEX node_users_departed_at ON node_users_departed USING btree (departed_at);

CREATE TABLE traffic_counters (
    node_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id text NOT NULL,
    up_bytes bigint NOT NULL,
    down_bytes bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    first_seen_at timestamp with time zone,
    CONSTRAINT traffic_counters_nonneg CHECK (((up_bytes >= 0) AND (down_bytes >= 0)))
)
WITH (fillfactor='80');

ALTER TABLE ONLY traffic_counters ADD CONSTRAINT traffic_counters_pkey PRIMARY KEY (node_id, user_id, session_id);

CREATE TABLE traffic_sessions (
    node_id uuid NOT NULL,
    session_id text NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    retired_at timestamp with time zone,
    purged_at timestamp with time zone
);

ALTER TABLE ONLY traffic_sessions ADD CONSTRAINT traffic_sessions_pkey PRIMARY KEY (node_id, session_id);

-- =========================================================================
-- Traffic history
-- =========================================================================

CREATE TABLE traffic_daily_pending (
    day date NOT NULL,
    user_id uuid NOT NULL,
    node_id uuid NOT NULL,
    up_bytes bigint NOT NULL,
    down_bytes bigint NOT NULL,
    billed_bytes bigint NOT NULL,
    CONSTRAINT traffic_daily_pending_billed_bytes_check CHECK ((billed_bytes >= 0)),
    CONSTRAINT traffic_daily_pending_down_bytes_check CHECK ((down_bytes >= 0)),
    CONSTRAINT traffic_daily_pending_up_bytes_check CHECK ((up_bytes >= 0))
)
WITH (autovacuum_vacuum_scale_factor='0', autovacuum_vacuum_threshold='20000');

CREATE TABLE traffic_daily (
    user_id uuid NOT NULL,
    day date NOT NULL,
    node_id uuid NOT NULL,
    up_bytes bigint DEFAULT 0 NOT NULL,
    down_bytes bigint DEFAULT 0 NOT NULL,
    billed_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT traffic_daily_billed_bytes_check CHECK ((billed_bytes >= 0)),
    CONSTRAINT traffic_daily_down_bytes_check CHECK ((down_bytes >= 0)),
    CONSTRAINT traffic_daily_up_bytes_check CHECK ((up_bytes >= 0))
)
WITH (fillfactor='80');

ALTER TABLE ONLY traffic_daily ADD CONSTRAINT traffic_daily_pkey PRIMARY KEY (user_id, day, node_id);
CREATE INDEX traffic_daily_day ON traffic_daily USING brin (day);
CREATE INDEX traffic_daily_node_cov ON traffic_daily USING btree (node_id, day) INCLUDE (user_id, up_bytes, down_bytes, billed_bytes);

CREATE TABLE traffic_node_daily (
    node_id uuid NOT NULL,
    day date NOT NULL,
    up_bytes bigint DEFAULT 0 NOT NULL,
    down_bytes bigint DEFAULT 0 NOT NULL,
    billed_bytes bigint DEFAULT 0 NOT NULL,
    users integer DEFAULT 0 NOT NULL,
    CONSTRAINT traffic_node_daily_billed_bytes_check CHECK ((billed_bytes >= 0)),
    CONSTRAINT traffic_node_daily_down_bytes_check CHECK ((down_bytes >= 0)),
    CONSTRAINT traffic_node_daily_up_bytes_check CHECK ((up_bytes >= 0)),
    CONSTRAINT traffic_node_daily_users_check CHECK ((users >= 0))
)
WITH (fillfactor='70');

ALTER TABLE ONLY traffic_node_daily ADD CONSTRAINT traffic_node_daily_pkey PRIMARY KEY (node_id, day);
CREATE INDEX traffic_node_daily_day ON traffic_node_daily USING btree (day);

CREATE TABLE traffic_monthly (
    user_id uuid NOT NULL,
    month date NOT NULL,
    node_id uuid NOT NULL,
    up_bytes bigint DEFAULT 0 NOT NULL,
    down_bytes bigint DEFAULT 0 NOT NULL,
    billed_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT traffic_monthly_billed_bytes_check CHECK ((billed_bytes >= 0)),
    CONSTRAINT traffic_monthly_down_bytes_check CHECK ((down_bytes >= 0)),
    CONSTRAINT traffic_monthly_month_check CHECK ((EXTRACT(day FROM month) = (1)::numeric)),
    CONSTRAINT traffic_monthly_up_bytes_check CHECK ((up_bytes >= 0))
);

ALTER TABLE ONLY traffic_monthly ADD CONSTRAINT traffic_monthly_pkey PRIMARY KEY (user_id, month, node_id);
CREATE INDEX traffic_monthly_node ON traffic_monthly USING btree (node_id, month);

-- =========================================================================
-- Plans and subscriptions
-- =========================================================================

CREATE TABLE plans (
    id uuid NOT NULL,
    name text NOT NULL,
    traffic_quota_bytes bigint,
    reset_period text NOT NULL,
    reset_days integer,
    speed_limit_mbps integer,
    device_seats integer,
    sort integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    on_sale boolean DEFAULT false NOT NULL,
    capacity integer,
    renewal_only boolean DEFAULT false NOT NULL,
    allow_switch_in boolean DEFAULT true NOT NULL,
    CONSTRAINT plans_capacity_check CHECK ((capacity >= 0)),
    CONSTRAINT plans_reset_days_iff_days CHECK (((reset_period = 'days'::text) = (reset_days IS NOT NULL))),
    CONSTRAINT plans_description_check CHECK ((char_length(description) <= 4000)),
    CONSTRAINT plans_device_seats_check CHECK ((device_seats >= 0)),
    CONSTRAINT plans_reset_days_check CHECK ((reset_days BETWEEN 1 AND 3650)),
    CONSTRAINT plans_reset_period_check CHECK ((reset_period = ANY (ARRAY['monthly'::text, 'days'::text, 'none'::text]))),
    CONSTRAINT plans_speed_limit_mbps_check CHECK ((speed_limit_mbps > 0)),
    CONSTRAINT plans_traffic_quota_bytes_check CHECK ((traffic_quota_bytes >= 0))
);

ALTER TABLE ONLY plans ADD CONSTRAINT plans_name_key UNIQUE (name);
ALTER TABLE ONLY plans ADD CONSTRAINT plans_pkey PRIMARY KEY (id);

CREATE TABLE plan_groups (
    plan_id uuid NOT NULL,
    group_id uuid NOT NULL
);

ALTER TABLE ONLY plan_groups ADD CONSTRAINT plan_groups_pkey PRIMARY KEY (plan_id, group_id);
CREATE INDEX plan_groups_group ON plan_groups USING btree (group_id);

CREATE TABLE plan_period_prices (
    plan_id uuid NOT NULL,
    period text NOT NULL,
    days integer,
    price_cents bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plan_period_prices_days_required CHECK (((period <> 'days'::text) OR (days IS NOT NULL))),
    CONSTRAINT plan_period_prices_days_allowed CHECK (((period = ANY (ARRAY['days'::text, 'onetime'::text])) OR (days IS NULL))),
    CONSTRAINT plan_period_prices_days_check CHECK ((days BETWEEN 1 AND 3650)),
    CONSTRAINT plan_period_prices_period_check CHECK ((period = ANY (ARRAY['month'::text, 'quarter'::text, 'half_year'::text, 'year'::text, 'two_year'::text, 'three_year'::text, 'days'::text, 'onetime'::text, 'reset'::text]))),
    CONSTRAINT plan_period_prices_price_cents_check CHECK ((price_cents BETWEEN 1 AND 100000000))
);

ALTER TABLE ONLY plan_period_prices ADD CONSTRAINT plan_period_prices_pkey PRIMARY KEY (plan_id, period);

CREATE TABLE user_plans (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    status user_plan_status DEFAULT 'active'::user_plan_status NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    period_anchor timestamp with time zone NOT NULL,
    last_reset_at timestamp with time zone,
    next_reset_at timestamp with time zone,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_plans_active_iff_open CHECK (((status = 'active'::user_plan_status) = (ended_at IS NULL)))
);

ALTER TABLE ONLY user_plans ADD CONSTRAINT user_plans_pkey PRIMARY KEY (id);
CREATE INDEX user_plans_expiry ON user_plans USING btree (expires_at) WHERE ((status = 'active'::user_plan_status) AND (expires_at IS NOT NULL));
CREATE INDEX user_plans_next_reset ON user_plans USING btree (next_reset_at) WHERE ((status = 'active'::user_plan_status) AND (next_reset_at IS NOT NULL));
CREATE UNIQUE INDEX user_plans_one_active ON user_plans USING btree (user_id) WHERE (status = 'active'::user_plan_status);
CREATE INDEX user_plans_plan_active ON user_plans USING btree (plan_id) WHERE (status = 'active'::user_plan_status);
CREATE INDEX user_plans_user ON user_plans USING btree (user_id, created_at);

-- =========================================================================
-- Payments, orders, coupons
-- =========================================================================

CREATE TABLE payment_methods (
    id uuid NOT NULL,
    kind text NOT NULL,
    display_name text NOT NULL,
    icon text,
    sort integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    secrets_enc bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_methods_config_check CHECK ((jsonb_typeof(config) = 'object'::text)),
    CONSTRAINT payment_methods_display_name_check CHECK ((length(display_name) BETWEEN 1 AND 64)),
    CONSTRAINT payment_methods_enabled_has_secrets CHECK (((NOT enabled) OR (secrets_enc IS NOT NULL))),
    CONSTRAINT payment_methods_icon_check CHECK ((icon ~ '^[a-z0-9_-]{1,32}$'::text)),
    CONSTRAINT payment_methods_kind_check CHECK ((kind = 'alipay_f2f'::text)),
    CONSTRAINT payment_methods_sort_check CHECK ((sort BETWEEN '-1000000'::integer AND 1000000)),
    CONSTRAINT payment_methods_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY payment_methods ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);
CREATE INDEX payment_methods_order ON payment_methods USING btree (sort, created_at);
CREATE TRIGGER payment_methods_notify AFTER INSERT OR DELETE OR UPDATE ON payment_methods FOR EACH STATEMENT EXECUTE FUNCTION akari_settings_notify();

CREATE TABLE orders (
    id uuid NOT NULL,
    out_trade_no text NOT NULL,
    user_id uuid,
    user_login text NOT NULL,
    plan_id uuid,
    plan_name text NOT NULL,
    amount_cents bigint NOT NULL,
    period_days integer,
    subject text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    qr_code text,
    trade_no text,
    paid_via text,
    paid_amount_cents bigint,
    manual_reason text,
    fulfilled_at timestamp with time zone,
    fulfil_result jsonb,
    fulfil_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    paid_at timestamp with time zone,
    ended_at timestamp with time zone,
    close_state text,
    last_query_at timestamp with time zone,
    period text NOT NULL,
    list_price_cents bigint NOT NULL,
    credit_cents bigint DEFAULT 0 NOT NULL,
    credit_order_id uuid,
    discount_cents bigint DEFAULT 0 NOT NULL,
    coupon_id uuid,
    coupon_code text,
    balance_cents bigint DEFAULT 0 NOT NULL,
    balance_state text DEFAULT 'none'::text NOT NULL,
    refunded_at timestamp with time zone,
    refund_cents bigint,
    refund_reason text,
    payment_method_id uuid,
    pay_url text,
    gift_cents bigint DEFAULT 0 NOT NULL,
    CONSTRAINT orders_amount_cents_check CHECK (((amount_cents >= 0) AND (amount_cents = ((((list_price_cents - credit_cents) - discount_cents) - balance_cents) - gift_cents)) AND ((amount_cents > 0) OR ((((credit_cents + discount_cents) + balance_cents) + gift_cents) > 0)))),
    CONSTRAINT orders_balance_cents_check CHECK ((balance_cents >= 0)),
    CONSTRAINT orders_balance_state CHECK (((balance_cents = 0) = (balance_state = 'none'::text))),
    CONSTRAINT orders_balance_state_check CHECK ((balance_state = ANY (ARRAY['none'::text, 'held'::text, 'refunded'::text]))),
    CONSTRAINT orders_paid_at CHECK (((status = 'paid'::text) = (paid_at IS NOT NULL))),
    CONSTRAINT orders_paid_via CHECK (((status <> 'paid'::text) OR (paid_via IS NOT NULL))),
    CONSTRAINT orders_ended_at CHECK (((status = ANY (ARRAY['expired'::text, 'cancelled'::text])) = (ended_at IS NOT NULL))),
    CONSTRAINT orders_fulfilled_paid CHECK (((fulfilled_at IS NULL) OR (status = 'paid'::text))),
    CONSTRAINT orders_coupon CHECK (((discount_cents > 0) <= (coupon_code IS NOT NULL))),
    CONSTRAINT orders_credit_cents_check CHECK ((credit_cents >= 0)),
    CONSTRAINT orders_discount_cents_check CHECK ((discount_cents >= 0)),
    CONSTRAINT orders_gift_cents_check CHECK ((gift_cents >= 0)),
    CONSTRAINT orders_list_price_cents_check CHECK ((list_price_cents > 0)),
    CONSTRAINT orders_out_trade_no_check CHECK ((out_trade_no ~ '^[A-Za-z0-9_]{1,64}$'::text)),
    CONSTRAINT orders_paid_via_check CHECK ((paid_via = ANY (ARRAY['notify'::text, 'query'::text, 'manual'::text, 'credit'::text, 'balance'::text, 'coupon'::text]))),
    CONSTRAINT orders_pay_url_check CHECK ((length(pay_url) <= 2048)),
    CONSTRAINT orders_period_check CHECK ((period = ANY (ARRAY['month'::text, 'quarter'::text, 'half_year'::text, 'year'::text, 'two_year'::text, 'three_year'::text, 'days'::text, 'onetime'::text, 'reset'::text]))),
    CONSTRAINT orders_period_days_check CHECK ((period_days BETWEEN 1 AND 3650)),
    CONSTRAINT orders_period_days_kind CHECK ((((period = 'days'::text) <= (period_days IS NOT NULL)) AND ((period = ANY (ARRAY['days'::text, 'onetime'::text])) OR (period_days IS NULL)))),
    CONSTRAINT orders_refund CHECK ((((refunded_at IS NULL) = (refund_cents IS NULL)) AND ((refunded_at IS NULL) OR (status = 'paid'::text)))),
    CONSTRAINT orders_refund_cents_check CHECK ((refund_cents >= 0)),
    CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'expired'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY orders ADD CONSTRAINT orders_out_trade_no_key UNIQUE (out_trade_no);
ALTER TABLE ONLY orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
CREATE INDEX orders_created ON orders USING btree (created_at DESC, id DESC);
CREATE UNIQUE INDEX orders_one_pending ON orders USING btree (user_id) WHERE (status = 'pending'::text);
CREATE INDEX orders_paid_at ON orders USING btree (paid_at) INCLUDE (amount_cents) WHERE (status = 'paid'::text);
CREATE INDEX orders_paid_via_paid_at ON orders USING btree (paid_via, paid_at) WHERE (status = 'paid'::text);
CREATE INDEX orders_pending ON orders USING btree (expires_at) WHERE (status = 'pending'::text);
CREATE INDEX orders_refunded_at ON orders USING btree (refunded_at) INCLUDE (refund_cents) WHERE (refunded_at IS NOT NULL);
CREATE INDEX orders_unfulfilled ON orders USING btree (paid_at) WHERE ((status = 'paid'::text) AND (fulfilled_at IS NULL));
CREATE INDEX orders_user ON orders USING btree (user_id, created_at DESC);
CREATE INDEX orders_user_plan_paid ON orders USING btree (user_id, plan_id, fulfilled_at DESC) WHERE (status = 'paid'::text);
CREATE INDEX orders_coupon ON orders (coupon_id) WHERE coupon_id IS NOT NULL;
CREATE INDEX orders_payment_method ON orders (payment_method_id) WHERE payment_method_id IS NOT NULL;

CREATE TABLE payment_events (
    id bigint GENERATED ALWAYS AS IDENTITY,
    order_id uuid,
    out_trade_no text,
    source text NOT NULL,
    verified boolean NOT NULL,
    outcome text NOT NULL,
    trade_status text,
    params jsonb,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    payment_method_id uuid,
    CONSTRAINT payment_events_source_check CHECK ((source = ANY (ARRAY['notify'::text, 'query'::text, 'precreate'::text, 'close'::text, 'manual'::text, 'expire'::text])))
);

ALTER TABLE ONLY payment_events ADD CONSTRAINT payment_events_pkey PRIMARY KEY (id);
CREATE INDEX payment_events_created ON payment_events USING btree (created_at);
CREATE INDEX payment_events_order ON payment_events USING btree (order_id, id);

CREATE TABLE coupons (
    id uuid NOT NULL,
    code text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    kind text NOT NULL,
    value bigint NOT NULL,
    plan_ids uuid[],
    periods text[],
    min_amount_cents bigint DEFAULT 0 NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    max_uses integer,
    per_user_limit integer,
    new_users_only boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    used integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    batch_id uuid,
    CONSTRAINT coupons_value_range CHECK ((((kind = 'percent'::text) AND (value BETWEEN 1 AND 100)) OR ((kind = 'fixed'::text) AND (value BETWEEN 1 AND 100000000)))),
    CONSTRAINT coupons_window CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at > starts_at))),
    CONSTRAINT coupons_used_le_max CHECK (((max_uses IS NULL) OR (used <= max_uses))),
    CONSTRAINT coupons_code_check CHECK ((code ~ '^[A-Za-z0-9_-]{3,32}$'::text)),
    CONSTRAINT coupons_kind_check CHECK ((kind = ANY (ARRAY['percent'::text, 'fixed'::text]))),
    CONSTRAINT coupons_max_uses_check CHECK ((max_uses BETWEEN 1 AND 100000000)),
    CONSTRAINT coupons_min_amount_cents_check CHECK ((min_amount_cents BETWEEN 0 AND 100000000)),
    CONSTRAINT coupons_name_check CHECK ((char_length(name) <= 100)),
    CONSTRAINT coupons_per_user_limit_check CHECK ((per_user_limit BETWEEN 1 AND 100000000)),
    CONSTRAINT coupons_periods_check CHECK (((cardinality(periods) BETWEEN 1 AND 9) AND (array_position(periods, NULL::text) IS NULL) AND (periods <@ ARRAY['month'::text, 'quarter'::text, 'half_year'::text, 'year'::text, 'two_year'::text, 'three_year'::text, 'days'::text, 'onetime'::text, 'reset'::text]))),
    CONSTRAINT coupons_plan_ids_check CHECK (((cardinality(plan_ids) BETWEEN 1 AND 200) AND (array_position(plan_ids, NULL::uuid) IS NULL))),
    CONSTRAINT coupons_used_check CHECK ((used >= 0))
);

ALTER TABLE ONLY coupons ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);
CREATE INDEX coupons_batch ON coupons USING btree (batch_id) WHERE (batch_id IS NOT NULL);
CREATE UNIQUE INDEX coupons_code ON coupons USING btree (lower(code));

CREATE TABLE coupon_redemptions (
    order_id uuid NOT NULL,
    coupon_id uuid NOT NULL,
    user_id uuid,
    status text NOT NULL,
    over_limit boolean DEFAULT false NOT NULL,
    discount_cents bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupon_redemptions_over_limit_redeemed CHECK (((NOT over_limit) OR (status = 'redeemed'::text))),
    CONSTRAINT coupon_redemptions_discount_cents_check CHECK ((discount_cents > 0)),
    CONSTRAINT coupon_redemptions_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'redeemed'::text, 'released'::text])))
);

ALTER TABLE ONLY coupon_redemptions ADD CONSTRAINT coupon_redemptions_pkey PRIMARY KEY (order_id);
CREATE INDEX coupon_redemptions_user ON coupon_redemptions USING btree (coupon_id, user_id);
CREATE INDEX coupon_redemptions_user_id ON coupon_redemptions (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE coupon_batches (
    id uuid NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    prefix text NOT NULL,
    count integer NOT NULL,
    template jsonb NOT NULL,
    actor_login text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT coupon_batches_count_check CHECK ((count BETWEEN 1 AND 5000)),
    CONSTRAINT coupon_batches_name_check CHECK ((char_length(name) <= 100)),
    CONSTRAINT coupon_batches_prefix_check CHECK ((prefix ~ '^[A-Za-z0-9_-]{0,16}$'::text))
);

ALTER TABLE ONLY coupon_batches ADD CONSTRAINT coupon_batches_pkey PRIMARY KEY (id);

-- =========================================================================
-- Balance, commissions, withdrawals
-- =========================================================================

CREATE TABLE user_balances (
    user_id uuid NOT NULL,
    balance_cents bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_balances_balance_cents_check CHECK ((balance_cents >= 0))
);

ALTER TABLE ONLY user_balances ADD CONSTRAINT user_balances_pkey PRIMARY KEY (user_id);
CREATE TRIGGER user_balances_guard BEFORE INSERT OR UPDATE ON user_balances FOR EACH ROW EXECUTE FUNCTION akari_balance_guard();

CREATE TABLE balance_ledger (
    id bigint GENERATED ALWAYS AS IDENTITY,
    user_id uuid,
    user_login text NOT NULL,
    kind text NOT NULL,
    amount_cents bigint NOT NULL,
    balance_after_cents bigint DEFAULT 0 NOT NULL,
    order_id uuid,
    commission_id uuid,
    withdrawal_id uuid,
    reason text,
    actor_login text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT balance_ledger_amount_cents_check CHECK (((amount_cents <> 0) AND (amount_cents BETWEEN '-10000000000'::bigint AND '10000000000'::bigint))),
    CONSTRAINT balance_ledger_balance_after_cents_check CHECK ((balance_after_cents >= 0)),
    CONSTRAINT balance_ledger_kind_shape CHECK (
CASE kind
    WHEN 'admin_adjust'::text THEN (reason IS NOT NULL)
    WHEN 'commission'::text THEN ((amount_cents > 0) AND (commission_id IS NOT NULL))
    WHEN 'order_payment'::text THEN ((amount_cents < 0) AND (order_id IS NOT NULL))
    WHEN 'refund_to_balance'::text THEN ((amount_cents > 0) AND (order_id IS NOT NULL))
    WHEN 'withdrawal'::text THEN ((amount_cents < 0) AND (withdrawal_id IS NOT NULL))
    WHEN 'withdrawal_reversal'::text THEN ((amount_cents > 0) AND (withdrawal_id IS NOT NULL))
    ELSE NULL::boolean
END),
    CONSTRAINT balance_ledger_kind_check CHECK ((kind = ANY (ARRAY['commission'::text, 'admin_adjust'::text, 'order_payment'::text, 'refund_to_balance'::text, 'withdrawal'::text, 'withdrawal_reversal'::text]))),
    CONSTRAINT balance_ledger_reason_check CHECK ((char_length(reason) <= 500))
);

ALTER TABLE ONLY balance_ledger ADD CONSTRAINT balance_ledger_pkey PRIMARY KEY (id);
CREATE INDEX balance_ledger_order ON balance_ledger USING btree (order_id) WHERE (order_id IS NOT NULL);
CREATE INDEX balance_ledger_user ON balance_ledger USING btree (user_id, id DESC);
CREATE TRIGGER balance_ledger_append_only BEFORE DELETE OR UPDATE ON balance_ledger FOR EACH ROW EXECUTE FUNCTION akari_ledger_append_only();
CREATE TRIGGER balance_ledger_apply BEFORE INSERT ON balance_ledger FOR EACH ROW EXECUTE FUNCTION akari_ledger_apply();

CREATE TABLE commission_settings (
    id integer DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    rate_percent integer DEFAULT 10 NOT NULL,
    first_order_only boolean DEFAULT true NOT NULL,
    hold_days integer DEFAULT 7 NOT NULL,
    min_withdrawal_cents bigint DEFAULT 10000 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_settings_hold_days_check CHECK ((hold_days BETWEEN 0 AND 365)),
    CONSTRAINT commission_settings_id_check CHECK ((id = 1)),
    CONSTRAINT commission_settings_min_withdrawal_cents_check CHECK ((min_withdrawal_cents BETWEEN 1 AND 100000000)),
    CONSTRAINT commission_settings_rate_percent_check CHECK ((rate_percent BETWEEN 0 AND 100))
);

ALTER TABLE ONLY commission_settings ADD CONSTRAINT commission_settings_pkey PRIMARY KEY (id);

CREATE TABLE commissions (
    id uuid NOT NULL,
    order_id uuid NOT NULL,
    inviter_id uuid,
    inviter_login text NOT NULL,
    invitee_id uuid,
    invitee_login text NOT NULL,
    base_cents bigint NOT NULL,
    rate_percent integer NOT NULL,
    amount_cents bigint NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone NOT NULL,
    credited_at timestamp with time zone,
    ledger_id bigint,
    reversed_at timestamp with time zone,
    reverse_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commissions_base_cents_check CHECK ((base_cents > 0)),
    CONSTRAINT commissions_amount_le_base CHECK (((amount_cents > 0) AND (amount_cents <= base_cents))),
    CONSTRAINT commissions_credited_state CHECK (((status = 'credited'::text) = ((credited_at IS NOT NULL) AND (ledger_id IS NOT NULL)))),
    CONSTRAINT commissions_reversed_state CHECK (((status = 'reversed'::text) = (reversed_at IS NOT NULL))),
    CONSTRAINT commissions_amount_rate CHECK ((amount_cents = ((base_cents * rate_percent) / 100))),
    CONSTRAINT commissions_rate_percent_check CHECK ((rate_percent BETWEEN 1 AND 100)),
    CONSTRAINT commissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'credited'::text, 'reversed'::text])))
);

ALTER TABLE ONLY commissions ADD CONSTRAINT commissions_order_id_key UNIQUE (order_id);
ALTER TABLE ONLY commissions ADD CONSTRAINT commissions_pkey PRIMARY KEY (id);
CREATE INDEX commissions_due ON commissions USING btree (available_at) WHERE (status = 'pending'::text);
CREATE INDEX commissions_inviter ON commissions USING btree (inviter_id, created_at DESC);
CREATE INDEX commissions_invitee ON commissions (invitee_id) WHERE invitee_id IS NOT NULL;

CREATE TABLE withdrawals (
    id uuid NOT NULL,
    user_id uuid,
    user_login text NOT NULL,
    amount_cents bigint NOT NULL,
    method text NOT NULL,
    account text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payout_reference text,
    note text,
    decided_at timestamp with time zone,
    decided_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT withdrawals_account_check CHECK ((char_length(account) BETWEEN 1 AND 200)),
    CONSTRAINT withdrawals_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT withdrawals_decided_at CHECK (((status = 'pending'::text) = (decided_at IS NULL))),
    CONSTRAINT withdrawals_approved_reference CHECK (((status <> 'approved'::text) OR (payout_reference IS NOT NULL))),
    CONSTRAINT withdrawals_method_check CHECK ((method = ANY (ARRAY['alipay'::text, 'wechat'::text, 'bank'::text, 'other'::text]))),
    CONSTRAINT withdrawals_note_check CHECK ((char_length(note) <= 500)),
    CONSTRAINT withdrawals_payout_reference_check CHECK ((char_length(payout_reference) <= 200)),
    CONSTRAINT withdrawals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY withdrawals ADD CONSTRAINT withdrawals_pkey PRIMARY KEY (id);
CREATE INDEX withdrawals_created ON withdrawals USING btree (created_at DESC, id DESC);
CREATE UNIQUE INDEX withdrawals_one_pending ON withdrawals USING btree (user_id) WHERE (status = 'pending'::text);
CREATE INDEX withdrawals_user ON withdrawals (user_id) WHERE user_id IS NOT NULL;

-- =========================================================================
-- Node monitoring and alerts
-- =========================================================================

CREATE TABLE node_metrics_1m (
    node_id uuid NOT NULL,
    bucket timestamp with time zone NOT NULL,
    samples integer NOT NULL,
    cpu_sum double precision,
    cpu_max real,
    load1_sum double precision,
    mem_used_sum double precision,
    mem_total bigint,
    swap_used_sum double precision,
    swap_total bigint,
    disk_used bigint,
    disk_total bigint,
    rx_bps_sum double precision,
    tx_bps_sum double precision,
    rx_bps_max bigint,
    tx_bps_max bigint,
    tcp_sum double precision,
    udp_sum double precision,
    conns_sum double precision DEFAULT 0 NOT NULL,
    conns_max bigint DEFAULT 0 NOT NULL,
    users_sum double precision DEFAULT 0 NOT NULL,
    users_max bigint DEFAULT 0 NOT NULL,
    CONSTRAINT node_metrics_1m_samples_check CHECK ((samples > 0))
)
WITH (fillfactor='70');

ALTER TABLE ONLY node_metrics_1m ADD CONSTRAINT node_metrics_1m_pkey PRIMARY KEY (node_id, bucket);
CREATE INDEX node_metrics_1m_bucket ON node_metrics_1m USING btree (bucket);

CREATE TABLE node_metrics_1h (
    node_id uuid CONSTRAINT node_metrics_1m_node_id_not_null NOT NULL,
    bucket timestamp with time zone CONSTRAINT node_metrics_1m_bucket_not_null NOT NULL,
    samples integer CONSTRAINT node_metrics_1m_samples_not_null NOT NULL,
    cpu_sum double precision,
    cpu_max real,
    load1_sum double precision,
    mem_used_sum double precision,
    mem_total bigint,
    swap_used_sum double precision,
    swap_total bigint,
    disk_used bigint,
    disk_total bigint,
    rx_bps_sum double precision,
    tx_bps_sum double precision,
    rx_bps_max bigint,
    tx_bps_max bigint,
    tcp_sum double precision,
    udp_sum double precision,
    conns_sum double precision DEFAULT 0 CONSTRAINT node_metrics_1m_conns_sum_not_null NOT NULL,
    conns_max bigint DEFAULT 0 CONSTRAINT node_metrics_1m_conns_max_not_null NOT NULL,
    users_sum double precision DEFAULT 0 CONSTRAINT node_metrics_1m_users_sum_not_null NOT NULL,
    users_max bigint DEFAULT 0 CONSTRAINT node_metrics_1m_users_max_not_null NOT NULL,
    CONSTRAINT node_metrics_1m_samples_check CHECK ((samples > 0))
);

ALTER TABLE ONLY node_metrics_1h ADD CONSTRAINT node_metrics_1h_pkey PRIMARY KEY (node_id, bucket);
CREATE INDEX node_metrics_1h_bucket ON node_metrics_1h USING btree (bucket);

CREATE TABLE node_latency (
    node_id uuid NOT NULL,
    source text NOT NULL,
    target text NOT NULL,
    delay_ms integer,
    error text,
    ord smallint DEFAULT 0 NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    CONSTRAINT node_latency_delay_ms_check CHECK (((delay_ms IS NULL) OR (delay_ms >= 0))),
    CONSTRAINT node_latency_error_check CHECK (((error IS NULL) OR (char_length(error) <= 200))),
    CONSTRAINT node_latency_source_check CHECK ((source = ANY (ARRAY['agent'::text, 'panel'::text]))),
    CONSTRAINT node_latency_target_check CHECK ((char_length(target) BETWEEN 1 AND 512))
);

ALTER TABLE ONLY node_latency ADD CONSTRAINT node_latency_pkey PRIMARY KEY (node_id, source, target);

CREATE TABLE alert_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    offline_secs integer DEFAULT 300,
    cpu_percent integer DEFAULT 90,
    cpu_minutes integer DEFAULT 5 NOT NULL,
    mem_percent integer DEFAULT 90,
    mem_minutes integer DEFAULT 5 NOT NULL,
    disk_percent integer DEFAULT 90,
    cert_days integer DEFAULT 14,
    latency_failures boolean DEFAULT true NOT NULL,
    last_error boolean DEFAULT true NOT NULL,
    cooldown_minutes integer DEFAULT 30 NOT NULL,
    notify_resolved boolean DEFAULT true NOT NULL,
    telegram_enabled boolean DEFAULT false NOT NULL,
    telegram_chat_id text,
    telegram_token_enc bytea,
    webhook_enabled boolean DEFAULT false NOT NULL,
    webhook_url text,
    webhook_secret_enc bytea,
    email_enabled boolean DEFAULT false NOT NULL,
    email_to text[] DEFAULT '{}'::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    telegram_api_url text,
    CONSTRAINT alert_settings_cert_days_check CHECK ((cert_days BETWEEN 1 AND 90)),
    CONSTRAINT alert_settings_telegram_complete CHECK (((NOT telegram_enabled) OR ((telegram_chat_id IS NOT NULL) AND (telegram_token_enc IS NOT NULL)))),
    CONSTRAINT alert_settings_webhook_complete CHECK (((NOT webhook_enabled) OR ((webhook_url IS NOT NULL) AND (webhook_secret_enc IS NOT NULL)))),
    CONSTRAINT alert_settings_email_recipients CHECK (((NOT email_enabled) OR (cardinality(email_to) > 0))),
    CONSTRAINT alert_settings_cooldown_minutes_check CHECK ((cooldown_minutes BETWEEN 0 AND 1440)),
    CONSTRAINT alert_settings_cpu_minutes_check CHECK ((cpu_minutes BETWEEN 1 AND 60)),
    CONSTRAINT alert_settings_cpu_percent_check CHECK ((cpu_percent BETWEEN 1 AND 100)),
    CONSTRAINT alert_settings_disk_percent_check CHECK ((disk_percent BETWEEN 1 AND 100)),
    CONSTRAINT alert_settings_email_to_check CHECK (((cardinality(email_to) <= 5) AND (array_position(email_to, NULL::text) IS NULL))),
    CONSTRAINT alert_settings_id_check CHECK ((id = 1)),
    CONSTRAINT alert_settings_mem_minutes_check CHECK ((mem_minutes BETWEEN 1 AND 60)),
    CONSTRAINT alert_settings_mem_percent_check CHECK ((mem_percent BETWEEN 1 AND 100)),
    CONSTRAINT alert_settings_offline_secs_check CHECK ((offline_secs BETWEEN 30 AND 86400)),
    CONSTRAINT alert_settings_telegram_api_url_check CHECK ((length(telegram_api_url) BETWEEN 9 AND 2048)),
    CONSTRAINT alert_settings_telegram_chat_id_check CHECK ((char_length(telegram_chat_id) BETWEEN 1 AND 64)),
    CONSTRAINT alert_settings_webhook_url_check CHECK ((char_length(webhook_url) BETWEEN 1 AND 512))
);

ALTER TABLE ONLY alert_settings ADD CONSTRAINT alert_settings_pkey PRIMARY KEY (id);

CREATE TABLE node_alert_rules (
    node_id uuid NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    disabled text[] DEFAULT '{}'::text[] NOT NULL,
    offline_secs integer,
    cpu_percent integer,
    cpu_minutes integer,
    mem_percent integer,
    mem_minutes integer,
    disk_percent integer,
    cert_days integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT node_alert_rules_cert_days_check CHECK ((cert_days BETWEEN 1 AND 90)),
    CONSTRAINT node_alert_rules_cpu_minutes_check CHECK ((cpu_minutes BETWEEN 1 AND 60)),
    CONSTRAINT node_alert_rules_cpu_percent_check CHECK ((cpu_percent BETWEEN 1 AND 100)),
    CONSTRAINT node_alert_rules_disabled_check CHECK (((cardinality(disabled) <= 16) AND (array_position(disabled, NULL::text) IS NULL))),
    CONSTRAINT node_alert_rules_disk_percent_check CHECK ((disk_percent BETWEEN 1 AND 100)),
    CONSTRAINT node_alert_rules_mem_minutes_check CHECK ((mem_minutes BETWEEN 1 AND 60)),
    CONSTRAINT node_alert_rules_mem_percent_check CHECK ((mem_percent BETWEEN 1 AND 100)),
    CONSTRAINT node_alert_rules_offline_secs_check CHECK ((offline_secs BETWEEN 30 AND 86400))
);

ALTER TABLE ONLY node_alert_rules ADD CONSTRAINT node_alert_rules_pkey PRIMARY KEY (node_id);

CREATE TABLE node_alerts (
    id bigint GENERATED ALWAYS AS IDENTITY,
    node_id uuid NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    fired_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    value text DEFAULT ''::text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    notified boolean DEFAULT false NOT NULL,
    acked_at timestamp with time zone,
    acked_by text,
    CONSTRAINT node_alerts_resolved_at CHECK (((status = 'resolved'::text) = (resolved_at IS NOT NULL))),
    CONSTRAINT node_alerts_acked_pair CHECK (((acked_at IS NULL) = (acked_by IS NULL))),
    CONSTRAINT node_alerts_detail_check CHECK ((char_length(detail) <= 600)),
    CONSTRAINT node_alerts_kind_check CHECK ((kind = ANY (ARRAY['offline'::text, 'cpu'::text, 'memory'::text, 'disk'::text, 'latency'::text, 'cert'::text, 'agent_cert'::text, 'last_error'::text]))),
    CONSTRAINT node_alerts_status_check CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text]))),
    CONSTRAINT node_alerts_value_check CHECK ((char_length(value) <= 200))
);

ALTER TABLE ONLY node_alerts ADD CONSTRAINT node_alerts_pkey PRIMARY KEY (id);
CREATE INDEX node_alerts_last ON node_alerts USING btree (node_id, kind, fired_at DESC);
CREATE UNIQUE INDEX node_alerts_one_firing ON node_alerts USING btree (node_id, kind) WHERE (status = 'firing'::text);
CREATE INDEX node_alerts_resolved ON node_alerts USING btree (resolved_at) WHERE (status = 'resolved'::text);

CREATE TABLE alert_notifications (
    id bigint GENERATED ALWAYS AS IDENTITY,
    alert_id bigint,
    channel text NOT NULL,
    event text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_until timestamp with time zone,
    claim uuid,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT alert_notifications_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT alert_notifications_channel_check CHECK ((channel = ANY (ARRAY['telegram'::text, 'webhook'::text, 'email'::text]))),
    CONSTRAINT alert_notifications_sent_at CHECK (((status = 'sent'::text) = (sent_at IS NOT NULL))),
    CONSTRAINT alert_notifications_event_check CHECK ((event = ANY (ARRAY['firing'::text, 'resolved'::text]))),
    CONSTRAINT alert_notifications_last_error_check CHECK ((char_length(last_error) <= 300)),
    CONSTRAINT alert_notifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'dead'::text])))
);

ALTER TABLE ONLY alert_notifications ADD CONSTRAINT alert_notifications_pkey PRIMARY KEY (id);
CREATE INDEX alert_notifications_due ON alert_notifications USING btree (next_attempt_at, id) WHERE (status = 'pending'::text);
CREATE INDEX alert_notifications_recent ON alert_notifications USING btree (created_at DESC, id DESC);
CREATE INDEX alert_notifications_alert ON alert_notifications (alert_id);

-- =========================================================================
-- Agent releases and rollouts
-- =========================================================================

CREATE TABLE agent_releases (
    id uuid NOT NULL,
    version text NOT NULL,
    os text NOT NULL,
    arch text NOT NULL,
    sha256 text NOT NULL,
    size bigint NOT NULL,
    manifest bytea NOT NULL,
    signatures jsonb NOT NULL,
    key_id text NOT NULL,
    min_panel_protocol integer NOT NULL,
    rollback boolean DEFAULT false NOT NULL,
    complete_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_releases_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agent_releases_size_check CHECK ((size > 0))
);

ALTER TABLE ONLY agent_releases ADD CONSTRAINT agent_releases_pkey PRIMARY KEY (id);
ALTER TABLE ONLY agent_releases ADD CONSTRAINT agent_releases_sha256_key UNIQUE (sha256);
ALTER TABLE ONLY agent_releases ADD CONSTRAINT agent_releases_version_os_arch_key UNIQUE (version, os, arch);

CREATE TABLE agent_release_chunks (
    release_id uuid NOT NULL,
    idx integer NOT NULL,
    data bytea NOT NULL,
    CONSTRAINT agent_release_chunks_idx_check CHECK ((idx >= 0))
);

ALTER TABLE ONLY agent_release_chunks ADD CONSTRAINT agent_release_chunks_pkey PRIMARY KEY (release_id, idx);

CREATE TABLE rollouts (
    id uuid NOT NULL,
    version text NOT NULL,
    status text NOT NULL,
    waves integer[] NOT NULL,
    percentage integer NOT NULL,
    explicit_nodes boolean NOT NULL,
    current_wave integer DEFAULT 0 NOT NULL,
    wave_started_at timestamp with time zone DEFAULT now() NOT NULL,
    health_timeout_secs integer NOT NULL,
    max_failure_ratio double precision NOT NULL,
    seed bigint NOT NULL,
    halted_reason text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT rollouts_current_wave_check CHECK ((current_wave >= 0)),
    CONSTRAINT rollouts_health_timeout_secs_check CHECK ((health_timeout_secs BETWEEN 30 AND 86400)),
    CONSTRAINT rollouts_max_failure_ratio_check CHECK ((max_failure_ratio BETWEEN (0)::double precision AND (1)::double precision)),
    CONSTRAINT rollouts_percentage_check CHECK ((percentage BETWEEN 1 AND 100)),
    CONSTRAINT rollouts_status_check CHECK ((status = ANY (ARRAY['running'::text, 'paused'::text, 'halted'::text, 'aborted'::text, 'completed'::text]))),
    CONSTRAINT rollouts_waves_check CHECK ((cardinality(waves) BETWEEN 1 AND 10))
);

ALTER TABLE ONLY rollouts ADD CONSTRAINT rollouts_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX rollouts_one_open ON rollouts USING btree ((true)) WHERE (status = ANY (ARRAY['running'::text, 'paused'::text, 'halted'::text]));

CREATE TABLE rollout_nodes (
    rollout_id uuid NOT NULL,
    node_id uuid NOT NULL,
    wave integer NOT NULL,
    "position" integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    from_version text,
    offered_at timestamp with time zone,
    finished_at timestamp with time zone,
    detail text,
    CONSTRAINT rollout_nodes_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'offered'::text, 'updating'::text, 'healthy'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT rollout_nodes_wave_check CHECK ((wave >= 0))
);

ALTER TABLE ONLY rollout_nodes ADD CONSTRAINT rollout_nodes_pkey PRIMARY KEY (rollout_id, node_id);
CREATE INDEX rollout_nodes_node ON rollout_nodes USING btree (node_id);

CREATE TABLE agent_update_settings (
    id boolean DEFAULT true NOT NULL,
    source_url text,
    auto_check boolean DEFAULT false NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    next_auto_check_at timestamp with time zone,
    check_started_at timestamp with time zone,
    last_check_at timestamp with time zone,
    last_check_ok boolean,
    last_check_result text,
    last_check_version text,
    last_check_code text,
    last_check_params jsonb,
    last_check_message text,
    last_check_stored text[],
    CONSTRAINT agent_update_settings_last_check_pair CHECK (((last_check_at IS NULL) = (last_check_result IS NULL))),
    CONSTRAINT agent_update_settings_failed_code CHECK (((last_check_result = 'failed'::text) = (last_check_code IS NOT NULL))),
    CONSTRAINT agent_update_settings_id_check CHECK (id),
    CONSTRAINT agent_update_settings_last_check_result_check CHECK ((last_check_result = ANY (ARRAY['stored'::text, 'up_to_date'::text, 'failed'::text]))),
    CONSTRAINT agent_update_settings_source_url_check CHECK (((source_url IS NULL) OR (length(source_url) BETWEEN 8 AND 512)))
);

ALTER TABLE ONLY agent_update_settings ADD CONSTRAINT agent_update_settings_pkey PRIMARY KEY (id);

-- =========================================================================
-- Site settings
-- =========================================================================

CREATE TABLE panel_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    main_domain text,
    sub_domain text,
    node_domain text,
    trust_cloudflare boolean,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    probe_interval_secs integer,
    probe_urls text[],
    probe_panel_tcp boolean,
    site_name text,
    cloudflare_ranges text[],
    install_tls_pin text,
    install_fallback_url text,
    acme_directory_url text,
    acme_email text,
    audit_retention_days integer,
    traffic_daily_retention_days integer,
    require_admin_2fa boolean,
    remove_mode text,
    extra_release_keys text[],
    CONSTRAINT panel_settings_acme_directory_url_check CHECK ((length(acme_directory_url) BETWEEN 9 AND 2048)),
    CONSTRAINT panel_settings_acme_email_check CHECK ((length(acme_email) BETWEEN 3 AND 254)),
    CONSTRAINT panel_settings_audit_retention_days_check CHECK ((audit_retention_days BETWEEN 0 AND 36500)),
    CONSTRAINT panel_settings_cloudflare_ranges_check CHECK (((cardinality(cloudflare_ranges) BETWEEN 1 AND 256) AND (array_position(cloudflare_ranges, NULL::text) IS NULL))),
    CONSTRAINT panel_settings_extra_release_keys_check CHECK (((cardinality(extra_release_keys) BETWEEN 1 AND 16) AND (array_position(extra_release_keys, NULL::text) IS NULL))),
    CONSTRAINT panel_settings_id_check CHECK ((id = 1)),
    CONSTRAINT panel_settings_install_fallback_url_check CHECK ((length(install_fallback_url) <= 2048)),
    CONSTRAINT panel_settings_install_tls_pin_check CHECK ((install_tls_pin ~ '^sha256//[A-Za-z0-9+/]{43}=$'::text)),
    CONSTRAINT panel_settings_probe_interval_secs_check CHECK ((probe_interval_secs BETWEEN 600 AND 604800)),
    CONSTRAINT panel_settings_probe_urls_check CHECK (((cardinality(probe_urls) BETWEEN 1 AND 4) AND (array_position(probe_urls, NULL::text) IS NULL))),
    CONSTRAINT panel_settings_remove_mode_check CHECK ((remove_mode = ANY (ARRAY['gate'::text, 'rebuild'::text]))),
    CONSTRAINT panel_settings_site_name_check CHECK (((site_name IS NULL) OR ((length(site_name) BETWEEN 1 AND 64) AND (site_name !~ '[[:cntrl:]]'::text)))),
    CONSTRAINT panel_settings_traffic_daily_retention_days_check CHECK (((traffic_daily_retention_days = 0) OR (traffic_daily_retention_days BETWEEN 32 AND 36500))),
    CONSTRAINT panel_settings_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY panel_settings ADD CONSTRAINT panel_settings_pkey PRIMARY KEY (id);
CREATE TRIGGER panel_settings_notify AFTER INSERT OR DELETE OR UPDATE ON panel_settings FOR EACH STATEMENT EXECUTE FUNCTION akari_settings_notify();

CREATE TABLE signup_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    register_enabled boolean DEFAULT false NOT NULL,
    invite_required boolean DEFAULT false NOT NULL,
    invite_single_use boolean DEFAULT false NOT NULL,
    invite_codes_per_user integer DEFAULT 5 NOT NULL,
    email_domains text[] DEFAULT '{}'::text[] NOT NULL,
    trial_plan_id uuid,
    trial_days integer DEFAULT 1 NOT NULL,
    reset_enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email_verify boolean,
    CONSTRAINT signup_settings_email_domains_check CHECK (((cardinality(email_domains) <= 100) AND (array_position(email_domains, NULL::text) IS NULL))),
    CONSTRAINT signup_settings_id_check CHECK ((id = 1)),
    CONSTRAINT signup_settings_invite_codes_per_user_check CHECK ((invite_codes_per_user BETWEEN 0 AND 100)),
    CONSTRAINT signup_settings_trial_days_check CHECK ((trial_days BETWEEN 1 AND 3650)),
    CONSTRAINT signup_settings_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY signup_settings ADD CONSTRAINT signup_settings_pkey PRIMARY KEY (id);

CREATE TABLE smtp_settings (
    id smallint DEFAULT 1 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    host text,
    port integer DEFAULT 587 NOT NULL,
    security text DEFAULT 'starttls'::text NOT NULL,
    username text,
    password_enc bytea,
    from_addr text,
    from_name text,
    notify_order_paid boolean DEFAULT true NOT NULL,
    notify_expiry_days integer DEFAULT 3 NOT NULL,
    notify_expired boolean DEFAULT true NOT NULL,
    notify_quota boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT smtp_enabled_complete CHECK (((NOT enabled) OR ((host IS NOT NULL) AND (from_addr IS NOT NULL)))),
    CONSTRAINT smtp_plain_no_auth CHECK (((security <> 'none'::text) OR (username IS NULL))),
    CONSTRAINT smtp_settings_from_name_check CHECK ((length(from_name) <= 64)),
    CONSTRAINT smtp_settings_id_check CHECK ((id = 1)),
    CONSTRAINT smtp_settings_notify_expiry_days_check CHECK ((notify_expiry_days BETWEEN 0 AND 30)),
    CONSTRAINT smtp_settings_port_check CHECK ((port BETWEEN 1 AND 65535)),
    CONSTRAINT smtp_settings_security_check CHECK ((security = ANY (ARRAY['starttls'::text, 'tls'::text, 'none'::text]))),
    CONSTRAINT smtp_settings_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY smtp_settings ADD CONSTRAINT smtp_settings_pkey PRIMARY KEY (id);

CREATE TABLE site_branding (
    id smallint NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    logo bytea,
    logo_sha256 bytea,
    favicon bytea,
    favicon_sha256 bytea,
    footer_text text,
    footer_links jsonb DEFAULT '[]'::jsonb NOT NULL,
    tos_url text,
    privacy_url text,
    client_downloads jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_branding_logo_pair CHECK (((logo IS NULL) = (logo_sha256 IS NULL))),
    CONSTRAINT site_branding_favicon_pair CHECK (((favicon IS NULL) = (favicon_sha256 IS NULL))),
    CONSTRAINT site_branding_client_downloads_check CHECK ((jsonb_typeof(client_downloads) = 'array'::text)),
    CONSTRAINT site_branding_favicon_check CHECK (((favicon IS NULL) OR (octet_length(favicon) BETWEEN 8 AND 65536))),
    CONSTRAINT site_branding_footer_links_check CHECK ((jsonb_typeof(footer_links) = 'array'::text)),
    CONSTRAINT site_branding_footer_text_check CHECK (((footer_text IS NULL) OR (char_length(footer_text) BETWEEN 1 AND 500))),
    CONSTRAINT site_branding_id_check CHECK ((id = 1)),
    CONSTRAINT site_branding_logo_check CHECK (((logo IS NULL) OR (octet_length(logo) BETWEEN 8 AND 262144))),
    CONSTRAINT site_branding_privacy_url_check CHECK (((privacy_url IS NULL) OR (char_length(privacy_url) BETWEEN 1 AND 2048))),
    CONSTRAINT site_branding_tos_url_check CHECK (((tos_url IS NULL) OR (char_length(tos_url) BETWEEN 1 AND 2048))),
    CONSTRAINT site_branding_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY site_branding ADD CONSTRAINT site_branding_pkey PRIMARY KEY (id);

CREATE TABLE legacy_config_imports (
    key text NOT NULL,
    outcome text NOT NULL,
    handled_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT legacy_config_imports_outcome_check CHECK ((outcome = ANY (ARRAY['imported'::text, 'kept'::text, 'unusable'::text])))
);

ALTER TABLE ONLY legacy_config_imports ADD CONSTRAINT legacy_config_imports_pkey PRIMARY KEY (key);

-- =========================================================================
-- Mail
-- =========================================================================

CREATE TABLE mail_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY,
    kind text NOT NULL,
    user_id uuid,
    to_addr text NOT NULL,
    subject text NOT NULL,
    body_text text NOT NULL,
    body_html text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_until timestamp with time zone,
    claim_token uuid,
    discard_after timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT mail_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT mail_outbox_settled_at CHECK (((status = 'pending'::text) = (settled_at IS NULL))),
    CONSTRAINT mail_outbox_kind_check CHECK ((kind = ANY (ARRAY['register_code'::text, 'register_exists'::text, 'email_code'::text, 'password_reset'::text, 'order_paid'::text, 'expiry_soon'::text, 'expired'::text, 'quota_80'::text, 'quota_100'::text, 'test'::text, 'ticket_reply'::text, 'ticket_new'::text, 'node_alert'::text, 'announcement'::text, 'admin_notice'::text]))),
    CONSTRAINT mail_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'dead'::text])))
);

ALTER TABLE ONLY mail_outbox ADD CONSTRAINT mail_outbox_pkey PRIMARY KEY (id);
CREATE INDEX mail_outbox_due ON mail_outbox USING btree (next_attempt_at, id) WHERE (status = 'pending'::text);
CREATE INDEX mail_outbox_settled ON mail_outbox USING btree (status, settled_at) WHERE (status <> 'pending'::text);
CREATE INDEX mail_outbox_user ON mail_outbox (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE mail_templates (
    kind text NOT NULL,
    locale text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    CONSTRAINT mail_templates_body_check CHECK ((char_length(body) BETWEEN 1 AND 20000)),
    CONSTRAINT mail_templates_kind_check CHECK ((kind = ANY (ARRAY['register_code'::text, 'register_exists'::text, 'email_code'::text, 'password_reset'::text, 'order_paid'::text, 'expiry_soon'::text, 'expired'::text, 'quota_80'::text, 'quota_100'::text, 'test'::text, 'ticket_reply'::text, 'ticket_new'::text, 'node_alert'::text, 'announcement'::text, 'admin_notice'::text]))),
    CONSTRAINT mail_templates_locale_check CHECK ((locale = ANY (ARRAY['zh'::text, 'en'::text]))),
    CONSTRAINT mail_templates_subject_check CHECK (((char_length(subject) BETWEEN 1 AND 200) AND (subject !~ '[[:cntrl:]]'::text))),
    CONSTRAINT mail_templates_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY mail_templates ADD CONSTRAINT mail_templates_pkey PRIMARY KEY (kind, locale);

-- =========================================================================
-- Tickets, announcements, knowledge base
-- =========================================================================

CREATE TABLE tickets (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    subject text NOT NULL,
    category text NOT NULL,
    priority text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    order_id uuid,
    node_id uuid,
    assignee_id uuid,
    messages integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_user_at timestamp with time zone,
    last_staff_at timestamp with time zone,
    user_read_at timestamp with time zone,
    staff_read_at timestamp with time zone,
    closed_at timestamp with time zone,
    closed_by text,
    CONSTRAINT tickets_category_check CHECK ((category = ANY (ARRAY['general'::text, 'billing'::text, 'technical'::text, 'account'::text, 'other'::text]))),
    CONSTRAINT tickets_closed_at CHECK (((status = 'closed'::text) = (closed_at IS NOT NULL))),
    CONSTRAINT tickets_closed_by_pair CHECK (((closed_at IS NULL) = (closed_by IS NULL))),
    CONSTRAINT tickets_closed_by_check CHECK ((closed_by = ANY (ARRAY['user'::text, 'staff'::text]))),
    CONSTRAINT tickets_messages_check CHECK ((messages BETWEEN 0 AND 200)),
    CONSTRAINT tickets_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT tickets_status_check CHECK ((status = ANY (ARRAY['open'::text, 'answered'::text, 'closed'::text]))),
    CONSTRAINT tickets_subject_check CHECK ((char_length(subject) BETWEEN 1 AND 120))
);

ALTER TABLE ONLY tickets ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);
CREATE INDEX tickets_assignee ON tickets USING btree (assignee_id) WHERE (assignee_id IS NOT NULL);
CREATE INDEX tickets_open ON tickets USING btree (status) WHERE (status <> 'closed'::text);
CREATE INDEX tickets_queue ON tickets USING btree (updated_at DESC, id);
CREATE INDEX tickets_user ON tickets USING btree (user_id, updated_at DESC, id);
CREATE INDEX tickets_node ON tickets (node_id) WHERE node_id IS NOT NULL;
CREATE INDEX tickets_order ON tickets (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE ticket_messages (
    id bigint GENERATED ALWAYS AS IDENTITY,
    ticket_id uuid NOT NULL,
    author_id uuid,
    author_login text NOT NULL,
    staff boolean NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_messages_body_check CHECK ((char_length(body) BETWEEN 1 AND 5000))
);

ALTER TABLE ONLY ticket_messages ADD CONSTRAINT ticket_messages_pkey PRIMARY KEY (id);
CREATE INDEX ticket_messages_ticket ON ticket_messages USING btree (ticket_id, id);
CREATE INDEX ticket_messages_author ON ticket_messages (author_id) WHERE author_id IS NOT NULL;

CREATE TABLE announcements (
    id uuid NOT NULL,
    title_zh text NOT NULL,
    title_en text,
    body_zh text NOT NULL,
    body_en text,
    pinned boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    visible_from timestamp with time zone,
    visible_until timestamp with time zone,
    audience text DEFAULT 'all'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mail_requested_at timestamp with time zone,
    mail_cursor uuid,
    mail_sent integer DEFAULT 0 NOT NULL,
    mail_done_at timestamp with time zone,
    CONSTRAINT announcements_audience_check CHECK ((audience = ANY (ARRAY['all'::text, 'with_plan'::text, 'without_plan'::text]))),
    CONSTRAINT announcements_body_en_check CHECK (((body_en IS NULL) OR (char_length(body_en) BETWEEN 1 AND 65536))),
    CONSTRAINT announcements_body_zh_check CHECK ((char_length(body_zh) BETWEEN 1 AND 65536)),
    CONSTRAINT announcements_visible_window CHECK (((visible_from IS NULL) OR (visible_until IS NULL) OR (visible_from < visible_until))),
    CONSTRAINT announcements_mail_done_after_request CHECK (((mail_done_at IS NULL) OR (mail_requested_at IS NOT NULL))),
    CONSTRAINT announcements_mail_sent_check CHECK ((mail_sent >= 0)),
    CONSTRAINT announcements_title_en_check CHECK (((title_en IS NULL) OR (char_length(title_en) BETWEEN 1 AND 120))),
    CONSTRAINT announcements_title_zh_check CHECK ((char_length(title_zh) BETWEEN 1 AND 120))
);

ALTER TABLE ONLY announcements ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);
CREATE INDEX announcements_mail_due ON announcements USING btree (mail_requested_at) WHERE ((mail_requested_at IS NOT NULL) AND (mail_done_at IS NULL));
CREATE INDEX announcements_order ON announcements USING btree (pinned DESC, created_at DESC, id);

CREATE TABLE announcement_reads (
    announcement_id uuid NOT NULL,
    user_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY announcement_reads ADD CONSTRAINT announcement_reads_pkey PRIMARY KEY (announcement_id, user_id);
CREATE INDEX announcement_reads_user ON announcement_reads USING btree (user_id);

CREATE TABLE kb_categories (
    id uuid NOT NULL,
    name_zh text NOT NULL,
    name_en text,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kb_categories_name_en_check CHECK (((name_en IS NULL) OR (char_length(name_en) BETWEEN 1 AND 64))),
    CONSTRAINT kb_categories_name_zh_check CHECK ((char_length(name_zh) BETWEEN 1 AND 64)),
    CONSTRAINT kb_categories_sort_check CHECK ((sort BETWEEN '-1000000'::integer AND 1000000))
);

ALTER TABLE ONLY kb_categories ADD CONSTRAINT kb_categories_pkey PRIMARY KEY (id);

CREATE TABLE kb_articles (
    id uuid NOT NULL,
    category_id uuid,
    title_zh text NOT NULL,
    title_en text,
    body_zh text NOT NULL,
    body_en text,
    sort integer DEFAULT 0 NOT NULL,
    published boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kb_articles_body_en_check CHECK (((body_en IS NULL) OR (char_length(body_en) BETWEEN 1 AND 65536))),
    CONSTRAINT kb_articles_body_zh_check CHECK ((char_length(body_zh) BETWEEN 1 AND 65536)),
    CONSTRAINT kb_articles_sort_check CHECK ((sort BETWEEN '-1000000'::integer AND 1000000)),
    CONSTRAINT kb_articles_title_en_check CHECK (((title_en IS NULL) OR (char_length(title_en) BETWEEN 1 AND 120))),
    CONSTRAINT kb_articles_title_zh_check CHECK ((char_length(title_zh) BETWEEN 1 AND 120))
);

ALTER TABLE ONLY kb_articles ADD CONSTRAINT kb_articles_pkey PRIMARY KEY (id);
CREATE INDEX kb_articles_category ON kb_articles USING btree (category_id, sort, created_at);
CREATE INDEX kb_articles_published ON kb_articles USING btree (sort, created_at) WHERE published;

-- =========================================================================
-- Audit and admin batch jobs
-- =========================================================================

CREATE TABLE audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    actor_login text NOT NULL,
    ip text,
    action text NOT NULL,
    target_type text,
    target_id text,
    before jsonb,
    after jsonb
);

ALTER TABLE ONLY audit_log ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
CREATE INDEX audit_log_action ON audit_log USING btree (action, id);
CREATE INDEX audit_log_actor ON audit_log USING btree (actor_login, id);
CREATE INDEX audit_log_at ON audit_log USING btree (at);

CREATE TABLE admin_batch_jobs (
    id uuid NOT NULL,
    actor_id uuid,
    actor_login text NOT NULL,
    action text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    selection text NOT NULL,
    filter jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    total integer NOT NULL,
    done integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    last_error text,
    claimed_until timestamp with time zone,
    claim_token uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT admin_batch_jobs_action_check CHECK ((action = ANY (ARRAY['extend_expiry'::text, 'reset_traffic'::text, 'enable'::text, 'disable'::text, 'set_plan'::text, 'cancel_plan'::text, 'add_balance'::text, 'send_email'::text]))),
    CONSTRAINT admin_batch_jobs_progress_le_total CHECK ((((done + failed) + skipped) <= total)),
    CONSTRAINT admin_batch_jobs_finished_at CHECK (((status = ANY (ARRAY['done'::text, 'cancelled'::text, 'failed'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT admin_batch_jobs_done_check CHECK ((done >= 0)),
    CONSTRAINT admin_batch_jobs_failed_check CHECK ((failed >= 0)),
    CONSTRAINT admin_batch_jobs_selection_check CHECK ((selection = ANY (ARRAY['ids'::text, 'filter'::text]))),
    CONSTRAINT admin_batch_jobs_skipped_check CHECK ((skipped >= 0)),
    CONSTRAINT admin_batch_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'cancelled'::text, 'failed'::text]))),
    CONSTRAINT admin_batch_jobs_total_check CHECK ((total >= 0))
);

ALTER TABLE ONLY admin_batch_jobs ADD CONSTRAINT admin_batch_jobs_pkey PRIMARY KEY (id);
CREATE INDEX admin_batch_jobs_open ON admin_batch_jobs USING btree (created_at) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));
CREATE INDEX admin_batch_jobs_recent ON admin_batch_jobs USING btree (created_at DESC);

CREATE TABLE admin_batch_items (
    job_id uuid NOT NULL,
    user_id uuid NOT NULL,
    user_login text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    detail text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_batch_items_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text, 'skipped'::text])))
);

ALTER TABLE ONLY admin_batch_items ADD CONSTRAINT admin_batch_items_pkey PRIMARY KEY (job_id, user_id);
CREATE INDEX admin_batch_items_pending ON admin_batch_items USING btree (job_id, user_id) WHERE (status = 'pending'::text);

-- =========================================================================
-- Foreign keys (after all tables: some reference each other)
-- =========================================================================

ALTER TABLE ONLY node_enrollments ADD CONSTRAINT node_enrollments_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY node_group_members ADD CONSTRAINT node_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES node_groups(id) ON DELETE CASCADE;
ALTER TABLE ONLY node_group_members ADD CONSTRAINT node_group_members_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY users ADD CONSTRAINT users_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY user_totp ADD CONSTRAINT user_totp_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY user_recovery_codes ADD CONSTRAINT user_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY email_codes ADD CONSTRAINT email_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY password_resets ADD CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY invite_codes ADD CONSTRAINT invite_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY user_notices ADD CONSTRAINT user_notices_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY node_users ADD CONSTRAINT node_users_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY node_users ADD CONSTRAINT node_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY node_users_departed ADD CONSTRAINT node_users_departed_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY node_users_departed ADD CONSTRAINT node_users_departed_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY traffic_sessions ADD CONSTRAINT traffic_sessions_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY plan_groups ADD CONSTRAINT plan_groups_group_id_fkey FOREIGN KEY (group_id) REFERENCES node_groups(id) ON DELETE CASCADE;
ALTER TABLE ONLY plan_groups ADD CONSTRAINT plan_groups_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE;
ALTER TABLE ONLY plan_period_prices ADD CONSTRAINT plan_period_prices_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE;
ALTER TABLE ONLY user_plans ADD CONSTRAINT user_plans_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE;
ALTER TABLE ONLY user_plans ADD CONSTRAINT user_plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY orders ADD CONSTRAINT orders_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL;
ALTER TABLE ONLY orders ADD CONSTRAINT orders_credit_order_id_fkey FOREIGN KEY (credit_order_id) REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE ONLY orders ADD CONSTRAINT orders_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id);
ALTER TABLE ONLY orders ADD CONSTRAINT orders_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL;
ALTER TABLE ONLY orders ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY payment_events ADD CONSTRAINT payment_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE ONLY payment_events ADD CONSTRAINT payment_events_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id) ON DELETE SET NULL;
ALTER TABLE ONLY coupons ADD CONSTRAINT coupons_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES coupon_batches(id) ON DELETE SET NULL;
ALTER TABLE ONLY coupon_redemptions ADD CONSTRAINT coupon_redemptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES coupons(id);
ALTER TABLE ONLY coupon_redemptions ADD CONSTRAINT coupon_redemptions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE ONLY coupon_redemptions ADD CONSTRAINT coupon_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY user_balances ADD CONSTRAINT user_balances_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY balance_ledger ADD CONSTRAINT balance_ledger_commission FOREIGN KEY (commission_id) REFERENCES commissions(id);
ALTER TABLE ONLY balance_ledger ADD CONSTRAINT balance_ledger_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE ONLY balance_ledger ADD CONSTRAINT balance_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY balance_ledger ADD CONSTRAINT balance_ledger_withdrawal FOREIGN KEY (withdrawal_id) REFERENCES withdrawals(id);
ALTER TABLE ONLY commissions ADD CONSTRAINT commissions_invitee_id_fkey FOREIGN KEY (invitee_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY commissions ADD CONSTRAINT commissions_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY commissions ADD CONSTRAINT commissions_ledger_id_fkey FOREIGN KEY (ledger_id) REFERENCES balance_ledger(id);
ALTER TABLE ONLY commissions ADD CONSTRAINT commissions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE ONLY withdrawals ADD CONSTRAINT withdrawals_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY node_metrics_1m ADD CONSTRAINT node_metrics_1m_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY node_metrics_1h ADD CONSTRAINT node_metrics_1h_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY node_latency ADD CONSTRAINT node_latency_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY node_alert_rules ADD CONSTRAINT node_alert_rules_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY node_alerts ADD CONSTRAINT node_alerts_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY alert_notifications ADD CONSTRAINT alert_notifications_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES node_alerts(id) ON DELETE CASCADE;
ALTER TABLE ONLY agent_release_chunks ADD CONSTRAINT agent_release_chunks_release_id_fkey FOREIGN KEY (release_id) REFERENCES agent_releases(id) ON DELETE CASCADE;
ALTER TABLE ONLY rollout_nodes ADD CONSTRAINT rollout_nodes_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE;
ALTER TABLE ONLY rollout_nodes ADD CONSTRAINT rollout_nodes_rollout_id_fkey FOREIGN KEY (rollout_id) REFERENCES rollouts(id) ON DELETE CASCADE;
ALTER TABLE ONLY signup_settings ADD CONSTRAINT signup_settings_trial_plan_id_fkey FOREIGN KEY (trial_plan_id) REFERENCES plans(id) ON DELETE SET NULL;
ALTER TABLE ONLY mail_outbox ADD CONSTRAINT mail_outbox_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY tickets ADD CONSTRAINT tickets_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY tickets ADD CONSTRAINT tickets_node_id_fkey FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE ONLY tickets ADD CONSTRAINT tickets_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE ONLY tickets ADD CONSTRAINT tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY ticket_messages ADD CONSTRAINT ticket_messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ONLY ticket_messages ADD CONSTRAINT ticket_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
ALTER TABLE ONLY announcement_reads ADD CONSTRAINT announcement_reads_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE;
ALTER TABLE ONLY announcement_reads ADD CONSTRAINT announcement_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ONLY kb_articles ADD CONSTRAINT kb_articles_category_id_fkey FOREIGN KEY (category_id) REFERENCES kb_categories(id) ON DELETE SET NULL;
ALTER TABLE ONLY admin_batch_items ADD CONSTRAINT admin_batch_items_job_id_fkey FOREIGN KEY (job_id) REFERENCES admin_batch_jobs(id) ON DELETE CASCADE;

-- =========================================================================
-- Seed rows: the single-row settings tables (code expects id = 1 / TRUE)
-- =========================================================================

INSERT INTO agent_update_settings (id, source_url, auto_check, version, updated_at, next_auto_check_at, check_started_at, last_check_at, last_check_ok, last_check_result, last_check_version, last_check_code, last_check_params, last_check_message, last_check_stored) VALUES (true, NULL, false, 1, now(), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO alert_settings (id, version, enabled, offline_secs, cpu_percent, cpu_minutes, mem_percent, mem_minutes, disk_percent, cert_days, latency_failures, last_error, cooldown_minutes, notify_resolved, telegram_enabled, telegram_chat_id, telegram_token_enc, webhook_enabled, webhook_url, webhook_secret_enc, email_enabled, email_to, updated_at, telegram_api_url) VALUES (1, 0, true, 300, 90, 5, 90, 5, 90, 14, true, true, 30, true, false, NULL, NULL, false, NULL, NULL, false, '{}', now(), NULL);
INSERT INTO commission_settings (id, enabled, rate_percent, first_order_only, hold_days, min_withdrawal_cents, updated_at) VALUES (1, false, 10, true, 7, 10000, now());
INSERT INTO panel_settings (id, version, main_domain, sub_domain, node_domain, trust_cloudflare, updated_at, probe_interval_secs, probe_urls, probe_panel_tcp, site_name, cloudflare_ranges, install_tls_pin, install_fallback_url, acme_directory_url, acme_email, audit_retention_days, traffic_daily_retention_days, require_admin_2fa, remove_mode, extra_release_keys) VALUES (1, 0, NULL, NULL, NULL, NULL, now(), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO signup_settings (id, version, register_enabled, invite_required, invite_single_use, invite_codes_per_user, email_domains, trial_plan_id, trial_days, reset_enabled, updated_at, email_verify) VALUES (1, 0, false, false, false, 5, '{}', NULL, 1, false, now(), NULL);
INSERT INTO site_branding (id, version, logo, logo_sha256, favicon, favicon_sha256, footer_text, footer_links, tos_url, privacy_url, client_downloads, updated_at) VALUES (1, 1, NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL, '[]', now());
INSERT INTO smtp_settings (id, version, enabled, host, port, security, username, password_enc, from_addr, from_name, notify_order_paid, notify_expiry_days, notify_expired, notify_quota, updated_at) VALUES (1, 0, false, NULL, 587, 'starttls', NULL, NULL, NULL, NULL, true, 3, true, true, now());
