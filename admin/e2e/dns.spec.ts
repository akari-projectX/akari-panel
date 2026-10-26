// INVENTORY §10a (DNS). The panel talks to e2e/fixtures/cloudflare-mock.py (scripts/e2e.sh):
// zone e2e-dns.test (editable, 58 records) and e2e-ro.test (read-only).
import { expect, test } from "@playwright/test";

import { apiJson, confirmDialog, dialog, must, openConsole, openRow, row, sql, toast, uniq } from "./helpers";

test.describe.configure({ mode: "serial" });

const GOOD = must("E2E_CF_TOKEN");
const ZONE = "a".repeat(32);
const ZONE_NAME = "e2e-dns.test";

/** The id of the account named `name`. */
async function accountId(name: string): Promise<string> {
  const { accounts } = await apiJson<{ accounts: { id: string; name: string }[] }>("GET", "/dns/accounts");
  const a = accounts.find((x) => x.name === name);
  if (!a) throw new Error(`no dns account ${name}`);
  return a.id;
}

async function addRecord(account: string, name: string, content: string, extra: object = {}): Promise<string> {
  const r = await apiJson<{ id: string }>("POST", `/dns/accounts/${account}/zones/${ZONE}/records`, {
    type: "A",
    name,
    content,
    ttl: 300,
    ...extra,
  });
  return r.id;
}

async function search(page: import("@playwright/test").Page, text: string) {
  await page.getByRole("searchbox", { name: "搜索名称或内容" }).fill(text);
  await expect(page).toHaveURL(/q=/);
}

test("DNS-01: Cloudflare tokens (owner) — add, test the connection, a rejected token shows on the page, the secret is never shown, delete", async ({
  page,
}, info) => {
  const good = uniq(info, "cf-good");
  const bad = uniq(info, "cf-bad");
  await openConsole(page, "/dns");
  await expect(page.getByText("还没有 Cloudflare 令牌")).toBeVisible();
  await page.getByTestId("dns-tokens").click();
  const d = dialog(page, "Cloudflare 令牌");
  await d.getByRole("button", { name: "添加令牌" }).click();
  await d.getByLabel("名称").fill(good);
  await d.getByLabel("API 令牌").fill("too-short");
  await expect(d.getByText("令牌太短")).toBeVisible();
  await expect(d.getByRole("button", { name: "保存令牌" })).toBeDisabled();
  await d.getByLabel("API 令牌").fill(GOOD);
  await d.getByRole("button", { name: "保存令牌" }).click();
  await toast(page, "令牌已保存");
  const card = d.getByTestId(`dns-account-${good}`);
  await card.getByRole("button", { name: "测试连接" }).click();
  await expect(card.getByTestId("dns-test-ok")).toContainText("2 个域名，1 个可编辑");
  await expect(d).not.toContainText(GOOD);
  // A token Cloudflare rejects.
  await d.getByRole("button", { name: "添加令牌" }).click();
  await d.getByLabel("名称").fill(bad);
  await d.getByLabel("API 令牌").fill("e2e-cf-token-rejected-0123456789");
  await d.getByRole("button", { name: "保存令牌" }).click();
  await toast(page, "令牌已保存");
  const badCard = d.getByTestId(`dns-account-${bad}`);
  await badCard.getByRole("button", { name: "测试连接" }).click();
  await expect(badCard).toContainText("Cloudflare 拒绝了这个令牌");
  await d.getByRole("button", { name: "关闭" }).last().click();
  await expect(d).toBeHidden();
  // The page keeps working with the good token and names the failing one.
  await expect(page.getByTestId("dns-zone-error")).toContainText("Cloudflare 拒绝了这个令牌");
  await expect(page.getByTestId("dns-zone")).toBeVisible();
  // Delete the rejected token (type its name).
  await page.getByTestId("dns-tokens").click();
  await d.getByTestId(`dns-account-${bad}`).getByRole("button", { name: "删除" }).click();
  await confirmDialog(page, bad, /删除令牌/);
  await toast(page, "令牌已删除");
  await d.getByRole("button", { name: "关闭" }).last().click();
  await expect(page.getByTestId("dns-zone-error")).toHaveCount(0);
});

