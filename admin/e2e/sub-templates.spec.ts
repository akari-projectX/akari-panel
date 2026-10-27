// INVENTORY §15 SET-29: the subscription template editor
// (/settings/sub-templates). Leaves every template at its default (the
// mobile project runs the same file after the desktop one).
import { expect, test, type Locator, type Page } from "@playwright/test";

import { USER, apiJson, confirmDialog, dialog, isMobile, openConsole, sql, toast } from "./helpers";

test.describe.configure({ mode: "serial" });

type Tpl = { format: string; body: string; version: number; is_default: boolean };

const GOOD =
  "mixed-port: 7890\nproxy-groups:\n  - {name: G, type: select, proxies: [$proxies, DIRECT]}\nrules:\n  - MATCH,G\n";
const BAD = "proxy-groups:\n  - {name: G, type: select, proxies: [Ghost]}\n";
const THEIRS = "mixed-port: 1\nrules: []\n";

async function stored(format: string): Promise<Tpl> {
  const all = await apiJson<{ templates: Tpl[] }>("GET", "/sub-templates");
  return all.templates.find((t) => t.format === format)!;
}

async function resetAll() {
  for (const f of ["sing-box", "clash", "surge", "surfboard"]) await apiJson("DELETE", `/sub-templates/${f}`);
}

