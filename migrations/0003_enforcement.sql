-- Sprint 2: "disable means disabled".

-- users.expiry_enforced: the expiry pass already pushed this user's removal
-- (bumped their nodes). Reset whenever expires_at changes.
ALTER TABLE users ADD COLUMN expiry_enforced BOOLEAN NOT NULL DEFAULT false;

-- nodes.last_error*: the agent's last failed apply and the versions it was
-- attempting. Cleared only by an ok Ack for versions >= the failed ones.
ALTER TABLE nodes ADD COLUMN last_error TEXT;
ALTER TABLE nodes ADD COLUMN last_error_at TIMESTAMPTZ;
ALTER TABLE nodes ADD COLUMN failed_config_version BIGINT;
ALTER TABLE nodes ADD COLUMN failed_user_version BIGINT;

-- nodes.online_session: the gRPC session that last marked the node online.
-- Only that session may mark it offline (or refresh it), across instances.
ALTER TABLE nodes ADD COLUMN online_session UUID;
