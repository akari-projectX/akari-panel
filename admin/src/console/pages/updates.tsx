// Agent 更新 (UPD-*; v2 updates-*, a pipeline): the fleet's version
// distribution on top, then the work in its order — ① 检查更新 (last
// check, source / auto check / keys read-only with a link to 系统设置 →
// 更新源与验签), ② 发布 (one row per version: platforms, size, signature,
// in use, ⋯ = roll out / delete with its impact; upload dialog with file
// slots and progress), ③ 灰度 (the open rollout inline: progress per
// server, one column per wave, pause / resume / abort with impact; the
// history below; the new-rollout dialog validates field by field and
// confirms "开始升级 N 台" on a second step).
// URL: ?upload=1, ?new=rollout[&version=], ?delete=<version>, ?open=<rollout id>.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock,
  Download,
  FileCheck2,
  FileKey2,
  HeartPulse,
  KeyRound,
  LoaderCircle,
  Package,
  Pause,
  Play,
  Rocket,
  RotateCw,
  Server,
  ShieldCheck,
  Shuffle,
  Square,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError, del, get, post } from "../../shared/api";
import { apiBase } from "../../shared/base";
import { cn } from "../../shared/cn";
import { bytes, dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Select } from "../../shared/ui/form";
import { Banner, KV, PageHeader } from "../../shared/ui/layout";
import { MenuItem, MenuSeparator, RowMenu } from "../../shared/ui/menu";
import { EmptyState, ErrorState, SkeletonRows } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { AsyncButton, CopyText, FixCount } from "../components/kit";
import { RadioCards } from "../components/inputs";
import { useErrText } from "../kit";
import { useQS } from "../router";
import { useServers } from "../servers";
import type { ServerView } from "../types";
import { useUpdateStatus } from "./update-status";

// Kept for pages that still import the badge from here (moved to update-status.tsx).
export { UpdateBadge, useUpdateStatus } from "./update-status";

type Release = {
  id: string;
  version: string;
  os: string;
  arch: string;
  sha256: string;
  size: number;
  key_id: string;
  rollback: boolean;
  complete: boolean;
  created_at: string;
};
type Rollout = {
  id: string;
  version: string;
  status: string;
  waves: number[];
  percentage: number;
  current_wave: number;
  health_timeout_secs: number;
  max_failure_ratio: number;
  halted_reason: string | null;
  created_by: string;
  created_at: string;
  finished_at: string | null;
  counts: Record<string, number>;
};
type RolloutServer = {
  server_id: string;
  name: string;
  wave: number;
  status: string;
  from_version: string | null;
  agent_version: string | null;
  detail: string | null;
  finished_at: string | null;
};

/** Rollouts that still hold their version (the backend refuses deleting it). */
const OPEN = ["running", "paused", "halted"];
const vnum = (v: string) => v.replace(/^v/, "");
const sameV = (a: string | null | undefined, b: string) => !!a && vnum(a) === vnum(b);
const short = (id: string) => id.slice(0, 8);
const serverLink = (id: string) => `/nodes?open=server:${id}`;

/** Compare "0.5.10" > "0.5.9" (numeric parts), newest first. */
function byVersionDesc(a: string, b: string): number {
  const pa = vnum(a).split(/[.-]/);
  const pb = vnum(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const c = (pb[i] ?? "").localeCompare(pa[i] ?? "");
      if (c) return c;
    } else if (x !== y) return y - x;
  }
  return 0;
}

type Version = { version: string; rows: Release[]; complete: boolean; size: number; created_at: string };
function groupReleases(rs: Release[]): Version[] {
  const m = new Map<string, Release[]>();
  for (const r of rs) m.set(r.version, [...(m.get(r.version) ?? []), r]);
  return [...m.entries()]
    .map(([version, rows]) => ({
      version,
      rows,
      complete: rows.some((r) => r.complete),
      size: rows.reduce((a, r) => a + r.size, 0),
      created_at: rows.map((r) => r.created_at).sort()[rows.length - 1],
    }))
    .sort((a, b) => byVersionDesc(a.version, b.version));
}

function useReleases() {
  return useQuery({ queryKey: ["releases"], queryFn: () => get<Release[]>("/agent-releases") });
}
function useRollouts() {
  return useQuery({
    queryKey: ["rollouts"],
    queryFn: () => get<Rollout[]>("/rollouts"),
    refetchInterval: (s) => ((s.state.data ?? []).some((r) => r.status === "running") ? 5000 : 30_000),
  });
}

function rolloutName(s: string, tr: Tr) {
  return (
    (
      {
        running: tr("进行中", "Running"),
        paused: tr("已暂停", "Paused"),
        halted: tr("已停止（失败过多）", "Halted (too many failures)"),
        aborted: tr("已中止", "Aborted"),
        completed: tr("已完成", "Completed"),
      } as Record<string, string>
    )[s] ?? s
  );
}

export function UpdatesPage() {
  const tr = useTr();
  const [query, patch] = useQS();
  const releases = useReleases();
  const versions = groupReleases(releases.data ?? []);
  const delV = query.get("delete");
  return (
    <>
      <PageHeader
        title={tr("Agent 更新", "Agent updates")}
        description={tr(
          "先检查、再发布、最后分批灰度；每台服务器的 agent 版本都在这里",
          "Check, release, then roll out in waves; every server's agent version is here",
        )}
      />
      <Distribution latest={versions.find((v) => v.complete)?.version} />
      <CheckStage />
      <ReleasesStage />
      <RolloutsStage />
      {query.get("upload") && <UploadDialog onClose={() => patch({ upload: null }, true)} />}
      {query.get("new") === "rollout" && (
        <RolloutDialog
          initialVersion={query.get("version") ?? ""}
          onClose={() => patch({ new: null, version: null }, true)}
        />
      )}
      {delV && <DeleteRelease version={delV} onClose={() => patch({ delete: null }, true)} />}
      {query.get("open") && <RolloutDetail id={query.get("open")!} onClose={() => patch({ open: null }, true)} />}
    </>
  );
}

/* ---------- 版本分布 ---------- */

