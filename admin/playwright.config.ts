// Admin app end-to-end (W33-b), run by ../scripts/e2e.sh against a real
// panel with its real CSP (bypassCSP stays off). Every line of
// INVENTORY.md is covered (test titles start with the line ids), on a
// desktop and on a phone. One panel, shared accounts, ordered steps:
// serial; each project uses its own names (e2e/helpers.ts `uniq`).
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], locale: "zh-CN" } },
    { name: "mobile", use: { ...devices["Pixel 7"], locale: "zh-CN" } },
  ],
});
