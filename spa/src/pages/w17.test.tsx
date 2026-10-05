// W17: portal tickets (zh/en), the console's ticket desk and alert center,
// the per-node alert rule card, and the node list reading the summary view.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../i18n";
import type { MyTicketRow, MyTicketView, NodeView } from "../lib/api";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { nodeRoutes } from "../test/nodes";
import {
  AdminAlerts,
  AlertSettingsCard,
  NodeAlertRulesCard,
  numOrNull,
  randomSecret,
  toBody,
  type AlertList,
  type AlertSettings,
  type NodeAlertRules,
} from "./admin-alerts";
import { AdminNodes, leaseLeft } from "./admin-nodes";
import { AdminTickets, type AdminTicketList, type AdminTicketView } from "./admin-tickets";
import { Tickets } from "./tickets";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.pushState(null, "", "/");
});

const row = (over: Partial<MyTicketRow> = {}): MyTicketRow => ({
  id: "t1",
  subject: "连不上香港节点",
  category: "technical",
  priority: "high",
  status: "answered",
  messages: 2,
  created_at: "2026-10-02T00:00:00Z",
  updated_at: "2026-10-02T01:00:00Z",
  unread: true,
  ...over,
});

const thread = (over: Partial<MyTicketView> = {}): MyTicketView => ({
  id: "t1",
  subject: "连不上香港节点",
  category: "technical",
  priority: "high",
  status: "answered",
  order_id: null,
  order_no: null,
  node_id: null,
  node_name: null,
  created_at: "2026-10-02T00:00:00Z",
  updated_at: "2026-10-02T01:00:00Z",
  closed_at: null,
  closed_by: null,
  messages: [
    { id: 1, staff: false, body: "节点连不上\n第二行", created_at: "2026-10-02T00:00:00Z" },
    { id: 2, staff: true, body: "请重启客户端", created_at: "2026-10-02T01:00:00Z" },
  ],
  ...over,
});