test("DNS-02: records — zones grouped by token, search and type filter in the URL, pages, cloud state, read-only zone", async ({
  page,
}, info) => {
  void info;
  await openConsole(page, "/dns");
  await expect(row(page, "www.e2e-dns.test")).toContainText("已代理");
  await expect(row(page, "origin.e2e-dns.test")).toContainText("仅 DNS");
  await expect(page.getByText(/共 58 条/)).toBeVisible();
  // Pages (Cloudflare pages of 50).
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(row(page, "p55.e2e-dns.test")).toBeVisible();
  await page.getByRole("button", { name: "上一页" }).click();
  // Search, then the type filter.
  await search(page, "origin");
  await expect(row(page, "origin.e2e-dns.test")).toBeVisible();
  await expect(page.locator("[data-row]:visible")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "搜索名称或内容" }).fill("");
  await page.getByTestId("dns-type-filter").selectOption("TXT");
  await expect(page).toHaveURL(/type=TXT/);
  await expect(row(page, "v=spf1 -all")).toBeVisible();
  await expect(page.locator("[data-row]:visible")).toHaveCount(1);
  await page.getByTestId("dns-type-filter").selectOption("");
  // The read-only zone: no create button, no selection, a notice.
  await page.getByTestId("dns-zone").selectOption({ label: "e2e-ro.test" });
  await expect(page.getByText("只有读取权限")).toBeVisible();
  await expect(page.getByTestId("dns-new")).toHaveCount(0);
  await expect(row(page, "ro.e2e-dns.test")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "选择" })).toHaveCount(0);
});

test("DNS-03: a record — create (checked fields), switch the cloud, edit, duplicate refused, delete", async ({
  page,
}, info) => {
  const name = `${uniq(info, "new")}.${ZONE_NAME}`;
  await openConsole(page, "/dns");
  await page.getByTestId("dns-new").click();
  const d = dialog(page, "新建 DNS 记录");
  await d.getByLabel("名称").fill(name);
  await d.getByRole("button", { name: "创建记录" }).click();
  await expect(d.getByText("请输入 IPv4 地址")).toBeVisible();
  await expect(d.getByText("1 处需要修正")).toBeVisible();
  // Other types bring their own fields.
  await d.getByTestId("dns-type").selectOption("MX");
  await expect(d.getByLabel("优先级")).toBeVisible();
  await d.getByTestId("dns-type").selectOption("SRV");
  await expect(d.getByLabel("端口")).toBeVisible();
  await d.getByTestId("dns-type").selectOption("A");
  await d.getByLabel("IPv4 地址").fill("203.0.113.77");
  await d.getByRole("switch", { name: "Cloudflare 代理" }).click();
  await expect(d.getByText("橙云记录固定为自动")).toBeVisible();
  await d.getByRole("button", { name: "创建记录" }).click();
  await toast(page, "记录已创建");
  await expect(d).toBeHidden();
  await search(page, name);
  await expect(row(page, name)).toContainText("203.0.113.77");
  await expect(row(page, name)).toContainText("已代理");
  // Switch the cloud off from the row.
  await page.getByTestId(`dns-cloud-${name}`).filter({ visible: true }).click();
  await expect(row(page, name)).toContainText("仅 DNS");
  // Edit.
  await openRow(page, name);
  const e = dialog(page, "编辑 DNS 记录");
  await e.getByLabel("IPv4 地址").fill("203.0.113.78");
  await e.getByLabel("备注").fill("e2e comment");
  await e.getByRole("button", { name: "保存" }).click();
  await toast(page, "记录已保存");
  await expect(row(page, name)).toContainText("203.0.113.78");
  // The same record again is refused with Cloudflare's reason.
  await page.getByTestId("dns-new").click();
  const dup = dialog(page, "新建 DNS 记录");
  await dup.getByLabel("名称").fill(name);
  await dup.getByLabel("IPv4 地址").fill("203.0.113.78");
  await dup.getByRole("button", { name: "创建记录" }).click();
  await toast(page, "记录已存在或与现有记录冲突");
  await dup.getByRole("button", { name: "取消" }).click();
  // Delete.
  await openRow(page, name);
  await dialog(page, "编辑 DNS 记录").getByRole("button", { name: "删除" }).click();
  await confirmDialog(page, undefined, /删除记录/);
  await toast(page, "记录已删除");
  await expect(row(page, name)).toBeHidden();
});

