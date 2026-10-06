// INVENTORY §15 (settings). Every test leaves the site as it found it
// (the mobile project runs the same file after the desktop one).
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  ADMIN,
  CONSOLE,
  MAILPIT,
  PAY_DIR,
  PNG,
  PREFIX,
  SMTP_PORT,
  confirmDialog,
  dialog,
  openConsole,
  sql,
  toast,
  uniq,
} from "./helpers";

test.describe.configure({ mode: "serial" });

async function setSwitch(s: Locator, on: boolean) {
  if ((await s.getAttribute("aria-checked")) !== String(on)) await s.click();
  await expect(s).toHaveAttribute("aria-checked", String(on));
}

async function tab(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("link", { name: new RegExp(`^${name}`) })
    .click();
}

test("SET-01 SET-02 SET-03 SET-04 SET-05 SET-25: site name and time zone, domain lists, removal impact, per-user subscription domains, certificate names, obsolete keys", async ({
  page,
}, info) => {
  await openConsole(page, "/settings/site");
  // SET-25: the e2e panel.toml carries obsolete keys on purpose.
  await expect(page.getByText("panel.toml 中有已废弃的键")).toBeVisible();
  // SET-01.
  await page.getByLabel("站点名称").fill("Akari E2E");
  await page.getByLabel("站点时区（IANA 名称）").fill("Asia/Tokyo");
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  await toast(page, "站点设置已保存");
  await page.getByLabel("站点时区（IANA 名称）").fill("Not/AZone");
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  await expect(page.locator("[data-toast]").filter({ hasText: /时区/ }).first()).toBeVisible();
  await page.getByLabel("站点名称").fill("");
  await page.getByLabel("站点时区（IANA 名称）").fill("");
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  await toast(page, "站点设置已保存");
  // SET-02 / SET-04: a subscription domain (DNS check), per-user domains.
  const sub = `${uniq(info, "sub")}.e2e.test`;
  const subs = page.getByRole("textbox", { name: /^订阅域名 \d/ });
  const n = await subs.count();
  await page.getByRole("button", { name: "添加", exact: true }).nth(1).click();
  await page.getByRole("textbox", { name: `订阅域名 ${n + 1}` }).fill(sub);
  await page
    .getByRole("button", { name: "DNS 检测" })
    .nth((await page.getByRole("textbox", { name: /^主域名 \d/ }).count()) + n)
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /✓|⚠|解析|DNS|NXDOMAIN|no/i })
      .first(),
  ).toBeVisible();
  await setSwitch(page.getByRole("switch", { name: "每个用户随机分配订阅域名" }), true);
  await page.getByLabel("信任 Cloudflare（读取 CF-Connecting-IP）").selectOption("false");
  await page.getByRole("button", { name: "保存域名" }).click();
  await toast(page, "域名设置已保存");
  await expect(page.getByRole("textbox", { name: `订阅域名 ${n + 1}` })).toHaveValue(sub);
  // SET-03: removing it lists the impact and wants the domain typed.
  const row = page.getByRole("textbox", { name: `订阅域名 ${n + 1}` }).locator("..");
  await row.getByRole("button", { name: "移除" }).click();
  await setSwitch(page.getByRole("switch", { name: "每个用户随机分配订阅域名" }), false);
  await page.getByLabel("信任 Cloudflare（读取 CF-Connecting-IP）").selectOption("");
  await page.getByRole("button", { name: "保存域名" }).click();
  await expect(dialog(page)).toContainText("以下地方会受影响");
  await confirmDialog(page, sub);
  await toast(page, "域名设置已保存");
  await expect(page.getByRole("textbox", { name: `订阅域名 ${n + 1}` })).toHaveCount(0);
  // SET-05: the gRPC certificate names (in use ones say so).
  await expect(page.getByText("节点通信证书域名")).toBeVisible();
  await expect(page.getByText("当前", { exact: true }).first()).toBeVisible();
});

