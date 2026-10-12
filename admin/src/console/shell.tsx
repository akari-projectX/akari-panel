// The console shell (2026-10 redesign, macOS-like; screenshots in
// design/admin-redesign-2026-10/):
// - desktop (≥1024px): a floating frosted sidebar (brand header with the
//   panel version and the collapse chevron, grouped navigation with pending
//   counts, collapsible and remembered, the account card at the bottom) and
//   a frosted toolbar (search / Ctrl+K on the left; theme and the alerts
//   bell on the right). Language, theme and sign-out are in the account
//   menu;
// - phone: a frosted top bar (brand, search, bell, account menu) and a
//   bottom tab bar (dashboard, users, orders, tickets, more — SPRINT
//   admin-redesign-1012 ⑦); "More" lists every page;
// - the command palette (Ctrl/⌘ K).
// The main area carries data-page / data-ready (the page's data has
// arrived) for the e2e timing suite.
import { useIsFetching } from "@tanstack/react-query";
import { Bell, ChevronsLeft, ChevronsRight, Fingerprint, Languages, LogOut, Moon, Search, Sun } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigation } from "react-router";
import { logout } from "../shared/api";
import { loadPage, loginBase } from "../shared/base";
import { cn } from "../shared/cn";
import { useLang, useSetLang, useTr } from "../shared/i18n";
import { useTheme } from "../shared/theme";
import { BrandMark } from "../shared/ui/brand";
import { Kbd, MOD_KEY } from "../shared/ui/form";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../shared/ui/menu";
import { useToast } from "../shared/ui/toast";
import { NAV, TABS, pathOf, type NavItem } from "./nav";
import { prefetchPage } from "./pages";
import { navigate } from "./router";
import { useBadges, useMe, useSite, type Badges } from "./session";

// The command palette (cmdk) is its own chunk, loaded on first open (or
// when the search pill is hovered / focused), not with the shell.
const loadPalette = () => import("./palette");
const CommandPalette = lazy(() => loadPalette().then((m) => ({ default: m.CommandPalette })));

function readCollapsed() {
  try {
    return localStorage.getItem("akari.admin.sidebar") === "collapsed";
  } catch {
    return false;
  }
}

function count(it: NavItem, b: Badges | undefined): number {
  if (!b) return 0;
  if (it.badge === "tickets") return b.tickets_unread;
  if (it.badge === "alerts") return b.alerts_firing;
  return 0;
}

/** The site mark: the uploaded logo, else the Akari seal (shared/ui/brand). */
export function AppMark({ size = 28 }: { size?: number }) {
  const site = useSite();
  return <BrandMark name={site.siteName} logoUrl={site.logoUrl} size={size} />;
}

/** Account menu (sidebar card on a desktop, avatar on a phone): account, theme, language, sign out. */
function AccountMenu({ trigger, onTheme }: { trigger: ReactNode; onTheme: () => void }) {
  const tr = useTr();
  const me = useMe();
  const lang = useLang();
  const setLang = useSetLang();
  const toast = useToast();
  const signOut = async () => {
    try {
      await logout();
      loadPage(loginBase);
    } catch {
      toast({ tone: "error", title: tr("退出失败，请重试", "Sign-out failed; try again") });
    }
  };
  return (
    <Menu trigger={trigger} align="start" label={tr("账户菜单", "Account menu")} className="w-60">
      <MenuLabel>
        <span className="block truncate text-body font-medium text-foreground">{me.email}</span>
        <span className="block font-normal">
          {me.is_owner ? tr("所有者 · 管理员", "Owner · admin") : tr("管理员", "Admin")}
        </span>
      </MenuLabel>
      <MenuSeparator />
      <MenuItem icon={Fingerprint} onClick={() => navigate("/account")}>
        {tr("通行密钥与密码", "Passkeys & password")}
      </MenuItem>
      <MenuItem icon={Moon} onClick={onTheme}>
        {tr("切换深色 / 浅色", "Toggle dark / light")}
      </MenuItem>
      <MenuItem icon={Languages} onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
        {lang === "zh" ? "English" : "中文"}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={LogOut} danger onClick={() => void signOut()}>
        {tr("退出登录", "Sign out")}
      </MenuItem>
    </Menu>
  );
}

function Avatar({ email, size = 28 }: { email: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-linear-to-b from-[color-mix(in_srgb,var(--primary),white_32%)] to-primary font-semibold text-primary-foreground uppercase"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {email.slice(0, 1)}
    </span>
  );
}

