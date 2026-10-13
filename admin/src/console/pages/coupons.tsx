// 优惠券 (CPN-*), v2 (proposal-v2 §3 优惠券 / 批量码): page tabs 优惠券 /
// 批量码 (/coupons, /coupons/batches). Each coupon row reads as one sentence
// (code pill + name, the rule sentence, a usage bar with "近 7 天 +N", the
// validity, the status); search and the status segment (with counts) live in
// the URL; ⋯ = copy, disable/enable, delete (disabled once used). Batches:
// one row per batch (state, code pattern, codes used, terms, CSV, ⋯ void).
// Dialogs (new / detail / generate) are in coupons-dialogs.tsx.
import { useQuery } from "@tanstack/react-query";
import { Ban, Copy, Download, Ellipsis, Layers3, Plus, Power, PowerOff, SearchX, Ticket, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { get } from "../../shared/api";
import { cn } from "../../shared/cn";
import { copyText, dateOnly, pct } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Segmented } from "../../shared/ui/form";
import { PageHeader } from "../../shared/ui/layout";
import { Menu, MenuItem, MenuSeparator } from "../../shared/ui/menu";
import { Meter } from "../../shared/ui/meter";
import { EmptyState, ErrorState, SkeletonRows } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { useQS, useRoute } from "../router";
import { CodePill, batchLabel, ruleParts, windowText, type Batch, type Coupon } from "../components/commerce-coupons";
import { PageTabs, SearchField } from "../components/kit";
import { CouponStatus, couponState, type CouponState } from "../components/status";
import type { PlanView } from "../types";
import { downloadFile } from "./download";
import { BatchDialog, CouponDetail, CouponEditor, useBatchActions, useCouponActions } from "./coupons-dialogs";
import { usePlans } from "./users";

const STATES: CouponState[] = ["live", "scheduled", "exhausted", "disabled", "expired"];
const ORDER: Record<CouponState, number> = { live: 0, scheduled: 1, exhausted: 2, disabled: 3, expired: 4 };
type SF = "all" | CouponState;

const num = (n: number) => n.toLocaleString("en");

export function CouponsPage() {
  const tr = useTr();
  const { sub } = useRoute();
  const [query, patch] = useQS();
  const isBatch = sub[0] === "batches";
  const open = query.get("open");
  const plans = usePlans();
  const list = useQuery({ queryKey: ["coupons"], queryFn: () => get<Coupon[]>("/coupons") });
  const batches = useQuery({ queryKey: ["coupon-batches"], queryFn: () => get<Batch[]>("/coupon-batches") });
  const all = useMemo(() => list.data ?? [], [list.data]);
  const live = all.filter((c) => couponState(c) === "live").length;
  const week = all.reduce((n, c) => n + c.redeemed_7d, 0);
  const bs = batches.data ?? [];
  const activeB = bs.filter((b) => !b.revoked_at);
  const close = () => patch({ open: null, tab: null });
  return (
    <>
      <PageHeader
        title={tr("优惠券", "Coupons")}
        description={
          isBatch ? (
            batches.data ? (
              <span className="tnum">
                {tr(
                  `${activeB.length} 批有效 · 共 ${num(activeB.reduce((n, b) => n + b.codes, 0))} 个码，已用 ${num(activeB.reduce((n, b) => n + b.codes_used, 0))} 个`,
                  `${activeB.length} active batches · ${num(activeB.reduce((n, b) => n + b.codes, 0))} codes, ${num(activeB.reduce((n, b) => n + b.codes_used, 0))} used`,
                )}
              </span>
            ) : (
              tr("批量生成的一次性兑换码。", "Generated one-off codes.")
            )
          ) : list.data ? (
            <span className="tnum">
              <b className="font-semibold text-foreground">{live}</b>
              {tr(" 张生效中 · 近 7 天核销 ", " live · ")}
              <b className="font-semibold text-foreground">{num(week)}</b>
              {tr(" 次", " redeemed in the last 7 days")}
            </span>
          ) : (
            tr("用户在结账时输入代码享受折扣。", "Codes buyers enter at checkout.")
          )
        }
        actions={
          isBatch ? (
            <Button variant="primary" icon={Plus} onClick={() => patch({ open: "new" })}>
              {tr("批量生成", "Generate codes")}
            </Button>
          ) : (
            <Button variant="primary" icon={Plus} onClick={() => patch({ open: "new" })}>
              {tr("新建优惠券", "New coupon")}
            </Button>
          )
        }
      />
      <PageTabs
        label={tr("优惠券页面", "Coupon pages")}
        items={[
          { to: "/coupons", label: tr("优惠券", "Coupons"), count: list.data ? all.length : undefined, end: true },
          { to: "/coupons/batches", label: tr("批量码", "Batches"), count: batches.data ? bs.length : undefined },
        ]}
      />
      {isBatch ? (
        <BatchList q={batches} plans={plans.data} onNew={() => patch({ open: "new" })} />
      ) : (
        <CouponList q={list} plans={plans.data} />
      )}
      {!isBatch && open === "new" && <CouponEditor coupons={all} plans={plans.data ?? []} onClose={close} />}
      {!isBatch && open && open !== "new" && <CouponDetail id={open} plans={plans.data} onClose={close} />}
      {isBatch && open === "new" && <BatchDialog plans={plans.data ?? []} onClose={close} />}
    </>
  );
}

