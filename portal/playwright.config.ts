import { defineConfig, devices } from '@playwright/test';

/*
 * 门户的端到端测试：跑在真实面板上（../scripts/e2e-portal.sh 起面板、种子数据（e2e/support/seed.ts）、
 * TLS 前端（测试域名指到本机，只信任那一把临时密钥），设 E2E_BASE）。性能报告是另一份配置（playwright.perf.config.ts）。
 * 桌面 1440×900 与手机 390×844 各跑一遍；一律「减少动效」。
 */
export default defineConfig({
  testDir: 'e2e',
  testIgnore: ['perf/**'],
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
