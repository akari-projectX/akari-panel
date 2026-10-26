// 系统设置 → 管理与安全 (v2): 后台入口 (SET-06: the address card — masked,
// 显示 / copy, what the prefix does and when it was last rotated (audit);
// SET-07: the IP allowlist as a list — "包含你的地址" badge, add a row, a
// list without your address is an error with "添加我的地址", confirmed on
// save with the recovery command; owner only, R47 — other admins see it
// read-only), the prefix rotation dialog (random or custom, the new address
// previewed, typed "轮换", then the done state with the new address and the
// command that shows it), 数据保留 (the retention days of SET-09: a shorter
// period says so in the row and is confirmed on save with a typed "删除旧数据";
// what these settings never delete is listed) and 我的账户与通行密钥 (an entry
// card to /account).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CircleCheck,
  Code2,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  Plus,
  RotateCw,
  Shuffle,
  TriangleAlert,
  X,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { get, post, put } from "../../shared/api";
import { loadPage } from "../../shared/base";
import { cn } from "../../shared/cn";
import { ago, dateTime } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input } from "../../shared/ui/form";
import { useAction } from "../data";
import { Avatar, CopyText } from "../components/kit";
import { RadioCards, UnitInput } from "../components/inputs";
import { useMe } from "../session";
import { fresh, useAccess, useSettings, type Access, type SettingsView } from "./settings-data";
import { useLastEdit } from "./settings-overview";
import {
  DangerRow,
  DangerZone,
  FieldRow,
  Loaded,
  OwnerOnly,
  OwnerNotice,
  Panel,
  SRow,
  intError,
  intOf,
  numText,
  useDraft,
  useOwner,
  useSavePart,
} from "../components/settings-kit";

// ---------------------------------------------------------------------------
// 后台入口
// ---------------------------------------------------------------------------

export function AccessSection() {
  const q = useAccess();
  return <Loaded q={q}>{(a) => <AccessForm a={a} />}</Loaded>;
}

/** Whether `ip` is `entry` or inside the IPv4 network `entry` (IPv6: exact match only). */
function covers(entry: string, ip: string): boolean {
  if (entry === ip) return true;
  const [net, bits] = entry.split("/");
  const v4 = (s: string) => {
    const p = s.split(".").map(Number);
    return p.length === 4 && p.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)
      ? p.reduce((n, x) => n * 256 + x, 0)
      : null;
  };
  const a = v4(net);
  const b = v4(ip);
  const n = Number(bits ?? 32);
  if (a === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) return false;
  const size = 2 ** (32 - n);
  return Math.floor(a / size) === Math.floor(b / size);
}

const V4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([0-9]|[12]\d|3[0-2]))?$/;
const V6 = /^[0-9a-f:]*:[0-9a-f:.]*(\/([0-9]|[1-9]\d|1[01]\d|12[0-8]))?$/i;
/** A loose IP / CIDR check (the server has the last word). */
const cidrOk = (s: string) => V4.test(s) || V6.test(s);

