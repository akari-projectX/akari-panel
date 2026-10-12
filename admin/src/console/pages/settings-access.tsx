// 系统设置 → 管理与安全：后台入口 (SET-06 masked address and prefix rotation,
// SET-07 IP allowlist; owner only, R47 — other admins see it read-only) and
// 数据保留 (the retention days of SET-09; shortening is confirmed on save).
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, RotateCw } from "lucide-react";
import { useState } from "react";
import { post, put } from "../../shared/api";
import { loadPage } from "../../shared/base";
import { useTr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Textarea } from "../../shared/ui/form";
import { useAction } from "../data";
import { CopyButton, Mono } from "../kit";
import { useMe } from "../session";
import { fresh, useAccess, useSettings, type Access, type SettingsView } from "./settings-data";
import {
  DangerZone,
  FieldRow,
  InfoRow,
  Loaded,
  intError,
  intOf,
  lines,
  numText,
  useDraft,
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

function AccessForm({ a }: { a: Access }) {
  const tr = useTr();
  const me = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const [shown, setShown] = useState(false);
  const [rotating, setRotating] = useState(false);
  const owner = me.is_owner;
  const url = a.admin_url ?? `${location.origin}/${a.admin_prefix}/admin`;
  const masked = url.replace(
    a.admin_prefix,
    `${a.admin_prefix.slice(0, 3)}${"•".repeat(Math.max(4, a.admin_prefix.length - 5))}${a.admin_prefix.slice(-2)}`,
  );
  const f = useDraft({ allow: a.admin_allow_cidrs.join("\n") });
  const list = lines(f.value!.allow);
  const selfMissing = list.length > 0 && !!a.your_ip && !list.some((x) => covers(x, a.your_ip!));
  useSavePart({
    count: owner ? f.edited.length : 0,
    errors: 0,
    discard: f.reset,
    save: async () => {
      const ok = await confirm({
        title: list.length
          ? tr(`只允许 ${list.length} 个地址或网段访问后台？`, `Allow only ${list.length} addresses or networks?`)
          : tr("取消 IP 白名单（任意地址可访问后台前缀）？", "Remove the allowlist (any address)?"),
        description: tr(
          `你的地址：${a.your_ip ?? "未知"}。被锁在外面时在服务器上执行：akari settings unset admin-allow`,
          `Your address: ${a.your_ip ?? "unknown"}. Locked out? On the server run: akari settings unset admin-allow`,
        ),
        tone: "warning",
        confirmLabel: tr("确认保存", "Save"),
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
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Group
        title={tr("后台地址", "Console address")}
        footer={
          tr(
            "全站唯一的秘密前缀；门户不会链接到这里。不要把它写进公开的地方。",
            "The site's only secret prefix; the portal never links here. Keep it out of public places.",
          ) +
          (owner
            ? ""
            : tr(
                "前缀与白名单只有所有者能修改，你只能查看。",
                " Only the owner changes the prefix and the allowlist; you can view them.",
              ))
        }
      >
        <InfoRow label={tr("当前地址", "Current address")}>
          <Mono>{shown ? url : masked}</Mono>
          <Button size="sm" variant="ghost" icon={shown ? EyeOff : Eye} onClick={() => setShown((x) => !x)}>
            {shown ? tr("隐藏", "Hide") : tr("显示", "Show")}
          </Button>
          <CopyButton text={url} />
        </InfoRow>
      </Group>
      <Group
        title={tr("IP 白名单", "IP allowlist")}
        footer={tr(
          "白名单外的地址访问后台前缀得到统一的 404。保存时必须包含你自己的地址，否则会被拒绝。",
          "Addresses outside the list get the uniform 404 on the console prefix. It must include your own address or the save is refused.",
        )}
      >
        <FieldRow
          label={tr(
            "后台 IP 白名单（每行一个地址或 CIDR；留空 = 任意地址）",
            "Admin IP allowlist (one address / CIDR per line; empty = any)",
          )}
          description={tr(
            `你的地址：${a.your_ip ?? "未知"}（保存时必须包含它）`,
            `Your address: ${a.your_ip ?? "unknown"} (must be included)`,
          )}
          error={
            owner && f.isEdited("allow") && selfMissing
              ? tr(
                  `白名单不包含你的地址 ${a.your_ip}：保存会被拒绝`,
                  `The list does not include your address ${a.your_ip}: the save will be refused`,
                )
              : undefined
          }
          stack
        >
          {(x) => (
            <Textarea
              {...x}
              rows={4}
              className="font-mono"
              readOnly={!owner}
              value={f.value!.allow}
              onChange={(e) => f.set("allow", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <DangerZone>
        <InfoRow
          label={tr("轮换后台前缀", "Rotate the console prefix")}
          description={tr(
            "旧地址在所有实例上立即失效，新地址只显示一次。",
            "The old address dies at once on every instance; the new one is shown once.",
          )}
        >
          <Button
            size="sm"
            variant="destructive-soft"
            icon={RotateCw}
            disabled={!owner}
            onClick={() => setRotating(true)}
          >
            {tr("轮换前缀…", "Rotate…")}
          </Button>
        </InfoRow>
      </DangerZone>
      {rotating && <RotateDialog a={a} url={url} onClose={() => setRotating(false)} />}
    </>
  );
}

function RotateDialog({ a, url, onClose }: { a: Access; url: string; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const [custom, setCustom] = useState("");
  const c = custom.trim();
  const error =
    c && !/^[A-Za-z0-9_-]{8,64}$/.test(c) ? tr("8–64 位字母、数字、- 或 _", "8–64 of A–Z a–z 0–9 - _") : undefined;
  const rotate = async () => {
    if (error) return;
    const box: { v?: Access } = {};
    const ok = await confirm({
      title: tr("轮换后台前缀？", "Rotate the admin prefix?"),
      impact: tr(
        "旧地址立即失效（所有实例），新地址只显示一次",
        "The old address dies at once on every instance; the new one is shown once",
      ),
      description: tr(`当前：${url}`, `Current: ${url}`),
      typeToConfirm: tr("轮换", "rotate"),
      confirmLabel: tr("轮换", "Rotate"),
      action: async () => {
        box.v = await post<Access>("/settings/access/admin-prefix", {
          version: a.version,
          confirm: true,
          admin_prefix: c || undefined,
        });
      },
    });
    const r = box.v;
    if (!ok || !r) return;
    const next = r.admin_url ?? `${location.origin}/${r.admin_prefix}/admin`;
    await confirm({
      title: tr("新的后台地址", "The new console address"),
      tone: "default",
      details: (
        <div className="flex items-start gap-2 text-body">
          <Mono>{next}</Mono>
          <CopyButton text={next} />
        </div>
      ),
      description: tr("请保存好这个地址；点确认后跳转到新地址。", "Keep this address; confirm to go there."),
      confirmLabel: tr("前往新地址", "Go to it"),
    });
    loadPage(`/${r.admin_prefix}/admin/settings/access`);
  };
  return (
    <Dialog
      open
      size="sm"
      tone="danger"
      icon={RotateCw}
      onClose={onClose}
      title={tr("轮换后台前缀", "Rotate the console prefix")}
      description={tr("留空 = 随机生成。", "Empty = random.")}
      onSubmit={() => void rotate()}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="destructive" disabled={!!error}>
            {tr("轮换前缀", "Rotate prefix")}
          </Button>
        </>
      }
    >
      <Field label={tr("新前缀（留空 = 随机生成）", "New prefix (empty = random)")} error={error}>
        <Input
          data-autofocus
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
      </Field>
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
  const auditError = f.isEdited("audit") ? intError(v.audit, 0, 36500, tr, true) : undefined;
  const trafficError = f.isEdited("traffic")
    ? (intError(v.traffic, 0, 36500, tr, true) ??
      (intOf(v.traffic) !== null && intOf(v.traffic)! > 0 && intOf(v.traffic)! < 32
        ? tr("0（永久）或 32–36500", "0 (forever) or 32–36500")
        : undefined))
    : undefined;
  const eff = (raw: string, def: number) => intOf(raw) ?? def;
  useSavePart({
    count: f.edited.length,
    errors: (auditError ? 1 : 0) + (trafficError ? 1 : 0),
    discard: f.reset,
    save: async () => {
      const shorter: { label: string; from: number; to: number }[] = [];
      const a0 = sec.audit_retention_days.effective;
      const a1 = eff(v.audit, sec.audit_retention_days.default);
      if (keep(a1) < keep(a0)) shorter.push({ label: tr("审计日志", "Audit log"), from: a0, to: a1 });
      const t0 = sec.traffic_daily_retention_days.effective;
      const t1 = eff(v.traffic, sec.traffic_daily_retention_days.default);
      if (keep(t1) < keep(t0)) shorter.push({ label: tr("流量明细", "Traffic history"), from: t0, to: t1 });
      if (shorter.length) {
        const days = (n: number) => (n === 0 ? tr("永久", "forever") : tr(`${n} 天`, `${n} days`));
        const ok = await confirm({
          title: tr("缩短保留期？", "Shorten the retention?"),
          impact: tr(
            "超过新保留期的记录会在下一次清理时删除，不能恢复",
            "Records older than the new period are deleted at the next cleanup and cannot be restored",
          ),
          impacts: shorter.map((x) => ({ label: x.label, value: `${days(x.from)} → ${days(x.to)}` })),
          description: tr(
            "流量明细按整月归并：超过保留期的整月日明细并入月汇总后删除。",
            "Traffic history is rolled up by whole months: daily rows of months past the period are merged into monthly totals and dropped.",
          ),
          confirmLabel: tr("缩短并保存", "Shorten and save"),
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
      f.reset();
      return true;
    },
  });
  return (
    <Group
      title={tr("保留天数", "Days kept")}
      footer={tr("0 = 永久保留；留空 = 默认值。", "0 = forever; empty = the default.")}
    >
      <FieldRow
        label={tr("审计日志保留天数", "Audit log retention (days)")}
        description={tr(
          `0–36500；默认 ${sec.audit_retention_days.default}，当前生效 ${sec.audit_retention_days.effective || "永久"}`,
          `0–36500; default ${sec.audit_retention_days.default}, in effect ${sec.audit_retention_days.effective || "forever"}`,
        )}
        error={auditError}
      >
        {(a) => (
          <Input
            {...a}
            inputMode="numeric"
            className="tnum text-right sm:w-28"
            placeholder={String(sec.audit_retention_days.default)}
            value={v.audit}
            onChange={(e) => f.set("audit", e.target.value)}
          />
        )}
      </FieldRow>
      <FieldRow
        label={tr("流量明细保留天数", "Traffic history retention (days)")}
        description={tr(
          `0 或 32–36500；默认 ${sec.traffic_daily_retention_days.default}，当前生效 ${sec.traffic_daily_retention_days.effective || "永久"}`,
          `0 or 32–36500; default ${sec.traffic_daily_retention_days.default}, in effect ${sec.traffic_daily_retention_days.effective || "forever"}`,
        )}
        error={trafficError}
      >
        {(a) => (
          <Input
            {...a}
            inputMode="numeric"
            className="tnum text-right sm:w-28"
            placeholder={String(sec.traffic_daily_retention_days.default)}
            value={v.traffic}
            onChange={(e) => f.set("traffic", e.target.value)}
          />
        )}
      </FieldRow>
    </Group>
  );
}
