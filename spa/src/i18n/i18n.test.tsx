import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "./en";
import { FixedLocale, LocaleSwitch, detectLocale, setLocale, translate, useHtmlLang, useLocale, useT } from "./index";
import { zh } from "./zh";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => setLocale("en"));
  window.localStorage.clear();
});

function keys(o: object, p = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [`${p}${k}`] : keys(v, `${p}${k}.`)));
}

function Probe() {
  const t = useT();
  const locale = useLocale();
  useHtmlLang(locale);
  return <p>{t("login.title")}</p>;
}

describe("i18n", () => {
  it("has the same keys and placeholders in every locale", () => {
    expect(keys(en).sort()).toEqual(keys(zh).sort());
    for (const k of keys(zh)) {
      const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      const [ns, name] = k.split(".") as [keyof typeof zh, string];
      const z = (zh[ns] as Record<string, string>)[name];
      const e = (en[ns] as Record<string, string>)[name];
      expect(vars(e), k).toEqual(vars(z));
    }
  });

  it("detects the browser language", () => {
    expect(detectLocale(["zh-TW", "en"])).toBe("zh");
    expect(detectLocale(["en-GB"])).toBe("en");
    expect(detectLocale(["ja-JP", "zh-CN"])).toBe("zh");
    expect(detectLocale(["ja-JP"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });

  it("interpolates variables and leaves unknown ones", () => {
    expect(translate("en", "portal.expires", { date: "1/2/2027" })).toBe("Expires 1/2/2027");
    expect(translate("zh", "billing.paidWith", { method: "支付宝" })).toBe("支付方式：支付宝");
    expect(translate("en", "portal.expires")).toBe("Expires {date}");
  });

  it("switches, persists the choice and updates <html lang>", () => {
    render(
      <>
        <LocaleSwitch />
        <Probe />
      </>,
    );
    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
    fireEvent.click(screen.getByRole("button", { name: "中文" }));
    expect(screen.getByText("登录")).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(window.localStorage.getItem("akari.locale")).toBe("zh");
    expect(screen.getByRole("button", { name: "中文" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps working when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    render(
      <>
        <LocaleSwitch />
        <Probe />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "中文" }));
    expect(screen.getByText("登录")).toBeTruthy();
  });

  it("FixedLocale pins the admin console to Chinese", () => {
    render(
      <FixedLocale locale="zh">
        <Probe />
      </FixedLocale>,
    );
    expect(screen.getByText("登录")).toBeTruthy();
  });
});
