// 节点表单的 xboard 式字段（W11）：显示名称、排序、对用户显示、标签、倍率、
// 节点组，以及每个入站的连接地址/连接端口。后台只做中文。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { get, patch, type ConnectOverride, type GroupView, type Inbound, type NodeView } from "../lib/api";
import { adminErrorText } from "../lib/errors";
import { humanBytes } from "../lib/utils";

export interface NodeOpsValue {
  displayName: string;
  sort: string;
  visible: boolean;
  tags: string;
  rate: string;
  groupIds: string[];
}

export function emptyOps(): NodeOpsValue {
  return { displayName: "", sort: "0", visible: true, tags: "", rate: "1", groupIds: [] };
}

export function opsFromNode(n: NodeView): NodeOpsValue {
  return {
    displayName: n.display_name ?? "",
    sort: String(n.sort),
    visible: n.visible,
    tags: n.tags.join(", "),
    rate: String(n.traffic_rate),
    groupIds: [...n.group_ids],
  };
}

/** Tags typed as "香港, IPLC，0.5x" (comma, Chinese comma or 、). */
export function parseTags(s: string): string[] {
  return s
    .split(/[,，、]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** The API body for these fields, or an error message. */
export function opsToBody(v: NodeOpsValue): Record<string, unknown> | string {
  const rate = Number(v.rate.trim());
  if (!v.rate.trim() || !Number.isFinite(rate) || rate < 0 || rate > 100) return "倍率须为 0–100 之间的数字";
  if (Math.abs(rate * 1000 - Math.round(rate * 1000)) > 1e-6) return "倍率最多 3 位小数";
  const sort = Number(v.sort.trim() || "0");
  if (!Number.isInteger(sort)) return "排序须为整数";
  const tags = parseTags(v.tags);
  if (tags.length > 8) return "标签最多 8 个";
  if (tags.some((t) => t.includes("|"))) return "标签不能包含 |";
  return {
    display_name: v.displayName.trim() || null,
    sort,
    visible: v.visible,
    tags,
    traffic_rate: rate,
    group_ids: v.groupIds,
  };
}

/** Only the fields that differ from a new node's defaults (create form). */
export function changedFromDefaults(body: Record<string, unknown>): Record<string, unknown> {
  const defaults = opsToBody(emptyOps()) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults[k])));
}

