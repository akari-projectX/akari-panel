-- W24: 注册需要邮箱验证 (xboard-style optional verification).
-- NULL = automatic: required exactly when SMTP sending is enabled
-- (signup::verification_required). true/false = the admin's explicit
-- choice. With verification off, accounts register with an UNVERIFIED
-- address (login = address; email_verified_at NULL): such an address is not
-- unique, receives no mail, cannot be used for password reset and is not
-- matched by the email form of the login (the login name is).
ALTER TABLE signup_settings ADD COLUMN email_verify BOOLEAN;
