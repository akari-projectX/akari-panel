// Servers, nodes, entrances (v2 shots/nodes.json). The shared ctx has a
// server without an agent (ctx.serverId) with one node (ctx.nodeId) and a
// relay entrance (ctx.entranceId); the server-page tabs use the seeded
// online server (seed.ts, ctx.extra.liveServer). Not taken (need an agent, a failure or a
// state the e2e panel cannot reach on demand): nodes-fleet-empty / -loading /
// -error, nodes-server-offline, nodes-server-quota, nodes-server-quota-exceeded,
// nodes-server-probe-cooldown, nodes-server-monitor-error,
// nodes-server-alerts-error, nodes-new-node-3-check-failed,
// nodes-entrance-probe-failed.
import { expect, type Page } from "@playwright/test";

import { apiJson } from "../helpers";
import { go, goDialog, goto, need, type Ctx, type Device, type Shot } from "./shared";

const sid = (c: Ctx) => need(c.serverId, "server");
/** The seeded online server (seed.ts: heartbeat, metrics, traffic), else the shared one. */
const live = (c: Ctx) => c.extra.liveServer ?? sid(c);
const nid = (c: Ctx) => need(c.nodeId, "node");
const eid = (c: Ctx) => need(c.entranceId, "relay entrance");
const dlg = (page: Page) => page.getByRole("dialog").last();
const alert = (page: Page) => expect(page.getByRole("alertdialog")).toBeVisible();

/** A server of this shot's own (the add-server flow really creates one); the previous one is deleted first. */
async function addServer(page: Page, device: Device) {
  const name = `screens-new-${device}-${Date.now() % 100000}`;
  const old = await apiJson<{ id: string; name: string; deleting_at: string | null }[]>("GET", "/servers");
  for (const s of old)
    if (s.name.startsWith(`screens-new-${device}-`) && !s.deleting_at)
      await apiJson("DELETE", `/servers/${s.id}`).catch(() => undefined);
  await goto(page, "/nodes?new=server");
  await dlg(page).getByRole("textbox", { name: /^名称/ }).fill(name);
  await dlg(page).getByRole("button", { name: "生成安装命令" }).click();
  await expect(page.getByRole("dialog", { name: `安装 agent · ${name}` })).toBeVisible();
}

async function wizard(page: Page, c: Ctx, steps: number, json = false) {
  await goto(page, `/nodes/${sid(c)}?new=node&server=${sid(c)}`);
  const d = dlg(page);
  if (json) await d.getByRole("radio", { name: /^高级 JSON/ }).click();
  for (let i = 0; i < steps; i++) await d.getByRole("button", { name: "下一步" }).click();
  await expect(d.locator("[aria-current=step]")).toBeVisible();
}

async function entrance(page: Page, c: Ctx, etab = "") {
  await goto(page, `/nodes/${sid(c)}?entrance=${eid(c)}${etab ? `&etab=${etab}` : ""}`);
  await expect(dlg(page)).toBeVisible();
  return dlg(page);
}

