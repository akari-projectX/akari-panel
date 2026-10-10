import type { ReactNode } from 'react';
import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive } from 'radix-ui';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

/*
 * 弹窗按用途分三类，每类一套外形，同类之间统一：
 *
 *   阅读 ReadingDialog  公告、工单对话。宽、正文按阅读宽度排，头部是「标签 · 日期」一行小字加大标题，
 *                       只有正文滚动，头尾不动。读东西的时候，框本身越不显眼越好。
 *   确认 ConfirmDialog  重置订阅、佣金划转这类不可撤销的操作。窄、按钮等宽并排，
 *                       「会发生什么」单独列成清单放在最前面——用户该在点下去之前读到的是后果，不是标题。
 *   流程 FlowDialog     下单、兑换礼品卡、提交工单、申请提现。填表的地方可以滚动，
 *                       底部一条不动的小结栏：左边是「这一步的结果」（应付金额、剩余字数），右边是按钮。
 *
 * 以前八个弹窗共用一个居中卡片，看公告、确认重置和付款长得一模一样，分不出轻重。
 * 手机上三类都从底部升起（整宽、顶部圆角），拇指够得着按钮；桌面上居中。
 */

/* 遮罩：比原来深一档，弹窗和页面的层次分得开。
 * 各层都带 data-slot（…-content / …-overlay）：index.css 按它套站内的弹层节奏——打开稍慢、关闭干脆 */
const overlay = 'fixed inset-0 z-50 bg-black/35 supports-backdrop-filter:backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0';

/* 手机从底部升起，桌面居中缩放进场 */
const sheet = cn(
  'fixed inset-x-0 bottom-0 z-50 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[22px] bg-popover text-popover-foreground outline-none',
  'shadow-[0_-12px_40px_-12px_rgba(13,21,38,.28)] ring-1 ring-foreground/8 supports-[height:100dvh]:max-h-[92dvh]',
  'data-open:animate-in data-open:slide-in-from-bottom-10 data-closed:animate-out data-closed:slide-out-to-bottom-10',
  'sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl',
  'sm:shadow-[0_24px_64px_-24px_rgba(13,21,38,.35)] sm:data-open:slide-in-from-bottom-0 sm:data-open:zoom-in-95 sm:data-closed:slide-out-to-bottom-0 sm:data-closed:zoom-out-95',
);

/* 手机上顶边一道小把手，提示这是可以收起的一层 */
function Grabber() {
  return <span aria-hidden className="mx-auto mt-2.5 block h-1 w-9 shrink-0 rounded-full bg-foreground/15 sm:hidden" />;
}

function CloseX({ className }: { className?: string }) {
  const tr = useT();
  return (
    <DialogPrimitive.Close asChild>
      <Button variant="ghost" size="icon-sm" className={cn('absolute top-3.5 right-3.5 text-muted-foreground', className)}>
        <XIcon />
        <span className="sr-only">{tr('关闭')}</span>
      </Button>
    </DialogPrimitive.Close>
  );
}

/* ───────────────────────── 阅读 ───────────────────────── */

