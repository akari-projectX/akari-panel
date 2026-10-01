-- R18 (2026-10-02): the one-time admin 2FA enrollment code (M1c, 0011) is
-- gone — admin 2FA is optional (recommended), and with
-- `auth.require_admin_2fa` an admin enrolls with the password-step session
-- alone. The table only ever held SHA-256 hashes of short-lived single-use
-- codes; nothing reads it any more, so it is dropped rather than left as
-- dead schema.
DROP TABLE IF EXISTS totp_enroll_codes;
