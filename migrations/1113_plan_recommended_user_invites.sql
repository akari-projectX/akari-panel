-- PR #132 follow-ups (2026-10-15).
--
-- `plans.recommended`: the operator marks a plan "推荐"; the portal shop
-- card shows a subtle tag and makes its button the primary one. Display
-- only — it changes no price, sale or entitlement rule. Default off.
--
-- `signup_settings.user_invites`: 允许用户邀请 (default on = the behaviour
-- before this migration). Off: users get no invite code (`GET
-- /me/invite-codes` returns none, `POST` → 409 `invite.disabled`) and no
-- existing code admits a registration (the same answer as an unknown code).
-- There are no admin-issued codes, so "invite code required" together with
-- user invites off would let nobody register: the API refuses that
-- combination while registration is open (`signup_admin.invites_needed`).

ALTER TABLE plans ADD COLUMN recommended boolean NOT NULL DEFAULT false;
ALTER TABLE signup_settings ADD COLUMN user_invites boolean NOT NULL DEFAULT true;

-- Exactly one invite code per user, enforced by the database (there are no
-- deployments to keep compatible with; 1112 kept accounts with several
-- codes): extra codes are deleted (the oldest stays) and the owner index
-- becomes unique.
DELETE FROM invite_codes c USING invite_codes k
 WHERE k.user_id = c.user_id AND (k.created_at, k.code) < (c.created_at, c.code);
DROP INDEX invite_codes_user;
CREATE UNIQUE INDEX invite_codes_user ON invite_codes (user_id);