export const shots: Shot[] = [
  { name: "nodes-fleet-default", open: go("/nodes") },
  { name: "nodes-fleet-full", open: go("/nodes"), full: true },
  { name: "nodes-fleet-search", open: go("/nodes?q=IPLC") },
  { name: "nodes-fleet-nomatch", open: go(`/nodes?q=${encodeURIComponent("首尔 Vultr")}`) },
  { name: "nodes-server-nodes", open: async (page, c) => goto(page, `/nodes/${live(c)}`), full: true },
  {
    name: "nodes-server-collapsed",
    open: async (page, c) => {
      // A pending server shows the install guide instead of its nodes.
      await goto(page, `/nodes/${live(c)}`);
      await page
        .getByRole("button", { name: /^收起 .* 的入口$/ })
        .first()
        .click();
    },
    full: true,
  },
  { name: "nodes-server-pending", open: async (page, c) => goto(page, `/nodes/${sid(c)}`) },
  { name: "nodes-server-monitor", open: async (page, c) => goto(page, `/nodes/${live(c)}?tab=monitor`), full: true },
  { name: "nodes-server-quota-tab", open: async (page, c) => goto(page, `/nodes/${live(c)}?tab=quota`) },
  {
    name: "nodes-server-quota-invalid",
    open: async (page, c) => {
      await goto(page, `/nodes/${live(c)}?tab=quota`);
      await page.getByRole("textbox", { name: /^每月重置日/ }).fill("32");
      await expect(page.getByText("请输入 1–31 的整数")).toBeVisible();
    },
  },
  {
    name: "nodes-server-alerts",
    open: async (page, c) => {
      await goto(page, `/nodes/${live(c)}?tab=alerts`);
      await page.getByRole("textbox", { name: /^离线多少秒告警/ }).fill("5");
    },
    full: true,
  },
  { name: "nodes-server-settings", open: async (page, c) => goto(page, `/nodes/${live(c)}?tab=settings`), full: true },
  { name: "nodes-add-server", open: goDialog(() => "/nodes?new=server") },
  { name: "nodes-add-server-command", open: async (page, _c, device) => addServer(page, device) },
  {
    name: "nodes-add-server-close-confirm",
    open: async (page, _c, device) => {
      await addServer(page, device);
      await dlg(page).getByRole("button", { name: "关闭", exact: true }).last().click();
      await expect(page.getByRole("dialog", { name: "确定已经复制安装命令？" })).toBeVisible();
    },
  },
  {
    name: "nodes-install-command",
    open: async (page, c) => {
      await goto(page, `/nodes/${sid(c)}?action=install`);
      await expect(
        dlg(page)
          .getByText(/\/install\//)
          .first(),
      ).toBeVisible();
    },
  },
  { name: "nodes-enroll-token", open: goDialog((c) => `/nodes/${sid(c)}?action=enroll`) },
  {
    name: "nodes-enroll-token-done",
    open: async (page, c) => {
      await goto(page, `/nodes/${sid(c)}?action=enroll`);
      await dlg(page).getByRole("button", { name: "生成注册令牌" }).click();
      await expect(dlg(page).getByText("引导文件（含一次性注册令牌，不含私钥）")).toBeVisible();
    },
  },
  {
    name: "nodes-tls-confirm",
    open: async (page, c) => {
      await goto(page, `/nodes/${live(c)}?tab=settings`);
      await page.getByRole("textbox", { name: /^TLS 域名/ }).fill("node.example.com");
      await page.getByRole("button", { name: /^保存并重建/ }).click();
      await alert(page);
    },
  },
  {
    name: "nodes-delete-server",
    open: async (page, c) => {
      await goto(page, `/nodes/${live(c)}?tab=settings`);
      await page.getByRole("button", { name: "删除服务器…" }).click();
      await alert(page);
    },
  },
  { name: "nodes-new-node-1-server", open: goDialog(() => "/nodes?new=node") },
  { name: "nodes-new-node-2-protocol", open: async (page, c) => wizard(page, c, 0) },
  { name: "nodes-new-node-3-reality", open: async (page, c) => wizard(page, c, 1) },
  { name: "nodes-new-node-3-json", open: async (page, c) => wizard(page, c, 1, true) },
  { name: "nodes-new-node-4-entrance", open: async (page, c) => wizard(page, c, 2) },
  { name: "nodes-node-basic", open: goDialog((c) => `/nodes/${sid(c)}?node=${nid(c)}`) },
  { name: "nodes-node-inbound", open: goDialog((c) => `/nodes/${sid(c)}?node=${nid(c)}&ntab=inbound`) },
  {
    name: "nodes-node-inbound-protocol",
    open: async (page, c) => {
      await goto(page, `/nodes/${sid(c)}?node=${nid(c)}&ntab=inbound`);
      await dlg(page).getByRole("button", { name: "从模板替换" }).click();
      await expect(dlg(page).getByText("协议会变化：")).toBeVisible();
    },
  },
  {
    name: "nodes-node-inbound-json",
    open: async (page, c) => {
      await goto(page, `/nodes/${sid(c)}?node=${nid(c)}&ntab=inbound`);
      await dlg(page).getByRole("button", { name: "编辑 JSON" }).click();
    },
  },
  { name: "nodes-node-audit", open: goDialog((c) => `/nodes/${sid(c)}?node=${nid(c)}&ntab=audit`) },
  {
    name: "nodes-node-protocol-confirm",
    open: async (page, c) => {
      await goto(page, `/nodes/${sid(c)}?node=${nid(c)}&ntab=inbound`);
      await dlg(page).getByRole("button", { name: "从模板替换" }).click();
      await dlg(page).getByRole("button", { name: /^保存/ }).click();
      await alert(page);
    },
  },
  {
    name: "nodes-node-block-on-confirm",
    open: async (page, c) => {
      await goto(page, `/nodes/${sid(c)}?node=${nid(c)}&ntab=audit`);
      const sw = dlg(page).getByRole("switch", { name: "出站拦截" });
      if ((await sw.getAttribute("aria-checked")) === "true") throw new Error("blocking is already on");
      await sw.click();
      await dlg(page).getByRole("button", { name: /^保存/ }).click();
      await alert(page);
    },
  },
  {
    name: "nodes-node-disable-confirm",
    open: async (page, c) => {
      await goto(page, `/nodes/${sid(c)}?node=${nid(c)}`);
      await dlg(page).getByRole("switch", { name: "启用节点" }).click();
      await alert(page);
    },
  },
  {
    name: "nodes-node-delete",
    open: async (page, c) => {
      await goto(page, `/nodes/${sid(c)}?node=${nid(c)}`);
      await dlg(page).getByRole("button", { name: "删除节点" }).click();
      await alert(page);
    },
  },
  { name: "nodes-entrance-connect", open: async (page, c) => void (await entrance(page, c)) },
  {
    name: "nodes-entrance-connect-warn",
    open: async (page, c) => {
      const d = await entrance(page, c);
      await d.getByRole("textbox", { name: /^连接地址/ }).fill("198.51.100.4");
      await d.getByRole("textbox", { name: "添加出口 IP / CIDR" }).fill("198.51.100.4");
      await expect(d.getByText(/连接地址也在出口列表里/)).toBeVisible();
    },
  },
  { name: "nodes-entrance-rate", open: async (page, c) => void (await entrance(page, c, "rate")) },
  {
    name: "nodes-entrance-rate-invalid",
    open: async (page, c) => {
      const d = await entrance(page, c, "rate");
      await d.getByRole("button", { name: "添加时段规则" }).click();
      await d.getByRole("button", { name: "添加时段规则" }).click();
      await d.getByLabel("规则 2 倍率").fill("");
      await expect(d.getByText("倍率不能为空")).toBeVisible();
    },
  },
  {
    name: "nodes-entrance-rate-blank",
    open: async (page, c) => {
      const d = await entrance(page, c, "rate");
      await d.getByRole("textbox", { name: /^基础倍率/ }).fill("");
      await expect(d.getByText(/倍率不能留空/)).toBeVisible();
    },
  },
  {
    name: "nodes-entrance-free-confirm",
    open: async (page, c) => {
      const d = await entrance(page, c, "rate");
      await d.getByRole("textbox", { name: /^基础倍率/ }).fill("0");
      await d.getByRole("button", { name: "保存", exact: true }).click();
      await alert(page);
    },
  },
  { name: "nodes-entrance-traffic", open: async (page, c) => void (await entrance(page, c, "traffic")) },
  {
    name: "nodes-entrance-conflict",
    open: async (page, c) => {
      const d = await entrance(page, c, "rate");
      // Someone else saves first (the API with the current version) …
      const servers = await apiJson<{ nodes: { entrances: { id: string; version: number; sort: number }[] }[] }[]>(
        "GET",
        "/servers",
      );
      const e = servers.flatMap((s) => s.nodes.flatMap((n) => n.entrances)).find((x) => x.id === eid(c));
      if (!e) throw new Error("no relay entrance");
      await apiJson("PATCH", `/entrances/${e.id}`, { sort: e.sort + 1, version: e.version });
      // … then this form saves with the version it was opened at.
      await d.getByRole("textbox", { name: /^基础倍率/ }).fill("2.5");
      await d.getByRole("button", { name: "保存", exact: true }).click();
      await expect(d.getByText("此入口已被他人修改。")).toBeVisible();
    },
  },
  {
    name: "nodes-entrance-delete",
    open: async (page, c) => {
      const d = await entrance(page, c);
      await d.getByRole("button", { name: "删除入口" }).click();
      await alert(page);
    },
  },
  { name: "nodes-add-relay", open: goDialog((c) => `/nodes/${sid(c)}?new=relay&for=${nid(c)}`) },
];
