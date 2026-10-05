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

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText(/^(Email|邮箱)$/), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/^(Password|密码)$/), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /^(Sign in|登录)$/ }));
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("Login", () => {
  it("signs in with the email address and the password (D1); no second step", async () => {
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
        return json(200, { id: "u1", email: "alice@example.com", role: "user" });
      }),
    );
    renderWithClient(<Login />);
    fill(" alice@example.com ", "pw-123456");
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(urls[0]).toMatch(/\/auth\/login$/);
    expect(urls[0]).not.toContain("/api/v1");
    expect(bodies[0]).toEqual({ email: "alice@example.com", password: "pw-123456" });
    expect(screen.queryByLabelText(/code/i)).toBeNull();
  });

  it("shows one uniform, localized message for a wrong password", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { error: "unauthorized" })),
    );
    act(() => setLocale("zh"));
    renderWithClient(<Login />);
    expect(screen.getByLabelText("邮箱")).toBeTruthy();
    fill("alice@example.com", "wrong");
    expect((await screen.findByRole("alert")).textContent).toBe("邮箱或密码错误");
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
    fill("alice@example.com", "pw");
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Please try again later.");
    mode = "net";
    fill("alice@example.com", "pw");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Cannot reach the server/));
  });

  it("asks for missing fields without calling the server", async () => {
    const calls = fakeApi({});
    renderWithClient(<Login />);
    fill("", "");
    expect((await screen.findByRole("alert")).textContent).toBe("Enter your email and password.");
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
