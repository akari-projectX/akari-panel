-- Subscription endpoint support (roadmap step 3).
-- nodes: public address clients dial for this node's inbounds.
ALTER TABLE nodes ADD COLUMN server_addr TEXT;

-- users: subscription token, stored hashed (sha256 of a 256-bit random).
ALTER TABLE users ADD COLUMN sub_token_hash TEXT UNIQUE;
