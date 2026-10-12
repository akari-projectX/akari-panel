// Servers, node groups and plans as several pages read them (one cache
// entry each; imported instead of reaching into another page's chunk). The
// keys start with the entity, so data.ts refetches them after any write that
// touches it (a plan saved refreshes the groups' plan lists and back).
import { useQuery } from "@tanstack/react-query";
import { get } from "../shared/api";
import type { Tr } from "../shared/i18n";
import type { Tone } from "../shared/ui/badge";
import type { NodeGroup, PlanView, ServerView } from "./types";

export const serversQuery = { queryKey: ["servers"], queryFn: () => get<ServerView[]>("/servers") };
export const groupsQuery = { queryKey: ["node-groups"], queryFn: () => get<NodeGroup[]>("/node-groups") };

export function useServers() {
  return useQuery({ ...serversQuery, refetchInterval: 10_000 });
}
export function useGroups() {
  return useQuery(groupsQuery);
}

export function usePlanList() {
  return useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
}

/**
 * Users who hold credentials on any of these entrances, from the plans'
 * current groups (one active plan per user, so the sum does not double
 * count). An estimate: subscriptions keep the groups they were bought with.
 */
export function holdersOf(entranceIds: string[], groups: NodeGroup[], plans: PlanView[]): number {
  const ids = new Set(entranceIds);
  const gs = new Set(groups.filter((g) => g.entrance_ids.some((e) => ids.has(e))).map((g) => g.id));
  return plans.filter((p) => p.group_ids.some((g) => gs.has(g))).reduce((n, p) => n + p.active_users, 0);
}

export function serverState(s: ServerView, tr: Tr): [string, Tone] {
  if (s.deleting_at) return [tr("删除中", "Deleting"), "neutral"];
  if (!s.enrolled) return [tr("待安装", "Not installed"), "info"];
  if (s.traffic_quota.exceeded_at) return [tr("超额停用", "Over quota"), "danger"];
  if (s.online) return [tr("在线", "Online"), "success"];
  return [tr("离线", "Offline"), "danger"];
}
