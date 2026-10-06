-- Phase A PR ① (ops-logic review 低-4): an order remembers the subscription
-- the buyer had when it was created (`prior_user_plan_id`, NULL = none). A
-- payment that would replace a DIFFERENT subscription than that one (the
-- buyer bought or switched to another plan meanwhile, and an old order was
-- paid late) never silently replaces it: the payment goes to the balance
-- (billing::orders, same path as a sold-out plan). Numbered in this task's
-- spare block; independent of the migrations around it. Pending orders get
-- their buyer's current subscription (they behave as before).
ALTER TABLE orders ADD COLUMN prior_user_plan_id uuid REFERENCES user_plans (id) ON DELETE SET NULL;
CREATE INDEX orders_prior_user_plan ON orders USING btree (prior_user_plan_id)
    WHERE prior_user_plan_id IS NOT NULL;
UPDATE orders o SET prior_user_plan_id = up.id FROM user_plans up
    WHERE o.status = 'pending' AND up.user_id = o.user_id AND up.status = 'active';