test("DNS-04: a record the panel depends on is marked and needs a confirmation to change or delete", async ({
  page,
}, info) => {
  const name = `${uniq(info, "pk")}.${ZONE_NAME}`;
  const account = await accountId(uniq(info, "cf-good"));
  const old = sql("SELECT coalesce(passkey_domain, '') FROM panel_settings WHERE id = 1");
  const id = await addRecord(account, name, "203.0.113.90");
  try {
    sql(`UPDATE panel_settings SET passkey_domain = '${name}' WHERE id = 1`);
    await openConsole(page, `/dns?zone=${account}:${ZONE}&q=${name}`);
    await expect(row(page, name)).toContainText("面板使用中");
    // Changing the address asks first; declining leaves the record alone.
    await openRow(page, name);
    const e = dialog(page, "编辑 DNS 记录");
    await expect(e.getByText("通行密钥中心域名")).toBeVisible();
    await e.getByLabel("IPv4 地址").fill("203.0.113.91");
    await e.getByRole("button", { name: "保存" }).click();
    const ask = page.getByRole("alertdialog", { name: "这会影响面板自身的功能" });
    await expect(ask).toContainText(name);
    await expect(ask).toContainText("通行密钥中心域名");
    await ask.getByRole("button", { name: "取消" }).click();
    await expect(e).toBeVisible();
    // Confirming applies it.
    await e.getByRole("button", { name: "保存" }).click();
    await confirmDialog(page, undefined, /仍然保存/);
    await toast(page, "记录已保存");
    await expect(row(page, name)).toContainText("203.0.113.91");
    // Changing only the comment needs no confirmation.
    await openRow(page, name);
    await dialog(page, "编辑 DNS 记录").getByLabel("备注").fill("only a comment");
    await dialog(page, "编辑 DNS 记录").getByRole("button", { name: "保存" }).click();
    await toast(page, "记录已保存");
    // Deleting asks twice: the usual confirmation, then the impact.
    await openRow(page, name);
    await dialog(page, "编辑 DNS 记录").getByRole("button", { name: "删除" }).click();
    await confirmDialog(page, undefined, /删除记录/);
    await confirmDialog(page, undefined, /仍然删除/);
    await toast(page, "记录已删除");
    await expect(row(page, name)).toBeHidden();
  } finally {
    sql(`UPDATE panel_settings SET passkey_domain = ${old ? `'${old}'` : "NULL"} WHERE id = 1`);
    await apiJson("DELETE", `/dns/accounts/${account}/zones/${ZONE}/records/${id}?confirm=true`).catch(() => {});
  }
});

