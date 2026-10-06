import { Link, useNavigate } from 'react-router-dom';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LENS_PATH } from '@/components/logo';
import { R } from '@/lib/routes';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * 出错页统一的样子：一座**灭掉的**灯塔。
 * 用的就是品牌印章里那枚镜面（LENS_PATH），只是这一次里面没有光，
 * 只有一道扫过去、什么也没找到的束光。四种错误共用它，区别只在文案与出口。
 */

export type ErrorKind = 'notfound' | 'crash' | 'chunk' | 'offline';

const COPY: Record<ErrorKind, { code: string; title: string; desc: string }> = {
  notfound: {
    code: '404',
    title: '这片海图上没有这一页',
    desc: '地址可能拼错了，或者这个页面已经被移走。下面几个入口是常去的地方。',
  },
  crash: {
    code: '500',
    title: '灯灭了一下',
    desc: '页面在渲染时出了错，这是我们的问题，不是你的操作有误。刷新通常就能回来。',
  },
  chunk: {
    code: '—',
    title: '这一页没能下载完',
    desc: '要么是网络断在了半路，要么是我们刚发布了新版本。刷新一次就会取到完整的文件。',
  },
  offline: {
    code: '⚡',
    title: '网络断开了',
    desc: '设备当前不在线。恢复连接后这一页会自己好起来，也可以手动刷新。',
  },
};

/** 灭灯的镜面：品牌那枚镜面，只是里面没有光，外面一道缓慢扫过、什么也没找到的束光 */
function DarkLens() {
  return (
    <span className="err-lens" aria-hidden>
      <svg viewBox="0 0 100 100" className="relative size-[74px]">
        <path d={LENS_PATH} fillRule="evenodd" className="fill-muted-foreground/22" />
        <circle cx="50" cy="50" r="9" className="fill-muted-foreground/30" />
      </svg>
    </span>
  );
}

export default function ErrorScreen({
  kind, detail, onRetry, className,
}: {
  kind: ErrorKind;
  /** 开发期用得上的原始报错，只在有的时候折起来放在最下面 */
  detail?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const tr = useT();
  const nav = useNavigate();
  const c = COPY[kind];
  const reload = onRetry ?? (() => window.location.reload());

  return (
    <div className={cn('page-wrap flex min-h-[68vh] flex-col justify-center py-24', className)}>
      <div className="max-w-[52ch]">
        <div className="flex items-center gap-5">
          <DarkLens />
          <span className="tnum text-[42px] leading-none font-medium tracking-[-0.04em] text-faint">
            {c.code}
          </span>
        </div>

        <h1 className="page-title mt-9">{tr(c.title)}</h1>
        <p className="mt-4 text-[15px] leading-[1.9] text-muted-foreground">{tr(c.desc)}</p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          {kind === 'notfound' ? (
            <>
              <Button asChild className="h-10"><Link to="/">{tr('回首页')}</Link></Button>
              <Button variant="outline" className="h-10" onClick={() => nav(-1)}>{tr('返回上一页')}</Button>
            </>
          ) : (
            <>
              <Button className="h-10" onClick={reload}><RotateCw className="size-4" />{tr('刷新页面')}</Button>
              <Button asChild variant="outline" className="h-10"><Link to="/">{tr('回首页')}</Link></Button>
            </>
          )}
        </div>

        {/* 404 才给去处清单：其余几种错误刷新就好，列一堆链接反而分散注意 */}
        {kind === 'notfound' && (
          <nav className="mt-12 border-t border-border pt-7">
            <div className="text-[12px] tracking-[.16em] text-muted-foreground">{tr('常去的地方')}</div>
            <ul className="mt-4 flex flex-col">
              {[
                { to: R.shop, label: '套餐商店', d: '订阅方案与流量包' },
                { to: R.nodes, label: '节点状态', d: '当前可用线路与倍率' },
                { to: R.help, label: '使用文档', d: '接入、计费与常见问题' },
                { to: R.dashboard, label: '仪表盘', d: '账号状态、流量与订阅一览' },
              ].map((l, i) => (
                <li key={l.to}>
                  <Link
                    to={l.to}
                    className="group flex items-baseline gap-4 border-b border-border py-3.5 last:border-b-0"
                  >
                    <span className="tnum w-5 shrink-0 text-[12px] text-muted-foreground">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="text-[14.5px] font-medium transition-colors group-hover:text-brand">
                      {tr(l.label)}
                    </span>
                    <span className="text-[12.5px] text-muted-foreground">{tr(l.d)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {detail && (
          <details className="mt-10 text-[12.5px] text-muted-foreground">
            <summary className="cursor-pointer select-none">{tr('技术细节')}</summary>
            <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted/50 p-3.5 text-[11.5px] leading-[1.7] whitespace-pre-wrap">
              {detail}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
