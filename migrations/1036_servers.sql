-- Phase A PR ② (Q1, research/db-schema-review.md §D2 方案 A): servers.
--
-- A server is one machine = one agent identity: its certificate and
-- enrolment, the agent's Hello/heartbeat state, the desired-state versions
-- and lease, the apply failures, two-phase deletion, the billing GCRA, the
-- latency probe, the TLS domain (one ACME certificate per agent) and the
-- entrance numbering. A node is one inbound (protocol) on a server (D2);
-- one agent serves every node of its server in one Snapshot. Machine data
-- (enrolment, metrics, latency, alerts, rollouts, traffic sessions and
-- counters, revocation tombstones) now belongs to the server.
--
-- Existing nodes become one server each with the same id, so every moved
-- row keeps its key. The per-node block-rule counters (1060) move to the
-- server in 1065: on a fresh database they are created after this file.

CREATE TABLE servers (
    id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    config_version bigint DEFAULT 1 NOT NULL,
    user_version bigint DEFAULT 0 NOT NULL,
    -- Identity (M1c): newest issued certificate, the renewal source while
    -- the new one has not been seen, the expiry of cert_serial.
    cert_serial text,
    prev_cert_serial text,
    cert_not_after timestamp with time zone,
    enrolled_at timestamp with time zone,
    server_name text,
    -- The last Hello / stream.
    agent_version text,
    core_version text,
    agent_protocol integer,
    agent_os text,
    agent_arch text,
    agent_addr inet,
    agent_capabilities text[],
    agent_session text,
    agent_session_at timestamp with time zone,
    finals_drained_session text,
    finals_drained_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    online_session uuid,
    lease_expires_at timestamp with time zone,
    -- The agent's last failed apply.
    last_error text,
    last_error_at timestamp with time zone,
    failed_config_version bigint,
    failed_user_version bigint,
    failed_reason text,
    failed_held_config_version bigint,
    failed_held_user_version bigint,
    -- Two-phase deletion.
    deleting_at timestamp with time zone,
    delete_acked_at timestamp with time zone,
    -- Billing plausibility (traffic::FLUSH_SQL): GCRA clock and credits.
    traffic_tat timestamp with time zone,
    traffic_max_rate_bytes_per_sec bigint,
    traffic_credit_floor timestamp with time zone,
    traffic_credit_until timestamp with time zone,
    -- W11 latency probe.
    probe_requested_at timestamp with time zone,
    panel_probe_next_at timestamp with time zone,
    -- W10: the domain the agent obtains a certificate for.
    tls_domain text,
    -- Last entrance number handed out on this server (-1 = none yet; the
    -- first is the first node's direct entrance, 0). Never reused.
    entrance_seq integer DEFAULT '-1'::integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT servers_name CHECK (char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT servers_status_valid CHECK (status = ANY (ARRAY['pending'::text, 'online'::text, 'offline'::text])),
    CONSTRAINT servers_traffic_max_rate CHECK (traffic_max_rate_bytes_per_sec IS NULL OR traffic_max_rate_bytes_per_sec > 0),
    CONSTRAINT servers_tls_domain CHECK (tls_domain IS NULL OR (length(tls_domain) <= 253
        AND tls_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'::text
        AND tls_domain !~ '^[0-9.]+$'::text)),
    CONSTRAINT servers_entrance_seq CHECK (entrance_seq BETWEEN '-1'::integer AND 32767)
)
-- Heartbeats, leases and every flush update the row (HOT updates).
WITH (fillfactor='70');

ALTER TABLE ONLY servers ADD CONSTRAINT servers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY servers ADD CONSTRAINT servers_name_key UNIQUE (name);
ALTER TABLE ONLY servers ADD CONSTRAINT servers_cert_serial_key UNIQUE (cert_serial);
ALTER TABLE ONLY servers ADD CONSTRAINT servers_prev_cert_serial_key UNIQUE (prev_cert_serial);

INSERT INTO servers (id, name, status, config_version, user_version, cert_serial, prev_cert_serial,
    cert_not_after, enrolled_at, server_name, agent_version, core_version, agent_protocol, agent_os,
    agent_arch, agent_addr, agent_capabilities, agent_session, agent_session_at,
    finals_drained_session, finals_drained_at, last_seen_at, online_session, lease_expires_at,
    last_error, last_error_at, failed_config_version, failed_user_version, failed_reason,
    failed_held_config_version, failed_held_user_version, deleting_at, delete_acked_at, traffic_tat,
    traffic_max_rate_bytes_per_sec, traffic_credit_floor, traffic_credit_until, probe_requested_at,
    panel_probe_next_at, tls_domain, entrance_seq, created_at, updated_at)
SELECT id, name, status, config_version, user_version, cert_serial, prev_cert_serial,
    cert_not_after, enrolled_at, server_name, agent_version, core_version, agent_protocol, agent_os,
    agent_arch, agent_addr, agent_capabilities, agent_session, agent_session_at,
    finals_drained_session, finals_drained_at, last_seen_at, online_session, lease_expires_at,
    last_error, last_error_at, failed_config_version, failed_user_version, failed_reason,
    failed_held_config_version, failed_held_user_version, deleting_at, delete_acked_at, traffic_tat,
    traffic_max_rate_bytes_per_sec, traffic_credit_floor, traffic_credit_until, probe_requested_at,
    panel_probe_next_at, tls_domain, entrance_seq, created_at, updated_at
FROM nodes;

-- Version changes and deletions wake the server's agent sessions (notify.rs).
CREATE TRIGGER servers_notify_delete AFTER DELETE ON servers FOR EACH ROW EXECUTE FUNCTION akari_notify_node_change();
CREATE TRIGGER servers_notify_versions AFTER UPDATE ON servers FOR EACH ROW
    WHEN (old.config_version IS DISTINCT FROM new.config_version OR old.user_version IS DISTINCT FROM new.user_version)
    EXECUTE FUNCTION akari_notify_node_change();
CREATE TRIGGER servers_refuse_revoked_serial BEFORE INSERT OR UPDATE OF cert_serial, prev_cert_serial ON servers
    FOR EACH ROW EXECUTE FUNCTION akari_refuse_revoked_serial();

-- -------------------------------------------------------------------------
-- Nodes: one inbound on a server
-- -------------------------------------------------------------------------

ALTER TABLE nodes ADD COLUMN server_id uuid;
UPDATE nodes SET server_id = id;
ALTER TABLE nodes ALTER COLUMN server_id SET NOT NULL;
ALTER TABLE ONLY nodes ADD CONSTRAINT nodes_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;
-- Target of entrances' (node_id, server_id) key.
ALTER TABLE ONLY nodes ADD CONSTRAINT nodes_id_server_key UNIQUE (id, server_id);
CREATE INDEX nodes_server ON nodes USING btree (server_id);

-- A node never moves to another server (its entrances' numbers, ports and
-- traffic keys are the server's).
CREATE FUNCTION akari_node_keep_server() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.server_id IS DISTINCT FROM OLD.server_id THEN
        RAISE EXCEPTION 'a node cannot move to another server' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_keep_server BEFORE UPDATE OF server_id ON nodes FOR EACH ROW EXECUTE FUNCTION akari_node_keep_server();

DROP TRIGGER nodes_notify_delete ON nodes;
DROP TRIGGER nodes_notify_versions ON nodes;
DROP TRIGGER nodes_refuse_revoked_serial ON nodes;

-- -------------------------------------------------------------------------
-- Machine tables follow the server
-- -------------------------------------------------------------------------

ALTER TABLE node_enrollments RENAME TO server_enrollments;
ALTER TABLE server_enrollments RENAME COLUMN node_id TO server_id;
ALTER TABLE server_enrollments DROP CONSTRAINT node_enrollments_node_id_fkey;
ALTER TABLE server_enrollments RENAME CONSTRAINT node_enrollments_pkey TO server_enrollments_pkey;
ALTER TABLE server_enrollments RENAME CONSTRAINT node_enrollments_token_hash_key TO server_enrollments_token_hash_key;
ALTER TABLE server_enrollments RENAME CONSTRAINT node_enrollments_pin_needs_origin TO server_enrollments_pin_needs_origin;
ALTER TABLE ONLY server_enrollments ADD CONSTRAINT server_enrollments_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE revoked_certs RENAME COLUMN node_id TO server_id;

ALTER TABLE traffic_sessions RENAME COLUMN node_id TO server_id;
ALTER TABLE traffic_sessions DROP CONSTRAINT traffic_sessions_node_id_fkey;
ALTER TABLE ONLY traffic_sessions ADD CONSTRAINT traffic_sessions_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

-- The billing baseline is per agent identity (the reporting server).
ALTER TABLE traffic_counters RENAME COLUMN node_id TO server_id;

ALTER TABLE node_metrics_1m RENAME TO server_metrics_1m;
ALTER TABLE server_metrics_1m RENAME COLUMN node_id TO server_id;
ALTER TABLE server_metrics_1m DROP CONSTRAINT node_metrics_1m_node_id_fkey;
ALTER TABLE server_metrics_1m RENAME CONSTRAINT node_metrics_1m_pkey TO server_metrics_1m_pkey;
ALTER INDEX node_metrics_1m_bucket RENAME TO server_metrics_1m_bucket;
ALTER TABLE ONLY server_metrics_1m ADD CONSTRAINT server_metrics_1m_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE node_metrics_1h RENAME TO server_metrics_1h;
ALTER TABLE server_metrics_1h RENAME COLUMN node_id TO server_id;
ALTER TABLE server_metrics_1h DROP CONSTRAINT node_metrics_1h_node_id_fkey;
ALTER TABLE server_metrics_1h RENAME CONSTRAINT node_metrics_1h_pkey TO server_metrics_1h_pkey;
ALTER INDEX node_metrics_1h_bucket RENAME TO server_metrics_1h_bucket;
ALTER TABLE ONLY server_metrics_1h ADD CONSTRAINT server_metrics_1h_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE node_latency RENAME TO server_latency;
ALTER TABLE server_latency RENAME COLUMN node_id TO server_id;
ALTER TABLE server_latency DROP CONSTRAINT node_latency_node_id_fkey;
ALTER TABLE server_latency RENAME CONSTRAINT node_latency_pkey TO server_latency_pkey;
ALTER TABLE ONLY server_latency ADD CONSTRAINT server_latency_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE node_alert_rules RENAME TO server_alert_rules;
ALTER TABLE server_alert_rules RENAME COLUMN node_id TO server_id;
ALTER TABLE server_alert_rules DROP CONSTRAINT node_alert_rules_node_id_fkey;
ALTER TABLE server_alert_rules RENAME CONSTRAINT node_alert_rules_pkey TO server_alert_rules_pkey;
ALTER TABLE ONLY server_alert_rules ADD CONSTRAINT server_alert_rules_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE node_alerts RENAME TO server_alerts;
ALTER TABLE server_alerts RENAME COLUMN node_id TO server_id;
ALTER TABLE server_alerts DROP CONSTRAINT node_alerts_node_id_fkey;
ALTER TABLE server_alerts RENAME CONSTRAINT node_alerts_pkey TO server_alerts_pkey;
ALTER TABLE server_alerts RENAME CONSTRAINT node_alerts_kind_check TO server_alerts_kind_check;
ALTER INDEX node_alerts_last RENAME TO server_alerts_last;
ALTER INDEX node_alerts_one_firing RENAME TO server_alerts_one_firing;
ALTER INDEX node_alerts_resolved RENAME TO server_alerts_resolved;
ALTER TABLE ONLY server_alerts ADD CONSTRAINT server_alerts_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE rollout_nodes RENAME TO rollout_servers;
ALTER TABLE rollout_servers RENAME COLUMN node_id TO server_id;
ALTER TABLE rollout_servers DROP CONSTRAINT rollout_nodes_node_id_fkey;
ALTER TABLE rollout_servers RENAME CONSTRAINT rollout_nodes_pkey TO rollout_servers_pkey;
ALTER TABLE rollout_servers RENAME CONSTRAINT rollout_nodes_status_check TO rollout_servers_status_check;
ALTER TABLE rollout_servers RENAME CONSTRAINT rollout_nodes_wave_check TO rollout_servers_wave_check;
ALTER INDEX rollout_nodes_node RENAME TO rollout_servers_server;
ALTER TABLE ONLY rollout_servers ADD CONSTRAINT rollout_servers_server_id_fkey FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

-- -------------------------------------------------------------------------
-- Entrances: numbered and port-checked per server
-- -------------------------------------------------------------------------

-- The agent runs every entrance of the server side by side: inbound tags
-- (e<wire_no>), traffic keys (<user>#<wire_no>) and listening ports must be
-- unique per server. server_id is the node's (composite key, the node
-- never moves).
ALTER TABLE entrances ADD COLUMN server_id uuid;
UPDATE entrances e SET server_id = n.server_id FROM nodes n WHERE n.id = e.node_id;
ALTER TABLE entrances ALTER COLUMN server_id SET NOT NULL;
ALTER TABLE entrances DROP CONSTRAINT entrances_node_id_fkey;
ALTER TABLE ONLY entrances ADD CONSTRAINT entrances_node_id_fkey FOREIGN KEY (node_id, server_id)
    REFERENCES nodes(id, server_id) ON DELETE CASCADE;
CREATE INDEX entrances_node ON entrances USING btree (node_id);

ALTER TABLE entrances DROP CONSTRAINT entrances_wire_no_key;
ALTER TABLE ONLY entrances ADD CONSTRAINT entrances_wire_no_key UNIQUE (server_id, wire_no);
ALTER TABLE entrances DROP CONSTRAINT entrances_listen_port_key;
ALTER TABLE ONLY entrances ADD CONSTRAINT entrances_listen_port_key UNIQUE (server_id, listen_port);
-- A direct entrance is 0 on the server's first node and numbered like a
-- relay on the others.
ALTER TABLE entrances DROP CONSTRAINT entrances_wire_no;
ALTER TABLE entrances ADD CONSTRAINT entrances_wire_no CHECK (
    (kind = 'direct' AND wire_no BETWEEN 0 AND 32767) OR (kind = 'relay' AND wire_no BETWEEN 1 AND 32767));

CREATE OR REPLACE FUNCTION akari_node_direct_entrance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    n integer;
BEGIN
    UPDATE servers SET entrance_seq = entrance_seq + 1 WHERE id = NEW.server_id RETURNING entrance_seq INTO n;
    INSERT INTO entrances (id, node_id, server_id, kind, name, wire_no)
        VALUES (gen_random_uuid(), NEW.id, NEW.server_id, 'direct', '直连', n);
    RETURN NEW;
END;
$$;

-- -------------------------------------------------------------------------
-- Machine columns leave nodes
-- -------------------------------------------------------------------------

ALTER TABLE nodes
    DROP COLUMN status,
    DROP COLUMN config_version,
    DROP COLUMN user_version,
    DROP COLUMN cert_serial,
    DROP COLUMN prev_cert_serial,
    DROP COLUMN cert_not_after,
    DROP COLUMN enrolled_at,
    DROP COLUMN server_name,
    DROP COLUMN agent_version,
    DROP COLUMN core_version,
    DROP COLUMN agent_protocol,
    DROP COLUMN agent_os,
    DROP COLUMN agent_arch,
    DROP COLUMN agent_addr,
    DROP COLUMN agent_capabilities,
    DROP COLUMN agent_session,
    DROP COLUMN agent_session_at,
    DROP COLUMN finals_drained_session,
    DROP COLUMN finals_drained_at,
    DROP COLUMN last_seen_at,
    DROP COLUMN online_session,
    DROP COLUMN lease_expires_at,
    DROP COLUMN last_error,
    DROP COLUMN last_error_at,
    DROP COLUMN failed_config_version,
    DROP COLUMN failed_user_version,
    DROP COLUMN failed_reason,
    DROP COLUMN failed_held_config_version,
    DROP COLUMN failed_held_user_version,
    DROP COLUMN deleting_at,
    DROP COLUMN delete_acked_at,
    DROP COLUMN traffic_tat,
    DROP COLUMN traffic_max_rate_bytes_per_sec,
    DROP COLUMN traffic_credit_floor,
    DROP COLUMN traffic_credit_until,
    DROP COLUMN probe_requested_at,
    DROP COLUMN panel_probe_next_at,
    DROP COLUMN tls_domain,
    DROP COLUMN entrance_seq;

ALTER TABLE rollouts RENAME COLUMN explicit_nodes TO explicit_servers;
