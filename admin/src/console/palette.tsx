// Command palette (Ctrl/⌘ K, cmdk; v2 shell-palette*): with an empty input
// the recently opened objects (recent.ts), then actions and every page.
// Typing searches pages, actions and the settings sections (names, old
// names and the settings inside them); from 2 characters the first 3 users
// (email prefix), from 3 the orders of an order number or an email (exact,
// like the orders list). "@…" searches users only (plan, expiry, status),
// "#…" orders only (email, plan, amount, status): the prefix becomes a chip
// left of the input, Backspace on an empty input (or the chip's ×) leaves
// the mode. Arrow keys move (the selection scrolls into view), Enter runs.
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  ArrowRight,
  AtSign,
  Ban,
  Clock,
  CornerDownLeft,
  Hash,
  Languages,
  LogOut,
  Mail,
  Megaphone,
  Moon,
  Plus,
  Receipt,
  Route,
  Search,
  Server,
  UserRound,
  X,
} from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { get, logout, qs } from "../shared/api";
import { loadPage, signedOutUrl } from "../shared/base";
import { dateOnly, yuan } from "../shared/format";
import { useLang, useSetLang, useTr } from "../shared/i18n";
import { Kbd, MOD_KEY } from "../shared/ui/form";
import { OrdStatus, UserStatus, type OrderLike, type UserLike } from "./components/status";
import { useDebounced } from "./kit";
import { ALL_NAV, navOf, pathOf } from "./nav";
import { SECTIONS, SETTINGS_IA } from "./pages/settings-ia";
import { readRecent, type Recent } from "./recent";
import { navigate } from "./router";

type UserHit = UserLike & { id: string; email: string; plan_name: string | null; expires_at: string | null };
type OrderHit = OrderLike & {
  id: string;
  out_trade_no: string;
  amount_cents: number;
  user_email: string | null;
  user_label: string;
  plan_name: string;
  created_at: string;
};

function Item({
  value,
  icon,
  label,
  sub,
  hint,
  onSelect,
}: {
  value: string;
  icon: ReactNode;
  label: ReactNode;
  sub?: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="group flex min-h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-body outline-none data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground pointer-coarse:min-h-11 max-sm:min-h-11"
    >
      <span
        aria-hidden="true"
        className="text-muted-foreground group-data-[selected=true]:text-primary-foreground [&_svg]:size-4"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {sub && (
          <span className="block truncate text-footnote text-muted-foreground group-data-[selected=true]:text-primary-foreground/80">
            {sub}
          </span>
        )}
      </span>
      {hint && (
        <span className="shrink-0 text-footnote text-faint group-data-[selected=true]:text-primary-foreground/80">
          {hint}
        </span>
      )}
      <CornerDownLeft className="hidden size-3.5 shrink-0 group-data-[selected=true]:block" aria-hidden="true" />
    </Command.Item>
  );
}

type Action = { id: string; label: string; keys: string; hint?: string; icon: ReactNode; run: () => void };

