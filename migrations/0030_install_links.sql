-- R18-2: one-line node installer.
--
-- An install link is a node's enrollment token issued through the install
-- flow: GET /{prefix}/install/<token> serves a shell script carrying that
-- same token (and the agent binary under .../agent/<arch>), so the link
-- dies exactly when the agent enrolls with it (single use) or when it
-- expires (install.token_ttl_secs, default 1 h). Tokens issued for a
-- bootstrap file (CLI `node add`, "enrollment token") have install_origin
-- NULL and are never served as a script.
--
-- install_origin: the panel origin the script downloads from
--   ("https://host[:port]", no path), fixed when the link is issued.
-- install_pin:    curl --pinnedpubkey value ("sha256//<base64>") when the
--   origin's certificate is not publicly trusted; NULL = plain TLS.
ALTER TABLE node_enrollments
    ADD COLUMN install_origin TEXT,
    ADD COLUMN install_pin TEXT,
    ADD CONSTRAINT node_enrollments_pin_needs_origin
        CHECK (install_pin IS NULL OR install_origin IS NOT NULL);