describe("portal tickets", () => {
  it("lists tickets with an unread marker, in English too", async () => {
    setLocale("en");
    fakeApi({ "GET /me/tickets": [row()] });
    renderWithClient(<Tickets />);
    expect(await screen.findByText("连不上香港节点")).toBeTruthy();
    expect(screen.getByText("New reply")).toBeTruthy();
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.getByText("Connection & technical")).toBeTruthy();
    setLocale("zh");
  });

  it("creates a ticket with the chosen fields (order optional), then shows it", async () => {
    setLocale("zh");
    const calls = fakeApi({
      "GET /me/tickets": [],
      "GET /me/orders": [{ id: "o1", out_trade_no: "AK20261002x", plan_name: "月付" }],
      "POST /me/tickets": () => ({ status: 201, body: { id: "t1" } }),
      "GET /me/tickets/t1": thread({ status: "open", messages: [thread().messages[0]] }),
    });
    renderWithClient(<Tickets />);
    fireEvent.click(await screen.findByRole("button", { name: "新建工单" }));
    fireEvent.click(screen.getByRole("button", { name: "提交工单" }));
    expect((await screen.findByRole("alert")).textContent).toBe("请填写标题和问题描述");
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: " 连不上 " } });
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "billing" } });
    fireEvent.change(screen.getByLabelText("优先级"), { target: { value: "urgent" } });
    fireEvent.change(screen.getByLabelText("问题描述"), { target: { value: "付款后没开通" } });
    expect(screen.getByText("还可输入 4994 字")).toBeTruthy();
    await screen.findByRole("option", { name: /AK20261002x/ });
    fireEvent.change(screen.getByLabelText("相关订单（可选）"), { target: { value: "o1" } });
    fireEvent.click(screen.getByRole("button", { name: "提交工单" }));
    await screen.findByText("工单已提交，请留意回复。");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      subject: "连不上",
      category: "billing",
      priority: "urgent",
      message: "付款后没开通",
      order_id: "o1",
    });
    expect(await screen.findByText(/节点连不上/)).toBeTruthy();
  });

  it("shows the thread (support without a login), replies and closes", async () => {
    setLocale("zh");
    let closed = false;
    const calls = fakeApi({
      "GET /me/tickets": [row()],
      "GET /me/tickets/t1": () => ({
        status: 200,
        body: closed ? thread({ status: "closed", closed_by: "user", closed_at: "2026-10-02T02:00:00Z" }) : thread(),
      }),
      "POST /me/tickets/t1/replies": () => ({ status: 201, body: { message_id: 3 } }),
      "POST /me/tickets/t1/close": () => {
        closed = true;
        return { status: 204 };
      },
    });
    renderWithClient(<Tickets />);
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    const list = await screen.findByRole("list", { name: "连不上香港节点" });
    expect(within(list).getByText("客服")).toBeTruthy();
    expect(within(list).getByText("我")).toBeTruthy();
    expect(list.textContent).not.toContain("admin");
    fireEvent.change(screen.getByLabelText("回复"), { target: { value: "还是不行" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/me/tickets/t1/replies")).toBe(true));
    expect(calls.find((c) => c.path === "/me/tickets/t1/replies")?.body).toEqual({ message: "还是不行" });
    fireEvent.click(screen.getByRole("button", { name: "关闭工单" }));
    // W20: an in-page confirmation dialog instead of window.confirm.
    const dialog = await screen.findByRole("alertdialog", { name: "关闭工单" });
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭工单" }));
    expect(await screen.findByText("工单已关闭。如有新问题请新建工单。")).toBeTruthy();
    expect(screen.queryByLabelText("回复")).toBeNull();
  });

  it("maps a closed-ticket refusal", async () => {
    setLocale("en");
    fakeApi({
      "GET /me/tickets": [row()],
      "GET /me/tickets/t1": thread(),
      "POST /me/tickets/t1/replies": () => ({
        status: 409,
        body: { error: "ticket is closed", code: "ticket.closed" },
      }),
    });
    renderWithClient(<Tickets />);
    fireEvent.click(await screen.findByRole("button", { name: "View" }));
    fireEvent.change(await screen.findByLabelText("Reply"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The ticket is closed");
    setLocale("zh");
  });
});

const adminRow = {
  id: "t1",
  user_id: "u1",
  user_email: "alice@example.com",
  subject: "连不上香港节点",
  category: "technical" as const,
  priority: "urgent" as const,
  status: "open" as const,
  messages: 1,
  order_id: null,
  order_no: null,
  node_id: null,
  node_name: null,
  assignee_id: null,
  assignee_email: null,
  created_at: "2026-10-02T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  closed_at: null,
  closed_by: null,
  unread: true,
};

describe("console tickets", () => {
  it("filters the queue and opens a ticket by deep link", async () => {
    const list: AdminTicketList = { tickets: [adminRow], total: 1, page: 1, per_page: 50, open: 1, unread: 1 };
    const calls = fakeApi({ "GET /tickets": list });
    window.history.pushState(null, "", "/admin/tickets");
    renderAdmin(<AdminTickets />);
    expect(await screen.findByRole("heading", { name: "工单管理" })).toBeTruthy();
    expect(await screen.findByText("待回复 1 个，未读 1 个。", { exact: false })).toBeTruthy();
    expect(screen.getByText("未读")).toBeTruthy();
    expect(calls[0].search).toBe("?status=active&page=1");
    fireEvent.change(screen.getByLabelText("负责人"), { target: { value: "me" } });
    fireEvent.click(screen.getByLabelText("只看未读"));
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "香港" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.search === `?status=active&assignee=me&unread=true&q=${encodeURIComponent("香港")}&page=1`),
      ).toBe(true),
    );
    fireEvent.click(await screen.findByRole("button", { name: "处理" }));
    expect(location.pathname).toBe("/admin/tickets/t1");
  });

  it("replies (and closes), assigns, reopens", async () => {
    let status: "open" | "closed" = "open";
    const view = (): AdminTicketView => ({
      ...adminRow,
      status,
      closed_at: status === "closed" ? "2026-10-02T02:00:00Z" : null,
      closed_by: status === "closed" ? "staff" : null,
      user_enabled: true,
      thread: [
        {
          id: 1,
          staff: false,
          author_label: "u-12345678",
          author_email: "alice@example.com",
          body: "节点连不上",
          created_at: "2026-10-02T00:00:00Z",
        },
      ],
    });
    const calls = fakeApi({
      "GET /tickets/t1": () => ({ status: 200, body: view() }),
      "GET /admins": [{ id: "a1", email: "root@example.com" }],
      "POST /tickets/t1/replies": (b: unknown) => {
        if ((b as { close: boolean }).close) status = "closed";
        return { status: 201, body: { message_id: 2 } };
      },
      "PUT /tickets/t1/assignee": () => ({ status: 204 }),
      "POST /tickets/t1/reopen": () => {
        status = "open";
        return { status: 204 };
      },
    });
    window.history.pushState(null, "", "/admin/tickets/t1");
    renderAdmin(<AdminTickets />);
    expect(await screen.findByRole("heading", { name: "连不上香港节点" })).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    await screen.findByRole("option", { name: "root@example.com" });
    fireEvent.change(screen.getByLabelText("负责人"), { target: { value: "a1" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ assignee_id: "a1" }));
    fireEvent.change(screen.getByLabelText("回复"), { target: { value: "已修复" } });
    fireEvent.click(screen.getByRole("button", { name: "回复并关闭" }));
    await screen.findByRole("button", { name: "重新打开" });
    expect(calls.find((c) => c.path === "/tickets/t1/replies")?.body).toEqual({ message: "已修复", close: true });
    fireEvent.click(screen.getByRole("button", { name: "重新打开" }));
    await screen.findByRole("button", { name: "关闭工单" });
  });
});

