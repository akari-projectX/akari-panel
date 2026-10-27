// Helpers the nodes and plans pages share (no page imports another page's
// module for these): entrance state words, the backend's Chinese machine
// warnings mapped to short bilingual titles (raw text in a disclosure),
// number fields that keep the typed string and validate it (never NaN, never
// "empty = 0"), tags and the node-group picker.
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Field } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { CircleAlert, X } from "lucide-react";
import { cn } from "../../shared/cn";

// --- Summary tiles (nodes and plans pages) -----------------------------------

// --- Backend warnings -------------------------------------------------------

/** The server / install warnings are Chinese sentences (servers.rs, nodeinstall.rs): a bilingual title for each. */
const WARNINGS: [RegExp, [string, string]][] = [
  [
    /不支持来源 IP 过滤|来源 IP 过滤未生效/,
    ["中转入口的来源 IP 过滤未生效", "Relay source-IP filtering is not active"],
  ],
  [/多个入口上的限速/, ["agent 过旧：多入口的限速分别计算", "Old agent: limits are counted per entrance"]],
  [/不支持限速/, ["agent 过旧：套餐限速不生效", "Old agent: plan speed limits are not enforced"]],
  [
    /允许用户访问本机内网/,
    ["agent 过旧：“访问本机内网/回环地址”设置不生效", "Old agent: the private-destinations setting is not applied"],
  ],
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

// --- Chips (tags, egress addresses) ------------------------------------------

/** A chip list while editing: the committed chips and what is still typed in the box. */
export type Chips = { items: string[]; draft: string };

export const chips = (items: string[]): Chips => ({ items, draft: "" });

/** Tags are split at commas only (a tag may contain spaces: "IPLC 专线"). */
const TAG_SPLIT = /[,，\n]+/;
/** Addresses are split at commas and white space. */
const ADDR_SPLIT = /[\s,，]+/;

function parts(text: string, split: RegExp): string[] {
  return text
    .split(split)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Every value, committed or still typed, without duplicates (what is sent). */
function chipValues(c: Chips, split: RegExp = TAG_SPLIT): string[] {
  return [...new Set([...c.items, ...parts(c.draft, split)])];
}
export const tagValues = (c: Chips) => chipValues(c, TAG_SPLIT);
export const addrValues = (c: Chips) => chipValues(c, ADDR_SPLIT);

/** An IPv4 / IPv6 address or network the panel accepts (entrances.rs `clean_cidrs`). */
export function isIpOrCidr(v: string): boolean {
  const [addr, len, extra] = v.split("/");
  if (extra !== undefined || !addr) return false;
  let max: number;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    if (addr.split(".").some((p) => Number(p) > 255 || (p.length > 1 && p.startsWith("0")))) return false;
    max = 32;
  } else if (addr.includes(":") && /^[0-9a-fA-F:.]+$/.test(addr)) {
    try {
      new URL(`http://[${addr}]/`);
    } catch {
      return false;
    }
    max = 128;
  } else return false;
  return len === undefined || (/^\d{1,3}$/.test(len) && Number(len) <= max);
}

/**
 * Chips with a box to type the next one: Enter, a separator or leaving the
 * box adds it; Backspace in an empty box removes the last one. Chips that
 * `invalid` rejects are shown red. Enter never submits the dialog here.
 */
export function ChipInput({
  value,
  onChange,
  label,
  placeholder,
  split = TAG_SPLIT,
  invalid,
  mono,
  error,
  chipTone = "primary",
}: {
  value: Chips;
  onChange: (c: Chips) => void;
  /** The box's accessible name ("添加标签"). */
  label: string;
  placeholder?: string;
  split?: RegExp;
  invalid?: (v: string) => boolean;
  mono?: boolean;
  error?: boolean;
  chipTone?: "primary" | "neutral";
}) {
  const tr = useTr();
  const commit = (draft: string, keepLast: boolean) => {
    const all = draft.split(split);
    const rest = keepLast ? (all.pop() ?? "") : "";
    const add = all.map((t) => t.trim()).filter(Boolean);
    const items = [...value.items];
    for (const t of add) if (!items.includes(t)) items.push(t);
    onChange({ items, draft: rest });
  };
  return (
    <div
      className={cn(
        "flex min-h-8 flex-wrap items-center gap-1.5 rounded-md bg-card px-1.5 py-1 shadow-[0_0_0_0.5px_var(--input)] transition-shadow focus-within:shadow-[0_0_0_1px_var(--primary),0_0_0_4px_var(--ring)] pointer-coarse:min-h-10",
        error && "shadow-[0_0_0_1px_var(--destructive),0_0_0_4px_var(--destructive-soft)]",
      )}
    >
      {value.items.map((x) => {
        const bad = invalid?.(x) ?? false;
        return (
          <span
            key={x}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-[6px] py-0.5 pr-1 pl-1.5 text-footnote",
              mono && "font-mono",
              bad
                ? "bg-destructive-soft text-destructive"
                : chipTone === "primary"
                  ? "bg-primary-soft text-primary"
                  : "bg-secondary text-foreground",
            )}
          >
            <span className="truncate">{x}</span>
            <button
              type="button"
              className="hit-44 inline-flex size-4 items-center justify-center rounded-full opacity-70 hover:opacity-100"
              aria-label={tr(`移除 ${x}`, `Remove ${x}`)}
              onClick={() => onChange({ ...value, items: value.items.filter((y) => y !== x) })}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        );
      })}
      <input
        aria-label={label}
        aria-invalid={error || undefined}
        value={value.draft}
        placeholder={placeholder}
        className={cn(
          "h-6 min-w-24 flex-1 bg-transparent px-1 text-body outline-none placeholder:text-faint",
          mono && "font-mono",
        )}
        onChange={(e) => {
          const t = e.target.value;
          if (split.test(t)) commit(t, true);
          else onChange({ ...value, draft: t });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (value.draft.trim()) commit(value.draft, false);
          } else if (e.key === "Backspace" && value.draft === "" && value.items.length > 0) {
            onChange({ ...value, items: value.items.slice(0, -1) });
          }
        }}
        onBlur={() => value.draft.trim() && commit(value.draft, false)}
      />
    </div>
  );
}

