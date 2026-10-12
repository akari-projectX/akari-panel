// Helpers the nodes and plans pages share (no page imports another page's
// module for these): entrance state words, the backend's Chinese machine
// warnings mapped to short bilingual titles (raw text in a disclosure),
// number fields that keep the typed string and validate it (never NaN, never
// "empty = 0"), tags and the node-group picker.
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { ago } from "../../shared/format";
import type { EntranceView, NodeGroup } from "../types";
import type { Tone } from "../../shared/ui/badge";
import { Checkbox, Field, Input } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

export function entranceState(e: EntranceView, tr: Tr): [string, Tone] {
  if (!e.enabled) return [tr("已停用", "Disabled"), "neutral"];
  if (e.hidden_since) return [tr("已隐藏", "Hidden"), "danger"];
  return [tr("订阅中", "In subscriptions"), "success"];
}

export function healthText(e: EntranceView, tr: Tr, lang: "zh" | "en"): [string, Tone] {
  if (e.kind === "direct") return [tr("直连", "direct"), "neutral"];
  if (e.health_ok === null) return [tr("未探测", "not tested"), "neutral"];
  if (e.health_ok) return [tr(`正常 · ${ago(e.health_at, lang)}`, `ok · ${ago(e.health_at, lang)}`), "success"];
  return [
    tr(
      `失败 ${e.health_failures} 次 · ${ago(e.health_at, lang)}`,
      `failed ×${e.health_failures} · ${ago(e.health_at, lang)}`,
    ),
    "danger",
  ];
}

// --- Backend warnings -------------------------------------------------------

