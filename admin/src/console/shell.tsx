// The console shell (v2 design, proposal-v2 §6 外壳; screenshots-v2/shell-*):
// - desktop (≥1024px): a floating frosted sidebar on the content canvas
//   (no column background or divider; 8px inset top/left/bottom): brand,
//   grouped navigation with live counts (tickets blue = unread, alerts red =
//   firing), collapsible to a 60px icon rail (tooltips, corner badges;
//   remembered in `akari.admin.sidebar`), the account card at the bottom.
//   The toolbar: breadcrumb «group › page › sub-page › open object» (the
//   object's name comes from the page via useCrumb, never a raw parameter),
//   the search pill (⌘K / Ctrl K), 中 / EN, theme, the alert bell popover;
// - phone: a top bar (brand mark or a back arrow, the title once the page's
//   large title scrolled away or the open object's name, search, bell,
//   avatar menu) and the bottom tab bar 仪表盘 / 用户 / 订单 / 工单 / 更多;
// - the account menu: who and how, 我的账户与通行密钥, theme and language as
//   segmented radio items, sign out;
// - the command palette (Ctrl/⌘ K, its own chunk).
// `?demo=bell|account-menu` opens those for the design-compare shots.
// The document title is «view · site 管理后台». <main> is keyed by the page
// (area), so switching sub-routes inside an area does not replay the
// entrance animation; it carries data-page / data-ready (the page's data has
// arrived) for the e2e timing suite.
import { useIsFetching } from "@tanstack/react-query";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Languages,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
  UserRound,
} from "lucide-react";
import { DropdownMenu as M, Tooltip } from "radix-ui";
import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigation } from "react-router";
import { logout } from "../shared/api";
import { loadPage, loginBase } from "../shared/base";
import { cn } from "../shared/cn";
import { useLang, useSetLang, useTr, type Tr } from "../shared/i18n";
import { setTheme, useTheme } from "../shared/theme";
import { BrandMark } from "../shared/ui/brand";
import { Kbd, MOD_KEY } from "../shared/ui/form";
import { Menu, MenuItem, MenuSeparator, Popover } from "../shared/ui/menu";
import { useToast } from "../shared/ui/toast";
import { NAV, OPEN_LABELS, SUB_LABELS, TABS, navOf, pathOf, type NavItem } from "./nav";
import { prefetchPage } from "./pages";
import { pushRecent } from "./recent";
import { navigate, setQuery } from "./router";
import { CrumbContext, useBadges, useMe, useSite, type Badges } from "./session";

// The command palette (cmdk) and the bell's list are their own chunks,
// loaded on first open (or when the search pill is hovered / focused).
const loadPalette = () => import("./palette");
const CommandPalette = lazy(() => loadPalette().then((m) => ({ default: m.CommandPalette })));
const BellPanel = lazy(() => import("./components/shell-bell").then((m) => ({ default: m.BellPanel })));

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

/* ---------- Where am I: group › page › sub-page › object ---------- */

type Crumb = { label: string; to?: string };

function useCrumbs(page: string, object: string | null, tr: Tr) {
  const loc = useLocation();
  const { group, item } = navOf(page);
  const segs = loc.pathname.split("/").filter(Boolean);
  const pageLabel = tr(item.zh, item.en);
  const crumbs: Crumb[] = [{ label: pageLabel, to: pathOf(page) }];
  const subKey = segs.length >= 2 ? `${segs[0]}/${segs[1]}` : "";
  const sub = SUB_LABELS[subKey];
  if (sub) crumbs.push({ label: tr(sub.zh, sub.en), to: `/${subKey}` });
  // An object: a path segment that is not a sub-page, or `?open=`.
  const opened = new URLSearchParams(loc.search).get("open");
  const hasObject = (segs.length >= 2 && !sub) || (!!opened && opened !== "new");
  if (object && object !== crumbs[crumbs.length - 1].label) crumbs.push({ label: object });
  else if (hasObject && !object) {
    const generic = OPEN_LABELS[page];
    crumbs.push({ label: generic ? tr(generic.zh, generic.en) : tr("详情", "Details") });
  }
  return {
    group: group ? tr(group.zh, group.en) : undefined,
    crumbs,
    /** The phone's top bar goes one level deeper (back arrow + object name). */
    deep: hasObject && crumbs.length > 1,
    view: crumbs[crumbs.length - 1].label,
    pageLabel,
  };
}

