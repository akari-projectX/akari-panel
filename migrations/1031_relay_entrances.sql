-- W28-a (PLAN-v0.4 §5): relay entrances.
--
-- A relay entrance is an external relay (IPLC, a forwarding VPS, ...) that
-- forwards to the node. The node serves it on its own derived inbound: the
-- node's inbound with another port (`listen_port`), its own per-user
-- credentials (`entrance_users`), and a kernel source-IP allowlist of the
-- relay's egress addresses (`source_cidrs`, applied by the agent with
-- nftables). Clients dial the relay (`connect_host`:`connect_port`).
--
-- `wire_no` is the entrance's short number on its node: the agent's
-- per-user traffic key is `<user uuid>` on the direct entrance (0) and
-- `<user uuid>#<wire_no>` on a relay, and the derived inbound's tag is
-- `e<wire_no>`. Numbers come from `nodes.entrance_seq` and are never reused
-- on a node (a late report of a removed entrance cannot be billed to a new
-- one).

ALTER TABLE entrances DROP CONSTRAINT entrances_kind;
ALTER TABLE entrances ADD CONSTRAINT entrances_kind CHECK (kind IN ('direct', 'relay'));

ALTER TABLE nodes ADD COLUMN entrance_seq integer DEFAULT 0 NOT NULL;
ALTER TABLE nodes ADD CONSTRAINT nodes_entrance_seq CHECK (entrance_seq BETWEEN 0 AND 32767);

ALTER TABLE entrances
    ADD COLUMN wire_no integer DEFAULT 0 NOT NULL,
    ADD COLUMN listen_port integer,
    ADD COLUMN source_cidrs cidr[] DEFAULT '{}'::cidr[] NOT NULL;

ALTER TABLE entrances ADD CONSTRAINT entrances_wire_no CHECK (
    (kind = 'direct' AND wire_no = 0) OR (kind = 'relay' AND wire_no BETWEEN 1 AND 32767));
ALTER TABLE entrances ADD CONSTRAINT entrances_listen_port CHECK (
    (kind = 'direct' AND listen_port IS NULL)
    OR (kind = 'relay' AND listen_port BETWEEN 1 AND 65535));
ALTER TABLE entrances ADD CONSTRAINT entrances_source_cidrs CHECK (
    (kind = 'direct' AND cardinality(source_cidrs) = 0)
    OR (kind = 'relay' AND cardinality(source_cidrs) BETWEEN 1 AND 64
        AND array_position(source_cidrs, NULL) IS NULL));
-- A relay is dialed at an explicit address.
ALTER TABLE entrances ADD CONSTRAINT entrances_relay_address CHECK (
    kind = 'direct' OR (connect_host IS NOT NULL AND connect_port IS NOT NULL));

ALTER TABLE ONLY entrances ADD CONSTRAINT entrances_wire_no_key UNIQUE (node_id, wire_no);
ALTER TABLE ONLY entrances ADD CONSTRAINT entrances_listen_port_key UNIQUE (node_id, listen_port);
