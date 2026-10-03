// Ops: portal announcements (read state, zh/en), help center (search,
// article deep link), branding (logo, footer, downloads), and the console's
// announcement editor, knowledge base, branding form and template editor.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../i18n";
import type { AuthOptions, Branding, HelpArticle, HelpList, Me, MyAnnouncements } from "../lib/api";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { BrandingSettings, brandingBody } from "./admin-branding";
import { AdminContent, announcementBody, contentTabOf } from "./admin-content";
import { MailTemplates, unknownPlaceholders, type MailTemplate } from "./admin-mail-templates";
import { AnnouncementsCard } from "./announcements";
import { Help, helpArticleOf } from "./help";
import { SiteFooter, SiteMark } from "../components/branding";
import { ClientDownloads } from "./subscription";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.pushState(null, "", "/");
});

const anns: MyAnnouncements = {
  unread: 1,
  announcements: [
    {
      id: "a1",
      title_zh: "维护通知",
      title_en: "Maintenance",
      html_zh: "<p>节点 <strong>周六</strong> 维护</p>",
      html_en: "<p>Nodes are <strong>maintained</strong> on Saturday</p>",
      pinned: true,
      created_at: "2026-10-02T00:00:00Z",
      read: false,
    },
    {
      id: "a2",
      title_zh: "旧公告",
      title_en: null,
      html_zh: "<p>已读的内容</p>",
      html_en: null,
      pinned: false,
      created_at: "2026-09-01T00:00:00Z",
      read: true,
    },
  ],
};

