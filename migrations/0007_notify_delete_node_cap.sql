-- Sprint 3b.
--
-- 1. Targeted wakeups (S3-2): every change of a node's desired-state
--    versions, and every node deletion, raises a NOTIFY on channel
--    'akari_change' inside the writing transaction (delivered on commit,
--    identical payloads within one transaction are collapsed by PostgreSQL).
--    Payload: the node id as text, or 'del:<node id>' for a deletion.
--    A trigger rather than application code, so no mutation path (API,
--    enforcement, CLI, manual SQL) can forget it; writes that do not change
--    the versions (flush, lease, online status, failures) never notify.
CREATE FUNCTION akari_notify_node_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('akari_change', 'del:' || OLD.id::text);
        RETURN OLD;
    END IF;
    PERFORM pg_notify('akari_change', NEW.id::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_notify_versions
    AFTER UPDATE ON nodes
    FOR EACH ROW
    WHEN ((OLD.config_version, OLD.user_version)
          IS DISTINCT FROM (NEW.config_version, NEW.user_version))
    EXECUTE FUNCTION akari_notify_node_change();

CREATE TRIGGER nodes_notify_delete
    AFTER DELETE ON nodes
    FOR EACH ROW
    EXECUTE FUNCTION akari_notify_node_change();

-- 2. Node deletion (S3-3, R12 D1/D2), two phases:
--    phase 1 (API/CLI) sets deleting_at and disables the node (version bump:
--    the agent converges to the empty state; its final counters are still
--    billed, node_users is untouched); the session that sees the agent ack
--    that empty state sets delete_acked_at. Phase 2 (a background loop on
--    any panel instance; after the ack, a timeout, or at once when no agent
--    is online) tombstones the certificate serial and deletes the row.
ALTER TABLE nodes
    ADD COLUMN deleting_at TIMESTAMPTZ,
    ADD COLUMN delete_acked_at TIMESTAMPTZ;

--    Tombstones are forever. A tombstoned serial is still accepted on the
--    control stream, but only to push it the empty state and close (a
--    refused agent would keep running its last config); the trigger below
--    makes it impossible to (re-)register a node with a revoked serial.
CREATE TABLE revoked_certs (
    cert_serial TEXT PRIMARY KEY,
    node_id     UUID NOT NULL,
    revoked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

--    R12 P2: serials are stored normalized (lowercase hex, no leading zero
--    bytes — install::normalize_serial), which is what identification
--    computes from the presented certificate. Older random serials with a
--    leading 0x00 byte could never authenticate.
UPDATE nodes SET cert_serial = lower(regexp_replace(cert_serial, '^(00)+', ''))
    WHERE cert_serial IS NOT NULL
      AND cert_serial <> lower(regexp_replace(cert_serial, '^(00)+', ''));

CREATE FUNCTION akari_refuse_revoked_serial() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.cert_serial IS NOT NULL
       AND EXISTS (SELECT 1 FROM revoked_certs WHERE cert_serial = NEW.cert_serial) THEN
        RAISE EXCEPTION 'certificate serial % is revoked', NEW.cert_serial
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_refuse_revoked_serial
    BEFORE INSERT OR UPDATE OF cert_serial ON nodes
    FOR EACH ROW
    EXECUTE FUNCTION akari_refuse_revoked_serial();

-- 3. Per-node aggregate plausibility cap (R6 L4, R12 D4) as GCRA:
--    traffic_tat is the node's virtual billing clock. A flush may bill the
--    node (all users and sessions together) at most
--    rate * (now - max(traffic_tat, now - window)); billing b advances
--    traffic_tat by b / rate. NULL = never billed: treated as now - 60 s.
--    Lives in the DB, so a panel restart grants nothing; an outage (no
--    flush) accrues allowance up to the window. traffic_max_rate_bytes_per_sec
--    overrides traffic.node_max_rate_bytes_per_sec for this node.
ALTER TABLE nodes
    ADD COLUMN traffic_tat TIMESTAMPTZ,
    ADD COLUMN traffic_max_rate_bytes_per_sec BIGINT
        CHECK (traffic_max_rate_bytes_per_sec IS NULL OR traffic_max_rate_bytes_per_sec > 0);

-- Existing nodes: the allowance counts from their last persisted counters,
-- so traffic delayed by the upgrade is billed (bounded by the window).
UPDATE nodes n SET traffic_tat =
    (SELECT max(c.updated_at) FROM traffic_counters c WHERE c.node_id = n.id);

-- 4. Departed pairs bill only traffic plausibly carried before the
--    unassignment (R12 D6): each counter row remembers when it was first
--    written. NULL (rows older than this migration) = updated_at.
ALTER TABLE traffic_counters ADD COLUMN first_seen_at TIMESTAMPTZ;
