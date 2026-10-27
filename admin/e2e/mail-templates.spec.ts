// INVENTORY §15 SET-18: the mail template editor (/settings/mail-templates).
// Leaves the template it edits at its default (the mobile project runs the
// same file after the desktop one).
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { MAILPIT, SMTP_PORT, apiJson, confirmDialog, dialog, isMobile, openConsole, toast, uniq } from "./helpers";

test.describe.configure({ mode: "serial" });

type Template = {
  kind: string;
  locale: string;
  required: string[];
  starter_html: string;
  html_source: string | null;
  custom: boolean;
};
type Mail = Record<string, unknown> & { version: number };

const KIND = "register_code";
const URL = `/settings/templates?kind=${KIND}`;

async function template(): Promise<Template> {
  const all = await apiJson<Template[]>("GET", "/settings/mail-templates");
  return all.find((t) => t.kind === KIND && t.locale === "zh")!;
}

/** The test mails need the Mailpit sink (SET-15 configures it too; this file may run first). */
async function smtpToMailpit() {
  if (!SMTP_PORT) return;
  const m = await apiJson<Mail>("GET", "/settings/mail");
  await apiJson("PUT", "/settings/mail", {
    version: m.version,
    enabled: true,
    provider: "smtp",
    host: "127.0.0.1",
    port: SMTP_PORT,
    security: "none",
    username: null,
    from_addr: "panel@e2e.test",
    from_name: "Akari",
    notify_order_paid: m.notify_order_paid,
    notify_expiry_days: m.notify_expiry_days,
    notify_expired: m.notify_expired,
    notify_quota: m.notify_quota,
    notify_refund: m.notify_refund,
    notify_ban: m.notify_ban,
    notify_plan_change: m.notify_plan_change,
    notify_withdrawal: m.notify_withdrawal,
    notify_commission: m.notify_commission,
  });
}

/** Phones and narrow windows show one pane at a time (编辑 / 预览 / 变量). */
async function pane(page: Page, info: TestInfo, name: "编辑" | "预览" | "变量") {
  if (isMobile(info)) await page.getByRole("button", { name, exact: true }).click();
}

/**
 * Replace a code editor's (CodeMirror) whole document. Not `fill()`: that
 * selects through the DOM and inserts at once, and CodeMirror only reads a DOM
 * selection on the next `selectionchange`, so on a slow runner the text went in
 * at the old cursor instead of replacing the document. ⌘/Ctrl+A is the
 * editor's own select-all (its keymap updates its state before the insert).
 */
async function setDoc(editor: Locator, text: string) {
  await editor.focus();
  await editor.press("ControlOrMeta+a");
  await editor.page().keyboard.insertText(text);
}

/** The editor's language switch (the shell toolbar has its own "English" button). */
const langs = (page: Page) => page.getByRole("group", { name: "语言" });
const errors = (page: Page) => page.getByRole("alert", { name: "模板错误" });
const saveButton = (page: Page) => page.getByRole("button", { name: /^保存/ });
const preview = (page: Page) => page.frameLocator("iframe[title='邮件 HTML 预览']");

