-- Mail kinds for actions an administrator takes on a customer's account
-- (ban / unban, plan change, withdrawal decision) and for credited invite
-- commissions, each with a settings toggle (default on).
ALTER TABLE mail_settings
    ADD COLUMN notify_ban boolean DEFAULT true NOT NULL,
    ADD COLUMN notify_plan_change boolean DEFAULT true NOT NULL,
    ADD COLUMN notify_withdrawal boolean DEFAULT true NOT NULL,
    ADD COLUMN notify_commission boolean DEFAULT true NOT NULL;

ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check CHECK (kind = ANY (ARRAY[
    'register_code', 'register_exists', 'email_code', 'password_reset', 'order_paid',
    'expiry_soon', 'expired', 'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new',
    'node_alert', 'announcement', 'admin_notice', 'refund', 'security_notice', 'login_code',
    'account_banned', 'account_unbanned', 'plan_changed', 'withdrawal_approved',
    'withdrawal_rejected', 'commission_credited']));

ALTER TABLE mail_templates DROP CONSTRAINT mail_templates_kind_check;
ALTER TABLE mail_templates ADD CONSTRAINT mail_templates_kind_check CHECK (kind = ANY (ARRAY[
    'register_code', 'register_exists', 'email_code', 'password_reset', 'order_paid',
    'expiry_soon', 'expired', 'quota_80', 'quota_100', 'test', 'ticket_reply', 'ticket_new',
    'node_alert', 'announcement', 'admin_notice', 'refund', 'security_notice', 'login_code',
    'account_banned', 'account_unbanned', 'plan_changed', 'withdrawal_approved',
    'withdrawal_rejected', 'commission_credited']));
