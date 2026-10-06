import { useEffect, type CSSProperties } from 'react';
import { holdBoot } from '@/lib/boot';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * 加载态的两个零件：
 * - `Spinner` —— 苹果那只活动指示器，用在「除了等没别的可做」的地方。
 * - `Sk`      —— 骨架条，用在「已经知道版式长什么样」的地方。
 *
 * 骨架条上扫过的那道光有统一的相位（`--sk-delay`），
 * 所以一屏骨架看起来是**一道光扫过整页**，而不是各闪各的。
 */

const SPOKES = Array.from({ length: 12 }, (_, i) => i);

export function Spinner({
  className, size = 28, tone = 'muted',
}: { className?: string; size?: number; tone?: 'muted' | 'current' }) {
  const tr = useT();
  return (
    <span
      role="status"
      aria-label={tr('加载中')}
      className={cn('spinner', className)}
      style={{
        '--spin-size': `${size}px`,
        ...(tone === 'current' && { '--spin-color': 'currentColor' }),
      } as CSSProperties}
    >
      {SPOKES.map((i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}
    </span>
  );
}

/** 骨架条。`d` 是这道光束的出发时间，按它在页面上的先后给。 */
export function Sk({ className, style, d = 0 }: { className?: string; style?: CSSProperties; d?: number }) {
  return (
    <span
      aria-hidden
      className={cn('sk', className)}
      style={{ ...style, '--sk-delay': `${d}s` } as CSSProperties}
    />
  );
}

/**
 * 页面级占位出现时拖住启动画面：它们在，说明页面结构都还没有，
 * 收起启动画面只会露出又一个加载态。hold 在启动画面收起后是空操作。
 */
function useHoldBoot(enabled = true) {
  useEffect(() => (enabled ? holdBoot() : undefined), [enabled]);
}

/* ── 整页：只有一盏灯，配一行会自己出现的解释 ── */

export function PageLoading({ className }: { className?: string }) {
  const tr = useT();
  useHoldBoot();
  return (
    <div className={cn('load-in flex min-h-[60vh] flex-col items-center justify-center gap-6', className)}>
      <Spinner />
      {/* 三秒之内加载完就永远不会看到这句；超过了，才需要一句交代 */}
      <p className="load-hint text-[12.5px] leading-[1.9] text-muted-foreground">
        {tr('正在载入，网络较慢时会久一点')}
      </p>
    </div>
  );
}

/* ── 用户中心：标题 + 指标条 + 若干行 ── */

/**
 * hold=false 用在「页面已经出来、只是在等数据」的场合：
 * 那种等待由 useApi 按 soft 计，最多拖 1 秒多，不该当成结构缺失一直拖住启动画面。
 */
export function DashSkeleton({ hold = true }: { hold?: boolean }) {
  useHoldBoot(hold);
  return (
    <div aria-busy className="load-in pt-11">
      <Sk className="h-[30px] w-[190px]" d={0} />
      <Sk className="mt-3.5 h-[15px] w-[min(340px,70%)]" d={0.06} />

      <div className="mt-11 grid gap-y-7 border-y border-border py-8 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2.5">
            <Sk className="h-[26px] w-[86px]" d={0.12 + i * 0.05} />
            <Sk className="h-[12px] w-[62px]" d={0.15 + i * 0.05} />
          </div>
        ))}
      </div>

      <div className="mt-9 flex flex-col gap-0">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border py-4.5 last:border-b-0">
            <Sk className="size-8 shrink-0 rounded-full" d={0.3 + i * 0.05} />
            <div className="flex min-w-0 grow flex-col gap-2">
              <Sk className="h-[14px]" style={{ width: `${52 - i * 6}%` }} d={0.32 + i * 0.05} />
              <Sk className="h-[11px]" style={{ width: `${72 - i * 5}%` }} d={0.34 + i * 0.05} />
            </div>
            <Sk className="hidden h-[14px] w-[68px] shrink-0 sm:block" d={0.36 + i * 0.05} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 站点长文页：左目录 + 右正文 ── */

export function DocSkeleton() {
  useHoldBoot();
  return (
    <div aria-busy className="load-in page-wrap pt-14 pb-24">
      <div className="max-w-[62ch] border-b border-border pb-10">
        <Sk className="h-[13px] w-[120px]" d={0} />
        <Sk className="mt-4 h-[34px] w-[260px]" d={0.06} />
        <Sk className="mt-4 h-[15px] w-full" d={0.1} />
        <Sk className="mt-2 h-[15px] w-[64%]" d={0.13} />
      </div>
      <div className="grid gap-x-14 pt-12 lg:grid-cols-[190px_1fr]">
        <div className="mb-10 hidden flex-col gap-3 lg:mb-0 lg:flex">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Sk key={i} className="h-[13px]" style={{ width: `${88 - i * 7}%` }} d={0.18 + i * 0.04} />
          ))}
        </div>
        <div className="min-w-0 lg:border-l lg:border-border lg:pl-14">
          {[0, 1, 2].map((s) => (
            <div key={s} className="border-b border-border py-9 first:pt-0 last:border-b-0">
              <Sk className="h-[19px] w-[200px]" d={0.24 + s * 0.12} />
              <div className="mt-5 flex flex-col gap-2.5">
                {[0, 1, 2, 3].map((l) => (
                  <Sk key={l} className="h-[13px]" style={{ width: `${96 - l * 11}%` }} d={0.28 + s * 0.12 + l * 0.03} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
