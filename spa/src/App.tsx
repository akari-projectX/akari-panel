import { lazy, Suspense, useEffect, useRef } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import ErrorBoundary from '@/components/error-boundary';
import ErrorScreen from '@/components/error-screen';
import OfflineBar from '@/components/offline-bar';
import { PageLoading } from '@/components/loading';
import SiteLayout from '@/layouts/site-layout';
import DashLayout from '@/layouts/dash-layout';
import { preloadEN, useLocale } from '@/i18n';
import { LocaleProvider } from '@/i18n/provider';
import { AuthProvider, GuestOnly, RequireAuth, RequireScope, SiteProvider } from '@/lib/auth-provider';
import { startBoot, useBootOut } from '@/lib/boot';
import { warmHanFont } from '@/lib/han-font';
import { fastNetwork, whenIdle } from '@/lib/prefetch';
import { R } from '@/lib/routes';
import {
  Account, Announcements, Dashboard, Forgot, Help, Invite, Login, Nodes, OrderDetail, Orders, Privacy, Register,
  Reset, Shop, Terms, Tickets, Traffic, Wallet,
} from '@/pages/registry';

/*
 * 提示条按需加载：sonner 压缩前 53 kB，首屏又用不到。它和页面并行下载，不在首屏必经的挂载分包里。
 * 挂上之前调用的 toast 会排队等它，见 lib/toast。
 */
const Toaster = lazy(() => import('@/components/ui/sonner').then((m) => ({ default: m.Toaster })));


/**
 * 锚点滚动。回到页首不在这里做：切页时旧页面要先淡出，
 * 由 PageTransition 在旧页面退场之后滚回页首，这里一跳旧页面就会抖。
 *
 * 管三件事：
 *   · 带锚点的地址 —— 滚到对应区块。目标可能还没挂载（旧页面在淡出、分包在下载），
 *     所以逐帧重试，最多约 1.5 秒；同一页内平滑滚动，跨页则等新页面出来后直接到位；
 *   · 同一页里去掉锚点（落地页上点 Logo）—— 平滑回到页首，这时没有切页动画来接手；
 *   · 刷新后的第一屏 —— 站点页回到页首（用户中心保留浏览器恢复的位置）。
 */
/**
 * 预热另一种语言：每进一页，等启动画面收起、浏览器空闲，把切过去要用的东西先下载好——
 * 中文界面预热英文词典，英文界面预热「切到中文时这一页要用的字体切片」（见 lib/han-font）。
 * 以前点了切换才开始下载，要等一会儿才切过去，或者新语言先用系统字体露一下再跳。省流量模式、不到 4G 的网络下不预热。
 */
function WarmOtherLocale() {
  const { pathname } = useLocation();
  const { locale } = useLocale();
  const out = useBootOut();
  useEffect(() => {
    if (!out) return;
    if (!fastNetwork()) return;
    return whenIdle(() => {
      if (locale === 'en') void warmHanFont('zh-CN');
      else preloadEN();
    });
  }, [pathname, locale, out]);
  return null;
}

/* 刷新后回到页首的站点页（用户中心保留浏览器恢复的位置） */
const SITE_PATHS = new Set<string>([R.terms, R.privacy, R.login, R.register, R.forgot, R.reset]);

