import { t } from './i18n.svelte';
import { toast } from './toast.svelte';

/**
 * 复制到剪贴板，按钮短暂变成对勾：`which` = 刚复制的是哪一个（金额 / 地址 / 订单号），
 * ms 毫秒后清掉。失败（没权限、非安全上下文）弹一句「复制失败，请手动选中复制」。
 */
export class Copied<K extends string = string> {
  which = $state<K | null>(null);
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ms: number;

  constructor(ms = 1600) {
    this.#ms = ms;
  }

  async copy(text: string, which: K) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error(t('复制失败，请手动选中复制'));
      return;
    }
    this.which = which;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.which = null; }, this.#ms);
  }
}
