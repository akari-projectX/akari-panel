-- Per-server switch: may users reach the machine's own private, loopback
-- and link-local addresses through the proxy (xray's freedom outbound
-- refuses them by default). Sent to the agent in ConfigSnapshot; changing it
-- bumps config_version (servers::apply_update).
ALTER TABLE servers ADD COLUMN allow_private_destinations boolean NOT NULL DEFAULT false;
