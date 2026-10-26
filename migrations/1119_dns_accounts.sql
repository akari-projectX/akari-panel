-- DNS management (PLAN-next「DNS 管理」): Cloudflare API tokens.
--
-- Cloudflare is the only source of truth for zones and records — nothing
-- of them is stored here. A row is one token (one Cloudflare account or a
-- token limited to some zones): `token_enc` is the token sealed with
-- data/master.key (`masterkey::Keys::seal`, AAD = the row id), the API only
-- ever shows that it is set plus `token_fingerprint` (first 12 hex digits of
-- its SHA-256), the audit log records it as "changed". Written by the owner
-- only (`dns::accounts`); `version` is the optimistic-concurrency counter.

CREATE TABLE dns_accounts (
    id uuid NOT NULL,
    name text NOT NULL,
    token_enc bytea NOT NULL,
    token_fingerprint text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dns_accounts_pkey PRIMARY KEY (id),
    CONSTRAINT dns_accounts_name CHECK (char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT dns_accounts_fingerprint CHECK (token_fingerprint ~ '^[0-9a-f]{12}$'),
    CONSTRAINT dns_accounts_version CHECK (version >= 1)
);

CREATE UNIQUE INDEX dns_accounts_name_key ON dns_accounts (lower(name));
