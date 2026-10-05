-- W28-a: relay entrance health. The panel TCP-connects to every enabled
-- relay entrance's address (`entrances::health_round`, any instance, rows
-- claimed with `health_next_at`); after `HEALTH_FAILURES` consecutive
-- failures the entrance is hidden from subscriptions and the portal
-- (`hidden_since`) and the node's `entrance_down` alert fires; the first
-- success restores it. The node keeps serving it (clients already
-- connected through the relay are not cut).

ALTER TABLE entrances
    ADD COLUMN health_next_at timestamp with time zone,
    ADD COLUMN health_at timestamp with time zone,
    ADD COLUMN health_ok boolean,
    ADD COLUMN health_failures integer DEFAULT 0 NOT NULL,
    ADD COLUMN health_error text,
    ADD COLUMN hidden_since timestamp with time zone;

ALTER TABLE entrances ADD CONSTRAINT entrances_health_failures CHECK (health_failures >= 0);
ALTER TABLE entrances ADD CONSTRAINT entrances_health_error CHECK (health_error IS NULL OR char_length(health_error) <= 200);
-- Only relays are probed and hidden.
ALTER TABLE entrances ADD CONSTRAINT entrances_health_relay CHECK (
    kind = 'relay' OR (health_at IS NULL AND hidden_since IS NULL));

CREATE INDEX entrances_health_due ON entrances USING btree (health_next_at) WHERE (kind = 'relay');

ALTER TABLE node_alerts DROP CONSTRAINT node_alerts_kind_check;
ALTER TABLE node_alerts ADD CONSTRAINT node_alerts_kind_check CHECK ((kind = ANY (ARRAY['offline'::text, 'cpu'::text, 'memory'::text, 'disk'::text, 'latency'::text, 'cert'::text, 'agent_cert'::text, 'last_error'::text, 'entrance_down'::text])));
