// 系统设置 → 订阅 (v2): 订阅链接与格式 (SET-12 formats, the portal import
// buttons as cards — greyed with "格式已关闭" when their format is off —
// SET-26 multipliers in line names with a preview; turning a format off and
// the multiplier change are confirmed together on save; SET-10 the path in
// the danger zone: rotate to a random or custom path, optional mail to every
// user, typed confirmation, then the new address and the mail job's
// progress). 分流规则 (SET-11) is its own lazily loaded file,
// settings-routing.tsx.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Code2, Eye, EyeOff, Mail, RefreshCw, Shuffle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { get, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { useTr, type Tr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { Card, Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Switch } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { Meter } from "../../shared/ui/meter";
import { useAction } from "../data";
import { RadioCards } from "../components/inputs";
import { CopyText } from "../components/kit";
import { fresh, useAccess, useSettings, type SettingsView } from "./settings-data";
import { DangerRow, DangerZone, Loaded, Panel, SwitchRow, useDraft, useSavePart } from "../components/settings-kit";

const FORMATS = ["clash", "sing-box", "links"];
const CLIENTS = ["clash", "stash", "shadowrocket", "sing-box", "hiddify"];

function formatName(f: string, tr: Tr) {
  return (
    (
      {
        clash: "Clash / mihomo",
        "sing-box": "sing-box",
        links: tr("通用链接（v2rayN、Shadowrocket…）", "Share links (v2rayN, Shadowrocket…)"),
      } as Record<string, string>
    )[f] ?? f
  );
}
function clientName(c: string) {
  return (
    (
      {
        clash: "Clash Verge / mihomo",
        stash: "Stash",
        shadowrocket: "Shadowrocket",
        "sing-box": "sing-box",
        hiddify: "Hiddify",
      } as Record<string, string>
    )[c] ?? c
  );
}

/** The format each import button needs. */
const NEEDS: Record<string, string> = {
  clash: "clash",
  stash: "clash",
  shadowrocket: "links",
  "sing-box": "sing-box",
  hiddify: "sing-box",
};

function formatDesc(f: string, tr: Tr) {
  return (
    (
      {
        clash: tr("YAML，含分流规则", "YAML with routing rules"),
        "sing-box": tr("JSON，含分流规则", "JSON with routing rules"),
        links: tr("Base64 节点链接列表", "A Base64 list of share links"),
      } as Record<string, string>
    )[f] ?? ""
  );
}

// ---------------------------------------------------------------------------
// 订阅链接与格式
// ---------------------------------------------------------------------------

export function SubscriptionSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <SubscriptionForm d={d} />}</Loaded>;
}

function SubscriptionForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const f = useDraft({
    formats: d.subscription.formats.effective,
    clients: d.subscription.import_clients.effective,
    name_rate: d.subscription.name_rate,
  });
  const v = f.value!;
  const toggle = (k: "formats" | "clients", id: string, on: boolean) =>
    f.set(k, on ? [...v[k].filter((x) => x !== id), id] : v[k].filter((x) => x !== id));
  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      const off = d.subscription.formats.effective.filter((x) => !v.formats.includes(x));
      const rate = v.name_rate !== d.subscription.name_rate;
      if (off.length || (rate && v.name_rate)) {
        const ok = await confirm({
          title: tr("保存订阅设置？", "Save the subscription settings?"),
          description: [
            off.length
              ? tr(
                  "被关闭的格式立即停止输出（统一 404），在用它的客户端下次刷新订阅时会失败。",
                  "A format turned off stops at once (the uniform 404); clients on it fail on their next refresh.",
                )
              : "",
            rate && v.name_rate
              ? tr(
                  "之后每次修改入口的基础倍率都会改变该线路的名字；客户端刷新订阅后会丢失用户选中的线路，可能回落到第一条（直连）。时段倍率不会显示。",
                  "Every change of an entrance's base multiplier then renames its line; after a refresh clients lose the user's selected line and may fall back to the first (direct). Time-window multipliers are never shown.",
                )
              : "",
          ]
            .filter(Boolean)
            .join(" "),
          impacts: [
            ...off.map((x) => ({
              label: tr(`关闭 ${formatName(x, tr)}`, `Turn off ${formatName(x, tr)}`),
              value: tr("在用它的客户端更新失败", "Its clients fail to update"),
            })),
            ...(rate && v.name_rate
              ? [
                  {
                    label: tr("线路名加上倍率", "Multipliers in line names"),
                    value: tr("倍率不是 1 的线路改名", "Lines not at 1× are renamed"),
                  },
                ]
              : []),
          ],
          tone: "warning",
          confirmLabel: off.length ? tr("关闭并保存", "Turn off and save") : tr("开启并保存", "Turn on and save"),
        });
        if (!ok) return false;
      }
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/subscription", {
            version: cur.version,
            ...(f.isEdited("formats") ? { formats: FORMATS.filter((x) => v.formats.includes(x)) } : {}),
            ...(f.isEdited("clients") ? { import_clients: CLIENTS.filter((x) => v.clients.includes(x)) } : {}),
            ...(f.isEdited("name_rate") ? { name_rate: v.name_rate } : {}),
          }),
        { ok: tr("订阅设置已保存", "Subscription settings saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  const was = (k: "formats" | "clients", x: string) =>
    (k === "formats" ? d.subscription.formats.effective : d.subscription.import_clients.effective).includes(x) !==
    v[k].includes(x);
  return (
    <>
      <Group
        title={tr("订阅格式", "Subscription formats")}
        footer={tr(
          "关闭的格式一律返回统一的 404；以后新增的格式在自定义过的站点上默认关闭。",
          "A disabled format answers the uniform 404; new formats start off on customised sites.",
        )}
      >
        {FORMATS.map((x) => (
          <SwitchRow
            key={x}
            label={formatName(x, tr)}
            name={tr(`订阅格式 ${formatName(x, tr)}`, `Format ${formatName(x, tr)}`)}
            description={formatDesc(x, tr)}
            checked={v.formats.includes(x)}
            onChange={(on) => toggle("formats", x, on)}
            changed={was("formats", x)}
          />
        ))}
      </Group>
      <Panel
        title={tr("门户一键导入按钮", "Portal one-click import buttons")}
        footer={tr(
          "按钮用 clash://、sing-box:// 等协议直接打开客户端。依赖的格式关闭时按钮自动隐藏。",
          "The buttons open the client through clash://, sing-box:// and the like. They hide while their format is off.",
        )}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {CLIENTS.map((x) => {
            const dep = v.formats.includes(NEEDS[x] ?? x);
            const on = v.clients.includes(x);
            return (
              <div
                key={x}
                className={cn(
                  "relative flex flex-col gap-2 rounded-xl bg-card p-3 shadow-card",
                  on && dep && "shadow-[0_0_0_1.5px_var(--primary)]",
                  !dep && "opacity-55",
                )}
              >
                {was("clients", x) && (
                  <span className="absolute top-2 right-2 size-1.5 rounded-full bg-primary" data-changed>
                    <span className="sr-only">{tr("已修改", "Edited")}</span>
                  </span>
                )}
                <span className="text-body font-semibold">{clientName(x)}</span>
                <span className="flex items-center justify-between gap-2 text-footnote text-muted-foreground">
                  {dep ? (on ? tr("显示", "Shown") : tr("隐藏", "Hidden")) : tr("格式已关闭", "Format off")}
                  <Switch
                    label={tr(`一键导入 ${clientName(x)}`, `Import ${clientName(x)}`)}
                    checked={on}
                    onChange={(y) => toggle("clients", x, y)}
                  />
                </span>
              </div>
            );
          })}
        </div>
      </Panel>
      <Group
        title={tr("线路名", "Line names")}
        footer={tr(
          "默认关闭：线路名不随倍率变化，客户端记住的选择不会丢。开启后只显示入口的基础倍率（1x 不显示），不显示时段倍率。",
          "Off by default: names never change with the multiplier, so clients keep the selection. When on, names show the entrance's base multiplier (not 1x), never a time-window one.",
        )}
      >
        <SwitchRow
          label={tr("订阅线路名显示倍率", "Multipliers in line names")}
          checked={v.name_rate}
          onChange={(x) => f.set("name_rate", x)}
          changed={f.isEdited("name_rate")}
        >
          {d.subscription.name_rate && (
            <Banner tone="warning">
              {tr(
                "已开启：修改入口倍率会改变线路名，用户刷新订阅后客户端可能切换到其他线路。",
                "On: changing an entrance's multiplier renames its line; after a refresh clients may switch to another line.",
              )}
            </Banner>
          )}
        </SwitchRow>
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
          {[
            [tr("香港 01", "Hong Kong 01"), ""],
            [tr("日本 02", "Japan 02"), "1.5"],
          ].map(([n, r]) => (
            <code
              key={n}
              className="rounded-md bg-window px-2 py-0.5 font-mono text-footnote ring-1 ring-border ring-inset"
            >
              {n}
              {v.name_rate && r ? <b className="text-primary"> ×{r}</b> : ""}
            </code>
          ))}
          <span className="text-footnote text-faint">{tr("写法示例", "How it reads")}</span>
        </div>
      </Group>
      <SubPath />
    </>
  );
}

function randomPath(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
}

/** SET-10: the site-wide subscription path; a change kills every old link at once. */
function SubPath() {
  const tr = useTr();
  const q = useAccess();
  const [open, setOpen] = useState(false);
  const [reveal, setReveal] = useState(false);
  const path = q.data?.sub_path;
  return (
    <DangerZone>
      <DangerRow
        label={tr("订阅路径", "Subscription path")}
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {path ? <code className="font-mono">{reveal ? `/${path}/<token>` : "/••••••/<token>"}</code> : "…"}
            {path && (
              <button
                type="button"
                onClick={() => setReveal(!reveal)}
                className="hit-44 inline-flex items-center gap-1 text-primary"
              >
                {reveal ? (
                  <EyeOff className="size-3.5" aria-hidden="true" />
                ) : (
                  <Eye className="size-3.5" aria-hidden="true" />
                )}
                {reveal ? tr("隐藏", "Hide") : tr("显示", "Show")}
              </button>
            )}
            <span>
              {tr("· 全站共用；轮换后所有旧链接立即失效", "· one for the site; rotating kills every old link at once")}
            </span>
          </span>
        }
        action={
          <Button
            size="sm"
            variant="destructive-soft"
            icon={RefreshCw}
            disabled={!q.data}
            onClick={() => setOpen(true)}
          >
            {tr("轮换订阅路径…", "Rotate the path…")}
          </Button>
        }
      />
      {open && q.data && (
        <SubPathDialog current={q.data.sub_path} version={q.data.version} onClose={() => setOpen(false)} />
      )}
    </DangerZone>
  );
}

