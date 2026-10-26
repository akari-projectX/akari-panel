// Tickets and content (v2 shots/support.json, the tickets-* and content-*
// shots; the shell / login / account ones are in support.ts). The setup
// makes three tickets of the screens user (waiting + assigned to the admin,
// answered, closed), announcements in every lifecycle state (one mailed,
// one mailing — the mail columns written with sql, the console has no
// way to fake a mailing), a KB category with articles, an empty category
// and the terms page. Not taken (not reproducible deterministically, or
// prototype-only): tickets-inbox-empty (other specs leave tickets),
// tickets-inbox-loading, tickets-thread-error, tickets-thread-new-reply
// (needs a customer reply landing during a 15 s poll), tickets-thread-
// closing (a spinner mid-request), content-ann-empty, content-ann-loading,
// content-ann-preview-rendering / -error, content-kb-loading,
// content-kb-body-loading.
import { expect, type Page } from "@playwright/test";

import { apiAs, apiJson, ORIGIN, sql } from "../helpers";
import { goDialog, goto, need, type Ctx, type Device, type Shot } from "./shared";

const SCREENS_PW = "screens-pass-1";

/** Desktop: the context column is on screen; phone: open ⓘ. */
async function context(page: Page, device: Device) {
  if (device === "desktop") return page.getByRole("complementary", { name: "用户与工单" });
  await page.getByRole("button", { name: "用户与工单信息" }).click();
  const d = page.getByRole("dialog", { name: "用户与工单" });
  await expect(d).toBeVisible();
  return d;
}

/** Open a row's ⋯ menu item on a content page. */
async function rowMenu(page: Page, path: string, title: string, item: string) {
  await goto(page, path);
  await page
    .getByRole("button", { name: `${title} 的操作` })
    .first()
    .click();
  await page.getByRole("menuitem", { name: item }).click();
  await expect(page.getByRole("alertdialog").or(page.getByRole("dialog")).first()).toBeVisible();
}

