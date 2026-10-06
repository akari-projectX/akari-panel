-- Phase A PR ① (ops-logic review 中-6): taking a plan off sale (`on_sale`
-- false) stops new purchases only — by default its current subscribers can
-- still renew it and buy its traffic reset pack (`renew_off_sale`, per
-- plan, the admin may switch it off). A disabled plan (`enabled` false) is
-- not sold at all. (Numbered in this task's spare block; independent of
-- the migrations around it.)
ALTER TABLE plans ADD COLUMN renew_off_sale boolean NOT NULL DEFAULT true;
