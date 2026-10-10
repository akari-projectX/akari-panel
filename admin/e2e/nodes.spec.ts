// INVENTORY §10 (servers, nodes, entrances) and §11 (plans, node groups).
import { expect, test, type Page } from "@playwright/test";

import { ADMIN, USER, apiJson, confirmDialog, dialog, openConsole, sql, toast, uniq } from "./helpers";

test.describe.configure({ mode: "serial" });

const server = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const nodeRow = (page: Page, name: string) => page.locator(`li[data-node="${name}"]`);

async function menu(page: Page, label: string, item: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("NOD-01 NOD-02 NOD-03 NOD-04 NOD-05 NOD-06 NOD-07 NOD-08 NOD-09: servers — add with an install command, reissue, edit, quota, alert rules, status, delete", async ({
  page,
}, info) => {
  const name = uniq(info, "srv");
  await openConsole(page, "/nodes");
  for (const t of ["服务器在线", "落地节点", "入口", "探测失败已隐藏"])
    await expect(page.getByText(t, { exact: true }).first()).toBeVisible();
  // NOD-03: add → the one-time install command with its countdown.
  await page.getByRole("button", { name: "添加服务器" }).click();
  let d = dialog(page, "添加服务器");
  await d.getByLabel("名称（内部，唯一）").fill(name);
  await d.getByRole("button", { name: "添加" }).click();
  await toast(page, "服务器已添加");
  d = dialog(page);
  await expect(d.getByText("在服务器上以 root 执行（一次性）")).toBeVisible();
  await expect(d.getByText(/后过期/).first()).toBeVisible();
  await expect(d.getByText(/\/install\//).first()).toBeVisible();
  await d.getByRole("button", { name: "完成" }).click();
  const card = server(page, name);
  await expect(card.getByText("待安装")).toBeVisible();
  await expect(card.getByText("这台服务器上还没有节点。")).toBeVisible();
  // NOD-04: a new install command; a manual bootstrap file.
  await menu(page, `服务器 ${name} 的操作`, "安装命令");
  await expect(dialog(page).getByText("在服务器上以 root 执行（一次性）")).toBeVisible();
  await dialog(page).getByRole("button", { name: "完成" }).click();
  await menu(page, `服务器 ${name} 的操作`, "手动引导文件");
  await expect(dialog(page).getByText("引导文件（含一次性注册令牌，不含私钥）")).toBeVisible();
  await dialog(page).getByRole("button", { name: "完成" }).click();
  // NOD-05: edit — check the domain's resolution, set the billing rate cap.
  await menu(page, `服务器 ${name} 的操作`, "编辑服务器");
  d = dialog(page);
  await d.getByLabel("服务器域名（TLS）").fill("localhost");
  await d.getByRole("button", { name: "检查解析" }).click();
  await expect(d.getByRole("status")).not.toHaveText(/检查中/);
  await d.getByLabel("服务器域名（TLS）").fill("");
  await d.getByLabel("计费速率上限（上下行合计 Mbps，留空 = 默认）").fill("100");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "已保存");
  // NOD-06: the traffic quota.
  await card.getByRole("button", { name: "流量额度" }).click();
  d = dialog(page);
  await d.getByRole("button", { name: "仅上行" }).click();
  await d.getByLabel("每周期额度（GiB，留空 = 不限）").fill("10");
  await d.getByLabel("每月重置日（1–31，留空 = 不重置）").fill("1");
  await expect(d.getByText("本周期已用")).toBeVisible();
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "流量额度已保存");
  await expect(card.getByText(/仅上行 · 每月 1 日重置/)).toBeVisible();
  // Over quota: the red state and its explanation.
  sql(`UPDATE servers SET traffic_quota_tx_bytes = 21474836480 WHERE name = '${name}'`);
  await page.reload();
  await expect(card.getByText("已超额")).toBeVisible();
  // NOD-09: alert rules of this server.
  await menu(page, `服务器 ${name} 的操作`, "告警规则");
  d = dialog(page);
  await d.getByRole("switch", { name: "静音", exact: true }).click();
  await d.getByLabel("离线多少秒告警").fill("600");
  await d.getByRole("checkbox", { name: "CPU 过高" }).click();
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "告警规则已保存");
  // NOD-08: status and latency.
  await menu(page, `服务器 ${name} 的操作`, "状态与测速");
  d = dialog(page);
  await expect(d.getByText("还没有测速结果。")).toBeVisible();
  await expect(d.getByText("历史")).toBeVisible();
  await d.getByRole("button", { name: "立即测速" }).click();
  await expect(page.locator("[data-toast]").first()).toBeVisible();
  await page.keyboard.press("Escape");
  // NOD-07: delete (type the name).
  await menu(page, `服务器 ${name} 的操作`, "删除服务器");
  await confirmDialog(page, name);
  await toast(page, "删除已开始");
});

