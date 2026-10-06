import { Suspense, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { DashHeader } from '@/layouts/dash-layout';
import SiteFooter from '@/components/site-footer';
import ErrorBoundary from '@/components/error-boundary';
import { DocSkeleton } from '@/components/loading';
import FrozenOutlet from '@/components/frozen-outlet';
import PageTransition from '@/components/page-transition';
import { LocaleToggle, ThemeToggle } from '@/components/prefs';
import { Logo } from '@/components/logo';
import { useT } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { prefetchSite, whenIdle } from '@/lib/prefetch';
import { useSite } from '@/lib/site';
import { R } from '@/lib/routes';
import { cn } from '@/lib/utils';

/**
 * 访客/未登录时的轻量页头：
 * 高度与样式（h-16, sticky, border-b）与用户中心 DashHeader 完全一致，
 * 不再有旧落地页的浮动 fixed 动画、也不把服务条款/隐私政策塞在顶部导航里。
 */
function GuestHeader() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const tr = useT();
  const site = useSite();

  /* 底色 95% 不透明，模糊只给一档：sticky 页头上的大半径 backdrop-filter 每次滚动都要重新模糊下面整条内容，是中低端机滚动掉帧的主因 */
  return (
    <header className="sticky top-0 z-30 h-16 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="page-wrap flex h-full items-center justify-between gap-6">
        <div className="flex items-center gap-8">
          <Link to={R.login} className="shrink-0"><Logo /></Link>
          <nav className="hidden items-center gap-6 sm:flex">
            <Link
              to={R.faq}
              className={cn(
                'text-[14px] font-medium transition-colors hover:text-brand',
                pathname === R.faq ? 'text-brand' : 'text-muted-foreground',
              )}
            >
              {tr('常见问题')}
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
          <LocaleToggle />

          {pathname !== R.login && (
            <Button variant="ghost" size="sm" onClick={() => nav(R.login)}>
              {tr('登录')}
            </Button>
          )}

          {pathname !== R.register && !site.loading && (
            !site.registerOpen ? (
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-amber-500" />
                {tr('暂停注册')}
              </span>
            ) : (
              <Button size="sm" onClick={() => nav(R.register)}>
                {tr('创建账号')}
              </Button>
            )
          )}
        </div>
      </div>
    </header>
  );
}

export default function SiteLayout() {
  const { pathname } = useLocation();
  const { authed } = useAuth();

  /* 空闲时把其余站点页的分包取好，切页时新页面直接渲染，不经过骨架 */
  useEffect(() => whenIdle(prefetchSite), []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* 已登录时复用用户中心的完整导航（仪表盘/商店/文档/工单/用户菜单），未登录时显示统一的访客页头 */}
      {authed ? <DashHeader /> : <GuestHeader />}

      <main className="flex-1">
        <PageTransition id={pathname}>
          <ErrorBoundary>
            <Suspense fallback={<DocSkeleton />}>
              <FrozenOutlet />
            </Suspense>
          </ErrorBoundary>
        </PageTransition>
      </main>

      <SiteFooter />
    </div>
  );
}
