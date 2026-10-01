import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TotpStatus } from "../lib/api";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { TwoFactorCard } from "./two-factor";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const status = (over: Partial<TotpStatus>): TotpStatus => ({
  id: "u1",
  login: "alice",
  role: "user",
  stage: "full",
  enabled: false,
  pending: false,
  recovery_codes_left: 0,
  admin_2fa_required: false,
  ...over,
});

const URI = "otpauth://totp/Akari:alice?secret=JBSWY3DPEHPK3PXP&issuer=Akari";
const CODES = Array.from({ length: 10 }, (_, i) => `aaaa-bbbb-${i}`);

describe("TwoFactorCard", () => {
  it("enrolls: QR code rendered locally, base32 fallback, confirm sends only the code", async () => {
    const calls = fakeApi({
      "GET /me/totp": status({}),
      "POST /me/totp/enroll": {
        secret: "JBSWY3DPEHPK3PXP",
        otpauth_uri: URI,
        digits: 6,
        period: 30,
        algorithm: "SHA1",
      },
      "POST /me/totp/confirm": { recovery_codes: CODES, stage: "full" },
    });
    renderWithClient(<TwoFactorCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on two-factor authentication" }));
    const qr = await screen.findByRole("img", { name: "Two-factor authentication QR code" });
    expect(qr.tagName.toLowerCase()).toBe("svg");
    expect(Number(qr.getAttribute("data-qr-version"))).toBeGreaterThan(0);
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    // No network fetch for the image: only the API calls above.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /me/totp", "POST /me/totp/enroll"]);
    fireEvent.change(screen.getByLabelText("Code from the app"), { target: { value: " 123456 " } });
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    expect(await screen.findByText("aaaa-bbbb-0")).toBeTruthy();
    expect(calls.find((c) => c.path === "/me/totp/confirm")?.body).toEqual({ code: "123456" });
  });

  it("offers the recovery codes as a .txt download and copy", async () => {
    fakeApi({
      "GET /me/totp": status({ enabled: true, recovery_codes_left: 2 }),
      "POST /me/totp/recovery-codes": { recovery_codes: CODES },
    });
    const created: Blob[] = [];
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b), "blob:x"), revokeObjectURL: () => {} }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithClient(<TwoFactorCard />);
    expect(await screen.findByText("On · 2 recovery codes left")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "New recovery codes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download .txt" }));
    expect(click).toHaveBeenCalled();
    const text = await created[0].text();
    expect(text).toContain("alice");
    for (const c of CODES) expect(text).toContain(c);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODES.join("\n")));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("renders in Chinese on the admin console and localizes a wrong code", async () => {
    fakeApi({
      "GET /me/totp": status({ role: "admin", enabled: true, recovery_codes_left: 9 }),
      "POST /me/totp/recovery-codes": () => ({ status: 400, body: { error: "invalid code" } }),
    });
    renderAdmin(<TwoFactorCard />);
    expect(await screen.findByText("已开启 · 剩余 9 个恢复码")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("身份验证器验证码"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "重新生成恢复码" }));
    expect((await screen.findByRole("alert")).textContent).toBe("验证码错误或已使用");
  });
});