export function TagsField({
  value,
  onChange,
  className,
}: {
  value: Chips;
  onChange: (v: Chips) => void;
  className?: string;
}) {
  const tr = useTr();
  const n = tagValues(value).length;
  return (
    <Field
      group
      className={className}
      label={tr("标签", "Tags")}
      error={n > 8 ? tr(`最多 8 个标签（现在 ${n} 个）`, `At most 8 tags (${n} now)`) : undefined}
      hint={tr(
        "最多 8 个，显示在订阅线路名与门户线路列表里，只属于这个入口",
        "At most 8; shown in subscription line names and the portal's line list, this entrance only",
      )}
    >
      <ChipInput
        value={value}
        onChange={onChange}
        label={tr("添加标签", "Add a tag")}
        placeholder={tr("添加…", "Add…")}
        error={n > 8}
      />
    </Field>
  );
}

export const ALERT_KINDS = [
  "offline",
  "cpu",
  "memory",
  "disk",
  "latency",
  "cert",
  "agent_cert",
  "last_error",
  "entrance_down",
  "traffic_quota",
] as const;

export function alertKindName(k: string, tr: Tr): string {
  return (
    (
      {
        offline: tr("服务器离线", "Server offline"),
        cpu: tr("CPU 过高", "High CPU"),
        memory: tr("内存过高", "High memory"),
        disk: tr("磁盘将满", "Disk filling up"),
        latency: tr("测速全部失败", "Every probe fails"),
        cert: tr("服务器证书即将到期", "Server certificate expiring"),
        agent_cert: tr("Agent 证书即将到期", "Agent certificate expiring"),
        last_error: tr("配置应用失败", "Apply failed"),
        entrance_down: tr("中转入口不可用", "Relay entrance down"),
        traffic_quota: tr("流量额度已用完", "Traffic quota used up"),
      } as Record<string, string>
    )[k] ?? k
  );
}
