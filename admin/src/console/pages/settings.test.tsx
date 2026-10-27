// 系统设置 (2026-10 redesign) in jsdom with a stubbed API: every section
// renders from its fixtures; the save bar counts edits and field errors,
// saves with the full body (numbers parsed, secrets left out), confirms
// dangerous changes (the cleanup estimate for the edited days, a new time
// zone), guards leaving with unsaved changes and redirects old addresses.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LangProvider } from "../../shared/i18n";
import { ConfirmProvider } from "../../shared/ui/confirm";
import { invalidateOnWrite, makeQueryClient } from "../data";
import { MeContext } from "../session";
import { SettingsPage } from "./settings";

const ROUTING = {
  mode: "rules" as const,
  block: [],
  direct: [{ type: "geosite", value: "cn" }],
  services: [],
  rest: null,
  tag_groups: [],
  dns: { mode: "recommended" as const, fakeip: true, cn: [], intl: [] },
};
const S = {
  version: 7,
  main: {
    domains: [{ domain: "a.example.com", display: "a.example.com", preferred: true }],
    effective: "https://a.example.com",
  },
  sub: { domains: [], effective: null },
  node: {
    domains: [{ domain: "n.example.com", display: "n.example.com", preferred: true }],
    panel_addr: "n.example.com:8443",
    server_name: "n.example.com",
    default_port: 8443,
  },
  sub_domain_per_user: false,
  trust_cloudflare: { value: null, effective: false },
  server_names: [
    {
      name: "n.example.com",
      display: "n.example.com",
      source: "settings",
      first_used_at: "2026-10-01T00:00:00Z",
      current: true,
      locked: "current",
      nodes: [],
    },
  ],
  certificate_names: [],
  host_gate: true,
  site_name: null,
  timezone: { value: null, effective: "Asia/Shanghai", default: "Asia/Shanghai" },
  passkey: { domain: null, rp_id: "a.example.com", related_origins: [], labels: 1, label_limit: 5 },
  warnings: [],
  probe: {
    interval_secs: { value: null, effective: 1800, default: 1800 },
    urls: { value: null, effective: ["https://x/"], default: ["https://x/"] },
    panel_tcp: { value: null, effective: true, default: true },
    manual_cooldown_secs: 30,
  },
  node_ops: {
    install_tls_pin: null,
    install_fallback_url: null,
    install_fallback_effective: null,
    install_fallback_default: "https://gh/{arch}",
    acme_directory_url: null,
    acme_email: null,
    remove_mode: { value: null, effective: "gate" },
  },
  security: {
    audit_retention_days: { value: null, effective: 365, default: 365 },
    traffic_daily_retention_days: { value: null, effective: 400, default: 400 },
    cloudflare_ranges: null,
    cloudflare_ranges_shipped: 15,
    extra_release_keys: null,
    release_keys: [{ id: "abc", label: "official", official: true }],
  },
  subscription: {
    routing: { value: null, effective: ROUTING, default: ROUTING },
    rule_set_clash_url: { value: null, effective: "https://r/{kind}/{name}", default: "https://r/{kind}/{name}" },
    rule_set_singbox_url: { value: null, effective: "https://s/{kind}/{name}", default: "https://s/{kind}/{name}" },
    formats: { value: null, effective: ["clash", "sing-box", "links"] },
    import_clients: { value: null, effective: ["clash", "hiddify"] },
    name_rate: false,
    own_client_only: false,
  },
};
const FIX: Record<string, unknown> = {
  "/settings": S,
  "/settings/branding": {
    version: 1,
    logo_url: null,
    favicon_url: null,
    footer_text: null,
    footer_links: [],
    tos_url: null,
    privacy_url: null,
    client_downloads: [],
  },
  "/settings/subscription/catalog": {
    categories: [
      { id: "ads", name: "广告与跟踪", geosite: ["category-ads-all"], geoip: [] },
      { id: "netflix", name: "Netflix", geosite: ["netflix"], geoip: [] },
    ],
    services: [{ key: "netflix", name: "Netflix", emoji: "🎬", categories: ["netflix"] }],
    entrances: [{ id: "e1", name: "直连", node: "东京 01", region: "JP", tags: [], enabled: true }],
    regions: ["JP"],
    tags: [],
    rule_sets: [],
  },
  "/settings/access": {
    version: 1,
    admin_prefix: "secretprefix",
    admin_url: null,
    admin_allow_cidrs: [],
    your_ip: "127.0.0.1",
    sub_path: "subpath",
  },
  "/settings/auth": {
    version: 1,
    turnstile_site_key: null,
    turnstile_secret_set: false,
    turnstile_login: false,
    turnstile_register: false,
    turnstile_reset: false,
    honeypot: true,
    min_submit_secs: 2,
    passkey_only_admins: false,
    passkey_only_users: false,
    passkey_prompt: true,
    warnings: [],
  },
  "/settings/signup": {
    version: 1,
    register_enabled: false,
    invite_required: false,
    invite_single_use: false,
    email_domains: [],
    trial_plan_id: null,
    trial_days: 3,
    reset_enabled: false,
    email_verify: false,
    passkey_register: false,
    user_invites: true,
    passkey_available: true,
    mail_enabled: false,
    public_origin: null,
    warnings: [],
  },
  "/settings/cleanup": {
    version: 1,
    auto: false,
    after_days: 30,
    warn: false,
    warn_days: 7,
    last_run_at: null,
    last_deleted: 0,
    last_warned: 0,
    due_warn: 0,
    due_delete: 0,
  },
  "/users": { users: [], total: 42 },
  "/plans": [{ id: "p1", name: "Basic" }],
  "/block-rules": {
    lists_version: "v1",
    nodes_enabled: 1,
    rules: [
      {
        id: 1,
        kind: "builtin",
        builtin_key: "ads",
        name: "Ads",
        pattern: null,
        entries: 100,
        enabled: true,
        sort: 10,
        hits_7d: 3,
      },
      {
        id: 2,
        kind: "domain",
        builtin_key: null,
        name: "Mine",
        pattern: "full:x.com",
        entries: 1,
        enabled: false,
        sort: 20,
        hits_7d: 0,
      },
    ],
  },
  "/agent-updates": {
    version: 1,
    source_url: null,
    default_source_url: "https://api.github.com/x",
    auto_check: false,
    next_auto_check_at: null,
    keys_configured: true,
  },
  "/settings/payments": {
    kinds: [
      {
        id: "alipay_f2f",
        label: "支付宝当面付",
        schema: [
          { name: "app_id", label: "APPID", type: "text", required: true },
          { name: "refund_original", label: "允许原路退款", type: "bool", default: true },
        ],
      },
    ],
    methods: [
      {
        id: "m1",
        kind: "alipay_f2f",
        kind_label: "支付宝当面付",
        display_name: "Alipay",
        icon: null,
        sort: 10,
        enabled: true,
        version: 1,
        config: { app_id: "1" },
        notify_url: "https://a/pay/m1/notify",
        active: true,
        warnings: [],
      },
    ],
    warnings: [],
  },
  "/commission-settings": {
    enabled: false,
    rate_percent: 5,
    first_order_only: false,
    hold_days: 7,
    min_withdrawal_cents: 1000,
    usdt_chains: ["trc20", "plasma"],
    usdt_rate_cents: null,
  },
  "/settings/mail": {
    version: 1,
    enabled: false,
    provider: "smtp",
    providers: ["smtp", "resend"],
    host: null,
    port: 465,
    security: "tls",
    username: null,
    password_set: false,
    api_key_set: false,
    from_addr: null,
    from_name: null,
    notify_order_paid: true,
    notify_expiry_days: 3,
    notify_expired: true,
    notify_quota: true,
    notify_refund: true,
    dead_letters: 0,
    pending: 0,
    warnings: [],
  },
  "/settings/mail-templates": [{ kind: "verify", custom: false }],
  "/alerts/settings": {
    version: 1,
    enabled: true,
    offline_secs: 120,
    cpu_percent: null,
    cpu_minutes: 5,
    mem_percent: null,
    mem_minutes: 5,
    disk_percent: null,
    cert_days: 14,
    latency_failures: true,
    last_error: true,
    cooldown_minutes: 60,
    notify_resolved: true,
    telegram_enabled: false,
    telegram_chat_id: null,
    telegram_token_set: false,
    telegram_api_url: null,
    telegram_api_default: "https://api.telegram.org",
    webhook_enabled: false,
    webhook_url: null,
    webhook_secret_set: false,
    email_enabled: false,
    email_to: [],
    email_available: false,
  },
  "/settings/domains/impact": { removed: [] },
  "/settings/dns-check": {
    domain: "x.example.org",
    addresses: [{ ip: "203.0.113.24", cloudflare: false }],
    level: "ok",
    message: "ok",
  },
  "/me/passkeys": { passkeys: [{ current: true }] },
};
// The overview's one request: each part is that section's own GET.
FIX["/settings/overview"] = {
  settings: FIX["/settings"],
  signup: FIX["/settings/signup"],
  auth: FIX["/settings/auth"],
  cleanup: FIX["/settings/cleanup"],
  access: FIX["/settings/access"],
  payments: FIX["/settings/payments"],
  commission: FIX["/commission-settings"],
  mail: FIX["/settings/mail"],
  mail_templates: FIX["/settings/mail-templates"],
  alerts: FIX["/alerts/settings"],
  block_rules: FIX["/block-rules"],
  agent_updates: FIX["/agent-updates"],
  branding: FIX["/settings/branding"],
};
const calls: { method: string; path: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/^.*\/api\/v1/, "").split("?")[0];
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method !== "GET" && path !== "/settings/domains/impact")
        return new Response(JSON.stringify(FIX[path] ?? { ok: true }), { status: 200 });
      if (!(path in FIX)) return new Response(JSON.stringify({ error: "nf", code: "x" }), { status: 404 });
      return new Response(JSON.stringify(FIX[path]), { status: 200 });
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
});
afterEach(() => cleanup());

