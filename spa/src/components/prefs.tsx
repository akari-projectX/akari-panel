import { flushSync } from 'react-dom';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LOCALES, localeReady, preloadEN, useLocale, type Locale } from '@/i18n';
import { crossfade } from '@/lib/motion';
import { warmHanFont } from '@/lib/han-font';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/theme';

/*
 * 明暗与语言的切换都走 crossfade：整页新旧两帧交叉淡化，而不是所有颜色、文字在同一帧硬切。
 * 过渡要在回调里同步把 DOM 改完：setTheme 同步改好 <html> 的 class，
 * flushSync 让 React 那一侧（图标、依赖 resolvedTheme 的组件）同步跟上。
 */
function useApplyTheme() {
  const { resolvedTheme, setTheme } = useTheme();
  return (next: 'light' | 'dark') => {
    if (next === resolvedTheme) return;
    crossfade(() => flushSync(() => setTheme(next)));
  };
}

function useToggleTheme() {
  const { resolvedTheme } = useTheme();
  const apply = useApplyTheme();
  return () => apply(resolvedTheme === 'dark' ? 'light' : 'dark');
}

/*
 * 切语言先等两样东西到位再交叉淡化：英文词典、新语言这一页要用的中文字体切片（见 lib/han-font）。
 * 平时页面空闲时已经预热过（App 的 WarmOtherLocale），这里多半立即就绪；
 * 没预热完就最多等 1 秒——宁可晚一点切，也别让新语言先用系统字体露一下再跳。
 */
function useSwitchLocale() {
  const { locale, setLocale } = useLocale();
  return (l: Locale) => {
    if (l === locale) return;
    const ready = Promise.all([localeReady(l), warmHanFont(l)]);
    Promise.race([ready, new Promise((r) => setTimeout(r, 1000))])
      .then(() => crossfade(() => flushSync(() => setLocale(l))));
  };
}

/**
 * 明暗切换。
 * 图标用 CSS 类切换而不是读 resolvedTheme 再条件渲染——后者在水合前拿不到值，
 * 会先画错一个图标再跳，视觉上是一次闪烁。
 */
export function ThemeToggle({ className }: { className?: string }) {
  const toggleTheme = useToggleTheme();
  const { t } = useLocale();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost" size="icon-lg" className={cn('rounded-full', className)}
          aria-label={t('切换明暗模式')}
          onClick={toggleTheme}
        >
          <Sun className="hidden dark:block" />
          <Moon className="block dark:hidden" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('切换明暗模式')}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 页头的语言按钮：只有中、英两种，点一下直接互换，不再展开菜单。
 * 按钮上写的是**切过去的那门语言**（中文界面显示 EN，英文界面显示「中」），一看就知道点了会变成什么。
 * 指针移上来就预取英文词典，点下去时通常已经到了，不会先闪一下中文。
 */
export function LocaleToggle({ className, dark = false }: { className?: string; dark?: boolean }) {
  const { locale, t } = useLocale();
  const switchLocale = useSwitchLocale();
  const next = LOCALES.find((l) => l.id !== locale)!;
  return (
    <button
      aria-label={t('切换语言')}
      title={next.label}
      lang={next.id}
      onPointerEnter={preloadEN}
      onFocus={preloadEN}
      onClick={() => switchLocale(next.id)}
      className={cn(
        'flex h-9 min-w-9 cursor-pointer items-center justify-center rounded-full px-2',
        'text-[12.5px] font-medium tracking-[.02em] transition-colors',
        dark ? 'text-slate-300 hover:bg-white/10 hover:text-white' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      {next.short}
    </button>
  );
}

/** 页头卡片里的语言开关：中、英两段并排，看得见现在是哪一边 */
export function LocaleSwitch({ className }: { className?: string }) {
  const { locale, t } = useLocale();
  const switchLocale = useSwitchLocale();
  return (
    <div
      role="group" aria-label={t('切换语言')} onPointerEnter={preloadEN} onFocus={preloadEN}
      className={cn('flex items-center rounded-full border border-border p-[3px]', className)}
    >
      {LOCALES.map((l) => {
        const on = l.id === locale;
        return (
          <button
            key={l.id}
            onClick={() => switchLocale(l.id)}
            aria-pressed={on}
            title={l.label}
            className={cn(
              'h-6 cursor-pointer rounded-full px-2 text-[12px] font-medium transition-colors',
              on ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {l.short}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 页头卡片里的明暗开关：和语言开关同一个外形，两段各放一个图标。
 * 这里不是「切换」而是直接选：看得见现在是哪一边，点另一边才会动。
 */
export function ThemeSwitch({ className }: { className?: string }) {
  const { resolvedTheme } = useTheme();
  const apply = useApplyTheme();
  const { t } = useLocale();
  const opts = [
    { id: 'light', label: '浅色', Icon: Sun },
    { id: 'dark', label: '深色', Icon: Moon },
  ] as const;
  return (
    <div role="group" aria-label={t('切换明暗模式')} className={cn('flex items-center rounded-full border border-border p-[3px]', className)}>
      {opts.map(({ id, label, Icon }) => {
        const on = resolvedTheme === id;
        return (
          <button
            key={id}
            onClick={() => apply(id)}
            aria-pressed={on}
            aria-label={t(label)}
            title={t(label)}
            className={cn(
              'grid h-6 w-8 cursor-pointer place-items-center rounded-full transition-colors',
              on ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
