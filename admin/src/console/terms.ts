// Catalog period kinds (billing/catalog.rs PeriodKind) and their labels.
import type { Tr } from "../shared/i18n";

export const PERIODS = [
  "month",
  "quarter",
  "half_year",
  "year",
  "two_year",
  "three_year",
  "days",
  "onetime",
  "reset",
] as const;
export type Period = (typeof PERIODS)[number];
/** Terms an admin can assign (every kind but the reset pack). */
export const TERMS: Period[] = PERIODS.filter((p) => p !== "reset");

export function periodLabel(p: string, tr: Tr, days?: number | null): string {
  switch (p) {
    case "month":
      return tr("月付", "Monthly");
    case "quarter":
      return tr("季付", "Quarterly");
    case "half_year":
      return tr("半年付", "Half-yearly");
    case "year":
      return tr("年付", "Yearly");
    case "two_year":
      return tr("两年付", "2 years");
    case "three_year":
      return tr("三年付", "3 years");
    case "days":
      return days ? tr(`${days} 天`, `${days} days`) : tr("自定义天数", "Custom days");
    case "onetime":
      return days ? tr(`一次性 ${days} 天`, `One-time ${days} days`) : tr("一次性（永久）", "One-time (no expiry)");
    case "reset":
      return tr("流量重置包", "Traffic reset pack");
    default:
      return p;
  }
}

/** Traffic reset rule of a plan ("monthly" | "none" | "days-N"). */
export function resetLabel(p: string, tr: Tr): string {
  if (p === "monthly") return tr("每月重置", "Resets monthly");
  if (p === "none") return tr("不重置", "Never resets");
  const m = /^days-(\d+)$/.exec(p);
  return m ? tr(`每 ${m[1]} 天重置`, `Resets every ${m[1]} days`) : p;
}
