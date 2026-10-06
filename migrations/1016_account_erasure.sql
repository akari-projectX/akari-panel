-- PR ③ (W27 / D10): account erasure — self-service deletion and the
-- never-used account cleanup share one routine (erase.rs).
--
-- An account without finance records (orders, balance ledger, commissions,
-- withdrawals) is deleted. One with finance records is anonymized and kept
-- (the money's history stays attached to an account row): personal data is
-- removed, the address replaced by `erased-<id>@erased.invalid`, the
-- account disabled for good and stamped `erased_at`. It is disabled like a
-- ban (disabled_reason 'admin', without a note) — this migration runs
-- before 1053 on a fresh database, where the reason is still an enum, so
-- no new reason value — and every reader of a ban excludes erased accounts
-- (`erased_at IS NULL`). Nothing re-enables one (the CHECK below).

ALTER TABLE users ADD COLUMN erased_at timestamp with time zone;
ALTER TABLE users ADD CONSTRAINT users_erased CHECK ((erased_at IS NULL) OR (NOT enabled));
