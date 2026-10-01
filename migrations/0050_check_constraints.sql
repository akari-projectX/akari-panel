-- B7: database-level guards for what the app already validates, so the CLI,
-- hand-written SQL and future code paths cannot store nonsense. Append-only;
-- every constraint is validated against existing rows.
ALTER TABLE users
    ADD CONSTRAINT users_role_valid CHECK (role IN ('admin', 'user')),
    ADD CONSTRAINT users_traffic_used_nonneg CHECK (traffic_used_bytes >= 0),
    ADD CONSTRAINT users_traffic_limit_nonneg CHECK (traffic_limit_bytes IS NULL OR traffic_limit_bytes >= 0);

ALTER TABLE nodes
    ADD CONSTRAINT nodes_status_valid CHECK (status IN ('pending', 'online', 'offline'));

ALTER TABLE traffic_counters
    ADD CONSTRAINT traffic_counters_nonneg CHECK (up_bytes >= 0 AND down_bytes >= 0);

ALTER TABLE node_users_departed
    ADD CONSTRAINT node_users_departed_billed_nonneg CHECK (billed_bytes >= 0);

ALTER TABLE node_users
    ADD CONSTRAINT node_users_credentials_array CHECK (jsonb_typeof(credentials) = 'array');
