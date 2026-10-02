import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../i18n";
import { fakeApi, renderWithClient } from "../test/harness";
import { Login } from "./login";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => setLocale("en"));
});

function fill(login: string, password: string) {
  fireEvent.change(screen.getByLabelText(/Email or username|邮箱或账号/), { target: { value: login } });
  fireEvent.change(screen.getByLabelText(/^(Password|密码)$/), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /^(Sign in|登录)$/ }));
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("Login", () => {
  it("password first; the code field only after totp_required (W20 two-step)", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        // The page title's site name (W21 useSiteName): not a login request.
        if (url.endsWith("/auth/options")) return json(200, { site_name: "Akari" });
        urls.push(url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        bodies.push(body);
        if (!body?.code) return json(401, { error: "totp required", totp_required: true });
        return body.code === "123456" ? json(200, { stage: "full" }) : json(401, { error: "unauthorized" });
      }),
    );
    renderWithClient(<Login />);
    // No code field up front.
    expect(screen.queryByLabelText("Two-factor code")).toBeNull();
    fill("alice@example.com", "pw-123456");
    const code = await screen.findByLabelText("Two-factor code");
    expect(urls[0]).toMatch(/\/auth\/login$/);
    expect(urls[0]).not.toContain("/api/v1");
    expect(bodies[0]).toEqual({ login: "alice@example.com", password: "pw-123456" });
    expect(screen.getByText(/uses two-factor authentication/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    // An empty code is caught locally.
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter the code.");
    expect(bodies).toHaveLength(1);
    // A wrong code: the password was accepted, so the message is about the code.
    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong or already used code. Enter a new one.");
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: " 123456 " } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]).toEqual({ login: "alice@example.com", password: "pw-123456", code: "123456" });
  });

  it("goes back to the password step", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { error: "totp required", totp_required: true })),
    );
    renderWithClient(<Login />);
    fill("alice", "pw-123456");
    await screen.findByLabelText("Two-factor code");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Email or username")).toBeTruthy();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });

  it("shows one uniform, localized message for a wrong password", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { error: "unauthorized" })),
    );
    act(() => setLocale("zh"));
    renderWithClient(<Login />);
    expect(screen.getByLabelText("邮箱或账号")).toBeTruthy();
    fill("alice", "wrong");
    expect((await screen.findByRole("alert")).textContent).toBe("账号或密码错误");
    expect(screen.queryByLabelText("两步验证码")).toBeNull();
  });

  it("explains rate limiting and network failures", async () => {
    let mode: "429" | "net" = "429";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (mode === "net") throw new TypeError("Failed to fetch");
        return json(429, { error: "too many requests" });
      }),
    );
    renderWithClient(<Login />);
    fill("alice", "pw");
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Please try again later.");
    mode = "net";
    fill("alice", "pw");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Cannot reach the server/));
  });

  it("asks for missing fields without calling the server", async () => {
    const calls = fakeApi({});
    renderWithClient(<Login />);
    fill("", "");
    expect((await screen.findByRole("alert")).textContent).toBe("Enter your email or username and password.");
    expect(calls).toHaveLength(0);
  });

  it("switches language on the login page and sets the title", () => {
    renderWithClient(<Login />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(document.title).toBe("Sign in · Akari");
    fireEvent.click(screen.getByRole("button", { name: "中文" }));
    expect(screen.getByRole("heading", { name: "登录" })).toBeTruthy();
  });
});