test("DNS-05: batch — select, orange cloud, a new address (other families skipped with the reason), delete", async ({
  page,
}, info) => {
  const base = uniq(info, "batch");
  const account = await accountId(uniq(info, "cf-good"));
  await addRecord(account, `${base}-1.${ZONE_NAME}`, "203.0.113.81");
  await addRecord(account, `${base}-2.${ZONE_NAME}`, "203.0.113.82");
  await openConsole(page, `/dns?zone=${account}:${ZONE}`);
  await search(page, base);
  await expect(page.locator("[data-row]:visible")).toHaveCount(2);
  await page.getByRole("checkbox", { name: "全选本页" }).first().check();
  const bar = page.getByTestId("bulk-bar");
  await expect(bar).toContainText("已选 2 项");
  await bar.getByRole("button", { name: "设为橙云" }).click();
  await toast(page, "已处理 2 条记录");
  await expect(row(page, `${base}-1`)).toContainText("已代理");
  await expect(row(page, `${base}-2`)).toContainText("已代理");
  await page.getByRole("checkbox", { name: "全选本页" }).first().check();
  await bar.getByRole("button", { name: "更换 IP" }).click();
  const ip = dialog(page, "批量更换 IP");
  await ip.getByLabel("新地址").fill("203.0.113.99");
  await ip.getByRole("button", { name: "更换" }).click();
  await toast(page, "已处理 2 条记录");
  await expect(row(page, `${base}-1`)).toContainText("203.0.113.99");
  // An IPv6 address does not fit A records: both are skipped, with the reason.
  await page.getByRole("checkbox", { name: "全选本页" }).first().check();
  await bar.getByRole("button", { name: "更换 IP" }).click();
  await ip.getByLabel("新地址").fill("2001:db8::1");
  await ip.getByRole("button", { name: "更换" }).click();
  const res = dialog(page, "批量操作结果");
  await expect(res.getByTestId("dns-batch-results")).toContainText("已跳过");
  await expect(res.getByTestId("dns-batch-results").locator("li")).toHaveCount(2);
  await res.getByRole("button", { name: "好" }).click();
  await expect(row(page, `${base}-1`)).toContainText("203.0.113.99");
  // Delete both (type the count).
  await page.getByRole("checkbox", { name: "全选本页" }).first().check();
  await bar.getByRole("button", { name: "删除" }).click();
  await confirmDialog(page, "2", /删除记录/);
  await toast(page, "已处理 2 条记录");
  await expect(page.locator("[data-row]:visible")).toHaveCount(0);
});

test("DNS-07: site domains — the panel's address (owner), point a name at the panel, a node domain goes back to grey", async ({
  page,
}, info) => {
  const account = await accountId(uniq(info, "cf-good"));
  const sub = `${uniq(info, "link")}.${ZONE_NAME}`;
  const node = `${uniq(info, "linknode")}.${ZONE_NAME}`;
  const addresses = sql(
    "SELECT coalesce(public_ipv4, '') || '|' || coalesce(public_ipv6, '') FROM panel_settings WHERE id = 1",
  );
  const [old4, old6] = addresses.split("|");
  const nodeRecord = await addRecord(account, node, "8.8.4.4", { proxied: true, ttl: 1 });
  try {
    sql("UPDATE panel_settings SET public_ipv4 = NULL, public_ipv6 = NULL WHERE id = 1");
    for (const [kind, host] of [
      ["sub", sub],
      ["node", node],
    ])
      sql(
        `INSERT INTO site_domains (kind, domain, host, preferred) VALUES ('${kind}', '${host}', '${host}', NOT EXISTS (SELECT 1 FROM site_domains WHERE kind = '${kind}'))`,
      );
    await openConsole(page, "/settings/domains");
    const subRow = page.locator(`[data-domain="${sub}"]`);
    // Without a panel address the row offers to set it (owner).
    await expect(subRow.getByText("Cloudflare 上还没有解析记录")).toBeVisible();
    await subRow.getByRole("button", { name: "设置面板地址" }).click();
    const d = dialog(page, "面板的公网地址");
    await d.getByLabel("IPv4").fill("10.0.0.1");
    await d.getByRole("button", { name: "保存" }).click();
    await toast(page, "必须是公网");
    await d.getByLabel("IPv4").fill("8.8.8.8");
    await d.getByLabel("IPv6").fill("2001:4860:4860::8888");
    await d.getByRole("button", { name: "保存" }).click();
    await toast(page, "面板地址已保存");
    // Point the name at the panel: an A and an AAAA record appear.
    await subRow.getByRole("button", { name: "指向本面板" }).click();
    await toast(page, "解析已更新");
    await expect(subRow.getByTestId("dns-record-chip")).toHaveCount(2);
    await expect(subRow).toContainText("A 8.8.8.8");
    await expect(subRow).toContainText("AAAA 2001:4860:4860::8888");
    // The node domain was orange: one click makes it grey (asks, it is in use).
    const nodeRow = page.locator(`[data-domain="${node}"]`);
    await nodeRow.getByRole("button", { name: "改为灰云" }).click();
    await confirmDialog(page, undefined, /仍然切换/);
    await toast(page, "已改为灰云");
    await expect(nodeRow.getByRole("button", { name: "改为灰云" })).toHaveCount(0);
  } finally {
    sql(`DELETE FROM site_domains WHERE host IN ('${sub}', '${node}')`);
    sql(
      `UPDATE panel_settings SET public_ipv4 = ${old4 ? `'${old4}'` : "NULL"}, public_ipv6 = ${old6 ? `'${old6}'` : "NULL"} WHERE id = 1`,
    );
    const { records } = await apiJson<{ records: { id: string }[] }>(
      "GET",
      `/dns/accounts/${account}/zones/${ZONE}/records?search=link`,
    );
    for (const r of records)
      await apiJson("DELETE", `/dns/accounts/${account}/zones/${ZONE}/records/${r.id}?confirm=true`).catch(() => {});
    await apiJson("DELETE", `/dns/accounts/${account}/zones/${ZONE}/records/${nodeRecord}?confirm=true`).catch(
      () => {},
    );
  }
});

