import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentUpdateStatus } from "../lib/api";
import { fakeApi, renderAdmin } from "../test/harness";
import { lastCheckText, UpdateAvailableBadge, UpdateCheck } from "./admin-update-check";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const status = (over: Partial<AgentUpdateStatus> = {}): AgentUpdateStatus => ({
  version: 3,
  source_url: null,
  default_source_url: "https://api.github.com/repos/akari-projectX/akari-agent/releases/latest",
  auto_check: false,
  next_auto_check_at: null,
  checking: false,
  keys_configured: true,
  last_check: null,
  latest: null,
  outdated_nodes: 0,
  update_available: null,
  ...over,
});

describe("UpdateCheck", () => {
  it("starts a check, polls while it runs and shows what was stored", async () => {
    let checking = false;
    const calls = fakeApi({
      "GET /agent-updates": () =>
        checking
          ? { status: 200, body: status({ checking: true }) }
          : {
              status: 200,
              body: status({
                last_check: {
                  at: "2026-10-03T02:00:00Z",
                  ok: true,
                  result: "stored",
                  version: "v0.5.0",
                  code: null,
                  params: null,
                  message: null,
                  stored: ["linux/amd64", "linux/arm64"],
                },
                latest: { version: "v0.5.0", platforms: ["linux/amd64", "linux/arm64"] },
                outdated_nodes: 2,
                update_available: "v0.5.0",
              }),
            },
      "POST /agent-updates/check": () => {
        checking = true;
        setTimeout(() => (checking = false), 50);
        return { status: 202, body: status({ checking: true }) };
      },
    });
    renderAdmin(<UpdateCheck />);
    // Nothing checked yet.
    expect(await screen.findByRole("button", { name: "检查更新" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByRole("button", { name: "检查中…" })).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST" && c.path === "/agent-updates/check")).toHaveLength(1);
    expect(
      await screen.findByText(/已保存 v0\.5\.0（linux\/amd64、linux\/arm64）/, {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.getByText("有新版本 v0.5.0（2 个节点可更新）")).toBeTruthy();
  });

  it("explains a failed check with the coded Chinese message", async () => {
    fakeApi({
      "GET /agent-updates": status({
        last_check: {
          at: "2026-10-03T02:00:00Z",
          ok: false,
          result: "failed",
          version: null,
          code: "agent_update.downgrade",
          params: { latest: "v0.4.0", have: "v0.5.0" },
          message: "refusing",
          stored: [],
        },
      }),
    });
    renderAdmin(<UpdateCheck />);
    expect(
      await screen.findByText(/检查失败：发布源的最新版本 v0\.4\.0 低于面板已有的 v0\.5\.0，拒绝降级/),
    ).toBeTruthy();
  });

  it("shows why a check cannot run (no release keys, already running)", async () => {
    fakeApi({
      "GET /agent-updates": status({ keys_configured: false }),
    });
    renderAdmin(<UpdateCheck />);
    const button = await screen.findByRole("button", { name: "检查更新" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/没有可用的发布公钥/)).toBeTruthy();
    cleanup();
    fakeApi({
      "GET /agent-updates": status(),
      "POST /agent-updates/check": () => ({
        status: 409,
        body: { error: "running", code: "agent_update.check_running", params: {} },
      }),
    });
    renderAdmin(<UpdateCheck />);
    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect((await screen.findByRole("alert")).textContent).toBe("检查更新：已有更新检查在进行中，请稍候");
  });

  it("saves the source (blank = official) and the auto check", async () => {
    const calls = fakeApi({
      "GET /agent-updates": status({ source_url: "https://mirror.example/latest" }),
      "PUT /agent-updates/settings": (body: unknown) => ({
        status: 200,
        body: status({ version: 4, auto_check: (body as { auto_check: boolean }).auto_check }),
      }),
    });
    renderAdmin(<UpdateCheck />);
    const input = await screen.findByLabelText("发布源（GitHub 最新发布 API）");
    expect((input as HTMLInputElement).value).toBe("https://mirror.example/latest");
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.click(screen.getByLabelText("自动检查（每 6 小时）"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("已保存")).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      version: 3,
      source_url: null,
      auto_check: true,
    });
  });
});

describe("UpdateAvailableBadge", () => {
  it("links to the updates view only when nodes run an older version", async () => {
    fakeApi({ "GET /agent-updates": status({ update_available: "v0.5.0", outdated_nodes: 3 }) });
    renderAdmin(<UpdateAvailableBadge />);
    const badge = await screen.findByText("有新版本 v0.5.0");
    const link = badge.closest("a");
    expect(link?.getAttribute("href")).toMatch(/\/admin\/updates$/);
    expect(link?.getAttribute("title")).toBe("3 个节点运行的版本低于 v0.5.0");
    cleanup();
    const calls = fakeApi({ "GET /agent-updates": status() });
    renderAdmin(<UpdateAvailableBadge />);
    await waitFor(() => expect(calls.some((c) => c.path === "/agent-updates")).toBe(true));
    expect(screen.queryByText(/有新版本/)).toBeNull();
  });
});

describe("lastCheckText", () => {
  it("is null before the first check and says up to date", () => {
    expect(lastCheckText(status())).toBeNull();
    const s = status({
      last_check: {
        at: "2026-10-03T02:00:00Z",
        ok: true,
        result: "up_to_date",
        version: "v0.5.0",
        code: null,
        params: null,
        message: null,
        stored: [],
      },
    });
    expect(lastCheckText(s)).toBe("2026-10-03 10:00 检查：已是最新（v0.5.0）");
  });
});
