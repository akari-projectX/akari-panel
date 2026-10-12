// Command palette (Ctrl/⌘ K, cmdk): pages, common actions, users by email
// and orders by number. "@…" searches users only, "#…" orders only. Arrow
// keys move (the selection scrolls into view), Enter runs.
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  ArrowRight,
  CornerDownLeft,
  Ban,
  Mail,
  Moon,
  Plus,
  Receipt,
  Route,
  Search,
  Server,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { get, qs } from "../shared/api";
import { yuan } from "../shared/format";
import { useTr } from "../shared/i18n";
import { Kbd } from "../shared/ui/form";
import { useDebounced } from "./kit";
import { ALL_NAV, pathOf } from "./nav";
import { navigate } from "./router";

type Cmd = { id: string; group: string; label: string; hint?: string; icon: LucideIcon; run: () => void };
type UserHit = { id: string; email: string; plan_name: string | null };
type OrderHit = { id: string; out_trade_no: string; amount_cents: number };

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
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  const raw = q.trim();
  const mode = raw.startsWith("@") ? "users" : raw.startsWith("#") ? "orders" : "all";
  const needle = mode === "all" ? raw : raw.slice(1).trim();
  const term = useDebounced(needle, 250);
  const users = useQuery({
    queryKey: ["palette", "users", term],
    queryFn: () => get<{ users: UserHit[] }>(`/users${qs({ q: term, limit: 5 })}`),
    enabled: open && mode !== "orders" && term.length >= 2,
  });
  const orders = useQuery({
    queryKey: ["palette", "orders", term],
    queryFn: () => get<OrderHit[]>(`/orders${qs({ out_trade_no: term, limit: 5 })}`),
    enabled: open && mode !== "users" && /^[A-Za-z0-9_-]{6,}$/.test(term),
  });

  const list = useMemo<Cmd[]>(() => {
    const go = (to: string) => () => {
      onOpenChange(false);
      navigate(to);
    };
    const actions = tr("常用操作", "Actions");
    const pages = tr("页面", "Pages");
    const fixed: Cmd[] = [
      // The design's five first (new user, relay, never-used, test mail, theme), then the rest.
      {
        id: "a-user",
        group: actions,
        label: tr("新建用户", "New user"),
        hint: tr("用户", "Users"),
        icon: Plus,
        run: go("/users?new=1"),
      },
      {
        id: "a-relay",
        group: actions,
        label: tr("添加中转入口", "Add a relay entrance"),
        hint: tr("节点", "Nodes"),
        icon: Route,
        run: go("/nodes"),
      },
      {
        id: "a-never",
        group: actions,
        label: tr("筛选从未使用的账号", "Filter never-used accounts"),
        hint: tr("用户", "Users"),
        icon: Ban,
        run: go("/users?never_used=1"),
      },
      {
        id: "a-mail",
        group: actions,
        label: tr("发送测试邮件", "Send a test mail"),
        hint: tr("设置 · 邮件", "Settings · Mail"),
        icon: Mail,
        run: go("/settings/mail"),
      },
      {
        id: "a-theme",
        group: actions,
        label: tr("切换深色 / 浅色", "Toggle dark / light"),
        icon: Moon,
        run: () => {
          onTheme();
          onOpenChange(false);
        },
      },
      {
        id: "a-node",
        group: actions,
        label: tr("添加落地节点", "Add a node"),
        hint: tr("节点", "Nodes"),
        icon: Server,
        run: go("/nodes?new=node"),
      },
      {
        id: "a-server",
        group: actions,
        label: tr("添加服务器", "Add a server"),
        hint: tr("节点", "Nodes"),
        icon: Server,
        run: go("/nodes?new=server"),
      },
      {
        id: "a-order",
        group: actions,
        label: tr("新建人工订单", "New manual order"),
        hint: tr("订单", "Orders"),
        icon: Receipt,
        run: go("/orders?new=1"),
      },
      ...ALL_NAV.map((n) => ({
        id: `p-${n.id}`,
        group: pages,
        label: tr(n.zh, n.en),
        icon: n.icon,
        run: go(pathOf(n.id)),
      })),
    ];
    const n = needle.toLowerCase();
    const matched = mode !== "all" ? [] : n ? fixed.filter((c) => c.label.toLowerCase().includes(n)) : fixed;
    // While typing, a matching page comes first (Enter opens it).
    const ordered = n
      ? [...matched.filter((c) => c.group === pages), ...matched.filter((c) => c.group !== pages)]
      : matched;
    return [
      ...ordered,
      ...(mode === "orders" ? [] : (users.data?.users ?? [])).map((u) => ({
        id: `u-${u.id}`,
        group: tr("用户", "Users"),
        label: u.email,
        hint: u.plan_name ?? tr("无套餐", "No plan"),
        icon: UserRound,
        run: go(`/users?open=${u.id}`),
      })),
      ...(mode === "users" ? [] : (orders.data ?? [])).map((o) => ({
        id: `o-${o.id}`,
        group: tr("订单", "Orders"),
        label: o.out_trade_no,
        hint: yuan(o.amount_cents),
        icon: Receipt,
        run: go(`/orders?open=${o.id}`),
      })),
    ];
  }, [tr, onOpenChange, onTheme, users.data, orders.data, needle, mode]);
  const groups = [...new Set(list.map((c) => c.group))];
  const searching = users.isFetching || orders.isFetching;

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay
          data-slot="dialog-overlay"
          className="fixed inset-0 z-50 bg-(--scrim) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <D.Content
          data-slot="dialog-content"
          aria-describedby={undefined}
          className="glass fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-24px)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-2xl bg-popover shadow-dialog data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97]"
        >
          <D.Title className="sr-only">{tr("命令面板", "Command palette")}</D.Title>
          <Command loop shouldFilter={false} label={tr("命令面板", "Command palette")}>
            <div className="flex items-center gap-2.5 border-b border-separator px-4">
              <Search className="size-[18px] shrink-0 text-faint" aria-hidden="true" />
              <Command.Input
                value={q}
                onValueChange={setQ}
                aria-label={tr("搜索", "Search")}
                placeholder={tr(
                  "搜索页面、操作、用户邮箱、订单号…",
                  "Search pages, actions, user emails, order numbers…",
                )}
                className="h-13 flex-1 bg-transparent text-callout outline-none placeholder:text-faint"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="scroll-thin max-h-[min(60vh,420px)] overflow-y-auto p-1.5">
              <Command.Empty className="py-10 text-center text-body text-muted-foreground">
                {searching ? tr("搜索中…", "Searching…") : tr("没有匹配的结果", "No results")}
              </Command.Empty>
              {groups.map((g) => (
                <Command.Group
                  key={g}
                  heading={g}
                  className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-faint"
                >
                  {list
                    .filter((c) => c.group === g)
                    .map((c) => (
                      <Command.Item
                        key={c.id}
                        value={c.id}
                        onSelect={c.run}
                        className="group flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-body outline-none data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground pointer-coarse:h-11"
                      >
                        <c.icon
                          className="size-4 shrink-0 text-muted-foreground group-data-[selected=true]:text-primary-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        {c.hint && (
                          <span className="text-footnote text-faint group-data-[selected=true]:text-primary-foreground/80">
                            {c.hint}
                          </span>
                        )}
                        {c.id.startsWith("p-") && (
                          <ArrowRight
                            className="size-3.5 text-faint group-data-[selected=true]:hidden"
                            aria-hidden="true"
                          />
                        )}
                        <CornerDownLeft
                          className="hidden size-3.5 group-data-[selected=true]:block"
                          aria-hidden="true"
                        />
                      </Command.Item>
                    ))}
                </Command.Group>
              ))}
            </Command.List>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-separator px-4 py-2 text-caption text-faint">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> {tr("选择", "navigate")}
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> {tr("打开", "open")}
              </span>
              <span className="ml-auto hidden items-center gap-1 sm:flex">
                {tr("输入", "Type")} <Kbd>@</Kbd> {tr("只搜用户，", "for users only,")} <Kbd>#</Kbd>{" "}
                {tr("只搜订单", "for orders only")}
              </span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