/** 显示名称 / 排序 / 显示 / 标签 / 倍率 / 节点组 (controlled). */
export function NodeOpsFields({
  value,
  onChange,
  idPrefix,
}: {
  value: NodeOpsValue;
  onChange: (v: NodeOpsValue) => void;
  idPrefix: string;
}) {
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => get<GroupView[]>("/node-groups") });
  const set = (p: Partial<NodeOpsValue>) => onChange({ ...value, ...p });
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={id("display")}>显示名称（用户可见）</Label>
          <Input
            id={id("display")}
            className="w-48"
            value={value.displayName}
            maxLength={64}
            placeholder="留空 = 节点名称"
            onChange={(e) => set({ displayName: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("tags")}>标签（逗号分隔）</Label>
          <Input
            id={id("tags")}
            className="w-56"
            value={value.tags}
            placeholder="香港, IPLC"
            onChange={(e) => set({ tags: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("rate")}>倍率</Label>
          <Input
            id={id("rate")}
            className="w-24"
            inputMode="decimal"
            value={value.rate}
            onChange={(e) => set({ rate: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("sort")}>排序</Label>
          <Input
            id={id("sort")}
            className="w-20"
            inputMode="numeric"
            value={value.sort}
            onChange={(e) => set({ sort: e.target.value })}
          />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" checked={value.visible} onChange={(e) => set({ visible: e.target.checked })} />
          对用户显示
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        倍率：用户流量按「实际用量 × 倍率」计费（如 0.5 = 半价，2 = 双倍，0 =
        免费）。隐藏的节点照常为已授权用户服务，只是不出现在用户的节点列表与订阅里。
      </p>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">节点组</legend>
        {groups.isPending ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : (groups.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有节点组（在「套餐」页创建）。</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {(groups.data ?? []).map((g) => (
              <label key={g.id} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={value.groupIds.includes(g.id)}
                  onChange={(e) =>
                    set({
                      groupIds: e.target.checked ? [...value.groupIds, g.id] : value.groupIds.filter((x) => x !== g.id),
                    })
                  }
                />
                {g.name}
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">套餐授权节点组：加入组后，持有对应套餐的用户即可使用此节点。</p>
      </fieldset>
    </div>
  );
}

type OverrideRows = Record<string, { host: string; port: string }>;

function overrideRows(inbounds: Inbound[], stored: Record<string, ConnectOverride>): OverrideRows {
  const out: OverrideRows = {};
  for (const i of inbounds) {
    const o = stored[i.tag] ?? {};
    out[i.tag] = { host: o.host ?? "", port: o.port != null ? String(o.port) : "" };
  }
  return out;
}

/** The connect_overrides body, or an error message. */
export function overridesToBody(rows: OverrideRows): Record<string, ConnectOverride> | string {
  const out: Record<string, ConnectOverride> = {};
  for (const [tag, r] of Object.entries(rows)) {
    const host = r.host.trim();
    const portText = r.port.trim();
    const o: ConnectOverride = {};
    if (host) o.host = host;
    if (portText) {
      const p = Number(portText);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return `入站 ${tag}：端口须为 1–65535`;
      o.port = p;
    }
    if (o.host || o.port) out[tag] = o;
  }
  return out;
}

/** 展示与计费：the W11 fields of an existing node, saved with one PATCH. */
export function NodeOpsCard({ node }: { node: NodeView }) {
  const queryClient = useQueryClient();
  const [ops, setOps] = useState<NodeOpsValue>(() => opsFromNode(node));
  const [rows, setRows] = useState<OverrideRows>(() => overrideRows(node.xray_inbounds, node.connect_overrides));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const body = opsToBody(ops);
    if (typeof body === "string") return setMsg({ ok: false, text: body });
    const overrides = overridesToBody(rows);
    if (typeof overrides === "string") return setMsg({ ok: false, text: overrides });
    setBusy(true);
    try {
      await patch(`/nodes/${node.id}`, { ...body, connect_overrides: overrides });
      setMsg({ ok: true, text: "已保存" });
      await queryClient.invalidateQueries({ queryKey: ["nodes"] });
    } catch (err) {
      setMsg({ ok: false, text: adminErrorText(err, "保存失败") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>展示与计费「{node.name}」</h2>
        </CardTitle>
        <CardDescription>
          这些设置不会重建节点、不会断开连接。累计流量：实际 {humanBytes(node.traffic_raw_bytes)} · 计费{" "}
          {humanBytes(node.traffic_billed_bytes)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={save}>
          <NodeOpsFields value={ops} onChange={setOps} idPrefix={`ops-${node.id}`} />
          <div className="space-y-2">
            <p className="text-sm font-medium">连接地址 / 连接端口</p>
            <p className="text-xs text-muted-foreground">
              客户端连接的地址/端口与节点监听的不同时填写（NAT、端口转发、中转）。留空 = 公网地址「
              {node.server_addr ?? "未设置"}」与入站端口。三种订阅格式与面板测速都使用这里的值。
            </p>
            {node.xray_inbounds.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有入站。</p>
            ) : (
              node.xray_inbounds.map((i) => (
                <div key={i.tag} className="flex flex-wrap items-end gap-3">
                  <span className="w-40 truncate pb-2 text-sm" title={i.tag}>
                    {i.tag}
                    <span className="ml-1 text-xs text-muted-foreground">:{String(i.port ?? "")}</span>
                  </span>
                  <div className="space-y-1.5">
                    <Label htmlFor={`ov-host-${node.id}-${i.tag}`}>连接地址</Label>
                    <Input
                      id={`ov-host-${node.id}-${i.tag}`}
                      className="w-56"
                      value={rows[i.tag]?.host ?? ""}
                      placeholder={node.server_addr ?? "relay.example.com"}
                      onChange={(e) => setRows({ ...rows, [i.tag]: { ...rows[i.tag], host: e.target.value } })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`ov-port-${node.id}-${i.tag}`}>连接端口</Label>
                    <Input
                      id={`ov-port-${node.id}-${i.tag}`}
                      className="w-28"
                      inputMode="numeric"
                      value={rows[i.tag]?.port ?? ""}
                      placeholder={String(i.port ?? "")}
                      onChange={(e) => setRows({ ...rows, [i.tag]: { ...rows[i.tag], port: e.target.value } })}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" variant="outline" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
            {msg && (
              <span
                role={msg.ok ? "status" : "alert"}
                className={`text-sm ${msg.ok ? "text-emerald-600" : "text-destructive"}`}
              >
                {msg.text}
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
