-- W27 (v0.4 D1 + D7, research/db-schema-review.md §3 D1/D7, Q4).
--
-- D1 email identity: everyone (admins too) logs in with the email address.
-- `users.login` is gone; `users.email` is NOT NULL and unique for every
-- account (verified or not: with "registration requires email
-- verification" off, an unverified address is still the login name).
--
-- Q4: money/audit snapshot columns no longer hold a login name (which would
-- now be an email address, i.e. personal data that the append-only ledger
-- could never forget). They hold a non-personal label instead
-- (`audit::user_label`: "u-" + the first 8 hex digits of the user id, or
-- cli/system/agent); displays join `users` for the current address.
--
-- D7: TOTP 2FA is removed (passkeys replace it): its two tables and the
-- "admins must use 2FA" setting go.

DROP TABLE user_recovery_codes;
DROP TABLE user_totp;
ALTER TABLE panel_settings DROP COLUMN require_admin_2fa;

DROP INDEX users_email_verified;
DROP INDEX users_email_prefix;
DROP INDEX users_login_prefix;
ALTER TABLE users DROP CONSTRAINT users_login_key;
ALTER TABLE users DROP COLUMN login;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
-- Prefix search of the admin user list (`lower(email) LIKE 'x%'`; emails
-- are stored lower-case, CHECK users_email_check).
CREATE INDEX users_email_prefix ON users USING btree (email text_pattern_ops);

ALTER TABLE orders RENAME COLUMN user_login TO user_label;
ALTER TABLE withdrawals RENAME COLUMN user_login TO user_label;
ALTER TABLE balance_ledger RENAME COLUMN user_login TO user_label;
ALTER TABLE balance_ledger RENAME COLUMN actor_login TO actor_label;
ALTER TABLE commissions RENAME COLUMN inviter_login TO inviter_label;
ALTER TABLE commissions RENAME COLUMN invitee_login TO invitee_label;
ALTER TABLE ticket_messages RENAME COLUMN author_login TO author_label;
ALTER TABLE admin_batch_items RENAME COLUMN user_login TO user_label;
ALTER TABLE admin_batch_jobs RENAME COLUMN actor_login TO actor_label;
ALTER TABLE coupon_batches RENAME COLUMN actor_login TO actor_label;
ALTER TABLE audit_log RENAME COLUMN actor_login TO actor_label;
ALTER INDEX audit_log_actor RENAME TO audit_log_actor_label;
