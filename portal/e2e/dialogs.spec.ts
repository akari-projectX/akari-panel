/*
 * 对话框的分包预载（lib/dialogs）：对话框照旧在单独的分包里，但页面空闲时就下好，第一次点按钮时当场弹出——
 * 原来第一次点击才开始下载，要等一两秒。每个用例都是新的浏览器上下文（缓存是空的）。
 * 账户：user@e2e.test（只打开对话框再关掉：注销只取影响清单，商店不下单）。
 */
import type { Locator, Page } from '@playwright/test';
import { expect, ready, signIn, test } from './fixtures';

/** 这个分包（Vite 的 assets/<名字>-<哈希>.js）下载完成 */
const chunkLoaded = (page: Page, name: string) =>
  page.waitForResponse((r) => new RegExp(`/assets/${name}-[\\w-]+\\.js$`).test(r.url()) && r.ok());

/** 点按钮（页面里同步 click）到对话框画出来的毫秒数 */
async function clickToDialog(button: Locator): Promise<number> {
  await button.scrollIntoViewIfNeeded();
  return button.evaluate((el) => new Promise<number>((resolve, reject) => {
    const t0 = performance.now();
    (el as HTMLElement).click();
    const tick = () => {
      const shown = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some((d) => d.getBoundingClientRect().height > 0);
      if (shown) resolve(performance.now() - t0);
      else if (performance.now() - t0 > 5000) reject(new Error('no dialog within 5 s'));
      else requestAnimationFrame(tick);
    };
    tick();
  }));
}

/** 点击之后不再下载这个分包 */
function noLateFetch(page: Page, name: string): () => void {
  const late: string[] = [];
  const watch = (r: { url(): string }) => { if (r.url().includes(`/assets/${name}-`)) late.push(r.url()); };
  page.on('request', watch);
  return () => {
    page.off('request', watch);
    expect(late, `${name} fetched again after the click`).toEqual([]);
  };
}

test('account deletion: the dialog chunk is preloaded while the page is idle; the first click opens it at once, the impact loads inside', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  const loaded = chunkLoaded(page, 'DeleteAccountDialog');
  await page.goto('/account');
  await ready(page, '设置');
  await loaded;

  const after = noLateFetch(page, 'DeleteAccountDialog');
  const ms = await clickToDialog(page.getByRole('button', { name: '注销账户…' }));
  expect(ms).toBeLessThan(300);
  const dialog = page.getByRole('dialog', { name: '注销账户' });
  await expect(dialog).toBeVisible();
  /* 影响清单在对话框里取：先占位，后填上 */
  await expect(dialog.getByText('注销后你将失去')).toBeVisible();
  after();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
});

test('shop: the order confirmation chunk is preloaded while the page is idle; the first click on a plan opens it at once', async ({ page }) => {
  await signIn(page, 'user@e2e.test');
  const loaded = chunkLoaded(page, 'ConfirmOrder');
  await page.goto('/shop');
  await ready(page, '商店');
  await expect(page.locator('.plan-card').first()).toBeVisible({ timeout: 15_000 });
  await loaded;

  const after = noLateFetch(page, 'ConfirmOrder');
  const ms = await clickToDialog(page.locator('.plan-cta button:not([disabled])').first());
  expect(ms).toBeLessThan(300);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '确认订单' })).toBeVisible();
  after();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