function mount(path: string, isOwner = true) {
  const qc = makeQueryClient();
  invalidateOnWrite(qc);
  const router = createMemoryRouter(
    [
      { path: "/settings/*", Component: SettingsPage },
      { path: "*", element: <div>elsewhere</div> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={qc}>
      <LangProvider initial="zh">
        <ConfirmProvider>
          <MeContext.Provider
            value={{ id: "u", email: "a@b.c", role: "admin", email_verified: true, is_owner: isOwner }}
          >
            <RouterProvider router={router} />
          </MeContext.Provider>
        </ConfirmProvider>
      </LangProvider>
    </QueryClientProvider>,
  );
  return router;
}

const IDS = [
  "site",
  "brand",
  "links",
  "domains",
  "signup",
  "login",
  "cleanup",
  "subscription",
  "routing",
  "install",
  "probe",
  "block",
  "updates",
  "payments",
  "commission",
  "mail",
  "notices",
  "alerts",
  "access",
  "retention",
  "account",
];

for (const id of IDS)
  test(`renders ${id}`, async () => {
    mount(`/settings/${id}`);
    await waitFor(() => expect(screen.queryAllByRole("status", { name: "加载中" })).toHaveLength(0), { timeout: 3000 });
    expect(document.body.textContent).not.toContain("加载失败");
  });

// R47 + audit batch 2: mail, domains, retention and sign-in policies are the
// owner's; another admin sees them read-only under the owner-only note.
for (const id of ["mail", "domains", "login", "retention"])
  test(`${id} is read-only for an admin who is not the owner`, async () => {
    mount(`/settings/${id}`, false);
    await screen.findByText("仅所有者可修改");
    await waitFor(() => expect(screen.queryAllByRole("status", { name: "加载中" })).toHaveLength(0), { timeout: 3000 });
    const frozen = document.querySelector("fieldset[disabled]");
    expect(frozen).not.toBeNull();
    // Every switch of the section sits inside the disabled fieldset.
    for (const sw of screen.queryAllByRole("switch")) expect(sw.closest("fieldset[disabled]")).not.toBeNull();
  });

test("overview", async () => {
  mount("/settings");
  const strip = await screen.findByRole("region", { name: "需要注意" });
  expect(strip.textContent).toContain("个已废弃的键");
  // Summaries are real values once their queries land.
  await screen.findByText("Asia/Shanghai");
});

test("overview: one request seeds every section", async () => {
  mount("/settings");
  await screen.findByText("Asia/Shanghai");
  await screen.findByRole("region", { name: "需要注意" });
  const gets = calls.filter((c) => c.method === "GET").map((c) => c.path);
  expect(gets).toContain("/settings/overview");
  for (const p of ["/settings", "/settings/signup", "/settings/mail", "/settings/mail-templates", "/block-rules"])
    expect(gets).not.toContain(p);
});

test("edit, bar, save", async () => {
  mount("/settings/signup");
  fireEvent.click(await screen.findByRole("switch", { name: "邀请码只能使用一次" }));
  fireEvent.click(screen.getByRole("switch", { name: "开放注册" }));
  const bar = await screen.findByRole("region", { name: "保存栏" });
  await waitFor(() => expect(bar.textContent).toContain("2 项未保存的修改"));
  await act(async () => {
    fireEvent.click(within(bar).getByRole("button", { name: "保存" }));
  });
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/settings/signup")).toBe(true));
  const put = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
  // One invite code per user: the old per-user limit is not sent.
  expect(put).not.toHaveProperty("invite_codes_per_user");
  expect(put.invite_single_use).toBe(true);
  expect(put.register_enabled).toBe(true);
});

test("an edit made while a save runs stays in the save bar", async () => {
  // Hold the PUT until the second edit is in.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let sending = false;
  const base = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(init?.method).toUpperCase() === "PUT") {
      sending = true;
      await held;
    }
    return base(url, init);
  });
  mount("/settings/login");
  fireEvent.click(await screen.findByRole("switch", { name: "密码登录后引导绑定通行密钥" }));
  const bar = screen.getByRole("region", { name: "保存栏" });
  await act(async () => {
    fireEvent.click(within(bar).getByRole("button", { name: "保存" }));
  });
  await waitFor(() => expect(sending).toBe(true));
  const min = screen.getByLabelText("最短提交时间（秒，0 = 关闭）");
  fireEvent.change(min, { target: { value: "5" } });
  await act(async () => release());
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  await waitFor(() => expect(screen.getByRole("button", { name: /^保存/ }).getAttribute("aria-busy")).toBeNull());
  // The sent edit left the bar; the one typed meanwhile is still there.
  expect(screen.getByRole("region", { name: "保存栏" }).textContent).toContain("1 项未保存的修改");
  expect((min as HTMLInputElement).value).toBe("5");
  const put = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
  expect(put.passkey_prompt).toBe(false);
  expect(put.min_submit_secs).toBe(2);
});