describe("portal announcements", () => {
  it("shows pinned/unread open, marks read on demand, follows the language", async () => {
    setLocale("zh");
    let read = 0;
    const calls = fakeApi({
      "GET /me/announcements": anns,
      "POST /me/announcements/a1/read": () => {
        read++;
        return { status: 204 };
      },
    });
    renderWithClient(<AnnouncementsCard />);
    expect(await screen.findByRole("heading", { name: "维护通知" })).toBeTruthy();
    expect(screen.getByText("1 条未读")).toBeTruthy();
    expect(screen.getByText("置顶")).toBeTruthy();
    // Pinned + unread starts open; the read one is collapsed.
    expect(screen.getByText("周六").tagName).toBe("STRONG");
    expect(screen.queryByText("已读的内容")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "标为已读" }));
    await waitFor(() => expect(read).toBe(1));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    cleanup();
    setLocale("en");
    fakeApi({ "GET /me/announcements": anns });
    renderWithClient(<AnnouncementsCard />);
    expect(await screen.findByRole("heading", { name: "Maintenance" })).toBeTruthy();
    expect(screen.getByText("maintained").tagName).toBe("STRONG");
    // No English variant: the Chinese title is shown.
    expect(screen.getByRole("heading", { name: "旧公告" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Read more" })[0]);
    expect(screen.getByText("已读的内容")).toBeTruthy();
    setLocale("zh");
  });

  it("empty state", async () => {
    fakeApi({ "GET /me/announcements": { announcements: [], unread: 0 } });
    renderWithClient(<AnnouncementsCard />);
    expect(await screen.findByText("暂无公告。")).toBeTruthy();
  });
});

const help: HelpList = {
  total: 2,
  categories: [
    {
      id: "c1",
      name_zh: "入门",
      name_en: "Getting started",
      articles: [
        {
          id: "k1",
          category_id: "c1",
          title_zh: "如何导入订阅",
          title_en: "Import",
          updated_at: "2026-10-01T00:00:00Z",
        },
      ],
    },
  ],
  uncategorized: [
    { id: "k2", category_id: null, title_zh: "其他问题", title_en: null, updated_at: "2026-10-01T00:00:00Z" },
  ],
};

describe("help center", () => {
  it("lists by category, searches on the server, opens an article by URL", async () => {
    setLocale("zh");
    const article: HelpArticle = {
      id: "k1",
      category_id: "c1",
      category_zh: "入门",
      category_en: null,
      title_zh: "如何导入订阅",
      title_en: null,
      html_zh: "<p>打开 <em>客户端</em></p>",
      html_en: null,
      updated_at: "2026-10-01T00:00:00Z",
    };
    const calls = fakeApi({ "GET /me/help": help, "GET /me/help/k1": article });
    renderWithClient(<Help />);
    expect(await screen.findByRole("heading", { name: "入门" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "其他" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索帮助文章"), { target: { value: "订阅" } });
    await waitFor(() => expect(calls.some((c) => c.search === `?q=${encodeURIComponent("订阅")}`)).toBe(true));
    fireEvent.click(screen.getByRole("link", { name: "如何导入订阅" }));
    expect(location.pathname).toBe("/app/help/k1");
    expect(await screen.findByRole("heading", { name: "如何导入订阅" })).toBeTruthy();
    expect(screen.getByText("客户端").tagName).toBe("EM");
    fireEvent.click(screen.getByRole("button", { name: /返回帮助中心/ }));
    expect(location.pathname).toBe("/app/help");
  });

  it("parses article paths", () => {
    expect(helpArticleOf("/app/help/abc")).toBe("abc");
    expect(helpArticleOf("/app/help")).toBeNull();
    expect(helpArticleOf("/app/helpx/abc")).toBeNull();
  });
});

const branding: Branding = {
  version: 3,
  logo_url: "brand/logo?v=0123456789abcdef",
  favicon_url: null,
  footer_text: "© 2026 Akari",
  footer_links: [{ label: "状态页", url: "https://status.example" }],
  tos_url: "https://x.example/tos",
  privacy_url: null,
  client_downloads: [{ platform: "android", label: "Clash Meta", url: "https://dl.example/a.apk" }],
  updated_at: "2026-10-02T00:00:00Z",
};

describe("branding in the portal", () => {
  it("logo, footer links (external ones open safely), downloads", async () => {
    setLocale("zh");
    const options: AuthOptions = {
      register: false,
      invite_required: false,
      email_domains: [],
      reset: false,
      site_name: "Akari Cloud",
      branding,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(options), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    renderWithClient(
      <>
        <SiteMark />
        <ClientDownloads />
        <SiteFooter />
      </>,
    );
    const logo = await screen.findByRole("img", { name: "Akari Cloud 标志" });
    expect(logo.getAttribute("src")).toBe("/brand/logo?v=0123456789abcdef");
    expect(screen.getByText("© 2026 Akari")).toBeTruthy();
    const status = screen.getByRole("link", { name: "状态页" });
    expect(status.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("link", { name: "服务条款" }).getAttribute("href")).toBe("https://x.example/tos");
    expect(screen.queryByRole("link", { name: "隐私政策" })).toBeNull();
    expect(screen.getByRole("heading", { name: "客户端下载" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Android/ }).getAttribute("href")).toBe("https://dl.example/a.apk");
  });

  it("nothing without branding", async () => {
    fakeApi({});
    renderWithClient(<SiteFooter />);
    await waitFor(() => expect(document.querySelector("footer")).toBeNull());
  });
});

describe("console content", () => {
  it("tabs and request bodies", () => {
    expect(contentTabOf("/admin/content/kb")).toBe("kb");
    expect(contentTabOf("/admin/content")).toBe("announcements");
    expect(
      announcementBody({
        title_zh: "t",
        title_en: " ",
        body_zh: "b",
        body_en: "",
        pinned: true,
        enabled: true,
        visible_from: "2026-10-02T08:00",
        visible_until: "",
        audience: "with_plan",
      }),
    ).toEqual({
      title_zh: "t",
      title_en: null,
      body_zh: "b",
      body_en: null,
      pinned: true,
      enabled: true,
      visible_from: "2026-10-02T00:00:00.000Z",
      visible_until: null,
      audience: "with_plan",
    });
  });

  it("creates an announcement with a live server preview", async () => {
    window.history.pushState(null, "", "/admin/content/announcements");
    let created: unknown = null;
    fakeApi({
      "GET /announcements": [],
      "POST /content/preview": (b: unknown) => ({
        status: 200,
        body: { html: `<p><strong>${String((b as { markdown: string }).markdown).replace(/\*/g, "")}</strong></p>` },
      }),
      "POST /announcements": (b: unknown) => {
        created = b;
        return { status: 201, body: { id: "n1" } };
      },
    });
    renderAdmin(<AdminContent />);
    fireEvent.click(await screen.findByRole("button", { name: "新建公告" }));
    fireEvent.change(screen.getByLabelText("标题（中文）"), { target: { value: "新公告" } });
    fireEvent.change(screen.getByLabelText("正文（中文）"), { target: { value: "**加粗**" } });
    const preview = await screen.findByRole("region", { name: "正文（中文）预览" });
    await waitFor(() => expect(within(preview).getByText("加粗").tagName).toBe("STRONG"), { timeout: 2000 });
    fireEvent.change(screen.getByLabelText("受众"), { target: { value: "without_plan" } });
    fireEvent.click(screen.getByLabelText("置顶"));
    fireEvent.click(screen.getByRole("button", { name: "发布公告" }));
    await screen.findByText("已发布公告。");
    expect(created).toMatchObject({ title_zh: "新公告", body_zh: "**加粗**", audience: "without_plan", pinned: true });
  });

  it("knowledge base lists articles and adds a category", async () => {
    window.history.pushState(null, "", "/admin/content/kb");
    let cat: unknown = null;
    fakeApi({
      "GET /kb/categories": [
        { id: "c1", name_zh: "入门", name_en: null, sort: 1, articles: 1, created_at: "2026-10-01T00:00:00Z" },
      ],
      "GET /kb/articles": [
        {
          id: "k1",
          category_id: "c1",
          category_name: "入门",
          title_zh: "如何导入订阅",
          title_en: null,
          body_zh: "x",
          body_en: null,
          sort: 0,
          published: false,
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-01T00:00:00Z",
        },
      ],
      "POST /kb/categories": (b: unknown) => {
        cat = b;
        return { status: 201, body: { id: "c2" } };
      },
    });
    renderAdmin(<AdminContent />);
    expect(await screen.findByText("如何导入订阅")).toBeTruthy();
    expect(screen.getByText("草稿")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("分类名称（中文）"), { target: { value: "进阶" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "添加分类" }));
    await screen.findByText("已添加分类。");
    expect(cat).toEqual({ name_zh: "进阶", name_en: null, sort: 5 });
  });
});

describe("console branding", () => {
  it("body drops blank rows", () => {
    expect(
      brandingBody(2, {
        footer_text: " ",
        tos_url: "",
        privacy_url: " /p ",
        links: [
          { label: "", url: "" },
          { label: "a", url: "https://a" },
        ],
        downloads: [
          { platform: "ios", label: " ", url: "https://i" },
          { platform: "linux", label: null, url: "" },
        ],
      }),
    ).toEqual({
      version: 2,
      footer_text: null,
      footer_links: [{ label: "a", url: "https://a" }],
      tos_url: null,
      privacy_url: "/p",
      client_downloads: [{ platform: "ios", label: null, url: "https://i" }],
    });
  });

  it("saves the text fields with the current version", async () => {
    let put: unknown = null;
    fakeApi({
      "GET /settings/branding": branding,
      "PUT /settings/branding": (b: unknown) => {
        put = b;
        return { status: 200, body: { ...branding, version: 4 } };
      },
    });
    renderAdmin(<BrandingSettings />);
    expect(await screen.findByRole("img", { name: "当前Logo" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("隐私政策链接"), { target: { value: "https://x.example/privacy" } });
    fireEvent.click(screen.getByRole("button", { name: "保存页脚与链接" }));
    await screen.findByText("已保存。");
    expect(put).toMatchObject({
      version: 3,
      privacy_url: "https://x.example/privacy",
      tos_url: "https://x.example/tos",
    });
  });
});

const tpl = (over: Partial<MailTemplate> = {}): MailTemplate => ({
  kind: "register_code",
  label: "注册验证码",
  locale: "zh",
  subject: "{site} 注册验证码",
  body: "验证码：\n\n{code}",
  default_subject: "{site} 注册验证码",
  default_body: "验证码：\n\n{code}",
  custom: false,
  version: 0,
  placeholders: [
    { name: "site", description: "站点名称" },
    { name: "code", description: "验证码" },
    { name: "minutes", description: "有效分钟数" },
  ],
  required: ["code"],
  ...over,
});

describe("mail template editor", () => {
  it("flags unknown and missing placeholders before saving", async () => {
    expect(unknownPlaceholders("{a} {site} {B} {b_1}", ["site"])).toEqual(["a", "b_1"]);
    let saved: unknown = null;
    fakeApi({
      "GET /settings/mail-templates": [tpl(), tpl({ locale: "en", subject: "Your {site} code" })],
      "POST /settings/mail-templates/preview": (b: unknown) => ({
        status: 200,
        body: { subject: `预览：${(b as { subject: string }).subject}`, text: "t", html: "<p>h</p>" },
      }),
      "PUT /settings/mail-templates/register_code/zh": (b: unknown) => {
        saved = b;
        return { status: 200, body: { version: 1, custom: true } };
      },
    });
    renderAdmin(<MailTemplates />);
    const subject = await screen.findByLabelText("邮件主题");
    expect((subject as HTMLInputElement).value).toBe("{site} 注册验证码");
    await waitFor(
      () => expect(screen.getByTestId("tpl-preview-subject").textContent).toContain("预览：{site} 注册验证码"),
      {
        timeout: 2000,
      },
    );
    expect(screen.getByTitle("邮件 HTML 预览").getAttribute("sandbox")).toBe("");
    const body = screen.getByLabelText("邮件正文");
    fireEvent.change(body, { target: { value: "没有验证码 {nope}" } });
    expect(screen.getByText("未知占位符：{nope}")).toBeTruthy();
    expect(screen.getByText("缺少必需占位符：{code}")).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存模板" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(body, { target: { value: "新的正文 " } });
    fireEvent.click(screen.getByRole("button", { name: "{code}*" }));
    expect((body as HTMLInputElement).value).toBe("新的正文 {code}");
    fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
    await screen.findByText("已保存模板。");
    expect(saved).toEqual({ version: 0, subject: "{site} 注册验证码", body: "新的正文 {code}" });
    // Restore default is offered only for a custom template.
    expect((screen.getByRole("button", { name: "恢复默认" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("语言"), { target: { value: "en" } });
    expect(await screen.findByDisplayValue("Your {site} code")).toBeTruthy();
  });

  it("restores the default after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let deleted = false;
    fakeApi({
      "GET /settings/mail-templates": [tpl({ custom: true, version: 2, subject: "自定义 {code}" })],
      "POST /settings/mail-templates/preview": { subject: "s", text: "t", html: "<p>h</p>" },
      "DELETE /settings/mail-templates/register_code/zh": () => {
        deleted = true;
        return { status: 200, body: { reset: true } };
      },
    });
    renderAdmin(<MailTemplates />);
    expect(await screen.findByText("已自定义")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    await screen.findByText("已恢复默认。");
    expect(deleted).toBe(true);
  });
});

export type { Me };