function Sidebar({
  page,
  collapsed,
  onCollapse,
  onTheme,
}: {
  page: string;
  collapsed: boolean;
  onCollapse: () => void;
  onTheme: () => void;
}) {
  const tr = useTr();
  const site = useSite();
  const me = useMe();
  const badges = useBadges();
  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "glass fixed inset-y-2 left-2 z-30 hidden flex-col rounded-[18px] bg-(--glass-sidebar) shadow-[0_0_0_0.5px_var(--border),inset_0_0.5px_0_var(--glass-edge)] transition-[width] duration-(--dur-base) ease-(--ease-out) lg:flex",
        collapsed ? "w-[64px]" : "w-[232px]",
      )}
    >
      <div
        className={cn("flex items-center gap-2.5 px-4 pt-4 pb-3", collapsed && "flex-col justify-center gap-1.5 px-0")}
      >
        <AppMark />
        {!collapsed && (
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-headline font-semibold tracking-[-0.01em]">{site.siteName}</div>
            <div className="truncate text-caption text-muted-foreground">
              {tr("管理后台", "Admin console")}
              {__PANEL_VERSION__ && ` · v${__PANEL_VERSION__}`}
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={onCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? tr("展开侧边栏", "Expand sidebar") : tr("收起侧边栏", "Collapse sidebar")}
          title={collapsed ? tr("展开侧边栏", "Expand sidebar") : tr("收起侧边栏", "Collapse sidebar")}
          className="hit-44 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          {collapsed ? (
            <ChevronsRight className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronsLeft className="size-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
      <nav className="scroll-thin flex-1 overflow-y-auto px-2.5 pb-3" aria-label={tr("主导航", "Main navigation")}>
        {NAV.map((g) => (
          <div key={g.zh} className="mt-3 first:mt-1">
            {collapsed ? (
              <div className="mx-auto mb-1 h-px w-6 bg-separator" />
            ) : (
              <div className="px-2 pb-1 text-caption font-semibold text-faint">{tr(g.zh, g.en)}</div>
            )}
            <ul className="grid gap-px">
              {g.items.map((it) => {
                const active = it.id === page;
                const n = count(it, badges.data);
                return (
                  <li key={it.id}>
                    <Link
                      to={pathOf(it.id)}
                      title={collapsed ? tr(it.zh, it.en) : undefined}
                      aria-label={collapsed ? tr(it.zh, it.en) : undefined}
                      aria-current={active ? "page" : undefined}
                      onMouseEnter={() => prefetchPage(it.id)}
                      onFocus={() => prefetchPage(it.id)}
                      className={cn(
                        "relative flex h-8 items-center gap-2.5 rounded-[9px] px-2 text-body font-medium transition-colors duration-(--dur-hover)",
                        active
                          ? "bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)] text-foreground"
                          : "text-foreground/80 hover:bg-accent",
                        collapsed && "justify-center px-0",
                      )}
                    >
                      <it.icon
                        className={cn(
                          "size-[17px] shrink-0 stroke-[1.8]",
                          active ? "text-primary" : "text-muted-foreground",
                        )}
                        aria-hidden="true"
                      />
                      {!collapsed && <span className="flex-1 truncate">{tr(it.zh, it.en)}</span>}
                      {n > 0 &&
                        (collapsed ? (
                          <span className="absolute top-1 right-2 size-1.5 rounded-full bg-destructive" />
                        ) : (
                          <span
                            className="tnum rounded-full bg-destructive px-1.5 text-caption leading-4 font-semibold text-white"
                            aria-label={tr(`${n} 条待处理`, `${n} pending`)}
                          >
                            {n}
                          </span>
                        ))}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className={cn("m-2.5 mt-0 grid", collapsed && "m-1.5")}>
        <AccountMenu
          onTheme={onTheme}
          trigger={
            <button
              type="button"
              aria-label={tr("账户菜单", "Account menu")}
              className={cn(
                "flex items-center gap-2.5 rounded-xl bg-card/60 p-2 text-left shadow-card transition-colors hover:bg-card",
                collapsed && "justify-center bg-transparent p-1 shadow-none",
              )}
            >
              <Avatar email={me.email} />
              {!collapsed && (
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-footnote font-medium">{me.email}</span>
                  <span className="block text-caption text-muted-foreground">
                    {me.is_owner ? tr("所有者", "Owner") : tr("管理员", "Admin")}
                  </span>
                </span>
              )}
            </button>
          }
        />
      </div>
    </aside>
  );
}

function BellButton({ firing }: { firing: number }) {
  const tr = useTr();
  return (
    <Link
      to="/alerts"
      aria-label={tr(`告警（${firing} 条正在告警）`, `Alerts (${firing} firing)`)}
      className="hit-44 relative inline-flex size-8 items-center justify-center rounded-full text-foreground transition-colors hover:bg-accent"
    >
      <Bell className="size-[18px]" aria-hidden="true" />
      {firing > 0 && (
        <span className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-destructive ring-2 ring-window" />
      )}
    </Link>
  );
}

export function Shell({ page, children }: { page: string; children: ReactNode }) {
  const tr = useTr();
  const [theme, toggleTheme] = useTheme();
  const me = useMe();
  const site = useSite();
  const badges = useBadges();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [palette, setPaletteState] = useState(false);
  // Mounted from the first open on (keeps its state; no load before it is wanted).
  const [paletteMounted, setPaletteMounted] = useState(false);
  const setPalette = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    setPaletteMounted(true);
    setPaletteState(v);
  }, []);
  const navigation = useNavigation();
  const fetching = useIsFetching();
  // Ready = this page's chunk and its first data have arrived (latched per page).
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (navigation.state === "idle" && fetching === 0) setReady(page);
  }, [navigation.state, fetching, page]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setPalette]);
  useEffect(() => {
    try {
      localStorage.setItem("akari.admin.sidebar", collapsed ? "collapsed" : "expanded");
    } catch {
      /* storage blocked */
    }
  }, [collapsed]);

  const firing = badges.data?.alerts_firing ?? 0;
  const inMore = !TABS.some((t) => t.id === page);
  const iconButton =
    "hit-44 inline-flex size-8 items-center justify-center rounded-full transition-colors hover:bg-accent";

  return (
    <div className="min-h-dvh bg-window">
      <Sidebar page={page} collapsed={collapsed} onCollapse={() => setCollapsed((v) => !v)} onTheme={toggleTheme} />
      <div
        className={cn(
          "min-h-dvh transition-[margin] duration-(--dur-base) ease-(--ease-out)",
          collapsed ? "lg:ml-[80px]" : "lg:ml-[248px]",
        )}
      >
        {/* Desktop toolbar: search on the left, theme and bell on the right. */}
        <header className="glass sticky top-0 z-20 hidden h-13 items-center gap-2 border-b border-separator bg-(--glass-toolbar) px-6 lg:flex">
          <button
            type="button"
            onClick={() => setPalette(true)}
            onMouseEnter={() => void loadPalette()}
            onFocus={() => void loadPalette()}
            className="flex h-8 w-[300px] max-w-full items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-3 text-body text-faint transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)]"
          >
            <Search className="size-4" aria-hidden="true" />
            <span className="flex-1 text-left">{tr("搜索或跳转…", "Search or jump to…")}</span>
            <Kbd>{MOD_KEY} K</Kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={tr("切换主题", "Toggle theme")}
              className={iconButton}
            >
              {theme === "dark" ? (
                <Moon className="size-4" aria-hidden="true" />
              ) : (
                <Sun className="size-4" aria-hidden="true" />
              )}
            </button>
            <BellButton firing={firing} />
          </div>
        </header>

        {/* Phone top bar */}
        <header className="glass sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-separator bg-(--glass-toolbar) px-4 pt-[env(safe-area-inset-top)] lg:hidden">
          <AppMark size={24} />
          <span className="min-w-0 truncate text-headline font-semibold">{site.siteName}</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPalette(true)}
              aria-label={tr("搜索", "Search")}
              className={iconButton}
            >
              <Search className="size-[18px]" aria-hidden="true" />
            </button>
            <BellButton firing={firing} />
            <AccountMenu
              onTheme={toggleTheme}
              trigger={
                <button
                  type="button"
                  aria-label={tr("账户菜单", "Account menu")}
                  className="hit-44 inline-flex size-8 items-center justify-center rounded-full"
                >
                  <Avatar email={me.email} size={24} />
                </button>
              }
            />
          </div>
        </header>

        <main
          key={page}
          data-page={page}
          data-ready={ready === page || undefined}
          className="page-in mx-auto max-w-[1360px] px-4 pt-4 pb-[calc(88px+env(safe-area-inset-bottom))] sm:px-6 lg:px-8 lg:pt-6 lg:pb-12"
        >
          {children}
        </main>
      </div>

      {/* Phone tab bar */}
      <nav
        aria-label={tr("标签栏", "Tab bar")}
        className="glass fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-separator bg-[color-mix(in_srgb,var(--window)_93%,transparent)] pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {TABS.map((t) => {
          const on = t.id === "more" ? inMore : t.id === page;
          const n = count(t, badges.data);
          return (
            <Link
              key={t.id}
              to={pathOf(t.id)}
              aria-current={on ? "page" : undefined}
              onMouseEnter={() => prefetchPage(t.id)}
              onFocus={() => prefetchPage(t.id)}
              className={cn(
                "relative flex h-[52px] flex-col items-center justify-center gap-0.5 text-micro font-medium transition-colors",
                on ? "text-primary" : "text-faint",
              )}
            >
              <t.icon className="size-[22px] stroke-[1.8]" aria-hidden="true" />
              {tr(t.zh, t.en)}
              {n > 0 && (
                <span
                  className="tnum absolute top-1 left-1/2 ml-2 rounded-full bg-destructive px-1 text-micro leading-4 font-semibold text-white"
                  aria-label={tr(`${n} 条待处理`, `${n} pending`)}
                >
                  {n}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      {paletteMounted && (
        <Suspense fallback={null}>
          <CommandPalette open={palette} onOpenChange={setPalette} onTheme={toggleTheme} />
        </Suspense>
      )}
    </div>
  );
}
