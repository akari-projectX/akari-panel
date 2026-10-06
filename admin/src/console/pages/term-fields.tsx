// D12: plan + term (catalog period kind without the reset pack, days where
// the kind takes them). Mirrors plans::Term / AssignPlanReq.
import { useTr, type Tr } from "../../shared/i18n";
import { Field, Input, Select } from "../../shared/ui/primitives";
import { TERMS, periodLabel } from "../terms";
import type { PlanView } from "../types";

export type TermForm = { planId: string; period: string; days: string };
export const EMPTY_TERM: TermForm = { planId: "", period: "month", days: "" };

export function termDaysRule(period: string): "required" | "optional" | "none" {
  return period === "days" ? "required" : period === "onetime" ? "optional" : "none";
}

/** `{plan_id, period, days?}` or an error text. */
export function termBody(
  f: TermForm,
  tr: Tr,
  needPlan = true,
): { plan_id: string; period: string; days?: number } | string {
  if (needPlan && !f.planId) return tr("请选择套餐", "Choose a plan");
  const rule = termDaysRule(f.period);
  const t = f.days.trim();
  if (rule === "none" || (rule === "optional" && t === "")) return { plan_id: f.planId, period: f.period };
  const n = Number(t);
  if (!/^\d{1,4}$/.test(t) || n < 1 || n > 3650) return tr("天数须为 1–3650 的整数", "Days must be 1–3650");
  return { plan_id: f.planId, period: f.period, days: n };
}

export function TermFields({
  form,
  onChange,
  plans,
  withPlan = true,
  allowNone,
}: {
  form: TermForm;
  onChange: (f: TermForm) => void;
  plans: PlanView[];
  withPlan?: boolean;
  /** Offer "no plan" (new user). */
  allowNone?: boolean;
}) {
  const tr = useTr();
  const rule = termDaysRule(form.period);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {withPlan && (
        <Field label={tr("套餐", "Plan")} className="sm:col-span-3">
          <Select value={form.planId} onChange={(e) => onChange({ ...form, planId: e.target.value })}>
            <option value="">{allowNone ? tr("暂不分配", "No plan for now") : tr("请选择…", "Choose…")}</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.enabled}>
                {p.name}
                {!p.enabled ? tr("（已停用）", " (disabled)") : ""}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {(!allowNone || form.planId) && (
        <>
          <Field label={tr("时长", "Term")} className="sm:col-span-2">
            <Select value={form.period} onChange={(e) => onChange({ ...form, period: e.target.value })}>
              {TERMS.map((p) => (
                <option key={p} value={p}>
                  {p === "onetime"
                    ? tr("一次性（天数留空 = 永久）", "One-time (empty days = no expiry)")
                    : periodLabel(p, tr)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr("天数", "Days")}>
            <Input
              inputMode="numeric"
              value={form.days}
              disabled={rule === "none"}
              placeholder={rule === "optional" ? tr("永久", "none") : rule === "none" ? "—" : "30"}
              onChange={(e) => onChange({ ...form, days: e.target.value })}
            />
          </Field>
        </>
      )}
    </div>
  );
}
