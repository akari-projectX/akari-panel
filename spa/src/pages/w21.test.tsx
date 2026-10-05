import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminConfirmProvider as ConfirmProvider, useAdminConfirm as useConfirm } from "../admin-confirm";
import { RowMenu } from "../components/row-menu";
import { Tabs } from "../components/tabs";
import {
  dateInputValue,
  datetimeInputIso,
  datetimeInputValue,
  endOfDayIso,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtTime,
} from "../lib/datetime";
import { periodKindZh, periodZh, sortPrices } from "../lib/billing";
import { FixedLocale } from "../i18n";
import { fakeApi, renderAdmin } from "../test/harness";
import { ACTION_ZH, AdminAudit, auditDiff } from "./audit";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("datetime (Beijing, 24-hour)", () => {
  it("formats in Asia/Shanghai whatever the browser zone", () => {
    expect(fmtDateTime("2026-10-02T16:30:05Z")).toBe("2026-10-03 00:30");
    expect(fmtDateTime("2026-10-02T16:30:05Z", true)).toBe("2026-10-03 00:30:05");
    expect(fmtDate("2026-10-02T15:59:59Z")).toBe("2026-10-02");
    expect(fmtTime("2026-10-02T05:07:00Z")).toBe("13:07");
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime("garbage")).toBe("—");
  });
  it("reads a picked day as a Beijing day ending 23:59:59", () => {
    expect(endOfDayIso("2026-10-31")).toBe("2026-10-31T15:59:59.000Z");
    expect(endOfDayIso("")).toBeNull();
    expect(endOfDayIso("31/10/2026")).toBeNull();
    expect(dateInputValue("2026-10-31T15:59:59Z")).toBe("2026-10-31");
    expect(dateInputValue("2026-10-31T16:00:00Z")).toBe("2026-11-01");
    expect(datetimeInputIso("2026-10-31T08:00")).toBe("2026-10-31T00:00:00.000Z");
    expect(datetimeInputValue("2026-10-31T00:00:00Z")).toBe("2026-10-31T08:00");
  });
  it("formats durations", () => {
    expect(fmtDuration(90000)).toBe("1 天 1 小时");
    expect(fmtDuration(3700)).toBe("1 小时 1 分");
    expect(fmtDuration(30)).toBe("1 分钟");
    expect(fmtDuration(0)).toBe("已到期");
  });
});

describe("billing labels", () => {
  it("names custom days and sorts prices in catalogue order", () => {
    expect(periodZh("days", null)).toBe("自定义天数");
    expect(periodZh("days", 7)).toBe("7 天");
    expect(periodKindZh("days")).toBe("自定义天数");
    expect(periodKindZh("onetime")).toBe("一次性");
    expect(
      sortPrices([
        { period: "reset", days: null },
        { period: "days", days: 30 },
        { period: "year", days: null },
        { period: "days", days: 7 },
        { period: "month", days: null },
      ]).map((p) => `${p.period}${p.days ?? ""}`),
    ).toEqual(["month", "year", "days7", "days30", "reset"]);
  });
});

