// 系统设置 (SET-*, 2026-10 redesign v2, proposal-v2 §5): 8 groups / 22
// sections, one URL each (`/settings` = overview, `/settings/<section>`;
// `/settings/templates` is the full-width template editor; old tab ids,
// the v2 aliases and `?section=<id>` redirect). Desktop: the group
// navigation (search over section names and the rows inside, `?q=`; amber
// dot = something to fix; lock = owner only) next to the overview or a
// section; phone: big title + search → needs attention → groups → section
// with "‹ 系统设置". Every section saves one way: the bottom save bar
// (N 项未保存的修改 · 放弃 · 保存 ⌘S; "N 处需要修正" blocks saving); leaving
// with unsaved changes asks "有未保存的修改" (放弃修改，去「X」/ 继续编辑).
import { ChevronLeft, CornerDownRight, ExternalLink, History, Info, Lock } from "lucide-react";
import { type ComponentType } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { cn } from "../../shared/cn";
import { dateTime } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Card, Tile } from "../../shared/ui/card";
import { SearchField } from "../components/kit";
import { SectionForm, useOwner, useWide } from "../components/settings-kit";
import { useRoute } from "../router";
import { useCrumb } from "../session";
import { AccessSection, AccountSection, RetentionSection } from "./settings-access";
import { BrandSection, DomainsSection, LinksSection, SiteSection } from "./settings-general";
import {
  MOVED_OUT,
  OLD_IDS,
  OVERVIEW_TINT,
  SECTIONS,
  SETTINGS_IA,
  groupOf,
  searchSettings,
  type Section,
  type SectionId,
} from "./settings-ia";
import { AlertsSection, MailSection, NoticesSection } from "./settings-mail";
import { BlockSection, InstallSection, ProbeSection, UpdatesSection } from "./settings-misc";
import { Overview, PhoneGroups, flagged, hrefOf, useLastEdit, useOverview, type Attn } from "./settings-overview";
import { CommissionSection, PaymentsSection } from "./settings-payments";
import { CleanupSection, LoginSection, SignupSection } from "./settings-signup";
import { RoutingSection, SubscriptionSection } from "./settings-sub";

export { useSettings, type DomainEntry, type Rule, type SettingsView } from "./settings-data";

const BODIES: Record<Exclude<SectionId, "templates">, ComponentType> = {
  site: SiteSection,
  brand: BrandSection,
  links: LinksSection,
  domains: DomainsSection,
  signup: SignupSection,
  login: LoginSection,
  cleanup: CleanupSection,
  subscription: SubscriptionSection,
  routing: RoutingSection,
  install: InstallSection,
  probe: ProbeSection,
  block: BlockSection,
  updates: UpdatesSection,
  payments: PaymentsSection,
  commission: CommissionSection,
  mail: MailSection,
  notices: NoticesSection,
  alerts: AlertsSection,
  access: AccessSection,
  retention: RetentionSection,
  account: AccountSection,
};

export function SettingsPage() {
  const { sub, query } = useRoute();
  const wide = useWide();
  const data = useOverview();
  const id = sub[0];
  // Old addresses: `?section=`, the tab ids of the previous layout and the v2 aliases, the outbox.
  const legacy = query.get("section");
  if (!id && legacy) return <Navigate to={`/settings/${OLD_IDS[legacy] ?? legacy}`} replace />;
  if (id === "mail" && query.has("outbox"))
    return <Navigate to={`/status?mail=${query.get("outbox") || "dead"}`} replace />;
  if (id && OLD_IDS[id]) return <Navigate to={`/settings/${OLD_IDS[id]}${location.search}`} replace />;
  const cur = id ? SECTIONS.find((s) => s.id === id) : undefined;
  if (id && !cur) return <Navigate to="/settings" replace />;
  if (cur?.href) return <Navigate to={cur.href} replace />;
  if (!wide) return cur ? <SectionPage key={cur.id} s={cur} /> : <PhoneIndex data={data} />;
  return (
    <div className="grid grid-cols-[236px_minmax(0,1fr)] gap-6 xl:gap-10">
      <SettingsNav current={cur?.id} attn={data.attn} />
      <div className="min-w-0">{cur ? <SectionPage key={cur.id} s={cur} /> : <Overview data={data} />}</div>
    </div>
  );
}

