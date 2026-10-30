// INVENTORY §8 (tickets: the inbox), §9 (content: announcements, knowledge base).
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  ADMIN,
  ORIGIN,
  USER,
  USER_PW,
  apiAs,
  apiJson,
  confirmDialog,
  dialog,
  isMobile,
  openConsole,
  toast,
  uniq,
} from "./helpers";

test.describe.configure({ mode: "serial" });

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Names unique per attempt too (a retry must not meet the previous attempt's rows). */
const run = Date.now().toString(36).slice(-5);

/** The ticket context (user, orders, handling): a column on desktop, the ⓘ dialog on a phone. */
async function context(page: Page, info: TestInfo) {
  if (!isMobile(info)) return page.getByRole("complementary", { name: "用户与工单" });
  await page.getByRole("button", { name: "用户与工单信息" }).click();
  const d = dialog(page, "用户与工单");
  await expect(d).toBeVisible();
  return d;
}
async function closeContext(page: Page, info: TestInfo) {
  if (!isMobile(info)) return;
  await dialog(page, "用户与工单").getByRole("button", { name: "关闭", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "用户与工单" })).toHaveCount(0);
}
/** The filter popover of the ticket queue. */
async function filters(page: Page) {
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  const p = page.getByRole("dialog", { name: "筛选" });
  await expect(p).toBeVisible();
  return p;
}

test("TKT-01 TKT-02 TKT-03: ticket inbox — views, filters in the URL, conversation, reply and close, reopen, assignee", async ({
  page,
}, info) => {
  const subject = `${uniq(info, "help me")}-${run}`;
  const user = await apiAs(USER, USER_PW, true);
  expect(
    (
      await user.post(`${ORIGIN}/api/v1/me/tickets`, {
        data: { subject, category: "billing", priority: "high", message: "my order" },
      })
    ).status(),
  ).toBe(201);
  // The dashboard's link (?status=open) is a status filter of the 全部未关闭 view.
  await openConsole(page, "/tickets?status=open");
  await expect(page.getByRole("tab", { name: /全部未关闭/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "清除筛选：状态" })).toBeVisible();
  let p = await filters(page);
  await p.getByLabel("分类").selectOption("billing");
  await p.getByLabel("优先级").selectOption("high");
  await p.getByRole("checkbox", { name: "只看未读" }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("搜索工单").fill(subject);
  // Filters live in the URL.
  await expect(page).toHaveURL(/category=billing/);
  await expect(page).toHaveURL(/unread=1/);
  await expect(page).toHaveURL(/[?&]q=/);
  const queue = page.getByRole("list", { name: "工单", exact: true });
  const item = queue.getByRole("link", { name: new RegExp(esc(subject)) });
  // Waiting for a reply: the row says how long, with the last message's preview.
  await expect(item).toContainText(/等 \d+ 分钟/);
  await expect(item).toContainText("my order");
  await item.click();
  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}/);
  const thread = page.getByRole("list", { name: "会话" });
  await expect(thread.getByText("my order")).toBeVisible();
  await expect(page.getByText(/等待回复 \d+ 分钟/)).toBeVisible();
  // The assignee select is not focused on open and only an explicit 分配 changes it.
  let ctx = await context(page, info);
  await expect(ctx.getByLabel("负责人")).not.toBeFocused();
  await ctx.getByLabel("负责人").selectOption({ label: `${ADMIN}（我）` });
  await expect(ctx.getByText("点「分配」后生效。")).toBeVisible();
  await ctx.getByRole("button", { name: "分配", exact: true }).click();
  await toast(page, "已分配");
  await closeContext(page, info);
  // Quick replies insert text that can still be edited.
  await page.getByRole("button", { name: "快捷回复" }).click();
  await page.getByRole("menuitem", { name: "请提供订单号" }).click();
  await expect(page.getByLabel("回复", { exact: true })).toHaveValue(/订单号/);
  // Ctrl+Enter sends the reply; the conversation shows it without a reload.
  await page.getByLabel("回复", { exact: true }).fill("checking");
  await page.getByLabel("回复", { exact: true }).press("Control+Enter");
  await toast(page, "已回复");
  await expect(thread.getByText("checking")).toBeVisible();
  await expect(page.getByLabel("回复", { exact: true })).toHaveValue("");
  await page.getByLabel("回复", { exact: true }).fill("fixed");
  await page.getByRole("button", { name: "回复并关闭" }).click();
  await toast(page, "已回复并关闭");
  await expect(thread.getByText("客服关闭了工单")).toBeVisible();
  await page.getByRole("button", { name: "重新打开" }).first().click();
  await toast(page, "已重新打开");
  await expect(page.getByLabel("回复", { exact: true })).toBeVisible();
  ctx = await context(page, info);
  await ctx.getByRole("button", { name: "关闭工单" }).click();
  await toast(page, "已关闭");
  if (isMobile(info)) {
    await closeContext(page, info);
    await page.getByRole("button", { name: "返回工单列表" }).click();
  }
  // The 已关闭 view, mine only: the ticket is there (the list updated by itself).
  await page.getByRole("tab", { name: /已关闭/ }).click();
  await page.getByRole("button", { name: "清除筛选：只看未读" }).click();
  p = await filters(page);
  await p.getByLabel("负责人").selectOption("me");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/view=closed/);
  await expect(queue.getByRole("link", { name: new RegExp(esc(subject)) })).toContainText("已关闭");
});

