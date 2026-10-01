import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeView, ReleaseView, RolloutView } from "../lib/api";
import { fakeApi, renderWithClient } from "../test/harness";
import { AdminUpdates, parseWaves } from "./admin-updates";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const release: ReleaseView = {
  id: "rel1",
  version: "v1.1.0",
  os: "linux",
  arch: "amd64",
  sha256: "ab".repeat(32),
  size: 1024,
  key_id: "2147ae3d5bc25aaf",
  min_panel_protocol: 3,
  rollback: false,
  complete: true,
  created_at: "2026-10-02T00:00:00Z",
  complete_at: "2026-10-02T00:00:00Z",
};

const rollout = (over: Partial<RolloutView>): RolloutView => ({
  id: "ro1",
  version: "v1.1.0",
  status: "running",
  waves: [10, 100],
  percentage: 100,
  explicit_nodes: false,
  current_wave: 0,
  wave_started_at: "2026-10-02T00:00:00Z",
  health_timeout_secs: 600,
  max_failure_ratio: 0.2,
  halted_reason: null,
  created_by: "root",
  created_at: "2026-10-02T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  finished_at: null,
  counts: { healthy: 1, pending: 3 },
  ...over,
});

const node = { id: "n1", name: "tokyo", enrolled: true, deleting_at: null, agent_version: "v1.0.0" } as unknown as NodeView;

describe("parseWaves", () => {
  it("accepts ascending percentages ending at 100", () => {
    expect(parseWaves("10, 50, 100")).toEqual([10, 50, 100]);
    expect(parseWaves("100")).toEqual([100]);
  });
  it("rejects anything else", () => {
    for (const bad of ["", "50", "50,50,100", "60,40,100", "0,100", "10,x,100", "10.5,100"]) {
      expect(parseWaves(bad)).toBeNull();
    }
  });
});

describe("AdminUpdates", () => {
  it("starts a rollout with the chosen waves and node selection", async () => {
    const calls = fakeApi({
      "GET /agent-releases": [release],
      "GET /rollouts": [],
      "GET /nodes": [node],
      "POST /rollouts": () => ({ status: 201, body: rollout({}) }),
    });
    renderWithClient(<AdminUpdates />);
    await screen.findByText("ready");
    fireEvent.change(screen.getByLabelText("Waves"), { target: { value: "25, 100" } });
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Start rollout" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/rollouts")).toBe(true));
    const body = calls.find((c) => c.method === "POST" && c.path === "/rollouts")?.body;
    expect(body).toEqual({
      version: "v1.1.0",
      percentage: 100,
      waves: [25, 100],
      health_timeout_secs: 600,
      max_failure_ratio: 0.2,
      node_ids: ["n1"],
    });
  });

  it("refuses malformed waves without calling the API", async () => {
    const calls = fakeApi({ "GET /agent-releases": [release], "GET /rollouts": [], "GET /nodes": [] });
    renderWithClient(<AdminUpdates />);
    await screen.findByText("ready");
    fireEvent.change(screen.getByLabelText("Waves"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Start rollout" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/waves/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("offers only the valid actions per state and shows the halt reason", async () => {
    const calls = fakeApi({
      "GET /agent-releases": [release],
      "GET /nodes": [],
      "GET /rollouts": [
        rollout({ id: "a", status: "halted", halted_reason: "2 failed / 3 finished > max_failure_ratio 0.2" }),
      ],
      "POST /rollouts/a/abort": rollout({ id: "a", status: "aborted" }),
    });
    renderWithClient(<AdminUpdates />);
    await screen.findByText(/2 failed \/ 3 finished/);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/rollouts/a/abort")).toBe(true));
  });
});
