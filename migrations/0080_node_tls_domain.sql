-- W10: automatic node certificate (agent protocol 6, ACME).
--
-- tls_domain: the node's TLS domain ("节点域名"). Set = the agent obtains and
-- renews a certificate for it itself (ConfigSnapshot.acme) for the inbounds
-- that read the node certificate files, and templates default their
-- SNI/Host to it. NULL = the files the admin installs on the node (as
-- before). Changing it bumps config_version (apply_update_node). Lowercase
-- DNS name, at least two labels, no wildcard, no IP literal (the API checks
-- the same; this is the backstop).
--
-- agent_addr: source address of the agent's latest stream (gRPC peer, set
-- at Hello). Shown next to the certificate status and compared with what
-- the TLS domain resolves to ("域名未解析到本机 IP").
ALTER TABLE nodes
    ADD COLUMN tls_domain TEXT
        CHECK (tls_domain IS NULL OR (
            length(tls_domain) <= 253
            AND tls_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
            AND tls_domain !~ '^[0-9.]+$')),
    ADD COLUMN agent_addr INET;
