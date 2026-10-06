import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

/* 单测只跑 src 下的 *.test.ts；e2e/ 是 Playwright 的，由 npm run e2e 跑 */
export default mergeConfig(viteConfig, defineConfig({ test: { include: ['src/**/*.test.ts'] } }));
