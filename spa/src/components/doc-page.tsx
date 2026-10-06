import type { ReactNode } from 'react';
import { useT, useTp } from '@/i18n';
import HashLink from '@/components/hash-link';
import { useEnter } from '@/lib/motion';

export type DocSection = { h: string; body: ReactNode };

/**
 * 长文页外壳（服务条款 / 隐私政策）。
 * 左侧 sticky 目录 + 右侧正文压在 1px 竖线上——和落地页正文的脊线是同一套骨架，
 * 免得法务页看起来像另一个网站贴进来的。
 */
export default function DocPage({
  title, updated, intro, introVars, sections,
}: {
  title: string;
  updated: string;
  intro: string;
  /** intro 里的占位符，比如 {site}；给了就按带变量的整句翻译 */
  introVars?: Record<string, string | number>;
  sections: DocSection[];
}) {
  const tr = useT();
  const tp = useTp();
  const enter = useEnter();
  return (
    <div className="page-wrap pt-14 pb-24">
      <header {...enter()} className="max-w-[62ch] border-b border-border pb-10">
        <div className="text-[12.5px] tracking-[.08em] text-muted-foreground">{tr('最后更新')} {updated}</div>
        <h1 className="page-title mt-3.5">{tr(title)}</h1>
        <p className="page-sub">{introVars ? tp(intro, introVars) : tr(intro)}</p>
      </header>

      <div className="grid gap-x-14 pt-12 lg:grid-cols-[190px_1fr]">
        <nav aria-label={tr('目录')} className="mb-10 hidden self-start lg:sticky lg:top-[92px] lg:mb-0 lg:block">
          <div className="text-[12px] tracking-[.16em] text-muted-foreground">{tr('目录')}</div>
          <ol className="mt-4 flex flex-col gap-2.5">
            {sections.map((s, i) => (
              <li key={s.h} className="flex gap-3 text-[13.5px] leading-[1.5]">
                <span className="tnum shrink-0 text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                <HashLink id={`s${i + 1}`} className="text-muted-foreground transition-colors hover:text-foreground">
                  {tr(s.h)}
                </HashLink>
              </li>
            ))}
          </ol>
        </nav>

        <div className="min-w-0 lg:border-l lg:border-border lg:pl-14">
          {sections.map((s, i) => (
            <section key={s.h} id={`s${i + 1}`} className="scroll-mt-[92px] border-b border-border py-9 first:pt-0 last:border-b-0">
              <div className="flex gap-4">
                <span className="tnum mt-[3px] shrink-0 text-[13px] font-medium text-brand">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0">
                  <h2 className="text-[19px] font-medium tracking-[-0.02em]">{tr(s.h)}</h2>
                  <div className="doc-body mt-4">{s.body}</div>
                </div>
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
