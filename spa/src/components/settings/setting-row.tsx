import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useReducedMotion } from '@/lib/motion';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * 设置行：左边名称 + 说明（1/3），右边当前值 + 操作（2/3），按钮与名称顶对齐；手机上上下两层。
 * 设置页只放「可以改的东西」，每一项一行（2026-10 设置页走查，design/portal-settings-audit-2026-10）。
 */
export function SettingRow({ title, desc, children, className }: {
  title: ReactNode; desc?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <div className={cn('set-row', className)}>
      <div className="min-w-0">
        <div className="set-row-t">{title}</div>
        {desc && <div className="set-row-d">{desc}</div>}
      </div>
      {children && <div className="set-row-r">{children}</div>}
    </div>
  );
}

export type SettingsPart = { id: string; label: string };

/**
 * 分区导航：桌面是左侧吸顶的竖排，手机是页头下面吸顶的横排（可横滑）。
 * 滚动时高亮当前分区（视口上部 1/3 处的那一个）；点击走锚点（地址栏带 #id，可以分享、刷新后回到原处）。
 */
export function SettingsNav({ parts }: { parts: SettingsPart[] }) {
  const tr = useT();
  const nav = useNavigate();
  const still = useReducedMotion();
  const [active, setActive] = useState(parts[0]?.id);
  useEffect(() => {
    const els = parts.map((p) => document.getElementById(p.id)).filter((e): e is HTMLElement => !!e);
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const first = parts.find((p) => seen.get(p.id));
      if (first) setActive(first.id);
    }, { rootMargin: '-72px 0px -62% 0px' });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [parts]);
  return (
    <nav aria-label={tr('设置分区')} className="settings-nav">
      <ul className="scroll-row">
        {parts.map((p) => (
          <li key={p.id}>
            <a
              href={`#${p.id}`} aria-current={active === p.id ? 'location' : undefined} className="settings-nav-link"
              onClick={(e) => {
                e.preventDefault();
                nav({ hash: p.id }, { replace: true, preventScrollReset: true });
                document.getElementById(p.id)?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
              }}
            >
              {p.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
