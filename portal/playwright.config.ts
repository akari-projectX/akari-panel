import { defineConfig, devices } from '@playwright/test';

/*
 * 门户 v2 的端到端测试：跑在真实面板上（../scripts/e2e-portal.sh 在 React 门户的用例之后，
 * 以 AKARI_PORTAL_V2=1 重启同一个面板、同一份数据，设 E2E_BASE）。浏览器参数与 React 门户相同
 * （TLS 前端：测试域名指到本机，只信任那一把临时密钥），同一个 Playwright 版本、同一个 Chromium。
 * 桌面 1440×900 与手机 390×844 各跑一遍；一律「减少动效」。
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/run',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE,
    launchOptions: {
      args: [
        `--host-resolver-rules=MAP ${process.env.E2E_TLS_HOST ?? 'portal.e2e.test'} 127.0.0.1`,
        `--ignore-certificate-errors-spki-list=${process.env.E2E_TLS_SPKI ?? ''}`,
      ],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
