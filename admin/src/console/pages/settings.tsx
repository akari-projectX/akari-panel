// 系统设置 (SET-*, 2026-10 redesign, proposal §3): sections grouped by
// domain, one URL each (`/settings` = overview, `/settings/<section>`; the
// old `/settings/<tab>` paths redirect). Desktop: the group navigation with
// search (labels, descriptions, old names) next to the section; phone: the
// group list, then the section with "‹ 系统设置". Every section saves one
// way: the bottom save bar (N unsaved changes · discard · save, ⌘/Ctrl+S;
// disabled while fields need fixing); leaving with unsaved changes asks.
import { ChevronLeft, ChevronRight, CloudCog, ExternalLink, Lock, Search, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link, Navigate, useBlocker } from "react-router";
import { cn } from "../../shared/cn";
import { useTr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { Tile } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Input, Kbd, MOD_KEY } from "../../shared/ui/form";
import { useToast } from "../../shared/ui/toast";
import { useErrText } from "../kit";
import { useRoute } from "../router";
import { useCrumb } from "../session";
import { AccessSection, RetentionSection } from "./settings-access";
import { useSettings } from "./settings-data";
import { DomainsSection, SiteSection } from "./settings-general";
import { MOVED_OUT, OLD_IDS, OVERVIEW_TINT, SECTIONS, SETTINGS_IA, type Section, type SectionId } from "./settings-ia";
import { SaveContext, useWide, type SavePart, type SaveRegistry } from "./settings-kit";
import { AlertsSection, MailSection, NoticesSection, TemplatesSection } from "./settings-mail";
import { BlockSection, InstallSection, ProbeSection, UpdatesSection } from "./settings-misc";
import { CommissionSection, PaymentsSection } from "./settings-payments";
import { CleanupSection, LoginSection, SignupSection } from "./settings-signup";
import { RoutingSection, SubscriptionSection } from "./settings-sub";

export { useSettings, type DomainEntry, type Rule, type SettingsView } from "./settings-data";

const BODIES: Record<Exclude<SectionId, "account">, ComponentType> = {
  site: SiteSection,
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
  templates: TemplatesSection,
  notices: NoticesSection,
  alerts: AlertsSection,
  access: AccessSection,
  retention: RetentionSection,
};

const hrefOf = (s: Section) => s.href ?? `/settings/${s.id}`;

