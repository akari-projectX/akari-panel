// W16: coupon + balance on the purchase page, the portal wallet / invite
// cards, and the console's coupons, finance and refund screens.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale, translate } from "../i18n";
import type { Me } from "../lib/api";
import {
  signedYuan,
  type AdminOrder,
  type Coupon,
  type MyBalance,
  type MyInvite,
  type Offer,
  type Shop,
  type Withdrawal,
} from "../lib/billing";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { AdminCoupons } from "./admin-coupons";
import { AdminFinance } from "./admin-finance";
import { AdminOrders } from "./admin-orders";
import { ShopView } from "./purchase";
import { Wallet } from "./wallet";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const offer = (over: Partial<Offer> = {}): Offer => ({
  period: "month",
  days: null,
  price_cents: 1000,
  amount_cents: 1000,
  discount_cents: 0,
  credit_cents: 0,
  forfeited_cents: 0,
  balance_cents: 0,
  coupon_refusal: null,
  action: "new",
  refusal: null,
  ...over,
});

const shop = (over: Partial<Shop> = {}, o: Partial<Offer> = {}): Shop => ({
  enabled: true,
  methods: [{ id: 'm1', kind: 'alipay_f2f', display_name: '支付宝', icon: null }],
  current: null,
  credit_cents: 0,
  balance_cents: 0,
  coupon: null,
  plans: [
    {
      plan_id: "p1",
      name: "Monthly",
      description: "",
      traffic_quota_bytes: null,
      period: "monthly",
      speed_limit_mbps: null,
      device_seats: null,
      current: false,
      remaining: null,
      sold_out: false,
      offers: [offer(o)],
    },
  ],
  ...over,
});

const paidOrder = {
  id: "o1",
  out_trade_no: "AK1",
  plan_id: "p1",
  plan_name: "Monthly",
  amount_cents: 0,
  period: "month",
  period_days: null,
  list_price_cents: 1000,
  credit_cents: 0,
  discount_cents: 200,
  coupon_code: "SAVE20",
  balance_cents: 800,
  refunded_at: null,
  pay_url: null,
  payment_method_id: "m1",
  payment_method_name: "支付宝",
  status: "paid",
  qr_code: null,
  created_at: "2026-10-02T00:00:00Z",
  expires_at: "2026-10-02T00:15:00Z",
  paid_at: "2026-10-02T00:00:00Z",
  fulfilled: true,
};

const me = (over: Partial<Me> = {}): Me => ({ expired: false, quota_exhausted: false, ...over }) as unknown as Me;