test("cleanup confirm", async () => {
  mount("/settings/cleanup");
  const sw = await screen.findByRole("switch", { name: "自动清理" });
  fireEvent.click(sw);
  const bar = await screen.findByRole("region", { name: "保存栏" });
  await act(async () => {
    fireEvent.click(within(bar).getByRole("button", { name: "保存" }));
  });
  const dlg = await screen.findByRole("alertdialog");
  await waitFor(() => expect(dlg.textContent).toContain("首次运行将删除约 42 个账户"));
});

test("domains add + save", async () => {
  mount("/settings/domains");
  fireEvent.click(await screen.findByRole("button", { name: "添加订阅域名" }));
  const dlg = await screen.findByRole("dialog", { name: "添加域名" });
  fireEvent.change(within(dlg).getByLabelText(/^域名/), { target: { value: "s.example.org" } });
  fireEvent.click(within(dlg).getByRole("button", { name: "添加" }));
  await screen.findByText("s.example.org");
  await screen.findByText("新添加");
  const bar = await screen.findByRole("region", { name: "保存栏" });
  await act(async () => {
    fireEvent.click(within(bar).getByRole("button", { name: "保存" }));
  });
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/settings")).toBe(true));
});

test("guard on leave", async () => {
  const router = mount("/settings/site");
  const name = await screen.findByLabelText("站点名称");
  fireEvent.change(name, { target: { value: "X" } });
  await screen.findByRole("region", { name: "保存栏" });
  await act(async () => {
    void router.navigate("/settings/domains");
  });
  const dlg = await screen.findByRole("dialog", { name: "有未保存的修改" });
  expect(dlg.textContent).toContain("放弃修改，去「域名与证书」");
  expect(router.state.location.pathname).toBe("/settings/site");
});

