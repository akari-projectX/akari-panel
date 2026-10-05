// D12 (W28-c): an admin assigns a plan only as plan + term (a catalogue
// period kind without the reset pack, plus days where the kind takes
// them), or extends a periodic subscription by N days. Mirrors
// `plans::Term` / `AssignPlanReq` / `RenewUserPlanReq` in src/plans.rs.

import { PERIOD_KINDS, periodZh, type PeriodKind } from "./billing";

export type TermKind = Exclude<PeriodKind, "reset">;

/** Term kinds in catalogue order. */
export const TERM_KINDS: readonly TermKind[] = PERIOD_KINDS.filter((k): k is TermKind => k !== "reset");

/** The option label of a term kind (days entered separately). */
export function termKindZh(kind: TermKind): string {
  if (kind === "days") return "自定义天数";
  if (kind === "onetime") return "一次性（填天数，留空 = 永久）";
  return periodZh(kind, null);
}

/** Whether the kind takes days: required, optional or never. */
export function termDays(kind: TermKind): "required" | "optional" | "none" {
  return kind === "days" ? "required" : kind === "onetime" ? "optional" : "none";
}

/** `{period, days?}` for the request, or a Chinese error. */
export function termBody(kind: TermKind, daysText: string): { period: TermKind; days?: number } | string {
  const rule = termDays(kind);
  const text = daysText.trim();
  if (rule === "none" || (rule === "optional" && text === "")) return { period: kind };
  const days = Number(text);
  if (!/^\d{1,4}$/.test(text) || days < 1 || days > 3650) return "天数须为 1–3650 的整数";
  return { period: kind, days };
}

/** Days for "延长 N 天", or a Chinese error. */
export function extendDays(text: string): number | string {
  const t = text.trim();
  const n = Number(t);
  if (!/^\d{1,4}$/.test(t) || n < 1 || n > 3650) return "天数须为 1–3650 的整数";
  return n;
}