describe("purchase with coupon and balance", () => {
  it("prices with the coupon and the balance on the server, sends no amount", async () => {
    setLocale("en");
    const calls = fakeApi({
      "GET /me/shop": shop({ balance_cents: 900, coupon: { code: "SAVE20", refusal: null } }, { discount_cents: 200 }),
      "GET /me/orders": [],
      "GET /me/balance": { balance_cents: 900, withdrawable_cents: 0, entries: [] },
      "POST /me/orders": () => ({ status: 201, body: paidOrder }),
      "GET /me/orders/o1": paidOrder,
    });
    renderWithClient(<ShopView me={me()} />);
    fireEvent.change(await screen.findByLabelText("Coupon code"), { target: { value: " save20 " } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(calls.some((c) => c.search.includes("coupon=save20"))).toBe(true));
    expect(await screen.findByText("Coupon SAVE20 applied")).toBeTruthy();
    expect(screen.getByText("Coupon discount ¥2.00")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Pay with my balance \(¥9.00 available\)/ }));
    await waitFor(() => expect(calls.some((c) => c.search.includes("use_balance=true"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Buy" }));
    const sheet = await screen.findByRole("dialog", { name: "Confirm your order" });
    expect(sheet.textContent).toContain("Coupon−¥2.00");
    fireEvent.click(await screen.findByRole("button", { name: /^(Pay ¥|Confirm$)/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      plan_id: "p1",
      period: "month",
      coupon: "save20",
      use_balance: true,
    });
    expect(await screen.findByText("Balance used ¥8.00")).toBeTruthy();
    expect(screen.getByText(/SAVE20 · Coupon discount ¥2.00/)).toBeTruthy();
  });

  it("shows why a coupon does not apply", async () => {
    setLocale("zh");
    fakeApi({
      "GET /me/shop": shop({ coupon: { code: "OLD", refusal: "expired" } }),
      "GET /me/orders": [],
    });
    renderWithClient(<ShopView me={me()} />);
    expect(await screen.findByText("优惠码已过期")).toBeTruthy();
    cleanup();
    fakeApi({
      "GET /me/shop": shop({ coupon: { code: "A", refusal: null } }, { coupon_refusal: "plan" }),
      "GET /me/orders": [],
    });
    renderWithClient(<ShopView me={me()} />);
    expect(await screen.findByText("该优惠码不适用于此套餐")).toBeTruthy();
    // No balance: no checkbox.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("maps the coupon errors of an order", () => {
    expect(translate("en", "errors.couponUsedUp")).toBe("This coupon has been used up.");
    expect(signedYuan(-990)).toBe("-9.90");
    expect(signedYuan(5)).toBe("+0.05");
  });
});

const balance = (over: Partial<MyBalance> = {}): MyBalance => ({
  balance_cents: 12000,
  withdrawable_cents: 10000,
  entries: [
    {
      id: 2,
      kind: "commission",
      amount_cents: 10000,
      balance_after_cents: 12000,
      order_id: "o9",
      out_trade_no: "AK9",
      commission_id: "c1",
      withdrawal_id: null,
      reason: null,
      created_at: "2026-10-02T00:00:00Z",
    },
    {
      id: 1,
      kind: "admin_adjust",
      amount_cents: 2000,
      balance_after_cents: 2000,
      order_id: null,
      out_trade_no: null,
      commission_id: null,
      withdrawal_id: null,
      reason: "补偿",
      created_at: "2026-10-01T00:00:00Z",
    },
  ],
  ...over,
});

const invite = (over: Partial<MyInvite> = {}): MyInvite => ({
  enabled: true,
  rate_percent: 10,
  first_order_only: true,
  hold_days: 7,
  min_withdrawal_cents: 5000,
  invite_codes: null,
  invited_count: 3,
  pending_cents: 300,
  credited_cents: 10000,
  reversed_cents: 0,
  balance_cents: 12000,
  withdrawable_cents: 10000,
  commissions: [
    {
      id: "c1",
      invitee_login: "bob",
      base_cents: 100000,
      rate_percent: 10,
      amount_cents: 10000,
      status: "credited",
      available_at: "2026-10-01T00:00:00Z",
      credited_at: "2026-10-01T00:00:00Z",
      reversed_at: null,
      created_at: "2026-09-24T00:00:00Z",
    },
  ],
  ...over,
});

const withdrawal = (over: Partial<Withdrawal> = {}): Withdrawal => ({
  id: "w1",
  user_id: "u1",
  user_login: "alice",
  amount_cents: 6000,
  method: "alipay",
  account: "a@b 张三",
  status: "pending",
  payout_reference: null,
  note: null,
  decided_at: null,
  decided_by: null,
  created_at: "2026-10-02T00:00:00Z",
  ...over,
});

// W15's invite codes inside the 我的邀请 card.
const invites = (over: Record<string, unknown> = {}) => ({
  codes: [],
  limit: 5,
  register_enabled: true,
  invite_required: false,
  single_use: false,
  invited: 0,
  link_base: null,
  ...over,
});

describe("portal wallet and invitations", () => {
  it("shows the ledger, requests and cancels a withdrawal", async () => {
    setLocale("en");
    let list: Withdrawal[] = [];
    const calls = fakeApi({
      "GET /me/balance": balance(),
      "GET /me/invite": invite(),
      "GET /me/invite-codes": invites({ register_enabled: false }),
      "GET /me/withdrawals": () => ({ status: 200, body: list }),
      "POST /me/withdrawals": () => {
        list = [withdrawal()];
        return { status: 201, body: { id: "w1" } };
      },
      "POST /me/withdrawals/w1/cancel": () => ({ status: 204 }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithClient(<Wallet me={me()} />);
    expect(await screen.findByText("Balance ¥120.00")).toBeTruthy();
    expect(screen.getByText("Withdrawable ¥100.00")).toBeTruthy();
    expect(screen.getAllByText("Invite commission").length).toBeGreaterThan(0);
    const plus = screen.getByText("+¥100.00");
    expect(plus.className).toContain("text-emerald-700");
    expect(screen.getByText("补偿")).toBeTruthy();
    // Invitations: W15 codes need open registration.
    expect(await screen.findByText("Registration is closed, so invite codes are not available.")).toBeTruthy();
    expect(screen.getByText("3 friends invited")).toBeTruthy();
    expect(screen.getByText(/Only your friend's first paid order counts/)).toBeTruthy();
    // Withdraw: text amount -> integer fen.
    fireEvent.change(screen.getByLabelText("Amount (CNY)"), { target: { value: "60.5x" } });
    fireEvent.change(screen.getByLabelText("Payee account and name"), { target: { value: " a@b 张三 " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(await screen.findByText("Enter a valid amount (at most two decimals).")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Amount (CNY)"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("Payout method"), { target: { value: "wechat" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/me/withdrawals")).toBe(true));
    expect(calls.find((c) => c.path === "/me/withdrawals" && c.method === "POST")?.body).toEqual({
      amount_cents: 6000,
      method: "wechat",
      account: "a@b 张三",
    });
    expect(await screen.findByText("Withdrawal requested; an admin will process it.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    // W20: an in-page confirmation (not window.confirm).
    expect(await screen.findByRole("alertdialog", { name: "Cancel withdrawal request" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/me/withdrawals/w1/cancel")).toBe(true));
  });

  it("restricted accounts see their balance only", async () => {
    setLocale("zh");
    const calls = fakeApi({ "GET /me/balance": balance({ entries: [] }) });
    renderWithClient(<Wallet me={me({ expired: true })} />);
    expect(await screen.findByText("余额 ¥120.00")).toBeTruthy();
    expect(screen.getByText("暂无余额变动。")).toBeTruthy();
    expect(screen.queryByText("我的邀请")).toBeNull();
    expect(calls.some((c) => c.path === "/me/invite" || c.path === "/me/withdrawals")).toBe(false);
  });

  it("explains a disabled programme", async () => {
    setLocale("zh");
    fakeApi({
      "GET /me/balance": balance({ withdrawable_cents: 0 }),
      "GET /me/invite": invite({ enabled: false, invite_codes: ["abcdefgh23"], commissions: [] }),
      "GET /me/invite-codes": invites({ codes: [{ code: "abcdefgh23", uses: 1, created_at: "2026-10-01T00:00:00Z" }] }),
      "GET /me/withdrawals": [withdrawal({ status: "approved", payout_reference: "T1" })],
    });
    renderWithClient(<Wallet me={me()} />);
    expect(await screen.findByText("邀请返利暂未开放。")).toBeTruthy();
    expect(await screen.findByText("abcdefgh23")).toBeTruthy();
    expect(screen.getByText("暂无返利。")).toBeTruthy();
    expect(await screen.findByText("打款凭证：T1")).toBeTruthy();
    // Nothing withdrawable: the form stays, disabled with the reason (W20, audit Minor 2).
    expect(screen.getByText("申请提现")).toBeTruthy();
    expect(screen.getByText("可提现金额 ¥0.00 低于最低提现额 ¥50.00，暂不能申请提现。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "提交申请" }) as HTMLButtonElement).disabled).toBe(true);
    // The first invite code is offered as a link with copy and QR (Minor 6).
    expect((screen.getByLabelText("你的邀请链接") as HTMLInputElement).value).toContain(
      "/app/register?invite=abcdefgh23",
    );
    fireEvent.click(screen.getByRole("button", { name: "显示二维码" }));
    expect(screen.getByRole("img", { name: "邀请链接二维码" })).toBeTruthy();
  });
});

const coupon = (over: Partial<Coupon> = {}): Coupon => ({
  id: "k1",
  code: "SAVE20",
  name: "国庆",
  kind: "percent",
  value: 20,
  plan_ids: ["p1"],
  periods: ["month"],
  min_amount_cents: 1000,
  starts_at: null,
  ends_at: null,
  max_uses: 10,
  per_user_limit: 1,
  new_users_only: true,
  enabled: true,
  used: 2,
  redeemed: 1,
  created_at: "2026-10-02T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  ...over,
});

describe("console: coupons", () => {
  it("lists, creates (fen), toggles, deletes and shows redemptions", async () => {
    const calls = fakeApi({
      "GET /coupons": [
        coupon(),
        coupon({
          id: "k2",
          code: "FIX5",
          kind: "fixed",
          value: 500,
          plan_ids: null,
          periods: null,
          min_amount_cents: 0,
          max_uses: null,
          per_user_limit: null,
          new_users_only: false,
          enabled: false,
        }),
      ],
      "GET /plans": [{ id: "p1", name: "月付套餐" }],
      "POST /coupons": () => ({ status: 201, body: { id: "k3" } }),
      "PATCH /coupons/k1": () => ({ status: 204 }),
      "DELETE /coupons/k2": () => ({
        status: 409,
        body: { error: "the coupon has been used by orders; disable it instead", code: "coupon_admin.in_use" },
      }),
      "GET /coupons/k1": {
        coupon: coupon(),
        redemptions: [
          {
            order_id: "o1",
            out_trade_no: "AK1",
            user_id: "u1",
            user_login: "alice",
            status: "redeemed",
            over_limit: true,
            discount_cents: 200,
            order_status: "paid",
            created_at: "2026-10-02T00:00:00Z",
          },
        ],
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<AdminCoupons />);
    expect(await screen.findByText("SAVE20")).toBeTruthy();
    expect(screen.getByText("减 20%")).toBeTruthy();
    expect(screen.getByText("减 ¥5.00")).toBeTruthy();
    expect(await screen.findByText(/月付套餐 · 月付 · 仅新用户 · 每人 1 次/)).toBeTruthy();
    // Create: fixed yuan -> fen; scope checkboxes.
    fireEvent.change(screen.getByLabelText("优惠码（3–32 位字母、数字、- 或 _）"), { target: { value: "NEW10" } });
    fireEvent.change(screen.getByLabelText("类型"), { target: { value: "fixed" } });
    fireEvent.change(screen.getByLabelText("减免金额（元）"), { target: { value: "10.5" } });
    fireEvent.change(screen.getByLabelText("总次数（空 = 不限）"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "创建优惠券" }));
    expect(await screen.findByText("总次数须为正整数或留空（不限）")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("总次数（空 = 不限）"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "季付" }));
    fireEvent.click(screen.getByRole("button", { name: "创建优惠券" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      code: "NEW10",
      kind: "fixed",
      value: 1050,
      plan_ids: null,
      periods: ["quarter"],
      min_amount_cents: 0,
      max_uses: 100,
      per_user_limit: null,
      new_users_only: false,
    });
    expect(await screen.findByText("已创建优惠码 NEW10")).toBeTruthy();
    // Percent out of range.
    fireEvent.change(screen.getByLabelText("优惠码（3–32 位字母、数字、- 或 _）"), { target: { value: "BAD" } });
    fireEvent.change(screen.getByLabelText("类型"), { target: { value: "percent" } });
    fireEvent.change(screen.getByLabelText("减免百分比"), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "创建优惠券" }));
    expect(await screen.findByText("折扣百分比须为 1–100 的整数")).toBeTruthy();
    // Toggle and delete.
    const row1 = screen.getByText("SAVE20").closest("tr")!;
    fireEvent.click(within(row1 as HTMLElement).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false });
    const row2 = screen.getByText("FIX5").closest("tr")!;
    fireEvent.click(within(row2 as HTMLElement).getByRole("button", { name: "删除" }));
    expect(await screen.findByText("该优惠码已被订单使用，不能删除，请改为停用")).toBeTruthy();
    // Detail.
    fireEvent.click(within(row1 as HTMLElement).getByRole("button", { name: "详情" }));
    expect(await screen.findByText("优惠券详情「SAVE20」")).toBeTruthy();
    expect(screen.getByText("超出次数（迟到付款）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("没有要修改的内容")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("修改总次数（- = 不限）"), { target: { value: "-" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").length).toBe(2));
    expect(calls.filter((c) => c.method === "PATCH")[1].body).toEqual({ max_uses: null });
  });
});

describe("console: finance", () => {
  it("approves with a reference, rejects with a reason, saves settings, adjusts a balance", async () => {
    const calls = fakeApi({
      "GET /withdrawals": [withdrawal()],
      "POST /withdrawals/w1/approve": () => ({ status: 204 }),
      "POST /withdrawals/w1/reject": () => ({ status: 204 }),
      "GET /balances": [{ user_id: "u1", login: "alice", balance_cents: 12000, updated_at: "2026-10-02T00:00:00Z" }],
      "GET /users/u1/balance": {
        user_id: "u1",
        login: "alice",
        balance_cents: 12000,
        withdrawable_cents: 10000,
        entries: [
          {
            ...balance().entries[1],
            user_id: "u1",
            user_login: "alice",
            actor_login: "root",
          },
        ],
      },
      "POST /users/u1/balance": () => ({ status: 200, body: { balance_cents: 11000 } }),
      "GET /commissions": [
        {
          id: "c1",
          order_id: "o1",
          out_trade_no: "AK1",
          inviter_id: "u1",
          inviter_login: "alice",
          invitee_id: "u2",
          invitee_login: "bob",
          base_cents: 1000,
          rate_percent: 10,
          amount_cents: 100,
          status: "reversed",
          available_at: "2026-10-09T00:00:00Z",
          credited_at: null,
          reversed_at: "2026-10-03T00:00:00Z",
          reverse_reason: "order refunded",
          created_at: "2026-10-02T00:00:00Z",
        },
      ],
      "GET /commission-settings": {
        enabled: false,
        rate_percent: 10,
        first_order_only: true,
        hold_days: 7,
        min_withdrawal_cents: 10000,
      },
      "PUT /commission-settings": () => ({ status: 200, body: {} }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<AdminFinance />);
    expect(await screen.findByText("a@b 张三", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "已打款" }));
    expect(await screen.findByText("请先填写打款凭证（交易号等）")).toBeTruthy();
    const ref = screen.getByLabelText("提现 alice 的打款凭证或拒绝原因");
    fireEvent.change(ref, { target: { value: "2026100222001" } });
    fireEvent.click(screen.getByRole("button", { name: "已打款" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/withdrawals/w1/approve")).toBe(true));
    expect(calls.find((c) => c.path === "/withdrawals/w1/approve")?.body).toEqual({
      payout_reference: "2026100222001",
    });
    fireEvent.change(screen.getByLabelText("提现 alice 的打款凭证或拒绝原因"), { target: { value: "账号有误" } });
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/withdrawals/w1/reject")).toBe(true));
    expect(calls.find((c) => c.path === "/withdrawals/w1/reject")?.body).toEqual({ reason: "账号有误" });
    // Commissions.
    expect(await screen.findByText("order refunded")).toBeTruthy();
    // Settings: yuan -> fen.
    await waitFor(() => expect((screen.getByLabelText("最低提现（元）") as HTMLInputElement).value).toBe("100.00"));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用邀请返利" }));
    fireEvent.change(screen.getByLabelText("返利比例（%）"), { target: { value: "101" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByText("返利比例须为 0–100 的整数")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("返利比例（%）"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("最低提现（元）"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      enabled: true,
      rate_percent: 15,
      first_order_only: true,
      hold_days: 7,
      min_withdrawal_cents: 5000,
    });
    // Balance: find, ledger, signed adjustment.
    fireEvent.click(screen.getByRole("button", { name: "明细与调整" }));
    expect(await screen.findByText("alice：余额 ¥120.00，可提现 ¥100.00")).toBeTruthy();
    expect(screen.getByText("root")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("方向"), { target: { value: "-" } });
    fireEvent.change(screen.getByLabelText("调整金额（元）"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "调整余额" }));
    expect(await screen.findByText("请填写原因（写入审计）")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("调整原因（必填）"), { target: { value: "误充" } });
    fireEvent.click(screen.getByRole("button", { name: "调整余额" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/users/u1/balance" && c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.path === "/users/u1/balance" && c.method === "POST")?.body).toEqual({
      amount_cents: -1000,
      reason: "误充",
    });
    expect(await screen.findByText("余额已调整")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("用户名（精确）"), { target: { value: " bob " } });
    fireEvent.click(screen.getByRole("button", { name: "查找" }));
    await waitFor(() => expect(calls.some((c) => c.search === "?login=bob")).toBe(true));
  });
});

const adminOrder = (over: Partial<AdminOrder> = {}): AdminOrder => ({
  id: "o1",
  out_trade_no: "AK1",
  user_id: "u1",
  user_login: "alice",
  plan_id: "p1",
  plan_name: "Monthly",
  amount_cents: 700,
  period: "month",
  period_days: null,
  list_price_cents: 1200,
  credit_cents: 0,
  credit_order_id: null,
  discount_cents: 200,
  coupon_id: "k1",
  coupon_code: "SAVE20",
  balance_cents: 300,
  balance_state: "held",
  refunded_at: null,
  refund_cents: null,
  refund_reason: null,
  status: "paid",
  trade_no: "2026",
  paid_via: "notify",
  paid_amount_cents: 700,
  manual_reason: null,
  fulfilled_at: "2026-10-02T00:01:00Z",
  fulfil_result: null,
  fulfil_error: null,
  created_at: "2026-10-02T00:00:00Z",
  expires_at: "2026-10-02T00:15:00Z",
  paid_at: "2026-10-02T00:01:00Z",
  ended_at: null,
  close_state: null,
  ...over,
});

describe("console: refund", () => {
  it("refunds a paid order with a reason, optionally to the balance", async () => {
    const calls = fakeApi({
      "GET /plan-prices": { payments_enabled: true, plans: [] },
      "GET /orders": [adminOrder()],
      "GET /orders/o1": { order: adminOrder(), events: [] },
      "POST /orders/o1/refund": () => ({ status: 200, body: { refund_cents: 1000 } }),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<AdminOrders />);
    expect(await screen.findByText("（券 SAVE20 ¥2.00）")).toBeTruthy();
    expect(screen.getByText("（余额 ¥3.00）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(await screen.findByText("SAVE20（-¥2.00）")).toBeTruthy();
    expect(screen.getByText("¥3.00（已扣余额）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "退款" }));
    expect(await screen.findByText("请填写退款原因（写入审计）")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("退款原因（必填，写入审计）"), { target: { value: "用户申请" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /支付宝实付 ¥7.00 也退到余额/ }));
    fireEvent.click(screen.getByRole("button", { name: "退款" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/orders/o1/refund")).toBe(true));
    expect(calls.find((c) => c.path === "/orders/o1/refund")?.body).toEqual({ reason: "用户申请", to_balance: true });
    expect(confirm.mock.calls[0][0]).toContain("退回余额 ¥10.00");
  });
});
