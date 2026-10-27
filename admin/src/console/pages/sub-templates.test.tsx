// 订阅模板 editor in jsdom with a stubbed API: tabs, the placeholder help,
// a server 400 with a position (error strip + marker), save, and the version
// conflict prompt (load the latest / keep the draft and overwrite).
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LangProvider } from "../../shared/i18n";
import { ConfirmProvider } from "../../shared/ui/confirm";
import { invalidateOnWrite, makeQueryClient } from "../data";
import { SubTemplatesPage } from "./sub-templates";

type Row = { format: string; body: string; default_body: string; is_default: boolean; version: number };
const row = (format: string, body: string): Row => ({ format, body, default_body: body, is_default: true, version: 0 });
let rows: Row[];
const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];

const view = (r: Row) => ({
  ...r,
  updated_at: null,
  updated_by: null,
  placeholders: [{ token: "$proxies", zh: "全部线路", en: "All lines" }],
});

beforeEach(() => {
  rows = [
    row("sing-box", '{"outbounds": []}'),
    row("clash", "mixed-port: 7890\n"),
    row("surge", "[Proxy]\n"),
    row("surfboard", "[Proxy]\n"),
  ];
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/^.*\/api\/v1/, "").split("?")[0];
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ method, path, body });
      if (path === "/sub-templates") return new Response(JSON.stringify({ templates: rows.map(view) }));
      const m = /^\/sub-templates\/([\w-]+)$/.exec(path);
      if (m && method === "PUT") {
        const r = rows.find((x) => x.format === m[1])!;
        if ((body!.body as string).includes("Ghost"))
          return new Response(
            JSON.stringify({
              error: "x",
              code: "sub_template.invalid",
              params: { field: "body", msg: "Ghost", line: 2, column: 5 },
            }),
            { status: 400 },
          );
        if (body!.version !== r.version)
          return new Response(JSON.stringify({ error: "x", code: "sub_template.version_conflict" }), { status: 409 });
        Object.assign(r, { body: body!.body, version: r.version + 1, is_default: false });
        return new Response(JSON.stringify(view(r)));
      }
      return new Response(JSON.stringify({ error: "nf", code: "x" }), { status: 404 });
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  // CodeMirror measures text with range rectangles, which jsdom lacks.
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {} };
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as never;
  Range.prototype.getBoundingClientRect = () => rect as never;
});
afterEach(() => cleanup());

function mount(path = "/settings/sub-templates") {
  const qc = makeQueryClient();
  invalidateOnWrite(qc);
  const router = createMemoryRouter(
    [
      { path: "/settings/sub-templates", Component: SubTemplatesPage },
      { path: "*", element: <div>elsewhere</div> },
    ],
    {
      initialEntries: [path],
    },
  );
  render(
    <QueryClientProvider client={qc}>
      <LangProvider initial="zh">
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </LangProvider>
    </QueryClientProvider>,
  );
}

test("tabs for the four clients; the cheat-sheet comes from the API", async () => {
  mount();
  await screen.findByRole("textbox", { name: "Sing-box 订阅模板" });
  for (const n of ["Sing-box", "Clash", "Surge", "Surfboard"])
    expect(screen.getByRole("tab", { name: new RegExp(`^${n}`) })).toBeTruthy();
  expect(screen.getByText("全部线路")).toBeTruthy();
  expect(screen.getByText("使用内置默认模板")).toBeTruthy();
});

test("a 400 with a position shows in the error strip and nothing is stored", async () => {
  mount("/settings/sub-templates?format=clash");
  const editor = await screen.findByRole("textbox", { name: "Clash 订阅模板" });
  // Type into the editor (CodeMirror reads the DOM it is given).
  fireEvent.input(editor, { target: { textContent: "Ghost" } });
  const save = screen.getByRole("button", { name: /^保存/ });
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  const strip = await screen.findByRole("alert", { name: "模板错误" });
  expect(within(strip).getByRole("button", { name: "第 2 行 第 5 列" })).toBeTruthy();
  expect(rows[1].is_default).toBe(true);
});

test("save sends the loaded version; a stale one asks to load the latest or overwrite", async () => {
  mount("/settings/sub-templates?format=clash");
  const editor = await screen.findByRole("textbox", { name: "Clash 订阅模板" });
  fireEvent.input(editor, { target: { textContent: "mixed-port: 1\n" } });
  const save = screen.getByRole("button", { name: /^保存/ }) as HTMLButtonElement;
  await waitFor(() => expect(save.disabled).toBe(false));
  // Another admin saves first.
  Object.assign(rows[1], { body: "theirs\n", version: 1, is_default: false });
  fireEvent.click(save);
  const banner = await screen.findByText("模板已被其他管理员修改");
  expect(save.disabled).toBe(true);
  expect(calls.filter((c) => c.method === "PUT").map((c) => c.body!.version)).toEqual([0]);
  fireEvent.click(screen.getByRole("button", { name: "保留我的草稿并覆盖" }));
  await waitFor(() => expect(screen.queryByText("模板已被其他管理员修改")).toBeNull());
  expect(banner.isConnected).toBe(false);
  await waitFor(() => expect(save.disabled).toBe(false));
  fireEvent.click(save);
  await waitFor(() => expect(rows[1].version).toBe(2));
  expect(calls.filter((c) => c.method === "PUT").map((c) => c.body!.version)).toEqual([0, 1]);
  await screen.findByText(/^已自定义/);
});