export function ReadingDialog({
  open, onOpenChange, meta, title, children, footer, className,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** 标题上方的一行小字：标签、编号、日期 */
  meta?: ReactNode;
  title: ReactNode;
  children: ReactNode;
  /** 底部不动的一栏：工单的回复框、公告的「关闭」 */
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-slot="panel-overlay" className={overlay} />
        <DialogPrimitive.Content data-slot="reading-content" aria-describedby={undefined} className={cn(sheet, 'sm:max-h-[min(86vh,780px)] sm:max-w-[640px]', className)}>
          <Grabber />
          <header className="relative shrink-0 border-b border-border px-6 pt-5 pb-5 sm:px-8 sm:pt-7">
            {meta && <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pr-8 text-[12px] text-muted-foreground">{meta}</div>}
            <DialogPrimitive.Title className="mt-2.5 pr-8 text-[20px] leading-[1.35] font-medium tracking-[-0.02em] text-balance sm:text-[22px]">
              {title}
            </DialogPrimitive.Title>
            <CloseX />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
            <div className="max-w-[62ch]">{children}</div>
          </div>
          {footer && (
            <footer className="shrink-0 border-t border-border px-6 pt-3.5 pb-[max(14px,env(safe-area-inset-bottom))] sm:px-8">
              {footer}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ───────────────────────── 确认 ───────────────────────── */

type Tone = 'warning' | 'danger' | 'brand';

const TONE: Record<Tone, { disc: string; button: string }> = {
  warning: { disc: 'bg-amber-500/12 text-warning', button: 'bg-warning text-white hover:bg-warning/90' },
  danger: { disc: 'bg-red-500/10 text-danger', button: 'bg-red-600 text-white hover:bg-red-700' },
  brand: { disc: 'bg-brand/10 text-brand-ink', button: '' },
};

export function ConfirmDialog({
  trigger, tone = 'warning', icon, title, description, consequences, confirmLabel, cancelLabel, pending, onConfirm,
}: {
  trigger: ReactNode;
  tone?: Tone;
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** 点下去之后会发生的事，一条一句 */
  consequences?: ReactNode[];
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  pending?: boolean;
  onConfirm: () => void;
}) {
  const tr = useT();
  const t = TONE[tone];
  return (
    <AlertPrimitive.Root>
      <AlertPrimitive.Trigger asChild>{trigger}</AlertPrimitive.Trigger>
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay data-slot="panel-overlay" className={overlay} />
        <AlertPrimitive.Content
          data-slot="confirm-content"
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(sheet, 'px-6 pb-[max(24px,env(safe-area-inset-bottom))] sm:max-w-[420px] sm:px-7 sm:pb-7')}
        >
          <Grabber />
          <div className="flex items-start gap-4 pt-5 sm:pt-7">
            <span className={cn('grid size-10 shrink-0 place-items-center rounded-full [&_svg]:size-5', t.disc)}>{icon}</span>
            <div className="min-w-0 pt-1">
              <AlertPrimitive.Title className="text-[16.5px] leading-[1.45] font-medium tracking-[-0.01em] text-balance">{title}</AlertPrimitive.Title>
              {description && (
                <AlertPrimitive.Description className="mt-1.5 text-[13.5px] leading-[1.75] text-pretty text-muted-foreground">{description}</AlertPrimitive.Description>
              )}
            </div>
          </div>
          {consequences && consequences.length > 0 && (
            <ul className="mt-5 space-y-2 rounded-xl bg-muted/60 px-4 py-3.5 text-[13px] leading-[1.6] font-normal text-body">
              {consequences.map((c, i) => (
                <li key={i} className="flex gap-2.5">
                  <span aria-hidden className={cn('mt-[7px] size-1.5 shrink-0 rounded-full', tone === 'brand' ? 'bg-brand' : tone === 'danger' ? 'bg-red-500' : 'bg-amber-500')} />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-6 grid grid-cols-2 gap-2.5">
            <AlertPrimitive.Cancel asChild>
              <Button variant="outline" className="h-10">{cancelLabel ?? tr('取消')}</Button>
            </AlertPrimitive.Cancel>
            <AlertPrimitive.Action asChild>
              <Button className={cn('h-10', t.button)} disabled={pending} onClick={onConfirm}>{confirmLabel}</Button>
            </AlertPrimitive.Action>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}

/* ───────────────────────── 流程 ───────────────────────── */

export function FlowDialog({
  open, onOpenChange, tone = 'brand', icon, title, description, toolbar, children, className,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** 图标底色：危险流程（注销账户）用 danger */
  tone?: Tone;
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** 标题下面、正文上面的一行：页签之类 */
  toolbar?: ReactNode;
  /** 正文。最后放一个 <FlowFooter>，它会贴在底部不动 */
  children: ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-slot="panel-overlay" className={overlay} />
        <DialogPrimitive.Content
          data-slot="flow-content"
          /* 没有说明文字时告诉 Radix 别找它，不然控制台里一条警告 */
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(sheet, 'sm:max-h-[min(88vh,820px)] sm:max-w-[560px]', className)}
        >
          <Grabber />
          <header className="relative flex shrink-0 items-start gap-3.5 px-6 pt-5 pb-4 sm:px-7 sm:pt-6">
            {icon && <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl [&_svg]:size-[18px]', TONE[tone].disc)}>{icon}</span>}
            <div className="min-w-0 pr-8">
              <DialogPrimitive.Title className="text-[17px] leading-[1.4] font-medium tracking-[-0.015em]">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="mt-0.5 text-[13px] leading-[1.6] text-muted-foreground">{description}</DialogPrimitive.Description>}
            </div>
            <CloseX />
          </header>
          {toolbar && <div className="shrink-0 px-6 pb-4 sm:px-7">{toolbar}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 sm:px-7">
            <div className="flex min-h-full flex-col gap-6 pt-1">{children}</div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * 流程弹窗的小结栏：放在正文最后，滚动时贴住底边。
 * 左边一句「这一步的结果」，右边是按钮；没有结果可说时左边留空，按钮照样靠右。
 */
export function FlowFooter({ summary, children }: { summary?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-6 mt-auto flex items-center gap-4 border-t border-border bg-popover/95 px-6 pt-3.5 pb-[max(14px,env(safe-area-inset-bottom))] backdrop-blur supports-backdrop-filter:bg-popover/85 sm:-mx-7 sm:px-7 sm:pb-4">
      <div className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-muted-foreground">{summary}</div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * 流程里真正有先后的一步：编号 + 小标题。只在有顺序的流程里用（先选周期、再用优惠券、再选付款方式），
 * 普通表单的字段别套它，编号会让人以为有先后。
 */
export function FlowStep({ n, title, aside, children }: { n: number; title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="tnum grid size-5 shrink-0 place-items-center rounded-full border border-border text-[11px] leading-none font-medium text-muted-foreground">{n}</span>
        <h3 className="text-[14px] font-medium">{title}</h3>
        {aside && <span className="ml-auto text-[12px] text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}
