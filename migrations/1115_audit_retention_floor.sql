-- Audit-batch-2 P2-4: the audit trail keeps at least 90 days (0 = forever).
-- A shorter window would let a bad change's trail expire before anyone looks.
UPDATE panel_settings SET audit_retention_days = 90
 WHERE audit_retention_days BETWEEN 1 AND 89;
ALTER TABLE panel_settings DROP CONSTRAINT panel_settings_audit_retention_days_check;
ALTER TABLE panel_settings ADD CONSTRAINT panel_settings_audit_retention_days_check
    CHECK (audit_retention_days = 0 OR audit_retention_days BETWEEN 90 AND 36500);