function AccessForm({ a }: { a: Access }) {
  const tr = useTr();
  const lang = useLang();
  const owner = useOwner();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const [shown, setShown] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [adding, setAdding] = useState("");
  const rotated = useLastEdit("settings.admin_prefix.rotate");
  const url = a.admin_url ?? `${location.origin}/${a.admin_prefix}/admin`;
  const masked = url.replace(
    a.admin_prefix,
    `${a.admin_prefix.slice(0, 3)}${"•".repeat(Math.max(4, a.admin_prefix.length - 5))}${a.admin_prefix.slice(-2)}`,
  );
  const f = useDraft({ allow: a.admin_allow_cidrs });
  const list = f.value!.allow;
  const me = a.your_ip;
  const covered = list.length === 0 || !me || list.some((x) => covers(x, me));
  const bad = list.filter((x) => !cidrOk(x));
  const selfError = !covered
    ? tr(
        `你的地址 ${me} 不在白名单里：保存后你会被挡在门外，服务器会拒绝这次保存`,
        `Your address ${me} is not in the list: you would lock yourself out, and the server refuses the save`,
      )
    : undefined;
  const badError = bad.length
    ? tr(
        `${bad.join(tr("、", ", "))} 不是有效的 IP 地址或 CIDR 网段`,
        `${bad.join(", ")}: not a valid IP address or CIDR`,
      )
    : undefined;
  const add = adding.trim();
  const addError =
    add && !cidrOk(add)
      ? tr("不是有效的 IP 地址或 CIDR 网段", "Not a valid IP address or CIDR")
      : add && list.includes(add)
        ? tr("已经在名单里", "Already listed")
        : undefined;
  useSavePart({
    count: owner ? f.edited.length : 0,
    errors: (selfError ? 1 : 0) + (badError ? 1 : 0),
    discard: () => {
      f.reset();
      setAdding("");
    },
    save: async () => {
      const ok = await confirm({
        title: list.length
          ? tr("更新后台 IP 白名单？", "Update the console allowlist?")
          : tr("取消 IP 白名单？", "Remove the allowlist?"),
        description: list.length
          ? tr(
              "保存后立即生效：不在名单里的地址访问后台前缀一律得到 404。",
              "Applies at once: addresses outside the list get the 404 on the console prefix.",
            )
          : tr("保存后任意地址都能访问后台前缀。", "Any address can then reach the console prefix."),
        impacts: [
          { label: tr("名单", "List"), value: tr(`${list.length} 条`, `${list.length} entries`) },
          {
            label: tr("你的地址", "Your address"),
            value: me ? (list.length ? tr(`${me} · 在名单内`, `${me} · listed`) : me) : tr("未知", "unknown"),
          },
          {
            label: tr("被锁在外面时", "If locked out"),
            value: <code className="font-mono text-footnote">akari settings unset admin-allow</code>,
          },
        ],
        tone: "warning",
        confirmLabel: tr("保存白名单", "Save the allowlist"),
      });
      if (!ok) return false;
      const cur = fresh(qc, ["settings", "access"], a);
      const r = await run(
        () => put("/settings/access/admin-allow", { version: cur.version, admin_allow_cidrs: list }),
        {
          ok: tr("白名单已保存", "Allowlist saved"),
        },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  const addEntry = (x: string) => {
    f.set("allow", [...list, x]);
    setAdding("");
  };
  return (
    <>
      {!owner && <OwnerNotice />}
      {/* grid-cols-1 (minmax(0, 1fr)): the shown address truncates instead of
          widening the card (an implicit grid column grows to the address's
          min-content width, and a phone then zooms the whole page out). */}
      <Card className="grid grid-cols-1 gap-3 p-4">
        <div className="text-footnote font-medium text-muted-foreground">{tr("后台地址", "Console address")}</div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 basis-60 truncate rounded-md bg-window px-3 py-2 font-mono text-callout ring-1 ring-border ring-inset">
            {shown ? url : masked}
          </code>
          <Button variant="outline" icon={shown ? EyeOff : Eye} onClick={() => setShown((x) => !x)}>
            {shown ? tr("隐藏", "Hide") : tr("显示", "Show")}
          </Button>
          <CopyText value={url} display="" label={tr("后台地址", "the console address")} />
        </div>
        <p className="text-footnote text-muted-foreground">
          {tr(
            "前缀是后台的第二道门：不知道它的人访问后台只会看到 404；门户不会链接到这里，不要把它写进公开的地方。",
            "The prefix is the console's second door: without it the console answers 404; the portal never links here, so keep it out of public places.",
          )}
          {rotated &&
            tr(
              ` 上次轮换 ${dateTime(rotated.at)}（${ago(rotated.at, lang)}）。`,
              ` Last rotated ${dateTime(rotated.at)} (${ago(rotated.at, lang)}).`,
            )}
        </p>
      </Card>
      <Panel
        title={tr("IP 白名单", "IP allowlist")}
        footer={tr(
          "留空 = 不限制来源。支持单个 IPv4 / IPv6 地址或 CIDR 网段；白名单外的地址访问后台前缀得到统一的 404。",
          "Empty = any source. Single IPv4 / IPv6 addresses or CIDR networks; addresses outside get the uniform 404 on the console prefix.",
        )}
      >
        <Card className="divide-y divide-separator overflow-hidden">
          {list.length === 0 && (
            <p className="px-4 py-3 text-body text-muted-foreground">
              {tr("没有白名单：任意地址都能访问后台前缀。", "No allowlist: any address can reach the console prefix.")}
            </p>
          )}
          {list.map((x, i) => {
            const ok = cidrOk(x);
            const mine = ok && !!me && covers(x, me);
            const isNew = !a.admin_allow_cidrs.includes(x);
            return (
              <div
                key={`${x}:${i}`}
                className={cn("relative flex min-h-11 items-center gap-3 px-4 py-2", !ok && "bg-destructive-soft/40")}
                data-allow={x}
              >
                {isNew && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" data-changed />}
                <code className={cn("min-w-0 flex-1 font-mono text-body break-all", !ok && "text-destructive")}>
                  {x}
                </code>
                {mine && (
                  <Badge tone="success">
                    <CircleCheck aria-hidden="true" />
                    {tr("包含你的地址", "Includes you")}
                  </Badge>
                )}
                {!ok && <Badge tone="danger">{tr("格式不对", "Invalid")}</Badge>}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon={X}
                  className="hit-44"
                  aria-label={tr(`移除 ${x}`, `Remove ${x}`)}
                  disabled={!owner}
                  onClick={() =>
                    f.set(
                      "allow",
                      list.filter((_, j) => j !== i),
                    )
                  }
                />
              </div>
            );
          })}
          <div className="grid gap-1.5 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={tr("添加地址或网段", "Add an address or network")}
                aria-invalid={addError ? true : undefined}
                value={adding}
                disabled={!owner}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (add && !addError) addEntry(add);
                  }
                }}
                placeholder={tr("IP 或 CIDR，如 198.51.100.0/24", "IP or CIDR, e.g. 198.51.100.0/24")}
                autoCapitalize="off"
                spellCheck={false}
                className="w-64 font-mono text-footnote max-sm:w-auto max-sm:flex-1"
              />
              <Button
                size="sm"
                variant="soft"
                icon={Plus}
                disabled={!owner || !add || !!addError}
                onClick={() => addEntry(add)}
              >
                {tr("添加", "Add")}
              </Button>
              <span className="flex-1 max-sm:hidden" />
              {me && (
                <span className="text-footnote text-muted-foreground max-sm:basis-full" data-your-ip={me}>
                  {tr("你的地址 ", "Your address ")}
                  <code className="font-mono text-foreground">{me}</code>
                </span>
              )}
              {!covered && me && (
                <Button size="sm" variant="outline" disabled={!owner} onClick={() => addEntry(me)}>
                  {tr("添加我的地址", "Add my address")}
                </Button>
              )}
            </div>
            {addError && <p className="text-footnote text-destructive">{addError}</p>}
          </div>
        </Card>
        {owner && selfError && (
          <p className="flex items-start gap-1.5 px-1 text-footnote text-destructive" role="alert">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {selfError}
          </p>
        )}
        {owner && badError && (
          <p className="px-1 text-footnote text-destructive" role="alert">
            {badError}
          </p>
        )}
      </Panel>
      <DangerZone>
        <DangerRow
          label={tr("轮换后台前缀", "Rotate the console prefix")}
          locked={!owner}
          description={tr(
            "旧地址在所有实例上立即失效，所有管理员都要改用新地址。只在地址泄露时使用。",
            "The old address dies at once on every instance and every admin moves to the new one. Use it when the address leaked.",
          )}
          action={
            <Button
              size="sm"
              variant="destructive-soft"
              icon={RotateCw}
              disabled={!owner}
              onClick={() => setRotating(true)}
            >
              {tr("轮换前缀…", "Rotate…")}
            </Button>
          }
        />
      </DangerZone>
      {rotating && <RotateDialog a={a} onClose={() => setRotating(false)} />}
    </>
  );
}

function RotateDialog({ a, onClose }: { a: Access; onClose: () => void }) {
  const tr = useTr();
  const [run, busy] = useAction();
  const [mode, setMode] = useState<"random" | "custom">("random");
  const [custom, setCustom] = useState("");
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState<Access | null>(null);
  const c = custom.trim();
  const word = tr("轮换", "rotate");
  const error =
    mode === "custom" && c && !/^[A-Za-z0-9_-]{8,64}$/.test(c)
      ? tr("8–64 位字母、数字、- 或 _", "8–64 of A–Z a–z 0–9 - _")
      : undefined;
  const ready = !error && (mode === "random" || !!c) && typed.trim() === word;
  const origin = (a.admin_url ?? `${location.origin}/${a.admin_prefix}/admin`).split(`/${a.admin_prefix}/`)[0];
  const next = done ? (done.admin_url ?? `${location.origin}/${done.admin_prefix}/admin`) : null;
  const rotate = async () => {
    if (!ready) return;
    const r = await run(() =>
      post<Access>("/settings/access/admin-prefix", {
        version: a.version,
        confirm: true,
        admin_prefix: mode === "custom" ? c : undefined,
      }),
    );
    if (r) setDone(r);
  };
  if (done && next)
    return (
      <Dialog
        open
        size="md"
        icon={CircleCheck}
        dirty={false}
        onClose={() => loadPage(`/${done.admin_prefix}/admin/settings/access`)}
        title={tr("新的后台地址", "The new console address")}
        description={tr(
          "旧地址已返回 404。把新地址存进密码管理器；当前页面会跳到新地址。",
          "The old address now answers 404. Keep the new one in your password manager; this page moves there.",
        )}
        footer={
          <>
            <div className="flex-1" />
            <Button variant="primary" onClick={() => loadPage(`/${done.admin_prefix}/admin/settings/access`)}>
              {tr("前往新地址", "Go to it")}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <CopyText block value={next} label={tr("新的后台地址", "the new console address")} />
          <ul className="grid gap-1 text-footnote text-muted-foreground">
            <li>
              {tr(
                "· 其他管理员需要改用新地址登录（不会自动通知他们）。",
                "· Other admins must use the new address (they are not told automatically).",
              )}
            </li>
            <li>
              {tr("· 忘记地址时在服务器上执行 ", "· Forgot it? On the server run ")}
              <code className="font-mono text-foreground">akari info</code>
            </li>
          </ul>
        </div>
      </Dialog>
    );
  return (
    <Dialog
      open
      size="md"
      tone="danger"
      icon={RotateCw}
      onClose={onClose}
      title={tr("轮换后台前缀", "Rotate the console prefix")}
      description={tr(
        "所有管理员都要改用新地址登录；旧地址在所有实例上立即失效。",
        "Every admin moves to the new address; the old one dies at once on every instance.",
      )}
      onSubmit={() => void rotate()}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="destructive" loading={busy} disabled={!ready}>
            {tr("轮换前缀", "Rotate prefix")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field group label={tr("新前缀", "New prefix")}>
          <RadioCards<"random" | "custom">
            value={mode}
            onChange={setMode}
            cols={2}
            label={tr("新前缀", "New prefix")}
            items={[
              {
                value: "random",
                title: tr("随机生成", "Random"),
                desc: tr("由面板生成（推荐）", "Made by the panel (recommended)"),
                icon: <Shuffle />,
              },
              {
                value: "custom",
                title: tr("自定义", "Custom"),
                desc: tr("8–64 位", "8–64 characters"),
                icon: <Code2 />,
              },
            ]}
          />
        </Field>
        {mode === "custom" && (
          <Field label={tr("自定义前缀", "Custom prefix")} error={error}>
            <Input
              data-autofocus
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          </Field>
        )}
        <div className="grid gap-1.5 rounded-lg bg-window p-3 ring-1 ring-border ring-inset">
          <div className="text-footnote text-muted-foreground">{tr("新地址", "New address")}</div>
          <code className="font-mono text-body break-all">
            {origin}/<b className="text-primary">{mode === "custom" ? c || "…" : tr("（随机）", "(random)")}</b>
            /admin
          </code>
        </div>
        <Field label={tr(`输入「${word}」以确认`, `Type "${word}" to confirm`)}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={word} autoComplete="off" />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 数据保留
// ---------------------------------------------------------------------------

export function RetentionSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <RetentionForm d={d} />}</Loaded>;
}

/** Days kept (0 = forever) → comparable (forever = ∞). */
const keep = (n: number) => (n === 0 ? Infinity : n);

function RetentionForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const sec = d.security;
  const f = useDraft({
    audit: numText(sec.audit_retention_days.value),
    traffic: numText(sec.traffic_daily_retention_days.value),
  });
  const v = f.value!;
  const auditError =
    intError(v.audit, 0, 36500, tr, true) ??
    (intOf(v.audit) !== null && intOf(v.audit)! > 0 && intOf(v.audit)! < 90
      ? tr("0（永久）或 90–36500", "0 (forever) or 90–36500")
      : undefined);
  const trafficError =
    intError(v.traffic, 0, 36500, tr, true) ??
    (intOf(v.traffic) !== null && intOf(v.traffic)! > 0 && intOf(v.traffic)! < 32
      ? tr("0（永久）或 32–36500", "0 (forever) or 32–36500")
      : undefined);
  const eff = (raw: string, def: number) => intOf(raw) ?? def;
  const a0 = sec.audit_retention_days.effective;
  const a1 = eff(v.audit, sec.audit_retention_days.default);
  const t0 = sec.traffic_daily_retention_days.effective;
  const t1 = eff(v.traffic, sec.traffic_daily_retention_days.default);
  const auditShorter = !auditError && keep(a1) < keep(a0);
  const trafficShorter = !trafficError && keep(t1) < keep(t0);
  const days = (n: number) => (n === 0 ? tr("永久", "forever") : tr(`${n} 天`, `${n} days`));
  useSavePart({
    count: f.edited.length,
    errors: (auditError ? 1 : 0) + (trafficError ? 1 : 0),
    discard: f.reset,
    save: async () => {
      const shorter: { label: string; value: string }[] = [];
      if (auditShorter)
        shorter.push({
          label: tr(`审计日志 ${days(a0)} → ${days(a1)}`, `Audit log ${days(a0)} → ${days(a1)}`),
          value: tr(`删除早于 ${a1} 天的记录`, `Entries older than ${a1} days are deleted`),
        });
      if (trafficShorter)
        shorter.push({
          label: tr(`流量明细 ${days(t0)} → ${days(t1)}`, `Traffic history ${days(t0)} → ${days(t1)}`),
          value: tr(
            "超过保留期的整月日明细并入月汇总后删除",
            "Daily rows of whole months past the period are merged into monthly totals and dropped",
          ),
        });
      if (shorter.length) {
        const ok = await confirm({
          title: tr("缩短保留期？", "Shorten the retention?"),
          description: tr(
            "超出新保留期的数据会在下一次清理时删除，无法恢复。需要留档请先导出。",
            "Data past the new period is deleted at the next cleanup and cannot be restored. Export first if you need a copy.",
          ),
          impacts: shorter,
          typeToConfirm: tr("删除旧数据", "delete old data"),
          confirmLabel: tr("缩短并删除", "Shorten and delete"),
        });
        if (!ok) return false;
      }
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/security", {
            version: cur.version,
            audit_retention_days: intOf(v.audit),
            traffic_daily_retention_days: intOf(v.traffic),
            cloudflare_ranges: cur.security.cloudflare_ranges,
            extra_release_keys: cur.security.extra_release_keys,
          }),
        { ok: tr("保留设置已保存", "Retention saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  const later = (
    <span className="text-warning">{tr(" · 保存后将删除更早的数据", " · older data is deleted after saving")}</span>
  );
  return (
    <OwnerOnly what={tr("保留设置", "the retention settings")}>
      <Group
        title={tr("保留天数", "Days kept")}
        footer={tr(
          "0 = 永久保留；留空 = 默认值。延长只影响之后的数据；缩短会在保存时确认。",
          "0 = forever; empty = the default. Longer only affects later data; shorter is confirmed on save.",
        )}
      >
        <FieldRow
          label={tr("审计日志保留天数", "Audit log retention (days)")}
          description={
            <>
              {tr(
                `0 或 90–36500；默认 ${sec.audit_retention_days.default}，当前生效 ${days(a0)}`,
                `0 or 90–36500; default ${sec.audit_retention_days.default}, in effect ${days(a0)}`,
              )}
              {auditShorter && later}
            </>
          }
          error={auditError}
          changed={f.isEdited("audit")}
        >
          {(x) => (
            <UnitInput
              {...x}
              unit={tr("天", "d")}
              invalid={!!auditError}
              placeholder={String(sec.audit_retention_days.default)}
              value={v.audit}
              onChange={(e) => f.set("audit", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow
          label={tr("流量明细保留天数", "Traffic history retention (days)")}
          description={
            <>
              {tr(
                `0 或 32–36500；默认 ${sec.traffic_daily_retention_days.default}，当前生效 ${days(t0)}；按整月归并`,
                `0 or 32–36500; default ${sec.traffic_daily_retention_days.default}, in effect ${days(t0)}; rolled up by whole months`,
              )}
              {trafficShorter && later}
            </>
          }
          error={trafficError}
          changed={f.isEdited("traffic")}
        >
          {(x) => (
            <UnitInput
              {...x}
              unit={tr("天", "d")}
              invalid={!!trafficError}
              placeholder={String(sec.traffic_daily_retention_days.default)}
              value={v.traffic}
              onChange={(e) => f.set("traffic", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Group title={tr("不受这里控制的数据", "Data these settings never delete")}>
        <SRow
          label={tr("订单与资金流水", "Orders and the money ledger")}
          description={tr(
            "永久保留（财务记录）；流量明细超过保留期后仍保留月汇总",
            "Kept for good (financial records); traffic keeps its monthly totals past the period",
          )}
        />
        <SRow
          label={tr("已删除或注销的用户", "Deleted or erased users")}
          description={tr(
            "有财务记录的账户只匿名化、不删除；订单仍指向它",
            "Accounts with financial records are anonymised, not deleted; their orders still point to them",
          )}
        />
      </Group>
    </OwnerOnly>
  );
}

// ---------------------------------------------------------------------------
// 我的账户与通行密钥 (an entry card: the account lives on /account)
// ---------------------------------------------------------------------------

type MyPasskeys = {
  available: boolean;
  passkeys: { id: string; name: string; last_used_at: string | null; current: boolean }[];
  password_login: boolean;
};

export function AccountSection() {
  const tr = useTr();
  const me = useMe();
  const q = useQuery({ queryKey: ["passkeys"], queryFn: () => get<MyPasskeys>("/me/passkeys") });
  const keys = (q.data?.passkeys ?? []).filter((p) => p.current);
  return (
    <>
      <Card className="grid gap-4 p-5">
        <div className="flex items-center gap-3">
          <Avatar name={me.email} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-headline font-semibold break-all">
              {me.email}
              <Badge tone={me.is_owner ? "primary" : "neutral"}>
                {me.is_owner ? tr("所有者", "Owner") : tr("管理员", "Admin")}
              </Badge>
            </div>
            <div className="text-footnote text-muted-foreground">
              {q.data
                ? tr(`${keys.length} 把通行密钥`, `${keys.length} ${keys.length === 1 ? "passkey" : "passkeys"}`)
                : tr("正在读取通行密钥…", "Loading passkeys…")}
            </div>
          </div>
        </div>
        {keys.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {keys.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-lg bg-window px-3 py-2.5 ring-1 ring-border ring-inset"
              >
                <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium">{p.name}</div>
                  <div className="text-caption text-faint">
                    {p.last_used_at
                      ? tr(`最后使用 ${dateTime(p.last_used_at)}`, `Last used ${dateTime(p.last_used_at)}`)
                      : tr("还没有用过", "Never used")}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-separator pt-3">
          <span className="min-w-0 flex-1 basis-60 text-footnote text-muted-foreground">
            {q.data &&
              (q.data.password_login
                ? tr("密码登录：开启。", "Password sign-in: on. ")
                : tr("密码登录：关闭（只用通行密钥）。", "Password sign-in: off (passkeys only). "))}
            {tr(
              "修改密码、增删通行密钥和「只用通行密钥登录」都在「我的账户」。",
              "Change the password, add or remove passkeys and passkey-only sign-in in My account.",
            )}
          </span>
          <Button asChild variant="primary">
            <Link to="/account">
              {tr("打开我的账户", "Open My account")}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </Card>
      <Group title={tr("相关的站点设置", "Related site settings")}>
        <SRow
          icon={<Fingerprint className="size-4 text-faint" aria-hidden="true" />}
          label={tr("登录与人机验证", "Sign-in and bot protection")}
          description={tr(
            "用户与管理员的登录方式、管理员只用通行密钥",
            "How users and admins sign in, admins passkey only",
          )}
        >
          <Button asChild size="sm" variant="ghost">
            <Link to="/settings/login">{tr("前往", "Open")}</Link>
          </Button>
        </SRow>
        <SRow
          icon={<KeyRound className="size-4 text-faint" aria-hidden="true" />}
          label={tr("通行密钥中心域名", "Passkey centre")}
          description={tr("在「域名与证书」的危险操作区", "In the danger zone of Domains and certificates")}
        >
          <Button asChild size="sm" variant="ghost">
            <Link to="/settings/domains">{tr("前往", "Open")}</Link>
          </Button>
        </SRow>
      </Group>
    </>
  );
}
