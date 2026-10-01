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

function fill(login: string, password: string, code = "") {
  fireEvent.change(screen.getByLabelText(/Account|账号/), { target: { value: login } });
  fireEvent.change(screen.getByLabelText(/^(Password|密码)$/), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/Authentication code|验证码/), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: /Sign in|登录/ }));
}

describe("Login", () => {
  it("posts to /{prefix}/auth/login, the code only when given (trimmed)", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url);
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Response(JSON.stringify({ stage: "full" }), { status: 200 });
      }),
    );
    renderWithClient(<Login />);
    fill("alice", "pw-123456");
    await waitFor(() => expect(bodies).toHaveLength(1));
    fill("alice", "pw-123456", " 123456 ");
    await waitFor(() => expect(bodies.length).toBeGreaterThanOrEqual(2));
    expect(urls[0]).toMatch(/\/auth\/login$/);
    expect(urls[0]).not.toContain("/api/v1");
    expect(bodies[0]).toEqual({ login: "alice", password: "pw-123456" });
    expect(bodies.find((b) => (b as { code?: string }).code)).toEqual({
      login: "alice",
      password: "pw-123456",
      code: "123456",
    });
  });

  it("shows one uniform, localized message for every credential failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );
    act(() => setLocale("zh"));
    renderWithClient(<Login />);
    fill("alice", "wrong");
    expect((await screen.findByRole("alert")).textContent).toBe("账号、密码或验证码错误");
  });

  it("explains rate limiting and network failures", async () => {
    let mode: "429" | "net" = "429";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (mode === "net") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ error: "too many requests" }), { status: 429 });
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
    expect((await screen.findByRole("alert")).textContent).toBe("Enter your account and password.");
    expect(calls).toHaveLength(0);
  });

  it("switches language on the login page", () => {
    renderWithClient(<Login />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "中文" }));
    expect(screen.getByRole("heading", { name: "登录" })).toBeTruthy();
  });
});