test("redirects", async () => {
  const r = mount("/settings/security");
  await waitFor(() => expect(r.state.location.pathname).toBe("/settings/access"));
  cleanup();
  const r3 = mount("/settings/branding");
  await waitFor(() => expect(r3.state.location.pathname).toBe("/settings/brand"));
  cleanup();
  const r4 = mount("/settings?section=notify");
  await waitFor(() => expect(r4.state.location.pathname).toBe("/settings/notices"));
  cleanup();
  const r2 = mount("/settings/mail?outbox=dead");
  await waitFor(() => expect(r2.state.location.pathname + r2.state.location.search).toBe("/status?mail=dead"));
});

test("phone index + section", async () => {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  mount("/settings");
  await screen.findByRole("navigation", { name: "设置分类" });
  cleanup();
  mount("/settings/login");
  await screen.findByRole("link", { name: "返回系统设置" });
  await screen.findByLabelText("最短提交时间（秒，0 = 关闭）");
});

test("block switch + order", async () => {
  mount("/settings/block");
  const sw = await screen.findByRole("switch", { name: "Mine" });
  fireEvent.click(sw);
  fireEvent.click(screen.getByRole("button", { name: "上移 Mine" }));
  const bar = await screen.findByRole("region", { name: "保存栏" });
  expect(bar.textContent).toContain("2 项未保存的修改");
  await act(async () => {
    fireEvent.click(within(bar).getByRole("button", { name: "保存" }));
  });
  await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").length).toBe(2));
  expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.path, c.body])).toEqual([
    ["/block-rules/2", { enabled: true, sort: 10 }],
    ["/block-rules/1", { sort: 20 }],
  ]);
});