/** The server / install warnings are Chinese sentences (servers.rs, nodeinstall.rs): a bilingual title for each. */
const WARNINGS: [RegExp, [string, string]][] = [
  [
    /不支持来源 IP 过滤|来源 IP 过滤未生效/,
    ["中转入口的来源 IP 过滤未生效", "Relay source-IP filtering is not active"],
  ],
  [/多个入口上的限速/, ["agent 过旧：多入口的限速分别计算", "Old agent: limits are counted per entrance"]],
  [/不支持限速/, ["agent 过旧：套餐限速不生效", "Old agent: plan speed limits are not enforced"]],
  [/流量额度已用完/, ["流量额度已用完", "Traffic quota used up"]],
  [/不会自动申请/, ["agent 过旧：不会自动申请证书", "Old agent: no automatic certificate"]],
  [/serverName/, ["入站的 SNI 与服务器域名不一致", "The inbound's SNI differs from the server domain"]],
  [/agent 证书/, ["agent 证书即将过期或已过期", "The agent certificate expires soon or has expired"]],
  [/重装命令|更新服务|单元/, ["需要重新运行一次安装命令", "Run the install command once more"]],
  [/无法检查 .* 的 TLS 证书/, ["无法检查面板的 TLS 证书", "Could not check the panel's TLS certificate"]],
  [/灰度更新中失败/, ["该版本在灰度中失败，改用此前版本", "That release failed in a rollout; an earlier one is used"]],
  [/没有 linux\//, ["缺少某个平台的 agent 程序", "No agent binary for a platform"]],
];

export function warningTitle(w: string, tr: Tr): string {
  for (const [re, [zh, en]] of WARNINGS) if (re.test(w)) return tr(zh, en);
  return tr("需要注意", "Needs attention");
}

/** Warnings as titled items; the backend's text in a disclosure (it is Chinese only). */
export function WarningList({ warnings, tone = "warning" }: { warnings: string[]; tone?: "warning" | "danger" }) {
  const tr = useTr();
  const lang = useLang();
  if (warnings.length === 0) return null;
  return (
    <Callout tone={tone}>
      <ul className="grid gap-1">
        {warnings.map((w) => (
          <li key={w}>
            {lang === "zh" ? (
              w
            ) : (
              <details>
                <summary className="cursor-pointer">{warningTitle(w, tr)}</summary>
                <p className="mt-1 text-footnote text-muted-foreground">{w}</p>
              </details>
            )}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/** `last_error` is the agent's own text (English, technical): a plain title, the raw text on demand. */
export function ApplyError({ error, at }: { error: string; at?: string | null }) {
  const tr = useTr();
  const lang = useLang();
  return (
    <Callout tone="danger" title={tr("配置应用失败", "Apply failed")}>
      <p>
        {tr(
          "agent 没能应用最新配置，仍在运行上一份配置。常见原因：端口被占用、证书文件缺失、入站参数不被这个版本支持。",
          "The agent could not apply the latest configuration and keeps running the previous one. Usual causes: a port in use, a missing certificate file, an inbound setting this version does not support.",
        )}
        {at ? ` (${ago(at, lang)})` : ""}
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer text-footnote text-muted-foreground">
          {tr("agent 的原始错误", "The agent's error text")}
        </summary>
        <pre className="mt-1 font-mono text-caption break-all whitespace-pre-wrap">{error}</pre>
      </details>
    </Callout>
  );
}

// --- Numbers ----------------------------------------------------------------

export type NumRule = {
  min: number;
  max: number;
  /** Whole numbers only (else decimals). */
  int?: boolean;
  /** Empty is allowed (means "none" / "default" — the label says which). */
  optional?: boolean;
  /** The lower bound is exclusive (decimals: "more than 0"). */
  above?: boolean;
};

/**
 * A typed number: [value, error]. Empty → [null] when optional (else an
 * error); anything that is not a plain number in range is an error — the
 * caller never sends NaN or turns a typo into "unlimited".
 */
export function num(text: string, r: NumRule, tr: Tr): [number | null, string | undefined] {
  const t = text.trim();
  if (t === "") return r.optional ? [null, undefined] : [null, tr("必填", "Required")];
  const ok = r.int ? /^-?\d+$/.test(t) : /^-?\d+(\.\d+)?$/.test(t);
  const v = ok ? Number(t) : NaN;
  const low = r.above ? v > r.min : v >= r.min;
  if (!Number.isFinite(v) || !low || v > r.max)
    return [
      null,
      r.int
        ? tr(`请输入 ${r.min}–${r.max} 的整数`, `Enter a whole number from ${r.min} to ${r.max}`)
        : r.above
          ? tr(`请输入大于 ${r.min}、不超过 ${r.max} 的数字`, `Enter a number above ${r.min}, at most ${r.max}`)
          : tr(`请输入 ${r.min}–${r.max} 的数字`, `Enter a number from ${r.min} to ${r.max}`),
    ];
  return [v, undefined];
}

export const PORT: NumRule = { min: 1, max: 65535, int: true };

/** "N 处需要修正" next to a dialog's save button. */
export function FixCount({ n }: { n: number }) {
  const tr = useTr();
  if (n === 0) return null;
  return (
    <span role="status" className="mr-auto inline-flex items-center gap-1 text-footnote text-destructive sm:mr-1">
      <CircleAlert className="size-3.5" aria-hidden="true" />
      {tr(`${n} 处需要修正`, `${n} to fix`)}
    </span>
  );
}

/** Errors to show: a field's error once it has text or a save was tried. */
export function shown(text: string, error: string | undefined, tried: boolean): string | undefined {
  return tried || text.trim() !== "" ? error : undefined;
}

// --- Tags and groups ----------------------------------------------------------

/** "IPLC, 原生" → ["IPLC", "原生"] (the panel trims and deduplicates). */
export function splitTags(v: string): string[] {
  return v
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function TagsField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const tr = useTr();
  const n = splitTags(value).length;
  return (
    <Field
      className={className}
      label={tr("标签（逗号分隔，用户可见）", "Tags (comma separated, shown to users)")}
      error={n > 8 ? tr(`最多 8 个标签（现在 ${n} 个）`, `At most 8 tags (${n} now)`) : undefined}
      hint={tr(
        "显示在订阅线路名里入口名称之后，也显示在门户线路列表里，只属于这个入口（最多 8 个）。",
        "Shown after the entrance's name in subscription line names and in the portal's line list; this entrance only (at most 8).",
      )}
    >
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="IPLC" />
    </Field>
  );
}

export function GroupPicker({
  groups,
  value,
  onChange,
  empty,
}: {
  groups: NodeGroup[];
  value: string[];
  onChange: (v: string[]) => void;
  /** Shown when there are no groups (e.g. a "create one" button). */
  empty?: ReactNode;
}) {
  const tr = useTr();
  return (
    <fieldset>
      <legend className="mb-1.5 text-footnote font-medium text-muted-foreground">{tr("节点组", "Node groups")}</legend>
      {groups.length === 0 ? (
        (empty ?? (
          <p className="text-footnote text-muted-foreground">
            {tr("还没有节点组（在「套餐 → 节点组」创建）。", "No node groups yet (Plans → Node groups).")}
          </p>
        ))
      ) : (
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <label
              key={g.id}
              className="flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-body ring-1 ring-border ring-inset"
            >
              <Checkbox
                checked={value.includes(g.id)}
                label={g.name}
                onChange={(on) => onChange(on ? [...value, g.id] : value.filter((x) => x !== g.id))}
              />
              {g.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** Same arrays regardless of order. */
export function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}
