-- next-version: passkeys across domains (Related Origin Requests) and
-- registering with a passkey.
--
-- panel_settings.passkey_domain: the passkey centre — a dedicated domain
-- that is the WebAuthn RP ID and serves /.well-known/webauthn listing every
-- main domain (NULL = no centre: the preferred main domain is the RP, as
-- before). The API keeps it different from every main / subscription / node
-- domain (both writers hold the panel_settings row lock).
--
-- users.signup_method: how the account came to be ('password' = the
-- registration form / admin / CLI, 'passkey' = registered with a passkey).
-- users.email_pending: a passkey registration creates the account before the
-- address is known; until the owner binds one, `email` is a placeholder
-- (pending-<id>@pending.invalid, never verified, never mailed) and the
-- session reaches only the binding endpoints. Pending accounts are removed
-- after PENDING_EMAIL_HOURS (reaper).
--
-- signup_settings.passkey_register: the registration page offers "register
-- with a passkey" (default off).

ALTER TABLE panel_settings ADD COLUMN passkey_domain text;
ALTER TABLE panel_settings ADD CONSTRAINT panel_settings_passkey_domain CHECK (
    passkey_domain IS NULL OR (char_length(passkey_domain) BETWEEN 1 AND 300));

ALTER TABLE users ADD COLUMN signup_method text NOT NULL DEFAULT 'password';
ALTER TABLE users ADD CONSTRAINT users_signup_method CHECK (signup_method IN ('password', 'passkey'));
ALTER TABLE users ADD COLUMN email_pending boolean NOT NULL DEFAULT false;
-- A pending account has a placeholder address, no verified address and
-- came in with a passkey; role user only.
ALTER TABLE users ADD CONSTRAINT users_email_pending CHECK (
    NOT email_pending OR (
        role = 'user' AND signup_method = 'passkey' AND email_verified_at IS NULL
        AND email = 'pending-' || id::text || '@pending.invalid'));
CREATE INDEX users_email_pending_created ON users (created_at) WHERE email_pending;

ALTER TABLE signup_settings ADD COLUMN passkey_register boolean NOT NULL DEFAULT false;
