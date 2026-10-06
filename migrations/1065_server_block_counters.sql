-- Phase A PR ② (Q1), second half of 1036: the W29 block-rule counters
-- belong to the agent (one hit count per rule and agent process), i.e. to
-- the server. Numbered after 1060 on purpose: on a fresh database 1036 runs
-- before 1060 creates these tables (W30's block 1065–1069 is this PR's;
-- the W28 block 1036–1052 runs too early).
--
-- 1036 gave every existing node a server with the same id, so the rows keep
-- their keys.

ALTER TABLE node_block_counters RENAME TO server_block_counters;
ALTER TABLE server_block_counters RENAME COLUMN node_id TO server_id;
ALTER TABLE server_block_counters DROP CONSTRAINT node_block_counters_node_id_fkey;
ALTER TABLE server_block_counters RENAME CONSTRAINT node_block_counters_pkey TO server_block_counters_pkey;
ALTER TABLE server_block_counters RENAME CONSTRAINT node_block_counters_epoch TO server_block_counters_epoch;
ALTER TABLE server_block_counters RENAME CONSTRAINT node_block_counters_hits TO server_block_counters_hits;
ALTER INDEX node_block_counters_updated RENAME TO server_block_counters_updated;
ALTER TABLE ONLY server_block_counters ADD CONSTRAINT server_block_counters_server_id_fkey
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE node_block_daily RENAME TO server_block_daily;
ALTER TABLE server_block_daily RENAME COLUMN node_id TO server_id;
ALTER TABLE server_block_daily DROP CONSTRAINT node_block_daily_node_id_fkey;
ALTER TABLE server_block_daily RENAME CONSTRAINT node_block_daily_pkey TO server_block_daily_pkey;
ALTER TABLE server_block_daily RENAME CONSTRAINT node_block_daily_hits TO server_block_daily_hits;
ALTER TABLE server_block_daily RENAME CONSTRAINT node_block_daily_rule_id_fkey TO server_block_daily_rule_id_fkey;
ALTER INDEX node_block_daily_day RENAME TO server_block_daily_day;
ALTER INDEX node_block_daily_rule RENAME TO server_block_daily_rule;
ALTER TABLE ONLY server_block_daily ADD CONSTRAINT server_block_daily_server_id_fkey
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

-- The per-node switch wakes the sessions of the node's server (they are
-- keyed by server id; still no version bump).
CREATE FUNCTION akari_notify_node_server() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('akari_change', NEW.server_id::text);
    RETURN NEW;
END;
$$;

DROP TRIGGER nodes_notify_block_rules ON nodes;
CREATE TRIGGER nodes_notify_block_rules AFTER UPDATE OF block_rules_enabled ON nodes
    FOR EACH ROW WHEN (old.block_rules_enabled IS DISTINCT FROM new.block_rules_enabled)
    EXECUTE FUNCTION akari_notify_node_server();
