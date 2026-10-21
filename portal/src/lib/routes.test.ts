import { describe, expect, it } from 'vitest';
import { match, PAGES, REDIRECTS } from './pages';
import { allowed, PAGE_SCOPES, R, safeRedirect, scopeOf } from './routes';
import { scanSvelte, scanTs } from '../../scripts/strings.mjs';

describe('routes', () => {
  it('scopes follow the panel guards', () => {
    expect(allowed('/', 'banned')).toBe(true);
    expect(allowed('/tickets', 'banned')).toBe(true);
    expect(allowed('/shop', 'banned')).toBe(false);
    expect(allowed('/nodes', 'renewal')).toBe(false);
    expect(allowed('/traffic', 'renewal')).toBe(false);
    expect(allowed('/orders/abc', 'renewal')).toBe(true);
    expect(allowed('/orders/abc', 'banned')).toBe(false);
    expect(allowed('/nodes', 'full')).toBe(true);
    expect(allowed('/', undefined)).toBe(false);
  });

  it('every scoped page exists', () => {
    for (const p of Object.keys(PAGE_SCOPES)) expect(match(p)?.page.layout).toBe('dash');
  });

  it('scopeOf: banned wins, then expired / quota', () => {
    expect(scopeOf({ banned: true, expired: true, quota_exhausted: false })).toBe('banned');
    expect(scopeOf({ banned: false, expired: false, quota_exhausted: true })).toBe('renewal');
    expect(scopeOf({ banned: false, expired: false, quota_exhausted: false })).toBe('full');
  });

  it('safeRedirect only accepts same-site paths', () => {
    expect(safeRedirect('/orders?x=1')).toBe('/orders?x=1');
    expect(safeRedirect('//evil.example')).toBe('/');
    expect(safeRedirect('https://evil.example')).toBe('/');
    expect(safeRedirect('/\\evil.example')).toBe('/');
    expect(safeRedirect(null)).toBe('/');
  });
});

describe('page matching', () => {
  it('matches static and parameter routes', () => {
    expect(match('/')?.page.title).toBe('仪表盘');
    expect(match('/shop/')?.page.path).toBe(R.shop);
    expect(match('/orders/a%20b')?.params).toEqual({ id: 'a b' });
    expect(match('/orders/a/b')).toBeUndefined();
    expect(match('/nope')).toBeUndefined();
    expect(match('/login')?.page.layout).toBe('guest');
    expect(match('/terms')?.page.layout).toBe('public');
  });

  it('every top-level route of R has a page or a redirect', () => {
    const tops = new Set(Object.values(R).filter((v): v is string => typeof v === 'string'));
    for (const p of tops) expect(!!match(p) || p in REDIRECTS, p).toBe(true);
    expect(PAGES.length).toBeGreaterThan(0);
    expect(REDIRECTS[R.invite]).toBe('/wallet?tab=invite');
  });
});

describe('strings extraction', () => {
  it('collects literals, keys and template parts; skips comments and regexes', () => {
    const r = scanTs(`
      // '注释'
      /* "块注释" */
      const a = { '键': "值", b: \`模板\`, c: \`前 \${x ? '甲' : "乙"} 后\` };
      const re = /'不是字符串'/g;
      const d = 4 / 2 / 1;
      const e = 'it\\'s';
    `);
    expect(r.strings).toEqual(expect.arrayContaining(['键', '值', '模板', '前 ', '甲', '乙', ' 后', "it's"]));
    expect(r.strings).not.toContain('注释');
    expect(r.strings).not.toContain('块注释');
    expect(r.strings.some((s: string) => s.includes('不是字符串'))).toBe(false);
    expect(r.keys).toContain('键');
    expect(r.keys).not.toContain('值');
  });

  it('flags Chinese written straight into Svelte markup', () => {
    const r = scanSvelte(`
      <script lang="ts">const x = '甲';</script>
      <style>.a::after { content: '样式'; }</style>
      <!-- 注释 -->
      <p title="提示 {y}">直接写的字 {t('乙')}</p>
      {#if ok}<span aria-label={t('丙')}>{'丁'}</span>{/if}
    `);
    expect(r.strings).toEqual(expect.arrayContaining(['甲', '乙', '丙', '丁']));
    expect(r.strings).not.toContain('样式');
    expect(r.markup).toEqual(['提示', '直接写的字']);
  });
});