test("CNT-01 CNT-02 CNT-05: announcements by lifecycle, editor with preview and site-zone window, mail, copy, delete", async ({
  page,
}, info) => {
  const title = `${uniq(info, "maintenance")}-${run}`;
  await openConsole(page, "/content");
  await page.getByRole("button", { name: "新建公告" }).first().click();
  const d = dialog(page, "新建公告");
  // Required fields are checked before anything is sent.
  await d.getByRole("button", { name: "发布" }).click();
  await expect(d.getByText("请填写中文标题")).toBeVisible();
  await expect(d.getByText("2 处需要修正")).toBeVisible();
  await d.getByRole("radio", { name: /有生效套餐的用户/ }).click();
  await d.getByLabel("标题（中文）").fill(title);
  await d.getByLabel("正文（Markdown）").fill("**周日** 维护");
  await expect(d.getByTestId("preview").locator("strong")).toHaveText("周日");
  await d.getByRole("switch", { name: "置顶" }).click();
  await expect(d.getByRole("tab", { name: /English/ })).toHaveAccessibleName(/未填写/);
  await d.getByRole("tab", { name: /English/ }).click();
  await d.getByLabel("标题（英文）").fill(`${title} en`);
  await d.getByLabel("正文（英文）").fill("Sunday maintenance");
  await expect(d.getByRole("tab", { name: /English/ })).toHaveAccessibleName(/已填写/);
  // The window is in the site time zone; the end must follow the start.
  await d.getByLabel("开始显示").fill("2030-01-02T10:00");
  await d.getByLabel("结束显示").fill("2030-01-01T10:00");
  await d.getByRole("button", { name: "发布" }).click();
  await expect(d.getByText("结束时间要晚于开始时间")).toBeVisible();
  await d.getByLabel("结束显示").fill("");
  await d.getByRole("button", { name: "发布" }).click();
  await toast(page, "已发布");
  // Starts in 2030: 已排期 (the list updated by itself).
  const scheduled = page.getByRole("region", { name: "已排期" });
  await expect(scheduled.getByText(title, { exact: true })).toBeVisible();
  await expect(scheduled).toContainText("有生效套餐的用户");
  // Back to a draft from the editor.
  await scheduled.getByText(title, { exact: true }).click();
  await dialog(page, "编辑公告").getByRole("button", { name: "撤回为草稿" }).click();
  await toast(page, "已存为草稿");
  const drafts = page.getByRole("region", { name: "草稿" });
  await expect(drafts.getByText(title, { exact: true })).toBeVisible();
  // Mail: the dialog names the audience and its size; mail is off here → the error is explained.
  await drafts.getByRole("button", { name: `${title} 的操作` }).click();
  await page.getByRole("menuitem", { name: "邮件通知…" }).click();
  const m = dialog(page, "用邮件通知这条公告？");
  await expect(m).toContainText("有生效套餐的用户");
  await expect(m).toContainText(/\d+ 人/);
  await m.getByRole("button", { name: /^发送/ }).click();
  await expect(
    page.locator("[data-sonner-toast]", { hasText: /邮件发送尚未配置|已加入发送队列/ }).first(),
  ).toBeVisible();
  if (await m.isVisible()) await m.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Copy as new: the editor starts from this one.
  await drafts.getByRole("button", { name: `${title} 的操作` }).click();
  await page.getByRole("menuitem", { name: "复制为新公告" }).click();
  await expect(dialog(page, "新建公告").getByLabel("标题（中文）")).toHaveValue(title);
  await dialog(page, "新建公告").getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Delete: type the title; the impact lists state, audience, mail.
  await drafts.getByRole("button", { name: `${title} 的操作` }).click();
  await page.getByRole("menuitem", { name: "删除…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("显示对象");
  await confirmDialog(page, title, "删除公告");
  await toast(page, "已删除");
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
});

test("CNT-07: announcement tags — the preset eight, create with a preset colour, edit, reorder, disable, delete only when unused", async ({
  page,
}, info) => {
  const name = uniq(info, "tag").slice(0, 12);
  const renamed = `${name}`.slice(0, 9) + "-2";
  const title = `${uniq(info, "tagged")}-${run}`;
  await openConsole(page, "/content/tags");
  const rows = page.getByTestId("tag-row");
  // The migration's eight presets, in order, solid chips.
  await expect(rows.getByTestId("ann-tag").nth(0)).toHaveText("活动");
  await expect(rows.getByTestId("ann-tag").nth(0)).toHaveAttribute("data-tag", "pink");
  await expect(rows.getByTestId("ann-tag").nth(1)).toHaveText("维护");
  await expect(rows.getByTestId("ann-tag").nth(7)).toHaveText("通知");
  // Create: the colour comes from the palette only (11 swatches), the preview follows.
  await page.getByRole("button", { name: "新建标签" }).first().click();
  const d = dialog(page, "新建标签");
  await d.getByRole("button", { name: "保存" }).click();
  await expect(d.getByText("请填写中文名称")).toBeVisible();
  await expect(d.getByRole("radio")).toHaveCount(11);
  await d.getByLabel("中文名称").fill(name);
  await d.getByRole("radio", { name: "青", exact: true }).click();
  await expect(d.getByTestId("tag-preview").getByTestId("ann-tag")).toHaveText(name);
  await expect(d.getByTestId("tag-preview").getByTestId("ann-tag")).toHaveAttribute("data-tag", "cyan");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "标签已创建");
  const mine = (n: string) => rows.filter({ has: page.getByTestId("ann-tag").filter({ hasText: n }) });
  await expect(mine(name)).toHaveCount(1);
  await expect(rows.last()).toContainText(name);
  // Edit: rename, English name, colour.
  await mine(name)
    .getByRole("button", { name: `编辑 ${name}` })
    .click();
  const e = dialog(page, "编辑标签");
  await e.getByLabel("中文名称").fill(renamed);
  await e.getByLabel("英文名称").fill("Renamed");
  await e.getByRole("radio", { name: "紫", exact: true }).click();
  await e.getByRole("button", { name: "保存" }).click();
  await toast(page, "标签已保存");
  await expect(mine(renamed).getByTestId("ann-tag")).toHaveAttribute("data-tag", "violet");
  await expect(mine(renamed)).toContainText("Renamed");
  // Reorder: up one, and it stays there.
  await page.getByRole("button", { name: `上移 ${renamed}` }).click();
  await expect(rows.nth(7)).toContainText(renamed);
  // Disable, enable (the menu is re-opened if a refetch replaced the row under it).
  const flip = async (item: string, done: string) => {
    await expect(async () => {
      await page.keyboard.press("Escape");
      await mine(renamed)
        .getByRole("button", { name: `${renamed} 的操作` })
        .click();
      await page.getByRole("menuitem", { name: item }).click({ timeout: 3000 });
    }).toPass({ timeout: 15000 });
    await toast(page, done);
  };
  await flip("停用", "已停用");
  await expect(mine(renamed)).toContainText("已停用");
  await flip("启用", "已启用");
  // In use: the delete item is off (disable instead); the API says 409 with the count.
  const tag = (await apiJson<{ id: string; name_zh: string }[]>("GET", "/announcement-tags")).find(
    (t) => t.name_zh === renamed,
  );
  expect(tag).toBeTruthy();
  const ann = await apiJson<{ id: string }>("POST", "/announcements", {
    title_zh: title,
    body_zh: "x",
    tag_id: tag?.id,
    enabled: false,
  });
  await page.reload();
  await mine(renamed)
    .getByRole("button", { name: `${renamed} 的操作` })
    .click();
  await expect(page.getByRole("menuitem", { name: /删除/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(mine(renamed)).toContainText("1 条公告");
  await apiJson("DELETE", `/announcements/${ann.id}`);
  // Unused again: delete (confirmation), the row goes.
  await page.reload();
  await mine(renamed)
    .getByRole("button", { name: `${renamed} 的操作` })
    .click();
  await page.getByRole("menuitem", { name: "删除…" }).click();
  await confirmDialog(page, undefined, "删除标签");
  await toast(page, "已删除");
  await expect(mine(renamed)).toHaveCount(0);
});

test("CNT-08: the announcement editor picks one tag, previews the title with it, and the list shows it", async ({
  page,
}, info) => {
  const title = `${uniq(info, "tagged")}-${run}`;
  await openConsole(page, "/content");
  await page.getByRole("button", { name: "新建公告" }).first().click();
  const d = dialog(page, "新建公告");
  await d.getByLabel("标题（中文）").fill(title);
  await d.getByLabel("正文（Markdown）").fill("正文");
  // No tag by default; picking one shows it before the title, live, in both previews.
  const group = d.getByRole("radiogroup", { name: "标签" });
  await expect(group.getByRole("radio", { name: "无标签" })).toHaveAttribute("aria-checked", "true");
  await group.getByRole("radio", { name: "维护" }).click();
  await expect(group.getByRole("radio", { name: "维护" })).toHaveAttribute("aria-checked", "true");
  const strip = d.getByTestId("title-preview");
  await expect(strip.getByTestId("ann-tag")).toHaveText("维护");
  await expect(strip.getByTestId("ann-tag")).toHaveAttribute("data-tag", "amber");
  await expect(strip).toContainText(title);
  await expect(d.getByTestId("preview").getByTestId("ann-tag")).toHaveText("维护");
  // Only one at a time.
  await group.getByRole("radio", { name: "重要" }).click();
  await expect(group.getByRole("radio", { name: "维护" })).toHaveAttribute("aria-checked", "false");
  await expect(strip.getByTestId("ann-tag")).toHaveAttribute("data-tag", "red");
  await d.getByRole("button", { name: "发布" }).click();
  await toast(page, "已发布");
  // The list row shows the chip before the title; the user's API carries it.
  const live = page.getByRole("region", { name: "进行中" });
  const rowOf = live.locator("button", { has: page.getByText(title, { exact: true }) });
  await expect(rowOf.getByTestId("ann-tag")).toHaveText("重要");
  const user = await apiAs(USER, USER_PW, true);
  const mine = (await (await user.get(`${ORIGIN}/api/v1/me/announcements`)).json()).announcements.find(
    (a: { title_zh: string }) => a.title_zh === title,
  );
  expect(mine.tag).toMatchObject({ name_zh: "重要", name_en: "Important", color: "red" });
  // Clear the tag again from the editor.
  await rowOf.click();
  const e = dialog(page, "编辑公告");
  await e.getByRole("radiogroup", { name: "标签" }).getByRole("radio", { name: "无标签" }).click();
  await e.getByRole("button", { name: "保存" }).click();
  await toast(page, "公告已保存");
  await expect(rowOf.getByTestId("ann-tag")).toHaveCount(0);
  await live.getByRole("button", { name: `${title} 的操作` }).click();
  await page.getByRole("menuitem", { name: "删除…" }).click();
  await confirmDialog(page, title, "删除公告");
  await toast(page, "已删除");
});

test("CNT-03 CNT-04 CNT-05 CNT-06: knowledge base — categories, articles with preview and slug check, legal pages", async ({
  page,
}, info) => {
  const cat = `${uniq(info, "常见问题")}-${run}`;
  const art = `${uniq(info, "如何连接")}-${run}`;
  const slug = `${uniq(info, "kb-how")}-${run}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  await openConsole(page, "/content/kb");
  // Categories: a new one in the manager (zh + en on one row).
  await page.getByRole("button", { name: "管理分类" }).first().click();
  let c = dialog(page, "管理分类");
  await c.getByRole("button", { name: "新建分类" }).click();
  await c
    .getByLabel(/的中文名$/)
    .last()
    .fill(cat);
  await c
    .getByLabel(/的英文名$/)
    .last()
    .fill("FAQ");
  await c.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "分类已保存");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The empty category offers 在这里新建文章 (the category preselected).
  await page.getByRole("button", { name: new RegExp(`^${esc(cat)}`) }).click();
  await expect(page.getByText(`「${cat}」里还没有文章`)).toBeVisible();
  await page.getByRole("button", { name: "在这里新建文章" }).click();
  let d = dialog(page, "新建文章");
  await expect(d.getByLabel("分类")).toHaveValue(/[0-9a-f-]{36}/);
  await d.getByLabel("文章标题（中文）").fill(art);
  await d.getByLabel("正文（Markdown）").fill("- 第一条");
  await expect(d.getByTestId("preview").locator("li")).toHaveText("第一条");
  await d.getByLabel("排序").fill("-1");
  await d.getByLabel("地址（可选）").fill(slug);
  await expect(d.getByText(`可用 · 门户地址 /kb/${slug}`)).toBeVisible();
  await d.getByRole("switch", { name: "发布" }).click();
  await d.getByRole("button", { name: "保存", exact: true }).click();
  await expect(d.getByText("请输入 0 或正整数（最大 1000000）")).toBeVisible();
  await d.getByLabel("排序").fill("3");
  await d.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "文章已保存");
  const row = page.getByRole("listitem").filter({ hasText: art });
  await expect(row).toContainText(`/kb/${slug}`);
  await expect(row).toContainText("已发布");
  // The slug is checked live against the other articles.
  await page.getByRole("button", { name: "新建文章" }).first().click();
  d = dialog(page, "新建文章");
  await d.getByLabel("地址（可选）").fill(slug);
  await expect(d.getByText(`已被「${art}」使用`).first()).toBeVisible();
  // Leaving an edited editor with Esc asks first (the footer's 取消 discards).
  await page.keyboard.press("Escape");
  await dialog(page, "放弃未保存的修改？").getByRole("button", { name: "放弃修改" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Unpublish from the row menu.
  await row.getByRole("button", { name: `${art} 的操作` }).click();
  await page.getByRole("menuitem", { name: "撤回为草稿" }).click();
  await toast(page, "已撤回为草稿");
  await expect(row).toContainText("草稿");
  // Legal pages: fixed slug terms / privacy, no category or address fields.
  const legal = isMobile(info) ? "隐私政策" : "服务条款";
  await page.getByRole("button", { name: new RegExp(`^${legal}`) }).click();
  d = dialog(page, new RegExp(`编辑${legal}`));
  await expect(d).toContainText(isMobile(info) ? "/privacy" : "/terms");
  await expect(d.getByLabel("地址（可选）")).toHaveCount(0);
  await expect(d.getByLabel("正文（Markdown）")).toBeEnabled();
  await d.getByLabel("正文（Markdown）").fill(`${legal}：第一条`);
  const pub = d.getByRole("switch", { name: "发布" });
  if ((await pub.getAttribute("aria-checked")) !== "true") await pub.click();
  await d.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "文章已保存");
  await expect(page.getByRole("button", { name: new RegExp(`^${legal}`) })).not.toContainText("未创建");
  // Delete the category: its article becomes uncategorized (the confirmation says how many).
  await page.getByRole("button", { name: "管理分类" }).first().click();
  c = dialog(page, "管理分类");
  await c.getByRole("button", { name: `删除 ${cat}` }).click();
  await expect(page.getByRole("alertdialog")).toContainText("1 篇文章会变成未分类");
  await confirmDialog(page, cat, "删除分类");
  await toast(page, "已删除");
  await c.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /^未分类/ }).click();
  await expect(page.getByRole("listitem").filter({ hasText: art })).toBeVisible();
  // Delete the article: type its title; the old link becomes 404.
  await page
    .getByRole("listitem")
    .filter({ hasText: art })
    .getByRole("button", { name: `${art} 的操作` })
    .click();
  await page.getByRole("menuitem", { name: "删除…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("404");
  await confirmDialog(page, art, "删除文章");
  await toast(page, "已删除");
  await expect(page.getByRole("listitem").filter({ hasText: art })).toHaveCount(0);
});

test("CNT-09 CNT-10: promotions — create with a live preview, an unknown coupon is refused, edit, delete", async ({
  page,
}, info) => {
  const title = `${uniq(info, "promo")}-${run}`.slice(0, 40);
  await openConsole(page, "/content/promotions");
  await page.getByRole("button", { name: "新建活动" }).first().click();
  const d = dialog(page, "新建活动");
  // Required fields are checked before anything is sent.
  await d.getByRole("button", { name: "保存" }).click();
  await expect(d.getByText("请填写标题")).toBeVisible();
  await expect(d.getByText("请填写一句说明")).toBeVisible();
  // The label wraps the error line, so after the required check its name is "标题 请填写标题".
  await d.getByLabel(/^标题/).fill(title);
  await d.getByLabel("折扣字样").fill("8折");
  await d.getByLabel("一句说明").fill("续费同样适用");
  const preview = d.getByTestId("promotion-preview");
  await expect(preview).toContainText(title);
  await expect(preview).toContainText("8折");
  // A code that is not a coupon: the server refuses it, the dialog stays open.
  await d.getByLabel("优惠码").fill(`NOPE${run}`);
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, /没有优惠码为/);
  await expect(d).toBeVisible();
  await d.getByLabel("优惠码").fill("");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "活动已创建");
  const rows = page.getByTestId("promotion-row");
  const mine = rows.filter({ hasText: title });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText("进行中");
  await expect(mine).toContainText("8折");
  // Edit: a new description; the version moves on, a second save works too.
  await mine.getByRole("button", { name: `编辑 ${title}` }).click();
  const e = dialog(page, "编辑活动");
  await e.getByLabel("一句说明").fill("十一月结束");
  await e.getByRole("button", { name: "保存" }).click();
  await toast(page, "活动已保存");
  await mine.getByRole("button", { name: `编辑 ${title}` }).click();
  const e2 = dialog(page, "编辑活动");
  await expect(e2.getByLabel("一句说明")).toHaveValue("十一月结束");
  await e2.getByLabel("排序").fill("5");
  await e2.getByRole("button", { name: "保存" }).click();
  await toast(page, "活动已保存");
  // Delete (confirmed): gone from the list.
  await mine.getByRole("button", { name: `${title} 的操作` }).click();
  await page.getByRole("menuitem", { name: "删除…" }).click();
  await confirmDialog(page);
  await toast(page, "已删除");
  await expect(mine).toHaveCount(0);
});