type Job = { id: string; status: string; total: number; done: number; failed: number; skipped: number };

function SubPathDialog({ current, version, onClose }: { current: string; version: number; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const [mode, setMode] = useState<"random" | "custom">("random");
  const [random] = useState(randomPath);
  const [custom, setCustom] = useState("");
  const [notify, setNotify] = useState(true);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState<{ path: string; job: Job | null } | null>(null);
  const p = mode === "random" ? random : custom.trim();
  const error = !/^[A-Za-z0-9_-]{4,64}$/.test(p)
    ? tr("4–64 位字母、数字、- 或 _", "4–64 of A–Z a–z 0–9 - _")
    : p === current
      ? tr("与当前路径相同", "Same as the current path")
      : undefined;
  const job =
    useQuery({
      queryKey: ["users", "batch", done?.job?.id],
      queryFn: () => get<Job>(`/users/batch/${done!.job!.id}`),
      enabled: !!done?.job,
      refetchInterval: (q) =>
        q.state.data && ["done", "cancelled", "failed"].includes(q.state.data.status) ? false : 2000,
    }).data ?? done?.job;
  const submit = async () => {
    setShown(true);
    if (error) return;
    const box: { job?: Job | null } = {};
    const ok = await confirm({
      title: tr(`把订阅路径改为 /${p}/？`, `Change the subscription path to /${p}/?`),
      impact: tr("所有用户的旧订阅链接立即失效", "Every user's old subscription link stops working at once"),
      description: tr(
        "保存后立即生效。旧链接返回 404，客户端更新订阅会失败，直到用户重新导入。",
        "Applies at once. Old links answer 404 and clients fail to update until users import again.",
      ),
      impacts: [
        { label: tr("当前", "Now"), value: <code className="font-mono">{`/${current}/…`}</code> },
        { label: tr("新的", "New"), value: <code className="font-mono">{`/${p}/…`}</code> },
        {
          label: tr("通知邮件", "Notice mail"),
          value: notify ? tr("发给所有已验证邮箱的用户", "To every verified address") : tr("不发送", "None"),
        },
      ],
      typeToConfirm: tr("旧链接全部失效", "old links stop"),
      confirmLabel: tr("轮换订阅路径", "Rotate the path"),
      action: async () => {
        const r = await put<{ notify_job: Job | null }>("/settings/access/sub-path", {
          version,
          sub_path: p,
          confirm: true,
          notify_users: notify,
        });
        box.job = r.notify_job;
      },
    });
    if (!ok) return;
    setDone({ path: p, job: box.job ?? null });
  };
  if (done)
    return (
      <Dialog
        open
        size="md"
        icon={CircleCheck}
        onClose={onClose}
        title={tr("订阅路径已轮换", "Subscription path rotated")}
        description={tr(
          "旧链接已失效（写入审计）。用户需要在客户端里重新导入订阅。",
          "Old links are dead (audited). Users import the subscription again.",
        )}
        footer={
          <>
            <div className="flex-1" />
            <Button variant="primary" onClick={onClose}>
              {tr("完成", "Done")}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <div className="text-footnote font-medium text-muted-foreground">
              {tr("新的订阅地址格式", "The new address")}
            </div>
            <CopyText block value={`/${done.path}/<token>`} />
          </div>
          {job && (
            <Card className="grid gap-2 p-3">
              <div className="flex items-center gap-2 text-body font-medium">
                <Mail className="size-4 text-primary" aria-hidden="true" />
                {tr("邮件通知任务已创建（用户 → 批量任务）", "Notice job created (Users → batch jobs)")}
              </div>
              <Meter value={job.total ? (job.done + job.failed + job.skipped) / job.total : 0} />
              <div className="flex justify-between text-footnote text-muted-foreground">
                <span className="tabular-nums">
                  {tr(
                    `已处理 ${job.done + job.failed + job.skipped} / ${job.total}`,
                    `${job.done + job.failed + job.skipped} of ${job.total}`,
                  )}
                </span>
                <Link to={`/users?job=${job.id}`} className="text-primary hover:underline">
                  {tr("查看任务", "Open the job")}
                </Link>
              </div>
            </Card>
          )}
        </div>
      </Dialog>
    );
  return (
    <Dialog
      open
      size="md"
      tone="danger"
      icon={RefreshCw}
      onClose={onClose}
      title={tr("轮换订阅路径", "Rotate the subscription path")}
      description={tr(
        "所有用户的订阅链接都会变，旧链接立即失效。只在链接被大规模泄露或被封锁时使用。",
        "Every user's link changes and old ones stop at once. Use it when links leaked widely or are blocked.",
      )}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="destructive">
            {tr("轮换…", "Rotate…")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <div className="text-footnote font-medium text-muted-foreground">{tr("当前", "Now")}</div>
          <code className="rounded-md bg-window px-2.5 py-1.5 font-mono text-footnote ring-1 ring-border ring-inset">{`/${current}/<token>`}</code>
        </div>
        <RadioCards
          label={tr("新路径", "New path")}
          value={mode}
          onChange={setMode}
          cols={2}
          items={[
            { value: "random", title: tr("随机生成", "Random"), desc: random, icon: <Shuffle /> },
            {
              value: "custom",
              title: tr("自定义", "Custom"),
              desc: tr("4–64 位字母、数字", "4–64 letters or digits"),
              icon: <Code2 />,
            },
          ]}
        />
        {mode === "custom" && (
          <Field
            label={tr("新路径（4–64 位字母、数字、- 或 _）", "New path (4–64 of A-Z a-z 0-9 - _)")}
            error={shown ? error : undefined}
          >
            <Input
              data-autofocus
              className="font-mono"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onBlur={() => setShown(true)}
            />
          </Field>
        )}
        {mode === "random" && shown && error && <p className="text-footnote text-destructive">{error}</p>}
        <label
          htmlFor="sub-path-notify"
          className="flex items-start gap-2.5 rounded-lg bg-window p-3 ring-1 ring-border ring-inset"
        >
          <span className="mt-0.5">
            <Checkbox
              id="sub-path-notify"
              checked={notify}
              onChange={setNotify}
              label={tr("邮件通知所有用户新链接", "Mail every user the new link")}
            />
          </span>
          <span>
            <span className="block text-body font-medium">{tr("邮件通知所有用户", "Mail every user")}</span>
            <span className="block text-footnote text-muted-foreground">
              {tr(
                "有已验证邮箱的用户会收到新链接与重新导入的步骤（批量任务，按发信速率发送）",
                "Users with a verified address get the new link and how to import it (a batch job, at the sending rate)",
              )}
            </span>
          </span>
        </label>
      </div>
    </Dialog>
  );
}
