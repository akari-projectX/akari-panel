// W16 后台（仅中文）：优惠券管理。新建（折扣/满减、适用套餐与周期、最低消费、
// 有效期、总次数与每人次数、仅限新用户）、启用/停用、调整次数与有效期、
// 删除（仅未被使用的）、查看使用记录。金额在界面上是元，提交前按文本换算为
// 整数分（parseYuan），服务端再校验。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { del, get, patch, post, type PlanView } from "../lib/api";
import {
  PERIOD_KINDS,
  parseYuan,
  periodKindZh,
  yuan,
  type Coupon,
  type CouponDetail,
  type PeriodKind,
} from "../lib/billing";
import { adminErrorText } from "../lib/admin-errors";
import { datetimeInputIso, fmtDateTime, TZ_LABEL } from "../lib/datetime";
import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { CouponBatchesCard } from "./admin-ops";

const fmt = (s: string | null) => fmtDateTime(s);
const errText = (err: unknown) => (err instanceof Error ? adminErrorText(err) : "失败");

const REDEMPTION_ZH = { reserved: "已预占（待付款）", redeemed: "已使用", released: "已释放" } as const;

/** "8 折" style label of a coupon's value. */
export function couponValue(c: Pick<Coupon, "kind" | "value">): string {
  return c.kind === "percent" ? `减 ${c.value}%` : `减 ¥${yuan(c.value)}`;
}

// datetime-local value, read as Beijing time (W21, M7) -> RFC 3339; "" -> null.
const toIso = datetimeInputIso;

