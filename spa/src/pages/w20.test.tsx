// W20: shared dialogs, the permanent subscription link, money format and
// small portal helpers.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import jsQR from "jsqr";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog, useConfirm } from "../components/confirm-dialog";
import { setLocale, translate } from "../i18n";
import type { Me } from "../lib/api";
import { money, moneyTone, signedMoney } from "../lib/billing";
import { encodeQr } from "../lib/qr";
import { importLinks, withFormat } from "../lib/sub-links";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { daysLeft } from "./dashboard";
import { intervalText } from "./portal-nodes";
import { SubscriptionCard } from "./subscription";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  act(() => setLocale("en"));
});

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const ME: Me = {
  id: "u1",
  role: "user",
  traffic_used_bytes: 0,
  traffic_limit_bytes: null,
  expires_at: null,
  expired: false,
  quota_exhausted: false,
  email: "alice@example.com",
  email_verified: false,
  locale: "en",
  sub_token: TOKEN,
  sub_url: `https://sub.example/p/sub/${TOKEN}`,
  sub_legacy: false,
  probe_interval_secs: 600,
};

describe("ConfirmDialog", () => {
  it("is a labelled modal: focus inside, Escape cancels, Tab stays inside, focus returns", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            outside
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            hide
          </button>
          <ConfirmDialog
            open={open}
            title="Delete it?"
            body="This cannot be undone."
            confirmLabel="Delete"
            destructive
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        </>
      );
    }
    const outside = () => screen.getByRole("button", { name: "outside" });
    renderWithClient(<Harness />);
    outside().focus();
    fireEvent.click(outside());
    const dialog = screen.getByRole("alertdialog", { name: "Delete it?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();
    // The safe choice has focus.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    // Tab from the last button wraps to the first.
    within(dialog).getByRole("button", { name: "Delete" }).focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("button", { name: "Delete" }).className).toContain("bg-destructive");
    fireEvent.click(screen.getByRole("button", { name: "hide", hidden: true }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(outside());
  });

  it("useConfirm resolves with the choice; the console (zh) gets Chinese buttons", async () => {
    const results: boolean[] = [];
    function Harness() {
      const [confirm, element] = useConfirm();
      return (
        <>
          <button type="button" onClick={() => void confirm({ title: "确定删除？" }).then((r) => results.push(r))}>
            ask
          </button>
          {element}
        </>
      );
    }
    renderAdmin(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "确定" }));
    await waitFor(() => expect(results).toEqual([true]));
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(results).toEqual([true, false]));
  });
});

describe("subscription links", () => {
  it("adds an explicit format only when asked", () => {
    const u = `https://s.example/p/sub/${TOKEN}`;
    expect(withFormat(u, "auto")).toBe(u);
    expect(withFormat(u, "clash")).toBe(`${u}?format=clash`);
    expect(withFormat(`${u}?x=1`, "sing-box")).toBe(`${u}?x=1&format=sing-box`);
  });

  it("builds the one-click import links of common clients", () => {
    const u = `https://s.example/p/sub/${TOKEN}`;
    const links = Object.fromEntries(importLinks(u, "Akari").map((l) => [l.id, l.href]));
    expect(links.clash).toBe(`clash://install-config?url=${encodeURIComponent(`${u}?format=clash`)}&name=Akari`);
    expect(links["sing-box"]).toBe(
      `sing-box://import-remote-profile?url=${encodeURIComponent(`${u}?format=sing-box`)}#Akari`,
    );
    const sr = links.shadowrocket;
    expect(sr.startsWith("shadowrocket://add/sub://")).toBe(true);
    const b64 = sr.slice("shadowrocket://add/sub://".length).split("?")[0];
    expect(atob(b64)).toBe(`${u}?format=links`);
    expect(links.stash).toContain("stash://install-config?url=");
    expect(links.hiddify).toBe(`hiddify://import/${u}#Akari`);
  });
});