test("SET-18: mail templates — placeholders checked while typing, preview, save, test the draft, unsaved-change guard, reset", async ({
  page,
}, info) => {
  await smtpToMailpit();
  const tpl = await template();
  const needed = tpl.required.map((r) => `{${r}}`).join(" ");
  await openConsole(page, URL);
  await expect(page.getByRole("heading", { name: "邮件模板" })).toBeVisible();

  // Unknown placeholder: marked before any round trip, save is off.
  const body = page.getByRole("textbox", { name: "邮件正文" });
  await setDoc(body, `${needed}\n\n{nope}`);
  await expect(errors(page)).toContainText("第 3 行：未知变量 {nope}");
  await expect(saveButton(page)).toBeDisabled();
  // A required placeholder removed: reported too.
  if (tpl.required.length) {
    await setDoc(body, "E2E 无必需变量");
    await expect(body).toHaveText("E2E 无必需变量");
    await expect(errors(page)).toContainText(`缺少必需变量 {${tpl.required[0]}}`);
  }
  await setDoc(body, `${needed}\n\nE2E 自定义`);
  await expect(errors(page)).toHaveCount(0);

  // Placeholder chips insert at the cursor (here: the subject).
  const subject = page.getByLabel("邮件主题");
  await subject.fill(`E2E ${info.project.name} `);
  await subject.press("End");
  if (isMobile(info)) {
    // Phones: the 变量 tab lists the placeholders (the chip row is for wider windows).
    await pane(page, info, "变量");
    await page
      .getByRole("complementary", { name: "变量" })
      .getByRole("button", { name: /^\{site\}/ })
      .click();
  } else await page.getByRole("button", { name: "{site}", exact: true }).click();
  await expect(subject).toHaveValue(`E2E ${info.project.name} {site}`);

  // Server-rendered preview: HTML and the plain-text part.
  await pane(page, info, "预览");
  await expect(preview(page).getByText("E2E 自定义")).toBeVisible();
  await page.getByRole("button", { name: "纯文本", exact: true }).click();
  await expect(page.getByLabel("纯文本预览")).toContainText("E2E 自定义");
  await page.getByRole("button", { name: "HTML", exact: true }).click();
  await pane(page, info, "编辑");

  await saveButton(page).click();
  await toast(page, "模板已保存");
  // Shown as customised without a reload.
  await expect(page.getByText(/^已自定义 · /)).toBeVisible();
  if (isMobile(info))
    await expect(page.getByLabel("模板", { exact: true }).locator("option:checked")).toContainText("已自定义");
  else
    await expect(
      page.getByRole("navigation", { name: "模板列表" }).getByRole("img", { name: "已自定义" }).first(),
    ).toBeVisible();
  expect((await template()).custom).toBe(true);

  // 发送测试 offers the current (unsaved) draft, chosen by default when there is one.
  await setDoc(body, `${needed}\n\nE2E 草稿`);
  await expect(page.getByText("未保存的修改").first()).toBeVisible();
  const to = `${uniq(info, "draft")}@e2e.test`;
  await page.getByRole("button", { name: "发送测试", exact: true }).click();
  const d = dialog(page, "发送测试邮件");
  await expect(d.getByRole("radio", { name: /当前草稿/ })).toHaveAttribute("aria-checked", "true");
  await expect(d.getByRole("radio", { name: /已保存的版本/ })).toBeEnabled();
  await d.getByLabel("测试收件地址").fill(to);
  await d.getByRole("button", { name: "发送", exact: true }).click();
  await toast(page, `测试邮件已发出：${to}`);
  if (MAILPIT) {
    await expect(async () => {
      const r = await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`)).json();
      expect(r.messages_count).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000 });
  }

  // Unsaved changes: switching the language asks; keep editing, then discard.
  await langs(page).getByRole("button", { name: "English", exact: true }).click();
  await expect(dialog(page, "放弃未保存的修改？")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("button", { name: "中文", exact: true })).toHaveAttribute("aria-pressed", "true");
  await langs(page).getByRole("button", { name: "English", exact: true }).click();
  await confirmDialog(page, undefined, "放弃修改");
  await expect(page).toHaveURL(/lang=en/);
  await expect(langs(page).getByRole("button", { name: "English", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.getByRole("button", { name: "中文", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/^已自定义 · /)).toBeVisible();

  // HTML source: starts from the generated HTML; a forbidden tag is refused by the
  // server's check (shown in the error strip, save off); saved, still the source after a reload.
  await page.getByRole("button", { name: "HTML 源码", exact: true }).click();
  const source = page.getByRole("textbox", { name: "HTML 源码" });
  await expect(source).toContainText(/<!doctype html>/i);
  const generated = (await template()).starter_html;
  await setDoc(source, `${generated}\n<p>E2E 源码</p>\n<script>alert(1)</script>`);
  await expect(errors(page)).toContainText(/HTML 源码第 \d+ 行第 \d+ 列：不能包含/);
  await expect(saveButton(page)).toBeDisabled();
  await setDoc(source, `${generated}\n<p>E2E 源码</p>`);
  await expect(errors(page)).toHaveCount(0);
  await pane(page, info, "预览");
  await expect(preview(page).getByText("E2E 源码")).toBeVisible();
  await pane(page, info, "编辑");
  await saveButton(page).click();
  await toast(page, "模板已保存");
  expect((await template()).html_source).toContain("E2E 源码");
  await page.reload();
  await expect(page.getByRole("button", { name: "HTML 源码", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "HTML 源码" })).toBeVisible();

  // Leaving the page with unsaved changes asks too.
  await page.getByRole("button", { name: "自动排版", exact: true }).click();
  await page
    .getByRole("main")
    .getByRole("link", { name: /^系统设置/ })
    .click();
  await expect(dialog(page, "放弃未保存的修改？")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
  await expect(page).toHaveURL(/\/settings\/(mail-)?templates/);

  // 恢复默认 (confirmed): back to the default, shown without a reload.
  await page.getByRole("button", { name: "恢复默认" }).click();
  await confirmDialog(page, undefined, "恢复默认");
  await toast(page, "已恢复默认");
  await expect(page.getByText("使用默认模板", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "自动排版", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await template()).custom).toBe(false);
});
