-- Phase A PR ① (ops-logic review 中-9, the refund part): the customer is
-- told when an order is refunded — how much went where and what happened to
-- the subscription (P1 revokes it). New mail kind `refund` (outbox and
-- editable templates) and a switch in 系统设置 → 邮件 (`notify_refund`,
-- default on, like the receipt).
ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check CHECK (kind IN (
    'register_code', 'register_exists', 'email_code', 'password_reset', 'order_paid',
    'expiry_soon', 'expired', 'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new',
    'node_alert', 'announcement', 'admin_notice', 'refund'));
ALTER TABLE mail_templates DROP CONSTRAINT mail_templates_kind_check;
ALTER TABLE mail_templates ADD CONSTRAINT mail_templates_kind_check CHECK (kind IN (
    'register_code', 'register_exists', 'email_code', 'password_reset', 'order_paid',
    'expiry_soon', 'expired', 'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new',
    'node_alert', 'announcement', 'admin_notice', 'refund'));
-- The settings row is `smtp_settings` until 1070 (W31) renames it; this
-- number sorts before 1070, so a fresh database adds the column before the
-- rename (it moves with the table) and an existing v0.4 dev database that
-- already ran 1070 adds it to `mail_settings`.
DO $$
BEGIN
    IF to_regclass('mail_settings') IS NOT NULL THEN
        ALTER TABLE mail_settings ADD COLUMN notify_refund boolean NOT NULL DEFAULT true;
    ELSE
        ALTER TABLE smtp_settings ADD COLUMN notify_refund boolean NOT NULL DEFAULT true;
    END IF;
END $$;
