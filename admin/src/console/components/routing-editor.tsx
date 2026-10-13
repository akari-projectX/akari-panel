// 分流规则编辑器的积木（路由 PR 3，SET-11）：一个分区的条目列表 + 自动识别
// 的输入框（建议列表：↑↓ 选择、回车添加、Esc 关闭）、服务的线路（首选 +
// 有序备用）、线路选择框、"这个网站会走哪？"、效果一句话、客户端分组预览。
// 只用后台的令牌与 v2 kit；状态在页面（settings-routing.tsx）里。
import { ArrowDown, ArrowUp, ArrowRight, CircleAlert, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { cn } from "../../shared/cn";
import { ago } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Input, Select } from "../../shared/ui/form";
import type { LineRef, Routing, RoutingItem } from "../pages/settings-data";
import {
  DOMAIN_CYCLE,
  MAX_BACKUPS,
  MAX_ITEMS,
  chainOf,
  clientGroups,
  entranceName,
  itemKey,
  itemLabel,
  kindName,
  refKey,
  refName,
  refOf,
  resolve,
  suggest,
  summary,
  type Catalog,
  type RuleSetCheck,
  type RuleSetStatus,
  type Service,
  type Suggestion,
} from "./routing-model";

/** A rule-set link's check, as the page tracks it. */
export type CheckState =
  { state: "checking" } | { state: "ok"; data: RuleSetCheck } | { state: "error"; text: string; code: string };

/** The blue "edited" bar on the left of a block (settings-kit's, local). */
export function EditedBar() {
  const tr = useTr();
  return (
    <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" data-changed>
      <span className="sr-only">{tr("已修改", "Edited")}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function RuleSetState({
  url,
  check,
  stored,
  onCheck,
}: {
  url: string;
  check: CheckState | undefined;
  stored: RuleSetStatus | undefined;
  onCheck: (url: string) => void;
}) {
  const tr = useTr();
  const lang = useLang();
  const sep = lang === "en" ? ", " : "、";
  const counts = check?.state === "ok" ? check.data.counts : stored?.counts;
  const parts: ReactNode[] = [];
  if (check?.state === "checking")
    parts.push(
      <span key="c" className="inline-flex items-center gap-1 text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {tr("下载并校验中…", "Downloading and checking…")}
      </span>,
    );
  if (check?.state === "error")
    parts.push(
      <span key="e" className="inline-flex items-center gap-1 text-destructive" role="alert">
        <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        {check.text}
      </span>,
    );
  if (counts && check?.state !== "checking" && check?.state !== "error") {
    const kept = counts.domain + counts.domain_suffix + counts.domain_keyword + counts.ip_cidr;
    const types = Object.entries(counts.unsupported_types)
      .map(([k, n]) => `${k} ${n}`)
      .join(sep);
    parts.push(
      <span key="n" className="text-muted-foreground" data-rule-count={kept}>
        {tr(`${kept.toLocaleString()} 条规则`, `${kept.toLocaleString()} rules`)}
      </span>,
    );
    if (counts.unsupported)
      parts.push(
        <span key="u" className="text-warning">
          {tr(
            `sing-box 不支持 ${counts.unsupported} 条（${types}），已跳过；Clash 照常使用`,
            `${counts.unsupported} not supported by sing-box (${types}), skipped there; Clash uses them`,
          )}
        </span>,
      );
  }
  if (stored && check?.state !== "checking") {
    if (stored.failing_since)
      parts.push(
        <span key="f" className="inline-flex items-center gap-1 text-warning">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {tr(
            `每日刷新失败（${ago(stored.failing_since, lang)}起），仍用上一份副本`,
            `Daily refresh failing since ${ago(stored.failing_since, lang)}; the last copy is still used`,
          )}
          {stored.last_error ? `: ${stored.last_error}` : ""}
        </span>,
      );
    else if (stored.fetched_at)
      parts.push(
        <span key="s" className="text-faint">
          {tr(`面板副本 ${ago(stored.fetched_at, lang)}下载`, `Panel copy fetched ${ago(stored.fetched_at, lang)}`)}
        </span>,
      );
  } else if (!check && !stored)
    parts.push(
      <span key="w" className="text-faint">
        {tr("保存时由面板下载校验", "The panel downloads and checks it on save")}
      </span>,
    );
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-2 text-footnote">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 && (
            <span className="text-faint" aria-hidden="true">
              ·
            </span>
          )}
          {p}
        </span>
      ))}
      {check?.state !== "checking" && (
        <Button
          size="sm"
          variant="ghost"
          icon={RefreshCw}
          className="text-primary"
          aria-label={tr(`重新检查 ${url}`, `Check ${url} again`)}
          onClick={() => onCheck(url)}
        >
          {tr("检查", "Check")}
        </Button>
      )}
    </div>
  );
}

