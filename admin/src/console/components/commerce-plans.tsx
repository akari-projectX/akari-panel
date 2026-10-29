// Plans and node groups (proposal-v2 §3 套餐看板 / 价格表 / 套餐编辑 / 节点组):
// the entrance index the board, the editor and the group pages share, and
// small helpers for prices. Real data only: entrances come from GET /servers
// (servers.ts), groups from GET /node-groups, plans from GET /plans.
import { useMemo } from "react";
import type { Tr } from "../../shared/i18n";
import type { NodeGroup, PlanPrice, PlanView, ServerView } from "../types";

/** One entrance as the plan pages show it. */
export type EntranceInfo = {
  id: string;
  /** Chip text: the node's name for its direct entrance, the entrance's own name for a relay. */
  name: string;
  /** "node · entrance" (checkbox names, titles). */
  full: string;
  kind: "direct" | "relay";
  rate: number;
  enabled: boolean;
  hidden: boolean;
  tags: string[];
  host: string | null;
  port: number | null;
  serverId: string;
  serverName: string;
  groupIds: string[];
};

/** Entrance id → entrance, from the servers list (every server, node and entrance). */
export function useEntranceIndex(servers: ServerView[] | undefined): Map<string, EntranceInfo> {
  return useMemo(() => {
    const m = new Map<string, EntranceInfo>();
    for (const s of servers ?? [])
      for (const n of s.nodes)
        for (const e of n.entrances) {
          const node = n.display_name || n.name;
          m.set(e.id, {
            id: e.id,
            name: e.kind === "relay" ? e.name : node,
            full: `${n.name} · ${e.name}`,
            kind: e.kind,
            rate: e.rate,
            enabled: e.enabled && n.enabled,
            hidden: !!e.hidden_since,
            tags: e.tags,
            host: e.connect_host,
            port: e.connect_port ?? n.port,
            serverId: s.id,
            serverName: s.name,
            groupIds: e.group_ids,
          });
        }
    return m;
  }, [servers]);
}

/** "×1.5" for a multiplier other than 1. */
export function rateText(rate: number): string | undefined {
  return rate === 1 ? undefined : `×${rate}`;
}

/** The distinct entrance ids of some groups. */
export function entrancesOf(groupIds: string[], groups: NodeGroup[]): string[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  return [...new Set(groupIds.flatMap((g) => byId.get(g)?.entrance_ids ?? []))];
}

/** Known entrances of these ids grouped by server (servers by name, entrances in list order). */
export function byServer(
  ids: string[],
  idx: Map<string, EntranceInfo>,
): { serverId: string; serverName: string; list: EntranceInfo[] }[] {
  const m = new Map<string, { serverId: string; serverName: string; list: EntranceInfo[] }>();
  for (const id of ids) {
    const e = idx.get(id);
    if (!e) continue;
    const row = m.get(e.serverId) ?? { serverId: e.serverId, serverName: e.serverName, list: [] };
    row.list.push(e);
    m.set(e.serverId, row);
  }
  return [...m.values()].sort((a, b) => a.serverName.localeCompare(b.serverName));
}

/** A group's facts: entrances, servers, relays (known entrances only). */
export function groupFacts(g: NodeGroup, idx: Map<string, EntranceInfo>) {
  const ents = g.entrance_ids.map((id) => idx.get(id)).filter((e): e is EntranceInfo => !!e);
  return {
    count: ents.length,
    servers: new Set(ents.map((e) => e.serverId)).size,
    relays: ents.filter((e) => e.kind === "relay").length,
  };
}

/** Active subscriptions of the plans that grant a group (one active plan per user: no double count). */
export function groupSubscribers(g: NodeGroup, plans: PlanView[]): number {
  return plans.filter((p) => p.group_ids.includes(g.id)).reduce((n, p) => n + p.active_users, 0);
}

/** Cents → the yuan text an input starts with ("25", "25.5", "25.05"). */
export function yuanRaw(cents: number): string {
  return (cents / 100)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
}

/** Short price-chip label of a period ("月", "季", "30 天", "重置包"). */
export function periodShort(p: PlanPrice, tr: Tr): string {
  switch (p.period) {
    case "month":
      return tr("月", "Mo");
    case "quarter":
      return tr("季", "Qtr");
    case "half_year":
      return tr("半年", "6 mo");
    case "year":
      return tr("年", "Yr");
    case "two_year":
      return tr("两年", "2 yr");
    case "three_year":
      return tr("三年", "3 yr");
    case "days":
      return tr(`${p.days ?? "?"} 天`, `${p.days ?? "?"} d`);
    case "onetime":
      return p.days ? tr(`一次性 ${p.days} 天`, `Once ${p.days} d`) : tr("一次性", "Once");
    case "reset":
      return tr("重置包", "Reset");
    default:
      return p.period;
  }
}

/** Nominal days of the calendar periods (docs/PAYMENTS.md W7), for "per month" hints. */
export const NOMINAL_DAYS: Record<string, number> = {
  month: 30,
  quarter: 90,
  half_year: 180,
  year: 365,
  two_year: 730,
  three_year: 1095,
};

/** A plan is shown in the portal: enabled, on sale and priced for something other than the reset pack. */
export function listed(p: PlanView): boolean {
  return p.enabled && p.on_sale && p.prices.some((x) => x.period !== "reset");
}

/** The first line of a plan description as plain text (the description is Markdown: drop list/heading/quote markers and emphasis). */
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s*(?:[-*+]\s+|\d+\.\s+|#+\s+|>\s*)/, "")
          .replace(/\*\*|__|`/g, "")
          .trim(),
      )
      .find(Boolean) ?? ""
  );
}