function Asker({ onAnswer }: { onAnswer: (ok: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={async () =>
        onAnswer(
          await confirm({ title: "删除节点「x」？", message: "不可恢复。", confirmLabel: "删除", destructive: true }),
        )
      }
    >
      ask
    </button>
  );
}

describe("ConfirmDialog", () => {
  it("asks in a modal dialog in Chinese and resolves with the answer", async () => {
    const answers: boolean[] = [];
    render(
      <FixedLocale locale="zh">
        <ConfirmProvider>
          <Asker onAnswer={(a) => answers.push(a)} />
        </ConfirmProvider>
      </FixedLocale>,
    );
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除节点「x」？" });
    expect(dialog.textContent).toContain("不可恢复。");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(answers).toEqual([false]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(answers).toEqual([false, true]));
    // Escape (the dialog's cancel event) declines.
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    const d = await screen.findByRole("alertdialog");
    act(() => {
      fireEvent.keyDown(d, { key: "Escape" });
    });
    await waitFor(() => expect(answers).toEqual([false, true, false]));
  });

  it("falls back to window.confirm without a provider", async () => {
    const spy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const answers: boolean[] = [];
    render(<Asker onAnswer={(a) => answers.push(a)} />);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    await waitFor(() => expect(answers).toEqual([true]));
    expect(spy).toHaveBeenCalledWith("删除节点「x」？\n\n不可恢复。");
  });
});

describe("RowMenu", () => {
  it("opens with the keyboard, moves with arrows, runs an item and closes on Escape", async () => {
    const picked: string[] = [];
    render(
      <RowMenu
        label="n1 的更多操作"
        items={[
          { label: "配置", onSelect: () => picked.push("配置") },
          { label: "停用", onSelect: () => picked.push("停用"), disabled: true },
          { label: "删除", onSelect: () => picked.push("删除"), destructive: true },
        ]}
      />,
    );
    const button = screen.getByRole("button", { name: "n1 的更多操作" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    expect(document.activeElement?.textContent).toBe("配置");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("删除"); // the disabled item is skipped
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    expect(picked).toEqual(["删除"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Tabs", () => {
  it("is a tablist with one tab stop and arrow-key navigation", () => {
    const changes: string[] = [];
    render(
      <Tabs
        label="分类"
        tabs={[
          { id: "a", label: "甲" },
          { id: "b", label: "乙" },
        ]}
        value="a"
        onChange={(t) => changes.push(t)}
      >
        <p>panel a</p>
      </Tabs>,
    );
    const a = screen.getByRole("tab", { name: "甲" });
    expect(a.getAttribute("aria-selected")).toBe("true");
    expect(a.tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "乙" }).tabIndex).toBe(-1);
    expect(screen.getByRole("tabpanel").textContent).toBe("panel a");
    fireEvent.keyDown(a, { key: "ArrowLeft" });
    expect(changes).toEqual(["b"]);
  });
});

describe("audit view", () => {
  it("diffs fields of an update and lists those of a create", () => {
    expect(
      auditDiff({ role: "user", enabled: true, email: "a@x.cc" }, { role: "admin", enabled: true, email: "a@x.cc" }),
    ).toEqual([{ field: "role", label: "角色", before: "user", after: "admin" }]);
    expect(auditDiff(null, { email: "a@x.cc", password: "changed" })).toEqual([
      { field: "email", label: "邮箱", before: "—", after: "a@x.cc" },
      { field: "password", label: "密码", before: "—", after: "（已更改）" },
    ]);
    expect(auditDiff({ enabled: true }, { enabled: false })[0]).toMatchObject({ before: "是", after: "否" });
    expect(auditDiff(null, null)).toEqual([]);
  });

  it("shows Chinese actions, Beijing times and field changes", async () => {
    fakeApi({
      "GET /audit": {
        entries: [
          {
            id: 7,
            at: "2026-10-02T04:00:00Z",
            actor_id: "a1",
            actor_label: "u-a1a1a1a1",
            actor_email: "root@example.com",
            ip: "203.0.113.9",
            action: "user.update",
            target_type: "user",
            target_id: "u1",
            before: { enabled: true, role: "user" },
            after: { enabled: false, role: "user" },
          },
          {
            id: 6,
            at: "2026-10-02T03:00:00Z",
            actor_id: null,
            actor_label: "system",
            actor_email: null,
            ip: null,
            action: "brand.new_action",
            target_type: null,
            target_id: null,
            before: null,
            after: null,
          },
        ],
        next_before: null,
      },
    });
    renderAdmin(<AdminAudit />);
    expect(await screen.findByText("2026-10-02 12:00:00")).toBeTruthy();
    expect(screen.getByRole("cell", { name: new RegExp(`^${ACTION_ZH["user.update"]}`) })).toBeTruthy();
    expect(screen.getByText("启用")).toBeTruthy();
    expect(screen.getByText("是")).toBeTruthy();
    expect(screen.getByText("否")).toBeTruthy();
    expect(screen.getByText("brand.new_action")).toBeTruthy();
    expect(screen.getByText("用户")).toBeTruthy();
  });
});