const ticketShots: Shot[] = [
  { name: "tickets-inbox-default", open: async (page) => goto(page, "/tickets") },
  {
    name: "tickets-thread-default",
    open: async (page, c) => goto(page, `/tickets/${need(c.extra.ticket, "ticket")}`),
  },
  {
    name: "tickets-thread-quick",
    open: async (page, c) => {
      await goto(page, `/tickets/${need(c.extra.ticket, "ticket")}`);
      await page.getByRole("button", { name: "快捷回复" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
    },
  },
  {
    name: "tickets-thread-assign",
    open: async (page, c, device) => {
      await goto(page, `/tickets/${need(c.extra.answered, "answered ticket")}`);
      const ctx = await context(page, device);
      const select = ctx.getByLabel("负责人");
      const other = await select.locator("option").nth(1).getAttribute("value");
      await select.selectOption(other ?? "");
      await expect(ctx.getByText("点「分配」后生效。")).toBeVisible();
    },
  },
  {
    name: "tickets-thread-info",
    devices: ["mobile"],
    open: async (page, c, device) => {
      await goto(page, `/tickets/${need(c.extra.ticket, "ticket")}`);
      await context(page, device);
    },
  },
  {
    name: "tickets-thread-closed",
    open: async (page, c) => goto(page, `/tickets/${need(c.extra.closed, "closed ticket")}?view=closed`),
  },
  {
    name: "tickets-inbox-mine",
    open: async (page, c) => goto(page, `/tickets/${need(c.extra.ticket, "ticket")}?view=mine`),
  },
  { name: "tickets-inbox-filtered", open: async (page) => goto(page, "/tickets?priority=urgent&category=billing") },
  { name: "tickets-inbox-nomatch", open: async (page) => goto(page, "/tickets?q=发票退款") },
];

const annShots: Shot[] = [
  { name: "content-ann-default", full: true, open: async (page) => goto(page, "/content/announcements") },
  {
    name: "content-ann-editor",
    open: goDialog((c) => `/content/announcements?open=${need(c.extra.annLive, "live announcement")}`),
  },
  {
    name: "content-ann-editor-new-invalid",
    open: async (page) => {
      await goto(page, "/content/announcements?open=new");
      const d = page.getByRole("dialog", { name: "新建公告" });
      await d.getByLabel("正文（Markdown）").fill("十月最后一周，节点将分批升级。");
      await d.getByLabel("结束显示").fill("2020-01-01T00:00");
      await d.getByRole("button", { name: "发布" }).click();
      await expect(d.getByText("请填写中文标题")).toBeVisible();
    },
  },
  {
    name: "content-ann-delete",
    open: async (page, c) =>
      rowMenu(page, "/content/announcements", need(c.extra.annLiveTitle, "live announcement"), "删除…"),
  },
  // Announcement tags (2026-10-26): no v2 mock-up; the names follow the same scheme.
  { name: "content-tags-default", full: true, open: async (page) => goto(page, "/content/tags") },
  { name: "content-tags-editor", open: goDialog(() => "/content/tags?open=new") },
  {
    name: "content-ann-editor-tag",
    open: async (page, c) => {
      await goto(page, `/content/announcements?open=${need(c.extra.annLive, "live announcement")}`);
      const d = page.getByRole("dialog", { name: "编辑公告" });
      await d.getByRole("radiogroup", { name: "标签" }).getByRole("radio", { name: "维护" }).click();
    },
  },
  {
    name: "content-ann-mail",
    open: goDialog((c) => `/content/announcements?mail=${need(c.extra.annLive, "live announcement")}`),
  },
  {
    name: "content-ann-mail-duplicate",
    open: goDialog((c) => `/content/announcements?mail=${need(c.extra.annMailed, "mailed announcement")}`),
  },
  {
    name: "content-ann-mail-sending",
    open: goDialog((c) => `/content/announcements?mail=${need(c.extra.annSending, "mailing announcement")}`),
  },
];

const kbShots: Shot[] = [
  { name: "content-kb-default", open: async (page) => goto(page, "/content/kb") },
  {
    name: "content-kb-category",
    open: async (page, c) => goto(page, `/content/kb?cat=${need(c.extra.kbCat, "category")}`),
  },
  {
    name: "content-kb-empty-category",
    open: async (page, c) => goto(page, `/content/kb?cat=${need(c.extra.kbEmpty, "empty category")}`),
  },
  { name: "content-kb-editor", open: goDialog((c) => `/content/kb?open=${need(c.extra.kbArticle, "article")}`) },
  { name: "content-kb-legal", open: goDialog((c) => `/content/kb?open=${need(c.extra.kbTerms, "terms page")}`) },
  {
    name: "content-kb-slug-taken",
    open: async (page, c) => {
      await goto(page, "/content/kb?open=new");
      const d = page.getByRole("dialog", { name: "新建文章" });
      await d.getByLabel("文章标题（中文）").fill("三分钟开始使用（新版）");
      await d.getByLabel("地址（可选）").fill(need(c.extra.kbSlug, "article slug"));
      await expect(d.getByText(/已被「/).first()).toBeVisible();
    },
  },
  { name: "content-kb-cats", open: goDialog(() => "/content/kb?cats=1") },
  {
    name: "content-kb-cat-delete",
    open: async (page, c) => {
      await goto(page, "/content/kb?cats=1");
      await page
        .getByRole("dialog", { name: "管理分类" })
        .getByRole("button", { name: `删除 ${need(c.extra.kbCatName, "category")}` })
        .click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    name: "content-kb-article-delete",
    open: async (page, c) => rowMenu(page, "/content/kb", need(c.extra.kbArticleTitle, "article"), "删除…"),
  },
];

export const shots: Shot[] = [...ticketShots, ...annShots, ...kbShots];

export async function setup(ctx: Ctx): Promise<void> {
  const tag = ctx.info.project.name;
  // Tickets of the screens user: waiting (assigned to the admin), answered, closed.
  try {
    const email = need(ctx.userEmail, "screens user");
    const user = await apiAs(email, SCREENS_PW, true);
    const open = async (subject: string, category: string, priority: string, message: string) => {
      const r = await user.post(`${ORIGIN}/api/v1/me/tickets`, { data: { subject, category, priority, message } });
      expect(r.status(), await r.text()).toBe(201);
      return ((await r.json()) as { id: string }).id;
    };
    const me = await apiJson<{ id: string }>("GET", "/me");
    ctx.extra.ticket = await open(
      "付款成功但套餐没有开通",
      "billing",
      "urgent",
      "昨晚用支付宝付了年付套餐，钱已经扣了，但门户里还是显示没有套餐。",
    );
    await apiJson("PUT", `/tickets/${ctx.extra.ticket}/assignee`, { assignee_id: me.id });
    ctx.extra.answered = await open(
      "香港节点晚上很慢",
      "technical",
      "high",
      "每天晚上 9 点以后香港节点速度只有几百 KB。",
    );
    await apiJson("POST", `/tickets/${ctx.extra.answered}/replies`, {
      message: "您好，晚高峰线路拥堵，我们正在扩容，期间可以先用日本节点。",
    });
    ctx.extra.closed = await open("怎么修改登录邮箱", "account", "normal", "我想把登录邮箱换成新的地址。");
    await apiJson("POST", `/tickets/${ctx.extra.closed}/replies`, {
      message: "在门户「账户」页可以修改邮箱，验证新地址后即生效。",
      close: true,
    });
  } catch (e) {
    console.log(`screens: no tickets of our own (${(e as Error).message.split("\n")[0]})`);
  }
  // Announcements: live (pinned), scheduled, draft, ended, mailed, mailing.
  const day = 86_400_000;
  const iso = (d: number) => new Date(Date.now() + d * day).toISOString();
  const ann = async (title: string, extra: Record<string, unknown>) =>
    (
      await apiJson<{ id: string }>("POST", "/announcements", {
        title_zh: title,
        body_zh: `## ${title}\n\n**节点维护**期间可能短暂断线，请留意。`,
        audience: "all",
        ...extra,
      })
    ).id;
  ctx.extra.annLiveTitle = `国庆期间客服时间调整 ${tag}`;
  ctx.extra.annLive = await ann(ctx.extra.annLiveTitle, {
    pinned: true,
    title_en: "Support hours during the holiday",
    body_en: "Support answers more slowly this week.",
    visible_from: iso(-3),
    visible_until: iso(9),
  });
  await ann(`十月底节点分批升级 ${tag}`, { visible_from: iso(6), visible_until: iso(20), audience: "with_plan" });
  await ann(`新客户端预告 ${tag}`, { enabled: false });
  await ann(`九月账单说明 ${tag}`, { visible_from: iso(-40), visible_until: iso(-10) });
  ctx.extra.annMailed = await ann(`日本节点扩容完成 ${tag}`, { visible_from: iso(-1) });
  ctx.extra.annSending = await ann(`订阅地址更换提醒 ${tag}`, { visible_from: iso(-2), visible_until: iso(12) });
  try {
    sql(
      `UPDATE announcements SET mail_requested_at = now() - interval '2 days', mail_done_at = now() - interval '2 days', mail_sent = 1284 WHERE id = '${ctx.extra.annMailed}'`,
    );
    sql(
      `UPDATE announcements SET mail_requested_at = now(), mail_done_at = NULL, mail_sent = 0 WHERE id = '${ctx.extra.annSending}'`,
    );
  } catch (e) {
    console.log(`screens: mail state not written (${(e as Error).message.split("\n")[0]})`);
  }
  // Knowledge base: a category with articles, an empty category, the terms page.
  ctx.extra.kbCatName = `新手入门 ${tag}`;
  ctx.extra.kbCat = (
    await apiJson<{ id: string }>("POST", "/kb/categories", {
      name_zh: ctx.extra.kbCatName,
      name_en: "Getting started",
    })
  ).id;
  ctx.extra.kbEmpty = (
    await apiJson<{ id: string }>("POST", "/kb/categories", { name_zh: `企业专线 ${tag}`, name_en: "Business lines" })
  ).id;
  ctx.extra.kbSlug = `choose-node-${tag}`;
  ctx.extra.kbArticleTitle = `如何选择节点 ${tag}`;
  ctx.extra.kbArticle = (
    await apiJson<{ id: string }>("POST", "/kb/articles", {
      category_id: ctx.extra.kbCat,
      title_zh: ctx.extra.kbArticleTitle,
      title_en: "Choosing a node",
      body_zh: "## 怎么选\n\n- 离你近的地区延迟更低\n- 晚高峰可以换到负载低的节点",
      body_en: "Pick the closest region.",
      sort: 2,
      published: true,
      slug: ctx.extra.kbSlug,
    })
  ).id;
  await apiJson("POST", "/kb/articles", {
    category_id: ctx.extra.kbCat,
    title_zh: `三分钟开始使用 ${tag}`,
    body_zh: "购买套餐后，把订阅链接导入客户端即可。",
    sort: 1,
    published: true,
  });
  const arts = await apiJson<{ id: string; slug: string | null }[]>("GET", "/kb/articles");
  ctx.extra.kbTerms =
    arts.find((a) => a.slug === "terms")?.id ??
    (
      await apiJson<{ id: string }>("POST", "/kb/articles", {
        title_zh: "服务条款",
        title_en: "Terms of service",
        body_zh: "## 一、服务内容\n\n本站提供网络加速服务。",
        published: true,
        slug: "terms",
      })
    ).id;
}