/* ---------- Coupons ---------- */

function CouponList({ q, plans }: { q: ReturnType<typeof useQuery<Coupon[]>>; plans: PlanView[] | undefined }) {
  const tr = useTr();
  const [query, patch] = useQS();
  const term = query.get("q") ?? "";
  const raw = query.get("status") ?? "";
  const sf: SF = (STATES as string[]).includes(raw) ? (raw as CouponState) : "all";
  const all = useMemo(() => q.data ?? [], [q.data]);
  const needle = term.trim().toLowerCase();
  const rows = useMemo(
    () =>
      all
        .map((c) => ({ c, s: couponState(c) }))
        .filter(
          ({ c, s }) =>
            (sf === "all" || s === sf) &&
            (!needle || c.code.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle)),
        )
        .sort((a, b) => ORDER[a.s] - ORDER[b.s] || b.c.redeemed_7d - a.c.redeemed_7d),
    [all, sf, needle],
  );
  const cnt = (s: CouponState) => all.filter((c) => couponState(c) === s).length;
  const labels: Record<SF, string> = {
    all: tr("全部", "All"),
    live: tr("生效中", "Live"),
    scheduled: tr("未开始", "Scheduled"),
    exhausted: tr("已用完", "Used up"),
    disabled: tr("已停用", "Disabled"),
    expired: tr("已过期", "Expired"),
  };
  const clear = () => patch({ q: null, status: null });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-separator p-3">
        <SearchBox value={term} onChange={(v) => patch({ q: v || null }, true)} />
        <div className="-mx-1 max-w-full overflow-x-auto px-1 [scrollbar-width:none]">
          <Segmented
            label={tr("优惠券状态", "Coupon status")}
            value={sf}
            onChange={(v) => patch({ status: v === "all" ? null : v })}
            options={(["all", ...STATES] as SF[]).map((v) => ({
              value: v,
              label: labels[v],
              count: q.data ? (v === "all" ? all.length : cnt(v)) : undefined,
            }))}
          />
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1.6fr)_200px_130px_84px_32px] gap-x-4 border-b border-separator px-4 py-1.5 text-footnote font-medium text-muted-foreground max-md:hidden">
        <span>{tr("优惠码与规则", "Code and rules")}</span>
        <span>{tr("使用", "Usage")}</span>
        <span>{tr("有效期", "Validity")}</span>
        <span>{tr("状态", "Status")}</span>
        <span />
      </div>
      {q.isPending ? (
        <SkeletonRows rows={6} height={60} avatar={false} />
      ) : q.isError ? (
        <ErrorState
          title={tr("优惠券加载失败", "Failed to load the coupons")}
          error={q.error}
          raw={q.error instanceof Error ? q.error.message : undefined}
          onRetry={() => void q.refetch()}
        />
      ) : rows.length === 0 ? (
        all.length === 0 ? (
          <EmptyState
            icon={Ticket}
            title={tr("还没有优惠券", "No coupons yet")}
            description={tr(
              "优惠券让用户在下单时输入代码享受折扣，可以限定套餐、周期、新用户和次数。",
              "Buyers enter a coupon code at checkout for a discount; limit it by plan, period, new customers and uses.",
            )}
            action={
              <Button variant="primary" icon={Plus} onClick={() => patch({ open: "new" })}>
                {tr("新建优惠券", "New coupon")}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={SearchX}
            title={tr("没有符合条件的优惠券", "No coupons match")}
            description={
              needle
                ? tr(
                    `没有代码或名称包含「${term.trim()}」的优惠券。`,
                    `No coupon whose code or name contains “${term.trim()}”.`,
                  )
                : tr("当前状态下没有优惠券。", "No coupon is in this state.")
            }
            action={<Button onClick={clear}>{tr("清除筛选", "Clear filters")}</Button>}
          />
        )
      ) : (
        <div className="divide-y divide-separator">
          {rows.map(({ c, s }) => (
            <CouponRow key={c.id} c={c} s={s} plans={plans} onOpen={() => patch({ open: c.id, tab: null })} />
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <div className="border-t border-separator px-4 py-2.5 text-footnote text-muted-foreground">
          {all.length >= 1000
            ? tr(`${rows.length} 张（只取最新 1000 张）`, `${rows.length} (newest 1000 only)`)
            : tr(`共 ${rows.length} 张`, `${rows.length} in total`)}
        </div>
      )}
    </Card>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tr = useTr();
  return (
    <div className="min-w-52 flex-1 max-sm:basis-full">
      <SearchField value={value} onChange={onChange} label={tr("搜索代码或名称", "Search code or name")} />
    </div>
  );
}

function CouponRow({
  c,
  s,
  plans,
  onOpen,
}: {
  c: Coupon;
  s: CouponState;
  plans: PlanView[] | undefined;
  onOpen: () => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const { toggle, remove } = useCouponActions();
  const w = windowText(c, s, tr);
  const dim = s === "expired" || s === "disabled";
  const used = c.used > 0 || c.redeemed > 0;
  return (
    <div
      data-row={c.id}
      className={cn(
        "group relative grid items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-accent md:grid-cols-[minmax(0,1.6fr)_200px_130px_84px_32px] md:py-2.5",
        dim && "[&_.dimmable]:opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        aria-label={tr(`打开 ${c.code}`, `Open ${c.code}`)}
      />
      <div className="dimmable pointer-events-none relative min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <CodePill code={c.code} />
          <span className="truncate text-body font-medium">{c.name}</span>
          <span className="ml-auto md:hidden">
            <CouponStatus state={s} />
          </span>
        </div>
        <div className="mt-1 truncate text-body text-muted-foreground">{ruleParts(c, plans, tr).join(" · ")}</div>
      </div>
      <div className="dimmable pointer-events-none relative">
        <div className="flex items-baseline justify-between gap-2 text-footnote">
          <span className="tnum">
            <b className="font-semibold text-foreground">{num(c.used)}</b>
            <span className="text-muted-foreground">
              {" "}
              / {c.max_uses == null ? tr("不限", "unlimited") : num(c.max_uses)}
            </span>
          </span>
          {c.redeemed_7d > 0 ? (
            <span className="tnum text-success">{tr(`近 7 天 +${c.redeemed_7d}`, `7 days +${c.redeemed_7d}`)}</span>
          ) : (
            <span className="text-faint">{tr("近 7 天无核销", "None in 7 days")}</span>
          )}
        </div>
        {c.max_uses == null ? (
          <div className="mt-1 text-caption text-faint">{tr("总次数不限", "No total limit")}</div>
        ) : (
          <Meter className="mt-1" value={pct(c.used, c.max_uses)} label={tr("使用比例", "Share used")} />
        )}
      </div>
      <div className="dimmable pointer-events-none relative max-md:flex max-md:items-baseline max-md:gap-2 max-md:pr-10">
        <div className={cn("text-body font-medium", w.warn && "text-warning")}>{w.t}</div>
        <div className="tnum text-footnote text-faint">{w.sub}</div>
      </div>
      <div className="relative max-md:hidden">
        <CouponStatus state={s} />
      </div>
      <div className="relative max-md:absolute max-md:right-2 max-md:bottom-2">
        <Menu
          label={tr(`${c.code} 的操作`, `Actions for ${c.code}`)}
          trigger={
            <Button
              variant="ghost"
              size="icon-sm"
              icon={Ellipsis}
              aria-label={tr("更多操作", "More actions")}
              className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
            />
          }
        >
          <MenuItem
            icon={Copy}
            onClick={async () => {
              if (await copyText(c.code)) toast({ tone: "success", title: tr(`已复制 ${c.code}`, `Copied ${c.code}`) });
              else toast({ tone: "error", title: tr("复制失败，请手动复制", "Copy failed; copy it by hand") });
            }}
          >
            {tr("复制代码", "Copy code")}
          </MenuItem>
          <MenuItem icon={c.enabled ? PowerOff : Power} onClick={() => void toggle(c)}>
            {c.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Trash2} danger disabled={used} onClick={() => void remove(c)}>
            <span className="flex-1">{tr("删除", "Delete")}</span>
            {used && <span className="text-caption">{tr("已使用", "Used")}</span>}
          </MenuItem>
        </Menu>
      </div>
    </div>
  );
}

/* ---------- Batches ---------- */

function batchState(b: Batch, tr: Tr) {
  if (b.revoked_at)
    return (
      <Badge tone="neutral">
        <Ban aria-hidden="true" />
        {tr("已作废", "Revoked")}
      </Badge>
    );
  if (b.template.ends_at && Date.parse(b.template.ends_at) <= Date.now())
    return <Badge tone="outline">{tr("已过期", "Expired")}</Badge>;
  if (b.codes > 0 && b.codes_used >= b.codes) return <Badge tone="warning">{tr("已用完", "Used up")}</Badge>;
  return (
    <Badge tone="success" dot>
      {tr("有效", "Active")}
    </Badge>
  );
}

function BatchList({
  q,
  plans,
  onNew,
}: {
  q: ReturnType<typeof useQuery<Batch[]>>;
  plans: PlanView[] | undefined;
  onNew: () => void;
}) {
  const tr = useTr();
  const rows = q.data ?? [];
  return (
    <Card>
      {q.isPending ? (
        <SkeletonRows rows={4} height={72} avatar={false} />
      ) : q.isError ? (
        <ErrorState
          title={tr("批量码加载失败", "Failed to load the batches")}
          error={q.error}
          raw={q.error instanceof Error ? q.error.message : undefined}
          onRetry={() => void q.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Layers3}
          title={tr("还没有批量码", "No code batches yet")}
          description={tr(
            "一次生成成百上千个一次性兑换码，适合渠道投放、线下卡片和合作伙伴发放。",
            "Generate hundreds of one-off codes at once — for channels, printed cards and partners.",
          )}
          action={
            <Button variant="primary" icon={Plus} onClick={onNew}>
              {tr("批量生成", "Generate codes")}
            </Button>
          }
        />
      ) : (
        <div className="divide-y divide-separator">
          {rows.map((b) => (
            <BatchRow key={b.id} b={b} plans={plans} />
          ))}
        </div>
      )}
    </Card>
  );
}

function BatchRow({ b, plans }: { b: Batch; plans: PlanView[] | undefined }) {
  const tr = useTr();
  const [download, downloading] = useAction();
  const { revoke } = useBatchActions();
  const t = b.template;
  const label = batchLabel(b, tr);
  const share = pct(b.codes_used, b.codes);
  const perCode =
    t.max_uses == null ? tr("每码不限次", "unlimited per code") : tr(`每码 ${t.max_uses} 次`, `${t.max_uses} per code`);
  const until = b.revoked_at
    ? tr(`已于 ${dateOnly(b.revoked_at)} 作废`, `revoked ${dateOnly(b.revoked_at)}`)
    : t.ends_at
      ? tr(`至 ${dateOnly(t.ends_at)}`, `until ${dateOnly(t.ends_at)}`)
      : tr("长期有效", "no end date");
  return (
    <div
      data-row={b.id}
      className={cn(
        "grid items-center gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1.5fr)_200px_minmax(0,1fr)_auto]",
        b.revoked_at && "[&>.dim]:opacity-55",
      )}
    >
      <div className="dim min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body font-semibold">{label}</span>
          {batchState(b, tr)}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-footnote text-muted-foreground">
          <CodePill code={`${b.prefix}${"X".repeat(t.length || 10)}`} className="text-caption" />
          <span className="truncate">
            {dateOnly(b.created_at)} · {b.actor_label}
          </span>
        </div>
      </div>
      <div className="dim">
        <div className="flex items-baseline justify-between text-footnote">
          <span className="tnum">
            <b className="font-semibold">{num(b.codes_used)}</b>
            <span className="text-muted-foreground">
              {" "}
              / {num(b.codes)} {tr("个已用", "used")}
            </span>
          </span>
          <span className="tnum text-faint">{share}%</span>
        </div>
        <Meter className="mt-1" value={share} label={tr("已用的码", "Codes used")} />
      </div>
      <div className="dim min-w-0 text-body text-muted-foreground">
        <div className="truncate">{ruleParts(t, plans, tr).join(" · ")}</div>
        <div className="truncate text-footnote text-faint">
          {perCode} · {until}
        </div>
      </div>
      <div className="flex items-center gap-1 max-md:justify-end">
        <Button
          size="sm"
          variant="outline"
          icon={Download}
          loading={downloading}
          onClick={() =>
            void download(() =>
              downloadFile(`/coupon-batches/${b.id}/export.csv`, `akari-coupon-batch-${b.id.slice(0, 8)}.csv`),
            )
          }
        >
          {tr("导出 CSV", "Export CSV")}
        </Button>
        <Menu
          label={tr(`${label} 的操作`, `Actions for ${label}`)}
          trigger={
            <Button variant="ghost" size="icon-sm" icon={Ellipsis} aria-label={tr("更多操作", "More actions")} />
          }
        >
          <MenuItem icon={Trash2} danger disabled={!!b.revoked_at} onClick={() => void revoke(b)}>
            {tr("作废整批", "Revoke batch")}
          </MenuItem>
        </Menu>
      </div>
    </div>
  );
}
