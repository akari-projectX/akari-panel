// INVENTORY §15 (settings; 2026-10 redesign: grouped sections, one bottom
// save bar per section, dangerous changes confirmed on save) plus the
// settings moved in from other pages: FIN-05 (invite commissions), ALR-03/04
// (alert channels and thresholds) and UPD-01's source and automatic check.
// Every test leaves the site as it found it (the mobile project runs the
// same file after the desktop one).
import { join } from "node:path";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import {
  ADMIN,
  CONSOLE,
  PAY_DIR,
  PNG,
  PREFIX,
  RELEASE_SOURCE,
  SMTP_PORT,
  apiJson,
  confirmDialog,
  dialog,
  expectFits,
  isMobile,
  must,
  openConsole,
  sql,
  toast,
  uniq,
} from "./helpers";

test.describe.configure({ mode: "serial" });

/** The section's save bar. */
function bar(page: Page): Locator {
  return page.getByRole("region", { name: "保存栏" });
}

/** Save the section through its save bar. */
async function save(page: Page): Promise<void> {
  await bar(page).getByRole("button", { name: "保存", exact: true }).click();
}

async function setSwitch(s: Locator, on: boolean) {
  if ((await s.getAttribute("aria-checked")) !== String(on)) await s.click();
  await expect(s).toHaveAttribute("aria-checked", String(on));
}

/** Pick a time zone in the searchable picker ("" = the default). */
async function pickZone(page: Page, zone: string) {
  await page.getByRole("button", { name: "站点时区" }).click();
  if (zone) {
    await page.getByLabel("搜索时区").fill(zone);
    await page.getByRole("option", { name: zone, exact: true }).click();
  } else await page.getByRole("option", { name: /^默认/ }).click();
}

/** The settings navigation: the group list on the overview (phone) or the side navigation (desktop). */
function sections(page: Page): Locator {
  return page.getByRole("navigation", { name: "设置分类" });
}

test("SET-25: overview (needs attention: obsolete keys), search by old names, old addresses redirect, unsaved changes guard, ⌘S", async ({
  page,
}, info: TestInfo) => {
  await openConsole(page, "/settings");
  // SET-25: the e2e panel.toml carries obsolete keys on purpose.
  await expect(page.getByRole("region", { name: "需要注意" })).toContainText("个已废弃的键");
  // Search finds a section by its old name.
  await page.getByLabel("搜索设置").fill("审计规则");
  await sections(page)
    .getByRole("link", { name: /出站拦截规则/ })
    .click();
  await expect(page).toHaveURL(/\/settings\/block$/);
  await expect(page.getByRole("heading", { name: "出站拦截规则" })).toBeVisible();
  // Old tab addresses land on the new sections; the outbox moved to the status page.
  for (const [from, to] of [
    ["security", "access"],
    ["nodes", "install"],
    ["branding", "brand"],
    ["notify", "notices"],
    ["passkeys", "account"],
  ]) {
    await page.goto(`${CONSOLE}/settings/${from}`);
    await expect(page).toHaveURL(new RegExp(`/settings/${to}$`));
  }
  await page.goto(`${CONSOLE}/settings?section=payments`);
  await expect(page).toHaveURL(/\/settings\/payments$/);
  await page.goto(`${CONSOLE}/settings/mail?outbox=dead`);
  await expect(page).toHaveURL(/\/status\?mail=dead$/);
  // Unsaved changes: the save bar counts them; leaving asks first. The site name is put back
  // through the API whatever happens (other specs read it in the page title).
  const site = await apiJson<{ site_name: string | null }>("GET", "/settings");
  try {
    await guardAndShortcut(page, info);
  } finally {
    const now = await apiJson<{ version: number; site_name: string | null }>("GET", "/settings");
    if (now.site_name !== site.site_name)
      await apiJson("PUT", "/settings/site", { version: now.version, site_name: site.site_name });
  }
});

async function guardAndShortcut(page: Page, info: TestInfo) {
  await openConsole(page, "/settings/site");
  const name = page.getByLabel("站点名称");
  await name.fill("Akari guard");
  await expect(bar(page)).toContainText("1 项未保存的修改");
  const leave = () =>
    isMobile(info)
      ? // The phone top bar has its own back arrow too: use the page's.
        page.getByRole("main").getByRole("link", { name: "返回系统设置" }).click()
      : sections(page)
          .getByRole("link", { name: /域名与证书/ })
          .click();
  await leave();
  await expect(dialog(page, "有未保存的修改")).toBeVisible();
  await dialog(page, "有未保存的修改").getByRole("button", { name: "继续编辑" }).click();
  await expect(page).toHaveURL(/\/settings\/site$/);
  await expect(name).toHaveValue("Akari guard");
  // ⌘/Ctrl+S saves; then back to the default name the same way (each save finished before
  // the next edit: the bar is gone).
  await page.keyboard.press("ControlOrMeta+s");
  await toast(page, "站点设置已保存");
  await expect(bar(page)).toHaveCount(0);
  await name.fill("");
  await expect(bar(page)).toContainText("1 项未保存的修改");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(bar(page)).toHaveCount(0);
  await expect(name).toHaveValue("");
  // Discard puts the saved values back.
  await name.fill("Akari discard");
  await bar(page).getByRole("button", { name: "放弃" }).click();
  await expect(name).toHaveValue("");
  await expect(bar(page)).toHaveCount(0);
  await name.fill("Akari leave");
  await leave();
  await dialog(page, "有未保存的修改")
    .getByRole("button", { name: /^放弃修改/ })
    .click();
  await expect(page).toHaveURL(/\/settings(\/domains)?$/);
}

