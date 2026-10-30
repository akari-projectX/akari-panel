// 内容 · 活动 (CNT-09, CNT-10). The dashboard's activity slot in the portal:
// a title, a one-line description, an optional badge ("8折"), an optional
// coupon whose code users see while the coupon is usable, an optional link
// (default the shop), a required window (the portal counts down to its end)
// and an audience. Users see one promotion at a time: the highest sort, then
// the one ending soonest. The list shows each one's state (进行中 / 已排期 /
// 已结束 / 已停用), window, audience and coupon; the editor is a lg dialog
// with a live preview of the slot. URL: `/content/promotions`,
// `?open=new|<id>`.
import { useQuery } from "@tanstack/react-query";
import { Gift, Pencil, Plus, Ticket, Trash2 } from "lucide-react";
import { useState } from "react";
import { del, get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateTime, fromLocalInput, toLocalInput } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Switch } from "../../shared/ui/form";
import { MenuItem, MenuSeparator, RowMenu } from "../../shared/ui/menu";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { SaveFooter } from "../components/kit";
import { RadioCards } from "../components/inputs";
import { useAction } from "../data";
import { useQS } from "../router";

export type Promotion = {
  id: string;
  title_zh: string;
  title_en: string | null;
  line_zh: string;
  line_en: string | null;
  badge: string | null;
  /** The coupon's current code (null without one). */
  coupon_code: string | null;
  /** Users see the code right now (the coupon is enabled, in its window, not used up). */
  coupon_usable: boolean;
  cta_label: string | null;
  cta_url: string | null;
  starts_at: string;
  ends_at: string;
  audience: string;
  enabled: boolean;
  sort: number;
  version: number;
  active: boolean;
  created_at: string;
};

type Life = "live" | "scheduled" | "ended" | "off";

function lifeOf(p: Promotion, now = Date.now()): Life {
  if (!p.enabled) return "off";
  if (new Date(p.ends_at).getTime() <= now) return "ended";
  if (new Date(p.starts_at).getTime() > now) return "scheduled";
  return "live";
}

function lifeBadge(l: Life, tr: Tr) {
  if (l === "live") return <Badge tone="success">{tr("进行中", "Live")}</Badge>;
  if (l === "scheduled") return <Badge tone="info">{tr("已排期", "Scheduled")}</Badge>;
  if (l === "ended") return <Badge tone="neutral">{tr("已结束", "Ended")}</Badge>;
  return <Badge tone="neutral">{tr("已停用", "Disabled")}</Badge>;
}

function audienceText(a: string, tr: Tr) {
  if (a === "with_plan") return tr("有套餐的用户", "Users with a plan");
  if (a === "without_plan") return tr("没有套餐的用户", "Users without a plan");
  return tr("所有用户", "All users");
}

export function usePromotions() {
  return useQuery({ queryKey: ["promotions"], queryFn: () => get<Promotion[]>("/promotions") });
}