function Breadcrumbs({ group, crumbs }: { group?: string; crumbs: Crumb[] }) {
  const tr = useTr();
  return (
    <nav aria-label={tr("位置", "Location")} className="flex min-w-0 items-center gap-1 text-body">
      {group && <span className="shrink-0 text-faint">{group}</span>}
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={i} className={cn("flex items-center gap-1", last ? "min-w-0" : "shrink-0")}>
            {(group || i > 0) && <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />}
            {c.to && !last ? (
              <Link to={c.to} className="font-medium text-muted-foreground hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate font-semibold text-foreground">
                {c.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/* ---------- The alert bell ---------- */

function BellButton({
  firing,
  open,
  onOpenChange,
  className,
}: {
  firing: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  className?: string;
}) {
  const tr = useTr();
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={tr("正在告警", "Firing now")}
      className="p-0"
      trigger={
        <button
          type="button"
          aria-label={tr(`告警（${firing} 条正在告警）`, `Alerts (${firing} firing)`)}
          className={cn(
            "hit-44 relative inline-flex size-8 items-center justify-center rounded-full text-foreground transition-colors hover:bg-accent data-[state=open]:bg-accent",
            className,
          )}
        >
          <Bell className="size-[18px]" aria-hidden="true" />
          {firing > 0 && (
            <span className="tnum pointer-events-none absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-micro leading-none font-semibold text-white ring-2 ring-window">
              {firing}
            </span>
          )}
        </button>
      }
    >
      {open && (
        <Suspense fallback={<div className="h-40 w-[min(380px,calc(100vw-24px))]" />}>
          <BellPanel onClose={() => onOpenChange(false)} />
        </Suspense>
      )}
    </Popover>
  );
}

/* ---------- The account menu ---------- */

function SegRow<T extends string>({
  label,
  icon,
  value,
  items,
  onChange,
}: {
  label: string;
  icon: ReactNode;
  value: T;
  items: { v: T; l: ReactNode; name: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex min-h-9 items-center gap-2 px-2.5 text-body pointer-coarse:min-h-11">
      <span className="text-muted-foreground [&_svg]:size-4" aria-hidden="true">
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      <M.RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as T)}
        aria-label={label}
        className="inline-flex rounded-[8px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] p-0.5"
      >
        {items.map((it) => (
          <M.RadioItem
            key={it.v}
            value={it.v}
            aria-label={it.name}
            className="inline-flex h-6 cursor-default items-center gap-1 rounded-[6px] px-2 text-footnote font-medium text-muted-foreground outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-ring data-[state=checked]:bg-segment-active data-[state=checked]:text-foreground data-[state=checked]:shadow-[0_0_0_0.5px_rgb(0_0_0/0.06),0_1px_3px_rgb(0_0_0/0.1)] pointer-coarse:h-8 [&_svg]:size-3.5"
          >
            {it.l}
          </M.RadioItem>
        ))}
      </M.RadioGroup>
    </div>
  );
}

/** Account menu (sidebar card on a desktop, avatar on a phone): account, theme, language, sign out. */
function AccountMenu({
  trigger,
  open,
  onOpenChange,
  align = "start",
}: {
  trigger: ReactNode;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  align?: "start" | "end";
}) {
  const tr = useTr();
  const me = useMe();
  const lang = useLang();
  const setLang = useSetLang();
  const [theme] = useTheme();
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
    <Menu
      trigger={trigger}
      align={align}
      open={open}
      onOpenChange={onOpenChange}
      label={tr("账户菜单", "Account menu")}
      className="w-[268px]"
    >
      <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-2">
        <Avatar email={me.email} size={32} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-body font-semibold">{me.email}</div>
          <div className="mt-0.5 text-footnote text-muted-foreground">
            {me.is_owner ? tr("所有者 · 管理员", "Owner · admin") : tr("管理员", "Admin")}
          </div>
        </div>
      </div>
      <MenuSeparator />
      <MenuItem icon={UserRound} onClick={() => navigate("/account")}>
        {tr("我的账户与通行密钥", "My account & passkeys")}
      </MenuItem>
      <MenuSeparator />
      <SegRow
        label={tr("主题", "Theme")}
        icon={theme === "dark" ? <Moon /> : <Sun />}
        value={theme}
        onChange={setTheme}
        items={[
          {
            v: "light",
            name: tr("浅色", "Light"),
            l: (
              <>
                <Sun aria-hidden="true" />
                {tr("浅色", "Light")}
              </>
            ),
          },
          {
            v: "dark",
            name: tr("深色", "Dark"),
            l: (
              <>
                <Moon aria-hidden="true" />
                {tr("深色", "Dark")}
              </>
            ),
          },
        ]}
      />
      <SegRow
        label={tr("语言", "Language")}
        icon={<Languages />}
        value={lang}
        onChange={setLang}
        items={[
          { v: "zh", name: "中文", l: "中文" }, // i18n-ok: a language's own name
          { v: "en", name: "English", l: "English" },
        ]}
      />
      <MenuSeparator />
      <MenuItem icon={LogOut} danger onClick={() => void signOut()}>
        {tr("退出登录", "Sign out")}
      </MenuItem>
    </Menu>
  );
}

/* ---------- Sidebar ---------- */

function RailTip({ label, on, children }: { label: string; on: boolean; children: ReactNode }) {
  if (!on) return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={10}
          className="glass z-50 rounded-md bg-popover px-2 py-1 text-footnote font-medium shadow-pop"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function Sidebar({
  page,
  collapsed,
  onCollapse,
  menuOpen,
  onMenuOpen,
}: {
  page: string;
  collapsed: boolean;
  onCollapse: () => void;
  menuOpen: boolean;
  onMenuOpen: (o: boolean) => void;
}) {
  const tr = useTr();
  const site = useSite();
  const me = useMe();
  const badges = useBadges();
  const collapseLabel = collapsed ? tr("展开侧边栏", "Expand sidebar") : tr("收起侧边栏", "Collapse sidebar");
  return (
    <Tooltip.Provider delayDuration={300}>
      <aside
        data-collapsed={collapsed}
        className={cn(
          "glass fixed inset-y-2 left-2 z-30 hidden flex-col rounded-[18px] bg-(--glass-sidebar) shadow-[0_0_0_0.5px_var(--border),inset_0_0.5px_0_var(--glass-edge)] transition-[width] duration-(--dur-base) ease-(--ease-out) lg:flex",
          collapsed ? "w-[60px]" : "w-[232px]",
        )}
      >
        <div className={cn("flex items-center gap-2.5 pt-4 pb-2", collapsed ? "flex-col px-0" : "px-4")}>
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
          <RailTip label={collapseLabel} on>
            <button
              type="button"
              onClick={onCollapse}
              aria-expanded={!collapsed}
              aria-label={collapseLabel}
              className="hit-44 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" aria-hidden="true" />
              ) : (
                <PanelLeftClose className="size-4" aria-hidden="true" />
              )}
            </button>
          </RailTip>
        </div>
        <nav
          className={cn("scroll-thin flex-1 overflow-y-auto pb-3", collapsed ? "px-2" : "px-2.5")}
          aria-label={tr("主导航", "Main navigation")}
        >
          {NAV.map((g) => (
            <div
              key={g.zh}
              className={cn(
                collapsed ? "mt-2 border-t border-separator pt-2 first:mt-0 first:border-0" : "mt-3 first:mt-1",
              )}
            >
              {!collapsed && <div className="px-2 pb-1 text-caption font-semibold text-faint">{tr(g.zh, g.en)}</div>}
              <ul className="grid gap-px">
                {g.items.map((it) => {
                  const active = it.id === page;
                  const n = count(it, badges.data);
                  const label = tr(it.zh, it.en);
                  const pending = tr(`${n} 条待处理`, `${n} pending`);
                  return (
                    <li key={it.id}>
                      <RailTip label={n ? `${label} · ${n}` : label} on={collapsed}>
                        <Link
                          to={pathOf(it.id)}
                          aria-label={collapsed ? (n ? `${label} ${pending}` : label) : undefined}
                          aria-current={active ? "page" : undefined}
                          onMouseEnter={() => prefetchPage(it.id)}
                          onFocus={() => prefetchPage(it.id)}
                          className={cn(
                            "relative flex items-center rounded-[9px] text-body font-medium transition-colors duration-(--dur-hover)",
                            collapsed ? "h-9 w-full justify-center" : "h-8 gap-2.5 px-2",
                            active
                              ? "bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)] text-foreground"
                              : "text-foreground/80 hover:bg-accent",
                          )}
                        >
                          <it.icon
                            className={cn(
                              "size-[17px] shrink-0 stroke-[1.8]",
                              active ? "text-primary" : "text-muted-foreground",
                            )}
                            aria-hidden="true"
                          />
                          {!collapsed && <span className="flex-1 truncate">{label}</span>}
                          {n > 0 &&
                            (collapsed ? (
                              <span
                                aria-hidden="true"
                                className={cn(
                                  "tnum absolute -top-0.5 -right-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-micro leading-none font-semibold text-white ring-2 ring-(--glass-sidebar)",
                                  it.badge === "alerts" ? "bg-destructive" : "bg-primary",
                                )}
                              >
                                {n}
                              </span>
                            ) : (
                              <span
                                className={cn(
                                  "tnum rounded-full px-1.5 text-caption leading-4 font-semibold text-white",
                                  it.badge === "alerts" ? "bg-destructive" : "bg-primary",
                                )}
                                aria-label={pending}
                              >
                                {n}
                              </span>
                            ))}
                        </Link>
                      </RailTip>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <AccountMenu
          open={menuOpen}
          onOpenChange={onMenuOpen}
          trigger={
            collapsed ? (
              <button
                type="button"
                aria-label={tr("账户菜单", "Account menu")}
                className="mx-auto mb-3 rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
              >
                <Avatar email={me.email} />
              </button>
            ) : (
              <button
                type="button"
                aria-label={tr("账户菜单", "Account menu")}
                className="m-2.5 mt-0 flex items-center gap-2.5 rounded-xl bg-card/60 p-2 text-left shadow-card outline-none transition-colors hover:bg-card focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-card"
              >
                <Avatar email={me.email} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-footnote font-medium">{me.email}</span>
                  <span className="block text-caption text-muted-foreground">
                    {me.is_owner ? tr("所有者", "Owner") : tr("管理员", "Admin")}
                  </span>
                </span>
                <ChevronsUpDown className="size-3.5 text-faint" aria-hidden="true" />
              </button>
            )
          }
        />
      </aside>
    </Tooltip.Provider>
  );
}

/* ---------- The shell ---------- */

function useDesktop() {
  const q = "(min-width: 1024px)";
  const [on, setOn] = useState(() => window.matchMedia?.(q).matches ?? true);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const h = () => setOn(m.matches);
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);
  return on;
}

export function Shell({ page, children }: { page: string; children: ReactNode }) {
  const tr = useTr();
  const lang = useLang();
  const setLang = useSetLang();
  const [theme, toggleTheme] = useTheme();
  const me = useMe();
  const site = useSite();
  const badges = useBadges();
  const loc = useLocation();
  const desktop = useDesktop();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [palette, setPaletteState] = useState(false);
  // Mounted from the first open on (keeps its state; no load before it is wanted).
  const [paletteMounted, setPaletteMounted] = useState(false);
  const setPalette = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    setPaletteMounted(true);
    setPaletteState(v);
  }, []);
  // The open object's name, reported by the page (useCrumb).
  const [object, setObject] = useState<string | null>(null);
  // `?demo=bell|account-menu` (design-compare shots) opens them; closing clears it.
  const demo = new URLSearchParams(loc.search).get("demo");
  const [bell, setBellState] = useState(false);
  const [menu, setMenuState] = useState(false);
  const setBell = (o: boolean) => {
    setBellState(o);
    if (!o && demo === "bell") setQuery({ demo: null });
  };
  const setMenu = (o: boolean) => {
    setMenuState(o);
    if (!o && demo === "account-menu") setQuery({ demo: null });
  };
  const bellOpen = bell || demo === "bell";
  const menuOpen = menu || demo === "account-menu";

  const navigation = useNavigation();
  const fetching = useIsFetching();
  // Ready = this page's chunk and its first data have arrived (latched per page).
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (navigation.state === "idle" && fetching === 0) setReady(page);
  }, [navigation.state, fetching, page]);

  const { group, crumbs, deep, view } = useCrumbs(page, object, tr);
  // «view · site 管理后台».
  useEffect(() => {
    document.title = `${view} · ${site.siteName} ${tr("管理后台", "admin")}`;
  }, [view, site.siteName, tr]);
  // Recently opened objects (the palette's first group).
  const to = loc.pathname + loc.search;
  useEffect(() => {
    if (object && deep) pushRecent({ label: object, page, to });
  }, [object, deep, page, to]);

  // The phone's top bar shows the title once the page's large title has scrolled away.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 40);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

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
  const parent = deep ? crumbs[crumbs.length - 2] : undefined;
  const iconButton =
    "hit-44 inline-flex size-8 items-center justify-center rounded-full transition-colors hover:bg-accent";

  return (
    <CrumbContext.Provider value={setObject}>
      <div className="min-h-dvh bg-window">
        <Sidebar
          page={page}
          collapsed={collapsed}
          onCollapse={() => setCollapsed((v) => !v)}
          menuOpen={desktop && menuOpen}
          onMenuOpen={setMenu}
        />
        <div
          className={cn(
            "min-h-dvh transition-[margin] duration-(--dur-base) ease-(--ease-out)",
            collapsed ? "lg:ml-[76px]" : "lg:ml-[248px]",
          )}
        >
          {/* Desktop toolbar: breadcrumb; search, language, theme, bell. */}
          <header className="glass sticky top-0 z-20 hidden h-13 items-center gap-3 border-b border-separator bg-(--glass-toolbar) px-6 lg:flex">
            <div className="min-w-0 flex-1">
              <Breadcrumbs group={group} crumbs={crumbs} />
            </div>
            <button
              type="button"
              onClick={() => setPalette(true)}
              onMouseEnter={() => void loadPalette()}
              onFocus={() => void loadPalette()}
              className="flex h-8 w-[260px] shrink-0 items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-3 text-body text-faint transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)] xl:w-[300px]"
            >
              <Search className="size-4" aria-hidden="true" />
              <span className="flex-1 truncate text-left">{tr("搜索、跳转或执行…", "Search, jump or run…")}</span>
              <Kbd>{MOD_KEY} K</Kbd>
            </button>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => setLang(lang === "zh" ? "en" : "zh")}
                aria-label={tr("切换界面语言", "Switch language")}
                className="inline-flex h-8 items-center rounded-full px-2.5 text-footnote font-semibold transition-colors hover:bg-accent"
              >
                <span className={lang === "zh" ? "text-foreground" : "text-faint"}>中</span>
                <span className="mx-1 text-faint">/</span>
                <span className={lang === "en" ? "text-foreground" : "text-faint"}>EN</span>
              </button>
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
              {desktop && <BellButton firing={firing} open={bellOpen} onOpenChange={setBell} />}
            </div>
          </header>

          {/* Phone top bar */}
          <header
            className={cn(
              "glass sticky top-0 z-20 flex h-12 items-center gap-1 border-b bg-(--glass-toolbar) pt-[env(safe-area-inset-top)] pr-2 pl-3 transition-colors lg:hidden",
              scrolled || deep ? "border-separator" : "border-transparent",
            )}
          >
            {deep && parent?.to ? (
              <Link
                to={parent.to}
                aria-label={tr(`返回${parent.label}`, `Back to ${parent.label}`)}
                className="-ml-1 inline-flex size-11 shrink-0 items-center text-primary"
              >
                <ChevronLeft className="size-6 stroke-[2.2]" aria-hidden="true" />
              </Link>
            ) : (
              <AppMark size={24} />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate px-1.5 text-headline font-semibold transition-opacity duration-(--dur-base)",
                scrolled || deep ? "opacity-100" : "opacity-0",
              )}
              aria-hidden={!(scrolled || deep)}
            >
              {view}
            </span>
            <button
              type="button"
              onClick={() => setPalette(true)}
              aria-label={tr("搜索", "Search")}
              className={cn(iconButton, "size-10")}
            >
              <Search className="size-5" aria-hidden="true" />
            </button>
            {!desktop && (
              <BellButton firing={firing} open={bellOpen} onOpenChange={setBell} className="size-10 [&_svg]:size-5" />
            )}
            <AccountMenu
              align="end"
              open={!desktop && menuOpen}
              onOpenChange={setMenu}
              trigger={
                <button
                  type="button"
                  aria-label={tr("账户菜单", "Account menu")}
                  className="inline-flex size-10 items-center justify-center rounded-full"
                >
                  <Avatar email={me.email} size={28} />
                </button>
              }
            />
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
                {/* After the label in the DOM (the link's name starts with the label), drawn on the icon's corner. */}
                {n > 0 && (
                  <span
                    className="tnum absolute top-0.5 left-1/2 ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-micro leading-none font-semibold text-white ring-2 ring-window"
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
    </CrumbContext.Provider>
  );
}
