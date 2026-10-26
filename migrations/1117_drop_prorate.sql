-- Audit 2026-10 (billing P3-2): akari_prorate was the only user of itself.
-- The switch credit is computed by billing::catalog::switch_credit (one SQL
-- statement, order by order, B1); the function had no caller and a test of
-- its own that did not cover the real arithmetic.
DROP FUNCTION IF EXISTS akari_prorate(bigint, integer, numeric, bigint);