test("SET-06 SET-07 SET-08 SET-09: console address and prefix rotation, the IP allowlist, sign-in policies, security values", async ({
  page,
}) => {
  await openConsole(page, "/settings/security");
  // SET-06: masked, shown on demand.
  await expect(page.getByText(`${CONSOLE.slice(0, CONSOLE.indexOf(PREFIX))}${PREFIX.slice(0, 3)}`)).toBeVisible();
  await page.getByRole("button", { name: "显示" }).click();
  await expect(page.getByText(CONSOLE, { exact: true })).toBeVisible();
  // Rotate to a custom prefix, then back to the original one.
  const temp = `e2e${PREFIX.slice(0, 20)}x`;
  for (const [from, to] of [
    [PREFIX, temp],
    [temp, PREFIX],
  ]) {
    await page.getByLabel("新前缀（留空 = 随机生成）").fill(to);
    await page.getByRole("button", { name: "轮换前缀" }).click();
    await expect(dialog(page)).toContainText("旧地址立即失效");
    await confirmDialog(page, "轮换");
    await expect(dialog(page, "新的后台地址")).toContainText(`/${to}/admin`);
    await dialog(page).getByRole("button", { name: "前往新地址" }).click();
    await expect(page).toHaveURL(new RegExp(`/${to}/(admin/settings/security|app)`));
    if (page.url().includes("/app")) {
      await page.locator("#email").fill(ADMIN);
      await page.locator("#password").fill(process.env.E2E_ADMIN_PW ?? "");
      await page.locator("form button[type=submit]").click();
    }
    await expect(page.getByRole("heading", { name: "后台地址（D4）" })).toBeVisible();
    expect((await page.request.get(page.url().replace(`/${to}/`, `/${from}/`))).status()).toBe(404);
  }
  // SET-07: the allowlist must contain this address; then cleared.
  const hint = await page.getByText(/你的地址：.*（保存时必须包含它）/).innerText();
  const mine = hint
    .replace(/^你的地址：/, "")
    .replace(/（.*$/, "")
    .trim();
  const allow = page.getByLabel("后台 IP 白名单（每行一个地址或 CIDR；留空 = 任意地址）");
  await allow.fill("203.0.113.7");
  await page.getByRole("button", { name: "保存白名单" }).click();
  await confirmDialog(page);
  await expect(page.locator("[data-toast]").filter({ hasNotText: "白名单已保存" }).first()).toBeVisible();
  await allow.fill(`${mine}\n203.0.113.7`);
  await page.getByRole("button", { name: "保存白名单" }).click();
  await expect(dialog(page)).toContainText("akari settings unset admin-allow");
  await confirmDialog(page);
  await toast(page, "白名单已保存");
  await allow.fill("");
  await page.getByRole("button", { name: "保存白名单" }).click();
  await confirmDialog(page);
  await toast(page, "白名单已保存");
  // SET-08: sign-in policies (switch and back).
  const prompt = page.getByRole("switch", { name: "密码登录后引导绑定通行密钥" });
  const was = (await prompt.getAttribute("aria-checked")) === "true";
  await prompt.click();
  await toast(page, "已保存");
  await setSwitch(prompt, was);
  await expect(page.getByRole("switch", { name: "管理员仅允许通行密钥登录" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "用户仅允许通行密钥登录" })).toBeVisible();
  // SET-09: retention and keys (the official key is listed read-only).
  await expect(page.getByText(/（内置官方）/).first()).toBeVisible();
  const audit = page.getByLabel(/^审计日志保留天数/);
  await audit.fill("400");
  await page.getByRole("button", { name: "保存", exact: true }).last().click();
  await toast(page, "安全设置已保存");
  await audit.fill("180");
  await page.getByRole("button", { name: "保存", exact: true }).last().click();
  await toast(page, "安全设置已保存");
});

