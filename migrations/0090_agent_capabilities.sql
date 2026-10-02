-- W12: the optional features the last connected agent advertised in its
-- Hello (Hello.capabilities, e.g. {metrics,latency}), recorded with
-- agent_protocol. NULL = no agent has said hello since this column exists.
-- The admin node view shows it; smoke gates agent-dependent sections on it.
ALTER TABLE nodes ADD COLUMN agent_capabilities TEXT[];