export function AdminCoupons() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <CouponList onSelect={setSelected} />
      <CreateCoupon />
      <CouponBatchesCard />
      {selected && <CouponDetailCard id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CouponList({ onSelect }: { onSelect: (id: string) => void }) {
  const queryClient = useQueryClient();
  const coupons = useQuery({ queryKey: ["coupons"], queryFn: () => get<Coupon[]>("/coupons") });
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const planName = (id: string) => plans.data?.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  async function act(f: () => Promise<unknown>) {
    setError(null);
    try {
      await f();
      await queryClient.invalidateQueries({ queryKey: ["coupons"] });
    } catch (err) {
      setError(errText(err));
    }
  }

  const rows = coupons.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>优惠券</h1>
        </CardTitle>
        <CardDescription>
          优惠按原价计算（折扣向下取整到分），再依次抵扣换套餐余值与余额，应付金额不会为负。优惠码不区分大小写。
          待付款订单会预占次数，订单取消或过期后释放。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <Table label="优惠券列表">
            <TableHeader>
              <TableRow>
                <TableHead>优惠码</TableHead>
                <TableHead>优惠</TableHead>
                <TableHead>适用范围</TableHead>
                <TableHead>有效期</TableHead>
                <TableHead>次数（已用/总数）</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <span className="font-mono">{c.code}</span>
                    {c.name && <span className="ml-1 text-xs text-muted-foreground">{c.name}</span>}
                  </TableCell>
                  <TableCell>
                    {couponValue(c)}
                    {c.min_amount_cents > 0 && (
                      <span className="ml-1 text-xs text-muted-foreground">满 ¥{yuan(c.min_amount_cents)}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {c.plan_ids ? c.plan_ids.map(planName).join("、") : "全部套餐"}
                    {" · "}
                    {c.periods ? c.periods.map((p) => periodKindZh(p)).join("、") : "全部周期"}
                    {c.new_users_only && " · 仅新用户"}
                    {c.per_user_limit != null && ` · 每人 ${c.per_user_limit} 次`}
                  </TableCell>
                  <TableCell className="text-xs">
                    {fmt(c.starts_at)} ～ {fmt(c.ends_at)}
                  </TableCell>
                  <TableCell>
                    {c.used} / {c.max_uses ?? "不限"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.enabled ? "default" : "secondary"}>{c.enabled ? "启用" : "停用"}</Badge>
                  </TableCell>
                  <TableCell className="space-x-1 whitespace-nowrap">
                    <Button size="sm" variant="outline" onClick={() => onSelect(c.id)}>
                      详情
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        if (
                          c.enabled &&
                          !(await confirm({
                            title: `停用优惠码 ${c.code}？`,
                            message: "停用后不能再使用（已预占的待付款订单不受影响），可随时重新启用。",
                            confirmLabel: "停用",
                            destructive: true,
                          }))
                        )
                          return;
                        void act(() => patch(`/coupons/${c.id}`, { enabled: !c.enabled }));
                      }}
                    >
                      {c.enabled ? "停用" : "启用"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `删除优惠码 ${c.code}？`,
                            message: "只能删除从未被订单使用过的优惠码。",
                            confirmLabel: "删除",
                            destructive: true,
                          })
                        )
                          void act(() => del(`/coupons/${c.id}`));
                      }}
                    >
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                    暂无优惠券
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateCoupon() {
  const queryClient = useQueryClient();
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"percent" | "fixed">("percent");
  const [value, setValue] = useState("");
  const [planIds, setPlanIds] = useState<string[]>([]);
  const [periods, setPeriods] = useState<PeriodKind[]>([]);
  const [min, setMin] = useState("");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [perUser, setPerUser] = useState("");
  const [newOnly, setNewOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const optInt = (s: string) => (s.trim() ? Number(s) : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(null);
    let v: number | null;
    if (kind === "percent") {
      v = /^\d{1,3}$/.test(value.trim()) ? Number(value) : null;
      if (v == null || v < 1 || v > 100) return setError("折扣百分比须为 1–100 的整数");
    } else {
      v = parseYuan(value);
      if (v == null) return setError("减免金额无效（元，最多两位小数）");
    }
    const minCents = min.trim() ? parseYuan(min) : 0;
    if (minCents == null) return setError("最低消费无效（元，最多两位小数）");
    for (const [label, s] of [
      ["总次数", maxUses],
      ["每人次数", perUser],
    ]) {
      if (s.trim() && !/^[1-9]\d{0,8}$/.test(s.trim())) return setError(`${label}须为正整数或留空（不限）`);
    }
    setError(null);
    try {
      await post("/coupons", {
        code: code.trim(),
        name: name.trim(),
        kind,
        value: v,
        plan_ids: planIds.length ? planIds : null,
        periods: periods.length ? periods : null,
        min_amount_cents: minCents,
        starts_at: toIso(starts),
        ends_at: toIso(ends),
        max_uses: optInt(maxUses),
        per_user_limit: optInt(perUser),
        new_users_only: newOnly,
      });
      setSaved(`已创建优惠码 ${code.trim()}`);
      setCode("");
      setName("");
      setValue("");
      await queryClient.invalidateQueries({ queryKey: ["coupons"] });
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>新建优惠券</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={submit}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="c-code">优惠码（3–32 位字母、数字、- 或 _）</Label>
              <Input id="c-code" className="w-48" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-name">备注名称</Label>
              <Input id="c-name" className="w-48" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-kind">类型</Label>
              <select
                id="c-kind"
                className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value as "percent" | "fixed")}
              >
                <option value="percent">按比例减免（%）</option>
                <option value="fixed">固定金额减免（元）</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-value">{kind === "percent" ? "减免百分比" : "减免金额（元）"}</Label>
              <Input id="c-value" className="w-28" value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-min">最低消费（元，原价）</Label>
              <Input id="c-min" className="w-28" value={min} onChange={(e) => setMin(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="c-starts">生效时间（{TZ_LABEL}）</Label>
              <Input id="c-starts" type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-ends">失效时间（{TZ_LABEL}）</Label>
              <Input id="c-ends" type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-max">总次数（空 = 不限）</Label>
              <Input id="c-max" className="w-28" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-per">每人次数（空 = 不限）</Label>
              <Input id="c-per" className="w-28" value={perUser} onChange={(e) => setPerUser(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={newOnly} onChange={(e) => setNewOnly(e.target.checked)} />
              仅限新用户（从未付款）
            </label>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">适用套餐（都不选 = 全部）</legend>
            <div className="flex flex-wrap gap-3 text-sm">
              {(plans.data ?? []).map((p) => (
                <label key={p.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={planIds.includes(p.id)}
                    onChange={() => setPlanIds(toggle(planIds, p.id))}
                  />
                  {p.name}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">适用周期（都不选 = 全部）</legend>
            <div className="flex flex-wrap gap-3 text-sm">
              {PERIOD_KINDS.map((k) => (
                <label key={k} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={periods.includes(k)}
                    onChange={() => setPeriods(toggle(periods, k))}
                  />
                  {periodKindZh(k)}
                </label>
              ))}
            </div>
          </fieldset>
          <Button type="submit" size="sm" disabled={!code.trim() || !value.trim()}>
            创建优惠券
          </Button>
          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              {saved}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function CouponDetailCard({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["coupon", id], queryFn: () => get<CouponDetail>(`/coupons/${id}`) });
  const [maxUses, setMaxUses] = useState("");
  const [ends, setEnds] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const c = detail.data?.coupon;
  if (!c) return null;

  async function save() {
    setSaved(false);
    const body: Record<string, unknown> = {};
    if (maxUses.trim() === "-") body.max_uses = null;
    else if (maxUses.trim()) {
      if (!/^[1-9]\d{0,8}$/.test(maxUses.trim())) return setError("总次数须为正整数（输入 - 表示不限）");
      body.max_uses = Number(maxUses);
    }
    if (ends) body.ends_at = toIso(ends);
    if (Object.keys(body).length === 0) return setError("没有要修改的内容");
    setError(null);
    try {
      await patch(`/coupons/${id}`, body);
      setSaved(true);
      setMaxUses("");
      setEnds("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["coupon", id] }),
        queryClient.invalidateQueries({ queryKey: ["coupons"] }),
      ]);
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>优惠券详情「{c.code}」</h2>
        </CardTitle>
        <CardDescription>
          {couponValue(c)} · 已用 {c.used} / {c.max_uses ?? "不限"} · 已付款使用 {c.redeemed} 次
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="d-max">修改总次数（- = 不限）</Label>
            <Input id="d-max" className="w-28" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="d-ends">修改失效时间（{TZ_LABEL}）</Label>
            <Input id="d-ends" type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
          </div>
          <Button size="sm" onClick={() => void save()}>
            保存
          </Button>
        </div>
        {saved && (
          <p role="status" className="text-sm text-muted-foreground">
            已保存
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <Table label="使用记录">
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>订单号</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>优惠</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(detail.data?.redemptions ?? []).map((r) => (
                <TableRow key={r.order_id}>
                  <TableCell>{fmt(r.created_at)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.out_trade_no}</TableCell>
                  <TableCell>{r.user_login}</TableCell>
                  <TableCell>¥{yuan(r.discount_cents)}</TableCell>
                  <TableCell>
                    {REDEMPTION_ZH[r.status]}
                    {r.over_limit && <Badge className="ml-1">超出次数（迟到付款）</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </CardContent>
    </Card>
  );
}