function ScrollTop() {
  const { pathname, hash } = useLocation();
  const prev = useRef<{ p: string; h: string } | null>(null);
  useEffect(() => {
    const from = prev.current;
    /* StrictMode 下挂载时 effect 会跑两遍，同一个地址不重复处理 */
    if (from && from.p === pathname && from.h === hash) return;
    prev.current = { p: pathname, h: hash };

    /* 重置链接的 #token=… 不是锚点 */
    if (!hash || hash.includes('=')) {
      if (!from) { if (SITE_PATHS.has(pathname)) window.scrollTo({ top: 0 }); }
      else if (from.p === pathname) window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const id = decodeURIComponent(hash.slice(1));
    const samePage = from?.p === pathname;
    let raf = 0;
    let tries = 0;
    const jump = () => {
      const el = document.getElementById(id);
      if (el) { el.scrollIntoView({ behavior: samePage ? 'smooth' : 'auto' }); return; }
      if (++tries < 90) raf = requestAnimationFrame(jump);
    };
    jump();
    return () => cancelAnimationFrame(raf);
  }, [pathname, hash]);
  return null;
}

/* 按账户范围开放的页面，见 lib/routes 的 PAGE_SCOPES */
const SHOP = ['full', 'renewal'] as const;
const scoped = (allow: readonly ('full' | 'renewal' | 'banned')[], el: React.ReactNode) =>
  <RequireScope allow={[...allow]}>{el}</RequireScope>;

export default function App() {
  /* 子组件的占位都登记完 hold 之后才会走到这里，见 lib/boot.ts */
  useEffect(() => { startBoot(); }, []);

  return (
    <LocaleProvider>
    <TooltipProvider delayDuration={200}>
      {/*
        BrowserRouter：门户在主域名根路径（D11）。面板对路由表里的每个顶层路径都返回 index.html
        （akari-panel access::PORTAL_PAGES，测试保证两边一致）；路由表见 lib/routes。
      */}
      <BrowserRouter>
      <SiteProvider>
      <AuthProvider>
        <ScrollTop />
        <WarmOtherLocale />
        {/*
          兜底的 ErrorBoundary 在最外层：布局本身崩了也还有一页可看。
          各布局内部还有一层，那一层崩了导航栏能留住。
        */}
        <ErrorBoundary>
          {/* SiteLayout / DashLayout 内部各有一层 Suspense；这一层兜住布局本身的分包 */}
          <Suspense fallback={<PageLoading className="min-h-screen" />}>
            <Routes>
              <Route element={<SiteLayout />}>
                <Route path={R.terms} element={<Terms />} />
                <Route path={R.privacy} element={<Privacy />} />
                {/* GuestOnly：已登录的人点回登录页时直接送进用户中心，而不是让他再登一次 */}
                <Route path={R.login} element={<GuestOnly><Login /></GuestOnly>} />
                <Route path={R.register} element={<GuestOnly><Register /></GuestOnly>} />
                <Route path={R.forgot} element={<GuestOnly><Forgot /></GuestOnly>} />
                {/* 邮件里的重置链接（#token=…）：登录与否都能用 */}
                <Route path={R.reset} element={<Reset />} />
              </Route>
              <Route element={<RequireAuth><DashLayout /></RequireAuth>}>
                <Route index element={<Dashboard />} />
                <Route path={R.shop} element={scoped(SHOP, <Shop />)} />
                <Route path={R.orders} element={scoped(SHOP, <Orders />)} />
                {/* 下单后停在这一页付款、查状态；订单列表点进来看的也是它 */}
                <Route path={`${R.orders}/:id`} element={scoped(SHOP, <OrderDetail />)} />
                <Route path={R.wallet} element={scoped(SHOP, <Wallet />)} />
                <Route path={R.help} element={scoped(SHOP, <Help />)} />
                <Route path={R.announcements} element={scoped(SHOP, <Announcements />)} />
                <Route path={R.account} element={scoped(SHOP, <Account />)} />
                <Route path={R.tickets} element={scoped(['full', 'renewal', 'banned'], <Tickets />)} />
                <Route path={R.nodes} element={scoped(['full'], <Nodes />)} />
                <Route path={R.traffic} element={scoped(['full'], <Traffic />)} />
                <Route path={R.invite} element={scoped(['full'], <Invite />)} />
              </Route>
              <Route element={<SiteLayout />}>
                {/* 走错地址的人应该知道自己走错了，而不是被悄悄送回首页 */}
                <Route path="*" element={<ErrorScreen kind="notfound" />} />
              </Route>
            </Routes>
          </Suspense>
        </ErrorBoundary>
        <OfflineBar />
        <Suspense fallback={null}><Toaster /></Suspense>
      </AuthProvider>
      </SiteProvider>
      </BrowserRouter>
    </TooltipProvider>
    </LocaleProvider>
  );
}
