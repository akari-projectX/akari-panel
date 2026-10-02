import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale, translate } from "../i18n";
import { parseYuan, yuan, type AdminOrder, type MyOrder, type Offer, type Shop } from "../lib/billing";
import { parseDescription } from "../components/plan-description";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { AdminOrders } from "./admin-orders";
import { Billing } from "./purchase";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const offer = (over: Partial<Offer> = {}): Offer => ({
  period: "month",
  days: null,
  price_cents: 990,
  amount_cents: 990,
  credit_cents: 0,
  forfeited_cents: 0,
  action: "new",
  refusal: null,
  ...over,
});

const shopPlan = (over: Partial<Shop["plans"][number]> = {}): Shop["plans"][number] => ({
  plan_id: "p1",
  name: "Monthly",
  description: "",
  traffic_quota_bytes: 100 * 1024 ** 3,
  period: "monthly",
  speed_limit_mbps: null,
  device_seats: null,
  current: false,
  remaining: null,
  sold_out: false,
  offers: [offer()],
  ...over,
});

const shop = (over: Partial<Shop> = {}): Shop => ({
  enabled: true,
  current: null,
  credit_cents: 0,
  plans: [shopPlan()],
  ...over,
});

const order = (over: Partial<MyOrder> = {}): MyOrder => ({
  id: "o1",
  out_trade_no: "AK20261002aaaaaaaaaaaaaaaaaaaaaaaa",
  plan_id: "p1",
  plan_name: "Monthly",
  amount_cents: 990,
  period: "month",
  period_days: null,
  list_price_cents: 990,
  credit_cents: 0,
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
  it("lives in the shared dictionaries (namespace billing)", () => {
    expect(translate("en", "billing.periodDays", { days: 30 })).toBe("30 days");
    expect(translate("zh", "billing.periodDays", { days: 30 })).toBe("30 天");
    expect(translate("zh", "billing.toPay", { amount: "9.90" })).toBe("应付 ¥9.90");
  });
});