export function PromotionsManager() {
  const tr = useTr();
  const q = usePromotions();
  const [query, patch] = useQS();
  const remove = useDeletePromotion();
  const list = q.data ?? [];
  const open = query.get("open");
  const editing = open && open !== "new" ? list.find((p) => p.id === open) : undefined;

  let body;
  if (q.isPending)
    body = (
      <Card className="divide-y divide-separator" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex h-16 items-center gap-4 px-4">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="ml-auto h-3 w-1/4" />
          </div>
        ))}
      </Card>
    );
  else if (list.length === 0 || (q.isError && !q.data))
    body = (
      <Card>
        {q.isError && !q.data ? (
          <ErrorState
            title={tr("活动加载失败", "The promotions did not load")}
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        ) : (
          <EmptyState
            icon={Gift}
            title={tr("还没有活动", "No promotions yet")}
            description={tr(
              "活动显示在门户仪表盘的右栏：倒计时、折扣字样、优惠码与去商店的按钮。",
              "A promotion shows in the portal dashboard's right column: a countdown, a badge, a coupon code and a link to the shop.",
            )}
            action={
              <Button variant="primary" icon={Plus} onClick={() => patch({ open: "new" })}>
                {tr("新建活动", "New promotion")}
              </Button>
            }
          />
        )}
      </Card>
    );
  else
    body = (
      <Card className="divide-y divide-separator overflow-hidden" data-testid="promotion-list">
        {list.map((p) => {
          const life = lifeOf(p);
          return (
            <div
              key={p.id}
              data-testid="promotion-row"
              className={cn(
                "flex min-h-16 items-center gap-3 px-4 py-2 hover:bg-accent/50 sm:gap-4",
                (life === "ended" || life === "off") && "opacity-70",
              )}
            >
              <button
                type="button"
                onClick={() => patch({ open: p.id })}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                aria-label={tr(`编辑 ${p.title_zh}`, `Edit ${p.title_zh}`)}
              >
                <span className="flex min-w-0 max-w-full items-center gap-2">
                  {p.badge && <span className="shrink-0 text-body font-semibold text-primary">{p.badge}</span>}
                  <span className="truncate text-body font-semibold">{p.title_zh}</span>
                </span>
                <span className="min-w-0 max-w-full truncate text-footnote text-muted-foreground">
                  {dateTime(p.starts_at)} – {dateTime(p.ends_at)} · {audienceText(p.audience, tr)}
                </span>
              </button>
              {p.coupon_code && (
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 text-footnote max-sm:hidden",
                    p.coupon_usable ? "text-muted-foreground" : "text-warning",
                  )}
                  title={
                    p.coupon_usable
                      ? tr("用户能看到这个优惠码", "Users see this code")
                      : tr("优惠券不可用，用户看不到优惠码", "The coupon is not usable; users do not see the code")
                  }
                >
                  <Ticket className="size-3.5" aria-hidden="true" />
                  <span className="font-mono">{p.coupon_code}</span>
                </span>
              )}
              {lifeBadge(life, tr)}
              <RowMenu label={tr(`${p.title_zh} 的操作`, `Actions of ${p.title_zh}`)}>
                {() => (
                  <>
                    <MenuItem icon={Pencil} onClick={() => patch({ open: p.id })}>
                      {tr("编辑", "Edit")}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={Trash2} danger onClick={() => void remove(p)}>
                      {tr("删除…", "Delete…")}
                    </MenuItem>
                  </>
                )}
              </RowMenu>
            </div>
          );
        })}
      </Card>
    );

  return (
    <>
      <p className="mb-3 px-1 text-footnote text-muted-foreground">
        {tr(
          "用户同一时间只看到一个活动：排序值最大的，其次是最先结束的。结束时间一到，门户里的活动位自动消失。",
          "Users see one promotion at a time: the highest sort, then the one ending soonest. At its end the slot disappears from the portal.",
        )}
      </p>
      {body}
      {open && (open === "new" || editing) && (
        <PromotionEditor key={open} promo={editing ?? null} onClose={() => patch({ open: null }, true)} />
      )}
    </>
  );
}

