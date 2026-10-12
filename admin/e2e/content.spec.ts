// INVENTORY §8 (tickets), §9 (content).
import { expect, test } from "@playwright/test";

import {
  ADMIN,
  ORIGIN,
  USER,
  USER_PW,
  apiAs,
  confirmDialog,
  dialog,
  openConsole,
  openRow,
  row,
  toast,
  uniq,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test("TKT-01 TKT-02 TKT-03: ticket queue, conversation, reply and close, reopen, assignee", async ({ page }, info) => {
  const subject = uniq(info, "help me");
  const user = await apiAs(USER, USER_PW, true);
  expect(
    (
      await user.post(`${ORIGIN}/api/v1/me/tickets`, {
        data: { subject, category: "billing", priority: "high", message: "my order" },
      })
    ).status(),
  ).toBe(201);
  await openConsole(page, "/tickets");
  await page.getByLabel("分类").selectOption("billing");
  await page.getByLabel("优先级").selectOption("high");
  await page.getByRole("checkbox", { name: "只看未读" }).click();
  await page.getByLabel("搜索工单").fill(subject);
  // Filters live in the URL.
  await expect(page).toHaveURL(/category=billing/);
  await expect(page).toHaveURL(/unread=1/);
  await expect(row(page, subject)).toContainText("待回复");
  await openRow(page, subject);
  const d = dialog(page, subject);
  await expect(d.getByText("my order")).toBeVisible();
  // The assignee select is not focused on open and only an explicit 分配 changes it.
  await expect(d.getByLabel("负责人")).not.toBeFocused();
  await d.getByLabel("负责人").selectOption({ label: `${ADMIN}（我）` });
  await d.getByRole("button", { name: "分配", exact: true }).click();
  await toast(page, "已分配");
  // Ctrl+Enter sends the reply; the conversation shows it without a reload.
  await d.getByLabel("回复").fill("checking");
  await d.getByLabel("回复").press("Control+Enter");
  await toast(page, "已回复");
  await expect(d.getByText("checking")).toBeVisible();
  await expect(d.getByLabel("回复")).toHaveValue("");
  await d.getByLabel("回复").fill("fixed");
  await d.getByRole("button", { name: "回复并关闭" }).click();
  await toast(page, "已回复并关闭");
  await expect(d.getByText("已关闭").first()).toBeVisible();
  await d.getByRole("button", { name: "重新打开" }).click();
  await toast(page, "已重新打开");
  await d.getByRole("button", { name: "关闭工单" }).click();
  await toast(page, "已关闭");
  await d.getByRole("button", { name: "关闭", exact: true }).first().click();
  await expect(dialog(page, subject)).toHaveCount(0);
  await page.getByLabel("状态", { exact: true }).selectOption("closed");
  await page.getByRole("checkbox", { name: "只看未读" }).click();
  await page.getByLabel("负责人").selectOption("me");
  await expect(row(page, subject)).toContainText("已关闭");
});

test("CNT-01 CNT-02 CNT-03 CNT-04 CNT-05 CNT-06: announcements (preview, mail), categories, articles with the terms slug", async ({
  page,
}, info) => {
  const title = uniq(info, "maintenance");
  await openConsole(page, "/content");
  await page.getByRole("button", { name: "新建公告" }).first().click();
  let d = dialog(page, "新建公告");
  // Required fields are checked before anything is sent.
  await d.getByRole("button", { name: "保存" }).click();
  await expect(d.getByText("请填写中文标题")).toBeVisible();
  await d.getByLabel("受众").selectOption("with_plan");
  await d.getByLabel("标题（中文）").fill(title);
  await d.getByLabel("正文（Markdown）").fill("**周日** 维护");
  await expect(d.getByTestId("preview").locator("strong")).toHaveText("周日");
  await d.getByRole("switch", { name: "置顶" }).click();
  await expect(d.getByRole("button", { name: /英文（可选）/ })).toContainText("未填");
  await d.getByRole("button", { name: /英文（可选）/ }).click();
  await d.getByLabel("标题（英文）").fill(`${title} en`);
  await d.getByLabel("正文（英文）").fill("Sunday maintenance");
  await expect(d.getByRole("button", { name: /英文（可选）/ })).toContainText("已填");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "公告已保存");
  await expect(row(page, title)).toContainText("有生效套餐的用户");
  await openRow(page, title);
  d = dialog(page, "编辑公告");
  // Mail needs mail sending: off here → the error is explained. The confirmation names the audience size.
  await d.getByRole("button", { name: "邮件通知" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(/有生效套餐的用户：最多 \d+ 人|人数未知/);
  await confirmDialog(page);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /邮件发送尚未配置|已加入发送队列/ })
      .or(page.locator("[data-sonner-toast]", { hasText: "已加入发送队列" })),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  if (await dialog(page, "编辑公告").isVisible()) await page.keyboard.press("Escape");
  await expect(dialog(page, "编辑公告")).toHaveCount(0);
  await openRow(page, title);
  await dialog(page, "编辑公告").getByRole("button", { name: "删除" }).click();
  await confirmDialog(page, title);
  await toast(page, "已删除");
  await expect(row(page, title)).toHaveCount(0);
  // Knowledge base.
  await page.getByRole("tab", { name: "知识库" }).click();
  const cat = uniq(info, "常见问题");
  await page.getByLabel("新分类名称").fill(cat);
  await page.getByRole("button", { name: "添加分类" }).click();
  await toast(page, "分类已添加");
  await page.getByRole("button", { name: `分类 ${cat} 的操作` }).click();
  await page.getByRole("menuitem", { name: "改名 / 排序" }).click();
  const c = dialog(page, "编辑分类");
  await c.getByLabel("英文名称（可选）").fill("FAQ");
  await c.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "已保存");
  await expect(page.getByText("FAQ", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建文章" }).first().click();
  d = dialog(page, "新建文章");
  await d.getByLabel("分类").selectOption({ label: cat });
  const slug = info.project.name === "desktop" ? "terms" : "privacy";
  await d.getByLabel("固定地址（可选）").fill(slug);
  await d.getByRole("switch", { name: "发布" }).click();
  await d.getByLabel("文章标题（中文）").fill(uniq(info, "服务条款"));
  await d.getByLabel("正文（Markdown）").fill("- 第一条");
  await expect(d.getByTestId("preview").locator("li")).toHaveText("第一条");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "文章已保存");
  await expect(row(page, uniq(info, "服务条款"))).toContainText(slug);
  // The slug is unique.
  await page.getByRole("button", { name: "新建文章" }).first().click();
  d = dialog(page, "新建文章");
  await d.getByLabel("固定地址（可选）").fill(slug);
  await d.getByLabel("文章标题（中文）").fill("dup");
  await d.getByLabel("正文（Markdown）").fill("x");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "另一篇文章已经使用这个固定地址");
  // Leaving an edited editor asks first.
  await page.keyboard.press("Escape");
  await dialog(page, "放弃未保存的修改？").getByRole("button", { name: "放弃修改" }).click();
  await expect(dialog(page, "新建文章")).toHaveCount(0);
  // Delete the category: its article becomes uncategorized (the confirmation says how many).
  await page.getByRole("button", { name: `分类 ${cat} 的操作` }).click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("1 篇文章会变成未分类");
  await confirmDialog(page, cat);
  await toast(page, "已删除");
  await expect(row(page, uniq(info, "服务条款"))).toContainText("未分类");
});