test("SET-15 SET-16 SET-17 SET-18: mail via SMTP, step-by-step diagnosis, the outbox, templates", async ({
  page,
}, info) => {
  await openConsole(page, "/settings/mail");
  // SET-15: SMTP to the Mailpit sink.
  await setSwitch(page.getByRole("switch", { name: "启用邮件发送" }), true);
  await page.getByRole("button", { name: "SMTP", exact: true }).click();
  await page.getByLabel("SMTP 服务器").fill("127.0.0.1");
  await page.getByLabel("端口", { exact: true }).fill(String(SMTP_PORT));
  await page.getByLabel("加密方式").selectOption("none");
  await page.getByLabel("发件地址").fill("panel@e2e.test");
  await page.getByLabel("发件人名称").fill("Akari");
  await setSwitch(page.getByRole("switch", { name: "退款通知" }), true);
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  await toast(page, "邮件设置已保存");
  // SET-16: diagnose and send.
  const to = `${uniq(info, "diag")}@e2e.test`;
  await page.getByLabel("收件地址").fill(to);
  await page.getByRole("button", { name: "诊断并发送" }).click();
  const report = page.getByRole("list", { name: "诊断结果" });
  await expect(report.getByText("测试邮件已被接受")).toBeVisible();
  await expect(report.locator("[data-step=config]")).toContainText("未加密连接");
  for (const step of ["tcp", "send"]) await expect(report.locator(`[data-step=${step}]`)).toContainText("ok");
  await page.getByRole("button", { name: "直接发送测试邮件" }).click();
  await toast(page, `测试邮件已发出：${to}`);
  if (MAILPIT) {
    await expect(async () => {
      const r = await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`)).json();
      expect(r.messages_count).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000 });
  }
  // SET-17: a dead letter, retried.
  const subject = uniq(info, "dead letter");
  sql(
    `INSERT INTO mail_outbox (kind, to_addr, subject, body_text, body_html, status, attempts, last_error, settled_at) ` +
      `VALUES ('test', 'nobody@e2e.test', '${subject}', 'body', '<p>body</p>', 'dead', 8, '550 mailbox unavailable', now())`,
  );
  await page.reload();
  await page
    .getByLabel("发件箱")
    .selectOption("dead")
    .catch(() => undefined);
  const dead = page.locator("[data-row]:visible", { hasText: subject });
  await expect(dead).toContainText("550 mailbox unavailable");
  await dead.getByRole("button", { name: "重试", exact: true }).click();
  await toast(page, "已重新排队");
  // SET-18: templates — edit with a placeholder, unknown placeholders refused, preview, test, reset.
  await tab(page, "邮件模板");
  await page.getByLabel("邮件种类").selectOption({ index: 0 });
  const body = page.getByLabel("邮件正文");
  await body.fill(`${await body.inputValue()}\n\n{nope}`);
  await expect(page.getByText("未知占位符：nope")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await body.fill((await body.inputValue()).replace("\n\n{nope}", "\n\nE2E 自定义"));
  await page.getByLabel("邮件主题").fill(`E2E ${info.project.name}`);
  await expect(page.frameLocator("iframe[title='邮件 HTML 预览']").getByText("E2E 自定义")).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "模板已保存");
  await expect(page.getByText("已自定义", { exact: true })).toBeVisible();
  await page.getByLabel("测试收件地址（发送已保存的版本，使用示例数据）").fill(to);
  await page.getByRole("button", { name: "发送测试" }).click();
  await toast(page, `测试邮件已发出：${to}`);
  await page.getByRole("button", { name: "恢复默认" }).click();
  await confirmDialog(page);
  await toast(page, "已恢复默认");
  await expect(page.getByText("已自定义", { exact: true })).toHaveCount(0);
});

test("SET-10 SET-11 SET-12: subscription path (with the mail job), routing rules, formats and import buttons", async ({
  page,
}) => {
  await openConsole(page, "/settings/subscription");
  const current = (await page.getByText(/^\/.+\/<token>$/).innerText()).split("/")[1];
  // SET-10: a new path, every user mailed (a batch job), then back without mail.
  for (const [path, notify] of [
    [`${current.slice(0, 20)}e2e`, true],
    [current, false],
  ] as const) {
    await page.getByLabel("新路径（4–64 位字母、数字、- 或 _）").fill(path);
    const box = page.getByRole("checkbox", { name: "邮件通知所有用户新链接" });
    if ((await box.isChecked()) !== notify) await box.click();
    await page.getByRole("button", { name: "应用新路径" }).click();
    await expect(dialog(page)).toContainText("所有用户的旧订阅链接立即失效");
    await confirmDialog(page, "旧链接全部失效");
    await toast(page, "订阅路径已更新（写入审计）");
    if (notify) await toast(page, "邮件通知任务已创建（用户 → 批量任务）");
    await expect(page.getByText(`/${path}/<token>`)).toBeVisible();
  }
  // SET-11: add a rule, move it up, delete it; restore defaults.
  const rules = page.getByRole("combobox", { name: "类型" });
  const count = await rules.count();
  await page.getByRole("button", { name: "添加规则" }).click();
  await expect(rules).toHaveCount(count + 1);
  await rules.last().selectOption("domain_suffix");
  await page.getByRole("textbox", { name: "值" }).last().fill("example.org");
  await page.getByRole("combobox", { name: "动作" }).last().selectOption("reject");
  await page.getByRole("button", { name: "上移" }).last().click();
  await page.getByRole("button", { name: "保存分流规则" }).click();
  await toast(page, "订阅设置已保存");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "值" }).nth(count - 1)).toHaveValue("example.org");
  await page.getByRole("button", { name: "恢复默认" }).click();
  await page.getByRole("button", { name: "保存分流规则" }).click();
  await toast(page, "订阅设置已保存");
  await expect(rules).toHaveCount(count);
  // SET-12: a format and an import button off, then on.
  for (const name of ["sing-box", "Hiddify"]) {
    const c = page.getByRole("checkbox", { name, exact: true }).first();
    await c.click();
    await toast(page, "已保存");
    await expect(c).not.toBeChecked();
    await c.click();
    await expect(c).toBeChecked();
  }
});

test("SET-13 SET-14: sign-up and password reset, bot protection", async ({ page }) => {
  await openConsole(page, "/settings/signup");
  // SET-13: open registration with invite codes, a domain allow-list; then closed again.
  const open = page.getByRole("switch", { name: "开放注册" });
  await setSwitch(open, true);
  await setSwitch(page.getByRole("switch", { name: "注册需要邀请码" }), true);
  await page.getByLabel("每个用户最多的邀请码数量").fill("3");
  await page.getByLabel("邮箱域名白名单（逗号分隔，留空 = 不限）").fill("e2e.test, example.com");
  await page.getByLabel("试用天数").fill("7");
  const saved = page.waitForResponse((r) => r.url().endsWith("/settings/signup") && r.request().method() === "PUT");
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  const res = await saved;
  expect(res.status(), await res.text()).toBe(200);
  await toast(page, "注册设置已保存");
  await page.reload();
  await expect(page.getByLabel("邮箱域名白名单（逗号分隔，留空 = 不限）")).toHaveValue("e2e.test, example.com");
  await setSwitch(page.getByRole("switch", { name: "开放注册" }), false);
  await setSwitch(page.getByRole("switch", { name: "注册需要邀请码" }), false);
  await page.getByLabel("邮箱域名白名单（逗号分隔，留空 = 不限）").fill("");
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  await toast(page, "注册设置已保存");
  // SET-14: honeypot and the minimum time (Turnstile is covered by SH-05).
  await setSwitch(page.getByRole("switch", { name: "蜜罐字段" }), true);
  await page.getByLabel("最短提交时间（秒，0 = 关闭）").fill("0");
  await expect(page.getByLabel("Turnstile 站点密钥")).toBeVisible();
  await expect(page.getByLabel("Turnstile 密钥（只写）")).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "保存", exact: true }).last().click();
  await toast(page, "人机验证设置已保存");
});

test("SET-19: payment methods — add from key files, test, disable, edit, delete", async ({ page }, info) => {
  const name = uniq(info, "支付宝");
  await openConsole(page, "/settings/payments");
  await page.getByLabel("类型").selectOption("alipay_f2f");
  await page.getByRole("button", { name: "添加支付方式" }).click();
  const d = dialog(page);
  await d.getByLabel("名称（用户可见）").fill(name);
  await setSwitch(d.getByRole("switch", { name: "启用" }), false);
  await d.getByLabel("环境").selectOption("custom");
  await d.getByLabel("网关地址（仅自定义）").fill("http://127.0.0.1:9/gateway.do");
  await d.getByLabel("APPID").fill("2021000000000001");
  await d.getByLabel("从文件读取 应用私钥").setInputFiles(join(PAY_DIR, "app-key.pem"));
  await d.getByLabel("从文件读取 支付宝公钥").setInputFiles(join(PAY_DIR, "alipay-pub.pem"));
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "支付方式已保存");
  const item = page.getByRole("listitem").filter({ hasText: name });
  await expect(item).toContainText("已停用");
  // Test the connection (nobody listens on the gateway: reported, not thrown).
  await item.getByRole("button", { name: "测试连接" }).click();
  await expect(page.locator("[data-toast]").first()).toBeVisible();
  // Edit: secrets left empty are kept; the app public key and notify URL shown.
  await item.getByRole("button", { name: "编辑" }).click();
  const e = dialog(page);
  await expect(e.getByText(/已设置.*留空 = 不修改/).first()).toBeVisible();
  await expect(e.getByLabel("应用公钥（上传到支付宝开放平台）")).toHaveValue(/^MIIB/);
  await e.getByLabel("排序（小的在前）").fill("9");
  await e.getByRole("button", { name: "保存" }).click();
  await toast(page, "支付方式已保存");
  await expect(item).toContainText("排序 9");
  // Delete (unused).
  await item.getByRole("button", { name: "删除" }).click();
  await confirmDialog(page, name);
  await toast(page, "已删除");
  await expect(item).toHaveCount(0);
});

test("SET-20 SET-21 SET-22 SET-23 SET-24: node communication, probes, block rules, account cleanup, branding", async ({
  page,
}, info) => {
  await openConsole(page, "/settings/nodes");
  // SET-20.
  await page.getByLabel("ACME 邮箱（可选）").fill("ops@e2e.test");
  await page.getByLabel("撤权方式").selectOption({ index: 1 });
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  await toast(page, "节点通信设置已保存");
  await page.getByLabel("ACME 邮箱（可选）").fill("");
  await page.getByLabel("撤权方式").selectOption({ index: 0 });
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  await toast(page, "节点通信设置已保存");
  // SET-21.
  await page.getByLabel(/^测速间隔/).fill("10");
  await page.getByLabel("面板 TCP 测速（也决定中转入口探测）").selectOption("false");
  await page.getByLabel("测速地址（1–4 个，每行一个，留空 = 默认）").fill("https://www.example.com/");
  await page.getByRole("button", { name: "保存", exact: true }).last().click();
  await toast(page, "测速设置已保存");
  await page.getByLabel(/^测速间隔/).fill("");
  await page.getByLabel("面板 TCP 测速（也决定中转入口探测）").selectOption("");
  await page.getByLabel("测速地址（1–4 个，每行一个，留空 = 默认）").fill("");
  await page.getByRole("button", { name: "保存", exact: true }).last().click();
  await toast(page, "测速设置已保存");
  // SET-22: a custom rule set — create, switch off, edit, delete; built-ins listed.
  await tab(page, "审计规则");
  await expect(page.getByText("内置", { exact: true }).first()).toBeVisible();
  const rule = uniq(info, "block");
  await page.getByRole("button", { name: "新建自定义规则" }).click();
  let d = dialog(page, "新建自定义规则");
  await d.getByLabel("名称").fill(rule);
  await d.getByLabel("类型").selectOption("domain");
  await d.getByLabel("内容（每行一条）").fill("full:ads.example.com\nkeyword:tracker");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "规则已保存");
  const item = page.getByRole("listitem").filter({ hasText: rule });
  await expect(item).toContainText("2 条");
  await item.getByRole("switch", { name: rule }).click();
  await toast(page, "已保存");
  await item.getByRole("button", { name: "编辑" }).click();
  d = dialog(page, "编辑规则");
  await d.getByLabel("内容（每行一条）").fill("full:ads.example.com");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "规则已保存");
  await expect(item).toContainText("1 条");
  await item.getByRole("button", { name: "删除" }).click();
  await confirmDialog(page);
  await toast(page, "已删除");
  // SET-23: cleanup settings and the jump to the filtered user list.
  await tab(page, "账号清理");
  await page.getByLabel("注册超过 N 天").fill("365");
  await setSwitch(page.getByRole("switch", { name: "删除前发邮件提醒" }), true);
  await page.getByLabel("提醒后等待天数").fill("14");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "清理设置已保存");
  await setSwitch(page.getByRole("switch", { name: "删除前发邮件提醒" }), false);
  await page.getByLabel("注册超过 N 天").fill("30");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "清理设置已保存");
  await page.getByRole("button", { name: "在用户列表中查看" }).click();
  await expect(page).toHaveURL(/\/users\?never_used=1/);
  // SET-24: branding — PNG logo up and down, footer and links.
  await page.goBack();
  await tab(page, "品牌");
  await page.getByLabel("上传Logo（PNG）").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await toast(page, "已上传");
  await expect(page.getByRole("img", { name: "Logo" })).toBeVisible();
  await page.getByRole("button", { name: "删除", exact: true }).first().click();
  await confirmDialog(page);
  await expect(page.getByRole("img", { name: "Logo" })).toHaveCount(0);
  await page.getByLabel("页脚文字").fill("© Akari E2E");
  await page.getByRole("button", { name: "添加链接" }).click();
  await page.getByRole("textbox", { name: "文字" }).last().fill("状态页");
  await page.getByRole("textbox", { name: "URL" }).first().fill("https://status.example.com");
  await page.getByRole("button", { name: "添加下载" }).click();
  await page.getByRole("textbox", { name: "URL" }).last().fill("https://example.com/akari.apk");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "品牌设置已保存");
  await page.reload();
  await expect(page.getByLabel("页脚文字")).toHaveValue("© Akari E2E");
  await page.getByLabel("页脚文字").fill("");
  for (const b of await page.getByRole("button", { name: "删除", exact: true }).all())
    if (await b.isVisible()) await b.click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "品牌设置已保存");
});