function useDeletePromotion() {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  return async (p: Promotion) => {
    const ok = await confirm({
      title: tr(`删除活动「${p.title_zh}」？`, `Delete the promotion "${p.title_zh}"?`),
      description: tr(
        "门户里的活动位立即消失。优惠券本身不受影响。",
        "The slot disappears from the portal at once. The coupon itself is not affected.",
      ),
      confirmLabel: tr("删除活动", "Delete promotion"),
      action: () => del(`/promotions/${p.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("已删除", "Deleted") });
    return ok;
  };
}

type Form = {
  title_zh: string;
  title_en: string;
  line_zh: string;
  line_en: string;
  badge: string;
  coupon_code: string;
  cta_label: string;
  cta_url: string;
  starts: string;
  ends: string;
  audience: string;
  enabled: boolean;
  sort: string;
};

/** The editor's starting values: the promotion's, or a week from now for a new one. */
function formOf(p: Promotion | null): Form {
  const now = new Date();
  const week = new Date(now.getTime() + 7 * 86_400_000);
  return {
    title_zh: p?.title_zh ?? "",
    title_en: p?.title_en ?? "",
    line_zh: p?.line_zh ?? "",
    line_en: p?.line_en ?? "",
    badge: p?.badge ?? "",
    coupon_code: p?.coupon_code ?? "",
    cta_label: p?.cta_label ?? "",
    cta_url: p?.cta_url ?? "",
    starts: toLocalInput(p?.starts_at ?? now.toISOString()),
    ends: toLocalInput(p?.ends_at ?? week.toISOString()),
    audience: p?.audience ?? "all",
    enabled: p?.enabled ?? true,
    sort: String(p?.sort ?? 0),
  };
}

function PromotionEditor({ promo, onClose }: { promo: Promotion | null; onClose: () => void }) {
  const tr = useTr();
  const [run, saving] = useAction();
  const initial = formOf(promo);
  const [f, setF] = useState<Form>(initial);
  const [tried, setTried] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const starts = fromLocalInput(f.starts);
  const ends = fromLocalInput(f.ends);
  const sort = Number(f.sort);
  const errs = {
    title_zh: f.title_zh.trim() ? null : tr("请填写标题", "Enter a title"),
    line_zh: f.line_zh.trim() ? null : tr("请填写一句说明", "Enter a one-line description"),
    window:
      !starts || !ends
        ? tr("请填写开始与结束时间", "Enter the start and the end")
        : new Date(ends) <= new Date(starts)
          ? tr("结束时间要晚于开始时间", "The end must be after the start")
          : null,
    sort:
      !Number.isInteger(sort) || Math.abs(sort) > 1_000_000
        ? tr("排序值是 −1000000 到 1000000 的整数", "Sort is a whole number from −1000000 to 1000000")
        : null,
    cta_url:
      f.cta_url.trim() && !/^(https?:\/\/|\/)/i.test(f.cta_url.trim())
        ? tr("链接以 https://、http:// 或 / 开头", "Links start with https://, http:// or /")
        : null,
  };
  const bad = Object.values(errs).filter(Boolean).length;
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const opt = (v: string) => v.trim() || null;

  const submit = async () => {
    setTried(true);
    if (bad) return;
    const body = {
      title_zh: f.title_zh.trim(),
      title_en: opt(f.title_en),
      line_zh: f.line_zh.trim(),
      line_en: opt(f.line_en),
      badge: opt(f.badge),
      coupon_code: opt(f.coupon_code),
      cta_label: opt(f.cta_label),
      cta_url: opt(f.cta_url),
      starts_at: starts,
      ends_at: ends,
      audience: f.audience,
      enabled: f.enabled,
      sort,
      ...(promo ? { version: promo.version } : {}),
    };
    const done = await run(() => (promo ? put(`/promotions/${promo.id}`, body) : post("/promotions", body)), {
      ok: promo ? tr("活动已保存", "Promotion saved") : tr("活动已创建", "Promotion created"),
    });
    if (done !== undefined) onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={Gift}
      title={promo ? tr("编辑活动", "Edit promotion") : tr("新建活动", "New promotion")}
      description={tr(
        "显示在门户仪表盘的活动位。时间按站点时区填写。",
        "Shows in the portal dashboard's activity slot. Times are in the site's time zone.",
      )}
      dirty={dirty}
      footer={<SaveFooter tried={tried} bad={bad} saving={saving} onClose={onClose} onSave={() => void submit()} />}
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field label={tr("标题", "Title")} required error={tried ? errs.title_zh : undefined}>
            <Input
              value={f.title_zh}
              maxLength={40}
              data-autofocus
              placeholder={tr("例如：全场 8 折，年付再送 50 GB", "e.g. 20% off everything")}
              aria-invalid={(tried && !!errs.title_zh) || undefined}
              onChange={set("title_zh")}
            />
          </Field>
          <Field label={tr("折扣字样", "Badge")} hint={tr("最多 8 个字", "Up to 8 characters")}>
            <Input value={f.badge} maxLength={8} placeholder={tr("8折", "−20%")} onChange={set("badge")} />
          </Field>
        </div>
        <Field label={tr("一句说明", "One-line description")} required error={tried ? errs.line_zh : undefined}>
          <Input
            value={f.line_zh}
            maxLength={80}
            placeholder={tr("续费同样适用，11 月 11 日结束。", "Renewals included; ends 11 November.")}
            aria-invalid={(tried && !!errs.line_zh) || undefined}
            onChange={set("line_zh")}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={tr("英文标题", "English title")}
            hint={tr("不填则英文用户看到中文", "Empty = English readers see Chinese")}
          >
            <Input value={f.title_en} maxLength={80} onChange={set("title_en")} />
          </Field>
          <Field label={tr("英文说明", "English description")}>
            <Input value={f.line_en} maxLength={160} onChange={set("line_en")} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("开始", "Starts")} required error={tried ? errs.window : undefined}>
            <Input type="datetime-local" value={f.starts} onChange={set("starts")} />
          </Field>
          <Field label={tr("结束（倒计时到这里）", "Ends (the countdown target)")} required>
            <Input type="datetime-local" value={f.ends} onChange={set("ends")} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label={tr("优惠码", "Coupon code")}
            hint={tr("填已有的优惠券；券不可用时用户看不到码", "An existing coupon; hidden while it is not usable")}
          >
            <Input value={f.coupon_code} maxLength={32} className="font-mono" onChange={set("coupon_code")} />
          </Field>
          <Field label={tr("按钮文字", "Button text")} hint={tr("默认「去商店」", "Default: Go to the shop")}>
            <Input value={f.cta_label} maxLength={16} onChange={set("cta_label")} />
          </Field>
          <Field
            label={tr("按钮链接", "Button link")}
            error={tried ? errs.cta_url : undefined}
            hint={tr("默认商店", "Default: the shop")}
          >
            <Input value={f.cta_url} maxLength={512} placeholder="/shop" onChange={set("cta_url")} />
          </Field>
        </div>
        <Field label={tr("给谁看", "Audience")} group>
          <RadioCards
            label={tr("给谁看", "Audience")}
            value={f.audience}
            onChange={(v: string) => setF({ ...f, audience: v })}
            items={[
              { value: "all", title: audienceText("all", tr) },
              { value: "with_plan", title: audienceText("with_plan", tr) },
              { value: "without_plan", title: audienceText("without_plan", tr) },
            ]}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <Field label={tr("排序", "Sort")} error={tried ? errs.sort : undefined} hint={tr("大的优先", "Higher first")}>
            <Input inputMode="numeric" value={f.sort} onChange={set("sort")} />
          </Field>
          <div className="flex items-center gap-3 self-end rounded-lg bg-window px-3 py-2.5 ring-1 ring-border ring-inset">
            <span className="min-w-0 flex-1 text-body font-medium">{tr("启用", "Enabled")}</span>
            <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label={tr("启用", "Enabled")} />
          </div>
        </div>
        <SlotPreview f={f} tr={tr} />
      </div>
    </Dialog>
  );
}

/** The portal slot as users will see it (static countdown). */
function SlotPreview({ f, tr }: { f: Form; tr: Tr }) {
  return (
    <div className="rounded-xl bg-window px-4 py-3 ring-1 ring-border ring-inset" data-testid="promotion-preview">
      <div className="mb-2 flex items-center justify-between text-footnote text-muted-foreground">
        <span>{tr("预览", "Preview")}</span>
        <span className="tnum">{tr("还剩 2 天 13:45:09", "2 days 13:45:09 left")}</span>
      </div>
      <div className="flex min-w-0 items-center gap-4">
        {f.badge.trim() && <span className="shrink-0 text-title2 font-semibold text-primary">{f.badge.trim()}</span>}
        <div className="min-w-0">
          <div className="truncate text-body font-semibold">{f.title_zh.trim() || tr("活动标题", "Title")}</div>
          <div className="truncate text-footnote text-muted-foreground">
            {f.line_zh.trim() || tr("一句说明", "Description")}
          </div>
          {f.coupon_code.trim() && (
            <div className="mt-1 inline-flex items-center gap-2 rounded border border-dashed border-border px-2 py-0.5 text-footnote">
              <span className="text-muted-foreground">{tr("优惠码", "Code")}</span>
              <span className="font-mono">{f.coupon_code.trim().toUpperCase()}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
