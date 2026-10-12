// INVENTORY §10 (servers, nodes, entrances) and §11 (plans, node groups).
// v2: the fleet overview (/nodes: needs-attention list, server rows that
// link to the server page, grouped search, filters 全部 / 需要关注 / 正常),
// the server page (/nodes/<id>: tabs 节点与入口 / 监控 / 流量额度 / 告警规则 /
// 设置) and URL-driven dialogs (?new=, ?node=&ntab=, ?entrance=&etab=,
// ?action=install|enroll).
import { expect, test, type Page } from "@playwright/test";

import { ADMIN, apiJson, confirmDialog, dialog, openConsole, sql, toast, uniq } from "./helpers";

test.describe.configure({ mode: "serial" });

const serverRow = (page: Page, name: string) => page.locator(`[data-server="${name}"]`);
const nodeCard = (page: Page, name: string) => page.locator(`section[data-node="${name}"]`);
const tab = (page: Page, name: string | RegExp) =>
  page.getByRole("tablist", { name: "服务器" }).getByRole("tab", { name });
const box = (scope: ReturnType<typeof dialog> | Page, name: RegExp) => scope.getByRole("textbox", { name });

async function menu(page: Page, label: string, item: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function openServer(page: Page, name: string) {
  await serverRow(page, name).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test("NOD-01 NOD-02 NOD-03 NOD-04 NOD-05 NOD-06 NOD-07 NOD-08 NOD-09: servers — add with an install command, reissue, settings, quota, alert rules, monitor, delete", async ({
  page,
}, info) => {
  const name = uniq(info, "srv");
  await openConsole(page, "/nodes");
  // NOD-03: name + TLS domain → the one-time install command (step 2).
  await page.getByRole("button", { name: "添加服务器" }).first().click();
  let d = dialog(page, "添加服务器");
  await box(d, /^名称/).fill(name);
  await d.getByRole("button", { name: "生成安装命令" }).click();
  await toast(page, "服务器已添加");
  d = dialog(page, `安装 agent · ${name}`);
  await expect(d.getByText("只显示这一次。")).toBeVisible();
  await expect(d.getByText(/\/install\//).first()).toBeVisible();
  await expect(d.getByText("等待 agent 首次连接…")).toBeVisible();
  await expect(d.getByRole("button", { name: "在此服务器添加节点" })).toBeDisabled();
  // Closing before the agent connected asks first; 返回复制 has the focus.
  await d.getByRole("button", { name: "关闭", exact: true }).last().click();
  const ask = dialog(page, "确定已经复制安装命令？");
  await expect(ask.getByRole("button", { name: "返回复制" })).toBeFocused();
  await ask.getByRole("button", { name: "返回复制" }).click();
  d = dialog(page, `安装 agent · ${name}`);
  await d.getByRole("button", { name: "关闭", exact: true }).last().click();
  await dialog(page, "确定已经复制安装命令？").getByRole("button", { name: "仍然关闭" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // NOD-01 / NOD-02: the row (a link to the server page), waiting for its agent.
  const row = serverRow(page, name);
  await expect(row.getByText("等待安装")).toBeVisible();
  // The fleet stats (shown once there is a server; an empty fleet is the "add your first server" state).
  for (const t of ["服务器在线", "落地节点", "入口", "探测失败已隐藏"])
    await expect(page.locator("main").getByText(t, { exact: true }).first()).toBeVisible();
  // Filters live in the URL: a server without its agent needs a look.
  const filters = page.getByRole("group", { name: "筛选" });
  await filters.getByRole("button", { name: /^需要关注/ }).click();
  await expect(page).toHaveURL(/[?&]view=issue/);
  await expect(row).toBeVisible();
  await filters.getByRole("button", { name: /^正常/ }).click();
  await expect(row).toHaveCount(0);
  await filters.getByRole("button", { name: /^全部/ }).click();
  await expect(page).not.toHaveURL(/[?&]view=/);
  // The search term lives in the URL; results are grouped; no match has its own state.
  const search = page.getByLabel("搜索服务器、节点或入口");
  await search.fill(name);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(name)}`));
  await expect(page.getByRole("region", { name: "服务器" })).toContainText(name);
  await search.fill(`${name}-no-such-thing`);
  await expect(page.getByText(`没有匹配「${name}-no-such-thing」的服务器、节点或入口`)).toBeVisible();
  await page.getByRole("button", { name: "清除搜索" }).first().click();
  await expect(row).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]q=/);
  // The server page.
  await openServer(page, name);
  await expect(page).toHaveURL(/\/nodes\/[0-9a-f-]{36}/);
  await expect(tab(page, /^节点与入口/)).toHaveAttribute("aria-selected", "true");
  // No agent yet: the tab says how to install it instead of listing nodes.
  await expect(page.getByText("等待 agent 首次连接")).toBeVisible();
  // NOD-04: a new install command; a new enrollment token (consequences first).
  await page.getByRole("button", { name: "安装命令" }).first().click();
  d = dialog(page, `安装命令 · ${name}`);
  await expect(d.getByText("已生成新命令，之前的命令已失效。")).toBeVisible();
  await expect(d.getByText(/\/install\//).first()).toBeVisible();
  await d.getByRole("button", { name: "关闭", exact: true }).last().click();
  await dialog(page, "确定已经复制安装命令？").getByRole("button", { name: "仍然关闭" }).click();
  await menu(page, `服务器 ${name} 的操作`, "重新生成注册令牌");
  d = dialog(page, `重新生成注册令牌 · ${name}`);
  await expect(d.getByText(/之前的证书会被吊销/)).toBeVisible();
  await d.getByRole("button", { name: "生成注册令牌" }).click();
  await toast(page, "已生成新的注册令牌");
  await expect(d.getByText("引导文件（含一次性注册令牌，不含私钥）")).toBeVisible();
  await d.getByRole("button", { name: "完成" }).click();
  // NOD-05: settings — check the domain's resolution, set the billing rate cap.
  await tab(page, "设置").click();
  await expect(page).toHaveURL(/[?&]tab=settings/);
  await box(page, /^TLS 域名/).fill("localhost");
  await page.getByRole("button", { name: "检查解析" }).click();
  await expect(page.getByRole("status").filter({ hasText: /解析|Cloudflare|检查失败/ })).toBeVisible();
  await box(page, /^TLS 域名/).fill("");
  await box(page, /^计费速率上限/).fill("100");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "已保存");
  // NOD-06: the traffic quota.
  await tab(page, /^流量额度/).click();
  await page.getByRole("radio", { name: /^仅上行/ }).click();
  await box(page, /^每周期额度/).fill("10");
  // A day outside 1–31 is an error under the field; nothing is sent.
  await box(page, /^每月重置日/).fill("32");
  await expect(page.getByText("请输入 1–31 的整数")).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("1 处需要修正")).toBeVisible();
  await box(page, /^每月重置日/).fill("1");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "流量额度已保存");
  await expect(page.locator("main")).toContainText("本周期已用 · 仅上行");
  // Over quota: the red state and its explanation.
  sql(`UPDATE servers SET traffic_quota_tx_bytes = 21474836480 WHERE name = '${name}'`);
  await page.reload();
  await expect(page.getByText("本周期流量额度已用完。").first()).toBeVisible();
  // (Never installed: the status chip stays 等待安装, which outranks 额度用尽.)
  await expect(page.getByRole("button", { name: "调整额度" }).first()).toBeVisible();
  // NOD-09: alert rules of this server.
  await tab(page, /^告警规则/).click();
  await page.getByRole("switch", { name: /^静音这台服务器/ }).click();
  await box(page, /^离线多少秒告警/).fill("5");
  await expect(page.getByText("不能小于 30")).toBeVisible();
  await box(page, /^离线多少秒告警/).fill("600");
  await page.getByRole("checkbox", { name: "CPU 过高" }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "告警规则已保存");
  // NOD-08: status and latency (监控).
  await tab(page, "监控").click();
  await expect(page.getByRole("heading", { name: "机器状态" })).toBeVisible();
  await expect(page.getByText("还没有测速结果。")).toBeVisible();
  // NOD-07: delete (type the name) → back to the list, which follows at once.
  await menu(page, `服务器 ${name} 的操作`, "删除服务器");
  await confirmDialog(page, name);
  await toast(page, "删除已开始");
  await expect(page).toHaveURL(/\/nodes(\?|$)/);
  await expect(async () => {
    if (await row.count()) await expect(row.getByText("删除中")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 5000 });
});

test("NOD-10 NOD-11 NOD-12 NOD-13 NOD-14 NOD-15 NOD-16 NOD-17 NOD-18 NOD-19 NOD-20: nodes, inbounds, block rules, direct and relay entrances, time windows", async ({
  page,
}, info) => {
  const srv = uniq(info, "host");
  await apiJson("POST", "/servers", { name: srv });
  const node = uniq(info, "edge");
  const port = 20000 + Math.floor(Math.random() * 20000);
  await openConsole(page, "/nodes");
  await openServer(page, srv);
  // NOD-10: the wizard from the server (step 1 is skipped), REALITY template.
  await menu(page, `服务器 ${srv} 的操作`, "在此服务器添加节点");
  let d = dialog(page, "新建落地节点");
  await expect(d.locator("[aria-current=step]")).toContainText("协议");
  await d.getByRole("radio", { name: /^VLESS \+ REALITY/ }).click();
  await d.getByRole("button", { name: "下一步" }).click();
  await box(d, /^端口/).fill(String(port));
  await d.getByRole("button", { name: "检测目标站点" }).click();
  await expect(d.getByRole("status")).toBeVisible();
  await d.getByRole("button", { name: "下一步" }).click();
  await box(d, /^节点名称/).fill(node);
  await box(d, /^地区/).fill("东京");
  await box(d, /^倍率/).fill("1.5");
  // Tags are the entrance's (the direct one here), not the node's.
  await d.getByRole("textbox", { name: "添加标签" }).fill("原生, 流媒体");
  await d.getByRole("button", { name: "创建节点" }).click();
  await toast(page, `已创建节点「${node}」`);
  // NOD-11 / NOD-15: the node card and its entrances.
  const card = nodeCard(page, node);
  await expect(card).toContainText(`:${port}`);
  await expect(card).toContainText("东京");
  await expect(card).toContainText("VLESS");
  const entrances = card.locator("li[data-entrance]");
  await expect(entrances).toHaveCount(1);
  await expect(entrances.first()).toContainText("1.5x");
  await expect(entrances.first()).toContainText("订阅中");
  await expect(entrances.first().locator("[data-entrance-tag]")).toHaveText(["原生", "流媒体"]);
  // The entrance list folds (a 44 px toggle).
  await card.getByRole("button", { name: `收起 ${node} 的入口` }).click();
  await expect(entrances).toHaveCount(0);
  await card.getByRole("button", { name: `展开 ${node} 的入口` }).click();
  await expect(entrances).toHaveCount(1);
  // NOD-14: outbound blocking is part of the node form (the rebuild confirmed on save).
  await card.getByRole("button", { name: `编辑节点 ${node}` }).click();
  d = dialog(page, `节点 · ${node}`);
  await d.getByRole("tab", { name: "审计与流量" }).click();
  await expect(page).toHaveURL(/[?&]ntab=audit/);
  await d.getByRole("switch", { name: "出站拦截" }).click();
  await expect(d.getByText("改动：出站拦截")).toBeVisible();
  await d.getByRole("button", { name: /^保存/ }).click();
  await expect(page.getByRole("alertdialog")).toContainText("开启出站拦截？");
  await confirmDialog(page, undefined, "开启并重建");
  await toast(page, "出站拦截已开启");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card.getByText("出站拦截 开")).toBeVisible();
  // NOD-12 / NOD-13 / NOD-20: the node dialog (with a day of traffic history; yesterday, so a
  // run around the site's midnight still finds it inside the 30 days).
  // Its own user (a shared fixture user may have been removed by another spec).
  const heavy = `${uniq(info, "heavy")}@e2e.test`;
  await apiJson("POST", "/users", { email: heavy, password: "heavy-user-pass-1" });
  const inserted = sql(
    `INSERT INTO traffic_daily (user_id, day, node_id, entrance_id, up_bytes, down_bytes, billed_bytes) ` +
      `SELECT u.id, akari_site_day(now()) - 1, n.id, e.id, 1048576, 2097152, 3145728 FROM users u, nodes n JOIN entrances e ON e.node_id = n.id ` +
      `WHERE u.email = '${heavy}' AND n.name = '${node}' RETURNING 1`,
  );
  expect(inserted, "traffic rows for the node's entrances").not.toBe("");
  await card.getByRole("button", { name: `编辑节点 ${node}` }).click();
  d = dialog(page, `节点 · ${node}`);
  await d.getByRole("tab", { name: "审计与流量" }).click();
  await expect(d.getByRole("switch", { name: "出站拦截" })).toHaveAttribute("aria-checked", "true");
  await expect(d.getByText("节点流量 · 30 天")).toBeVisible();
  await expect(d.getByRole("list", { name: "用量最高的用户" })).toContainText(heavy);
  // One form, one save: the display name and the inbound together.
  await d.getByRole("tab", { name: "基本" }).click();
  await box(d, /^显示名称/).fill(`${node} 显示`);
  await d.getByRole("tab", { name: /^入站/ }).click();
  await expect(d.getByText("当前入站")).toBeVisible();
  await d.getByRole("button", { name: "编辑 JSON" }).click();
  const json = box(d, /^Xray 入站 JSON/);
  const inbound = JSON.parse(await json.inputValue());
  // A new protocol re-issues every user's credentials: confirmed first, cancelling sends nothing.
  await json.fill(JSON.stringify({ ...inbound, protocol: "vmess" }));
  await expect(d.getByText("协议会变化：")).toBeVisible();
  await d.getByRole("button", { name: /^保存/ }).click();
  const reissue = page.getByRole("alertdialog");
  await expect(reissue).toContainText("重新发放全部凭据");
  await expect(reissue).toContainText("重新发放凭据的用户");
  await reissue.getByRole("button", { name: "取消" }).click();
  await expect(reissue).toHaveCount(0);
  await expect(card).toContainText(`:${port}`);
  await json.fill(JSON.stringify({ ...inbound, port: port + 1 }));
  await expect(d.getByText(/改动：显示名.*入站/)).toBeVisible();
  await d.getByRole("button", { name: /^保存/ }).click();
  await toast(page, "入站已保存，agent 将重建配置");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card).toContainText(`:${port + 1}`);
  await expect(card.getByText(`${node} 显示`)).toBeVisible();
  // NOD-17: a relay entrance (the same entrance form in create mode).
  await menu(page, `节点 ${node} 的操作`, "添加中转入口");
  d = dialog(page, `添加中转入口 · ${node}`);
  await box(d, /^入口名称/).fill("IPLC");
  await d.getByRole("textbox", { name: "添加标签" }).fill("IPLC 专线");
  await box(d, /^端口/).fill("30001");
  await box(d, /^落地监听端口/).fill(String(port + 2));
  // The egress hint; the dial IP typed in as the egress is called out.
  await expect(d.getByText(/curl -4 ifconfig\.me/).first()).toBeVisible();
  await box(d, /^连接地址/).fill("198.51.100.4");
  await d.getByRole("textbox", { name: "添加出口 IP / CIDR" }).fill("198.51.100.4");
  await expect(d.getByText(/连接地址也在出口列表里/)).toBeVisible();
  await box(d, /^连接地址/).fill("relay.example.com");
  // The path strip follows the form.
  await expect(d.getByText("relay.example.com:30001")).toBeVisible();
  // An address that is not an IP / CIDR is called out as a red chip under the field.
  const egress = d.getByRole("textbox", { name: "添加出口 IP / CIDR" });
  await egress.fill("203.0.113.300");
  await egress.press("Enter");
  await expect(d.getByText("「203.0.113.300」不是有效的 IP 地址或 CIDR")).toBeVisible();
  await expect(d.getByText("1 处需要修正")).toBeVisible();
  await d.getByRole("button", { name: "移除 203.0.113.300" }).click();
  await egress.fill("203.0.113.0/24");
  await expect(d.getByText(/连接地址也在出口列表里/)).toHaveCount(0);
  await d.getByRole("tab", { name: /倍率与时段/ }).click();
  await box(d, /^基础倍率/).fill("2");
  await d.getByRole("button", { name: "添加入口" }).click();
  await toast(page, "已添加中转入口");
  await expect(entrances).toHaveCount(2);
  const relay = card.locator("li[data-entrance]", { hasText: "IPLC" });
  await expect(relay).toContainText("relay.example.com:30001");
  await expect(relay).toContainText("2x");
  await expect(relay.locator("[data-entrance-tag]")).toHaveText(["IPLC 专线"]);
  // NOD-18: a relay that fails its probe — hidden, and listed under 需要处理.
  sql(
    `UPDATE entrances SET hidden_since = now() WHERE name = 'IPLC' AND node_id = (SELECT id FROM nodes WHERE name = '${node}')`,
  );
  await page.reload();
  await expect(relay).toContainText("已隐藏");
  const serverUrl = page.url();
  await openConsole(page, "/nodes");
  await expect(page.getByRole("region", { name: "需要处理" })).toContainText(
    `${srv} / ${node} · 已从订阅隐藏、已告警，恢复后自动显示`,
  );
  await page.goto(serverUrl);
  // NOD-16 / NOD-19: the direct entrance — tags, base rate (one save for both tabs).
  await entrances.first().getByRole("button").click();
  d = dialog(page);
  await expect(d).toContainText("直连入口");
  await expect(d).toContainText("订阅中显示为");
  await expect(d.getByRole("button", { name: "移除 原生" })).toBeVisible();
  await d.getByRole("button", { name: "移除 流媒体" }).click();
  await d.getByRole("textbox", { name: "添加标签" }).fill("高速");
  await d.getByRole("tab", { name: /倍率与时段/ }).click();
  await expect(page).toHaveURL(/[?&]etab=rate/);
  await box(d, /^基础倍率/).fill("1");
  await expect(d.getByText(/改动：标签、基础倍率/)).toBeVisible();
  await d.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "已保存入口");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(entrances.first().locator("[data-entrance-tag]")).toHaveText(["原生", "高速"]);
  await expect(relay.locator("[data-entrance-tag]")).toHaveText(["IPLC 专线"]);
  // Time windows: two identical rules overlap (warned); the heat map shows each hour's value.
  await entrances.first().getByRole("button").click();
  d = dialog(page);
  await d.getByRole("tab", { name: /倍率与时段/ }).click();
  await d.getByRole("button", { name: "添加时段规则" }).click();
  await d.getByRole("button", { name: "添加时段规则" }).click();
  await expect(d.getByText("与其他规则在部分时段重叠，重叠处取最高倍率").first()).toBeVisible();
  await expect(d.getByLabel("规则 1 开始")).toHaveAttribute("type", "time");
  await expect(d.getByLabel("规则 1 结束")).toHaveValue("00:00");
  await d.getByRole("button", { name: "删除规则 2" }).click();
  await expect(d.getByText("与其他规则在部分时段重叠，重叠处取最高倍率")).toHaveCount(0);
  const heat = d.getByRole("group", { name: "一周 7×24 倍率热力图" });
  await expect(heat.getByRole("button", { name: "周一 20:00 2x" })).toBeVisible();
  // A cell selected from the keyboard (or by dragging) becomes a rule.
  await heat.getByRole("button", { name: "周六 10:00 1x" }).press("Enter");
  await d.getByLabel("新规则倍率").fill("3");
  await d.getByRole("button", { name: "生成规则" }).click();
  await expect(d.getByLabel("规则 2 开始")).toHaveValue("10:00");
  await expect(d.getByLabel("规则 2 结束")).toHaveValue("11:00");
  await expect(heat.getByRole("button", { name: "周六 10:00 3x" })).toBeVisible();
  await d.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "已保存入口");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(entrances.first()).toContainText("时段 2");
  // Delete the relay (type its name).
  await relay.getByRole("button").click();
  await dialog(page, "IPLC").getByRole("button", { name: "删除入口" }).click();
  const del = page.getByRole("alertdialog");
  await expect(del).toContainText("删除入口「IPLC」？");
  await expect(del).toContainText("所属节点组");
  await confirmDialog(page, "IPLC");
  await toast(page, "入口已删除");
  await expect(entrances).toHaveCount(1);
  // NOD-12: disable (confirmed), enable, delete (type the name).
  await menu(page, `节点 ${node} 的操作`, "停用");
  await confirmDialog(page, undefined, "停用节点");
  await expect(card.getByText("已停用").first()).toBeVisible();
  await menu(page, `节点 ${node} 的操作`, "启用");
  await expect(card.getByText("已停用")).toHaveCount(0);
  await menu(page, `节点 ${node} 的操作`, "删除节点");
  await confirmDialog(page, node);
  await toast(page, "节点已删除");
  await expect(card).toHaveCount(0);
});

test("NOD-22 NOD-23: multiplier input safety, stale forms refused, the entrance's own traffic and multiplier history", async ({
  page,
}, info) => {
  const { id: serverId } = await apiJson<{ id: string }>("POST", "/servers", { name: uniq(info, "rate-host") });
  const node = uniq(info, "rate-node");
  const { id: nodeId } = await apiJson<{ id: string }>("POST", "/nodes", {
    server_id: serverId,
    name: node,
    inbound: { protocol: "vmess", port: 21000 + Math.floor(Math.random() * 20000), settings: { clients: [] } },
  });
  const view = () =>
    apiJson<{ entrances: { id: string; name: string; rate_permille: number; sort: number; version: number }[] }>(
      "GET",
      `/nodes/${nodeId}`,
    ).then((n) => n.entrances[0]);
  const e = await view();
  sql(
    `INSERT INTO traffic_entrance_daily (entrance_id, node_id, day, up_bytes, down_bytes, billed_bytes, users) ` +
      `VALUES ('${e.id}', '${nodeId}', akari_site_day(now()), 1048576, 2097152, 3145728, 1)`,
  );
  // Old deep links still open the entrance (on its server page now).
  const url = `/nodes?open=entrance:${e.id}`;
  await openConsole(page, url);
  await expect(page).toHaveURL(new RegExp(`/nodes/${serverId}\\?.*entrance=${e.id}`));
  let d = dialog(page, e.name);
  await d.getByRole("tab", { name: /倍率与时段/ }).click();
  const rate = box(d, /^基础倍率/);
  const save = (x: typeof d) => x.getByRole("button", { name: "保存", exact: true }).click();
  // NOD-22: an empty multiplier is an error under the field (never 0x), nothing is sent.
  await rate.fill("");
  await expect(d.getByText(/倍率不能留空/)).toBeVisible();
  await save(d);
  expect((await view()).rate_permille).toBe(1000);
  // 0x asks first; cancelling sends nothing.
  await rate.fill("0");
  await expect(d.getByText("0x = 免费，保存时需要确认")).toBeVisible();
  await save(d);
  await expect(dialog(page)).toContainText("0x（免费）");
  await dialog(page).getByRole("button", { name: "取消" }).click();
  expect((await view()).rate_permille).toBe(1000);

  // Two forms on the same entrance: the first save wins, the second is
  // refused (409), says so in place and overwrites nothing.
  const other = await page.context().newPage();
  await openConsole(other, url);
  const d2 = dialog(other, e.name);
  await d2.getByRole("tab", { name: /倍率与时段/ }).click();
  await expect(box(d2, /^基础倍率/)).toHaveValue("1");
  await d2.getByRole("tab", { name: "连接" }).click();
  await rate.fill("10");
  await save(d);
  await toast(page, "已保存入口");
  await expect(page.locator("[data-sonner-toast]", { hasText: "不追溯" }).first()).toBeVisible();
  await box(d2, /^排序/).fill("7");
  await save(d2);
  await expect(d2.getByText("此入口已被他人修改。")).toBeVisible();
  await expect(d2.getByText("已被他人修改，不能保存")).toBeVisible();
  await expect(d2.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await other.close();
  const after = await view();
  expect([after.rate_permille, after.sort]).toEqual([10000, 0]);

  // NOD-23: the entrance's own days and its multiplier history (who, old → new).
  await openConsole(page, `/nodes/${serverId}?entrance=${e.id}&etab=traffic`);
  d = dialog(page, e.name);
  await expect(d.getByRole("tab", { name: "流量与记录" })).toHaveAttribute("aria-selected", "true");
  await expect(d.getByText("30 天原始")).toBeVisible();
  await d.getByText("每日明细").click();
  const days = d.getByRole("table", { name: "每日流量" });
  await expect(days).toContainText("3.0 MiB");
  await expect(d).toContainText("1x → 10x");
  await expect(d).toContainText(ADMIN);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await apiJson("DELETE", `/nodes/${nodeId}`);
});

test("NOD-21 PLN-01 PLN-02 PLN-03 PLN-04: node groups, plans with prices and groups, term changes applied to subscribers, disable, delete", async ({
  page,
}, info) => {
  const act = async (label: string, item: string) => {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("menuitem", { name: item }).click();
  };
  const tabs = page.getByRole("navigation", { name: "套餐页面" });
  const srv = uniq(info, "plan-host");
  const { id: serverId } = await apiJson<{ id: string }>("POST", "/servers", { name: srv });
  const node = uniq(info, "plan-node");
  await apiJson("POST", "/nodes", {
    server_id: serverId,
    name: node,
    inbound: { protocol: "vmess", port: 21000 + Math.floor(Math.random() * 20000), settings: { clients: [] } },
  });
  const group = uniq(info, "组");
  const plan = uniq(info, "基础套餐");
  await openConsole(page, "/plans");
  // NOD-21: a node group with the node's direct entrance (the card draws server → entrance chips).
  await tabs.getByRole("link", { name: /节点组/ }).click();
  await expect(page).toHaveURL(/\/plans\/groups/);
  await page.getByRole("button", { name: "新建节点组" }).first().click();
  let d = dialog(page, "新建节点组");
  await d.getByLabel("名称").fill(group);
  await d.getByLabel("说明").fill("e2e");
  await d.getByRole("checkbox", { name: `${node} · 直连` }).click();
  await d.getByRole("button", { name: "创建" }).click();
  await toast(page, "节点组已保存");
  const groupCard = page.getByRole("region", { name: group });
  await expect(groupCard).toContainText(srv);
  await expect(groupCard).toContainText(node);
  // PLN-02: a plan through the sectioned editor (traffic, price, stock, the group with its entrances listed live).
  await tabs.getByRole("link", { name: /^套餐/ }).click();
  await page.getByRole("button", { name: "新建套餐" }).first().click();
  d = dialog(page, "新建套餐");
  const section = (name: string) => d.getByRole("navigation", { name: "套餐设置分区" }).getByRole("button", { name });
  await d.getByLabel("名称").fill(plan);
  await section("流量与限速").click();
  await d.getByRole("textbox", { name: /^流量(?!重置)/ }).fill("100");
  await d.getByRole("textbox", { name: /^限速/ }).fill("50");
  await section("价格").click();
  await d.getByLabel("月付价格").fill("10");
  await section("库存与上架").click();
  await d.getByLabel("库存（同时持有的人数上限）").fill("10");
  await section("节点组").click();
  await d.getByRole("checkbox", { name: group }).click();
  await expect(d.getByText("用户将获得这些入口 · 1")).toBeVisible();
  await d.getByRole("button", { name: "创建套餐" }).click();
  await toast(page, "套餐已创建");
  // PLN-01: the card (price chip, quota, group chip).
  const card = page.getByRole("region", { name: plan });
  await expect(card).toContainText("¥10");
  await expect(card).toContainText("100 GiB");
  await expect(card).toContainText(group);
  // Numbers are checked in place: a bad speed limit is never sent as "no limit"; the editor jumps to its section.
  await card.getByRole("button", { name: plan, exact: true }).click();
  d = dialog(page, `编辑「${plan}」`);
  await section("流量与限速").click();
  await d.getByRole("textbox", { name: /^限速/ }).fill("5x");
  await section("基本").click();
  await d.getByRole("button", { name: "保存" }).click();
  await expect(d.getByText("请输入整数")).toBeVisible();
  await expect(d.getByText("1 处需要修正")).toBeVisible();
  // Esc on an edited form asks first; the footer's 取消 discards.
  await page.keyboard.press("Escape");
  await expect(dialog(page, "放弃未保存的修改？")).toBeVisible();
  await dialog(page, "放弃未保存的修改？").getByRole("button", { name: "继续编辑" }).click();
  await d.getByRole("button", { name: "取消" }).click();
  await expect(d).toHaveCount(0);
  await expect(card).toContainText("50 Mbps");
  // PLN-03: a subscriber; lowering the quota previews the impact and applies it to them.
  const u = await apiJson<{ id: string }>("POST", "/users", {
    email: `${uniq(info, "sub")}@e2e.test`,
    password: "plan-pass-1",
  });
  const planId = sql(`SELECT id FROM plans WHERE name = '${plan}'`);
  await apiJson("PUT", `/users/${u.id}/plan`, { plan_id: planId, period: "month" });
  await card.getByRole("button", { name: plan, exact: true }).click();
  d = dialog(page, `编辑「${plan}」`);
  await section("流量与限速").click();
  await d.getByRole("textbox", { name: /^流量(?!重置)/ }).fill("50");
  await d.getByRole("button", { name: "保存" }).click();
  const impact = dialog(page, "这次改动会影响现有用户");
  await expect(impact).toContainText("1 个生效订阅");
  await expect(impact).toContainText("100 GiB");
  await impact.getByRole("button", { name: "同时应用到现有用户" }).click();
  await toast(page, "套餐已保存");
  await expect(card).toContainText("50 GiB");
  expect(sql(`SELECT quota_bytes FROM user_plans WHERE user_id = '${u.id}' AND status = 'active'`)).toBe(
    String(50 * 1024 ** 3),
  );
  // PLN-04: disable (confirmed) and enable; delete is refused while held, allowed for a plan nobody holds.
  await act(`套餐 ${plan} 的操作`, "停用");
  await confirmDialog(page, undefined, "停用");
  await expect(card).toContainText("已停用");
  await act(`套餐 ${plan} 的操作`, "启用");
  await confirmDialog(page, undefined, "启用");
  await expect(card).not.toContainText("已停用");
  await act(`套餐 ${plan} 的操作`, "删除");
  const blocked = dialog(page, `暂时不能删除「${plan}」`);
  await expect(blocked).toContainText("1 个用户正在使用");
  await expect(blocked.getByRole("link", { name: "查看这些用户" })).toBeVisible();
  await blocked.getByRole("button", { name: "知道了" }).click();
  const spare = uniq(info, "空套餐");
  await apiJson("POST", "/plans", { name: spare, period: "monthly" });
  await page.reload();
  await act(`套餐 ${spare} 的操作`, "删除");
  await confirmDialog(page, spare);
  await toast(page, "套餐已删除");
  await expect(page.getByRole("region", { name: spare })).toHaveCount(0);
  // The group: the same row menu as plans; the list follows without a reload.
  await tabs.getByRole("link", { name: /节点组/ }).click();
  await act(`节点组 ${group} 的操作`, "删除");
  await expect(dialog(page)).toContainText(plan);
  await expect(dialog(page)).toContainText("受影响的订阅");
  await confirmDialog(page, group);
  await toast(page, "节点组已删除");
  await expect(page.getByRole("region", { name: group })).toHaveCount(0);
});
