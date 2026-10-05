-- W29: node block rules (后台「审计规则」; named block_rules so it is never
-- confused with audit_log, research/db-schema-review.md).
--
-- The panel compiles the enabled rules into one BlockPolicy per agent
-- (blockrules.rs); the agent only installs them into xray routing
-- (sniffing + blackhole). Only aggregate per-node hit counts are kept —
-- never per-user access records.

CREATE TABLE block_rules (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL,
    -- Vendored rule set (src/blockrules/lists, scripts/update-block-lists.sh).
    builtin_key text,
    name text NOT NULL,
    -- Custom rules: one entry per line, validated by blockrules::parse_entries.
    pattern text,
    enabled boolean NOT NULL DEFAULT false,
    sort integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT block_rules_kind CHECK (kind IN ('builtin', 'domain', 'ip', 'protocol')),
    CONSTRAINT block_rules_builtin_key CHECK (builtin_key IN ('bittorrent', 'bt_tracker', 'xunlei_pt')),
    CONSTRAINT block_rules_builtin_shape CHECK (
        (kind = 'builtin') = (builtin_key IS NOT NULL)
        AND (kind = 'builtin') = (pattern IS NULL)
    ),
    CONSTRAINT block_rules_name CHECK (char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT block_rules_pattern CHECK (pattern IS NULL OR octet_length(pattern) BETWEEN 1 AND 65536),
    CONSTRAINT block_rules_sort CHECK (sort BETWEEN -1000000 AND 1000000)
);

CREATE UNIQUE INDEX block_rules_builtin ON block_rules (builtin_key) WHERE kind = 'builtin';

-- The built-in sets exist exactly once and keep their kind on every write
-- path (API, CLI, hand-written SQL): they can be switched, never removed.
CREATE FUNCTION akari_block_rules_keep_builtin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.kind = 'builtin' THEN
            RAISE EXCEPTION 'built-in block rule sets cannot be deleted' USING ERRCODE = 'AK029';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.kind IS DISTINCT FROM NEW.kind OR OLD.builtin_key IS DISTINCT FROM NEW.builtin_key THEN
        RAISE EXCEPTION 'block rule kind cannot change' USING ERRCODE = 'AK029';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER block_rules_keep_builtin BEFORE UPDATE OR DELETE ON block_rules
    FOR EACH ROW EXECUTE FUNCTION akari_block_rules_keep_builtin();

-- Any change re-sends the compiled policy to every agent (notify.rs
-- `block-rules` → wake all sessions), in the writing transaction.
CREATE FUNCTION akari_block_rules_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('akari_change', 'block-rules');
    RETURN NULL;
END $$;

CREATE TRIGGER block_rules_notify AFTER INSERT OR DELETE OR UPDATE ON block_rules
    FOR EACH STATEMENT EXECUTE FUNCTION akari_block_rules_notify();

INSERT INTO block_rules (kind, builtin_key, name, enabled, sort) VALUES
    ('builtin', 'bittorrent', 'BitTorrent 协议识别', true, -30),
    ('builtin', 'bt_tracker', 'BT Tracker 域名', true, -20),
    ('builtin', 'xunlei_pt', '迅雷 / PT 站域名', false, -10);

-- Per-node switch, default off. Toggling it never bumps config_version
-- (no Snapshot, no xray rebuild): it wakes the node's sessions, which send
-- the new BlockPolicy; the agent swaps only that node's inbound handlers.
ALTER TABLE nodes ADD COLUMN block_rules_enabled boolean NOT NULL DEFAULT false;

CREATE TRIGGER nodes_notify_block_rules AFTER UPDATE OF block_rules_enabled ON nodes
    FOR EACH ROW WHEN (old.block_rules_enabled IS DISTINCT FROM new.block_rules_enabled)
    EXECUTE FUNCTION akari_notify_node_change();

-- Highest cumulative hit count an agent process (epoch) reported per rule.
-- Like traffic_counters, this is the baseline the daily delta is computed
-- against in SQL (GREATEST + RETURNING old/new), so replays never count
-- twice. rule_id has no foreign key: rows are pruned with their epoch.
CREATE TABLE node_block_counters (
    node_id uuid NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    epoch text NOT NULL,
    rule_id bigint NOT NULL,
    hits bigint NOT NULL,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (node_id, epoch, rule_id),
    CONSTRAINT node_block_counters_epoch CHECK (char_length(epoch) BETWEEN 1 AND 64),
    CONSTRAINT node_block_counters_hits CHECK (hits >= 0)
);

CREATE INDEX node_block_counters_updated ON node_block_counters (updated_at);

-- Blocked connections per node, rule and UTC day (90 days, reaper).
CREATE TABLE node_block_daily (
    node_id uuid NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    day date NOT NULL,
    rule_id bigint NOT NULL REFERENCES block_rules (id) ON DELETE CASCADE,
    hits bigint NOT NULL,
    PRIMARY KEY (node_id, day, rule_id),
    CONSTRAINT node_block_daily_hits CHECK (hits >= 0)
);

CREATE INDEX node_block_daily_day ON node_block_daily (day);
CREATE INDEX node_block_daily_rule ON node_block_daily (rule_id);
