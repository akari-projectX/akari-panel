// W15: registration, password reset, email and invite cards (user bundle,
// zh/en) and the admin 注册/邮件 cards (Chinese).
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicPages } from "../app";
import { setLocale } from "../i18n";
import type { AuthOptions, Me } from "../lib/api";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { MailSettings, parseDomains, type SignupView, type SmtpView } from "./admin-mail-settings";
import { Login } from "./login";
import { EmailCard, InviteCodes, inviteLink } from "./portal-account";
import { Register, inviteFromLocation } from "./register";
import { ForgotPassword, ResetPassword, tokenFromHash } from "./reset";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  act(() => setLocale("en"));
});

const opts = (over: Partial<AuthOptions> = {}): AuthOptions => ({
  register: true,
  invite_required: false,
  email_domains: [],
  reset: true,
  ...over,
});

const me = (over: Partial<Me> = {}): Me => ({
  id: "u1",
  login: "alice@example.com",
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
  probe_interval_secs: 18000,
  ...over,
});

describe("login page links", () => {
  it("offers sign-up / forgot password only when enabled", () => {
    const { unmount } = renderWithClient(<Login options={opts({ register: false, reset: false })} />);
    expect(screen.queryByText("Sign up")).toBeNull();
    expect(screen.queryByText("Forgot password?")).toBeNull();
    unmount();
    renderWithClient(<Login options={opts()} />);
    expect(screen.getByText("Sign up").getAttribute("href")).toBe("/app/register");
    expect(screen.getByText("Forgot password?").getAttribute("href")).toBe("/app/forgot");
  });

  it("routes the public pages by path and falls back to sign-in when disabled", async () => {
    fakeApi({ "GET /auth/options": opts({ register: false }) });
    history.replaceState(null, "", "/app/register");
    renderWithClient(<PublicPages />);
    // Registration is off: the sign-in page, not the form.
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    cleanup();
    fakeApi({ "GET /auth/options": opts() });
    renderWithClient(<PublicPages />);
    expect(await screen.findByRole("heading", { name: "Sign up" })).toBeTruthy();
  });
});

