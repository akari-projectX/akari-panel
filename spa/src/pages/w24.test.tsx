// W24 / R40: the registration proof of work, registration without email
// verification, the 系统设置 → 支付 methods tab, and the checkout method
// picker.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../i18n";
import type { AuthOptions, Me } from "../lib/api";
import type { MyOrder, Offer, Shop } from "../lib/billing";
import { leadingZeroBits, sha256Ascii, solvePow } from "../lib/pow";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { configBody, PaymentSettings, type PaymentsList } from "./admin-payments";
import { ShopView } from "./purchase";
import { Register } from "./register";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => setLocale("en"));
});

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("proof of work", () => {
  it("hashes like SHA-256 and finds a nonce", async () => {
    expect(hex(sha256Ascii("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(sha256Ascii(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    // Two blocks (≥ 56 bytes) as real challenges are.
    const long = "v1.1800000000.0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef:12345";
    const want = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(long)));
    expect(hex(sha256Ascii(long))).toBe(hex(want));
    expect(leadingZeroBits(new Uint8Array([0, 0, 0x10]))).toBe(19);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    const n = await solvePow("challenge", 10, 500);
    expect(leadingZeroBits(sha256Ascii(`challenge:${n}`))).toBeGreaterThanOrEqual(10);
  });
});

const opts = (over: Partial<AuthOptions> = {}): AuthOptions => ({
  register: true,
  invite_required: false,
  email_domains: [],
  reset: false,
  email_verify: false,
  ...over,
});

describe("Register without email verification", () => {
  it("has no code step and sends a solved challenge", async () => {
    const calls = fakeApi({
      "GET /auth/register/challenge": { challenge: "c1", bits: 6 },
      "POST /auth/register": { id: "u1", login: "a@example.com", role: "user", stage: "full", trial: false },
    });
    renderWithClient(<Register options={opts()} />);
    expect(screen.queryByLabelText("Email code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send code" })).toBeNull();
    expect(screen.getByText(/not verified yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "password1" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/auth/register")).toHaveLength(1));
    const body = calls.find((c) => c.path === "/auth/register")?.body as {
      pow: { challenge: string; nonce: string };
      code?: string;
    };
    expect(body.code).toBeUndefined();
    expect(body.pow.challenge).toBe("c1");
    expect(leadingZeroBits(sha256Ascii(`c1:${body.pow.nonce}`))).toBeGreaterThanOrEqual(6);
  });

  it("maps the generic refusal (zh)", async () => {
    act(() => setLocale("zh"));
    fakeApi({
      "GET /auth/register/challenge": { challenge: "c1", bits: 1 },
      "POST /auth/register": () => ({
        status: 400,
        body: { error: "x", code: "signup.unavailable", params: {} },
      }),
    });
    renderWithClient(<Register options={opts()} />);
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("设置密码"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("再次输入密码"), { target: { value: "password1" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    expect((await screen.findByRole("alert")).textContent).toContain("该邮箱无法注册");
  });
});

const LIST: PaymentsList = {
  kinds: [
    {
      id: "alipay_f2f",
      label: "支付宝当面付",
      schema: [
        {
          name: "environment",
          label: "环境",
          type: "select",
          required: true,
          options: [
            { value: "production", label: "正式" },
            { value: "sandbox", label: "沙箱" },
            { value: "custom", label: "自定义网关" },
          ],
        },
        { name: "gateway_url", label: "网关地址（仅自定义）", type: "text" },
        { name: "app_id", label: "APPID", type: "text", required: true },
        { name: "seller_id", label: "商户 PID（可选，2088…）", type: "text" },
        { name: "app_private_key", label: "应用私钥", type: "key", secret: true, required: true },
        { name: "alipay_public_key", label: "支付宝公钥", type: "key", required: true },
        { name: "order_timeout_minutes", label: "订单有效期（分钟，5–120）", type: "number", default: 15 },
      ],
    },
  ],
  methods: [
    {
      id: "m1",
      kind: "alipay_f2f",
      kind_label: "支付宝当面付",
      display_name: "支付宝",
      icon: null,
      sort: 0,
      enabled: true,
      version: 3,
      config: {
        environment: "sandbox",
        gateway_url: null,
        app_id: "2021",
        seller_id: null,
        order_timeout_minutes: 15,
        alipay_public_key: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
        app_private_key_set: true,
        app_key_fingerprint: "ab".repeat(32),
        app_public_key: "MIIBIjAN",
        alipay_public_key_fingerprint: "cd".repeat(32),
        alipay_public_key_prev_until: null,
      },
      notify_url: "https://panel.example/p/pay/m1/notify",
      active: true,
      warnings: [],
    },
  ],
  warnings: [],
};

describe("系统设置 → 支付", () => {
  it("lists methods, tests, toggles with confirm and edits without resending the key", async () => {
    const calls = fakeApi({
      "GET /settings/payments": LIST,
      "POST /settings/payments/m1/test": {
        ok: true,
        result: "keys_ok",
        message: "连接正常",
        code: "40004",
        sub_code: "ACQ.TRADE_NOT_EXIST",
      },
      "PUT /settings/payments/m1": LIST.methods[0],
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<PaymentSettings />);
    expect(await screen.findByText("支付宝")).toBeTruthy();
    expect(screen.getByText("沙箱")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect((await screen.findByRole("status")).textContent).toContain("连接正常（ACQ.TRADE_NOT_EXIST）");
    fireEvent.click(screen.getByRole("button", { name: "停用" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(confirm).toHaveBeenCalled();
    const put = calls.find((c) => c.method === "PUT")?.body as Record<string, unknown>;
    expect(put.enabled).toBe(false);
    expect(put.version).toBe(3);
    expect(JSON.stringify(put)).not.toContain("app_private_key");
    // Edit: the secret shows as set; the derived app public key and notify URL are shown.
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByText(/已设置（公钥指纹 abababab/)).toBeTruthy();
    expect((screen.getByLabelText("应用公钥（上传到支付宝开放平台）") as HTMLTextAreaElement).value).toBe("MIIBIjAN");
    expect((screen.getByLabelText("异步通知地址") as HTMLInputElement).value).toContain("/pay/m1/notify");
    expect((screen.getByLabelText("应用私钥") as HTMLTextAreaElement).value).toBe("");
  });

  it("builds the config body: numbers, empty secrets omitted", () => {
    const body = configBody(LIST.kinds[0], {
      environment: "custom",
      gateway_url: "http://127.0.0.1:1/g",
      app_id: " 2021 ",
      seller_id: "",
      app_private_key: "",
      alipay_public_key: "PEM",
      order_timeout_minutes: "30",
    });
    expect(body).toEqual({
      environment: "custom",
      gateway_url: "http://127.0.0.1:1/g",
      app_id: "2021",
      seller_id: null,
      alipay_public_key: "PEM",
      order_timeout_minutes: 30,
    });
  });

  it("adds a method of a kind", async () => {
    const calls = fakeApi({
      "GET /settings/payments": { ...LIST, methods: [] },
      "POST /settings/payments": () => ({ status: 201, body: LIST.methods[0] }),
    });
    renderAdmin(<PaymentSettings />);
    fireEvent.change(await screen.findByLabelText("添加支付方式"), { target: { value: "alipay_f2f" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.change(await screen.findByLabelText("APPID"), { target: { value: "2021" } });
    fireEvent.change(screen.getByLabelText("应用私钥"), { target: { value: "PRIV" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const body = calls.find((c) => c.method === "POST")?.body as { kind: string; config: Record<string, unknown> };
    expect(body.kind).toBe("alipay_f2f");
    expect(body.config.app_id).toBe("2021");
    expect(body.config.app_private_key).toBe("PRIV");
    expect(body.config.gateway_url).toBeNull();
  });
});

const ME: Me = {
  id: "u1",
  login: "alice",
  role: "user",
  traffic_used_bytes: 0,
  traffic_limit_bytes: null,
  expires_at: null,
  expired: false,
  quota_exhausted: false,
  banned: false,
  ban_reason: null,
  banned_at: null,
  email: null,
  email_verified: false,
  locale: "en",
  sub_token: null,
  sub_url: null,
  sub_legacy: false,
  probe_interval_secs: 600,
};

const offer: Offer = {
  period: "month",
  days: null,
  price_cents: 990,
  amount_cents: 990,
  discount_cents: 0,
  credit_cents: 0,
  forfeited_cents: 0,
  balance_cents: 0,
  coupon_refusal: null,
  action: "new",
  refusal: null,
};

const shop: Shop = {
  enabled: true,
  methods: [
    { id: "a", kind: "alipay_f2f", display_name: "Alipay A", icon: null },
    { id: "b", kind: "alipay_f2f", display_name: "Alipay B", icon: null },
  ],
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
      offers: [offer],
    },
  ],
};

const order: MyOrder = {
  id: "o1",
  out_trade_no: "AK1",
  plan_id: "p1",
  plan_name: "Monthly",
  amount_cents: 990,
  period: "month",
  period_days: null,
  list_price_cents: 990,
  credit_cents: 0,
  discount_cents: 0,
  coupon_code: null,
  balance_cents: 0,
  refunded_at: null,
  status: "pending",
  qr_code: null,
  pay_url: "https://pay.example/AK1",
  payment_method_id: "b",
  payment_method_name: "Alipay B",
  created_at: "2026-10-03T00:00:00Z",
  expires_at: "2099-10-03T00:15:00Z",
  paid_at: null,
  fulfilled: false,
};

describe("checkout payment method", () => {
  it("asks for a method when several are enabled and sends it", async () => {
    const calls = fakeApi({
      "GET /me/shop": shop,
      "GET /me/orders": [],
      "POST /me/orders": () => ({ status: 201, body: order }),
      "GET /me/orders/o1": order,
    });
    renderWithClient(<ShopView me={ME} />);
    fireEvent.click(await screen.findByRole("button", { name: "Buy" }));
    const pay = await screen.findByRole("button", { name: "Pay ¥9.90" });
    expect(pay).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText("Alipay B"));
    expect(pay).toHaveProperty("disabled", false);
    fireEvent.click(pay);
    expect(await screen.findByRole("link", { name: "Open the payment page" })).toBeTruthy();
    expect(screen.getByText("Payment method: Alipay B")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && c.path === "/me/orders");
    expect(post?.body).toEqual({ plan_id: "p1", period: "month", method_id: "b" });
  });
});