test('DNS-08: a server — its certificate domain follows the server\'s address, and "IP changed" updates it in one click', async ({
  page,
}, info) => {
  const account = await accountId(uniq(info, "cf-good"));
  const host = `${uniq(info, "srv")}.${ZONE_NAME}`;
  const { id } = await apiJson<{ id: string }>("POST", "/servers", { name: uniq(info, "dns-server") });
  sql(`UPDATE servers SET tls_domain = '${host}', agent_addr = '8.8.4.4'::inet WHERE id = '${id}'`);
  try {
    await openConsole(page, `/nodes/${id}?tab=settings`);
    const card = page.getByTestId("server-dns");
    await expect(card.getByTestId(`server-dns-${host}`)).toContainText("还没有解析记录");
    await card.getByRole("button", { name: "指向 8.8.4.4" }).click();
    await toast(page, "解析已更新");
    await expect(card.getByTestId(`server-dns-${host}`)).toContainText("A 8.8.4.4");
    // The machine moved: type the new address; the name is in use, so it asks.
    await card.getByRole("button", { name: "IP 变了" }).click();
    await card.getByLabel("新的 IP 地址").fill("8.8.8.8");
    await card.getByRole("button", { name: "更新全部解析" }).click();
    await confirmDialog(page, undefined, /仍然修改/);
    await toast(page, "解析已更新");
    await expect(card.getByTestId(`server-dns-${host}`)).toContainText("A 8.8.8.8");
    await expect(card.getByTestId(`server-dns-${host}`)).not.toContainText("8.8.4.4");
  } finally {
    const { records } = await apiJson<{ records: { id: string }[] }>(
      "GET",
      `/dns/accounts/${account}/zones/${ZONE}/records?search=${host}`,
    );
    for (const r of records)
      await apiJson("DELETE", `/dns/accounts/${account}/zones/${ZONE}/records/${r.id}?confirm=true`).catch(() => {});
    await apiJson("DELETE", `/servers/${id}`).catch(() => {});
  }
});

test("DNS-06: the audit log names the DNS changes and the token never appears; the tokens are removed", async ({
  page,
}, info) => {
  const good = uniq(info, "cf-good");
  const rows = sql(`SELECT count(*) FROM audit_log WHERE action LIKE 'dns.record.%'`);
  expect(Number(rows)).toBeGreaterThan(0);
  expect(
    sql(
      `SELECT count(*) FROM audit_log WHERE action LIKE 'dns.%' AND (before::text LIKE '%${GOOD}%' OR after::text LIKE '%${GOOD}%')`,
    ),
  ).toBe("0");
  await openConsole(page, "/audit?action=dns.record.create");
  await expect(row(page, "添加 DNS 记录")).toBeVisible();
  await openConsole(page, "/dns?tokens=1");
  const d = dialog(page, "Cloudflare 令牌");
  await d.getByTestId(`dns-account-${good}`).getByRole("button", { name: "删除" }).click();
  await confirmDialog(page, good, /删除令牌/);
  await toast(page, "令牌已删除");
});