describe("Register", () => {
  it("sends the code, then registers with locale and the invite of the link", async () => {
    history.replaceState(null, "", "/app/register?invite=Abcdefgh");
    expect(inviteFromLocation()).toBe("Abcdefgh");
    const calls = fakeApi({
      "POST /auth/register/code": { ok: true },
      "POST /auth/register": { id: "u1", login: "a@example.com", role: "user", stage: "full", trial: false },
    });
    renderWithClient(<Register options={opts({ invite_required: true, email_domains: ["example.com"] })} />);
    expect(screen.getByText("Accepted addresses: example.com")).toBeTruthy();
    expect((screen.getByLabelText("Invite code") as HTMLInputElement).value).toBe("Abcdefgh");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " a@example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/If this address can sign up/);
    expect(screen.getByRole("button", { name: /Send again in/ })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Email code"), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "password1" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/auth/register")).toHaveLength(1));
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/auth/register/code", { email: "a@example.com", locale: "en", invite_code: "Abcdefgh" }],
      [
        "POST",
        "/auth/register",
        { email: "a@example.com", code: "123456", password: "password1", locale: "en", invite_code: "Abcdefgh" },
      ],
    ]);
  });

  it("validates locally and maps server errors (zh)", async () => {
    act(() => setLocale("zh"));
    fakeApi({
      "POST /auth/register": () => ({
        status: 400,
        body: { error: "invalid or expired code", code: "signup.invalid_code" },
      }),
    });
    renderWithClient(<Register options={opts()} />);
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    expect((await screen.findByRole("alert")).textContent).toBe("请先填写邮箱");
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("邮箱验证码"), { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    expect((await screen.findByRole("alert")).textContent).toBe("请填写邮件中的 6 位验证码");
    fireEvent.change(screen.getByLabelText("邮箱验证码"), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText("设置密码"), { target: { value: "password1" } });
    fireEvent.change(screen.getByLabelText("再次输入密码"), { target: { value: "password2" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    expect((await screen.findByRole("alert")).textContent).toBe("两次输入的密码不一致");
    fireEvent.change(screen.getByLabelText("再次输入密码"), { target: { value: "password1" } });
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("验证码错误或已过期，请重新获取"));
  });
});

describe("password reset", () => {
  it("forgot: one generic answer", async () => {
    const calls = fakeApi({ "POST /auth/password-reset/request": { ok: true } });
    renderWithClient(<ForgotPassword />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "x@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/If this address belongs to an account/);
    expect(calls[0].body).toEqual({ email: "x@example.com" });
  });

  it("reset: reads the fragment token, drops it from the URL, posts it", async () => {
    const token = "A".repeat(43);
    history.replaceState(null, "", `/app/reset#token=${token}`);
    expect(tokenFromHash()).toBe(token);
    const calls = fakeApi({ "POST /auth/password-reset": { ok: true } });
    renderWithClient(<ResetPassword />);
    await waitFor(() => expect(location.hash).toBe(""));
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new password" } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: "new password" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/has been reset/);
    expect(calls[0].body).toEqual({ token, password: "new password" });
  });

  it("reset: a link without a token says so; server errors are mapped", async () => {
    renderWithClient(<ResetPassword />);
    expect(screen.getByRole("alert").textContent).toMatch(/incomplete/);
    cleanup();
    history.replaceState(null, "", `/app/reset#token=${"B".repeat(43)}`);
    fakeApi({
      "POST /auth/password-reset": () => ({
        status: 400,
        body: { error: "invalid or expired link", code: "signup.invalid_link" },
      }),
    });
    renderWithClient(<ResetPassword />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new password" } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: "new password" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/invalid or has expired/);
  });
});

describe("portal cards", () => {
  it("email: password + address → code → verify", async () => {
    const calls = fakeApi({
      "POST /me/email/code": { ok: true },
      "POST /me/email/verify": { email: "new@example.com", email_verified: true },
    });
    renderWithClient(<EmailCard me={me({ email: "old@example.com", email_verified: true })} />);
    expect(screen.getByText("old@example.com · verified")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/new@example.com/);
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Your email is now new@example.com.")).toBeTruthy();
    expect(calls.map((c) => c.body)).toEqual([{ email: "new@example.com", password: "pw" }, { code: "654321" }]);
  });

  it("invite codes: a note while registration is closed; lists, links, creates", async () => {
    fakeApi({
      "GET /me/invite-codes": {
        codes: [],
        limit: 5,
        register_enabled: false,
        invite_required: false,
        single_use: false,
        invited: 0,
        link_base: null,
      },
    });
    renderWithClient(<InviteCodes />);
    expect(await screen.findByText(/Registration is closed/)).toBeTruthy();
    cleanup();
    let codes = [{ code: "abcdefgh23", uses: 2, created_at: "2026-10-01T00:00:00Z" }];
    const calls = fakeApi({
      "GET /me/invite-codes": () => ({
        status: 200,
        body: {
          codes,
          limit: 2,
          register_enabled: true,
          invite_required: true,
          single_use: true,
          invited: 2,
          link_base: "https://p.example/x/app/register?invite=",
        },
      }),
      "POST /me/invite-codes": () => {
        codes = [...codes, { code: "zzzzzzzz22", uses: 0, created_at: "2026-10-02T00:00:00Z" }];
        return { status: 201, body: { code: "zzzzzzzz22" } };
      },
    });
    renderWithClient(<InviteCodes />);
    expect(await screen.findByText("abcdefgh23")).toBeTruthy();
    expect(screen.getByText(/Each invite code works once/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New invite code" }));
    expect(await screen.findByText("zzzzzzzz22")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New invite code" })).toHaveProperty("disabled", true),
    );
    expect(calls.some((c) => c.method === "POST")).toBe(true);
    expect(inviteLink("ab cd", "https://p.example/x/app/register?invite=")).toBe(
      "https://p.example/x/app/register?invite=ab%20cd",
    );
    expect(inviteLink("abc", null)).toBe(`${location.origin}/app/register?invite=abc`);
  });
});

const signupView = (over: Partial<SignupView> = {}): SignupView => ({
  version: 3,
  email_verify: null,
  email_verify_effective: true,
  register_enabled: false,
  invite_required: false,
  invite_single_use: false,
  invite_codes_per_user: 5,
  email_domains: [],
  trial_plan_id: null,
  trial_days: 3,
  reset_enabled: false,
  mail_enabled: true,
  public_origin: "https://p.example",
  warnings: [],
  ...over,
});

const smtpView = (over: Partial<SmtpView> = {}): SmtpView => ({
  version: 7,
  enabled: true,
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "mailer",
  password_set: true,
  from_addr: "noreply@example.com",
  from_name: "Akari",
  notify_order_paid: true,
  notify_expiry_days: 3,
  notify_expired: true,
  notify_quota: true,
  dead_letters: 1,
  pending: 0,
  warnings: [],
  ...over,
});

describe("admin 注册 / 邮件", () => {
  it("parses domain lists", () => {
    expect(parseDomains(" a.com\n@b.com, c.com，d.com ")).toEqual(["a.com", "@b.com", "c.com", "d.com"]);
    expect(parseDomains("  ")).toEqual([]);
  });

  it("saves both cards; the password is sent only when typed", async () => {
    const calls = fakeApi({
      "GET /settings/signup": signupView({ warnings: ["邮件发送未启用：验证码与重置链接无法送达"] }),
      "GET /settings/mail": smtpView(),
      "GET /plans": [{ id: "p1", name: "试用", enabled: true }],
      "PUT /settings/signup": (b: unknown) => ({ status: 200, body: { ...signupView(), ...(b as object) } }),
      "PUT /settings/mail": (b: unknown) => ({
        status: 200,
        body: { ...smtpView(), ...(b as object), version: ((b as { version: number }).version ?? 0) + 1 },
      }),
      "POST /settings/mail/test": () => ({ status: 502, body: { error: "send failed: 535 auth failed" } }),
      "GET /mail/outbox": [
        {
          id: 9,
          kind: "order_paid",
          to_addr: "u@example.com",
          subject: "s",
          status: "dead",
          attempts: 8,
          last_error: "421 later",
          created_at: "2026-10-01T00:00:00Z",
          next_attempt_at: "2026-10-01T00:00:00Z",
          settled_at: "2026-10-01T01:00:00Z",
          retryable: true,
        },
      ],
      "POST /mail/outbox/9/retry": () => ({ status: 204 }),
    });
    renderAdmin(<MailSettings />);
    expect(await screen.findByText("邮件发送未启用：验证码与重置链接无法送达")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("开放注册"));
    fireEvent.change(screen.getByLabelText("邮箱域名白名单"), { target: { value: "gmail.com\nqq.com" } });
    await screen.findByRole("option", { name: "试用" });
    fireEvent.change(screen.getByLabelText("试用套餐"), { target: { value: "p1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存注册设置" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/settings/signup")).toBe(true));
    expect(calls.find((c) => c.path === "/settings/signup" && c.method === "PUT")?.body).toEqual({
      version: 3,
      register_enabled: true,
      invite_required: false,
      invite_single_use: false,
      invite_codes_per_user: 5,
      email_domains: ["gmail.com", "qq.com"],
      trial_plan_id: "p1",
      trial_days: 3,
      reset_enabled: false,
      email_verify: null,
    });

    expect((screen.getByLabelText("密码") as HTMLInputElement).placeholder).toBe("已保存，留空不修改");
    fireEvent.click(screen.getByRole("button", { name: "保存邮件设置" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/settings/mail")).toBe(true));
    const first = calls.filter((c) => c.path === "/settings/mail" && c.method === "PUT")[0].body as Record<
      string,
      unknown
    >;
    expect("password" in first).toBe(false);
    expect(first.version).toBe(7);
    // The form remounts on the new version; the success note survives it.
    expect(await screen.findAllByText("已保存。")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存邮件设置" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/settings/mail" && c.method === "PUT")).toHaveLength(2));
    expect(
      (calls.filter((c) => c.path === "/settings/mail" && c.method === "PUT")[1].body as { password: string }).password,
    ).toBe("new-secret");

    // Plain text + credentials is refused locally.
    fireEvent.change(screen.getByLabelText("加密方式"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "保存邮件设置" }));
    expect((await screen.findByText(/未加密连接不能使用用户名和密码/)).textContent).toBeTruthy();

    // Test mail: the server's answer is shown.
    fireEvent.change(screen.getByLabelText("发送测试邮件（使用已保存的设置）"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送测试邮件" }));
    expect(await screen.findByText(/535 auth failed/)).toBeTruthy();

    // Dead letters: list and retry.
    fireEvent.click(screen.getByRole("button", { name: "查看失败邮件" }));
    expect(await screen.findByText("支付回执")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/mail/outbox/9/retry")).toBe(true));
  });
});
