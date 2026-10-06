// The console shell (W33-a design): collapsible sidebar (remembered),
// top bar (breadcrumb, Ctrl+K search, language, theme, alerts, account
// menu), mobile drawer navigation and the command palette.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get, logout, qs } from "../shared/api";
import { adminBase, loadPage, loginBase } from "../shared/base";
import { cn } from "../shared/cn";
import { useLang, useSetLang, useTr } from "../shared/i18n";
import { useTheme } from "../shared/theme";
import { Icon, type IconName } from "../shared/ui/icons";
import { MenuItem, Popover, useToast } from "../shared/ui/overlays";
import { Badge, Button, Kbd } from "../shared/ui/primitives";
import { ALL_NAV, NAV, type NavItem } from "./nav";
import { navigate } from "./router";
import { useBadges, useMe, useSite } from "./session";

function readCollapsed() {
  try {
    return localStorage.getItem("akari.admin.sidebar") === "collapsed";
  } catch {
    return false;
  }
}

export function Shell({ page, children }: { page: string; children: ReactNode }) {
  const tr = useTr();
  const lang = useLang();
  const setLang = useSetLang();
  const [theme, toggleTheme] = useTheme();
  const me = useMe();
  const site = useSite();
  const toast = useToast();
  const badges = useBadges();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileNav, setMobileNav] = useState(false);
  const [palette, setPalette] = useState(false);
  const [userMenu, setUserMenu] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("akari.admin.sidebar", collapsed ? "collapsed" : "expanded");
    } catch {
      /* storage blocked */
    }
  }, [collapsed]);

  const count = (it: NavItem): number => {
    if (!badges.data) return 0;
    if (it.badge === "tickets") return badges.data.tickets_unread;
    if (it.badge === "alerts") return badges.data.alerts_firing;
    return 0;
  };
  const current = ALL_NAV.find((n) => n.id === page);
  const signOut = async () => {
    try {
      await logout();
      loadPage(loginBase);
    } catch {
      toast({ tone: "error", title: tr("退出失败，请重试", "Sign-out failed; try again") });
    }
  };

  const sidebar = (mobile: boolean) => {
    const narrow = collapsed && !mobile;
    return (
      <nav className="flex h-full flex-col" aria-label={tr("主导航", "Main navigation")}>
        <div
          className={cn(
            "flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4",
            narrow && "justify-center px-0",
          )}
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-[13px] font-bold text-primary-foreground">
            {site.siteName.slice(0, 1)}
          </div>
          {!narrow && (
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold leading-tight">{site.siteName}</div>
              <div className="text-[11px] leading-tight text-muted-foreground">{tr("管理后台", "Admin console")}</div>
            </div>
          )}
          {mobile && (
            <Button
              variant="ghost"
              size="icon-sm"
              icon="x"
              className="ml-auto"
              onClick={() => setMobileNav(false)}
              aria-label={tr("关闭菜单", "Close menu")}
            />
          )}
        </div>
        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto px-2 py-3">
          {NAV.map((g) => (
            <div key={g.zh}>
              {!narrow && (
                <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {tr(g.zh, g.en)}
                </div>
              )}
              {narrow && <div className="mx-auto mb-1 h-px w-6 bg-border" />}
              <ul className="space-y-0.5">
                {g.items.map((it) => {
                  const active = it.id === page;
                  const n = count(it);
                  return (
                    <li key={it.id}>
                      <a
                        href={it.id === "dashboard" ? adminBase : `${adminBase}/${it.id}`}
                        title={narrow ? tr(it.zh, it.en) : undefined}
                        aria-current={active ? "page" : undefined}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(it.id === "dashboard" ? "" : `/${it.id}`);
                          setMobileNav(false);
                        }}
                        className={cn(
                          "relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors",
                          active
                            ? "bg-sidebar-accent font-medium text-foreground"
                            : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                          narrow && "justify-center px-0",
                        )}
                      >
                        {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />}
                        <Icon name={it.icon} size={16} className={active ? "text-primary" : "text-muted-foreground"} />
                        {!narrow && (
                          <>
                            <span className="flex-1 truncate text-left">{tr(it.zh, it.en)}</span>
                            {n > 0 && (
                              <span
                                className="rounded-full bg-destructive-soft px-1.5 text-[11px] font-medium text-destructive"
                                aria-label={tr(`${n} 条待处理`, `${n} pending`)}
                              >
                                {n}
                              </span>
                            )}
                          </>
                        )}
                        {narrow && n > 0 && (
                          <span className="absolute right-1.5 top-1 h-1.5 w-1.5 rounded-full bg-destructive" />
                        )}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        {!mobile && (
          <div className="border-t border-border p-2">
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-expanded={!collapsed}
              className={cn(
                "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground hover:bg-sidebar-accent/60",
                collapsed && "justify-center px-0",
              )}
            >
              <Icon name="panel" size={16} />
              {collapsed ? (
                <span className="sr-only">{tr("展开侧边栏", "Expand sidebar")}</span>
              ) : (
                tr("收起侧边栏", "Collapse sidebar")
              )}
            </button>
          </div>
        )}
      </nav>
    );
  };

  return (
    <div className="flex min-h-screen">
      <aside
        className={cn(
          "z-20 hidden shrink-0 border-r border-border bg-sidebar transition-[width] lg:block",
          collapsed ? "w-16" : "w-60",
        )}
        data-collapsed={collapsed}
      >
        <div className="sticky top-0 h-screen">{sidebar(false)}</div>
      </aside>
      {mobileNav && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileNav(false)} aria-hidden="true" />
          <aside className="anim-in absolute inset-y-0 left-0 w-72 border-r border-border bg-sidebar shadow-pop">
            {sidebar(true)}
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-1.5 border-b border-border bg-background/85 px-3 backdrop-blur sm:gap-2 sm:px-5">
          <Button
            variant="ghost"
            size="icon-sm"
            icon="menu"
            className="lg:hidden"
            onClick={() => setMobileNav(true)}
            aria-label={tr("菜单", "Menu")}
          />
          <div className="hidden min-w-0 items-center gap-1.5 text-sm text-muted-foreground sm:flex">
            <span>{site.siteName}</span>
            <Icon name="chevronRight" size={14} />
            <span className="truncate font-medium text-foreground">{current ? tr(current.zh, current.en) : ""}</span>
          </div>
          <span className="truncate text-sm font-medium sm:hidden">{current ? tr(current.zh, current.en) : ""}</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="hidden h-8 w-64 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-[13px] text-muted-foreground shadow-card hover:bg-muted md:flex"
          >
            <Icon name="search" size={14} />
            <span className="flex-1 text-left">{tr("搜索用户、订单、页面…", "Search users, orders, pages…")}</span>
            <Kbd>Ctrl K</Kbd>
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            icon="search"
            className="md:hidden"
            onClick={() => setPalette(true)}
            aria-label={tr("搜索", "Search")}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            icon="languages"
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
            aria-label={lang === "zh" ? "English" : "中文"}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            icon={theme === "dark" ? "sun" : "moon"}
            onClick={toggleTheme}
            aria-label={tr("切换主题", "Toggle theme")}
          />
          <div className="relative">
            <Button
              variant="ghost"
              size="icon-sm"
              icon="bell"
              onClick={() => navigate("/alerts")}
              aria-label={tr(
                `告警（${badges.data?.alerts_firing ?? 0} 条正在告警）`,
                `Alerts (${badges.data?.alerts_firing ?? 0} firing)`,
              )}
            />
            {(badges.data?.alerts_firing ?? 0) > 0 && (
              <span className="pointer-events-none absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-destructive ring-2 ring-background" />
            )}
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setUserMenu((v) => !v)}
              aria-label={tr("账户菜单", "Account menu")}
              className="ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold uppercase text-primary"
            >
              {me.email.slice(0, 2)}
            </button>
            <Popover open={userMenu} onClose={() => setUserMenu(false)}>
              <div className="px-2.5 py-2">
                <div className="truncate text-[13px] font-medium">{me.email}</div>
                <div className="text-xs text-muted-foreground">
                  {me.is_owner ? tr("所有者 · 管理员", "Owner · admin") : tr("管理员", "Admin")}
                </div>
              </div>
              <div className="my-1 h-px bg-border" />
              <MenuItem
                icon="fingerprint"
                onClick={() => {
                  setUserMenu(false);
                  navigate("/account");
                }}
              >
                {tr("通行密钥与密码", "Passkeys & password")}
              </MenuItem>
              <MenuItem icon="logout" danger onClick={signOut}>
                {tr("退出登录", "Sign out")}
              </MenuItem>
            </Popover>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 sm:py-6">{children}</main>
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} onTheme={toggleTheme} />}
    </div>
  );
}

/* ---------------- Command palette (Ctrl+K) ---------------- */
type Cmd = { id: string; group: string; label: string; hint?: string; icon: IconName; run: () => void };

type UserHit = { id: string; email: string; plan_name: string | null };
type OrderHit = { id: string; out_trade_no: string; amount_cents: number };

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function CommandPalette({ onClose, onTheme }: { onClose: () => void; onTheme: () => void }) {
  const tr = useTr();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const term = useDebounced(q.trim(), 250);
  const users = useQuery({
    queryKey: ["palette", "users", term],
    queryFn: () => get<{ users: UserHit[] }>(`/users${qs({ q: term, limit: 5 })}`),
    enabled: term.length >= 2,
  });
  const orders = useQuery({
    queryKey: ["palette", "orders", term],
    queryFn: () => get<OrderHit[]>(`/orders${qs({ out_trade_no: term, limit: 5 })}`),
    enabled: /^[A-Za-z0-9_-]{6,}$/.test(term),
  });

  const all = useMemo<Cmd[]>(() => {
    const go = (to: string) => () => {
      navigate(to);
      onClose();
    };
    const pages = tr("页面", "Pages");
    const actions = tr("操作", "Actions");
    return [
      ...ALL_NAV.map((n) => ({
        id: `p-${n.id}`,
        group: pages,
        label: tr(n.zh, n.en),
        icon: n.icon,
        run: go(n.id === "dashboard" ? "" : `/${n.id}`),
      })),
      { id: "a-user", group: actions, label: tr("新建用户", "New user"), icon: "plus", run: go("/users?new=1") },
      {
        id: "a-node",
        group: actions,
        label: tr("添加落地节点", "Add a node"),
        icon: "server",
        run: go("/nodes?new=node"),
      },
      {
        id: "a-server",
        group: actions,
        label: tr("添加服务器", "Add a server"),
        icon: "server",
        run: go("/nodes?new=server"),
      },
      {
        id: "a-never",
        group: actions,
        label: tr("筛选从未使用的账号", "Filter never-used accounts"),
        icon: "filter",
        run: go("/users?never_used=1"),
      },
      {
        id: "a-mail",
        group: actions,
        label: tr("测试发信", "Send a test mail"),
        icon: "mail",
        run: go("/settings/mail"),
      },
      {
        id: "a-order",
        group: actions,
        label: tr("新建人工订单", "New manual order"),
        icon: "receipt",
        run: go("/orders?new=1"),
      },
      {
        id: "a-theme",
        group: actions,
        label: tr("切换深色 / 浅色", "Toggle dark / light"),
        icon: "moon",
        run: () => {
          onTheme();
          onClose();
        },
      },
      ...(users.data?.users ?? []).map((u) => ({
        id: `u-${u.id}`,
        group: tr("用户", "Users"),
        label: u.email,
        hint: u.plan_name ?? tr("无套餐", "No plan"),
        icon: "user" as IconName,
        run: go(`/users?open=${u.id}`),
      })),
      ...(orders.data ?? []).map((o) => ({
        id: `o-${o.id}`,
        group: tr("订单", "Orders"),
        label: o.out_trade_no,
        hint: `¥${(o.amount_cents / 100).toFixed(2)}`,
        icon: "receipt" as IconName,
        run: go(`/orders?open=${o.id}`),
      })),
    ];
  }, [tr, onClose, onTheme, users.data, orders.data]);

  const needle = q.trim().toLowerCase();
  const list = needle
    ? all.filter(
        (c) =>
          c.id.startsWith("u-") || c.id.startsWith("o-") || (c.label + (c.hint ?? "")).toLowerCase().includes(needle),
      )
    : all;
  const groups = [...new Set(list.map((c) => c.group))];
  useEffect(() => setIdx(0), [q]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-[10vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tr("命令面板", "Command palette")}
        className="anim-in relative w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover shadow-pop"
      >
        <div className="flex items-center gap-2 border-b border-border px-3.5">
          <Icon name="search" size={16} className="text-muted-foreground" />
          <input
            ref={input}
            value={q}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-label={tr("搜索", "Search")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(list.length - 1, i + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              }
              if (e.key === "Enter") list[idx]?.run();
              if (e.key === "Escape") onClose();
            }}
            placeholder={tr("输入页面、操作、邮箱或订单号…", "Type a page, action, email or order no…")}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div id="palette-list" role="listbox" className="scroll-thin max-h-[60vh] overflow-y-auto p-1.5">
          {list.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">{tr("没有结果", "No results")}</div>
          )}
          {groups.map((g) => (
            <div key={g} className="pb-1">
              <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {g}
              </div>
              {list
                .filter((c) => c.group === g)
                .map((c) => {
                  const i = list.indexOf(c);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={i === idx}
                      onMouseEnter={() => setIdx(i)}
                      onClick={c.run}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px]",
                        i === idx && "bg-muted",
                      )}
                    >
                      <Icon name={c.icon} size={15} className="text-muted-foreground" />
                      <span className="flex-1 truncate">{c.label}</span>
                      {c.hint && <span className="text-xs text-muted-foreground">{c.hint}</span>}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-border bg-subtle px-3.5 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> {tr("选择", "navigate")}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd> {tr("打开", "open")}
          </span>
          {(users.isFetching || orders.isFetching) && (
            <Badge tone="outline" className="ml-auto">
              {tr("搜索中…", "Searching…")}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}
