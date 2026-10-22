import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/*
 * 门户性能报告（e2e/perf/，只报告不判定）：与验收用例同一个真实面板、同一个 TLS 前端，
 * 由 ../scripts/e2e-portal.sh 在 E2E_PERF_OUT 设置时跑。动效照常播放（用例里按上下文设置）。
 */
export default defineConfig({
  ...base,
  testDir: 'e2e/perf',
  testIgnore: undefined,
  outputDir: 'test-results/perf-artifacts',
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-mid', use: { ...devices['Pixel 7'] } },
  ],
});