test("NOD-10 NOD-11 NOD-12 NOD-13 NOD-14 NOD-15 NOD-16 NOD-17 NOD-18 NOD-19 NOD-20: nodes, inbounds, block rules, direct and relay entrances, time windows", async ({
  page,
}, info) => {
  const srv = uniq(info, "host");
  await apiJson("POST", "/servers", { name: srv });
  const node = uniq(info, "edge");
  const port = 20000 + Math.floor(Math.random() * 20000);
  await openConsole(page, "/nodes");
  // NOD-10: a landing node from the REALITY template.
  await page.getByRole("button", { name: "添加节点" }).first().click();
  let d = dialog(page, "添加落地节点");
  await d.getByRole("combobox", { name: "服务器", exact: true }).selectOption({ label: srv });
  await d.getByLabel("名称（内部，唯一）").fill(node);
  await d.getByLabel("地区（用户可见）").fill("东京");
  await d.getByLabel("协议模板").selectOption("vless_reality");
  await d.getByLabel("端口", { exact: true }).fill(String(port));
  await d.getByLabel("倍率").fill("1.5");
  await d.getByRole("button", { name: "检测目标站点" }).click();
  await expect(d.getByRole("status")).toBeVisible();
  await d.getByRole("button", { name: "添加", exact: true }).click();
  await toast(page, "节点已添加");
  // NOD-11 / NOD-15: the row and its entrance table.
  const row = nodeRow(page, node);
  await expect(row.getByText(`vless :${port}`)).toBeVisible();
  await expect(row.getByText("东京")).toBeVisible();
  await expect(row.locator("tr[data-entrance]")).toHaveCount(1);
  await expect(row.locator("tr[data-entrance]").first()).toContainText("1.5x");
  await expect(row.locator("tr[data-entrance]").first()).toContainText("显示");
  // NOD-14: the node's block-rules switch (confirmed).
  await row.getByRole("switch", { name: `${node} 的审计规则` }).click();
  await confirmDialog(page);
  await toast(page, "审计规则已开启");
  // NOD-12 / NOD-13 / NOD-20: the node drawer (with a day of traffic history).
  sql(
    `INSERT INTO traffic_daily (user_id, day, node_id, entrance_id, up_bytes, down_bytes, billed_bytes) ` +
      `SELECT u.id, akari_site_day(now()), n.id, e.id, 1048576, 2097152, 3145728 FROM users u, nodes n JOIN entrances e ON e.node_id = n.id ` +
      `WHERE u.email = '${USER}' AND n.name = '${node}'`,
  );
  await row.getByRole("button", { name: node, exact: true }).click();
  d = dialog(page);
  await d.getByLabel("显示名称").fill(`${node} 显示`);
  await d.getByLabel("标签（逗号分隔）").fill("流媒体, 高速");
  await d.getByRole("button", { name: "保存展示设置" }).click();
  await toast(page, "已保存");
  await expect(d.getByText("已开启")).toBeVisible();
  await expect(d.getByText("节点流量（近 30 天）")).toBeVisible();
  await expect(d.getByText("用量最高的用户")).toBeVisible();
  await expect(d.getByText(USER)).toBeVisible();
  await d.getByRole("button", { name: "编辑 JSON" }).click();
  const box = d.getByLabel("Xray 入站 JSON（对象，不含 tag）");
  const inbound = JSON.parse(await box.inputValue());
  inbound.port = port + 1;
  await box.fill(JSON.stringify(inbound));
  await expect(d.getByText(/协议变化会重新发放凭据/)).toBeVisible();
  await d.getByRole("button", { name: "保存入站" }).click();
  await toast(page, "入站已保存，agent 将重建配置");
  await page.keyboard.press("Escape");
  await expect(row.getByText(`vless :${port + 1}`)).toBeVisible();
  // NOD-17: a relay entrance.
  await menu(page, `节点 ${node} 的操作`, "添加中转入口");
  d = dialog(page);
  await d.getByLabel("名称", { exact: true }).fill("IPLC");
  await d.getByLabel("倍率").fill("2");
  await d.getByLabel("连接地址（中转机）").fill("relay.example.com");
  await d.getByLabel("连接端口").fill("30001");
  await d.getByLabel("监听端口（节点上）").fill(String(port + 2));
  await d.getByLabel("中转机出口 IP / CIDR").fill("203.0.113.0/24");
  await d.getByRole("button", { name: "添加" }).click();
  await toast(page, "中转入口已添加");
  await expect(row.locator("tr[data-entrance]")).toHaveCount(2);
  const relay = row.locator("tr[data-entrance]", { hasText: "IPLC" });
  await expect(relay).toContainText("中转");
  await expect(relay).toContainText("relay.example.com:30001");
  // NOD-18: a relay that fails its probe.
  sql(
    `UPDATE entrances SET hidden_since = now() WHERE name = 'IPLC' AND node_id = (SELECT id FROM nodes WHERE name = '${node}')`,
  );
  await page.reload();
  await expect(row.getByText(/已从订阅隐藏并已告警，恢复后自动显示/)).toBeVisible();
  // NOD-16 / NOD-19: the direct entrance — base rate, time windows (overlap warned), heat map.
  await row.locator("tr[data-entrance]").first().click();
  d = dialog(page);
  await expect(d.getByText("当前倍率")).toBeVisible();
  await d.getByLabel("基础倍率（0–100）").fill("1");
  await d.getByRole("button", { name: "保存入口" }).click();
  await toast(page, "入口已保存");
  await d.getByRole("button", { name: "添加规则" }).click();
  await d.getByRole("button", { name: "添加规则" }).click();
  await expect(d.getByRole("status").filter({ hasText: /重叠/ })).toBeVisible();
  await d.getByRole("button", { name: "删除规则" }).last().click();
  await d.getByRole("button", { name: "保存时段规则" }).click();
  await toast(page, "时段规则已保存（写入审计）");
  await expect(d.getByRole("table", { name: "一周 7×24 倍率热力图" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row.locator("tr[data-entrance]").first().getByText("1", { exact: true })).toBeVisible();
  // Delete the relay (type its name).
  await relay.click();
  await dialog(page).getByRole("button", { name: "删除中转入口" }).click();
  await confirmDialog(page, "IPLC");
  await toast(page, "入口已删除");
  await expect(row.locator("tr[data-entrance]")).toHaveCount(1);
  // NOD-12: disable (confirmed), enable, delete (type the name).
  await menu(page, `节点 ${node} 的操作`, "停用");
  await confirmDialog(page);
  await expect(row.getByText("已停用")).toBeVisible();
  await menu(page, `节点 ${node} 的操作`, "启用");
  await confirmDialog(page);
  await expect(row.getByText("已停用")).toHaveCount(0);
  await menu(page, `节点 ${node} 的操作`, "删除节点");
  await confirmDialog(page, node);
  await toast(page, "节点已删除");
  await expect(row).toHaveCount(0);
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
  const url = `/nodes?open=entrance:${e.id}`;
  await openConsole(page, url);
  let d = dialog(page);
  const rate = d.getByLabel("基础倍率（0–100）");
  // NOD-22: an empty multiplier is an error (never 0x), nothing is sent.
  await rate.fill("");
  await d.getByRole("button", { name: "保存入口" }).click();
  await expect(d.getByText(/请填写倍率/)).toBeVisible();
  expect((await view()).rate_permille).toBe(1000);
  // 0x asks first; cancelling sends nothing.
  await rate.fill("0");
  await d.getByRole("button", { name: "保存入口" }).click();
  await expect(dialog(page)).toContainText("0x（免费）");
  await dialog(page).getByRole("button", { name: "取消" }).click();
  expect((await view()).rate_permille).toBe(1000);

  // Two forms on the same entrance: the first save wins, the second is
  // refused (409) and overwrites nothing.
  const other = await page.context().newPage();
  await openConsole(other, url);
  const d2 = dialog(other);
  await expect(d2.getByLabel("基础倍率（0–100）")).toHaveValue("1");
  await rate.fill("10");
  await d.getByRole("button", { name: "保存入口" }).click();
  await toast(page, "入口已保存");
  await expect(page.locator("[data-toast]", { hasText: "不追溯" }).first()).toBeVisible();
  await d2.getByLabel("排序").fill("7");
  await d2.getByRole("button", { name: "保存入口" }).click();
  await toast(other, "入口已被修改（可能是其他管理员），请关闭后重新打开再保存");
  await other.close();
  const after = await view();
  expect([after.rate_permille, after.sort]).toEqual([10000, 0]);

  // NOD-23: the entrance's own days and its multiplier history (who, old → new).
  d = dialog(page);
  await expect(d.getByText("入口流量（近 30 天）")).toBeVisible();
  const days = d.getByRole("list", { name: "每日流量" });
  await expect(days).toContainText("原始 3.0 MiB");
  const history = d.getByRole("list", { name: "倍率变更记录" });
  await expect(history.getByText("1x → 10x")).toBeVisible();
  await expect(history).toContainText(ADMIN);
  await page.keyboard.press("Escape");
  await apiJson("DELETE", `/nodes/${nodeId}`);
});

test("NOD-21 PLN-01 PLN-02 PLN-03 PLN-04: node groups, plans with prices and groups, term changes applied to subscribers, disable, delete", async ({
  page,
}, info) => {
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
  // NOD-21: a node group with the node's direct entrance.
  await page.getByRole("tab", { name: "节点组" }).click();
  await page.getByRole("button", { name: "新建节点组" }).first().click();
  let d = dialog(page, "新建节点组");
  await d.getByLabel("名称").fill(group);
  await d.getByLabel("说明").fill("e2e");
  await d.getByRole("checkbox", { name: `${node} · 直连` }).click();
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "节点组已保存");
  await expect(page.getByRole("region", { name: group })).toContainText(`${srv} / ${node}`);
  // PLN-02: a plan with a monthly price and the group (its entrances listed live).
  await page.getByRole("tab", { name: "套餐" }).click();
  await page.getByRole("button", { name: "新建套餐" }).first().click();
  d = dialog(page, "新建套餐");
  await d.getByLabel("名称").fill(plan);
  await d.getByLabel("流量额度（GiB，留空不限）").fill("100");
  await d.getByLabel("限速（Mbps，留空不限）").fill("50");
  await d.getByLabel("库存（最多用户数，留空不限）").fill("10");
  await d.getByRole("checkbox", { name: "月付" }).click();
  await d.getByLabel("月付价格").fill("10");
  await d.getByRole("checkbox", { name: group }).click();
  await expect(d.getByText("用户将获得的入口（1）")).toBeVisible();
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "套餐已保存");
  // PLN-01: the card.
  const card = page.getByRole("region", { name: plan });
  await expect(card).toContainText("¥10.00");
  await expect(card).toContainText("100 GiB");
  // PLN-03: a subscriber; lowering the quota previews the impact and applies it to them.
  const u = await apiJson<{ id: string }>("POST", "/users", {
    email: `${uniq(info, "sub")}@e2e.test`,
    password: "plan-pass-1",
  });
  const planId = sql(`SELECT id FROM plans WHERE name = '${plan}'`);
  await apiJson("PUT", `/users/${u.id}/plan`, { plan_id: planId, period: "month" });
  await card.getByRole("button", { name: new RegExp(`^${plan}`) }).click();
  d = dialog(page, `编辑套餐 ${plan}`);
  await d.getByLabel("流量额度（GiB，留空不限）").fill("50");
  await d.getByRole("button", { name: "保存" }).click();
  const impact = dialog(page, "套餐条款变更");
  await expect(impact).toContainText("1 个生效订阅");
  await impact.getByRole("button", { name: "同时应用到 1 个现有订阅" }).click();
  await toast(page, "套餐已保存");
  expect(sql(`SELECT quota_bytes FROM user_plans WHERE user_id = '${u.id}' AND status = 'active'`)).toBe(
    String(50 * 1024 ** 3),
  );
  // PLN-04: disable (confirmed) and enable; delete is refused while held, allowed for a plan nobody holds.
  await menu(page, `套餐 ${plan} 的操作`, "停用");
  await confirmDialog(page);
  await expect(card).toContainText("已停用");
  await menu(page, `套餐 ${plan} 的操作`, "启用");
  await confirmDialog(page);
  await menu(page, `套餐 ${plan} 的操作`, "删除");
  await expect(dialog(page)).toContainText("1 个用户正在使用");
  await page.keyboard.press("Escape");
  const spare = uniq(info, "空套餐");
  await apiJson("POST", "/plans", { name: spare, period: "monthly" });
  await page.reload();
  await menu(page, `套餐 ${spare} 的操作`, "删除");
  await confirmDialog(page, spare);
  await toast(page, "套餐已删除");
  await expect(page.getByRole("region", { name: spare })).toHaveCount(0);
  // The group: delete it from its dialog.
  await page.getByRole("tab", { name: "节点组" }).click();
  await page.getByRole("region", { name: group }).getByRole("button", { name: "编辑" }).click();
  await dialog(page).getByRole("button", { name: "删除" }).click();
  await expect(dialog(page)).toContainText("1 个套餐的用户会失去这些入口");
  await confirmDialog(page, group);
  await toast(page, "节点组已删除");
});