function Distribution({ latest }: { latest: string | undefined }) {
  const tr = useTr();
  const servers = useServers();
  const list = (servers.data ?? []).filter((s) => !s.deleting_at);
  const none = tr("未注册", "Not installed");
  const unknown = tr("未知版本", "Unknown");
  const m = new Map<string, string[]>();
  for (const s of list) {
    const v = !s.enrolled ? none : s.agent_version ? `v${vnum(s.agent_version)}` : unknown;
    m.set(v, [...(m.get(v) ?? []), s.name]);
  }
  const rows = [...m.entries()].sort((a, b) =>
    a[0] === none ? 1 : b[0] === none ? -1 : a[0] === unknown ? 1 : b[0] === unknown ? -1 : byVersionDesc(a[0], b[0]),
  );
  const color = (v: string, i: number) =>
    v === none || v === unknown ? "var(--faint)" : `var(--chart-${(i % 8) + 1})`;
  const enrolled = list.filter((s) => s.enrolled).length;
  const atLatest = latest ? list.filter((s) => s.enrolled && sameV(s.agent_version, latest)).length : 0;
  return (
    <Card className="mb-6 px-4 py-3.5" data-distribution>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-headline font-semibold">{tr("机队版本", "Fleet versions")}</h2>
        {servers.isPending ? (
          <SkeletonRows rows={1} height={20} />
        ) : list.length === 0 ? (
          <span className="text-body text-muted-foreground">{tr("还没有服务器", "No servers yet")}</span>
        ) : latest ? (
          <span className="text-body text-muted-foreground">
            <b className="tnum font-semibold text-foreground">{atLatest}</b>
            {tr(` / ${enrolled} 台已是最新 v${vnum(latest)}`, ` / ${enrolled} on the newest v${vnum(latest)}`)}
          </span>
        ) : (
          <span className="text-body text-muted-foreground">{tr(`${enrolled} 台已注册`, `${enrolled} installed`)}</span>
        )}
      </div>
      {list.length > 0 && (
        <>
          <div className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            {rows.map(([v, names], i) => (
              <div
                key={v}
                title={`${v}: ${names.join(", ")}`}
                className="h-full"
                style={{ width: `${(names.length / list.length) * 100}%`, background: color(v, i) }}
              />
            ))}
          </div>
          <div className="mt-2.5 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-4">
            {rows.map(([v, names], i) => (
              <div key={v} className="flex min-w-0 items-baseline gap-2 text-footnote">
                <span
                  className="size-2 shrink-0 translate-y-[-1px] rounded-full"
                  style={{ background: color(v, i) }}
                  aria-hidden="true"
                />
                <span className="font-semibold whitespace-nowrap">{v}</span>
                <span className="tnum whitespace-nowrap text-muted-foreground">
                  {tr(`${names.length} 台`, `${names.length}`)}
                </span>
                <span className="min-w-0 truncate text-faint">{names.join(tr("、", ", "))}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------- 流水线外壳 ---------- */

function Stage({
  n,
  title,
  desc,
  action,
  children,
  last,
}: {
  n: number;
  title: string;
  desc: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <section className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 sm:grid-cols-[32px_minmax(0,1fr)] sm:gap-x-4">
      <div className="flex flex-col items-center" aria-hidden="true">
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-foreground text-footnote font-semibold text-card sm:size-8">
          {n}
        </span>
        {!last && <span className="mt-1 w-px flex-1 bg-separator" />}
      </div>
      <div className={cn("min-w-0", !last && "pb-8")}>
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 pt-0.5 sm:pt-1">
          <div className="min-w-0 flex-1">
            <h2 className="text-title3 font-semibold tracking-[-0.015em]">{title}</h2>
            <p className="mt-0.5 text-footnote text-muted-foreground">{desc}</p>
          </div>
          {action}
        </div>
        {children}
      </div>
    </section>
  );
}

/* ---------- ① 检查 ---------- */

function CheckStage() {
  const tr = useTr();
  const errText = useErrText();
  const s = useUpdateStatus();
  const [run, busy] = useAction();
  const qc = useQueryClient();
  const d = s.data;
  // A finished check may have stored releases: re-read the list.
  const checkedAt = d?.last_check?.at;
  useEffect(() => {
    if (checkedAt) void qc.invalidateQueries({ queryKey: ["releases"] });
  }, [checkedAt, qc]);
  // How long the running check has waited (the status polls every 2 s meanwhile).
  const [since, setSince] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!d?.checking) {
      setSince(null);
      return;
    }
    setSince((x) => x ?? Date.now());
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [d?.checking]);
  const last = d?.last_check;
  const checking = !!d?.checking || busy;
  const lastError =
    last && !last.ok
      ? last.code
        ? errText(new ApiError(400, last.message ?? last.code, { code: last.code, params: last.params ?? {} }))
        : tr("检查失败", "Check failed")
      : null;
  return (
    <Stage
      n={1}
      title={tr("检查更新", "Check for updates")}
      desc={tr(
        "从发布源拉取新版本，验签通过后自动加入发布列表；不会自动开始灰度",
        "Fetches new versions from the source and adds them after verifying; never starts a rollout",
      )}
      action={
        d && (
          <Button
            variant="primary"
            icon={checking ? undefined : RotateCw}
            loading={checking}
            disabled={!d.keys_configured || checking}
            onClick={() => void run(() => post("/agent-updates/check"))}
          >
            {checking ? tr("正在检查…", "Checking…") : tr("立即检查", "Check now")}
          </Button>
        )
      }
    >
      {d && !d.keys_configured && (
        <Banner
          tone="warning"
          icon={<KeyRound />}
          title={tr("没有发布公钥，不能检查更新。", "No release key: updates cannot be checked.")}
          className="mb-3"
          action={
            <Button size="sm" variant="outline" asChild>
              <Link to="/settings/updates">{tr("去添加公钥", "Add a key")}</Link>
            </Button>
          }
        >
          {tr(
            "不验签就无法确认新版本来自你信任的发布者。",
            "Without verifying, a new version cannot be traced to a publisher you trust.",
          )}
        </Banner>
      )}
      {s.isError && !d ? (
        <Card>
          <ErrorState
            compact
            title={tr("读取更新状态失败", "The update status did not load")}
            error={s.error}
            onRetry={() => void s.refetch()}
          />
        </Card>
      ) : !d ? (
        <Card>
          <SkeletonRows rows={3} />
        </Card>
      ) : (
        <Card className="grid grid-cols-1 divide-separator overflow-hidden sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] sm:divide-x max-sm:divide-y">
          <div className="px-4 py-3" data-last-check>
            <div className="text-footnote text-muted-foreground">{tr("上次检查", "Last check")}</div>
            {d.checking ? (
              <div className="mt-1 flex items-center gap-2 text-body" role="status">
                <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden="true" />
                {tr("正在连接发布源…", "Contacting the source…")}
                {since &&
                  tr(
                    ` 已等待 ${Math.round((Date.now() - since) / 1000)} 秒`,
                    ` ${Math.round((Date.now() - since) / 1000)} s`,
                  )}
              </div>
            ) : last ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-body">
                <span className="tnum">{dateTime(last.at)}</span>
                {last.ok ? (
                  last.result === "stored" ? (
                    <Badge tone="primary">
                      <Download aria-hidden="true" />
                      {tr(
                        `已保存 ${last.version}（${last.stored.join(", ")}）`,
                        `Stored ${last.version} (${last.stored.join(", ")})`,
                      )}
                    </Badge>
                  ) : (
                    <Badge tone="success">
                      <Check aria-hidden="true" />
                      {tr("已是最新", "Up to date")}
                    </Badge>
                  )
                ) : (
                  <Badge tone="danger">
                    <X aria-hidden="true" />
                    {tr("检查失败", "Check failed")}
                  </Badge>
                )}
              </div>
            ) : (
              <div className="mt-1 text-body text-muted-foreground">{tr("从未检查", "Never")}</div>
            )}
            {lastError && last?.message ? (
              <div className="mt-1.5 rounded-md bg-destructive-soft/60 px-2 py-1.5 text-footnote">
                <span className="text-destructive">{lastError}</span>
                <details className="mt-0.5 text-muted-foreground">
                  <summary className="cursor-default text-faint">{tr("原始错误", "Raw error")}</summary>
                  <code className="mt-1 block font-mono text-caption break-all">{last.message}</code>
                </details>
              </div>
            ) : (
              <div className="mt-1 text-footnote text-faint">
                {d.latest
                  ? tr(
                      `最新发布 ${d.latest.version}（${d.latest.platforms.join(", ")}）；${d.outdated_servers} 台服务器较旧`,
                      `Newest release ${d.latest.version} (${d.latest.platforms.join(", ")}); ${d.outdated_servers} servers older`,
                    )
                  : tr("还没有发布", "No release yet")}
              </div>
            )}
          </div>
          <dl className="grid min-w-0 gap-1.5 px-4 py-3 text-footnote">
            <div className="flex items-center gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">{tr("发布源", "Source")}</dt>
              <dd className="min-w-0 flex-1">
                <CopyText value={d.source_url ?? d.default_source_url} className="max-w-full" />
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">{tr("自动检查", "Auto check")}</dt>
              <dd>
                {!d.auto_check
                  ? tr("关闭", "Off")
                  : !d.keys_configured
                    ? tr("已暂停（缺少公钥）", "Paused (no key)")
                    : tr(
                        `开启 · 每 6 小时 · 下次 ${dateTime(d.next_auto_check_at)}`,
                        `On · every 6 h · next ${dateTime(d.next_auto_check_at)}`,
                      )}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">{tr("验签公钥", "Keys")}</dt>
              <dd>
                {d.keys_configured ? (
                  tr("已配置", "Configured")
                ) : (
                  <span className="text-warning">{tr("未配置", "None")}</span>
                )}
              </dd>
            </div>
            <dd>
              <Link to="/settings/updates" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                {tr("在 系统设置 → 更新源与验签 修改", "Change in Settings → Source and keys")}
                <ArrowRight className="size-3" aria-hidden="true" />
              </Link>
            </dd>
          </dl>
        </Card>
      )}
    </Stage>
  );
}

/* ---------- ② 发布 ---------- */

function ReleasesStage() {
  const tr = useTr();
  const [, patch] = useQS();
  const q = useReleases();
  const rollouts = useRollouts();
  const servers = useServers();
  const versions = groupReleases(q.data ?? []);
  const newest = versions.find((v) => v.complete)?.version;
  const open = (rollouts.data ?? []).find((r) => OPEN.includes(r.status));
  const upload = (
    <Button variant="outline" icon={Upload} onClick={() => patch({ upload: "1" })}>
      {tr("上传发布", "Upload a release")}
    </Button>
  );
  return (
    <Stage
      n={2}
      title={tr("发布", "Releases")}
      desc={tr(
        "可用于升级的 agent 版本；都已用发布公钥验签，带二进制的才能用来灰度",
        "Agent versions to update to; all verified, those with a binary can be rolled out",
      )}
      action={upload}
    >
      <Card className="overflow-hidden">
        {q.isPending ? (
          <SkeletonRows rows={3} height={64} />
        ) : q.isError && !q.data ? (
          <ErrorState
            compact
            title={tr("发布列表加载失败", "Releases did not load")}
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        ) : versions.length === 0 ? (
          <EmptyState
            icon={Upload}
            title={tr("还没有发布", "No releases yet")}
            description={tr(
              "点「立即检查」从发布源拉取，或手动上传清单、签名和二进制。",
              "Use “Check now” to fetch from the source, or upload a manifest, signature and binary.",
            )}
            action={upload}
          />
        ) : (
          <ul className="divide-y divide-separator">
            {versions.map((v) => {
              const inUse = open && open.version === v.version;
              const running = (servers.data ?? []).filter((s) => sameV(s.agent_version, v.version)).length;
              return (
                <li key={v.version} className="flex items-start gap-3 px-4 py-3" data-release={v.version}>
                  <span
                    className={cn(
                      "mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4",
                      v.complete ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
                    )}
                    aria-hidden="true"
                  >
                    {v.complete ? <ShieldCheck /> : <AlertTriangle />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-callout font-semibold">{v.version}</span>
                      {v.version === newest && <Badge tone="primary">{tr("最新", "Newest")}</Badge>}
                      {inUse && (
                        <Badge tone="info">
                          <Rocket aria-hidden="true" />
                          {tr(`灰度 #${short(open.id)} 使用中`, `Rollout #${short(open.id)} uses it`)}
                        </Badge>
                      )}
                      {v.rows.some((r) => r.rollback) && <Badge tone="warning">{tr("回滚版", "Rollback")}</Badge>}
                      <Badge tone="success">
                        <Check aria-hidden="true" />
                        {tr("签名已验证", "Signature verified")}
                      </Badge>
                      {!v.complete && <Badge tone="warning">{tr("缺二进制", "No binary")}</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-footnote text-muted-foreground">
                      <span>
                        {v.rows
                          .map((r) => `${r.os}/${r.arch}${r.complete ? "" : tr("（缺二进制）", " (no binary)")}`)
                          .join(" · ")}
                      </span>
                      <span className="tnum">{bytes(v.size)}</span>
                      <span>{dateTime(v.created_at)}</span>
                      <span className="font-mono">{tr(`公钥 ${v.rows[0].key_id}`, `key ${v.rows[0].key_id}`)}</span>
                      <span className="tnum font-medium text-foreground/80">
                        {running ? tr(`${running} 台在用`, `${running} running it`) : tr("无服务器在用", "Not running")}
                      </span>
                    </div>
                  </div>
                  <RowMenu label={tr(`${v.version} 的操作`, `Actions for ${v.version}`)}>
                    {() => (
                      <>
                        <MenuItem
                          icon={Rocket}
                          disabled={!v.complete || !!open}
                          onClick={() => patch({ new: "rollout", version: v.version })}
                        >
                          {tr("用这个版本灰度", "Roll out this version")}
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem icon={Trash2} danger onClick={() => patch({ delete: v.version })}>
                          {tr("删除发布…", "Delete the release…")}
                        </MenuItem>
                      </>
                    )}
                  </RowMenu>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Stage>
  );
}

/** The delete confirmation for a whole version (every platform). */
function DeleteRelease({ version, onClose }: { version: string; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const releases = useReleases();
  const rollouts = useRollouts();
  const servers = useServers();
  const ready = releases.data && rollouts.data && servers.data;
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    const rows = (releases.data ?? []).filter((r) => r.version === version);
    if (rows.length === 0) {
      onClose();
      return;
    }
    const using = (rollouts.data ?? []).find((r) => r.version === version && OPEN.includes(r.status));
    const running = (servers.data ?? []).filter((s) => sameV(s.agent_version, version)).length;
    void confirm({
      title: tr(`删除发布 ${version}？`, `Delete release ${version}?`),
      description: using
        ? tr(
            `灰度 #${short(using.id)} 正在使用这个版本：先中止它，否则面板会拒绝删除。`,
            `Rollout #${short(using.id)} uses this version: abort it first or the panel refuses.`,
          )
        : tr(
            "删除后不能再用它灰度，一键安装也改用其他版本；已经在运行这个版本的服务器不受影响。可以重新检查更新或手动上传。",
            "It can no longer be rolled out and installs use another version; servers running it are not affected. Check again or upload to restore.",
          ),
      impacts: [
        {
          label: tr("进行中的灰度", "Open rollout"),
          value: using ? (
            <span className="text-destructive">
              {tr(`#${short(using.id)}（须先中止）`, `#${short(using.id)} (abort first)`)}
            </span>
          ) : (
            tr("没有未结束的灰度使用这个版本", "No open rollout uses this version")
          ),
        },
        {
          label: tr("正在运行此版本", "Running this version"),
          value: tr(`${running} 台（不受影响）`, `${running} (not affected)`),
        },
        {
          label: tr("文件", "Files"),
          value: tr(
            `${rows.length} 个平台 · ${bytes(rows.reduce((a, r) => a + r.size, 0))}`,
            `${rows.length} platform(s) · ${bytes(rows.reduce((a, r) => a + r.size, 0))}`,
          ),
        },
      ],
      typeToConfirm: version,
      confirmLabel: tr("删除发布", "Delete the release"),
      action: async () => {
        for (const r of rows) await del(`/agent-releases/${r.id}`);
      },
    }).then((ok) => {
      if (ok) toast({ tone: "success", title: tr(`已删除 ${version}`, `Deleted ${version}`) });
      onClose();
    });
  }, [ready, releases.data, rollouts.data, servers.data, version, confirm, tr, toast, onClose]);
  return null;
}

/** PUT a binary with upload progress (fetch has none); errors as ApiError. */
function putWithProgress(path: string, file: Blob, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", `${apiBase}${path}`);
    x.withCredentials = true;
    x.setRequestHeader("content-type", "application/octet-stream");
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(x.responseText) as Record<string, unknown>;
      } catch {
        /* not JSON */
      }
      reject(new ApiError(x.status, typeof body.error === "string" ? body.error : x.statusText, body));
    };
    x.onerror = () => reject(new ApiError(0, "network error", { code: "" }));
    x.send(file);
  });
}

function FileSlot({
  icon,
  label,
  hint,
  file,
  accept,
  onPick,
  progress,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  file: File | null;
  accept?: string;
  onPick: (f: File | null) => void;
  progress?: ReactNode;
  disabled?: boolean;
}) {
  const tr = useTr();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 ring-1 ring-inset",
        file ? "bg-card ring-border" : "border border-dashed border-input bg-window ring-transparent",
      )}
    >
      <span
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4",
          file ? "bg-success-soft text-success" : "bg-secondary text-muted-foreground",
        )}
        aria-hidden="true"
      >
        {file ? <CheckCircle2 /> : icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium">{label}</div>
        {file ? (
          <div className="truncate font-mono text-caption text-muted-foreground">
            {file.name} · {bytes(file.size)}
          </div>
        ) : (
          <div className="text-footnote text-faint">{hint}</div>
        )}
        {progress}
      </div>
      <input
        ref={ref}
        type="file"
        accept={accept}
        aria-label={label}
        className="sr-only"
        tabIndex={-1}
        disabled={disabled}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      {!progress && (
        <Button size="sm" variant={file ? "ghost" : "outline"} disabled={disabled} onClick={() => ref.current?.click()}>
          {file ? tr("更换", "Change") : tr("选择文件", "Choose file")}
        </Button>
      )}
    </div>
  );
}

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div className="mt-1.5 flex items-center gap-2" role="progressbar" aria-label={label} aria-valuenow={value}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${value}%` }} />
      </div>
      <span className="tnum text-caption text-muted-foreground">{value}%</span>
    </div>
  );
}

function UploadDialog({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const toast = useToast();
  const errText = useErrText();
  const qc = useQueryClient();
  const [manifest, setManifest] = useState<File | null>(null);
  const [sig, setSig] = useState<File | null>(null);
  const [binary, setBinary] = useState<File | null>(null);
  const [stage, setStage] = useState<null | "verify" | number>(null);
  const [error, setError] = useState<unknown>(null);
  const busy = stage !== null;
  const missing = [manifest, sig, binary].filter((x) => !x).length;
  const upload = async () => {
    if (!manifest || !sig || !binary || busy) return;
    setError(null);
    setStage("verify");
    try {
      let sigJson: unknown;
      try {
        sigJson = JSON.parse(await sig.text());
      } catch {
        throw new Error(tr("签名文件不是有效的 JSON（.sig）", "The signature file is not valid JSON (.sig)"));
      }
      const created = await post<Release>("/agent-releases", { manifest: await manifest.text(), sig: sigJson });
      setStage(0);
      await putWithProgress(`/agent-releases/${created.id}/binary`, binary, setStage);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["releases"] }),
        qc.invalidateQueries({ queryKey: ["agent-updates"] }),
      ]);
      toast({ tone: "success", title: tr(`已上传 ${created.version}`, `Uploaded ${created.version}`) });
      onClose();
    } catch (e) {
      setError(e);
      void qc.invalidateQueries({ queryKey: ["releases"] });
    } finally {
      setStage(null);
    }
  };
  const verified = stage !== null && stage !== "verify";
  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      size="md"
      icon={Upload}
      title={tr("上传 agent 发布", "Upload an agent release")}
      description={tr(
        "一个平台的清单、签名和二进制。先验签，通过才会出现在发布列表里。",
        "One platform's manifest, signature and binary. Verified first; only then listed.",
      )}
      dirty={!!(manifest || sig || binary) && !busy}
      onSubmit={() => void upload()}
      footer={
        <>
          <span className="mr-auto text-footnote text-muted-foreground" role="status">
            {missing
              ? tr(`还差 ${missing} 个文件`, `${missing} file(s) missing`)
              : busy
                ? tr("上传中，请勿关闭", "Uploading, keep this open")
                : tr("签名会用已配置的发布公钥校验", "Checked with the configured release keys")}
          </span>
          <Button onClick={onClose} disabled={busy}>
            {tr("取消", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!!missing}>
            {busy ? tr("上传中…", "Uploading…") : tr("上传并验签", "Upload and verify")}
          </Button>
        </>
      }
    >
      <div className="grid gap-2">
        <FileSlot
          icon={<FileCheck2 />}
          label={tr("清单（manifest）", "Manifest")}
          hint={tr("版本号、平台、文件的 SHA-256", "Version, platform, the file's SHA-256")}
          accept=".json"
          file={manifest}
          onPick={setManifest}
          disabled={busy}
          progress={
            busy ? (
              stage === "verify" ? (
                <div className="mt-1 text-caption text-muted-foreground">{tr("正在验签…", "Verifying…")}</div>
              ) : (
                <Bar value={100} label={tr("清单", "Manifest")} />
              )
            ) : undefined
          }
        />
        <FileSlot
          icon={<FileKey2 />}
          label={tr("签名", "Signature")}
          hint={tr("用发布私钥对清单的 Ed25519 签名（.sig）", "Ed25519 signature of the manifest (.sig)")}
          accept=".sig"
          file={sig}
          onPick={setSig}
          disabled={busy}
          progress={busy && verified ? <Bar value={100} label={tr("签名", "Signature")} /> : undefined}
        />
        <FileSlot
          icon={<Package />}
          label={tr("二进制", "Binary")}
          hint={tr("必须与清单里的哈希一致", "Must match the manifest's hash")}
          file={binary}
          onPick={setBinary}
          disabled={busy}
          progress={
            busy ? (
              <Bar value={typeof stage === "number" ? stage : 0} label={tr("上传进度", "Upload progress")} />
            ) : undefined
          }
        />
      </div>
      {error ? (
        <Banner tone="danger" icon={<X />} title={tr("上传失败：", "Upload failed:")} className="mt-3">
          {error instanceof ApiError ? errText(error) : (error as Error).message}
        </Banner>
      ) : null}
    </Dialog>
  );
}

/* ---------- ③ 灰度 ---------- */

const RS: Record<string, { zh: string; en: string; icon: ReactNode; cls: string }> = {
  healthy: { zh: "已升级", en: "Updated", icon: <CheckCircle2 />, cls: "bg-success-soft text-success" },
  updating: {
    zh: "升级中",
    en: "Updating",
    icon: <LoaderCircle className="animate-spin" />,
    cls: "bg-primary-soft text-primary",
  },
  offered: { zh: "已下发", en: "Offered", icon: <HeartPulse />, cls: "bg-info-soft text-info" },
  pending: { zh: "等待", en: "Waiting", icon: <Clock />, cls: "bg-secondary text-muted-foreground" },
  failed: { zh: "失败", en: "Failed", icon: <XCircle />, cls: "bg-destructive-soft text-destructive" },
  skipped: { zh: "已跳过", en: "Skipped", icon: <CircleSlash />, cls: "bg-warning-soft text-warning" },
};

function useRolloutDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["rollouts", id],
    queryFn: () => get<Rollout & { servers: RolloutServer[] }>(`/rollouts/${id}`),
    enabled: !!id,
    refetchInterval: (s) => (s.state.data && !OPEN.includes(s.state.data.status) ? false : 5000),
  });
}

function RolloutsStage() {
  const tr = useTr();
  const [, patch] = useQS();
  const q = useRollouts();
  const open = (q.data ?? []).find((r) => OPEN.includes(r.status));
  const history = (q.data ?? []).filter((r) => !OPEN.includes(r.status));
  const releases = useReleases();
  const servers = useServers();
  const newest = groupReleases(releases.data ?? []).find((v) => v.complete)?.version;
  const behind = newest
    ? (servers.data ?? []).filter((s) => s.enrolled && !s.deleting_at && !sameV(s.agent_version, newest)).length
    : 0;
  const create = (
    <Button
      variant="primary"
      icon={Rocket}
      disabled={!!open}
      title={open ? tr("已有进行中的灰度", "A rollout is open") : undefined}
      onClick={() => patch({ new: "rollout" })}
    >
      {tr("新建灰度", "New rollout")}
    </Button>
  );
  return (
    <Stage
      n={3}
      last
      title={tr("灰度", "Rollouts")}
      desc={tr(
        "分批升级：每批升级后等健康检查通过再继续；失败比例超过上限自动停止",
        "In waves: each waits for the health check; stops by itself above the failure ratio",
      )}
      action={create}
    >
      {open && (
        <p className="-mt-1 mb-2 text-footnote text-faint">
          {tr(
            "同一时间只能有一个灰度；当前这个结束或中止后才能新建。",
            "One rollout at a time; finish or abort this one to start another.",
          )}
        </p>
      )}
      {q.isPending ? (
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      ) : q.isError && !q.data ? (
        <Card>
          <ErrorState
            compact
            title={tr("灰度状态加载失败", "Rollouts did not load")}
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        </Card>
      ) : open ? (
        <ActiveRollout r={open} />
      ) : (
        <Card>
          <EmptyState
            icon={Rocket}
            title={tr("没有进行中的灰度", "No rollout running")}
            description={
              newest
                ? tr(`还有 ${behind} 台服务器不是 ${newest}。`, `${behind} servers are not on ${newest}.`)
                : tr("先有一个带二进制的发布，才能灰度。", "A release with a binary is needed first.")
            }
            action={newest ? create : undefined}
          />
        </Card>
      )}
      <h3 className="mt-5 mb-2 px-1 text-footnote font-semibold text-muted-foreground">{tr("历史", "History")}</h3>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <SkeletonRows rows={3} />
        ) : history.length === 0 ? (
          <p className="px-4 py-6 text-center text-body text-muted-foreground">
            {tr("还没有结束的灰度。", "No finished rollouts yet.")}
          </p>
        ) : (
          <ul className="divide-y divide-separator">
            {history.map((h) => {
              const total = Object.values(h.counts).reduce((a, b) => a + b, 0);
              const ok = h.status === "completed";
              return (
                <li key={h.id} data-rollout={h.id}>
                  <button
                    type="button"
                    onClick={() => patch({ open: h.id })}
                    className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent"
                  >
                    <span
                      className={cn(
                        "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-3.5",
                        ok ? "bg-success-soft text-success" : "bg-destructive-soft text-destructive",
                      )}
                      aria-hidden="true"
                    >
                      {ok ? <Check /> : <CircleDashed />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-body font-medium">
                        #{short(h.id)} {h.version} ·{" "}
                        {ok
                          ? tr(`完成，${total} 台`, `completed, ${total} servers`)
                          : tr(
                              `${rolloutName(h.status, tr)}，${total} 台中 ${h.counts.failed ?? 0} 台失败`,
                              `${rolloutName(h.status, tr)}, ${h.counts.failed ?? 0} of ${total} failed`,
                            )}
                      </div>
                      <div className="text-footnote text-muted-foreground">
                        {dateTime(h.created_at)} – {dateTime(h.finished_at)} · {h.created_by}
                      </div>
                      {h.halted_reason && (
                        <div className="mt-0.5 text-footnote break-words text-destructive">{h.halted_reason}</div>
                      )}
                    </div>
                    <ArrowRight className="mt-1 size-4 shrink-0 text-faint" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Stage>
  );
}

function ServerStateChip({ s }: { s: string }) {
  const tr = useTr();
  const st = RS[s] ?? { zh: s, en: s, icon: <Server />, cls: "bg-secondary text-muted-foreground" };
  return (
    <span
      className={cn(
        "mt-px inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-caption font-medium [&_svg]:size-3",
        st.cls,
      )}
    >
      {st.icon}
      {tr(st.zh, st.en)}
    </span>
  );
}

function ActiveRollout({ r }: { r: Rollout }) {
  const tr = useTr();
  const confirm = useConfirm();
  const [run] = useAction();
  const q = useRolloutDetail(r.id);
  const d = q.data;
  const list = d?.servers ?? [];
  const c = d?.counts ?? r.counts;
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const done = (c.healthy ?? 0) + (c.skipped ?? 0);
  const moving = (c.offered ?? 0) + (c.updating ?? 0);
  const paused = r.status === "paused";
  const halted = r.status === "halted";
  const act = (what: "pause" | "resume") =>
    run(() => post(`/rollouts/${r.id}/${what}`), {
      ok: what === "pause" ? tr("已暂停", "Paused") : tr("已继续", "Resumed"),
    });
  const abort = () =>
    confirm({
      title: tr(`中止灰度 #${short(r.id)}？`, `Abort rollout #${short(r.id)}?`),
      description: tr(
        "正在升级的那台会完成本次升级，其余的不再升级。已升级的服务器不会回退。中止后不能继续。",
        "The server updating now finishes; the rest are not updated. Updated servers keep the new version. Cannot be resumed.",
      ),
      impacts: [
        { label: tr(`已升级（保持 ${r.version}）`, `Updated (keep ${r.version})`), value: c.healthy ?? 0 },
        { label: tr("正在升级 / 健康检查", "Updating / health check"), value: moving },
        { label: tr("不再升级", "Not updated"), value: c.pending ?? 0 },
      ],
      tone: "danger",
      confirmLabel: tr("中止灰度", "Abort the rollout"),
      action: () => post(`/rollouts/${r.id}/abort`),
    });
  return (
    <Card className="overflow-hidden" data-active-rollout>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3.5 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-headline font-semibold">
              {tr(`#${short(r.id)} 升级到 ${r.version}`, `#${short(r.id)} to ${r.version}`)}
            </span>
            {paused ? (
              <Badge tone="warning">
                <Pause aria-hidden="true" />
                {tr("已暂停", "Paused")}
              </Badge>
            ) : halted ? (
              <Badge tone="danger">
                <AlertTriangle aria-hidden="true" />
                {rolloutName("halted", tr)}
              </Badge>
            ) : (
              <Badge tone="primary">
                <LoaderCircle className="animate-spin" aria-hidden="true" />
                {tr(
                  `进行中 · 第 ${r.current_wave + 1}/${r.waves.length} 批`,
                  `Running · wave ${r.current_wave + 1}/${r.waves.length}`,
                )}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-footnote text-muted-foreground">
            {tr(
              `${r.created_by} · ${dateTime(r.created_at)} 开始 · 健康超时 ${Math.round(r.health_timeout_secs / 60)} 分钟 · 失败超过 ${Math.round(r.max_failure_ratio * 100)}% 自动停止`,
              `${r.created_by} · started ${dateTime(r.created_at)} · health timeout ${Math.round(r.health_timeout_secs / 60)} min · stops above ${Math.round(r.max_failure_ratio * 100)}% failed`,
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {r.status === "running" && (
            <AsyncButton variant="outline" size="sm" icon={Pause} onClick={() => act("pause")}>
              {tr("暂停", "Pause")}
            </AsyncButton>
          )}
          {(paused || halted) && (
            <AsyncButton variant="primary" size="sm" icon={Play} onClick={() => act("resume")}>
              {tr("继续", "Resume")}
            </AsyncButton>
          )}
          <Button variant="destructive-soft" size="sm" icon={Square} onClick={() => void abort()}>
            {tr("中止", "Abort")}
          </Button>
        </div>
      </div>
      {r.halted_reason && (
        <div className="mx-4 mb-3 rounded-lg bg-destructive-soft/60 px-3 py-2 text-footnote break-words">
          <span className="font-medium text-destructive">
            {tr("失败过多，已自动停止：", "Stopped, too many failures: ")}
          </span>
          {r.halted_reason}
        </div>
      )}
      <div className="px-4 pb-3">
        <div className="mb-1 flex justify-between text-footnote text-muted-foreground">
          <span>
            <b className="tnum text-foreground">{c.healthy ?? 0}</b>
            {tr(` / ${total} 台已升级`, ` / ${total} updated`)}
          </span>
          <span className="tnum">{total ? Math.round((done / total) * 100) : 0}%</span>
        </div>
        <div className="flex h-2 gap-0.5" aria-hidden="true">
          {(list.length ? list.map((s) => s.status) : Array.from({ length: total }, () => "pending")).map((s, i) => (
            <span
              key={i}
              className={cn(
                "flex-1 first:rounded-l-full last:rounded-r-full",
                s === "healthy"
                  ? "bg-success"
                  : s === "updating" || s === "offered"
                    ? "bg-primary/60"
                    : s === "skipped"
                      ? "bg-warning/60"
                      : s === "failed"
                        ? "bg-destructive"
                        : "bg-secondary",
              )}
            />
          ))}
        </div>
      </div>
      {q.isError && !d ? (
        <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
      ) : !d ? (
        <SkeletonRows rows={3} />
      ) : (
        <div className="grid gap-px border-t border-separator bg-separator md:grid-cols-3">
          {r.waves.map((pct, w) => {
            const inWave = list.filter((s) => s.wave === w);
            const cur = w === r.current_wave;
            return (
              <div
                key={w}
                className={cn(
                  "bg-card px-4 py-3",
                  cur && "bg-[color-mix(in_srgb,var(--primary-soft),var(--card)_40%)]",
                )}
              >
                <div className="mb-2 flex items-center gap-1.5 text-footnote font-semibold">
                  {tr(`第 ${w + 1} 批`, `Wave ${w + 1}`)}
                  <span className="font-normal text-muted-foreground">
                    {tr(`累计 ${pct}%`, `${pct}% cumulative`)} ·{" "}
                    {w < r.current_wave
                      ? tr("已完成", "done")
                      : cur
                        ? paused
                          ? tr("已暂停", "paused")
                          : tr("进行中", "running")
                        : tr("等待", "waiting")}
                  </span>
                </div>
                {inWave.length === 0 ? (
                  <p className="text-footnote text-faint">{tr("这一批没有服务器", "No servers in this wave")}</p>
                ) : (
                  <ul className="grid gap-1.5">
                    {inWave.map((s) => (
                      <li key={s.server_id}>
                        <Link
                          to={serverLink(s.server_id)}
                          className="flex items-start gap-2 rounded-md hover:bg-accent"
                        >
                          <ServerStateChip s={s.status} />
                          <span className="min-w-0">
                            <span className="block truncate text-body">{s.name}</span>
                            <span className="block truncate text-caption text-muted-foreground">
                              {s.detail ?? `${s.from_version ?? "?"} → ${r.version}`}
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** A finished rollout's details (?open=): parameters and every server. */
function RolloutDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const q = useRolloutDetail(id);
  const r = q.data;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={Rocket}
      title={r ? tr(`灰度 ${r.version}`, `Rollout ${r.version}`) : tr("灰度", "Rollout")}
      description={
        r &&
        `#${short(r.id)} · ${rolloutName(r.status, tr)} · ${r.created_by} · ${dateTime(r.created_at)}${r.finished_at ? ` – ${dateTime(r.finished_at)}` : ""}`
      }
      footer={<Button onClick={onClose}>{tr("关闭", "Close")}</Button>}
    >
      {q.isPending ? (
        <SkeletonRows rows={5} />
      ) : q.isError && !r ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : r ? (
        <div className="grid gap-3">
          {r.halted_reason && (
            <Banner tone="danger" title={tr("失败过多，已自动停止：", "Stopped, too many failures:")}>
              {r.halted_reason}
            </Banner>
          )}
          <KV
            cols={2}
            items={[
              { k: tr("批次（累计 %）", "Waves (cumulative %)"), v: r.waves.join(" → ") },
              { k: tr("覆盖比例", "Coverage"), v: `${r.percentage}%` },
              {
                k: tr("健康超时", "Health timeout"),
                v: tr(`${r.health_timeout_secs} 秒`, `${r.health_timeout_secs} s`),
              },
              { k: tr("最大失败比例", "Max failure ratio"), v: `${Math.round(r.max_failure_ratio * 100)}%` },
            ]}
          />
          {r.servers.length === 0 ? (
            <EmptyState icon={Server} title={tr("没有服务器", "No servers")} />
          ) : (
            <ul className="divide-y divide-separator overflow-hidden rounded-lg bg-window">
              {r.servers.map((s) => (
                <li key={s.server_id} className="flex items-start gap-2 px-3 py-2 text-body">
                  <ServerStateChip s={s.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-all">{s.name}</span>
                      <span className="text-footnote text-muted-foreground">
                        {tr(`第 ${s.wave + 1} 批`, `wave ${s.wave + 1}`)} · {s.from_version ?? "?"} →{" "}
                        {s.agent_version ?? "?"}
                      </span>
                    </div>
                    {s.detail && <p className="text-footnote break-words text-muted-foreground">{s.detail}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

/** Whole numbers in [lo, hi] from the raw text (null = invalid). */
function intIn(text: string, lo: number, hi: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const v = Number(text.trim());
  return v >= lo && v <= hi ? v : null;
}

function RolloutDialog({ initialVersion, onClose }: { initialVersion: string; onClose: () => void }) {
  const tr = useTr();
  const toast = useToast();
  const [run, busy] = useAction();
  const releases = useReleases();
  const servers = useServers();
  const versions = groupReleases(releases.data ?? []).filter((v) => v.complete);
  const [version, setVersion] = useState(initialVersion);
  const [mode, setMode] = useState<"pct" | "pick">("pct");
  const [pct, setPct] = useState("100");
  const [batches, setBatches] = useState("3");
  const [timeoutM, setTimeoutM] = useState("10");
  const [ratio, setRatio] = useState("20");
  const [picked, setPicked] = useState<string[]>([]);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [tried, setTried] = useState(false);
  const [step, setStep] = useState<"form" | "confirm">("form");
  const first = versions[0]?.version ?? "";
  useEffect(() => {
    if (!version && first) setVersion(first);
  }, [version, first]);
  // Eligible = enrolled, not being deleted (rollout.rs create).
  const eligible = (servers.data ?? []).filter((s) => s.enrolled && !s.deleting_at);
  const candidates = eligible.filter((s) => !sameV(s.agent_version, version));
  const errs = {
    version: !version ? tr("先选一个带二进制的发布", "Pick a release with a binary") : null,
    pct: mode === "pct" && intIn(pct, 1, 100) === null ? tr("填 1–100 之间的整数", "A whole number 1–100") : null,
    pick: mode === "pick" && picked.length === 0 ? tr("至少选一台", "Pick at least one") : null,
    batches: intIn(batches, 1, 10) === null ? tr("1–10 的整数", "A whole number 1–10") : null,
    timeout: intIn(timeoutM, 1, 1440) === null ? tr("1–1440 分钟的整数", "Whole minutes 1–1440") : null,
    ratio:
      ratio.trim() === ""
        ? tr("必填；超过这个比例就自动停止", "Required; stops above this ratio")
        : intIn(ratio, 0, 100) === null
          ? tr("填 0–100 之间的整数", "A whole number 0–100")
          : null,
  };
  const nErr = Object.values(errs).filter(Boolean).length;
  const show = (k: keyof typeof errs) => ((tried || touched[k]) && errs[k]) || undefined;
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));
  const nb = intIn(batches, 1, 10) ?? 1;
  const n =
    mode === "pick" ? picked.length : Math.max(1, Math.ceil((eligible.length * (intIn(pct, 1, 100) ?? 0)) / 100));
  const per = Math.ceil(n / nb);
  const waves = Array.from({ length: nb }, (_, i) => Math.round((100 * (i + 1)) / nb));
  const affected =
    mode === "pick"
      ? eligible.filter((s) => picked.includes(s.id))
      : (candidates.length ? candidates : eligible).slice(0, n);
  const next = () => {
    setTried(true);
    if (nErr === 0) setStep("confirm");
  };
  const start = async () => {
    const body: Record<string, unknown> = {
      version,
      waves,
      health_timeout_secs: Number(timeoutM) * 60,
      max_failure_ratio: Number(ratio) / 100,
    };
    if (mode === "pick") body.server_ids = picked;
    else body.percentage = Number(pct);
    const r = await run(() => post("/rollouts", body));
    if (r !== undefined) {
      toast({
        tone: "success",
        title: tr(`灰度已开始：第 1 批约 ${per} 台`, `Rollout started: about ${per} in wave 1`),
      });
      onClose();
    }
  };
  const serverChip = (s: ServerView) => (
    <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-footnote">
      <Server className="size-3 text-faint" aria-hidden="true" />
      {s.name}
      <span className="text-faint">{s.agent_version ?? "?"}</span>
    </span>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      icon={Rocket}
      title={
        step === "confirm"
          ? tr(`开始灰度 ${version}？`, `Start rolling out ${version}?`)
          : tr("新建灰度", "New rollout")
      }
      description={
        step === "confirm"
          ? tr("确认后立即开始第 1 批，可以随时暂停或中止。", "Wave 1 starts at once; pause or abort any time.")
          : tr(
              "分批升级 agent：每批升级后等健康检查通过，再进行下一批。",
              "Updates the agents in waves; each waits for its health check.",
            )
      }
      onSubmit={() => (step === "form" ? next() : void start())}
      dirty={step === "form" && Object.keys(touched).length > 0}
      footer={
        step === "confirm" ? (
          <>
            <Button variant="ghost" className="mr-auto" onClick={() => setStep("form")}>
              {tr("返回修改", "Back")}
            </Button>
            <Button type="submit" variant="primary" icon={Rocket} loading={busy}>
              {tr(`开始升级 ${n} 台`, `Update ${n} server(s)`)}
            </Button>
          </>
        ) : (
          <>
            <span className="mr-auto text-footnote text-muted-foreground">
              {tried && nErr ? (
                <FixCount n={nErr} />
              ) : (
                <>
                  {tr("将影响约 ", "Affects about ")}
                  <b className="tnum text-foreground">{n}</b>
                  {tr(` 台服务器，分 ${nb} 批，每批约 ${per} 台`, ` server(s), ${nb} wave(s), about ${per} each`)}
                </>
              )}
            </span>
            <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
            <Button type="submit" variant="primary" disabled={tried && nErr > 0}>
              {tr("下一步", "Next")}
            </Button>
          </>
        )
      }
    >
      {step === "confirm" ? (
        <div className="grid gap-3">
          <dl className="divide-y divide-separator rounded-lg bg-window ring-1 ring-border ring-inset">
            {[
              [tr("版本", "Version"), version],
              [
                tr("范围", "Scope"),
                mode === "pick"
                  ? tr(`指定 ${n} 台`, `${n} picked`)
                  : tr(`${pct}% 的已注册服务器（约 ${n} 台）`, `${pct}% of installed servers (about ${n})`),
              ],
              [
                tr("批次", "Waves"),
                tr(`${nb} 批（累计 ${waves.join(" → ")}%）`, `${nb} (cumulative ${waves.join(" → ")}%)`),
              ],
              [
                tr("健康检查", "Health check"),
                tr(`每批升级后等待最多 ${timeoutM} 分钟`, `up to ${timeoutM} min per wave`),
              ],
              [tr("自动停止", "Auto stop"), tr(`失败超过 ${ratio}% 时`, `above ${ratio}% failed`)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 px-3 py-2 text-body">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <div>
            <div className="mb-1.5 text-footnote font-medium text-muted-foreground">
              {tr(`将影响 ${n} 台服务器`, `Affects ${n} server(s)`)}
            </div>
            <div className="flex flex-wrap gap-1.5">{affected.map(serverChip)}</div>
          </div>
          <Banner tone="info">
            {tr(
              "升级时 agent 会重启，连接会断开几秒；协议过旧的 agent 记为已跳过。",
              "The agent restarts while updating (a few seconds offline); agents too old are skipped.",
            )}
          </Banner>
        </div>
      ) : (
        <div className="grid gap-4">
          <Field
            label={tr("版本", "Version")}
            hint={tr("只列出带二进制的发布", "Releases with a binary only")}
            error={show("version")}
          >
            <Select value={version} onChange={(e) => setVersion(e.target.value)}>
              {versions.length === 0 && <option value="">{tr("没有可用的发布", "No release")}</option>}
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version} · {v.rows.map((r) => `${r.os}/${r.arch}`).join(tr("、", ", "))}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <div className="mb-1.5 text-footnote font-medium text-muted-foreground">{tr("范围", "Scope")}</div>
            <RadioCards
              cols={2}
              label={tr("范围", "Scope")}
              value={mode}
              onChange={setMode}
              items={[
                {
                  value: "pct",
                  icon: <Shuffle />,
                  title: tr("按比例", "By share"),
                  desc: tr(`从 ${eligible.length} 台已注册的服务器里挑`, `Of ${eligible.length} installed servers`),
                },
                {
                  value: "pick",
                  icon: <Server />,
                  title: tr("指定服务器", "Pick servers"),
                  desc: tr("只升级勾选的几台", "Only the ticked ones"),
                },
              ]}
            />
          </div>
          {mode === "pct" ? (
            <Field label={tr("比例（%）", "Share (%)")} error={show("pct")}>
              <Input inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value)} onBlur={blur("pct")} />
            </Field>
          ) : (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-footnote font-medium text-muted-foreground">
                {tr(`选择服务器（已选 ${picked.length}）`, `Servers (${picked.length} picked)`)}
              </legend>
              {servers.isPending ? (
                <SkeletonRows rows={3} height={40} />
              ) : eligible.length === 0 ? (
                <p className="text-body text-muted-foreground">{tr("没有已注册的服务器。", "No installed servers.")}</p>
              ) : (
                <div className="max-h-52 divide-y divide-separator overflow-y-auto rounded-lg ring-1 ring-border ring-inset">
                  {eligible.map((s) => {
                    const same = sameV(s.agent_version, version);
                    return (
                      <label
                        key={s.id}
                        className={cn(
                          "flex min-h-10 items-center gap-2.5 px-3 text-body pointer-coarse:min-h-11",
                          same && "opacity-50",
                        )}
                      >
                        <Checkbox
                          disabled={same}
                          checked={picked.includes(s.id)}
                          label={s.name}
                          onChange={(on) => setPicked(on ? [...picked, s.id] : picked.filter((x) => x !== s.id))}
                        />
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        <span className="tnum text-footnote text-muted-foreground">
                          {same
                            ? tr("已是此版本", "Already on it")
                            : `${s.agent_version ?? "?"}${s.online ? "" : tr(" · 离线", " · offline")}`}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {show("pick") && <p className="text-footnote text-destructive">{show("pick")}</p>}
            </fieldset>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={tr("批次", "Waves")} error={show("batches")}>
              <Input
                inputMode="numeric"
                value={batches}
                onChange={(e) => setBatches(e.target.value)}
                onBlur={blur("batches")}
              />
            </Field>
            <Field
              label={tr("健康超时（分钟）", "Health timeout (min)")}
              hint={tr("超时算失败", "Timeout = failed")}
              error={show("timeout")}
            >
              <Input
                inputMode="numeric"
                value={timeoutM}
                onChange={(e) => setTimeoutM(e.target.value)}
                onBlur={blur("timeout")}
              />
            </Field>
            <Field label={tr("最大失败比例（%）", "Max failed (%)")} error={show("ratio")}>
              <Input
                inputMode="numeric"
                value={ratio}
                onChange={(e) => setRatio(e.target.value)}
                onBlur={blur("ratio")}
              />
            </Field>
          </div>
        </div>
      )}
    </Dialog>
  );
}