export function SettingsPage() {
  const { sub, query } = useRoute();
  const wide = useWide();
  const id = sub[0];
  // Old addresses: the tab ids of the previous layout, and the outbox (now on the status page).
  if (id === "mail" && query.has("outbox"))
    return <Navigate to={`/status?mail=${query.get("outbox") || "dead"}`} replace />;
  if (id && OLD_IDS[id]) return <Navigate to={`/settings/${OLD_IDS[id]}`} replace />;
  if (id === "mail-templates") return <Navigate to="/settings/templates" replace />;
  const cur = id ? SECTIONS.find((s) => s.id === id) : undefined;
  if (id && !cur) return <Navigate to="/settings" replace />;
  if (cur?.href) return <Navigate to={cur.href} replace />;
  if (!wide) return cur ? <SectionPage key={cur.id} s={cur} /> : <PhoneIndex />;
  return (
    <div className="grid grid-cols-[232px_minmax(0,1fr)] gap-6 xl:gap-8">
      <SettingsNav current={cur?.id} />
      <div className="min-w-0">{cur ? <SectionPage key={cur.id} s={cur} /> : <Overview />}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function useSearch() {
  const tr = useTr();
  const [q, setQ] = useState("");
  const t = q.trim().toLowerCase();
  const match = useCallback(
    (s: { zh: string; en: string; keywords: string; desc?: [string, string] }) =>
      !t || `${s.zh} ${s.en} ${s.keywords} ${s.desc?.join(" ") ?? ""}`.toLowerCase().includes(t),
    [t],
  );
  const box = (className?: string) => (
    <div className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint"
        aria-hidden="true"
      />
      <Input
        type="search"
        aria-label={tr("搜索设置", "Search settings")}
        placeholder={tr("搜索设置", "Search settings")}
        className="rounded-full pl-8"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
    </div>
  );
  const moved = t ? MOVED_OUT.filter(match) : [];
  return { q: t, match, box, moved };
}

function Moved({ items }: { items: typeof MOVED_OUT }) {
  const tr = useTr();
  return (
    <>
      {items.map((m) => (
        <Link
          key={m.to}
          to={m.to}
          className="flex min-h-9 items-center gap-2.5 rounded-[9px] px-2 py-1 text-body hover:bg-accent"
        >
          <ExternalLink className="size-4 text-faint" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{tr(m.zh, m.en)}</span>
            <span className="block text-footnote text-muted-foreground">{tr(...m.where)}</span>
          </span>
        </Link>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Desktop navigation and overview
// ---------------------------------------------------------------------------

function SettingsNav({ current }: { current?: SectionId }) {
  const tr = useTr();
  const search = useSearch();
  const item = (on: boolean) =>
    cn(
      "flex h-8 items-center gap-2.5 rounded-[9px] px-2 text-body font-medium transition-colors",
      on ? "bg-primary text-primary-foreground" : "hover:bg-accent",
    );
  const groups = SETTINGS_IA.map((g) => ({ ...g, sections: g.sections.filter(search.match) })).filter(
    (g) => g.sections.length > 0,
  );
  return (
    <aside className="sticky top-[76px] max-h-[calc(100dvh-100px)] self-start overflow-y-auto pr-1 pb-6">
      <h1 className="mb-3 text-title2 font-bold tracking-[-0.02em]">{tr("系统设置", "Settings")}</h1>
      {search.box("mb-3")}
      <nav aria-label={tr("设置分类", "Settings sections")}>
        {!search.q && (
          <Link to="/settings" aria-current={!current ? "page" : undefined} className={cn(item(!current), "mb-1")}>
            <Tile color={OVERVIEW_TINT}>
              <CloudCog />
            </Tile>
            {tr("概览", "Overview")}
          </Link>
        )}
        {groups.map((g) => (
          <div key={g.zh} className="mt-3">
            <div className="px-2 pb-1 text-caption font-semibold text-faint">{tr(g.zh, g.en)}</div>
            {g.sections.map((s) => (
              <Link
                key={s.id}
                to={hrefOf(s)}
                aria-current={current === s.id ? "page" : undefined}
                className={item(current === s.id)}
              >
                <Tile color={s.tint}>
                  <s.icon />
                </Tile>
                <span className="flex-1 truncate">{tr(s.zh, s.en)}</span>
                {s.owner && (
                  <Lock
                    className={cn("size-3", current === s.id ? "text-primary-foreground/80" : "text-faint")}
                    aria-label={tr("仅所有者可修改", "Owner only")}
                  />
                )}
                {s.href && <ChevronRight className="size-3.5 text-faint" aria-hidden="true" />}
              </Link>
            ))}
          </div>
        ))}
        {search.moved.length > 0 && (
          <div className="mt-3">
            <div className="px-2 pb-1 text-caption font-semibold text-faint">{tr("已移出设置", "Moved elsewhere")}</div>
            <Moved items={search.moved} />
          </div>
        )}
        {search.q && groups.length === 0 && search.moved.length === 0 && (
          <p className="px-2 py-3 text-footnote text-muted-foreground">
            {tr("没有匹配的设置", "No matching settings")}
          </p>
        )}
      </nav>
    </aside>
  );
}

/** "需要注意": obsolete panel.toml keys (SET-25) and the standing warnings of /settings. */
function Attention() {
  const tr = useTr();
  const s = useSettings();
  const d = s.data;
  if (!d || (d.obsolete_config_keys.length === 0 && d.warnings.length === 0)) return null;
  return (
    <section
      aria-label={tr("需要注意", "Needs attention")}
      className="grid gap-2 rounded-xl bg-warning-soft px-4 py-3 text-body"
    >
      <div className="flex items-center gap-2 font-semibold">
        <TriangleAlert className="size-4 text-warning" aria-hidden="true" />
        {tr("需要注意", "Needs attention")}
      </div>
      {d.obsolete_config_keys.length > 0 && (
        <div>
          <div className="font-medium">{tr("panel.toml 中有已废弃的键", "panel.toml has obsolete keys")}</div>
          <div className="text-footnote text-muted-foreground">
            {tr(
              "这些设置已经搬到系统设置里，请从 panel.toml 删除：",
              "These settings moved here; delete them from panel.toml: ",
            )}
            <code className="font-mono break-all text-foreground">{d.obsolete_config_keys.join(", ")}</code>
          </div>
        </div>
      )}
      {d.warnings.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ul className="min-w-0 flex-1 list-disc pl-4 text-footnote">
            {d.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <Button asChild size="sm" variant="outline">
            <Link to="/settings/domains">{tr("查看域名与证书", "Open domains")}</Link>
          </Button>
        </div>
      )}
    </section>
  );
}

function Overview() {
  const tr = useTr();
  useCrumb(tr("概览", "Overview"));
  return (
    <div className="grid gap-6">
      <div className="pt-1">
        <h2 className="text-title2 font-bold tracking-[-0.02em]">{tr("概览", "Overview")}</h2>
        <p className="mt-1 text-body text-muted-foreground">
          {tr("带", "Sections with")} <Lock className="inline size-3" aria-label={tr("锁", "a lock")} />{" "}
          {tr("的分区只有所有者能修改；带", "only the owner can change; sections with")}{" "}
          <TriangleAlert className="inline size-3 text-warning" aria-label={tr("警告", "a warning sign")} />{" "}
          {tr(
            "的分区含有影响全站的操作，单独放在分区底部的「危险操作」里，保存时会再确认。",
            "hold site-wide actions, kept apart in their danger zone and confirmed on save.",
          )}
        </p>
      </div>
      <Attention />
      {SETTINGS_IA.map((g) => (
        <section key={g.zh}>
          <h3 className="mb-2 px-1 text-footnote font-semibold text-muted-foreground">{tr(g.zh, g.en)}</h3>
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {g.sections.map((s) => (
              <Link
                key={s.id}
                to={hrefOf(s)}
                className="group flex items-center gap-3 rounded-xl bg-card p-3.5 shadow-card transition-shadow hover:shadow-raised"
              >
                <Tile color={s.tint} size={32}>
                  <s.icon />
                </Tile>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-body font-semibold">
                    {tr(s.zh, s.en)}
                    {s.owner && <Lock className="size-3 text-faint" aria-label={tr("仅所有者可修改", "Owner only")} />}
                    {s.danger && (
                      <TriangleAlert
                        className="size-3 text-warning"
                        aria-label={tr("含危险操作", "Has a danger zone")}
                      />
                    )}
                  </div>
                  <div className="line-clamp-2 text-footnote text-muted-foreground">{tr(...s.desc)}</div>
                </div>
                <ChevronRight
                  className="size-4 text-faint transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phone: the group list
// ---------------------------------------------------------------------------

function PhoneIndex() {
  const tr = useTr();
  const search = useSearch();
  const groups = SETTINGS_IA.map((g) => ({ ...g, sections: g.sections.filter(search.match) })).filter(
    (g) => g.sections.length > 0,
  );
  return (
    <>
      <h1 className="mb-3 text-title1 font-bold tracking-[-0.02em]">{tr("系统设置", "Settings")}</h1>
      {search.box("mb-4")}
      <div className="mb-5">
        <Attention />
      </div>
      <nav aria-label={tr("设置分类", "Settings sections")} className="grid gap-5">
        {groups.map((g) => (
          <section key={g.zh} className="grid gap-1.5">
            <h2 className="px-4 text-footnote font-semibold text-muted-foreground">{tr(g.zh, g.en)}</h2>
            <div className="divide-y divide-separator overflow-hidden rounded-xl bg-card shadow-card">
              {g.sections.map((s) => (
                <Link key={s.id} to={hrefOf(s)} className="flex min-h-12 items-center gap-3 px-4 py-2 active:bg-accent">
                  <Tile color={s.tint} size={28}>
                    <s.icon />
                  </Tile>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-callout font-medium">
                      {tr(s.zh, s.en)}
                      {s.owner && (
                        <Lock className="size-3 text-faint" aria-label={tr("仅所有者可修改", "Owner only")} />
                      )}
                    </div>
                    <div className="truncate text-footnote text-muted-foreground">{tr(...s.desc)}</div>
                  </div>
                  <ChevronRight className="size-4 text-faint" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </section>
        ))}
        {search.moved.length > 0 && (
          <section className="grid gap-1.5">
            <h2 className="px-4 text-footnote font-semibold text-muted-foreground">
              {tr("已移出设置", "Moved elsewhere")}
            </h2>
            <div className="rounded-xl bg-card p-1.5 shadow-card">
              <Moved items={search.moved} />
            </div>
          </section>
        )}
        {search.q && groups.length === 0 && search.moved.length === 0 && (
          <p className="px-4 text-footnote text-muted-foreground">{tr("没有匹配的设置", "No matching settings")}</p>
        )}
      </nav>
    </>
  );
}

// ---------------------------------------------------------------------------
// A section: header, body, the save bar and the leave guard
// ---------------------------------------------------------------------------

function SectionPage({ s }: { s: Section }) {
  const tr = useTr();
  const wide = useWide();
  const Body = BODIES[s.id as Exclude<SectionId, "account">];
  useCrumb(tr(s.zh, s.en));
  return (
    <SaveScope>
      <div className="pb-6">
        {!wide && (
          <Link
            to="/settings"
            className="-ml-1 mb-2 inline-flex min-h-11 items-center text-callout text-primary"
            aria-label={tr("返回系统设置", "Back to Settings")}
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
            {tr("系统设置", "Settings")}
          </Link>
        )}
        <header className="mb-5 flex items-start gap-3 pt-1">
          <Tile color={s.tint} size={36}>
            <s.icon />
          </Tile>
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 text-title2 font-bold tracking-[-0.02em]">
              {tr(s.zh, s.en)}
            </h2>
            <p className="mt-0.5 text-body text-muted-foreground">{tr(...s.desc)}</p>
          </div>
        </header>
        <div className="grid gap-6">
          <Body />
        </div>
      </div>
    </SaveScope>
  );
}

function SaveScope({ children }: { children: ReactNode }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrText();
  const parts = useRef(new Map<string, { current: SavePart }>());
  const [, setTick] = useState(0);
  const registry = useMemo<SaveRegistry>(
    () => ({
      set: (id, part) => {
        parts.current.set(id, part);
        setTick((t) => t + 1);
      },
      remove: (id) => {
        parts.current.delete(id);
        setTick((t) => t + 1);
      },
      bump: () => setTick((t) => t + 1),
    }),
    [],
  );
  const all = [...parts.current.values()].map((p) => p.current);
  const count = all.reduce((n, p) => n + p.count, 0);
  const errors = all.reduce((n, p) => n + (p.count > 0 ? p.errors : 0), 0);
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);
  dirty.current = count > 0;

  const save = useCallback(async () => {
    const list = [...parts.current.values()].map((p) => p.current);
    if (saving || list.some((p) => p.count > 0 && p.errors > 0)) return;
    setSaving(true);
    try {
      for (const p of list) if (p.count > 0 && !(await p.save())) return;
    } catch (e) {
      toast({ tone: "error", title: errText(e) });
    } finally {
      setSaving(false);
    }
  }, [saving, toast, errText]);
  const discard = () => {
    for (const p of parts.current.values()) p.current.discard();
  };

  // ⌘/Ctrl+S saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty.current) void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leaving with unsaved changes asks (another section, another page, the browser).
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void confirm({
      title: tr("放弃未保存的修改？", "Discard unsaved changes?"),
      description: tr(
        `这个分区还有 ${count} 项修改没有保存，离开后不会保存。`,
        `${count} changes in this section are not saved; they are lost if you leave.`,
      ),
      confirmLabel: tr("放弃修改", "Discard"),
      tone: "warning",
    }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state]);
  useEffect(() => {
    if (count === 0) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [count]);

  return (
    <SaveContext.Provider value={registry}>
      {children}
      {count > 0 && (
        <div
          role="region"
          aria-label={tr("保存栏", "Save bar")}
          className="glass sticky bottom-[calc(64px+env(safe-area-inset-bottom))] z-20 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-(--glass-toolbar) px-4 py-2.5 shadow-pop animate-in fade-in-0 slide-in-from-bottom-2 lg:bottom-5"
        >
          <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-body" role="status">
            <span className="font-medium">
              {tr(`${count} 项未保存的修改`, `${count} unsaved ${count === 1 ? "change" : "changes"}`)}
            </span>
            {errors > 0 && (
              <span className="ml-2 text-destructive max-sm:ml-0 max-sm:block">
                {tr(`· ${errors} 处需要修正`, `· ${errors} to fix`)}
              </span>
            )}
          </span>
          <Button variant="ghost" size="sm" disabled={saving} onClick={discard}>
            {tr("放弃", "Discard")}
          </Button>
          <Button variant="primary" size="sm" loading={saving} disabled={errors > 0} onClick={() => void save()}>
            {tr("保存", "Save")}
            <span aria-hidden="true" className="max-sm:hidden">
              <Kbd className="bg-white/20 text-white">{MOD_KEY === "⌘" ? "⌘S" : "Ctrl S"}</Kbd>
            </span>
          </Button>
        </div>
      )}
    </SaveContext.Provider>
  );
}