export function ItemRow({
  item,
  catalog,
  conflict,
  error,
  check,
  stored,
  onKind,
  onRemove,
  onCheck,
}: {
  item: RoutingItem;
  catalog: Catalog | undefined;
  conflict?: string;
  error?: string;
  check?: CheckState;
  stored?: RuleSetStatus;
  onKind: () => void;
  onRemove: () => void;
  onCheck: (url: string) => void;
}) {
  const tr = useTr();
  const L = itemLabel(item, catalog, tr);
  const kind = kindName(item.type, tr);
  const domain = item.type in DOMAIN_CYCLE;
  return (
    <li
      className={cn("grid gap-0.5 rounded-lg px-2 py-1.5 hover:bg-accent", error && "bg-destructive-soft/50")}
      data-item={itemKey(item)}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn("min-w-0 truncate text-body font-medium", conflict && "text-muted-foreground line-through")}
        >
          {L.name}
        </span>
        {domain ? (
          <button
            type="button"
            onClick={onKind}
            title={tr("点击切换：后缀 / 精确 / 关键词", "Click to switch: suffix / exact / keyword")}
            aria-label={tr(`切换类型（现在：${kind}）`, `Switch the type (now: ${kind})`)}
            className="hit-44 inline-flex items-center gap-1 rounded-md px-1.5 text-caption text-muted-foreground ring-1 ring-border ring-inset hover:text-primary hover:ring-primary"
          >
            {kind} ⇄
          </button>
        ) : (
          <span className="rounded-md px-1.5 text-caption text-muted-foreground ring-1 ring-border ring-inset">
            {kind}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-faint max-sm:basis-full max-sm:order-last">
          {L.raw}
        </span>
        {conflict && (
          <Badge tone="warning">
            {tr(`已在「${conflict}」里，这里不生效`, `Already in "${conflict}": never reached here`)}
          </Badge>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          icon={X}
          className="ml-auto text-faint hover:text-destructive"
          aria-label={tr(`删除 ${L.name}`, `Remove ${L.name}`)}
          onClick={onRemove}
        />
      </div>
      {item.type === "rule_set" && <RuleSetState url={item.value} check={check} stored={stored} onCheck={onCheck} />}
      {error && (
        <p className="flex items-center gap-1 pl-2 text-footnote text-destructive" role="alert">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </li>
  );
}

/** The one input of a section: detects a domain, an IP range, a category or a rule-set link. */
export function Adder({
  label,
  catalog,
  existing,
  disabled,
  onAdd,
}: {
  label: string;
  catalog: Catalog | undefined;
  existing: RoutingItem[];
  disabled?: boolean;
  onAdd: (it: RoutingItem) => void;
}) {
  const tr = useTr();
  const id = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const opts = suggest(text, catalog, tr);
  const pickable = opts.map((o, i) => (o.item ? i : -1)).filter((i) => i >= 0);
  const cur = pickable.includes(sel) ? sel : (pickable[0] ?? -1);
  const pick = (o: Suggestion | undefined) => {
    if (!o?.item) return;
    if (existing.some((x) => itemKey(x) === itemKey(o.item!))) {
      setNote(tr("这一项已经在这里了", "Already here"));
      return;
    }
    onAdd(o.item);
    setText("");
    setOpen(false);
    setNote(null);
  };
  const move = (d: 1 | -1) => {
    if (!pickable.length) return;
    const at = pickable.indexOf(cur);
    setSel(pickable[(at + d + pickable.length) % pickable.length]);
  };
  const groupName = (g: Suggestion["group"]) =>
    g === "category"
      ? tr("分类", "Categories")
      : g === "rule_set"
        ? tr("远程规则集", "Remote rule-set")
        : g === "keyword"
          ? tr("关键词", "Keyword")
          : tr("识别为", "Detected as");
  const show = open && opts.length > 0;
  const groups = opts.map((o) => o.group).filter((g, i, all) => all.indexOf(g) === i);
  return (
    <div className="relative max-w-xl">
      <Input
        role="combobox"
        aria-label={label}
        aria-expanded={show}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={show && cur >= 0 ? `${id}-o${cur}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={text}
        placeholder={tr(
          "+ 添加网站、IP 段、分类或规则集链接（如 example.com、奈飞、https://…/Claude.yaml）",
          "+ Add a site, IP range, category or rule-set link (example.com, netflix, https://…/Claude.yaml)",
        )}
        className="border-dashed bg-transparent focus:bg-card"
        onChange={(e) => {
          setText(e.target.value);
          setSel(0);
          setOpen(true);
          setNote(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            move(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(opts[cur]);
          } else if (e.key === "Escape" && show) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {note && <p className="mt-1 text-footnote text-warning">{note}</p>}
      {show && (
        <div
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label={tr("建议", "Suggestions")}
          className="absolute inset-x-0 top-full z-30 mt-1 grid gap-0.5 rounded-xl bg-card p-1 shadow-pop"
          onMouseDown={(e) => e.preventDefault()}
        >
          {groups.map((g) => (
            <div key={g} role="group" aria-label={groupName(g)} className="grid gap-0.5">
              <div aria-hidden="true" className="px-2.5 pt-1.5 pb-0.5 text-caption font-medium text-faint">
                {groupName(g)}
              </div>
              {opts.map((o, i) =>
                o.group !== g ? null : (
                  <button
                    key={i}
                    id={`${id}-o${i}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === cur}
                    aria-disabled={!o.item || undefined}
                    onClick={() => pick(o)}
                    onMouseEnter={() => o.item && setSel(i)}
                    className={cn(
                      "flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-body",
                      i === cur && "bg-primary-soft text-primary",
                      !o.item && "cursor-default text-muted-foreground",
                    )}
                  >
                    <span className="min-w-0 truncate">{o.label}</span>
                    <span className="ml-auto shrink-0 truncate font-mono text-caption text-faint">{o.hint}</span>
                  </button>
                ),
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ItemList({
  title,
  items,
  catalog,
  conflictOf,
  errorOf,
  checks,
  stored,
  disabled,
  onChange,
  onCheck,
}: {
  title: string;
  items: RoutingItem[];
  catalog: Catalog | undefined;
  conflictOf: (it: RoutingItem) => string | undefined;
  errorOf: (index: number, it: RoutingItem) => string | undefined;
  checks: Record<string, CheckState | undefined>;
  stored: (url: string) => RuleSetStatus | undefined;
  disabled?: boolean;
  onChange: (items: RoutingItem[], added?: RoutingItem) => void;
  onCheck: (url: string) => void;
}) {
  const tr = useTr();
  return (
    <div className="grid gap-1.5 sm:pl-12">
      {items.length ? (
        <ul className="grid">
          {items.map((it, i) => (
            <ItemRow
              key={itemKey(it)}
              item={it}
              catalog={catalog}
              conflict={conflictOf(it)}
              error={errorOf(i, it)}
              check={it.type === "rule_set" ? checks[it.value] : undefined}
              stored={it.type === "rule_set" ? stored(it.value) : undefined}
              onCheck={onCheck}
              onKind={() =>
                onChange(items.map((x, j) => (j === i ? { ...x, type: DOMAIN_CYCLE[x.type] ?? x.type } : x)))
              }
              onRemove={() => onChange(items.filter((_, j) => j !== i))}
            />
          ))}
        </ul>
      ) : (
        <p className="px-2 text-footnote text-faint">{tr("还没有内容", "Nothing here yet")}</p>
      )}
      <Adder
        label={tr(`添加到「${title}」`, `Add to "${title}"`)}
        catalog={catalog}
        existing={items}
        disabled={disabled || items.length >= MAX_ITEMS}
        onAdd={(it) => onChange([...items, it], it)}
      />
      {items.length >= MAX_ITEMS && (
        <p className="text-footnote text-faint">
          {tr(`每个分区最多 ${MAX_ITEMS} 条`, `At most ${MAX_ITEMS} per section`)}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** A line select: entrances by node, region groups, tag groups (and "all" for the default proxy). */
export function RefSelect({
  label,
  value,
  catalog,
  entrancesOnly,
  withAll,
  placeholder,
  exclude = [],
  onChange,
  className,
}: {
  label: string;
  value: string;
  catalog: Catalog | undefined;
  entrancesOnly?: boolean;
  withAll?: boolean;
  placeholder?: string;
  exclude?: string[];
  onChange: (key: string) => void;
  className?: string;
}) {
  const tr = useTr();
  const nodes: string[] = [];
  for (const e of catalog?.entrances ?? []) if (!nodes.includes(e.node)) nodes.push(e.node);
  const known =
    value === "" ||
    value === "all" ||
    (catalog?.entrances ?? []).some((e) => `e:${e.id}` === value) ||
    (!entrancesOnly &&
      ((catalog?.regions ?? []).some((r) => `r:${r}` === value) ||
        (catalog?.tags ?? []).some((t) => `t:${t}` === value)));
  const missing = refName(refOf(value), catalog, tr).name;
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn("min-w-0", className)}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {!known && <option value={value}>{missing}</option>}
      {withAll && <option value="all">{tr("全部节点（自动选最快）", "All lines (fastest)")}</option>}
      {nodes.map((n) => (
        <optgroup key={n} label={tr(`${n} 的线路`, `Lines of ${n}`)}>
          {(catalog?.entrances ?? [])
            .filter((e) => e.node === n && !exclude.includes(`e:${e.id}`))
            .map((e) => (
              <option key={e.id} value={`e:${e.id}`}>
                {entranceName(e)}
                {e.tags.length ? ` · ${e.tags.join("/")}` : ""}
                {e.enabled ? "" : tr(" · 已停用", " · disabled")}
              </option>
            ))}
        </optgroup>
      ))}
      {!entrancesOnly && !!catalog?.regions.length && (
        <optgroup label={tr("地区组（自动选最快）", "Region groups (fastest)")}>
          {catalog.regions
            .filter((r) => !exclude.includes(`r:${r}`))
            .map((r) => (
              <option key={r} value={`r:${r}`}>
                {`🌐 ${r}`}
              </option>
            ))}
        </optgroup>
      )}
      {!entrancesOnly && !!catalog?.tags.length && (
        <optgroup label={tr("标签组（自动选最快）", "Tag groups (fastest)")}>
          {catalog.tags
            .filter((t) => !exclude.includes(`t:${t}`))
            .map((t) => (
              <option key={t} value={`t:${t}`}>
                {`🏷 ${t}`}
              </option>
            ))}
        </optgroup>
      )}
    </Select>
  );
}

/** primary → backup → backup as chips (the first one blue). */
export function RouteChips({ chain, catalog }: { chain: (LineRef | null)[]; catalog: Catalog | undefined }) {
  const tr = useTr();
  if (!chain.length) return <Badge tone="warning">{tr("未选线路 → 走默认代理", "No line → the default proxy")}</Badge>;
  return (
    <span className="contents">
      {chain.map((r, i) => {
        const n = refName(r, catalog, tr);
        return (
          <span key={`${refKey(r)}-${i}`} className="inline-flex items-center gap-1">
            {i > 0 && <ArrowRight className="size-3 text-faint" aria-hidden="true" />}
            <Badge tone={n.missing ? "danger" : i === 0 ? "primary" : "outline"}>{n.name}</Badge>
          </span>
        );
      })}
      {chain.length > 1 && (
        <span className="text-footnote text-muted-foreground">{tr("（挂了按顺序切换）", "(fails over in order)")}</span>
      )}
    </span>
  );
}

export function LinesEditor({
  service,
  catalog,
  onChange,
}: {
  service: Service;
  catalog: Catalog | undefined;
  onChange: (s: Service) => void;
}) {
  const tr = useTr();
  const name = service.name;
  const used = chainOf(service).map(refKey);
  const setBackups = (b: LineRef[]) => onChange({ ...service, backups: b });
  const swap = (i: number, j: number) => {
    const b = [...service.backups];
    [b[i], b[j]] = [b[j], b[i]];
    setBackups(b);
  };
  return (
    <div className="grid gap-3 rounded-xl bg-window p-3 ring-1 ring-border ring-inset sm:ml-12">
      <div className="grid gap-1.5 sm:grid-cols-[4rem_minmax(0,1fr)] sm:items-center">
        <span className="text-footnote font-medium text-muted-foreground">{tr("首选", "Primary")}</span>
        <RefSelect
          label={tr(`${name} 的首选线路`, `${name}: primary line`)}
          value={service.primary ? `e:${service.primary}` : ""}
          catalog={catalog}
          entrancesOnly
          placeholder={tr("（不指定，走备用或默认代理）", "(none: the backups or the default proxy)")}
          onChange={(k) => {
            const r = refOf(k);
            const primary = r && "entrance" in r ? r.entrance : null;
            onChange({ ...service, primary, backups: service.backups.filter((b) => refKey(b) !== k) });
          }}
        />
      </div>
      <div className="grid gap-1.5 sm:grid-cols-[4rem_minmax(0,1fr)] sm:items-start">
        <span className="text-footnote font-medium text-muted-foreground sm:pt-1.5">{tr("备用", "Backups")}</span>
        <div className="grid min-w-0 gap-1.5">
          {service.backups.length > 0 && (
            <ol className="grid gap-1" aria-label={tr(`${name} 的备用线路`, `${name}: backups`)}>
              {service.backups.map((b, j) => {
                const n = refName(b, catalog, tr);
                return (
                  <li
                    key={`${refKey(b)}-${j}`}
                    className="flex min-w-0 items-center gap-1.5 rounded-lg bg-card py-0.5 pr-1 pl-2.5 shadow-card"
                  >
                    <span className="w-4 text-caption text-faint tabular-nums">{j + 1}</span>
                    <span className={cn("min-w-0 flex-1 truncate text-body", n.missing && "text-destructive")}>
                      {n.name}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      icon={ArrowUp}
                      aria-label={tr(`上移备用 ${j + 1}`, `Move backup ${j + 1} up`)}
                      disabled={j === 0}
                      onClick={() => swap(j, j - 1)}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      icon={ArrowDown}
                      aria-label={tr(`下移备用 ${j + 1}`, `Move backup ${j + 1} down`)}
                      disabled={j === service.backups.length - 1}
                      onClick={() => swap(j, j + 1)}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      icon={X}
                      aria-label={tr(`移除备用 ${j + 1}`, `Remove backup ${j + 1}`)}
                      onClick={() => setBackups(service.backups.filter((_, k) => k !== j))}
                    />
                  </li>
                );
              })}
            </ol>
          )}
          {service.backups.length < MAX_BACKUPS ? (
            <RefSelect
              label={tr(`${name} 添加备用线路`, `${name}: add a backup`)}
              value=""
              catalog={catalog}
              exclude={used}
              placeholder={tr("+ 添加备用线路或地区组…", "+ Add a backup line or group…")}
              onChange={(k) => {
                const r = refOf(k);
                if (r) setBackups([...service.backups, r]);
              }}
            />
          ) : (
            <p className="text-footnote text-faint">
              {tr(`最多 ${MAX_BACKUPS} 个备用`, `At most ${MAX_BACKUPS} backups`)}
            </p>
          )}
        </div>
      </div>
      <p className="text-footnote text-muted-foreground">
        {tr(
          "客户端里默认用「推荐（自动容灾）」：首选正常就用首选，挂了按备用顺序切换，恢复后切回。建议最后放一个地区组兜底。用户套餐里没有的线路自动跳过。",
          "Clients default to the recommended failover group: the primary while it works, then the backups in order, back to the primary when it recovers. End with a region group as a safety net. Lines a user's plan lacks are skipped.",
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The side: test box, one sentence
// ---------------------------------------------------------------------------

const EXAMPLES = ["claude.ai", "www.netflix.com", "youtube.com", "www.baidu.com", "t.me", "192.168.1.1", "github.com"];

export function TestBox({
  routing,
  catalog,
  checks,
}: {
  routing: Routing;
  catalog: Catalog | undefined;
  checks: Record<string, CheckState | undefined>;
}) {
  const tr = useTr();
  const [q, setQ] = useState("www.netflix.com");
  const ok: Record<string, RuleSetCheck | undefined> = {};
  for (const [k, v] of Object.entries(checks)) if (v?.state === "ok") ok[k] = v.data;
  const r = resolve(q, routing, catalog, ok, tr);
  const input = useRef<HTMLInputElement>(null);
  let head: ReactNode = null;
  let chain: (LineRef | null)[] | null = null;
  let why = "";
  let tone = "text-primary";
  if (r) {
    if (r.to === "block") {
      head = tr("拦截", "Blocked");
      tone = "text-destructive";
      why = tr(`命中「${r.section}」里的 ${r.hit.why}`, `Matches ${r.hit.why} in "${r.section}"`);
    } else if (r.to === "direct") {
      head = tr("直连", "Direct");
      tone = "text-success";
      why = r.section
        ? tr(`命中「${r.section}」里的 ${r.hit?.why}`, `Matches ${r.hit?.why} in "${r.section}"`)
        : (r.hit?.why ?? "");
    } else if (r.to === "service") {
      head = r.service.emoji ? `${r.service.emoji} ${r.service.name}` : r.service.name;
      chain = r.fallback ? [routing.rest] : r.chain;
      why = tr(`命中「${r.service.name}」里的 ${r.hit.why}`, `Matches ${r.hit.why} in "${r.service.name}"`);
    } else {
      head = tr("默认代理", "Default proxy");
      chain = r.chain;
      why = r.global
        ? tr("全局代理模式：其余全部走默认代理", "Global proxy: everything else via the default proxy")
        : tr("上面都没命中 → 其余全部", "Nothing above matched → the rest");
    }
  }
  const hit = r && "hit" in r ? r.hit : null;
  return (
    <Card className="grid gap-2.5 p-4" role="search" aria-label={tr("测试分流", "Test the routing")}>
      <h3 className="text-body font-semibold">{tr("测试：这个网站会走哪？", "Test: where does this site go?")}</h3>
      <Input
        ref={input}
        aria-label={tr("测试网址", "Address to test")}
        value={q}
        autoComplete="off"
        spellCheck={false}
        placeholder={tr("输入网址或 IP，例如 www.netflix.com", "A site or IP, e.g. www.netflix.com")}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => setQ(e)}
            className="hit-44 rounded-full px-2 text-caption text-muted-foreground ring-1 ring-border ring-inset hover:text-primary hover:ring-primary"
          >
            {e}
          </button>
        ))}
      </div>
      <div aria-live="polite" data-testid="routing-test-result">
        {!r ? (
          <p className="text-footnote text-faint">{tr("输入后立即显示结果", "The result shows as you type")}</p>
        ) : (
          <div className="grid gap-1.5">
            <div className={cn("text-headline font-semibold", tone)} data-verdict={r.to}>
              {head}
            </div>
            {chain && (
              <div className="flex flex-wrap items-center gap-1.5 text-footnote text-muted-foreground">
                {tr("实际线路：", "Lines: ")}
                <RouteChips chain={chain} catalog={catalog} />
              </div>
            )}
            {r.to === "service" && r.fallback && (
              <p className="text-footnote text-muted-foreground">
                {tr("这个服务没选线路，走默认代理", "This service has no line: the default proxy")}
              </p>
            )}
            <p className="text-footnote text-muted-foreground">{why}</p>
            {hit?.guess && (
              <p className="text-footnote text-warning">
                {tr(
                  "按分类名匹配，以客户端下载的完整列表为准；不在列表里时会继续往下匹配。",
                  "Matched by the category's name; the full list the client downloads decides, and a miss falls through to the next rule.",
                )}
              </p>
            )}
            {hit?.sample && (
              <p className="text-footnote text-faint">
                {tr("按规则集的前 20 条样例匹配。", "Matched against the rule-set's first 20 rules.")}
              </p>
            )}
          </div>
        )}
      </div>
      <p className="text-footnote text-faint">
        {tr(
          "内置分类的完整列表由客户端下载，这里只认得局域网地址与名字明显的网站；域名、IP 段、关键词与已检查的规则集按实际内容匹配。",
          "Clients download the built-in categories' full lists: here only LAN addresses and obviously named sites are recognised; domains, IP ranges, keywords and checked rule-sets match by their content.",
        )}
      </p>
    </Card>
  );
}

export function Summary({ routing, catalog }: { routing: Routing; catalog: Catalog | undefined }) {
  const tr = useTr();
  const lang = useLang();
  const parts = summary(routing, catalog, tr, lang);
  return (
    <Card className="grid gap-2 p-4">
      <h3 className="text-body font-semibold">{tr("效果一句话", "In one sentence")}</h3>
      <p className="text-body leading-relaxed" data-testid="routing-summary">
        {parts.join(lang === "en" ? "; " : "；")}
        {lang === "en" ? "." : "。"}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// What users see in Clash
// ---------------------------------------------------------------------------

export function ClientPreview({ routing, catalog }: { routing: Routing; catalog: Catalog | undefined }) {
  const tr = useTr();
  const groups = clientGroups(routing, catalog, tr);
  return (
    <ul className="grid grid-cols-1 gap-2.5 md:grid-cols-2" aria-label={tr("客户端分组", "Client groups")}>
      {groups.map((g) => (
        <li key={g.name} className="grid content-start gap-1.5 rounded-xl bg-card p-3 shadow-card">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-body font-semibold">{g.name}</span>
            <Badge tone="outline">{g.kind === "select" ? tr("手动选择", "Select") : tr("自动选最快", "Fastest")}</Badge>
          </div>
          {g.current && (
            <div className="text-footnote text-primary">
              {tr("当前：", "Now: ")}
              {g.current}
            </div>
          )}
          {g.failover && (
            <div className="text-footnote text-muted-foreground">
              {tr(
                `推荐 = ${g.failover.join(" → ")}（按顺序容灾）`,
                `Recommended = ${g.failover.join(" → ")} (in order)`,
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {g.members.map((m) => (
              <span
                key={m}
                className={cn(
                  "rounded-md px-1.5 py-px text-caption ring-1 ring-inset",
                  m === g.current ? "bg-primary-soft text-primary ring-transparent" : "bg-window ring-border",
                )}
              >
                {m}
              </span>
            ))}
            {!!g.lines && (
              <span className="rounded-md px-1.5 py-px text-caption text-muted-foreground ring-1 ring-border ring-inset">
                {g.members.length
                  ? tr(`+ ${g.lines} 条线路`, `+ ${g.lines} lines`)
                  : tr(`${g.lines} 条线路`, `${g.lines} lines`)}
              </span>
            )}
            {g.kind === "url-test" && !g.members.length && !g.lines && (
              <span className="text-caption text-faint">{tr("（没有线路）", "(no lines)")}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The section header's tile: an icon or an emoji. */
export function SectionTile({
  tone,
  children,
}: {
  tone: "danger" | "success" | "primary" | "neutral";
  children: ReactNode;
}) {
  const soft = {
    danger: "bg-destructive-soft text-destructive",
    success: "bg-success-soft text-success",
    primary: "bg-primary-soft text-primary",
    neutral: "bg-secondary text-muted-foreground",
  }[tone];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] text-callout [&_svg]:size-[18px]",
        soft,
      )}
    >
      {children}
    </span>
  );
}
