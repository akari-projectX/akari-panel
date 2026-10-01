// Playwright end-to-end tests (e2e/), run by ../scripts/e2e.sh against a
// real panel: E2E_BASE etc. come from that script. The CSP is the panel's
// own (bypassCSP stays off).
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // One panel, shared accounts, ordered steps (2FA enrollment changes the
  // admin's login): serial.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
});
