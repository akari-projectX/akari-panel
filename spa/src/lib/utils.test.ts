import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { adminErrorText, errorText } from "./errors";
import { humanBytes } from "./utils";
import { translate } from "../i18n";

describe("humanBytes", () => {
  it("uses binary units labelled as such", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1023)).toBe("1023 B");
    expect(humanBytes(1024)).toBe("1.0 KiB");
    expect(humanBytes(1.5 * 1024 ** 2)).toBe("1.5 MiB");
    expect(humanBytes(100 * 1024 ** 3)).toBe("100.0 GiB");
    expect(humanBytes(2 * 1024 ** 4)).toBe("2.0 TiB");
    expect(humanBytes(Number.NaN)).toBe("-");
  });
});

describe("errorText", () => {
  const zh = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate("zh", k, v);
  it("localizes statuses, known messages and network errors", () => {
    expect(errorText(new ApiError(429, "too many requests"), zh)).toBe("尝试次数过多，请稍后再试");
    expect(errorText(new ApiError(500, "internal error"), zh)).toBe("服务器出错了，请稍后再试");
    expect(errorText(new ApiError(400, "invalid code"), zh)).toBe("验证码错误或已使用");
    expect(errorText(new ApiError(400, "role must be 'user' or 'admin'"), zh)).toBe(
      "操作失败：role must be 'user' or 'admin'",
    );
    expect(errorText(new TypeError("Failed to fetch"), zh)).toBe("无法连接服务器，请检查网络后重试");
  });
  it("maps admin-only messages in the console only (R23: not in the user dictionaries)", () => {
    expect(adminErrorText(new ApiError(409, "login already exists"))).toBe("该账号已存在");
    expect(adminErrorText(new ApiError(409, "cannot remove the last enabled admin"))).toBe(
      "不能移除最后一个启用的管理员",
    );
    expect(adminErrorText(new ApiError(429, "too many requests"))).toBe("尝试次数过多，请稍后再试");
    expect(errorText(new ApiError(409, "login already exists"), zh)).toBe("操作失败：login already exists");
  });
  it("puts a context in front without doubling the generic prefix", () => {
    expect(adminErrorText(new ApiError(400, "boom"))).toBe("操作失败：boom");
    expect(adminErrorText(new ApiError(400, "boom"), "节点列表加载失败")).toBe("节点列表加载失败：boom");
    expect(adminErrorText(new ApiError(500, "x"), "节点列表加载失败")).toBe(
      "节点列表加载失败：服务器出错了，请稍后再试",
    );
    expect(adminErrorText(new ApiError(409, "login already exists"), "创建失败")).toBe("创建失败：该账号已存在");
  });
});
