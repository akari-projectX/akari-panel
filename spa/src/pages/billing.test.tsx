import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseYuan, yuan, type AdminOrder, type MyOrder, type Shop } from "../lib/billing";
import { fakeApi, renderWithClient } from "../test/harness";
import { AdminOrders } from "./admin-orders";
import { billing, translate } from "./billing-i18n";
import { Billing } from "./purchase";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const shop = (over: Partial<Shop> = {}): Shop => ({
  enabled: true,
  current: null,
  plans: [
    {
      plan_id: "p1",
      name: "Monthly",
      price_cents: 990,
      period_days: 30,
      traffic_quota_bytes: 100 * 1024 ** 3,
      period: "monthly",
      speed_limit_mbps: null,
      action: "new",
    },
  ],
  ...over,
});

const order = (over: Partial<MyOrder> = {}): MyOrder => ({
  id: "o1",
  out_trade_no: "AK20261002aaaaaaaaaaaaaaaaaaaaaaaa",
  plan_id: "p1",
  plan_name: "Monthly",
  amount_cents: 990,
  period_days: 30,
  status: "pending",
  qr_code: "https://qr.alipay.com/bax00000000000000000000",
  created_at: "2026-10-02T00:00:00Z",
  expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  paid_at: null,
  fulfilled: false,
  ...over,
});

describe("money formatting", () => {
  it("is integer cents both ways", () => {
    expect(yuan(990)).toBe("9.90");
    expect(yuan(1)).toBe("0.01");
    expect(yuan(100000)).toBe("1000.00");
    expect(parseYuan("9.9")).toBe(990);
    expect(parseYuan("0.01")).toBe(1);
    expect(parseYuan("10")).toBe(1000);
    expect(parseYuan("0.29")).toBe(29);
    for (const bad of ["", "0", "0.00", "-1", "1.234", "1e3", "abc", "1,00"]) {
      expect(parseYuan(bad)).toBeNull();
    }
  });
});

describe("billing i18n", () => {
  it("has the same keys in every locale", () => {
    expect(Object.keys(billing.zh).sort()).toEqual(Object.keys(billing.en).sort());
    expect(translate("en", "perPeriod", { price: "9.90", days: 30 })).toBe("¥9.90 / 30 days");
    expect(translate("zh", "perPeriod", { price: "9.90", days: 30 })).toBe("¥9.90 / 30 天");
  });
});

describe("Billing (user)", () => {
  it("buys, shows the QR and flips to paid by polling", async () => {
    localStorage.setItem("akari.locale", "en");
    let polls = 0;
    const calls = fakeApi({
      "GET /me/shop": shop(),
      "GET /me/orders": [],
      "POST /me/orders": () => ({ status: 201, body: order() }),
      "GET /me/orders/o1": () => {
        polls += 1;
        return {
          status: 200,
          body: polls < 2 ? order() : order({ status: "paid", qr_code: null, fulfilled: true }),
        };
      },
    });
    renderWithClient(<Billing />);
    const buy = await screen.findByRole("button", { name: "Buy" });
    expect(screen.getByText("¥9.90 / 30 days")).toBeTruthy();
    fireEvent.click(buy);
    expect(await screen.findByRole("img", { name: "Alipay payment QR code" })).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && c.path === "/me/orders");
    // The client never sends an amount.
    expect(post?.body).toEqual({ plan_id: "p1" });
    await waitFor(() => expect(screen.getByText("Payment received. Your plan is active.")).toBeTruthy(), {
      timeout: 8000,
    });
    expect(screen.queryByRole("img", { name: "Alipay payment QR code" })).toBeNull();
  }, 10_000);

  it("asks before replacing the current plan and speaks Chinese", async () => {
    localStorage.setItem("akari.locale", "zh");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const calls = fakeApi({
      "GET /me/shop": shop({
        current: { plan_id: "p0", name: "Old", expires_at: "2026-11-01T00:00:00Z" },
        plans: [{ ...shop().plans[0], action: "replace" }],
      }),
      "GET /me/orders": [],
    });
    renderWithClient(<Billing />);
    fireEvent.click(await screen.findByRole("button", { name: "更换为此套餐" }));
    expect(confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains when payments are off", async () => {
    localStorage.setItem("akari.locale", "en");
    fakeApi({ "GET /me/shop": shop({ enabled: false, plans: [] }), "GET /me/orders": [] });
    renderWithClient(<Billing />);
    expect(await screen.findByText(/Online purchase is not available/)).toBeTruthy();
  });
});

const adminOrder = (over: Partial<AdminOrder> = {}): AdminOrder => ({
  id: "o1",
  out_trade_no: "AK1",
  user_id: "u1",
  user_login: "alice",
  plan_id: "p1",
  plan_name: "Monthly",
  amount_cents: 990,
  period_days: 30,
  status: "paid",
  trade_no: "2026",
  paid_via: "notify",
  paid_amount_cents: 990,
  manual_reason: null,
  fulfilled_at: null,
  fulfil_result: null,
  fulfil_error: "plan is disabled (not offered)",
  created_at: "2026-10-02T00:00:00Z",
  expires_at: "2026-10-02T00:15:00Z",
  paid_at: "2026-10-02T00:01:00Z",
  ended_at: null,
  close_state: null,
  ...over,
});

describe("AdminOrders", () => {
  it("saves prices as integer cents", async () => {
    const calls = fakeApi({
      "GET /plan-prices": {
        payments_enabled: true,
        prices: [
          {
            plan_id: "p1",
            plan_name: "Monthly",
            plan_enabled: true,
            price_cents: null,
            period_days: null,
            purchasable: false,
            updated_at: null,
          },
        ],
      },
      "GET /orders": [],
      "PUT /plans/p1/price": { status: 204 },
    });
    renderWithClient(<AdminOrders />);
    fireEvent.change(await screen.findByLabelText("Monthly 价格"), { target: { value: "0.29" } });
    fireEvent.click(screen.getByLabelText("Monthly 上架"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ price_cents: 29, period_days: 30, purchasable: true });
  });

  it("retries fulfilment only with a reason", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const calls = fakeApi({
      "GET /plan-prices": { payments_enabled: true, prices: [] },
      "GET /orders": [adminOrder()],
      "GET /orders/o1": { order: adminOrder(), events: [] },
      "POST /orders/o1/fulfil": { fulfilled: true },
    });
    renderWithClient(<AdminOrders />);
    expect(await screen.findByText("未开通")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const retry = await screen.findByRole("button", { name: "重试开通" });
    fireEvent.click(retry);
    expect(await screen.findByText("请填写原因（写入审计）")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(screen.getByLabelText("原因（必填，写入审计）"), { target: { value: "plan re-enabled" } });
    fireEvent.click(retry);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ reason: "plan re-enabled" });
  });
});