test("alerts save", async () => {
  mount("/settings/alerts");
  const cpu = await screen.findByLabelText("CPU 超过 %");
  fireEvent.change(cpu, { target: { value: "95" } });
  const bar = await screen.findByRole("region", { name: "保存栏" });
  await act(async () => {
    fireEvent.click(within(bar).getByRole("button", { name: "保存" }));
  });
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/alerts/settings")).toBe(true));
  const b = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
  expect(b.cpu_percent).toBe(95);
  expect(b.mem_percent).toBe(null);
  expect(b.offline_secs).toBe(120);
});

test("timezone picker", async () => {
  mount("/settings/site");
  fireEvent.click(await screen.findByRole("button", { name: "站点时区" }));
  fireEvent.change(await screen.findByLabelText("搜索时区"), { target: { value: "Tokyo" } });
  fireEvent.click(await screen.findByRole("option", { name: "Asia/Tokyo" }));
  const bar = await screen.findByRole("region", { name: "保存栏" });
  await act(async () => {
    fireEvent.click(within(bar).getByRole("button", { name: "保存" }));
  });
  const dlg = await screen.findByRole("alertdialog");
  expect(dlg.textContent).toContain("之后的日界按新时区计算");
});

test("payments edit + mail save", async () => {
  mount("/settings/payments");
  fireEvent.click(await screen.findByRole("button", { name: "编辑 Alipay" }));
  await screen.findByRole("dialog", { name: "编辑 Alipay" });
  cleanup();
  mount("/settings/mail");
  const port = await screen.findByLabelText("端口");
  fireEvent.change(port, { target: { value: "587" } });
  const bar = await screen.findByRole("region", { name: "保存栏" });
  await act(async () => {
    fireEvent.click(within(bar).getByRole("button", { name: "保存" }));
  });
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/settings/mail")).toBe(true));
  const b = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
  expect(b.port).toBe(587);
  expect(b.notify_expiry_days).toBe(3);
  expect("password" in b).toBe(false);
});

test("routing: add by typing, a service with a pinned line, the test box, one save", async () => {
  mount("/settings/routing");
  const add = await screen.findByRole("combobox", { name: "添加到「拦截」" });
  fireEvent.change(add, { target: { value: "www.example.org" } });
  const list = await screen.findByRole("listbox", { name: "建议" });
  expect(within(list).getAllByRole("option")[0].textContent).toContain("example.org 及子域名");
  fireEvent.keyDown(add, { key: "ArrowDown" });
  fireEvent.keyDown(add, { key: "ArrowUp" });
  fireEvent.keyDown(add, { key: "Enter" });
  const blocked = screen.getByRole("region", { name: "拦截" });
  await within(blocked).findByText("example.org 及子域名");
  // A common service from the catalog, its primary line picked.
  fireEvent.click(await screen.findByRole("button", { name: "🎬 Netflix" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "Netflix 的首选线路" }), { target: { value: "e:e1" } });
  // The test box follows the draft.
  fireEvent.change(screen.getByRole("textbox", { name: "测试网址" }), { target: { value: "a.example.org" } });
  await waitFor(() => expect(screen.getByTestId("routing-test-result").textContent).toContain("拦截"));
  const bar = await screen.findByRole("region", { name: "保存栏" });
  await waitFor(() => expect(bar.textContent).toContain("2 项未保存的修改"));
  await act(async () => {
    fireEvent.click(within(bar).getByRole("button", { name: "保存" }));
  });
  await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/settings/subscription")).toBe(true));
  const b = calls.find((c) => c.method === "PUT")!.body as { routing: { block: unknown[]; services: unknown[] } };
  expect(b.routing.block).toEqual([{ type: "domain_suffix", value: "example.org" }]);
  expect(b.routing.services).toEqual([
    {
      key: "netflix",
      name: "Netflix",
      emoji: "🎬",
      items: [{ type: "category", value: "netflix" }],
      primary: "e1",
      backups: [],
    },
  ]);
  expect("rule_set_clash_url" in b).toBe(false);
});
