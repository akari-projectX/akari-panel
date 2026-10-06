import { useCallback, useState } from 'react';
import { toast } from '@/lib/toast';
import { useSafeTimeout } from '@/hooks/use-safe-timeout';
import { useT } from '@/i18n';

/**
 * 复制到剪贴板，并让对应的按钮短暂显示「已复制」。
 *
 * writeText 会 reject：非安全源（局域网 http 部署）、权限被拒、文档失焦都会。
 * 失败时统一提示用户手动复制，绝不假装成功——以前各页各写一遍，有的写漏了 catch，
 * 复制失败照样弹「已复制」。成功与否由返回值告诉调用处，成功提示的文案各页自己定。
 *
 * 同一页有好几个复制按钮时用 key 区分，copied 等于哪个 key 就是哪个按钮在显示「已复制」。
 */
export function useCopy<K extends string = string>(ms = 1800) {
  const tr = useT();
  const later = useSafeTimeout();
  const [copied, setCopied] = useState<K | null>(null);

  const copy = useCallback(async (text: string, key = '' as K): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      /* 只撤掉自己：连着点了两个按钮时，前一个的计时器不该把后一个的「已复制」提前收掉 */
      later(() => setCopied((v) => (v === key ? null : v)), ms);
      return true;
    } catch {
      toast.error(tr('复制失败，请手动选中复制'));
      return false;
    }
  }, [later, ms, tr]);

  return [copied, copy] as const;
}
