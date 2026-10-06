import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { holdBoot } from '@/lib/boot';
import { LocaleCtx, hasEN, loadEN, readLocale, saveLocale, translate, type Locale } from './index';

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, set] = useState<Locale>(readLocale);
  /* 词典到了之后要换一个 t 的引用，让用到它的组件重新渲染 */
  const [enReady, setEnReady] = useState(hasEN);

  /* lang 在浏览器第一次排版之前定下来：读屏软件、断行规则都按它 */
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => { saveLocale(locale); }, [locale]);

  useEffect(() => {
    if (locale !== 'en' || hasEN()) return;
    let alive = true;
    const release = holdBoot();
    loadEN()
      .then(() => { if (alive) setEnReady(true); })
      /* 分包下不来就先显示中文，不因为一本词典让整站起不来 */
      .catch(() => {})
      .finally(release);
    return () => { alive = false; release(); };
  }, [locale]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- enReady 变了要换引用，translate 读的是模块里的词典
  const t = useCallback((s: string) => translate(locale, s), [locale, enReady]);

  const value = useMemo(() => ({ locale, setLocale: set, t }), [locale, t]);
  return <LocaleCtx.Provider value={value}>{children}</LocaleCtx.Provider>;
}
