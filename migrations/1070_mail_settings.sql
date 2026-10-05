-- W31: mail transports. `smtp_settings` becomes `mail_settings` with a
-- provider: 'smtp' (host/port/security/credentials, as before) or 'resend'
-- (HTTPS API; `api_key_enc` = the API key sealed with the master key's
-- secrets AEAD, AAD `mail::RESEND_AAD`). Adding a provider = a module in
-- src/mail/transport/ + its id in mail_settings_provider.
ALTER TABLE smtp_settings RENAME TO mail_settings;
ALTER TABLE mail_settings RENAME CONSTRAINT smtp_settings_pkey TO mail_settings_pkey;
ALTER TABLE mail_settings RENAME CONSTRAINT smtp_settings_from_name_check TO mail_settings_from_name;
ALTER TABLE mail_settings RENAME CONSTRAINT smtp_settings_id_check TO mail_settings_single_row;
ALTER TABLE mail_settings RENAME CONSTRAINT smtp_settings_notify_expiry_days_check TO mail_settings_notify_expiry_days;
ALTER TABLE mail_settings RENAME CONSTRAINT smtp_settings_port_check TO mail_settings_port;
ALTER TABLE mail_settings RENAME CONSTRAINT smtp_settings_security_check TO mail_settings_security;
ALTER TABLE mail_settings RENAME CONSTRAINT smtp_settings_version_check TO mail_settings_version;
ALTER TABLE mail_settings RENAME CONSTRAINT smtp_plain_no_auth TO mail_settings_plain_no_auth;

ALTER TABLE mail_settings
    ADD COLUMN provider text NOT NULL DEFAULT 'smtp',
    ADD COLUMN api_key_enc bytea,
    ADD CONSTRAINT mail_settings_provider CHECK (provider IN ('smtp', 'resend'));

-- Enabled = complete for the chosen provider (a sender address always).
ALTER TABLE mail_settings DROP CONSTRAINT smtp_enabled_complete;
ALTER TABLE mail_settings ADD CONSTRAINT mail_settings_enabled_complete CHECK (
    NOT enabled OR (from_addr IS NOT NULL AND CASE provider
        WHEN 'smtp' THEN host IS NOT NULL
        WHEN 'resend' THEN api_key_enc IS NOT NULL
    END)
);