const settings = (over: Partial<AlertSettings> = {}): AlertSettings => ({
  version: 3,
  enabled: true,
  offline_secs: 300,
  cpu_percent: 90,
  cpu_minutes: 5,
  mem_percent: 90,
  mem_minutes: 5,
  disk_percent: 90,
  cert_days: 14,
  latency_failures: true,
  last_error: true,
  cooldown_minutes: 30,
  notify_resolved: true,
  telegram_enabled: false,
  telegram_chat_id: null,
  telegram_token_set: true,
  telegram_api_url: null,
  telegram_api_default: "https://api.telegram.org",
  webhook_enabled: false,
  webhook_url: null,
  webhook_secret_set: false,
  email_enabled: false,
  email_to: [],
  email_available: false,
  eval_interval_secs: 30,
  ...over,
});

describe("console alert center", () => {
  it("helpers", () => {
    expect(numOrNull("")).toBeNull();
    expect(numOrNull(" 42 ")).toBe(42);
    expect(numOrNull("4.2")).toBe("bad");
    expect(randomSecret()).toMatch(/^[0-9a-f]{32}$/);
    expect(leaseLeft(null)).toBeNull();
    expect(leaseLeft("2026-10-02T01:00:00Z", Date.parse("2026-10-02T00:00:00Z"))).toBe(3600);
  });

  it("lists alerts, acks one, saves settings (secrets only when entered) and tests a channel", async () => {
    const alerts: AlertList = {
      alerts: [
        {
          id: 9,
          node_id: "n1",
          node_name: "香港 01",
          kind: "offline",
          status: "firing",
          fired_at: "2026-10-02T00:00:00Z",
          resolved_at: null,
          value: "离线 6 分钟",
          detail: "超过 5 分钟未收到 agent 的连接",
          notified: true,
          acked_at: null,
          acked_by: null,
        },
      ],
      firing: 1,
      firing_by_kind: { offline: 1 },
    };
    const calls = fakeApi({
      "GET /alerts": alerts,
      "POST /alerts/9/ack": () => ({ status: 204 }),
      "GET /alerts/settings": settings(),
      "PUT /alerts/settings": (b: unknown) => ({ status: 200, body: { ...settings(), ...(b as object), version: 4 } }),
      "POST /alerts/test": { ok: false, error: "telegram: HTTP 401 Unauthorized" },
      "GET /alerts/notifications": [
        {
          id: 1,
          alert_id: 9,
          channel: "webhook",
          event: "firing",
          status: "dead",
          attempts: 8,
          last_error: "webhook: HTTP 500",
          created_at: "2026-10-02T00:00:00Z",
          sent_at: null,
          next_attempt_at: "2026-10-02T00:00:00Z",
          title: "[告警] 香港 01：节点离线",
        },
      ],
      "POST /alerts/notifications/1/retry": () => ({ status: 204 }),
    });
    renderAdmin(
      <>
        <AdminAlerts />
        <AlertSettingsCard />
      </>,
    );
    expect(await screen.findByRole("heading", { name: "告警中心" })).toBeTruthy();
    // W21: the settings live in 系统设置 → 告警; the center links there.
    expect(screen.getByRole("link", { name: "系统设置 → 告警" }).getAttribute("href")).toBe("/admin/settings/alerts");
    expect(await screen.findByText("1 条告警正在触发。")).toBeTruthy();
    expect(screen.getByText("离线 6 分钟")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/alerts/9/ack")).toBe(true));

    // Settings: empty threshold = off; the token is kept unless entered.
    const cpu = await screen.findByLabelText("CPU 高于（%）");
    fireEvent.change(cpu, { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("通过 Telegram 通知"));
    fireEvent.change(screen.getByLabelText("Chat ID"), { target: { value: "-100123" } });
    // W25: the Bot API origin (was panel.toml [alerts] telegram_api_url).
    expect(screen.getByLabelText("Telegram API 地址").getAttribute("placeholder")).toBe(
      "留空 = https://api.telegram.org",
    );
    fireEvent.change(screen.getByLabelText("Telegram API 地址"), { target: { value: " https://tg.example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "随机生成" }));
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://hooks.example.com/a" } });
    fireEvent.click(screen.getByRole("button", { name: "保存告警设置" }));
    await screen.findByText("已保存。");
    const body = calls.find((c) => c.method === "PUT")?.body as Record<string, unknown>;
    expect(body.version).toBe(3);
    expect(body.cpu_percent).toBeNull();
    expect(body.telegram_enabled).toBe(true);
    expect(body.telegram_chat_id).toBe("-100123");
    expect(body.telegram_api_url).toBe("https://tg.example.com");
    expect("telegram_token" in body).toBe(false);
    expect(body.webhook_secret).toMatch(/^[0-9a-f]{32}$/);
    expect(body.email_to).toEqual([]);

    fireEvent.click(screen.getAllByRole("button", { name: "发送测试" })[0]);
    expect((await screen.findByText(/Telegram 测试失败/)).textContent).toContain("HTTP 401");

    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/alerts/notifications/1/retry")).toBe(true));
  });

  it("refuses a non-integer threshold before saving", () => {
    const form = {
      enabled: true,
      offline_secs: "abc",
      cpu_percent: "",
      cpu_minutes: "5",
      mem_percent: "",
      mem_minutes: "5",
      disk_percent: "",
      cert_days: "",
      latency_failures: true,
      last_error: true,
      cooldown_minutes: "30",
      notify_resolved: true,
      telegram_enabled: false,
      telegram_chat_id: "",
      telegram_token: "",
      telegram_clear: true,
      telegram_api_url: "",
      webhook_enabled: false,
      webhook_url: "",
      webhook_secret: "",
      email_enabled: false,
      email_to: "a@example.com，b@example.com",
    };
    expect(toBody(form, 1)).toBe("离线判定必须是整数（留空表示关闭）");
    const ok = toBody({ ...form, offline_secs: "60" }, 1) as Record<string, unknown>;
    expect(ok.telegram_token).toBeNull();
    expect(ok.telegram_api_url).toBeNull();
    expect(ok.email_to).toEqual(["a@example.com", "b@example.com"]);
    expect(toBody({ ...form, offline_secs: "60", cpu_minutes: "" }, 1)).toBe("CPU 持续分钟必须是整数");
  });

  it("node rule card saves overrides, disabled kinds and mute", async () => {
    const rules: NodeAlertRules = {
      muted: false,
      disabled: [],
      offline_secs: null,
      cpu_percent: null,
      cpu_minutes: null,
      mem_percent: null,
      mem_minutes: null,
      disk_percent: null,
      cert_days: null,
    };
    const calls = fakeApi({ "GET /nodes/n1/alert-rules": rules, "PUT /nodes/n1/alert-rules": rules });
    renderAdmin(<NodeAlertRulesCard nodeId="n1" />);
    fireEvent.click(await screen.findByLabelText("静音此节点"));
    fireEvent.change(screen.getByLabelText("离线超过（秒）"), { target: { value: "600" } });
    fireEvent.click(screen.getByLabelText("CPU 过高"));
    fireEvent.click(screen.getByRole("button", { name: "保存告警规则" }));
    await screen.findByText("已保存。");
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      ...rules,
      muted: true,
      disabled: ["cpu"],
      offline_secs: 600,
    });
  });
});

describe("node list (summary view)", () => {
  it("reads ?view=summary and links firing alerts", async () => {
    const full = {
      id: "n1",
      name: "hk-1",
      enabled: true,
      status: "online",
      online: true,
      latency: [],
      heartbeat: null,
      warnings: [],
      tags: [],
      visible: true,
      traffic_rate: 1,
      enrolled: true,
      display_name: null,
      lease_expires_at: null,
    } as unknown as NodeView;
    const routes = nodeRoutes([full]);
    (routes["GET /nodes"] as { alerts_firing: number }[])[0].alerts_firing = 2;
    const calls = fakeApi(routes);
    renderAdmin(<AdminNodes />);
    expect(await screen.findByText("2 条告警")).toBeTruthy();
    expect(calls.find((c) => c.path === "/nodes")?.search).toBe("?view=summary");
    fireEvent.click(screen.getByText("2 条告警"));
    expect(location.pathname).toBe("/admin/alerts");
  });
});
