-- W27 (v0.4 D7): passkeys (WebAuthn) and the login-method policies.
--
-- webauthn_credentials: one row per registered passkey. `rp_id` is the
-- relying-party id (the main domain's host) the credential was created for:
-- a browser only offers it there, so after a main-domain change the row is
-- kept but no longer counts (passkey::Rp, "current"). `passkey` is
-- webauthn-rs' serialized Passkey (public key + counter + backup flags; no
-- secret). Deleting the account deletes its passkeys.
--
-- users.password_login_disabled_at: the account's own choice "passkey
-- only" (set after binding a passkey from the login prompt, or on the
-- account page); it only takes effect while the account has a current
-- passkey, so a domain change or deleting the last passkey can never lock
-- anyone out.
--
-- auth_settings: passkey-only per role (same "while a current passkey
-- exists" rule) and the prompt to bind a passkey after a password login.

CREATE TABLE webauthn_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    rp_id text NOT NULL,
    cred_id bytea NOT NULL,
    passkey jsonb NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    CONSTRAINT webauthn_credentials_name CHECK ((char_length(name) BETWEEN 1 AND 64)),
    CONSTRAINT webauthn_credentials_cred_id CHECK ((octet_length(cred_id) BETWEEN 16 AND 1023)),
    CONSTRAINT webauthn_credentials_rp_id CHECK ((char_length(rp_id) BETWEEN 1 AND 253))
);

ALTER TABLE ONLY webauthn_credentials ADD CONSTRAINT webauthn_credentials_pkey PRIMARY KEY (id);
ALTER TABLE ONLY webauthn_credentials ADD CONSTRAINT webauthn_credentials_key UNIQUE (rp_id, cred_id);
CREATE INDEX webauthn_credentials_user ON webauthn_credentials USING btree (user_id);
ALTER TABLE ONLY webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE users ADD COLUMN password_login_disabled_at timestamp with time zone;

ALTER TABLE auth_settings
    ADD COLUMN passkey_only_admins boolean DEFAULT false NOT NULL,
    ADD COLUMN passkey_only_users boolean DEFAULT false NOT NULL,
    ADD COLUMN passkey_prompt boolean DEFAULT false NOT NULL;