describe("SubscriptionCard", () => {
  it("shows the link permanently: copy with feedback, QR, formats and import buttons", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderWithClient(<SubscriptionCard me={ME} />);
    const input = screen.getByLabelText("Subscription link") as HTMLInputElement;
    expect(input.value).toBe(ME.sub_url);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ME.sub_url));
    expect((await screen.findByRole("status")).textContent).toBe("Copied to the clipboard");
    // QR of exactly the shown URL (decoded with an independent decoder).
    fireEvent.click(screen.getByRole("button", { name: "Show QR code" }));
    expect(screen.getByRole("img", { name: "Subscription link QR code" })).toBeTruthy();
    const qr = encodeQr(ME.sub_url!);
    const px = 4;
    const dim = (qr.size + 8) * px;
    const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
    for (let y = 0; y < qr.size; y++)
      for (let x = 0; x < qr.size; x++)
        if (qr.modules[y][x])
          for (let dy = 0; dy < px; dy++)
            for (let dx = 0; dx < px; dx++) {
              const i = (((y + 4) * px + dy) * dim + (x + 4) * px + dx) * 4;
              data[i] = data[i + 1] = data[i + 2] = 0;
            }
    expect(jsQR(data, dim, dim)?.data).toBe(ME.sub_url);
    // Format selector changes the shown link.
    fireEvent.click(screen.getByLabelText("Clash / mihomo"));
    expect(input.value).toBe(`${ME.sub_url}?format=clash`);
    // Import buttons.
    expect(screen.getByRole("link", { name: "Clash Verge / mihomo" }).getAttribute("href")).toMatch(
      /^clash:\/\/install-config\?url=/,
    );
    expect(screen.getByRole("link", { name: "Shadowrocket" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "sing-box" })).toBeTruthy();
  });

  it("falls back to this origin when no subscription domain is set, and says when copying fails", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    renderWithClient(<SubscriptionCard me={{ ...ME, sub_url: null }} />);
    expect((screen.getByLabelText("Subscription link") as HTMLInputElement).value).toBe(
      `${location.origin}/sub/${TOKEN}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Could not copy/);
  });

  it("resets only after a confirmation", async () => {
    const calls = fakeApi({ "POST /me/sub-token": { sub_token: "x", sub_url: null } });
    renderWithClient(<SubscriptionCard me={ME} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset subscription link" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Reset the subscription link?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Reset subscription link" }));
    const again = await screen.findByRole("alertdialog");
    fireEvent.click(within(again).getByRole("button", { name: "Reset subscription link" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/me/sub-token")).toBe(true));
    expect(await screen.findByText(/A new subscription link was made/)).toBeTruthy();
  });

  it("explains a legacy link and offers a viewable one (zh)", async () => {
    act(() => setLocale("zh"));
    renderWithClient(<SubscriptionCard me={{ ...ME, sub_token: null, sub_url: null, sub_legacy: true }} />);
    expect(screen.getByText(/仍然有效/)).toBeTruthy();
    expect(screen.queryByLabelText("订阅链接")).toBeNull();
    expect(screen.getByRole("button", { name: "生成可查看的新链接" })).toBeTruthy();
  });
});

describe("helpers", () => {
  it("formats money with the sign before the currency (audit Minor 3)", () => {
    expect(money(5000)).toBe("¥50.00");
    expect(money(-1000)).toBe("−¥10.00");
    expect(signedMoney(5000)).toBe("+¥50.00");
    expect(signedMoney(-1000)).toBe("−¥10.00");
    expect(moneyTone(1)).toBe("text-emerald-700");
    expect(moneyTone(-1)).toBe("text-destructive");
    expect(moneyTone(0)).toBe("");
  });

  it("describes the effective probe interval", () => {
    const en = (k: string, v?: Record<string, string | number>) => translate("en", k as never, v);
    expect(intervalText(en, 600)).toBe("10 min");
    expect(intervalText(en, 18000)).toBe("5 h");
    expect(intervalText(en, 5400)).toBe("1.5 h");
    expect(intervalText(en, 86400 * 2)).toBe("2 days");
  });

  it("counts whole days left", () => {
    const now = Date.parse("2026-10-02T00:00:00Z");
    expect(daysLeft("2026-10-12T00:00:00Z", now)).toBe(10);
    expect(daysLeft("2026-10-02T01:00:00Z", now)).toBe(1);
    expect(daysLeft("2026-10-01T00:00:00Z", now)).toBe(0);
  });
});
