import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useT } from '@/i18n';
import { R } from '@/lib/routes';
import { useSite } from '@/lib/site';

/* 每个路由在浏览器标签页上的名字（与导航里的叫法一致） */
const TITLES: Record<string, string> = {
  [R.dashboard]: '仪表盘',
  [R.shop]: '商店',
  [R.nodes]: '节点状态',
  [R.traffic]: '使用明细',
  [R.orders]: '我的订单',
  [R.wallet]: '钱包',
  [R.invite]: '邀请',
  [R.tickets]: '工单',
  [R.help]: '文档',
  [R.announcements]: '公告与动态',
  [R.account]: '设置',
  [R.login]: '登录',
  [R.register]: '注册',
  [R.forgot]: '找回密码',
  [R.reset]: '重置密码',
  [R.deleted]: '账户已注销',
  [R.terms]: '服务条款',
  [R.privacy]: '隐私政策',
};

/** 浏览器标签页标题 =「页面名 · 站点名」（站点名来自 /auth/options，后台改了已打开的页面下次取设置时跟上） */
function pageTitle(pathname: string): string | null {
  if (TITLES[pathname]) return TITLES[pathname];
  if (pathname.startsWith(`${R.orders}/`)) return '订单详情';
  return null;
}

export default function DocumentTitle() {
  const { pathname } = useLocation();
  const tr = useT();
  const site = useSite();
  useEffect(() => {
    if (site.loading) return;
    const page = pageTitle(pathname);
    document.title = page ? `${tr(page)} · ${site.title}` : site.title;
  }, [pathname, tr, site.title, site.loading]);
  return null;
}
