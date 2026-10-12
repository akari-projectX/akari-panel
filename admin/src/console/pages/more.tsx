// 更多 (v2 shell-more; phones reach it from the tab bar, desktops can open
// it too as a centred narrow column): the account card (email, owner,
// passkey count → 我的账户), a search pill (the command palette), every
// page grouped like the sidebar (coloured tiles, live counts), language and
// appearance as segmented controls, sign out and the version.
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Languages, LogOut, Moon, Search, Sun } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { get, logout } from "../../shared/api";
import { loadPage, signedOutUrl } from "../../shared/base";
import { cn } from "../../shared/cn";
import { useLang, useSetLang, useTr, type Lang } from "../../shared/i18n";
import { setTheme, useTheme, type Theme } from "../../shared/theme";
import { Tile } from "../../shared/ui/card";
import { Segmented } from "../../shared/ui/form";
import { PageHeader } from "../../shared/ui/layout";
import { Spin } from "../components/kit";
import { NAV, pathOf } from "../nav";
import { useBadges, useMe, useSite } from "../session";

/** Open the command palette (the shell listens for ⌘/Ctrl K). */
function openPalette() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
}

export function MorePage() {
  const tr = useTr();
  const me = useMe();
  const site = useSite();
  const lang = useLang();
  const setLang = useSetLang();
  const [theme] = useTheme();
  const badges = useBadges();
  const keys = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => get<{ passkeys: { current: boolean }[] }>("/me/passkeys"),
  });
  const [leaving, setLeaving] = useState(false);
  const nKeys = keys.data?.passkeys.filter((p) => p.current).length;
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={tr("更多", "More")} />
      <div className="grid gap-6">
        <Link to="/account" className="flex items-center gap-3 rounded-xl bg-card p-3.5 shadow-card active:bg-accent">
          <span
            aria-hidden="true"
            className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-linear-to-b from-[color-mix(in_srgb,var(--primary),white_32%)] to-primary text-title3 font-semibold text-primary-foreground uppercase"
          >
            {me.email.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-headline font-semibold">{me.email}</span>
            <span className="mt-0.5 block text-footnote text-muted-foreground">
              {me.is_owner ? tr("所有者", "Owner") : tr("管理员", "Admin")}
              {nKeys !== undefined && tr(` · ${nKeys} 个通行密钥`, ` · ${nKeys} passkey${nKeys === 1 ? "" : "s"}`)}
            </span>
          </span>
          <ChevronRight className="size-4 text-faint" aria-hidden="true" />
        </Link>

        <button
          type="button"
          onClick={openPalette}
          className="flex h-11 items-center gap-2 rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-3 text-left text-callout text-faint"
        >
          <Search className="size-4" aria-hidden="true" />
          {tr("搜索页面、用户、订单…", "Search pages, users, orders…")}
        </button>

        <nav aria-label={tr("全部页面", "All pages")} className="grid gap-6">
          {NAV.map((g) => (
            <section key={g.zh} className="grid gap-1.5">
              <h2 className="px-4 text-footnote font-medium text-muted-foreground">{tr(g.zh, g.en)}</h2>
              <ul className="overflow-hidden rounded-xl bg-card shadow-card">
                {g.items.map((it) => {
                  const n =
                    it.badge === "tickets"
                      ? (badges.data?.tickets_unread ?? 0)
                      : it.badge === "alerts"
                        ? (badges.data?.alerts_firing ?? 0)
                        : 0;
                  return (
                    <li key={it.id} className="group">
                      <Link to={pathOf(it.id)} className="flex h-12 items-center gap-3 pl-4 active:bg-accent">
                        <Tile color={it.tint} size={30}>
                          <it.icon />
                        </Tile>
                        <span className="flex h-full min-w-0 flex-1 items-center gap-2 border-b border-separator pr-4 group-last:border-0">
                          <span className="flex-1 truncate text-callout font-medium">{tr(it.zh, it.en)}</span>
                          {n > 0 && (
                            <span
                              className={cn(
                                "tnum rounded-full px-1.5 text-footnote leading-5 font-semibold text-white",
                                it.badge === "alerts" ? "bg-destructive" : "bg-primary",
                              )}
                              aria-label={tr(`${n} 条待处理`, `${n} pending`)}
                            >
                              {n}
                            </span>
                          )}
                          <ChevronRight className="size-4 text-faint" aria-hidden="true" />
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>

        <section className="grid gap-1.5">
          <h2 className="px-4 text-footnote font-medium text-muted-foreground">{tr("偏好", "Preferences")}</h2>
          <div className="overflow-hidden rounded-xl bg-card shadow-card">
            <div className="flex min-h-12 items-center gap-3 border-b border-separator px-4 py-1.5">
              <Tile color="#0ea5e9" size={30}>
                <Languages />
              </Tile>
              <span className="flex-1 text-callout font-medium">{tr("语言", "Language")}</span>
              <Segmented<Lang>
                label={tr("语言", "Language")}
                value={lang}
                onChange={setLang}
                options={[
                  { value: "zh", label: "中文" }, // i18n-ok: a language's own name
                  { value: "en", label: "English" },
                ]}
              />
            </div>
            <div className="flex min-h-12 items-center gap-3 px-4 py-1.5">
              <Tile color="#4f46e5" size={30}>
                {theme === "dark" ? <Moon /> : <Sun />}
              </Tile>
              <span className="flex-1 text-callout font-medium">{tr("外观", "Appearance")}</span>
              <Segmented<Theme>
                label={tr("外观", "Appearance")}
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "light", label: tr("浅色", "Light") },
                  { value: "dark", label: tr("深色", "Dark") },
                ]}
              />
            </div>
          </div>
          <p className="px-4 text-footnote text-faint">
            {tr("只影响本设备上的后台显示。", "Only affects the console on this device.")}
          </p>
        </section>

        <div className="grid gap-1.5">
          <button
            type="button"
            disabled={leaving}
            onClick={async () => {
              setLeaving(true);
              await logout().catch(() => undefined);
              loadPage(signedOutUrl);
            }}
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-card text-callout font-medium text-destructive shadow-card active:bg-accent disabled:opacity-60"
          >
            {leaving ? <Spin /> : <LogOut className="size-4" aria-hidden="true" />}
            {tr("退出登录", "Sign out")}
          </button>
          <p className="text-center text-footnote text-faint">
            {tr(`${site.siteName} 管理后台`, `${site.siteName} admin console`)} · Akari
            {__PANEL_VERSION__ && ` v${__PANEL_VERSION__}`}
          </p>
        </div>
      </div>
    </div>
  );
}
