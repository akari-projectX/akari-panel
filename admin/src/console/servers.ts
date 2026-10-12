// Servers and node groups as several pages read them (one cache entry;
// imported instead of reaching into another page's chunk).
import { useQuery } from "@tanstack/react-query";
import { get } from "../shared/api";
import type { Tr } from "../shared/i18n";
import type { Tone } from "../shared/ui/badge";
import type { NodeGroup, ServerView } from "./types";

export function useServers() {
  return useQuery({ queryKey: ["servers"], queryFn: () => get<ServerView[]>("/servers"), refetchInterval: 10_000 });
}
export function useGroups() {
  return useQuery({ queryKey: ["node-groups"], queryFn: () => get<NodeGroup[]>("/node-groups") });
}

export function serverState(s: ServerView, tr: Tr): [string, Tone] {
  if (s.deleting_at) return [tr("删除中", "Deleting"), "neutral"];
  if (!s.enrolled) return [tr("待安装", "Not installed"), "info"];
  if (s.traffic_quota.exceeded_at) return [tr("超额停用", "Over quota"), "danger"];
  if (s.online) return [tr("在线", "Online"), "success"];
  return [tr("离线", "Offline"), "danger"];
}