/** Replace a code editor's whole document (see mail-templates.spec.ts for why not fill()). */
async function setDoc(editor: Locator, text: string) {
  await editor.focus();
  await editor.press("ControlOrMeta+a");
  await editor.page().keyboard.insertText(text);
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const saveButton = (page: Page) => page.getByRole("button", { name: /^保存/ });
const errors = (page: Page) => page.getByRole("alert", { name: "模板错误" });
const side = (page: Page, name: "占位符" | "预览") =>
  page.getByRole("group", { name: "侧栏" }).getByRole("button", { name, exact: true });

test("SET-29: subscription templates — tabs, placeholders, error markers, preview (sample and real user), save, version conflict, reset, leave guard", async ({
  page,
}, info) => {
  await resetAll();
  await openConsole(page, "/settings/sub-templates");
  await expect(page.getByRole("heading", { name: "订阅模板" })).toBeVisible();
  await expect(page.getByText("配置各个客户端的订阅模板")).toBeVisible();
  for (const name of ["Sing-box", "Clash", "Surge", "Surfboard"]) await expect(tab(page, name)).toBeVisible();

  // Sing-box first, showing the built-in default.
  const singbox = page.getByRole("textbox", { name: "Sing-box 订阅模板" });
  await expect(singbox).toContainText('"log"');
  await expect(page.getByText("使用内置默认模板", { exact: true })).toBeVisible();

  // The placeholder cheat-sheet (collapsed behind a button on a phone); a click inserts at the cursor.
  if (isMobile(info)) await page.getByRole("button", { name: /^占位符说明/ }).click();
  await expect(page.getByText("selector / urltest 的 outbounds 里")).toBeVisible();
  await page.getByRole("button", { name: "插入 {all}", exact: true }).click();
  await expect(singbox).toContainText("{all}");
  await expect(tab(page, "Sing-box").getByRole("img", { name: "有未保存的修改" })).toBeVisible();
  await expect(page.getByText("未保存的修改", { exact: true })).toBeVisible();
  // 恢复默认 on an unsaved default only discards the edit (no confirmation, nothing stored).
  await page.getByRole("button", { name: "恢复默认" }).click();
  await expect(page.getByText("使用内置默认模板", { exact: true })).toBeVisible();
  await expect(singbox).not.toContainText("{all}");

  // Clash: a template naming a proxy that does not exist is refused with its place.
  await tab(page, "Clash").click();
  await expect(page).toHaveURL(/format=clash/);
  const clash = page.getByRole("textbox", { name: "Clash 订阅模板" });
  await expect(clash).toContainText("mixed-port");
  await setDoc(clash, BAD);
  await saveButton(page).click();
  await expect(errors(page)).toContainText("Ghost");
  await expect(errors(page).getByRole("button", { name: /^第 2 行/ })).toBeVisible();
  await expect(page.locator(".cm-err-line")).toHaveCount(1);
  expect((await stored("clash")).is_default).toBe(true);

  // Fixed: the markers go away as soon as the text changes; the preview shows the sample lines.
  await setDoc(clash, GOOD);
  await expect(errors(page)).toHaveCount(0);
  await expect(page.locator(".cm-err-line")).toHaveCount(0);
  await page.getByRole("button", { name: "预览", exact: true }).last().click();
  const rendered = page.getByLabel("预览结果");
  await expect(rendered).toContainText("香港 01");
  await expect(page.getByText("不含任何真实凭据")).toBeVisible();

  // A real user: audited, so the page says so and the button waits for a choice.
  await page.getByRole("group", { name: "预览数据" }).getByRole("button", { name: "真实用户" }).click();
  await expect(page.getByText("记入审计日志")).toBeVisible();
  await expect(page.getByRole("button", { name: "预览", exact: true }).last()).toBeDisabled();
  await page.getByLabel("搜索用户（邮箱）").fill(USER.slice(0, 6));
  await page
    .getByRole("list", { name: "匹配的用户" })
    .getByRole("button", { name: new RegExp(USER) })
    .click();
  const before = Number(sql("SELECT count(*) FROM audit_log WHERE action = 'sub_template.preview'"));
  await page.getByRole("button", { name: "预览", exact: true }).last().click();
  await expect(async () => {
    expect(Number(sql("SELECT count(*) FROM audit_log WHERE action = 'sub_template.preview'"))).toBe(before + 1);
  }).toPass();
  await expect(rendered).toContainText("proxies:");
  await page.getByRole("group", { name: "预览数据" }).getByRole("button", { name: "示例数据" }).click();

  // Save: shown as customised without a reload.
  await saveButton(page).click();
  await toast(page, "订阅模板已保存");
  await expect(page.getByText(/^已自定义 · /)).toBeVisible();
  expect((await stored("clash")).version).toBe(1);

  // Someone else saves while this draft is open: refused with the reload prompt.
  await setDoc(clash, GOOD + "# mine\n");
  await apiJson("PUT", "/sub-templates/clash", { version: 1, body: THEIRS });
  await saveButton(page).click();
  const banner = page.getByRole("alert").filter({ hasText: "模板已被其他管理员修改" });
  await expect(banner).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
  await banner.getByRole("button", { name: "载入最新版本" }).click();
  await expect(clash).toContainText("mixed-port: 1");
  await expect(banner).toHaveCount(0);
  await expect(page.getByText(/^已自定义 · /)).toBeVisible();

  // ...or keep the draft and overwrite.
  await setDoc(clash, GOOD + "# mine\n");
  await apiJson("PUT", "/sub-templates/clash", { version: 2, body: "mixed-port: 2\nrules: []\n" });
  await saveButton(page).click();
  await banner.getByRole("button", { name: "保留我的草稿并覆盖" }).click();
  await saveButton(page).click();
  await toast(page, "订阅模板已保存");
  expect((await stored("clash")).body).toContain("# mine");

  // Leaving with an unsaved draft asks first.
  await setDoc(clash, GOOD + "# unsaved\n");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^系统设置/ })
    .click();
  await expect(dialog(page, "放弃未保存的修改？")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
  await expect(page).toHaveURL(/\/settings\/sub-templates/);

  // 恢复默认 (confirmed): the stored template is deleted.
  await page.getByRole("button", { name: "恢复默认" }).click();
  await confirmDialog(page, undefined, "恢复默认");
  await toast(page, "已恢复默认模板");
  await expect(page.getByText("使用内置默认模板", { exact: true })).toBeVisible();
  expect((await stored("clash")).is_default).toBe(true);

  // The two text formats open with their own placeholders.
  await tab(page, "Surge").click();
  await expect(page.getByRole("textbox", { name: "Surge 订阅模板" })).toContainText("[General]");
  if (isMobile(info)) await page.getByRole("button", { name: /^占位符说明/ }).click();
  await expect(page.getByRole("button", { name: "插入 $subscribe_info", exact: true })).toBeVisible();
  await side(page, "预览").click();
  await page.getByRole("button", { name: "预览", exact: true }).last().click();
  await expect(page.getByLabel("预览结果")).toContainText("#!MANAGED-CONFIG");

  // The old section address leads to the editor.
  await openConsole(page, "/settings/routing");
  await expect(page).toHaveURL(/\/settings\/sub-templates/);
  await expect(page.getByRole("heading", { name: "订阅模板" })).toBeVisible();
  await resetAll();
});
