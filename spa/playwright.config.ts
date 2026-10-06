import { defineConfig, devices } from '@playwright/test';

/*
 * 门户端到端测试：跑在一个真实的面板上（../scripts/e2e-portal.sh 起面板、灌数据、设 E2E_BASE）。
 * 桌面与手机两种视口各跑一遍。
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE,
    /* 门户经 e2e/tls-proxy.mjs 走 https（主域名是 https 源，通行密钥才可用）：把测试域名指到本机，只信任那一把临时密钥 */
    launchOptions: {
      args: [
        `--host-resolver-rules=MAP ${process.env.E2E_TLS_HOST ?? 'portal.e2e.test'} 127.0.0.1`,
        `--ignore-certificate-errors-spki-list=${process.env.E2E_TLS_SPKI ?? ''}`,
      ],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
