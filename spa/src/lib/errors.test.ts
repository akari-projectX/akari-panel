import { describe, expect, it } from "vitest";

import { translate } from "../i18n";
import { ADMIN_CODES, adminErrorText, adminMessageText } from "./admin-errors";
import { ApiError } from "./api";
import { CODE_KEYS, errorText, errorVars } from "./errors";

const zh = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate("zh", k, v);
const en = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate("en", k, v);

describe("errorText (portal)", () => {
  it("maps codes with params in both languages", () => {
    const e = new ApiError(400, "password must be at least 8 characters", { code: "account.password_too_short" });
    expect(errorText(e, zh)).toBe("密码至少需要 8 位");
    expect(errorText(e, en)).toBe("The password must be at least 8 characters");
    const t = new ApiError(400, "subject is longer than 120 characters", {
      code: "ticket.subject_long",
      params: { max_subject: 120 },
    });
    expect(errorText(t, zh)).toBe("标题最多 120 个字符");
    expect(errorText(t, en)).toBe("The subject can be at most 120 characters");
  });
  it("formats fen params as yuan", () => {
    const e = new ApiError(400, "the minimum withdrawal is 1000 fen", {
      code: "withdrawal.below_minimum",
      params: { min_cents: 1000 },
    });
    expect(errorText(e, zh)).toBe("最低提现金额为 10.00 元");
    expect(errorText(e, en)).toBe("The minimum withdrawal is ¥10.00");
    expect(errorVars({ max_price_cents: 12345, n: 3 }, "m")).toEqual({
      message: "m",
      max_price_cents: 12345,
      max_price_yuan: "123.45",
      max_price_cents_yuan: "123.45",
      n: 3,
    });
  });
  it("falls back to statuses, the message and network errors", () => {
    expect(errorText(new ApiError(429, "too many requests"), zh)).toBe("尝试次数过多，请稍后再试");
    expect(errorText(new ApiError(500, "internal error"), zh)).toBe("服务器出错了，请稍后再试");
    expect(errorText(new ApiError(400, "something new", { code: "brand.new_code" }), zh)).toBe(
      "操作失败：something new",
    );
    expect(errorText(new TypeError("Failed to fetch"), zh)).toBe("无法连接服务器，请检查网络后重试");
    // The portal never shows console texts (R23).
    expect(errorText(new ApiError(409, "login already exists", { code: "user.login_exists" }), zh)).toBe(
      "操作失败：login already exists",
    );
  });
});

describe("adminErrorText (console)", () => {
  it("maps console codes in Chinese with params", () => {
    expect(adminErrorText(new ApiError(409, "login already exists", { code: "user.login_exists" }))).toBe(
      "该账号已存在",
    );
    const e = new ApiError(400, "speed_limit_mbps must be 1..=100000", {
      code: "plan.speed_limit_range",
      params: {
        max_speed_mbps: 100000,
      },
    });
    expect(adminErrorText(e)).toBe("限速须为 1–100000 Mbps");
    const p = new ApiError(400, "price_cents must be 1..=100000000", {
      code: "plan.price_range",
      params: {
        max_price_cents: 100000000,
      },
    });
    expect(adminErrorText(p)).toBe("价格须在 0.01–1000000.00 元之间");
  });
  it("uses the portal mapping for shared codes, then statuses", () => {
    expect(adminErrorText(new ApiError(400, "x", { code: "request.no_fields" }))).toBe("没有任何改动");
    expect(adminErrorText(new ApiError(429, "too many requests", { code: "request.rate_limited" }))).toBe(
      "尝试次数过多，请稍后再试",
    );
  });
  it("puts a context in front without doubling the generic prefix", () => {
    expect(adminErrorText(new ApiError(400, "boom"))).toBe("操作失败：boom");
    expect(adminErrorText(new ApiError(400, "boom"), "节点列表加载失败")).toBe("节点列表加载失败：boom");
    expect(adminErrorText(new ApiError(500, "x"), "节点列表加载失败")).toBe(
      "节点列表加载失败：服务器出错了，请稍后再试",
    );
    expect(adminErrorText(new ApiError(409, "login already exists", { code: "user.login_exists" }), "创建失败")).toBe(
      "创建失败：该账号已存在",
    );
  });
  it("translates stored messages without a code", () => {
    expect(adminMessageText("the plan no longer exists")).toBe("套餐已不存在");
    expect(adminMessageText("something else")).toBe("something else");
  });
  it("keeps the two maps apart", () => {
    for (const code of Object.keys(ADMIN_CODES)) expect(CODE_KEYS[code], code).toBeUndefined();
  });
});