describe("plan descriptions (Markdown-lite)", () => {
  it("splits paragraphs and bullet lists", () => {
    expect(parseDescription("Fast plan\nfor everyone\n\n- 100 Mbps\n* 5 devices\n• 24/7\n\nEnjoy")).toEqual([
      { kind: "p", lines: ["Fast plan", "for everyone"] },
      { kind: "ul", items: ["100 Mbps", "5 devices", "24/7"] },
      { kind: "p", lines: ["Enjoy"] },
    ]);
    expect(parseDescription("")).toEqual([]);
    expect(parseDescription("\r\n- a\r\n-  \r\n")).toEqual([{ kind: "ul", items: ["a"] }]);
  });

  it("renders markup as text, never as HTML", async () => {
    setLocale("en");
    fakeApi({
      "GET /me/shop": shop({
        plans: [shopPlan({ description: "<img src=x onerror=alert(1)>\n- <b>bold</b>" })],
      }),
      "GET /me/orders": [],
    });
    const { container } = renderWithClient(<Billing />);
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(screen.getByText("<b>bold</b>").tagName).toBe("LI");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("Billing (user)", () => {
  it("buys, shows the QR and flips to paid by polling", async () => {
    setLocale("en");
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
    expect(screen.getByText("To pay: ¥9.90")).toBeTruthy();
    fireEvent.click(buy);
    expect(await screen.findByRole("img", { name: "Alipay payment QR code" })).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && c.path === "/me/orders");
    // The client never sends an amount: plan + period only.
    expect(post?.body).toEqual({ plan_id: "p1", period: "month" });
    await waitFor(() => expect(screen.getByText("Payment received. Your plan is active.")).toBeTruthy(), {
      timeout: 8000,
    });
    expect(screen.queryByRole("img", { name: "Alipay payment QR code" })).toBeNull();
  }, 10_000);

  it("asks before switching plans, shows the credit and speaks Chinese", async () => {
    setLocale("zh");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const calls = fakeApi({
      "GET /me/shop": shop({
        current: { plan_id: "p0", name: "Old", expires_at: "2026-11-01T00:00:00Z" },
        credit_cents: 300,
        plans: [shopPlan({ offers: [offer({ action: "switch", credit_cents: 300, amount_cents: 690 })] })],
      }),
      "GET /me/orders": [],
    });
    renderWithClient(<Billing />);
    fireEvent.click(await screen.findByRole("button", { name: "更换为此套餐" }));
    expect(screen.getByText("应付 ¥6.90")).toBeTruthy();
    expect(screen.getByText("已抵扣当前套餐剩余价值 ¥3.00（原价 ¥9.90）")).toBeTruthy();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("应付 ¥6.90（已抵扣 ¥3.00）"));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("picks a period, warns about forfeited credit and shows sold-out plans", async () => {
    setLocale("en");
    const calls = fakeApi({
      "GET /me/shop": shop({
        plans: [
          shopPlan({
            offers: [
              offer(),
              offer({
                period: "year",
                price_cents: 9900,
                amount_cents: 0,
                credit_cents: 9900,
                forfeited_cents: 100,
                action: "switch",
              }),
              offer({ period: "onetime", days: 7, price_cents: 300, amount_cents: 300 }),
            ],
          }),
          shopPlan({
            plan_id: "p2",
            name: "Full",
            sold_out: true,
            remaining: 0,
            offers: [offer({ action: null, amount_cents: null, refusal: "sold_out" })],
          }),
        ],
      }),
      "GET /me/orders": [],
      "POST /me/orders": () => ({ status: 201, body: order({ status: "paid", qr_code: null, fulfilled: true }) }),
    });
    renderWithClient(<Billing />);
    fireEvent.click(await screen.findByLabelText(/^Yearly/));
    expect(screen.getByText("To pay: ¥0.00")).toBeTruthy();
    expect(screen.getByText(/the extra ¥1.00 is not refunded/)).toBeTruthy();
    expect(screen.getByLabelText(/^One-time \(7 days\)/)).toBeTruthy();
    // The sold-out plan cannot be bought.
    expect(screen.getAllByText("Sold out").length).toBeGreaterThan(0);
    const soldOut = screen.getAllByRole("button", { name: "Sold out" });
    expect((soldOut[0] as HTMLButtonElement).disabled).toBe(true);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch to this plan" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ plan_id: "p1", period: "year" });
    expect(await screen.findByText("Payment received. Your plan is active.")).toBeTruthy();
  });

  it("offers the reset pack to holders with a confirmation", async () => {
    setLocale("en");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    fakeApi({
      "GET /me/shop": shop({
        current: { plan_id: "p1", name: "Monthly", expires_at: "2026-11-01T00:00:00Z" },
        plans: [
          shopPlan({
            current: true,
            offers: [
              offer({ period: "reset", price_cents: 500, amount_cents: 500, action: "reset" }),
              offer({ action: "renew" }),
            ],
          }),
        ],
      }),
      "GET /me/orders": [],
    });
    renderWithClient(<Billing />);
    // The default selection skips the reset pack.
    expect(await screen.findByRole("button", { name: "Renew" })).toBeTruthy();
    expect(screen.getByText("Your plan")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/^Traffic reset pack/));
    fireEvent.click(screen.getByRole("button", { name: "Buy reset pack" }));
    expect(confirm).toHaveBeenCalled();
  });

  it("shows server errors localized (errorText)", async () => {
    setLocale("en");
    fakeApi({
      "GET /me/shop": shop(),
      "GET /me/orders": [],
      "POST /me/orders": () => ({ status: 502, body: { error: "payment gateway unavailable, try again" } }),
    });
    renderWithClient(<Billing />);
    fireEvent.click(await screen.findByRole("button", { name: "Buy" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The payment service is unavailable. Please try again.",
    );
  });

  it("explains when payments are off", async () => {
    setLocale("en");
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
  period: "days",
  period_days: 30,
  list_price_cents: 990,
  credit_cents: 0,
  credit_order_id: null,
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
  it("summarises what is on sale and shows period and credit of orders", async () => {
    fakeApi({
      "GET /plan-prices": {
        payments_enabled: true,
        plans: [
          {
            plan_id: "p1",
            plan_name: "Monthly",
            plan_enabled: true,
            on_sale: true,
            prices: [
              { period: "month", days: null, price_cents: 990 },
              { period: "reset", days: null, price_cents: 300 },
            ],
          },
        ],
      },
      "GET /orders": [adminOrder({ period: "month", period_days: null, credit_cents: 200, amount_cents: 790 })],
    });
    renderAdmin(<AdminOrders />);
    expect(await screen.findByText("：月付 ¥9.90，流量重置包 ¥3.00")).toBeTruthy();
    expect(await screen.findByText("月付")).toBeTruthy();
    expect(screen.getByText("（抵扣 ¥2.00）")).toBeTruthy();
  });

  it("retries fulfilment only with a reason", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const calls = fakeApi({
      "GET /plan-prices": { payments_enabled: true, plans: [] },
      "GET /orders": [adminOrder()],
      "GET /orders/o1": { order: adminOrder(), events: [] },
      "POST /orders/o1/fulfil": { fulfilled: true },
    });
    renderAdmin(<AdminOrders />);
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
