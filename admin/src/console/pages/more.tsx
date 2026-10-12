// "More" (phones): every page in one screen, grouped like the sidebar,
// system-settings style (coloured tiles, chevrons), plus language and theme.
import { ChevronRight, Languages, Moon } from "lucide-react";
import { Link } from "react-router";
import { useLang, useSetLang, useTr } from "../../shared/i18n";
import { useTheme } from "../../shared/theme";
import { Tile } from "../../shared/ui/card";
import { PageHeader } from "../../shared/ui/layout";
import { NAV, pathOf } from "../nav";
import { useBadges } from "../session";

export function MorePage() {
  const tr = useTr();
  const lang = useLang();
  const setLang = useSetLang();
  const [theme, toggleTheme] = useTheme();
  const badges = useBadges();
  const row = "flex h-12 items-center gap-3 px-4 text-left active:bg-accent";
  return (
    <>
      <PageHeader title={tr("更多", "More")} />
      <nav aria-label={tr("全部页面", "All pages")} className="grid gap-5">
        {NAV.map((g) => (
          <section key={g.zh} className="grid gap-1.5">
            <h2 className="px-1 text-footnote font-semibold text-muted-foreground">{tr(g.zh, g.en)}</h2>
            <ul className="divide-y divide-separator overflow-hidden rounded-xl bg-card shadow-card">
              {g.items.map((it) => {
                const n =
                  it.badge === "tickets"
                    ? (badges.data?.tickets_unread ?? 0)
                    : it.badge === "alerts"
                      ? (badges.data?.alerts_firing ?? 0)
                      : 0;
                return (
                  <li key={it.id}>
                    <Link to={pathOf(it.id)} className={row}>
                      <Tile color={it.tint} size={28}>
                        <it.icon />
                      </Tile>
                      <span className="flex-1 text-callout font-medium">{tr(it.zh, it.en)}</span>
                      {n > 0 && (
                        <span
                          className="tnum rounded-full bg-destructive px-1.5 text-caption leading-4 font-semibold text-white"
                          aria-label={tr(`${n} 条待处理`, `${n} pending`)}
                        >
                          {n}
                        </span>
                      )}
                      <ChevronRight className="size-4 text-faint" aria-hidden="true" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
      <section className="mt-5 grid gap-1.5">
        <h2 className="px-1 text-footnote font-semibold text-muted-foreground">{tr("偏好", "Preferences")}</h2>
        <div className="divide-y divide-separator overflow-hidden rounded-xl bg-card shadow-card">
          <button type="button" className={`${row} w-full`} onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
            <Tile color="#0ea5e9" size={28}>
              <Languages />
            </Tile>
            <span className="flex-1 text-callout font-medium">{tr("语言", "Language")}</span>
            <span className="text-body text-muted-foreground">{lang === "zh" ? "中文" : "English"}</span>
          </button>
          <button type="button" className={`${row} w-full`} onClick={toggleTheme}>
            <Tile color="#4b5563" size={28}>
              <Moon />
            </Tile>
            <span className="flex-1 text-callout font-medium">{tr("深色模式", "Dark mode")}</span>
            <span className="text-body text-muted-foreground">
              {theme === "dark" ? tr("开", "On") : tr("关", "Off")}
            </span>
          </button>
        </div>
      </section>
    </>
  );
}
