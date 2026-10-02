// W22: traffic history — portal card (zh/en), admin user/node views, helpers.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { barBox } from "../components/bar-chart";
import { setLocale } from "../i18n";
import { fillDays, lastDays, utcToday } from "../lib/traffic";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { NodeTraffic, UserTraffic } from "./admin-traffic";
import { TrafficCard } from "./portal-traffic";

const GIB = 1024 ** 3;
const b = (up: number, down: number, billed: number) => ({ up_bytes: up, down_bytes: down, billed_bytes: billed });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale("zh");
});

describe("helpers", () => {
  it("lastDays / utcToday / fillDays use UTC days and fill gaps with zeros", () => {
    const now = new Date("2026-03-02T23:30:00Z");
    expect(utcToday(now)).toBe("2026-03-02");
    expect(lastDays(7, now)).toEqual({ from: "2026-02-24", to: "2026-03-02" });
    const filled = fillDays([{ day: "2026-02-28", ...b(1, 2, 3) }], "2026-02-27", "2026-03-01");
    expect(filled.map((d) => d.day)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(filled[1]).toEqual({ day: "2026-02-28", ...b(1, 2, 3) });
    expect(filled[0]).toEqual({ day: "2026-02-27", ...b(0, 0, 0) });
    expect(fillDays([], "2026-01-01", "2030-01-01")).toHaveLength(400);
    expect(fillDays([], "2026-01-02", "2026-01-01")).toHaveLength(0);
  });

  it("bar geometry stays inside the chart", () => {
    const first = barBox(0, 30);
    const last = barBox(29, 30);
    expect(first.x).toBeGreaterThan(0);
    expect(last.x + last.w).toBeLessThanOrEqual(600);
    expect(barBox(0, 1000).w).toBeGreaterThanOrEqual(1);
  });
});

function myTraffic(from: string, to: string) {
  return {
    from,
    to,
    timezone: "UTC",
    daily_since: null,
    total: b(3 * GIB, 6 * GIB, 4 * GIB),
    days: [{ day: to, ...b(3 * GIB, 6 * GIB, 4 * GIB) }],
    nodes: [
      { name: "香港 01", ...b(2 * GIB, 4 * GIB, 3 * GIB) },
      { name: null, ...b(GIB, 2 * GIB, GIB) },
    ],
  };
}

describe("portal 流量明细", () => {
  it("shows totals, the daily chart and per-node rows; switching the range refetches", async () => {
    const { from, to } = lastDays(30);
    const calls = fakeApi({ "GET /me/traffic": myTraffic(from, to) });
    renderWithClient(<TrafficCard />);
    expect(await screen.findByRole("heading", { name: "流量记录" })).toBeTruthy();
    expect(await screen.findByText("香港 01")).toBeTruthy();
    expect(screen.getByText("其他节点")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("9.0 GiB");
    expect(screen.getAllByText("4.0 GiB").length).toBeGreaterThan(0);
    expect(calls[0].search).toBe(`?from=${from}&to=${to}`);
    fireEvent.click(screen.getByRole("button", { name: "近 7 天" }));
    const seven = lastDays(7);
    await waitFor(() => expect(calls.some((c) => c.search === `?from=${seven.from}&to=${seven.to}`)).toBe(true));
    expect(screen.getByRole("button", { name: "近 7 天" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("English, empty period, and errors", async () => {
    setLocale("en");
    const { from, to } = lastDays(30);
    fakeApi({
      "GET /me/traffic": { ...myTraffic(from, to), total: b(0, 0, 0), days: [], nodes: [] },
    });
    renderWithClient(<TrafficCard />);
    expect(await screen.findByText("No traffic in this period.")).toBeTruthy();
    expect(screen.getByText("Usage history", { selector: "h2" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    fakeApi({ "GET /me/traffic": () => ({ status: 500, body: { error: "boom" } }) });
    renderWithClient(<TrafficCard />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load your traffic");
  });

  it("hover shows the day's values", async () => {
    const { from, to } = lastDays(30);
    fakeApi({ "GET /me/traffic": myTraffic(from, to) });
    renderWithClient(<TrafficCard />);
    const svg = await screen.findByRole("img");
    svg.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    fireEvent.mouseMove(svg, { clientX: 299 });
    expect(await screen.findByText(new RegExp(`${to.slice(5)} · 9.0 GiB`))).toBeTruthy();
    fireEvent.mouseLeave(svg);
  });
});

describe("admin traffic views", () => {
  it("user: daily totals and per-node table (deleted nodes named as such)", async () => {
    const { from, to } = lastDays(30);
    const calls = fakeApi({
      "GET /users/u1/traffic": () => ({
        status: 200,
        body: {
          from,
          to,
          timezone: "UTC",
          group: calls.at(-1)?.search.includes("group=node") ? "node" : "day",
          daily_since: null,
          total: b(GIB, 2 * GIB, 3 * GIB),
          rows: calls.at(-1)?.search.includes("group=node")
            ? [
                { node_id: "n1", name: "东京", ...b(GIB, GIB, 2 * GIB) },
                { node_id: "n9", name: null, ...b(0, GIB, GIB) },
              ]
            : [{ day: to, ...b(GIB, 2 * GIB, 3 * GIB) }],
        },
      }),
    });
    renderAdmin(<UserTraffic userId="u1" login="alice" />);
    const section = await screen.findByRole("region", { name: "alice 的流量明细" });
    expect(await within(section).findByText("东京")).toBeTruthy();
    expect(within(section).getByText("已删除的节点")).toBeTruthy();
    expect(await within(section).findByText(/合计：上传 1\.0 GiB/)).toBeTruthy();
    expect(calls.some((c) => c.search.startsWith("?group=day&from="))).toBe(true);
    fireEvent.click(within(section).getByRole("button", { name: "近 90 天" }));
    const ninety = lastDays(90);
    await waitFor(() => expect(calls.some((c) => c.search.includes(`from=${ninety.from}`))).toBe(true));
  });

  it("node: top users (deleted users named as such) and errors", async () => {
    const { from, to } = lastDays(30);
    fakeApi({
      "GET /nodes/n1/traffic": {
        from,
        to,
        timezone: "UTC",
        daily_since: null,
        total: b(GIB, GIB, GIB),
        days: [{ day: to, users: 2, ...b(GIB, GIB, GIB) }],
        top_users: [
          { user_id: "u1", login: "alice", ...b(GIB, 0, GIB) },
          { user_id: "u2", login: null, ...b(0, GIB, 0) },
        ],
      },
    });
    renderAdmin(<NodeTraffic nodeId="n1" />);
    expect(await screen.findByText("alice")).toBeTruthy();
    expect(screen.getByText("已删除的用户")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    fakeApi({});
    renderAdmin(<NodeTraffic nodeId="n2" />);
    expect((await screen.findAllByRole("alert"))[0].textContent).toContain("节点流量加载失败");
  });
});