test("SET-01 SET-24: site name and time zone (confirmed), logo, footer, links and downloads", async ({ page }) => {
  await openConsole(page, "/settings/site");
  // SET-01: a name and a time zone; the new zone is confirmed on save.
  await page.getByLabel("站点名称").fill("Akari E2E");
  await pickZone(page, "Asia/Tokyo");
  await expect(bar(page)).toContainText("2 项未保存的修改");
  await save(page);
  await expect(dialog(page)).toContainText("之后的日界按新时区计算");
  await confirmDialog(page, undefined, "更改时区");
  await toast(page, "站点设置已保存");
  await expect(page.getByRole("button", { name: "站点时区" })).toContainText("Asia/Tokyo");
  await page.getByLabel("站点名称").fill("");
  await pickZone(page, "");
  await save(page);
  await confirmDialog(page, undefined, "更改时区");
  await toast(page, "站点设置已保存");
  await expect(page.getByRole("button", { name: "站点时区" })).toContainText("默认");
  // SET-24 (外观与品牌): a PNG logo up and down (applies at once), shown on a light and a dark tile.
  await page.goto(`${CONSOLE}/settings/brand`);
  await page.getByLabel("上传Logo（PNG）").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await toast(page, "已上传");
  await expect(page.getByRole("img", { name: "Logo", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Logo（深色底）" })).toBeVisible();
  await page.getByRole("button", { name: "删除Logo" }).click();
  await confirmDialog(page);
  await expect(page.getByRole("img", { name: "Logo", exact: true })).toHaveCount(0);
  // Footer text and a link (a bad address is refused in place).
  await page.getByLabel("页脚文字").fill("© Akari E2E");
  await page.getByRole("button", { name: "添加链接" }).click();
  await page.getByRole("textbox", { name: "文字" }).last().fill("状态页");
  const link = page.getByRole("textbox", { name: "链接地址" }).last();
  await link.fill("status.example.com");
  await expect(bar(page)).toContainText("1 处需要修正");
  await expect(bar(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await link.fill("https://status.example.com");
  await save(page);
  await toast(page, "品牌设置已保存");
  await expect(page.getByLabel("页脚文字")).toHaveValue("© Akari E2E");
  await page.getByLabel("页脚文字").fill("");
  const links = page.getByRole("button", { name: /^删除页脚链接/ });
  while ((await links.count()) > 0) await links.first().click();
  await save(page);
  await toast(page, "品牌设置已保存");
  // SET-24 (条款与下载链接): one row per platform with a portal switch; links checked in place.
  await page.goto(`${CONSOLE}/settings/links`);
  await page.getByLabel("隐私政策链接").fill("example.com/privacy");
  await expect(bar(page)).toContainText("1 处需要修正");
  await page.getByLabel("隐私政策链接").fill("");
  await setSwitch(page.getByRole("switch", { name: "在门户显示 Android" }), true);
  await page.getByLabel("Android 下载地址").fill("https://example.com/akari.apk");
  await save(page);
  await toast(page, "链接已保存");
  await expect(page.getByLabel("Android 下载地址")).toHaveValue("https://example.com/akari.apk");
  await setSwitch(page.getByRole("switch", { name: "在门户显示 Android" }), false);
  await save(page);
  await toast(page, "链接已保存");
  await expect(page.getByRole("switch", { name: "在门户显示 Android" })).toHaveAttribute("aria-checked", "false");
});

test("SET-02 SET-03 SET-04 SET-05 SET-09 SET-27: domain list cards (added in a dialog with a live check, DNS check from the row menu), removal marked and confirmed with its impact, per-user subscription domains, Cloudflare, certificate names, the passkey centre", async ({
  page,
}, info) => {
  await openConsole(page, "/settings/domains");
  // SET-02: a subscription domain from the card's "添加" (a bad name is refused in the dialog).
  const sub = `${uniq(info, "sub")}.e2e.test`;
  await page.getByRole("button", { name: "添加订阅域名" }).click();
  const add = dialog(page, "添加域名");
  await expect(add.getByRole("radio", { name: /订阅域名/ })).toHaveAttribute("aria-checked", "true");
  const input = add.getByLabel(/^域名/);
  await input.fill("portal");
  await expect(add.getByText(/不是完整域名/)).toBeVisible();
  await expect(add.getByRole("button", { name: "添加", exact: true })).toBeDisabled();
  await input.fill(sub);
  await expect(add.getByText("即时检测")).toBeVisible();
  await add.getByRole("button", { name: "添加", exact: true }).click();
  await expect(add).toHaveCount(0);
  await expect(page.locator(`[data-domain="${sub}"]`)).toContainText("新添加");
  await page.getByRole("button", { name: `更多操作 ${sub}` }).click();
  await page.getByRole("menuitem", { name: "重新检测 DNS" }).click();
  await expect(
    page
      .locator(`[data-domain="${sub}"]`)
      .getByRole("status")
      .filter({ hasText: /解析|DNS|NXDOMAIN|no/i })
      .first(),
  ).toBeAttached();
  // SET-04 and Cloudflare trust in the same save.
  await setSwitch(page.getByRole("switch", { name: "每个用户随机分配订阅域名" }), true);
  await page.getByLabel("信任 Cloudflare（读取 CF-Connecting-IP）").selectOption("false");
  await expect(bar(page)).toContainText("项未保存的修改");
  await save(page);
  await toast(page, "域名设置已保存");
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByText(sub, { exact: true })).toBeVisible();
  // SET-03: removing it lists the impact on save and wants the domain typed.
  await page.getByRole("button", { name: `更多操作 ${sub}` }).click();
  await page.getByRole("menuitem", { name: "移除…" }).click();
  await expect(page.locator(`[data-domain="${sub}"]`)).toContainText("保存时移除");
  await setSwitch(page.getByRole("switch", { name: "每个用户随机分配订阅域名" }), false);
  await page.getByLabel("信任 Cloudflare（读取 CF-Connecting-IP）").selectOption("");
  await save(page);
  await expect(dialog(page)).toContainText("以下地方会受影响");
  await confirmDialog(page, sub, "移除并保存");
  await toast(page, "域名设置已保存");
  await expect(page.locator(`[data-domain="${sub}"]`)).toHaveCount(0);
  // SET-09 (Cloudflare ranges): edited in a dialog, saved in the bar, then back to the shipped list.
  for (const ranges of ["173.245.48.0/20", ""]) {
    await page.getByRole("button", { name: "编辑网段" }).click();
    const d = dialog(page, "Cloudflare 网段");
    await d.getByLabel("网段（每行一个）").fill(ranges);
    await d.getByRole("button", { name: "完成" }).click();
    await save(page);
    await toast(page, "Cloudflare 网段已保存");
    await expect(page.getByText(ranges ? "自定义 1 段" : /使用内置的 \d+ 段/)).toBeVisible();
  }
  // SET-05: the gRPC certificate names (the one in use says so).
  await expect(page.getByText("节点通信证书域名")).toBeVisible();
  await expect(page.getByText("当前", { exact: true }).first()).toBeVisible();
  // SET-27: the passkey centre sits in the danger zone; a bad name is refused (nothing saved here:
  // zz-passkeys sets it).
  await expect(page.getByText("通行密钥中心域名").first()).toBeVisible();
  const zone = page.getByRole("region", { name: "危险操作" });
  await zone.getByRole("button", { name: /^(设置|更换)…$/ }).click();
  const d = dialog(page, "通行密钥中心域名");
  await d.getByLabel("新的中心域名").fill("bad");
  await expect(d.getByText(/不是完整域名/)).toBeVisible();
  await expect(d.getByRole("button", { name: "继续…" })).toBeDisabled();
  await d.getByRole("button", { name: "取消" }).click();
  await expect(bar(page)).toHaveCount(0);
});

test("SET-09: retention days — a shorter period is flagged in the row and confirmed on save with a typed 删除旧数据 (cancelled here)", async ({
  page,
}) => {
  await openConsole(page, "/settings/retention");
  const audit = page.getByLabel("审计日志保留天数");
  await audit.fill("40");
  await expect(page.getByText("保存后将删除更早的数据")).toBeVisible();
  await expect(page.getByText("不受这里控制的数据")).toBeVisible();
  await save(page);
  const c = page.getByRole("alertdialog");
  await expect(c).toContainText("缩短保留期");
  await expect(c.getByRole("button", { name: "缩短并删除" })).toBeDisabled();
  await c.getByLabel("确认文字").fill("删除旧数据");
  await expect(c.getByRole("button", { name: "缩短并删除" })).toBeEnabled();
  await c.getByRole("button", { name: "取消" }).click();
  await bar(page).getByRole("button", { name: "放弃" }).click();
  await expect(bar(page)).toHaveCount(0);
});

test("SET-06 SET-07: console address card (masked) and prefix rotation (random or custom, typed confirmation, the done state), the IP allowlist as a list", async ({
  page,
}) => {
  await openConsole(page, "/settings/access");
  // SET-06: masked, shown on demand.
  await expect(page.getByText(`${CONSOLE.slice(0, CONSOLE.indexOf(PREFIX))}${PREFIX.slice(0, 3)}`)).toBeVisible();
  await page.getByRole("button", { name: "显示" }).click();
  await expect(page.getByText(CONSOLE, { exact: true })).toBeVisible();
  // The whole address still fits a phone (a wider page zooms out and taps miss).
  await expectFits(page, "the console address shown");
  // Rotate to a custom prefix (danger zone), then back to the original one.
  const temp = `e2e${PREFIX.slice(0, 20)}x`;
  for (const [from, to] of [
    [PREFIX, temp],
    [temp, PREFIX],
  ]) {
    await page.getByRole("button", { name: "轮换前缀…" }).click();
    const d = dialog(page, "轮换后台前缀");
    await d.getByRole("radio", { name: /自定义/ }).click();
    await d.getByLabel("自定义前缀").fill(to);
    await expect(d).toContainText(`/${to}/admin`);
    await expect(d.getByRole("button", { name: "轮换前缀" })).toBeDisabled();
    await d.getByLabel(/输入「轮换」以确认/).fill("轮换");
    await d.getByRole("button", { name: "轮换前缀" }).click();
    await expect(dialog(page, "新的后台地址")).toContainText(`/${to}/admin`);
    await dialog(page, "新的后台地址").getByRole("button", { name: "前往新地址" }).click();
    await expect(page).toHaveURL(new RegExp(`/${to}/(admin/settings/access|app)`));
    if (page.url().includes("/app")) {
      await page.locator("#email").fill(ADMIN);
      await page.locator("#password").fill(process.env.E2E_ADMIN_PW ?? "");
      await page.locator("form button[type=submit]").click();
    }
    await expect(page.getByRole("heading", { name: "后台入口" })).toBeVisible();
    expect((await page.request.get(page.url().replace(`/${to}/`, `/${from}/`))).status()).toBe(404);
  }
  // SET-07: a list without this address is an error in place (the save is blocked) with "添加我的地址".
  const mine = await page.locator("[data-your-ip]").getAttribute("data-your-ip");
  expect(mine).toBeTruthy();
  const add = page.getByLabel("添加地址或网段");
  await add.fill("10.0.0.300");
  await expect(page.getByText("不是有效的 IP 地址或 CIDR 网段")).toBeVisible();
  await add.fill("203.0.113.7");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByText(/不在白名单里/)).toBeVisible();
  await expect(bar(page)).toContainText("1 处需要修正");
  await expect(bar(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "添加我的地址" }).click();
  await expect(page.locator(`[data-allow="${mine}"]`)).toContainText("包含你的地址");
  await save(page);
  await expect(dialog(page)).toContainText("akari settings unset admin-allow");
  await confirmDialog(page, undefined, "保存白名单");
  await toast(page, "白名单已保存");
  for (const x of [mine!, "203.0.113.7"]) await page.getByRole("button", { name: `移除 ${x}` }).click();
  await save(page);
  await confirmDialog(page, undefined, "保存白名单");
  await toast(page, "白名单已保存");
  await expect(bar(page)).toHaveCount(0);
});

test("SET-08 SET-14: sign-in policies (admins passkey-only confirmed on save with the recovery command), bot protection", async ({
  page,
}) => {
  await openConsole(page, "/settings/login");
  // SET-08: a policy through the save bar, and back.
  const prompt = page.getByRole("switch", { name: "密码登录后引导绑定通行密钥" });
  const was = (await prompt.getAttribute("aria-checked")) === "true";
  await prompt.click();
  await expect(bar(page)).toContainText("1 项未保存的修改");
  await save(page);
  await toast(page, "登录与人机验证设置已保存");
  await expect(prompt).toHaveAttribute("aria-checked", String(!was));
  await setSwitch(prompt, was);
  await save(page);
  await toast(page, "登录与人机验证设置已保存");
  await expect(page.getByRole("switch", { name: "用户只能用通行密钥登录" })).toBeVisible();
  // Admins passkey-only (danger zone): the confirmation names the recovery command; cancelled, then discarded.
  const admins = page.getByRole("switch", { name: "管理员只能用通行密钥登录" });
  await expect(admins).toHaveAttribute("aria-checked", "false");
  await admins.click();
  await save(page);
  await expect(dialog(page)).toContainText("akari admin reset-login");
  await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
  await bar(page).getByRole("button", { name: "放弃" }).click();
  await expect(admins).toHaveAttribute("aria-checked", "false");
  // SET-14: honeypot and the minimum time (validated in place; Turnstile is covered by SH-05).
  await expect(page.getByLabel("Turnstile 站点密钥")).toBeVisible();
  await expect(page.getByLabel("Turnstile 密钥（只写）")).toHaveAttribute("type", "password");
  await setSwitch(page.getByRole("switch", { name: "蜜罐字段" }), true);
  const min = page.getByLabel("最短提交时间（秒，0 = 关闭）");
  await min.fill("99");
  await expect(page.getByText("请输入 0–60 的整数")).toBeVisible();
  await expect(bar(page)).toContainText("1 处需要修正");
  await expect(bar(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  for (const v of ["1", "0"]) {
    await min.fill(v);
    await save(page);
    await toast(page, "登录与人机验证设置已保存");
    await expect(min).toHaveValue(v);
  }
});

test("SET-13 SET-28: sign-up, invites (one code per user), passkey sign-up, trial, password reset", async ({
  page,
}) => {
  await openConsole(page, "/settings/signup");
  await setSwitch(page.getByRole("switch", { name: "开放注册" }), true);
  await setSwitch(page.getByRole("switch", { name: "注册需要邀请码" }), true);
  // 允许用户邀请 (default on): off while codes are required = nobody could
  // register (no admin-issued codes), so the page says so and will not save.
  const userInvites = page.getByRole("switch", { name: "允许用户邀请" });
  await expect(userInvites).toHaveAttribute("aria-checked", "true");
  await setSwitch(userInvites, false);
  await expect(page.getByText("已发出的邀请码不能用于注册", { exact: false })).toBeVisible();
  await expect(page.getByText("没有任何邀请码可用，没人能注册", { exact: false })).toBeVisible();
  await setSwitch(userInvites, true);
  await expect(page.getByText("没有任何邀请码可用，没人能注册", { exact: false })).toHaveCount(0);
  // SET-28: the passkey sign-up switch is here (not changed: zz-passkeys covers it).
  await expect(page.getByRole("switch", { name: "允许用通行密钥注册" })).toBeVisible();
  // One invite code per user (2026-10-14): no per-user limit field any more.
  await expect(page.getByLabel("每个用户最多的邀请码数量")).toHaveCount(0);
  await expect(page.getByText("每个用户只有一个固定的邀请码，开启后每人只能邀请一人")).toBeVisible();
  const domains = page.getByLabel("添加邮箱域名");
  for (const d of ["e2e.test", "example.com"]) {
    await domains.fill(d);
    await domains.press("Enter");
  }
  await expect(page.getByRole("button", { name: "移除 example.com" })).toBeVisible();
  // The trial days show once a trial plan is chosen (put back to 不提供 at the end).
  const trial = page.getByRole("combobox", { name: "试用套餐" });
  const trialBefore = await trial.inputValue();
  if (!(await page.getByLabel("试用天数").isVisible())) await trial.selectOption({ index: 1 });
  await page.getByLabel("试用天数").fill("7");
  const saved = page.waitForResponse((r) => r.url().endsWith("/settings/signup") && r.request().method() === "PUT");
  await save(page);
  const res = await saved;
  expect(res.status(), await res.text()).toBe(200);
  await toast(page, "注册设置已保存");
  await page.reload();
  await expect(page.getByText("只有这 2 个域名的邮箱能注册", { exact: false })).toBeVisible();
  await setSwitch(page.getByRole("switch", { name: "开放注册" }), false);
  await setSwitch(page.getByRole("switch", { name: "注册需要邀请码" }), false);
  for (const d of ["e2e.test", "example.com"]) await page.getByRole("button", { name: `移除 ${d}` }).click();
  if ((await trial.inputValue()) !== trialBefore) await trial.selectOption(trialBefore);
  await save(page);
  await toast(page, "注册设置已保存");
});

test("SET-23: account cleanup (estimate for the edited days, turning it on wants a typed confirmation), the filtered user list", async ({
  page,
}) => {
  await openConsole(page, "/settings/cleanup");
  const days = page.getByLabel("注册超过 N 天");
  await days.fill("0");
  await expect(page.getByText("请输入 1–3650 的整数")).toBeVisible();
  await days.fill("365");
  await expect(page.locator("[data-cleanup-estimate]")).toHaveText(/^\d+$/);
  await setSwitch(page.getByRole("switch", { name: "删除前发邮件提醒" }), true);
  await page.getByLabel("提醒后等待天数").fill("14");
  await save(page);
  await toast(page, "清理设置已保存");
  // Automatic deletion: the first run's estimate and a typed confirmation (cancelled here).
  await page.getByRole("switch", { name: "自动清理" }).click();
  await save(page);
  const c = page.getByRole("alertdialog");
  await expect(c).toContainText("首次运行将");
  await expect(c.getByLabel("确认文字")).toBeVisible();
  await c.getByRole("button", { name: "取消" }).click();
  await bar(page).getByRole("button", { name: "放弃" }).click();
  await setSwitch(page.getByRole("switch", { name: "删除前发邮件提醒" }), false);
  await days.fill("30");
  await save(page);
  await toast(page, "清理设置已保存");
  await page.getByRole("link", { name: "在用户列表中查看" }).click();
  await expect(page).toHaveURL(/\/users\?never_used=1/);
});

test("SET-10 SET-12 SET-26: subscription path (danger zone, with the mail job), formats and import buttons (turning one off confirmed), multipliers in line names", async ({
  page,
}) => {
  await openConsole(page, "/settings/subscription");
  await page.getByRole("region", { name: "危险操作" }).getByRole("button", { name: "显示" }).click();
  const current = (await page.getByText(/^\/.+\/<token>$/).innerText()).split("/")[1];
  // SET-10: a new path, every user mailed (a batch job), then back without mail.
  for (const [path, notify] of [
    [`${current.slice(0, 20)}e2e`, true],
    [current, false],
  ] as const) {
    await page.getByRole("button", { name: "轮换订阅路径…" }).click();
    const d = dialog(page, "轮换订阅路径");
    await d.getByRole("radio", { name: /自定义/ }).click();
    await d.getByLabel("新路径（4–64 位字母、数字、- 或 _）").fill(path);
    const box = d.getByRole("checkbox", { name: "邮件通知所有用户新链接" });
    if ((await box.isChecked()) !== notify) await box.click();
    await d.getByRole("button", { name: "轮换…" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("所有用户的旧订阅链接立即失效");
    await confirmDialog(page, "旧链接全部失效", "轮换订阅路径");
    const done = dialog(page, "订阅路径已轮换");
    await expect(done).toContainText(`/${path}/<token>`);
    if (notify) await expect(done).toContainText("邮件通知任务已创建（用户 → 批量任务）");
    await done.getByRole("button", { name: "完成" }).click();
    await expect(page.getByText(`/${path}/<token>`)).toBeVisible();
  }
  // SET-12: a format and an import button off (the format confirmed), then on again.
  const format = page.getByRole("switch", { name: "订阅格式 sing-box" });
  const hiddify = page.getByRole("switch", { name: "一键导入 Hiddify" });
  await setSwitch(format, false);
  await setSwitch(hiddify, false);
  await save(page);
  await expect(dialog(page)).toContainText("统一 404");
  await confirmDialog(page, undefined, "关闭并保存");
  await toast(page, "订阅设置已保存");
  await expect(format).toHaveAttribute("aria-checked", "false");
  await setSwitch(format, true);
  await setSwitch(hiddify, true);
  await save(page);
  await toast(page, "订阅设置已保存");
  await expect(bar(page)).toHaveCount(0);
  // SET-26: off by default; turning it on is confirmed; off again without a confirmation.
  const rate = page.getByRole("switch", { name: "订阅线路名显示倍率" });
  await expect(rate).toHaveAttribute("aria-checked", "false");
  await rate.click();
  await save(page);
  await expect(dialog(page)).toContainText("客户端刷新订阅后会丢失用户选中的线路");
  await confirmDialog(page, undefined, "开启并保存");
  await toast(page, "订阅设置已保存");
  await expect(page.getByText(/已开启：修改入口倍率会改变线路名/)).toBeVisible();
  await setSwitch(rate, false);
  await save(page);
  await toast(page, "订阅设置已保存");
  await expect(page.getByText(/已开启：修改入口倍率会改变线路名/)).toHaveCount(0);
});

test("SET-27: own client only — the switch greys the third-party formats and import buttons, turning it on is confirmed with its effects, off restores them", async ({
  page,
}) => {
  await openConsole(page, "/settings/subscription");
  const own = page.getByRole("switch", { name: "仅自研客户端" });
  const format = page.getByRole("switch", { name: "订阅格式 Clash / mihomo" });
  const clash = page.getByRole("switch", { name: "一键导入 Clash Verge / mihomo" });
  await expect(own).toHaveAttribute("aria-checked", "false");
  await expect(format).toBeEnabled();
  await own.click();
  await expect(format).toBeDisabled();
  await expect(clash).toBeDisabled();
  await save(page);
  const d = dialog(page);
  await expect(d).toContainText("用户看不到订阅链接、二维码与导入按钮");
  await expect(d).toContainText("下次更新订阅时失败（统一 404）");
  await confirmDialog(page, undefined, "开启并保存");
  await toast(page, "订阅设置已保存");
  await expect(page.getByText(/已开启：第三方格式与导入按钮暂停/)).toBeVisible();
  const view = await apiJson<{ subscription: { own_client_only: boolean; formats: { effective: string[] } } }>(
    "GET",
    "/settings",
  );
  expect(view.subscription.own_client_only).toBe(true);
  expect(view.subscription.formats.effective).toContain("clash");
  // Off again: no confirmation, the formats are back.
  await setSwitch(own, false);
  await save(page);
  await toast(page, "订阅设置已保存");
  await expect(format).toBeEnabled();
  await expect(format).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/已开启：第三方格式与导入按钮暂停/)).toHaveCount(0);
});

test("SET-11: routing editor — sections by destination, one auto-detecting input (domain / IP / category / remote rule-set), services with a primary and ordered backups, conflicts, the test box, DNS, global mode, save → reload, restore the recommended routing", async ({
  page,
}, info) => {
  const view = () => apiJson<{ version: number; subscription: { routing: { value: unknown } } }>("GET", "/settings");
  const before = (await view()).subscription.routing.value;
  // Start from the recommended routing.
  await apiJson("PUT", "/settings/subscription", { version: (await view()).version, routing: null });
  // Two lines in two regions to pin.
  const { id: serverId } = await apiJson<{ id: string }>("POST", "/servers", { name: uniq(info, "route-host") });
  const nodes: { id: string; entrance: string; region: string }[] = [];
  for (const region of ["E2E-JP", "E2E-HK"]) {
    const { id } = await apiJson<{ id: string }>("POST", "/nodes", {
      server_id: serverId,
      name: uniq(info, `route-${region}`),
      inbound: { protocol: "vmess", port: 21000 + Math.floor(Math.random() * 20000), settings: { clients: [] } },
    });
    sql(`UPDATE nodes SET region = '${region}' WHERE id = '${id}'`);
    const n = await apiJson<{ entrances: { id: string }[] }>("GET", `/nodes/${id}`);
    nodes.push({ id, entrance: n.entrances[0].id, region });
  }
  try {
    await openConsole(page, "/settings/routing");
    const blocked = page.getByRole("region", { name: "拦截", exact: true });
    const direct = page.getByRole("region", { name: "直连", exact: true });
    const netflix = page.getByRole("region", { name: "Netflix", exact: true });
    const result = page.getByTestId("routing-test-result");
    const test = page.getByRole("textbox", { name: "测试网址" });

    // A domain (Enter takes the highlighted suggestion; ↓↑ move it), its kind toggles.
    const addBlock = page.getByRole("combobox", { name: "添加到「拦截」" });
    await addBlock.fill("ads.e2e.test");
    await expect(page.getByRole("option", { name: /ads\.e2e\.test 及子域名/ })).toBeVisible();
    await addBlock.press("ArrowDown");
    await addBlock.press("ArrowUp");
    await addBlock.press("Enter");
    await expect(blocked.getByText("ads.e2e.test 及子域名")).toBeVisible();
    await blocked.getByRole("button", { name: "切换类型（现在：域名后缀）" }).click();
    await expect(blocked.getByText("仅 ads.e2e.test")).toBeVisible();
    // An IP range and a category (by its Chinese alias) into 直连: the category is then a conflict in Netflix.
    const addDirect = page.getByRole("combobox", { name: "添加到「直连」" });
    await addDirect.fill("198.51.100.0/24");
    await addDirect.press("Enter");
    await expect(direct.getByText("198.51.100.0/24", { exact: true })).toBeVisible();
    await addDirect.fill("奈飞");
    await page.getByRole("option", { name: /^Netflix/ }).click();
    await expect(netflix.getByText("已在「直连」里，这里不生效")).toBeVisible();
    await direct.getByRole("button", { name: "删除 Netflix" }).click();
    await expect(netflix.getByText("已在「直连」里，这里不生效")).toHaveCount(0);
    // A remote rule-set: the panel downloads it and shows what it holds.
    const ruleSet = must("E2E_RULE_SET");
    await addBlock.fill(ruleSet);
    await addBlock.press("Enter");
    await expect(blocked.getByText("3 条规则")).toBeVisible();
    await expect(blocked.getByText(/sing-box 不支持 1 条/)).toBeVisible();
    await test.fill("api.e2e-rules.test");
    await expect(result.locator("[data-verdict]")).toHaveAttribute("data-verdict", "block");
    await expect(result).toContainText("规则集「E2E」");

    // Netflix: a primary line and two backups, reordered; the service moves below Google.
    await netflix.getByRole("button", { name: "Netflix 的线路" }).click();
    await netflix.getByRole("combobox", { name: "Netflix 的首选线路" }).selectOption(`e:${nodes[0].entrance}`);
    const backup = netflix.getByRole("combobox", { name: "Netflix 添加备用线路" });
    await backup.selectOption("r:E2E-JP");
    await backup.selectOption("r:E2E-HK");
    const backups = netflix.getByRole("list", { name: "Netflix 的备用线路" }).getByRole("listitem");
    await expect(backups).toHaveText([/E2E-JP/, /E2E-HK/]);
    await netflix.getByRole("button", { name: "下移备用 1" }).click();
    await expect(backups).toHaveText([/E2E-HK/, /E2E-JP/]);
    await page.getByRole("button", { name: "下移 Netflix" }).click();
    await expect(page.locator("[data-service]").first()).toHaveAttribute("data-service", "google");
    // Services from the catalog and a custom one.
    await page.getByRole("button", { name: "🎵 Spotify" }).click();
    await expect(page.getByRole("region", { name: "Spotify", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "自定义服务…" }).click();
    const d = dialog(page, "自定义服务");
    await d.getByLabel("名称").fill("E2E 游戏");
    await d.getByRole("button", { name: "添加" }).click();
    const game = page.getByRole("region", { name: "E2E 游戏", exact: true });
    await expect(game).toBeVisible();
    await page.getByRole("combobox", { name: "添加到「E2E 游戏」" }).fill("game.e2e.test");
    await page.getByRole("combobox", { name: "添加到「E2E 游戏」" }).press("Enter");

    // The test box and the sentence follow the draft.
    await test.fill("www.game.e2e.test");
    await expect(result.locator("[data-verdict]")).toHaveText("⭐ E2E 游戏");
    await test.fill("www.netflix.com");
    await expect(result.locator("[data-verdict]")).toHaveAttribute("data-verdict", "service");
    await expect(result).toContainText("按分类名匹配");
    await expect(result).toContainText("E2E-HK");
    await expect(page.getByTestId("routing-summary")).toContainText("Netflix 走");
    // Global mode: everything but the LAN via the default proxy.
    const mode = page.getByRole("group", { name: "模式" });
    await mode.getByRole("button", { name: "全局代理" }).click();
    await expect(page.getByText(/全局代理：除局域网外/)).toBeVisible();
    await expect(result.locator("[data-verdict]")).toHaveAttribute("data-verdict", "default");
    await test.fill("192.168.1.1");
    await expect(result.locator("[data-verdict]")).toHaveAttribute("data-verdict", "direct");
    await mode.getByRole("button", { name: "规则分流（推荐）" }).click();
    await page.getByRole("combobox", { name: "默认代理" }).selectOption("r:E2E-JP");

    // DNS: custom lists are checked as typed.
    await page.getByRole("group", { name: "DNS 下发" }).getByRole("button", { name: "自定义" }).click();
    const cn = page.getByLabel("国内 DNS", { exact: true });
    await cn.fill("not a server");
    await expect(page.getByText(/不是有效的 DNS 服务器：not a server/)).toBeVisible();
    await expect(bar(page)).toContainText("1 处需要修正");
    await cn.fill("223.5.5.5\nhttps://doh.pub/dns-query");
    await setSwitch(page.getByRole("switch", { name: "使用 Fake-IP" }), false);
    await expectFits(page, "the routing editor");

    await save(page);
    await toast(page, "分流规则已保存");
    await page.reload();
    await expect(page.getByRole("region", { name: "拦截", exact: true }).getByText("仅 ads.e2e.test")).toBeVisible();
    await expect(direct.getByText("198.51.100.0/24", { exact: true })).toBeVisible();
    await expect(blocked.getByText(/面板副本/)).toBeVisible();
    await expect(page.locator("[data-service]").first()).toHaveAttribute("data-service", "google");
    await expect(netflix.getByText(/E2E-HK/).first()).toBeVisible();
    await expect(game).toBeVisible();
    await expect(page.getByRole("group", { name: "DNS 下发" }).getByRole("button", { name: "自定义" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("switch", { name: "使用 Fake-IP" })).toHaveAttribute("aria-checked", "false");
    const saved = (await view()).subscription.routing.value as {
      services: { key: string; primary: string | null; backups: unknown[] }[];
      rest: unknown;
    };
    expect(saved.services.find((s) => s.key === "netflix")).toMatchObject({
      primary: nodes[0].entrance,
      backups: [{ region: "E2E-HK" }, { region: "E2E-JP" }],
    });
    expect(saved.rest).toEqual({ region: "E2E-JP" });

    // Restore the recommended routing (confirmed, then saved).
    await page.getByRole("region", { name: "危险操作" }).getByRole("button", { name: "恢复推荐设置" }).click();
    await confirmDialog(page, undefined, "恢复推荐设置");
    await save(page);
    await toast(page, "分流规则已保存");
    await expect(game).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Spotify", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-service]").first()).toHaveAttribute("data-service", "netflix");
  } finally {
    await apiJson("PUT", "/settings/subscription", { version: (await view()).version, routing: before });
    for (const n of nodes) await apiJson("DELETE", `/nodes/${n.id}`);
  }
});

test("SET-15 SET-16 SET-17 SET-18: mail via SMTP (port validated), step-by-step diagnosis, notices; the outbox moved to the status page; the template editor link", async ({
  page,
}, info) => {
  await openConsole(page, "/settings/mail");
  // SET-15: SMTP to the Mailpit sink.
  await setSwitch(page.getByRole("switch", { name: "启用邮件发送" }), true);
  await page.getByRole("radio", { name: /^SMTP/ }).click();
  await page.getByLabel("SMTP 服务器").fill("127.0.0.1");
  const port = page.getByLabel("端口", { exact: true });
  await port.fill("70000");
  await expect(page.getByText("请输入 1–65535 的整数")).toBeVisible();
  await port.fill(String(SMTP_PORT));
  await page.getByRole("group", { name: "加密方式" }).getByRole("button", { name: "不加密" }).click();
  await page.getByLabel("发件地址").fill("panel@e2e.test");
  await page.getByLabel("发件人名称").fill("Akari");
  if (await bar(page).count()) {
    await save(page);
    await toast(page, "发信设置已保存");
  }
  // SET-16: diagnose and send (the saved configuration).
  const to = `${uniq(info, "diag")}@e2e.test`;
  await page.getByRole("button", { name: "测试发信" }).click();
  const diag = dialog(page, "测试发信");
  await diag.getByLabel("收件地址").fill(to);
  await diag.getByRole("button", { name: "诊断并发送" }).click();
  const report = diag.getByRole("list", { name: "诊断结果" });
  await expect(report.getByText("测试邮件已被接受")).toBeVisible();
  await expect(report.locator("[data-step=config]")).toContainText("未加密连接");
  for (const step of ["tcp", "send"]) await expect(report.locator(`[data-step=${step}]`)).toContainText("通过");
  await diag.getByRole("button", { name: "直接发送测试邮件" }).click();
  await toast(page, `测试邮件已发出：${to}`);
  await diag.getByRole("button", { name: "关闭" }).first().click();
  await expect(page).toHaveURL(/\/settings\/mail$/);
  // SET-15 (notices): what is sent, apart from how; the reminder days are validated.
  await page.goto(`${CONSOLE}/settings/notices`);
  await setSwitch(page.getByRole("switch", { name: "退款通知" }), true);
  const reminder = page.getByRole("switch", { name: "到期前提醒" });
  const reminderWas = (await reminder.getAttribute("aria-checked")) === "true";
  await setSwitch(reminder, true);
  const days = page.getByLabel("到期前多少天提醒");
  const before = await days.inputValue();
  await days.fill("31");
  await expect(page.getByText("请输入 1–30 的整数")).toBeVisible();
  await days.fill(before === "3" ? "4" : "3");
  await save(page);
  await toast(page, "通知设置已保存");
  await days.fill(before);
  await setSwitch(reminder, reminderWas);
  if (await bar(page).count()) {
    await save(page);
    await toast(page, "通知设置已保存");
  }
  // SET-18: the template editor is its own full-width page (/settings/templates, the old address too).
  await page.goto(`${CONSOLE}/settings/mail`);
  await page
    .getByRole("link", { name: /邮件模板/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/${PREFIX}/admin/settings/templates$`));
  await expect(page.getByRole("heading", { name: "邮件模板" })).toBeVisible();
  // SET-17: the outbox is on the status page now (old links follow it).
  await page.goto(`${CONSOLE}/settings/mail?outbox=dead`);
  await expect(page).toHaveURL(/\/status\?mail=dead$/);
});

test("SET-19: payment methods — cards in the portal order, add (kind radio cards → editor, key files), test, edit in a dialog (numbers checked while typing), enabling through the save bar, delete from the danger zone's select", async ({
  page,
}, info) => {
  const name = uniq(info, "支付宝");
  await openConsole(page, "/settings/payments");
  await page.getByRole("button", { name: "添加渠道" }).click();
  const kinds = dialog(page, "添加支付方式");
  await kinds.getByRole("radio", { name: /支付宝当面付/ }).click();
  await expect(kinds.getByRole("radio", { name: /余额/ })).toBeDisabled();
  await kinds.getByRole("button", { name: "下一步" }).click();
  const d = dialog(page, "添加 支付宝当面付");
  await d.getByLabel("名称（用户可见）").fill(name);
  await setSwitch(d.getByRole("switch", { name: "启用", exact: true }), false);
  await d.getByLabel("环境").selectOption("custom");
  await d.getByLabel("网关地址（仅自定义）").fill("http://127.0.0.1:9/gateway.do");
  await d.getByLabel("APPID").fill("2021000000000001");
  await d.getByLabel("从文件读取 应用私钥").setInputFiles(join(PAY_DIR, "app-key.pem"));
  await d.getByLabel("从文件读取 支付宝公钥").setInputFiles(join(PAY_DIR, "alipay-pub.pem"));
  await d.getByRole("button", { name: "添加", exact: true }).click();
  await toast(page, "支付方式已保存");
  const item = page.locator(`[data-method="${name}"]`);
  await expect(item).toContainText("停用");
  await expect(item).toContainText("本月");
  // Test the connection (nobody listens on the gateway: reported, not thrown).
  await item.getByRole("button", { name: "测试连接" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: /连接/ }).first()).toBeVisible();
  // Edit: secrets left empty are kept; the app public key shown; a bad number refused in place.
  await item.getByRole("button", { name: `编辑 ${name}` }).click();
  const e = dialog(page, `编辑 ${name}`);
  await expect(e.getByText(/已设置.*留空 = 不修改/).first()).toBeVisible();
  await expect(e.getByLabel("应用公钥（上传到支付宝开放平台）")).toHaveValue(/^MIIB/);
  const timeout = e.getByLabel("订单有效期（分钟，5–120）");
  await timeout.fill("abc");
  await expect(e.getByText("请输入整数")).toBeVisible();
  // The count beside the save button is desktop only (a phone's footer has no room).
  if (!isMobile(info)) await expect(e.getByText("1 处需要修正")).toBeVisible();
  await expect(e.getByRole("button", { name: "保存" })).toBeDisabled();
  await timeout.fill("20");
  await e.getByRole("button", { name: "保存" }).click();
  await toast(page, "支付方式已保存");
  await expect(e).toHaveCount(0);
  // Enabling goes through the save bar (discarded here: other specs expect one enabled method).
  await item.getByRole("switch", { name: `启用 ${name}` }).click();
  await expect(bar(page)).toContainText("1 项未保存的修改");
  await bar(page).getByRole("button", { name: "放弃" }).click();
  await expect(item.getByRole("switch", { name: `启用 ${name}` })).toHaveAttribute("aria-checked", "false");
  // Delete (unused), from the danger zone: pick it in the select, then 删除….
  const zone = page.getByRole("region", { name: "危险操作" });
  await zone.getByLabel("要删除的渠道").selectOption({ label: name });
  await zone.getByRole("button", { name: "删除…" }).click();
  await confirmDialog(page, name);
  await expect(item).toHaveCount(0);
});

test("FIN-05: invite commissions (moved to settings) — numbers validated in place, saved through the bar", async ({
  page,
}) => {
  type Commission = Record<string, unknown>;
  const before = await apiJson<Commission>("GET", "/commission-settings");
  try {
    await openConsole(page, "/settings/commission");
    await setSwitch(page.getByRole("switch", { name: "开启邀请返利" }), true);
    const rate = page.getByLabel("返利比例（%）");
    await rate.fill("101");
    await expect(page.getByText("请输入 0–100 的整数")).toBeVisible();
    await expect(bar(page).getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await rate.fill("10");
    await page.getByLabel("冻结天数").fill("0");
    await page.getByLabel("最低提现（元）").fill("1");
    await page.getByLabel(/参考汇率/).fill("7.20");
    await expect(page.getByRole("checkbox", { name: "Plasma" })).toBeChecked();
    await save(page);
    await toast(page, "邀请返利设置已保存");
    await expect(bar(page)).toHaveCount(0);
    await page.reload();
    await expect(rate).toHaveValue("10");
  } finally {
    await apiJson("PUT", "/commission-settings", before);
  }
});

test("ALR-03 ALR-04: alert thresholds and channels (moved to settings) — validated in place, the webhook with a generated secret, a channel test on the saved configuration", async ({
  page,
}) => {
  await openConsole(page, "/settings/alerts");
  const cpu = page.getByLabel("CPU 超过 %");
  await cpu.fill("101");
  await expect(page.getByText("请输入 1–100 的整数")).toBeVisible();
  await cpu.fill("95");
  await page.getByLabel("冷却（分钟）").fill("30");
  await setSwitch(page.getByRole("switch", { name: "Webhook" }), true);
  await page.getByLabel("Webhook 地址").fill(`${new URL(RELEASE_SOURCE).origin}/hook`);
  await page.getByRole("button", { name: "随机生成" }).click();
  await page.getByLabel("收件人（最多 5 个，逗号分隔）").fill(ADMIN);
  await save(page);
  await toast(page, "告警设置已保存");
  await expect(page.getByText("已保存；留空 = 不修改").first()).toBeVisible();
  // ALR-04: the test uses the saved configuration (the stand-in answers 501: reported).
  await expect(page.getByText("测试使用已保存的配置").first()).toBeVisible();
  await page.getByRole("button", { name: "发送测试（Webhook）" }).click();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: /Webhook/ })
      .first(),
  ).toBeVisible();
  // The webhook off again (the evaluator would deliver to it).
  await setSwitch(page.getByRole("switch", { name: "Webhook" }), false);
  await save(page);
  await toast(page, "告警设置已保存");
});

test("UPD-01: the release source and automatic check (moved to settings); release keys listed, a bad key refused", async ({
  page,
}) => {
  await openConsole(page, "/settings/updates");
  const source = page.getByLabel("发布源（GitHub 最新发布 API，留空 = 官方）");
  const auto = page.getByRole("switch", { name: "自动检查（每 6 小时）" });
  const was = await source.inputValue();
  const autoWas = (await auto.getAttribute("aria-checked")) === "true";
  await source.fill("not a url");
  await expect(page.getByText(/请输入以 https:\/\/ 开头的完整地址/)).toBeVisible();
  await source.fill(RELEASE_SOURCE);
  await auto.click();
  await save(page);
  await toast(page, "更新源设置已保存");
  await page.reload();
  await expect(source).toHaveValue(RELEASE_SOURCE);
  await expect(auto).toHaveAttribute("aria-checked", String(!autoWas));
  // The built-in key is read only; an extra key is checked in its dialog (not saved here).
  await expect(page.getByText("内置官方").first()).toBeVisible();
  await page.getByRole("button", { name: "添加公钥" }).click();
  const d = dialog(page, "添加发布公钥");
  await d.getByLabel("公钥（base64）").fill("not-a-key");
  await d.getByRole("button", { name: "添加" }).click();
  await expect(d.getByText("请粘贴 base64 编码的 Ed25519 公钥")).toBeVisible();
  await d.getByRole("button", { name: "取消" }).click();
  // Back as it was.
  await source.fill(was);
  await setSwitch(auto, autoWas);
  if (await bar(page).count()) {
    await save(page);
    await toast(page, "更新源设置已保存");
  }
});

test("SET-20 SET-21 SET-22: install and certificates, probes (turning the TCP probe off is confirmed), outbound block rules", async ({
  page,
}, info) => {
  await openConsole(page, "/settings/install");
  // SET-20.
  const email = page.getByLabel("ACME 邮箱（可选）");
  await email.fill("nope");
  await expect(page.getByText("邮箱格式不对")).toBeVisible();
  await email.fill("ops@e2e.test");
  const remove = page.getByRole("radiogroup", { name: "撤权方式" }).getByRole("radio");
  await remove.nth(1).click();
  await save(page);
  await toast(page, "安装与证书设置已保存");
  await email.fill("");
  await remove.nth(0).click();
  await save(page);
  await toast(page, "安装与证书设置已保存");
  // SET-21.
  await page.goto(`${CONSOLE}/settings/probe`);
  const interval = page.getByLabel("测速间隔（分钟）");
  await interval.fill("5");
  await expect(page.getByText("请输入 10–10080 的整数")).toBeVisible();
  await interval.fill("10");
  const tcp = page.getByRole("switch", { name: "面板 TCP 测速" });
  const tcpWas = (await tcp.getAttribute("aria-checked")) === "true";
  await setSwitch(tcp, false);
  await page.getByRole("button", { name: "添加地址" }).click();
  await page.getByLabel("测速地址 1", { exact: true }).fill("https://www.example.com/");
  await save(page);
  const saved = page.locator("[data-sonner-toast]", { hasText: "测速设置已保存" });
  await expect(page.getByRole("alertdialog").or(saved).first()).toBeVisible();
  if (await page.getByRole("alertdialog").isVisible()) {
    await expect(page.getByRole("alertdialog")).toContainText("中转入口不会再被自动检查");
    await confirmDialog(page, undefined, "关闭并保存");
  }
  await toast(page, "测速设置已保存");
  await interval.fill("");
  await setSwitch(tcp, tcpWas);
  await page.getByRole("button", { name: "移除测速地址 1" }).click();
  await save(page);
  await toast(page, "测速设置已保存");
  // SET-22: a custom rule set — create (dialog), switch off (save bar), edit, delete; built-ins listed.
  await page.goto(`${CONSOLE}/settings/block`);
  await expect(page.getByText("内置", { exact: true }).first()).toBeVisible();
  const rule = uniq(info, "block");
  await page.getByRole("button", { name: "新建自定义规则" }).click();
  let d = dialog(page, "新建自定义规则");
  await d.getByLabel("名称").fill(rule);
  await d.getByLabel("类型").selectOption("domain");
  await d.getByLabel("内容（每行一条）").fill("full:ads.example.com\nkeyword:tracker");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "规则已保存");
  const item = page.locator(`[data-rule-set="${rule}"]`);
  await expect(item).toContainText("2 条");
  const on = item.getByRole("switch", { name: rule });
  const was = (await on.getAttribute("aria-checked")) === "true";
  await on.click();
  await save(page);
  await toast(page, "拦截规则已保存");
  await expect(on).toHaveAttribute("aria-checked", String(!was));
  await item.getByRole("button", { name: `编辑 ${rule}` }).click();
  d = dialog(page, "编辑规则");
  await d.getByLabel("内容（每行一条）").fill("full:ads.example.com");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "规则已保存");
  await expect(item).toContainText("1 条");
  await item.getByRole("button", { name: `编辑 ${rule}` }).click();
  await dialog(page, "编辑规则").getByRole("button", { name: "删除规则集" }).click();
  await confirmDialog(page, rule);
  await expect(item).toHaveCount(0);
});