export function CommandPalette({
  open,
  onOpenChange,
  onTheme,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onTheme: () => void;
}) {
  const tr = useTr();
  const lang = useLang();
  const setLang = useSetLang();
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<Recent[]>([]);
  useEffect(() => {
    if (open) setRecent(readRecent());
    else setQ("");
  }, [open]);
  const mode = q.startsWith("@") ? "users" : q.startsWith("#") ? "orders" : "all";
  const needle = (mode === "all" ? q : q.slice(1)).trim();
  const term = useDebounced(needle, 250);
  const n = needle.toLowerCase();
  const has = (s: string) => s.toLowerCase().includes(n);

  const users = useQuery({
    queryKey: ["palette", "users", term, mode],
    queryFn: () => get<{ users: UserHit[] }>(`/users${qs({ q: term, limit: mode === "users" ? 8 : 3 })}`),
    enabled: open && mode !== "orders" && (mode === "users" ? term.length >= 1 : term.length >= 2),
  });
  const byEmail = term.includes("@");
  const orders = useQuery({
    queryKey: ["palette", "orders", term, mode],
    queryFn: () =>
      get<OrderHit[]>(
        `/orders${qs(byEmail ? { email: term, limit: mode === "orders" ? 8 : 3 } : { out_trade_no: term, limit: 8 })}`,
      ),
    enabled: open && mode !== "users" && term.length >= 3 && (byEmail || /^[A-Za-z0-9_-]{3,}$/.test(term)),
  });

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };
  const actions: Action[] = [
    {
      id: "new-user",
      label: tr("新建用户", "New user"),
      keys: "new user xinjian",
      hint: tr("用户", "Users"),
      icon: <Plus />,
      run: () => go("/users?new=1"),
    },
    {
      id: "add-server",
      label: tr("添加服务器", "Add a server"),
      keys: "add node server 节点",
      hint: tr("节点", "Nodes"),
      icon: <Server />,
      run: () => go("/nodes?new=server"),
    },
    {
      id: "never-used",
      label: tr("筛选从未使用的账号", "Filter never-used accounts"),
      keys: "never used cleanup 清理",
      hint: tr("用户", "Users"),
      icon: <Ban />,
      run: () => go("/users?never=1"),
    },
    {
      id: "test-mail",
      label: tr("发送测试邮件", "Send a test mail"),
      keys: "mail test smtp diagnose 发信 诊断",
      hint: tr("设置 · 发信通道", "Settings · Mail"),
      icon: <Mail />,
      run: () => go("/settings/mail"),
    },
    {
      id: "new-announcement",
      label: tr("新建公告", "New announcement"),
      keys: "announcement notice 公告",
      hint: tr("内容", "Content"),
      icon: <Megaphone />,
      run: () => go("/content/announcements?open=new"),
    },
    {
      id: "add-node",
      label: tr("添加落地节点", "Add a node"),
      keys: "add node inbound 节点",
      hint: tr("节点", "Nodes"),
      icon: <Server />,
      run: () => go("/nodes?new=node"),
    },
    {
      id: "add-relay",
      label: tr("添加中转入口", "Add a relay entrance"),
      keys: "relay entrance 中转",
      hint: tr("节点", "Nodes"),
      icon: <Route />,
      run: () => go("/nodes?new=relay"),
    },
    {
      id: "manual-order",
      label: tr("新建人工订单", "New manual order"),
      keys: "manual order gift 订单 赠送",
      hint: tr("订单", "Orders"),
      icon: <Receipt />,
      run: () => go("/orders?new=1"),
    },
    {
      id: "theme",
      label: tr("切换深色 / 浅色", "Toggle dark / light"),
      keys: "theme dark light 主题 深色 浅色",
      icon: <Moon />,
      run: () => {
        onTheme();
        onOpenChange(false);
      },
    },
    {
      id: "language",
      label: tr("切换界面语言（中 / EN）", "Switch language (中 / EN)"), // i18n-ok: both languages named
      keys: "language english chinese 语言 中文",
      icon: <Languages />,
      run: () => {
        setLang(lang === "en" ? "zh" : "en");
        onOpenChange(false);
      },
    },
    {
      id: "sign-out",
      label: tr("退出登录", "Sign out"),
      keys: "sign out logout 退出",
      icon: <LogOut />,
      run: () => {
        onOpenChange(false);
        void logout()
          .catch(() => undefined)
          .finally(() => loadPage(signedOutUrl));
      },
    },
  ];
  const shownActions = mode !== "all" ? [] : n ? actions.filter((a) => has(a.label) || has(a.keys)) : actions;
  const pages = mode !== "all" ? [] : ALL_NAV.filter((p) => !n || has(p.zh) || has(p.en) || has(p.id));
  const sections = useMemo(() => {
    if (mode !== "all" || !n) return [];
    return SECTIONS.filter(
      (s) => s.zh.toLowerCase().includes(n) || s.en.toLowerCase().includes(n) || s.keywords.toLowerCase().includes(n),
    ).slice(0, 4);
  }, [mode, n]);
  const groupOf = (id: string) => SETTINGS_IA.find((g) => g.sections.some((s) => s.id === id));
  const userHits = mode === "orders" ? [] : (users.data?.users ?? []);
  const orderHits = mode === "users" ? [] : (orders.data ?? []);
  const searching = users.isFetching || orders.isFetching || needle !== term;
  const nothing =
    !shownActions.length &&
    !pages.length &&
    !sections.length &&
    !userHits.length &&
    !orderHits.length &&
    !(mode === "all" && !n);

  const heading =
    "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-faint";
  const setTerm = (v: string) => setQ(mode === "users" ? `@${v}` : mode === "orders" ? `#${v}` : v);

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay
          data-slot="dialog-overlay"
          className="fixed inset-0 z-50 bg-(--scrim) data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <D.Content
          data-slot="dialog-content"
          aria-describedby={undefined}
          className="glass fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-24px)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-2xl bg-popover shadow-dialog data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] max-sm:top-2"
        >
          <D.Title className="sr-only">{tr("命令面板", "Command palette")}</D.Title>
          <Command loop shouldFilter={false} label={tr("搜索", "Search")}>
            <div className="flex items-center gap-2.5 border-b border-separator px-4">
              <Search className="size-[18px] shrink-0 text-faint" aria-hidden="true" />
              {mode !== "all" && (
                <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-primary-soft pr-1 pl-2 text-footnote font-semibold text-primary">
                  {mode === "users" ? (
                    <AtSign className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Hash className="size-3.5" aria-hidden="true" />
                  )}
                  {mode === "users" ? tr("只搜用户", "Users only") : tr("只搜订单", "Orders only")}
                  <button
                    type="button"
                    onClick={() => setQ("")}
                    aria-label={tr("退出此模式", "Leave this mode")}
                    className="inline-flex size-4 items-center justify-center rounded-full hover:bg-primary/15"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </span>
              )}
              <Command.Input
                value={mode === "all" ? q : q.slice(1)}
                onValueChange={setTerm}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" && mode !== "all" && q.length === 1) setQ("");
                }}
                aria-label={tr("搜索", "Search")}
                placeholder={
                  mode === "users"
                    ? tr("邮箱或用户 ID…", "Email or user id…")
                    : mode === "orders"
                      ? tr("订单号或邮箱…", "Order number or email…")
                      : tr("搜索页面、操作、设置；@ 用户，# 订单", "Search pages, actions, settings; @ users, # orders")
                }
                className="h-13 min-w-0 flex-1 bg-transparent text-callout outline-none placeholder:text-faint"
              />
              <Kbd className="max-sm:hidden">Esc</Kbd>
            </div>
            <Command.List className={`scroll-thin max-h-[min(60vh,440px)] overflow-y-auto p-1.5 ${heading}`}>
              {nothing && (
                <div className="py-10 text-center text-body text-muted-foreground" role="status">
                  {searching
                    ? tr("搜索中…", "Searching…")
                    : needle
                      ? tr(`没有匹配「${needle}」的结果`, `Nothing matches “${needle}”`)
                      : mode === "users"
                        ? tr("输入邮箱开头或用户 ID", "Type the start of an email or a user id")
                        : tr("输入订单号或买家邮箱", "Type an order number or the buyer’s email")}
                  {mode === "all" && !searching && (
                    <div className="mt-1 text-footnote text-faint">
                      {tr("找用户请输入 @ 开头，找订单请输入 # 开头", "Start with @ for users, # for orders")}
                    </div>
                  )}
                </div>
              )}
              {mode === "all" && !n && recent.length > 0 && (
                <Command.Group heading={tr("最近打开", "Recently opened")}>
                  {recent.map((r) => {
                    const { item } = navOf(r.page);
                    return (
                      <Item
                        key={r.to}
                        value={`recent ${r.to}`}
                        icon={<Clock />}
                        label={r.label}
                        hint={tr(item.zh, item.en)}
                        onSelect={() => go(r.to)}
                      />
                    );
                  })}
                </Command.Group>
              )}
              {shownActions.length > 0 && (
                <Command.Group heading={tr("操作", "Actions")}>
                  {shownActions.slice(0, n ? 8 : 5).map((a) => (
                    <Item
                      key={a.id}
                      value={`action ${a.id}`}
                      icon={a.icon}
                      label={a.label}
                      hint={a.hint}
                      onSelect={a.run}
                    />
                  ))}
                </Command.Group>
              )}
              {pages.length > 0 && n !== "" && (
                <Command.Group heading={tr("页面", "Pages")}>
                  {pages.slice(0, 6).map((p) => (
                    <Item
                      key={p.id}
                      value={`page ${p.id}`}
                      icon={<p.icon />}
                      label={tr(p.zh, p.en)}
                      hint={<ArrowRight className="size-3.5" aria-hidden="true" />}
                      onSelect={() => go(pathOf(p.id))}
                    />
                  ))}
                </Command.Group>
              )}
              {userHits.length > 0 && (
                <Command.Group
                  heading={
                    mode === "users"
                      ? tr(`用户 · 匹配 ${userHits.length} 个（最多显示 8 个）`, `Users · ${userHits.length} (up to 8)`)
                      : tr("用户", "Users")
                  }
                >
                  {userHits.map((u) => (
                    <Item
                      key={u.id}
                      value={`user ${u.id}`}
                      icon={<UserRound />}
                      label={u.email}
                      sub={
                        mode === "users"
                          ? `${u.plan_name ?? tr("无套餐", "No plan")}${u.expires_at ? ` · ${tr("到期", "expires")} ${dateOnly(u.expires_at)}` : ""}`
                          : undefined
                      }
                      hint={mode === "users" ? <UserStatus user={u} /> : (u.plan_name ?? tr("无套餐", "No plan"))}
                      onSelect={() => go(`/users?open=${u.id}`)}
                    />
                  ))}
                </Command.Group>
              )}
              {orderHits.length > 0 && (
                <Command.Group heading={tr("订单", "Orders")}>
                  {orderHits.map((o) => (
                    <Item
                      key={o.id}
                      value={`order ${o.id}`}
                      icon={<Receipt />}
                      label={<span className="font-mono text-footnote">{o.out_trade_no}</span>}
                      sub={
                        mode === "orders"
                          ? `${o.user_email ?? o.user_label} · ${o.plan_name} · ${dateOnly(o.created_at)}`
                          : undefined
                      }
                      hint={
                        mode === "orders" ? (
                          <span className="flex items-center gap-2">
                            <span className="tnum">{yuan(o.amount_cents)}</span>
                            <OrdStatus order={o} />
                          </span>
                        ) : (
                          yuan(o.amount_cents)
                        )
                      }
                      onSelect={() => go(`/orders?open=${o.id}`)}
                    />
                  ))}
                </Command.Group>
              )}
              {pages.length > 0 && n === "" && (
                <Command.Group heading={tr("页面", "Pages")}>
                  {pages.map((p) => (
                    <Item
                      key={p.id}
                      value={`page ${p.id}`}
                      icon={<p.icon />}
                      label={tr(p.zh, p.en)}
                      hint={<ArrowRight className="size-3.5" aria-hidden="true" />}
                      onSelect={() => go(pathOf(p.id))}
                    />
                  ))}
                </Command.Group>
              )}
              {sections.length > 0 && (
                <Command.Group heading={tr("系统设置", "Settings")}>
                  {sections.map((s) => {
                    const g = groupOf(s.id);
                    return (
                      <Item
                        key={s.id}
                        value={`setting ${s.id}`}
                        icon={<s.icon />}
                        label={tr(s.zh, s.en)}
                        sub={g ? tr(g.zh, g.en) : undefined}
                        hint={tr("设置", "Settings")}
                        onSelect={() => go(s.href ?? `/settings/${s.id}`)}
                      />
                    );
                  })}
                </Command.Group>
              )}
            </Command.List>
            <div className="flex items-center gap-4 border-t border-separator px-4 py-2 text-caption text-faint max-sm:hidden">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> {tr("选择", "move")}
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> {tr("打开", "open")}
              </span>
              <span className="flex items-center gap-1">
                <Kbd>{MOD_KEY} K</Kbd> {tr("随时打开", "anywhere")}
              </span>
              <span className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setQ("@")}
                  className="flex items-center gap-1 hover:text-foreground"
                >
                  <Kbd>@</Kbd> {tr("用户", "users")}
                </button>
                <button
                  type="button"
                  onClick={() => setQ("#")}
                  className="flex items-center gap-1 hover:text-foreground"
                >
                  <Kbd>#</Kbd> {tr("订单", "orders")}
                </button>
              </span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
