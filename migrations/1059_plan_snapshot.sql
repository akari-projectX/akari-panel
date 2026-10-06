-- Phase A PR ① (ops-logic review 中-5): a subscription keeps the plan terms
-- it was bought with. The quota, traffic reset policy, speed limit and node
-- groups are copied onto the subscription when it is created (any path:
-- order, admin assignment, trial — the triggers below), and the panel reads
-- them from there (`users.traffic_limit_bytes`, resets, the agents' speed
-- limit, the reconcile's granted entrances). Editing a plan changes what
-- new purchases get; an admin may also apply the edit to the plan's current
-- subscribers ("同时应用到现有用户", with an impact preview, audited). The
-- groups' members (entrances) stay live: infrastructure, not plan terms.
ALTER TABLE user_plans ADD COLUMN quota_bytes bigint;
ALTER TABLE user_plans ADD COLUMN reset_period text;
ALTER TABLE user_plans ADD COLUMN reset_days integer;
ALTER TABLE user_plans ADD COLUMN speed_limit_mbps integer;
UPDATE user_plans up SET quota_bytes = p.traffic_quota_bytes, reset_period = p.reset_period,
    reset_days = p.reset_days, speed_limit_mbps = p.speed_limit_mbps
    FROM plans p WHERE p.id = up.plan_id;
ALTER TABLE user_plans ALTER COLUMN reset_period SET NOT NULL;
ALTER TABLE user_plans ADD CONSTRAINT user_plans_quota_bytes CHECK (quota_bytes >= 0);
ALTER TABLE user_plans ADD CONSTRAINT user_plans_reset_period
    CHECK (reset_period IN ('monthly', 'days', 'none'));
ALTER TABLE user_plans ADD CONSTRAINT user_plans_reset_days
    CHECK ((reset_period = 'days') = (reset_days IS NOT NULL) AND reset_days BETWEEN 1 AND 3650);
ALTER TABLE user_plans ADD CONSTRAINT user_plans_speed_limit_mbps CHECK (speed_limit_mbps > 0);

-- The node groups a subscription grants (the reconcile reads these, not
-- plan_groups). A deleted group goes from every snapshot.
CREATE TABLE user_plan_groups (
    user_plan_id uuid NOT NULL REFERENCES user_plans (id) ON DELETE CASCADE,
    group_id uuid NOT NULL REFERENCES node_groups (id) ON DELETE CASCADE,
    PRIMARY KEY (user_plan_id, group_id)
);
CREATE INDEX user_plan_groups_group ON user_plan_groups USING btree (group_id);
INSERT INTO user_plan_groups (user_plan_id, group_id)
    SELECT up.id, pg.group_id FROM user_plans up JOIN plan_groups pg ON pg.plan_id = up.plan_id;

-- Snapshot at creation: a new subscription without explicit terms takes the
-- plan's (BEFORE INSERT), and the plan's groups (AFTER INSERT).
CREATE FUNCTION akari_user_plan_terms() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.reset_period IS NULL THEN
        SELECT p.traffic_quota_bytes, p.reset_period, p.reset_days, p.speed_limit_mbps
            INTO NEW.quota_bytes, NEW.reset_period, NEW.reset_days, NEW.speed_limit_mbps
            FROM plans p WHERE p.id = NEW.plan_id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER user_plans_terms BEFORE INSERT ON user_plans
    FOR EACH ROW EXECUTE FUNCTION akari_user_plan_terms();

CREATE FUNCTION akari_user_plan_groups() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO user_plan_groups (user_plan_id, group_id)
        SELECT NEW.id, pg.group_id FROM plan_groups pg WHERE pg.plan_id = NEW.plan_id;
    RETURN NULL;
END $$;
CREATE TRIGGER user_plans_groups AFTER INSERT ON user_plans
    FOR EACH ROW EXECUTE FUNCTION akari_user_plan_groups();