/** The name of where a path leads (the leave guard's "去「X」"). */
function placeName(path: string, tr: ReturnType<typeof useTr>): string | undefined {
  const m = /\/settings(?:\/([^/?#]+))?\/?$/.exec(path);
  if (!m) return undefined;
  if (!m[1]) return tr("概览", "Overview");
  const s = SECTIONS.find((x) => x.id === (OLD_IDS[m[1]] ?? m[1]));
  return s ? tr(s.zh, s.en) : undefined;
}

// ---------------------------------------------------------------------------
// Search (`?q=`): section names, then "row ↳ group › section"
// ---------------------------------------------------------------------------

function useSearchQ(): [string, (v: string) => void] {
  const [sp, setSp] = useSearchParams();
  return [
    sp.get("q") ?? "",
    (v) =>
      setSp(
        (p) => {
          const n = new URLSearchParams(p);
          if (v) n.set("q", v);
          else n.delete("q");
          return n;
        },
        { replace: true },
      ),
  ];
}

function Mark({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (i < 0) return <>{text}</>;
  const n = q.trim().length;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[3px] bg-warning-soft px-px text-foreground">{text.slice(i, i + n)}</mark>
      {text.slice(i + n)}
    </>
  );
}

function SearchResults({ q }: { q: string }) {
  const tr = useTr();
  const hits = searchSettings(q);
  const t = q.trim().toLowerCase();
  const moved = MOVED_OUT.filter((m) => `${m.zh} ${m.en} ${m.keywords}`.toLowerCase().includes(t));
  if (hits.length === 0 && moved.length === 0)
    return (
      <p className="px-2 py-6 text-center text-footnote text-muted-foreground">
        {tr(`没有匹配「${q.trim()}」的设置`, `No settings match “${q.trim()}”`)}
      </p>
    );
  return (
    <div className="grid gap-0.5">
      <div className="px-2 pb-1 text-caption font-semibold text-faint">
        {tr(`${hits.length + moved.length} 个结果`, `${hits.length + moved.length} results`)}
      </div>
      {hits.map((h, i) => {
        const g = groupOf(h.section.id);
        const label = h.row ? tr(...h.row) : tr(h.section.zh, h.section.en);
        return (
          <Link
            key={`${h.section.id}-${i}`}
            to={hrefOf(h.section)}
            className="flex min-h-11 items-center gap-2.5 rounded-[9px] px-2 py-1.5 hover:bg-accent"
          >
            <Tile color={h.section.tint}>
              <h.section.icon />
            </Tile>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-medium">
                <Mark text={label} q={q} />
              </span>
              {h.row ? (
                <span className="flex items-center gap-1 truncate text-caption text-muted-foreground">
                  <CornerDownRight className="size-3 shrink-0" aria-hidden="true" />
                  {tr(g.zh, g.en)} › {tr(h.section.zh, h.section.en)}
                </span>
              ) : (
                <span className="block truncate text-caption text-muted-foreground">{tr(g.zh, g.en)}</span>
              )}
            </span>
          </Link>
        );
      })}
      {moved.map((m) => (
        <Link
          key={m.to}
          to={m.to}
          className="flex min-h-11 items-center gap-2.5 rounded-[9px] px-2 py-1.5 hover:bg-accent"
        >
          <ExternalLink className="size-4 text-faint" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{tr(m.zh, m.en)}</span>
            <span className="block text-caption text-muted-foreground">{tr(...m.where)}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop navigation
// ---------------------------------------------------------------------------

function SettingsNav({ current, attn }: { current?: SectionId; attn: Attn[] }) {
  const tr = useTr();
  const owner = useOwner();
  const [q, setQ] = useSearchQ();
  const item = (on: boolean) =>
    cn(
      "flex h-8 items-center gap-2.5 rounded-[9px] px-2 text-body font-medium transition-colors",
      on ? "bg-primary text-primary-foreground" : "hover:bg-accent",
    );
  return (
    <aside className="sticky top-[76px] max-h-[calc(100dvh-100px)] self-start overflow-y-auto pr-1 pb-6 [scrollbar-width:thin]">
      <h1 className="mb-3 px-1 text-title2 font-bold tracking-[-0.02em]">{tr("系统设置", "Settings")}</h1>
      <SearchField
        value={q}
        onChange={setQ}
        label={tr("搜索设置", "Search settings")}
        placeholder={tr("搜索设置，如 时区、Turnstile", "Search, e.g. time zone, Turnstile")}
        className="mb-3 [&_input]:rounded-full"
      />
      <nav aria-label={tr("设置分类", "Settings sections")}>
        {q.trim() ? (
          <SearchResults q={q} />
        ) : (
          <>
            <Link to="/settings" aria-current={!current ? "page" : undefined} className={cn(item(!current), "mb-1")}>
              <Tile color={OVERVIEW_TINT}>
                <Info />
              </Tile>
              <span className="flex-1">{tr("概览", "Overview")}</span>
              {attn.length > 0 && (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-caption font-semibold tabular-nums",
                    !current ? "bg-primary-foreground/20" : "bg-warning-soft text-warning",
                  )}
                  aria-label={tr(`${attn.length} 项需要注意`, `${attn.length} need attention`)}
                >
                  {attn.length}
                </span>
              )}
            </Link>
            {SETTINGS_IA.map((g) => (
              <div key={g.zh} className="mt-3">
                <div className="px-2 pb-1 text-caption font-semibold text-faint">{tr(g.zh, g.en)}</div>
                {g.sections.map((s) => {
                  const on = current === s.id;
                  return (
                    <Link key={s.id} to={hrefOf(s)} aria-current={on ? "page" : undefined} className={item(on)}>
                      <Tile color={s.tint}>
                        <s.icon />
                      </Tile>
                      <span className="flex-1 truncate">{tr(s.zh, s.en)}</span>
                      {flagged(attn, s.id) && (
                        <span
                          className={cn("size-1.5 rounded-full", on ? "bg-primary-foreground" : "bg-warning")}
                          role="img"
                          aria-label={tr("需要注意", "Needs attention")}
                        />
                      )}
                      {s.owner && (
                        <Lock
                          className={cn(
                            "size-3 shrink-0",
                            on ? "text-primary-foreground/80" : owner ? "text-faint" : "text-muted-foreground",
                          )}
                          aria-label={tr("仅所有者可修改", "Owner only")}
                        />
                      )}
                    </Link>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </nav>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Phone: title, search, needs attention, the groups
// ---------------------------------------------------------------------------

function PhoneIndex({ data }: { data: ReturnType<typeof useOverview> }) {
  const tr = useTr();
  const [q, setQ] = useSearchQ();
  useCrumb(tr("系统设置", "Settings"));
  return (
    <>
      <h1 className="mb-3 text-title1 font-bold tracking-[-0.02em]">{tr("系统设置", "Settings")}</h1>
      <SearchField
        value={q}
        onChange={setQ}
        label={tr("搜索设置", "Search settings")}
        className="mb-4 [&_input]:h-10 [&_input]:rounded-[11px]"
      />
      {q.trim() ? (
        <Card className="p-1.5">
          <nav aria-label={tr("设置分类", "Settings sections")}>
            <SearchResults q={q} />
          </nav>
        </Card>
      ) : (
        <PhoneGroups data={data} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// A section: header (icon, title, one line, last change), body, save bar, leave guard
// ---------------------------------------------------------------------------

function SectionPage({ s }: { s: Section }) {
  const tr = useTr();
  const wide = useWide();
  const owner = useOwner();
  const Body = BODIES[s.id as Exclude<SectionId, "templates">];
  const last = useLastEdit(s.audit);
  useCrumb(tr(s.zh, s.en));
  return (
    <SectionForm placeName={(p) => placeName(p, tr)}>
      {!wide && (
        <Link
          to="/settings"
          className="-ml-1.5 mb-2 inline-flex min-h-11 items-center text-callout text-primary"
          aria-label={tr("返回系统设置", "Back to Settings")}
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
          {tr("系统设置", "Settings")}
        </Link>
      )}
      <header className="mb-5 flex flex-wrap items-start gap-x-3 gap-y-2 pt-1">
        <Tile color={s.tint} size={36}>
          <s.icon />
        </Tile>
        <div className="min-w-0 flex-1 basis-60">
          <h2 className="flex flex-wrap items-center gap-2 text-title2 font-bold tracking-[-0.02em]">
            {tr(s.zh, s.en)}
            {s.owner && (
              <Badge tone={owner ? "neutral" : "warning"}>
                <Lock aria-hidden="true" />
                {owner ? tr("部分仅所有者", "Partly owner only") : tr("仅所有者可修改", "Owner only")}
              </Badge>
            )}
          </h2>
          <p className="mt-0.5 max-w-[680px] text-body text-muted-foreground">{tr(...s.desc)}</p>
        </div>
        {last && (
          <Link
            to={`/audit?action=${encodeURIComponent(last.action)}&entry=${last.id}`}
            className="inline-flex items-center gap-1 pt-1.5 text-footnote text-faint hover:text-foreground max-sm:hidden"
          >
            <History className="size-3.5" aria-hidden="true" />
            {tr("上次修改", "Last changed")} {dateTime(last.at)} · {last.actor_email ?? last.actor_label}
          </Link>
        )}
      </header>
      <div className="grid gap-6">
        <Body />
      </div>
    </SectionForm>
  );
}
