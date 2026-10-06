import { defineConfig, devices } from '@playwright/test';

/*
 * 门户端到端测试：跑在一个真实的面板上（scripts/e2e-local.sh 起面板、灌数据、设 E2E_BASE）。
 * 桌面与手机两种视口各跑一遍。
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: '.e2e/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
