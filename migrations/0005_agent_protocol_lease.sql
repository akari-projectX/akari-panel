-- Sprint 3a. agent_protocol: Hello.protocol_version of the last connected
-- agent (0 = predates the field; below the panel's MIN_AGENT_PROTOCOL the
-- node is served the empty state and last_error says so).
-- lease_expires_at: when the fail-closed lease last granted to the node's
-- agent runs out (renewed after every successful desired-state read).
ALTER TABLE nodes ADD COLUMN agent_protocol INTEGER;
ALTER TABLE nodes ADD COLUMN lease_expires_at TIMESTAMPTZ;
