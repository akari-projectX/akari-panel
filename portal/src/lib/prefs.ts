import { setMailLocale } from './auth.svelte';
import { setLocale, type Locale } from './i18n.svelte';

/**
 * 用户主动切换界面语言（顶栏按钮、窄屏菜单）：先预热中文字体切片（英文 → 中文时），再切换，
 * 并把账户的邮件语言改成同一门。
 */
export async function changeLocale(next: Locale) {
  await setLocale(next);
  setMailLocale(next === 'en' ? 'en' : 'zh');
}
