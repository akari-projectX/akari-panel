// 系统状态 (ST-*, W31; v2 status-*, activity-monitor style): a verdict
// first (all fine, or "N 个问题需要关注" with each problem linking to its
// place), the panel instances (ring gauges, exited ones folded into a
// line), the dependencies (PostgreSQL / Valkey / Caddy) and the background
// jobs ordered by severity (stale → failing → fine; the fine ones folded).
// 概览 / 邮件队列 are two segments (`?tab=mail`; SET-17's queue lives in
// mail-queue.tsx). A failed poll keeps the data, says so in the verdict and
// dims the instances.
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Cpu,
  Database,
  HardDrive,
  Mail,
  PauseCircle,
  Server,
  ShieldCheck,
  Timer,
  XCircle,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { get } from "../../shared/api";
import { cn } from "../../shared/cn";
import { ago, bytes, dateTime, duration, pct } from "../../shared/format";
import { useLang, useTr, type Lang, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Card } from "../../shared/ui/card";
import { Segmented } from "../../shared/ui/form";
import { PageHeader } from "../../shared/ui/layout";
import { Gauge } from "../../shared/ui/ring";
import { ErrorState, Skeleton, SkeletonRows } from "../../shared/ui/states";
import { AsyncButton, Fresh, RawError } from "../components/kit";
import { useQS } from "../router";
import { MailQueue } from "./mail-queue";

type Host = {
  hostname: string | null;
  cores: number | null;
  cpu_percent: number | null;
  load: [number, number, number] | null;
  mem_total_bytes: number | null;
  mem_used_bytes: number | null;
  disk_total_bytes: number | null;
  disk_used_bytes: number | null;
  rss_bytes: number | null;
  /** /proc/stat, meminfo, loadavg hidden by the service sandbox. */
  proc_hidden?: boolean;
};
type Instance = {
  id: string;
  this: boolean;
  alive: boolean;
  version: string;
  git_sha: string;
  started_at: string;
  beat_at: string;
  host: Host;
  agent_sessions: number;
  db_pool_size: number;
  db_pool_idle: number;
};
type Job = {
  job: string;
  last_run_at: string | null;
  last_ok_at: string | null;
  lag_secs: number | null;
  stale: boolean;
  last_error: string | null;
  last_error_at: string | null;
  backlog: Record<string, number | null> | null;
};
export type Status = {
  generated_at: string;
  instances: Instance[];
  instances_error: string | null;
  postgres: {
    ok: boolean;
    latency_ms: number | null;
    version: string | null;
    connections: number | null;
    max_connections: number | null;
    database_bytes: number | null;
    in_recovery: boolean | null;
    error: string | null;
  };
  valkey: {
    ok: boolean;
    latency_ms: number | null;
    version: string | null;
    used_memory_bytes: number | null;
    max_memory_bytes: number | null;
    connected_clients: number | null;
    uptime_secs: number | null;
    error: string | null;
  };
  caddy: {
    configured: boolean;
    ok: boolean;
    host: string | null;
    latency_ms: number | null;
    http_status: number | null;
    cert_expires_at: string | null;
    error: string | null;
  };
  jobs: Job[];
};

export function useSystemStatus() {
  return useQuery({
    queryKey: ["system-status"],
    queryFn: () => get<Status>("/system/status"),
    refetchInterval: 10_000,
  });
}

function jobName(j: string, tr: Tr) {
  return (
    (
      {
        settlement: tr("流量结算", "Traffic settlement"),
        reconciliation: tr("支付对账", "Payment reconciliation"),
        mail: tr("邮件发件箱", "Mail outbox"),
        alerts: tr("告警评估", "Alert evaluation"),
      } as Record<string, string>
    )[j] ?? j
  );
}
function jobDesc(j: string, tr: Tr) {
  return (
    (
      {
        settlement: tr("把 agent 上报的流量记入用户与服务器额度", "Books the agents' traffic to users and servers"),
        reconciliation: tr("向支付渠道核对待支付订单与退款", "Checks unpaid orders and refunds with the provider"),
        mail: tr("发送队列中的邮件，失败的按退避重试", "Sends the queued mail, retries with back-off"),
        alerts: tr("评估告警规则并投递通知", "Evaluates the alert rules and delivers notices"),
      } as Record<string, string>
    )[j] ?? ""
  );
}

/** A probe's or job's raw error (English, from a driver) → one line in words. */
function explainError(raw: string, tr: Tr): string {
  const s = raw.toLowerCase();
  if (/timed? ?out|timeout|deadline/.test(s)) return tr("检查超时：对方没有及时回答", "Timed out: no answer in time");
  if (s.includes("connection refused"))
    return tr("连接被拒绝：服务没有在监听", "Connection refused: nothing listening");
  if (s.includes("invalid main domain")) return tr("主域名无效", "The main domain is invalid");
  if (s.includes("invalid host name")) return tr("主机名无效", "Invalid host name");
  if (s.includes("not an http answer")) return tr("对方的回答不是 HTTP", "The answer was not HTTP");
  if (/certificate|tls|handshake|x509/.test(s)) return tr("TLS 握手或证书出错", "TLS handshake or certificate error");
  if (/dns|resolve|lookup|name or service/.test(s)) return tr("域名解析失败", "DNS lookup failed");
  if (/auth|password|permission|denied/.test(s)) return tr("认证或权限被拒绝", "Authentication or permission refused");
  if (/pool|too many (clients|connections)/.test(s)) return tr("连接数已满", "Out of connections");
  if (/reset|broken pipe|closed/.test(s)) return tr("连接被对方断开", "The connection was closed");
  return tr("检查失败", "Check failed");
}

/** Backlog keys → words. */
function backlogText(k: string, v: number | null, tr: Tr, lang: Lang): [string, string] {
  const n = v === null ? "—" : v.toLocaleString();
  switch (k) {
    case "pending":
      return [tr("待发送", "Pending"), n];
    case "due":
      return [tr("已到发送时间", "Due"), n];
    case "oldest_due_secs":
      return [tr("最早的已等待", "Oldest waiting"), v === null ? "—" : duration(v, lang)];
    case "dead":
      return [tr("失败邮件", "Failed mail"), n];
    case "pending_orders":
      return [tr("待核对订单", "Orders to check"), n];
    case "pending_deliveries":
      return [tr("待发送告警通知", "Alert notices pending"), n];
    default:
      return [k, n];
  }
}

type JobState = "stalled" | "failing" | "ok";
function jobState(j: Job): JobState {
  if (j.stale) return "stalled";
  if (j.last_error_at && (!j.last_ok_at || j.last_error_at > j.last_ok_at)) return "failing";
  return "ok";
}
const JOB_RANK: Record<JobState, number> = { stalled: 0, failing: 1, ok: 2 };

type Problem = { tone: "danger" | "warning"; text: string; to?: string; href?: string };

function problemsOf(s: Status, dead: number, tr: Tr, lang: Lang): Problem[] {
  const out: Problem[] = [];
  for (const j of s.jobs) {
    const st = jobState(j);
    if (st === "stalled")
      out.push({
        tone: "danger",
        text: tr(
          `${jobName(j.job, tr)}已停滞 ${j.lag_secs != null ? duration(j.lag_secs, lang) : ""}`,
          `${jobName(j.job, tr)} stalled ${j.lag_secs != null ? duration(j.lag_secs, lang) : ""}`,
        ),
        href: `#job-${j.job}`,
      });
    else if (st === "failing")
      out.push({
        tone: "danger",
        text: tr(`${jobName(j.job, tr)}最近一次运行出错`, `${jobName(j.job, tr)}: the last run failed`),
        href: `#job-${j.job}`,
      });
  }
  if (!s.postgres.ok)
    out.push({ tone: "danger", text: tr("PostgreSQL 检查失败", "PostgreSQL check failed"), href: "#dep-pg" });
  if (!s.valkey.ok)
    out.push({ tone: "danger", text: tr("Valkey 检查失败", "Valkey check failed"), href: "#dep-valkey" });
  if (s.caddy.configured && !s.caddy.ok)
    out.push({ tone: "danger", text: tr("反向代理检查失败", "Reverse proxy check failed"), href: "#dep-caddy" });
  const certDays = s.caddy.cert_expires_at
    ? Math.floor((Date.parse(s.caddy.cert_expires_at) - Date.now()) / 86_400_000)
    : null;
  if (certDays != null && certDays < 14)
    out.push({
      tone: "warning",
      text: tr(`Caddy：证书 ${certDays} 天后到期`, `Caddy: the certificate expires in ${certDays} days`),
      href: "#dep-caddy",
    });
  if (dead > 0)
    out.push({
      tone: "warning",
      text: tr(`${dead} 封邮件发送失败`, `${dead} mails failed`),
      to: "/status?tab=mail&mail=dead",
    });
  if (s.instances_error)
    out.push({
      tone: "warning",
      text: tr("读不到其他实例的心跳（Valkey 不可用）", "Cannot read the other instances' heartbeats (Valkey down)"),
    });
  for (const i of s.instances.filter((x) => x.alive)) {
    const d = i.host.disk_total_bytes ? pct(i.host.disk_used_bytes ?? 0, i.host.disk_total_bytes) : null;
    if (d != null && d >= 90)
      out.push({
        tone: "warning",
        text: tr(
          `${i.host.hostname ?? i.id.slice(0, 8)} 磁盘已用 ${d}%`,
          `${i.host.hostname ?? i.id.slice(0, 8)}: disk ${d}% used`,
        ),
      });
  }
  return out;
}

export function StatusPage() {
  const tr = useTr();
  const [query, patch] = useQS();
  const q = useSystemStatus();
  const s = q.data;
  // ?mail=… alone (older links) also means the mail tab.
  const tab = query.get("tab") === "mail" || (!query.get("tab") && query.get("mail")) ? "mail" : "overview";
  const dead = s?.jobs.find((j) => j.job === "mail")?.backlog?.dead ?? 0;
  const pending = s?.jobs.find((j) => j.job === "mail")?.backlog?.pending ?? 0;
  return (
    <>
      <PageHeader
        title={tr("系统状态", "System status")}
        description={tr(
          "实例、依赖、后台任务与邮件队列",
          "Instances, dependencies, background jobs and the mail queue",
        )}
        actions={
          s && <Fresh updatedAt={q.dataUpdatedAt} stale={q.isError && !!s} every={10} onRefresh={() => q.refetch()} />
        }
      />
      <Segmented
        className="mb-4"
        label={tr("系统状态视图", "System status view")}
        value={tab}
        onChange={(v) => patch({ tab: v === "overview" ? null : v, mail: null, diagnose: null })}
        options={[
          {
            value: "overview",
            label: (
              <>
                <HardDrive className="size-3.5" aria-hidden="true" />
                {tr("概览", "Overview")}
              </>
            ),
          },
          {
            value: "mail",
            label: (
              <>
                <Mail className="size-3.5" aria-hidden="true" />
                {tr("邮件队列", "Mail queue")}
                {dead > 0 && (
                  <Badge tone="danger" className="ml-0.5 px-1.5 py-0 text-caption">
                    {dead}
                  </Badge>
                )}
              </>
            ),
          },
        ]}
      />
      {tab === "mail" ? (
        <MailQueue dead={dead} pending={pending ?? 0} />
      ) : q.isError && !s ? (
        <Card>
          <ErrorState
            title={tr("系统状态加载失败", "System status did not load")}
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        </Card>
      ) : !s ? (
        <div className="grid gap-4" role="status" aria-label={tr("加载中", "Loading")}>
          <Skeleton className="h-28 rounded-xl" />
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-52 rounded-xl" />
            ))}
          </div>
          <Card>
            <SkeletonRows rows={4} height={56} />
          </Card>
        </div>
      ) : (
        <Overview s={s} dead={dead} stale={q.isError} onRetry={() => q.refetch()} />
      )}
    </>
  );
}

function H({ icon, title, note }: { icon: ReactNode; title: string; note?: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2 px-1">
      <span className="text-muted-foreground [&_svg]:size-4" aria-hidden="true">
        {icon}
      </span>
      <h2 className="text-headline font-semibold tracking-[-0.01em]">{title}</h2>
      {note && <span className="truncate text-footnote text-faint max-sm:hidden">{note}</span>}
    </div>
  );
}

function Overview({
  s,
  dead,
  stale,
  onRetry,
}: {
  s: Status;
  dead: number;
  stale: boolean;
  onRetry: () => Promise<unknown>;
}) {
  const tr = useTr();
  const lang = useLang();
  const live = s.instances.filter((i) => i.alive);
  const exited = s.instances.filter((i) => !i.alive);
  return (
    <div className="grid gap-6">
      <Verdict s={s} dead={dead} stale={stale} onRetry={onRetry} />
      <section>
        <H
          icon={<Cpu />}
          title={tr("面板实例", "Panel instances")}
          note={tr("每个实例自己上报；主机指标来自 /proc", "Each instance reports itself; host figures from /proc")}
        />
        <div className={cn("grid gap-3 md:grid-cols-2", stale && "opacity-70")}>
          {live.map((i) => (
            <InstanceCard key={i.id} i={i} />
          ))}
        </div>
        {exited.length > 0 && (
          <div className="mt-2 rounded-lg px-3 py-2 text-footnote text-muted-foreground ring-1 ring-border ring-inset">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <Clock className="size-3.5 text-faint" aria-hidden="true" />
              {tr(`${exited.length} 个已退出的实例`, `${exited.length} exited instance(s)`)}
            </div>
            <ul className="mt-1 grid gap-0.5 pl-5.5">
              {exited.map((i) => (
                <li key={i.id}>
                  {i.host.hostname ?? i.id.slice(0, 8)} · v{i.version} ·{" "}
                  {tr(`最后心跳 ${ago(i.beat_at, lang)}`, `last heartbeat ${ago(i.beat_at, lang)}`)}
                </li>
              ))}
            </ul>
            <p className="mt-1 pl-5.5 text-faint">
              {tr(
                "重启或升级前的进程，不再显示指标；10 分钟后（同一主机有新实例时立即）自动移除。",
                "Processes from before a restart or upgrade, no figures; removed after 10 minutes (at once when a new instance runs on the host).",
              )}
            </p>
          </div>
        )}
        {s.instances_error && (
          <div className="mt-2 rounded-lg bg-warning-soft px-3 py-2">
            <RawError
              message={tr(
                `读不到其他实例的心跳（Valkey 不可用）：只显示当前实例。${explainError(s.instances_error, tr)}`,
                `Cannot read the other instances' heartbeats (Valkey down): this instance only. ${explainError(s.instances_error, tr)}`,
              )}
              raw={s.instances_error}
            />
          </div>
        )}
      </section>
      <section>
        <H icon={<Database />} title={tr("依赖", "Dependencies")} />
        <Deps s={s} />
      </section>
      <section>
        <H
          icon={<Timer />}
          title={tr("后台任务", "Background jobs")}
          note={tr("有问题的排在最前；所有实例合计", "Problems first; across the instances")}
        />
        <Jobs jobs={s.jobs} />
      </section>
    </div>
  );
}

function Verdict({
  s,
  dead,
  stale,
  onRetry,
}: {
  s: Status;
  dead: number;
  stale: boolean;
  onRetry: () => Promise<unknown>;
}) {
  const tr = useTr();
  const lang = useLang();
  const problems = problemsOf(s, dead, tr, lang);
  const live = s.instances.filter((i) => i.alive).length;
  const deps = [s.postgres.ok, s.valkey.ok, ...(s.caddy.configured ? [s.caddy.ok] : [])];
  const jobsOk = s.jobs.filter((j) => jobState(j) === "ok").length;
  const stats: [string, string][] = [
    [String(live), tr("实例运行中", "instances up")],
    [`${deps.filter(Boolean).length}/${deps.length}`, tr("依赖正常", "dependencies OK")],
    [`${jobsOk}/${s.jobs.length}`, tr("任务正常", "jobs OK")],
  ];
  const statBlock = (
    <div className="flex gap-6 text-center max-sm:w-full max-sm:justify-around">
      {stats.map(([v, k]) => (
        <div key={k}>
          <div className="tnum text-title2 font-semibold">{v}</div>
          <div className="text-footnote text-muted-foreground">{k}</div>
        </div>
      ))}
    </div>
  );
  return (
    <Card className="overflow-hidden" data-verdict>
      {stale && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b border-separator bg-warning-soft px-5 py-2 text-body"
        >
          <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
          <span className="flex-1">
            <b className="font-semibold text-warning">{tr("刷新失败", "Refresh failed")}</b>
            <span className="text-foreground/80">
              {tr(
                `，下面显示的是 ${dateTime(s.generated_at).slice(11, 19)} 的数据，会自动重试。`,
                `; showing the data of ${dateTime(s.generated_at).slice(11, 19)}, retrying by itself.`,
              )}
            </span>
          </span>
          <AsyncButton size="sm" variant="outline" onClick={onRetry}>
            {tr("立即重试", "Retry now")}
          </AsyncButton>
        </div>
      )}
      {problems.length === 0 ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-success text-white">
            <CheckCircle2 className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-title3 font-semibold">{tr("全部正常", "All fine")}</div>
            <div className="text-body text-muted-foreground">
              {tr(
                `${live} 个实例、${deps.length} 个依赖、${s.jobs.length} 个后台任务都在按时运行。`,
                `${live} instances, ${deps.length} dependencies and ${s.jobs.length} jobs are running on time.`,
              )}
            </div>
          </div>
          {statBlock}
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-5 gap-y-3 px-5 py-4">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-destructive text-white">
            <Activity className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-title3 font-semibold tracking-[-0.015em]">
              {tr(`${problems.length} 个问题需要关注`, `${problems.length} issue(s) need attention`)}
            </div>
            <ul className="mt-1.5 grid gap-1">
              {problems.map((p) => {
                const inner = (
                  <>
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        p.tone === "danger" ? "bg-destructive" : "bg-warning",
                      )}
                      aria-hidden="true"
                    />
                    <span className="underline-offset-2 group-hover:underline">{p.text}</span>
                  </>
                );
                const cls = "group inline-flex items-center gap-2 text-body text-foreground/85";
                return (
                  <li key={p.text}>
                    {p.to ? (
                      <Link to={p.to} className={cls}>
                        {inner}
                      </Link>
                    ) : p.href ? (
                      <a href={p.href} className={cls}>
                        {inner}
                      </a>
                    ) : (
                      <span className={cls}>{inner}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          {statBlock}
        </div>
      )}
    </Card>
  );
}

function InstanceCard({ i }: { i: Instance }) {
  const tr = useTr();
  const lang = useLang();
  const h = i.host;
  const mem = h.mem_total_bytes ? pct(h.mem_used_bytes ?? 0, h.mem_total_bytes) : null;
  const disk = h.disk_total_bytes ? pct(h.disk_used_bytes ?? 0, h.disk_total_bytes) : null;
  const load = h.load && h.cores ? Math.round((h.load[0] / h.cores) * 100) : null;
  const cpu = h.cpu_percent == null ? null : Math.round(h.cpu_percent);
  const gauge = (label: string, v: number | null, detail: ReactNode) => (
    <div role="img" aria-label={`${label} ${v == null ? tr("未知", "unknown") : `${v}%`}`}>
      <Gauge value={v == null ? null : Math.min(v, 100)} label={label} detail={detail} />
    </div>
  );
  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-secondary text-muted-foreground">
          <Server className="size-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-headline font-semibold break-all">{h.hostname ?? i.id.slice(0, 8)}</span>
            <Badge tone="success" dot>
              {tr("运行中", "Running")}
            </Badge>
            {i.this && <Badge tone="outline">{tr("当前实例", "This instance")}</Badge>}
          </div>
          <div className="mt-0.5 text-footnote text-muted-foreground">
            v{i.version} ({i.git_sha.slice(0, 12)}) ·{" "}
            {tr(
              `已运行 ${duration((Date.now() - Date.parse(i.started_at)) / 1000, lang)}`,
              `up ${duration((Date.now() - Date.parse(i.started_at)) / 1000, lang)}`,
            )}
          </div>
        </div>
      </div>
      {h.proc_hidden ? (
        <div className="mx-4 mb-3 flex items-start gap-2.5 rounded-lg bg-window px-3 py-2.5 text-footnote ring-1 ring-border ring-inset">
          <ShieldCheck className="mt-px size-4 shrink-0 text-info" aria-hidden="true" />
          <div>
            <div className="font-medium">
              {tr("看不到这台主机的 CPU、内存和负载", "This host's CPU, memory and load are hidden")}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {tr(
                "旧版面板 systemd 单元的 ProcSubset=pid 隐藏了 /proc/stat、/proc/meminfo、/proc/loadavg，所以这些显示为未知。运行 akari-ctl upgrade 安装新单元即可。",
                "ProcSubset=pid in an older panel systemd unit hides /proc/stat, /proc/meminfo and /proc/loadavg, so these are unknown. Run akari-ctl upgrade to install the new unit.",
              )}
              {disk != null && tr(` 磁盘已用 ${disk}%。`, ` Disk ${disk}% used.`)}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 px-3 pb-3 max-sm:gap-1 max-sm:px-1">
          {gauge("CPU", cpu, h.cores ? tr(`${h.cores} 核`, `${h.cores} cores`) : undefined)}
          {gauge(tr("内存", "Memory"), mem, `${bytes(h.mem_used_bytes)} / ${bytes(h.mem_total_bytes)}`)}
          {gauge(tr("负载", "Load"), load, h.load ? h.load.map((x) => x.toFixed(2)).join(" ") : "—")}
          {gauge(
            tr("磁盘", "Disk"),
            disk,
            h.disk_total_bytes != null
              ? tr(
                  `剩 ${bytes(h.disk_total_bytes - (h.disk_used_bytes ?? 0))}`,
                  `${bytes(h.disk_total_bytes - (h.disk_used_bytes ?? 0))} free`,
                )
              : "—",
          )}
        </div>
      )}
      <dl className="mt-auto grid grid-cols-3 divide-x divide-separator border-t border-separator text-center">
        {(
          [
            [tr("面板进程内存", "Panel RSS"), bytes(h.rss_bytes)],
            [tr("agent 会话", "Agent sessions"), String(i.agent_sessions)],
            [tr("数据库连接", "DB pool"), `${i.db_pool_size - i.db_pool_idle} / ${i.db_pool_size}`],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="py-2">
            <dt className="text-caption text-muted-foreground">{k}</dt>
            <dd className="tnum text-body font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function Deps({ s }: { s: Status }) {
  const tr = useTr();
  const lang = useLang();
  const ms = (v: number | null) => (v != null ? `${v} ms` : "—");
  const certDays = s.caddy.cert_expires_at
    ? Math.floor((Date.parse(s.caddy.cert_expires_at) - Date.now()) / 86_400_000)
    : null;
  const cards: {
    id: string;
    name: string;
    icon: ReactNode;
    version: string | null;
    ok: boolean | null;
    error: string | null;
    warn?: string;
    metrics: [string, ReactNode][];
  }[] = [
    {
      id: "pg",
      name: "PostgreSQL",
      icon: <Database />,
      version: s.postgres.version,
      ok: s.postgres.ok,
      error: s.postgres.error,
      metrics: [
        [tr("延迟", "Latency"), ms(s.postgres.latency_ms)],
        [tr("连接", "Connections"), `${s.postgres.connections ?? "?"} / ${s.postgres.max_connections ?? "?"}`],
        [tr("库大小", "Size"), bytes(s.postgres.database_bytes)],
        [
          tr("只读副本", "Replica"),
          s.postgres.in_recovery == null ? "—" : s.postgres.in_recovery ? tr("是", "yes") : tr("否", "no"),
        ],
      ],
    },
    {
      id: "valkey",
      name: "Valkey",
      icon: <Zap />,
      version: s.valkey.version,
      ok: s.valkey.ok,
      error: s.valkey.error,
      metrics: [
        [tr("延迟", "Latency"), ms(s.valkey.latency_ms)],
        [
          tr("内存", "Memory"),
          `${bytes(s.valkey.used_memory_bytes)}${s.valkey.max_memory_bytes ? ` / ${bytes(s.valkey.max_memory_bytes)}` : ""}`,
        ],
        [tr("客户端", "Clients"), s.valkey.connected_clients ?? "—"],
        [tr("运行", "Uptime"), duration(s.valkey.uptime_secs, lang)],
      ],
    },
    {
      id: "caddy",
      name: tr("反向代理（Caddy）", "Reverse proxy (Caddy)"),
      icon: <ShieldCheck />,
      version: s.caddy.host,
      ok: s.caddy.configured ? s.caddy.ok : null,
      error: s.caddy.error,
      warn:
        certDays != null && certDays < 14
          ? tr(`证书 ${certDays} 天内到期`, `Certificate expires within ${certDays} days`)
          : undefined,
      metrics: [
        [tr("延迟", "Latency"), ms(s.caddy.latency_ms)],
        ["HTTP", s.caddy.http_status ?? "—"],
        [
          tr("证书到期", "Cert expires"),
          s.caddy.cert_expires_at ? dateTime(s.caddy.cert_expires_at).slice(0, 10) : "—",
        ],
        [tr("剩余", "Left"), certDays != null ? tr(`${certDays} 天`, `${certDays} d`) : "—"],
      ],
    },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {cards.map((d) => (
        <Card key={d.id} id={`dep-${d.id}`} className="scroll-mt-20 px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span
              className="inline-flex size-8 items-center justify-center rounded-[9px] bg-secondary text-muted-foreground [&_svg]:size-4"
              aria-hidden="true"
            >
              {d.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-body font-semibold">{d.name}</div>
              <div className="truncate text-caption text-faint">{d.version ?? "—"}</div>
            </div>
            {d.ok === null ? (
              <Badge>{tr("未配置主域名", "No main domain")}</Badge>
            ) : !d.ok ? (
              <Badge tone="danger" dot>
                {tr("异常", "Down")}
              </Badge>
            ) : d.warn ? (
              <Badge tone="warning">
                <AlertTriangle aria-hidden="true" />
                {tr("注意", "Attention")}
              </Badge>
            ) : (
              <Badge tone="success" dot>
                {tr("正常", "OK")}
              </Badge>
            )}
          </div>
          {d.warn && (
            <div className="mt-2 rounded-md bg-warning-soft px-2 py-1 text-footnote text-warning">{d.warn}</div>
          )}
          {d.error && (
            <div className="mt-2 rounded-md bg-destructive-soft/60 px-2 py-1.5">
              <RawError message={explainError(d.error, tr)} raw={d.error} />
            </div>
          )}
          <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
            {d.metrics.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2 text-footnote">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="tnum truncate font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ))}
    </div>
  );
}

function Jobs({ jobs }: { jobs: Job[] }) {
  const tr = useTr();
  const lang = useLang();
  const [showOk, setShowOk] = useState(false);
  const sorted = [...jobs].sort((a, b) => JOB_RANK[jobState(a)] - JOB_RANK[jobState(b)]);
  const bad = sorted.filter((j) => jobState(j) !== "ok");
  const ok = sorted.filter((j) => jobState(j) === "ok");
  // Folding the fine ones only helps when something is wrong.
  const fold = bad.length > 0 && !showOk;
  const badge = (st: JobState) =>
    st === "stalled" ? (
      <Badge tone="danger">
        <PauseCircle aria-hidden="true" />
        {tr("已停滞", "Stalled")}
      </Badge>
    ) : st === "failing" ? (
      <Badge tone="danger">
        <XCircle aria-hidden="true" />
        {tr("有失败", "Failing")}
      </Badge>
    ) : (
      <Badge tone="success" dot>
        {tr("正常", "OK")}
      </Badge>
    );
  const cell = (k: string, v: string, danger?: boolean) => (
    <div className="min-w-0">
      <div className="text-caption text-muted-foreground md:hidden">{k}</div>
      <div className={cn("tnum truncate text-body", danger && "font-semibold text-destructive")}>{v}</div>
    </div>
  );
  const grid = "md:grid-cols-[minmax(0,1.4fr)_88px_repeat(2,minmax(80px,0.5fr))_minmax(0,1fr)]";
  const row = (j: Job) => {
    const st = jobState(j);
    const backlog = Object.entries(j.backlog ?? {}).filter(([k]) => k !== "oldest_due_secs" || j.backlog?.[k]);
    return (
      <li key={j.job} id={`job-${j.job}`} className="relative scroll-mt-20" data-job={j.job}>
        <span
          className={cn("absolute inset-y-0 left-0 w-[3px]", st === "ok" ? "bg-transparent" : "bg-destructive")}
          aria-hidden="true"
        />
        <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 px-4 py-3", grid)}>
          <div className="min-w-0">
            <div className="text-body font-semibold">{jobName(j.job, tr)}</div>
            <div className="truncate text-footnote text-muted-foreground">{jobDesc(j.job, tr)}</div>
          </div>
          <div className="md:pt-0.5">{badge(st)}</div>
          <div className="col-span-2 grid grid-cols-2 gap-2 md:contents">
            {cell(tr("上次运行", "Last run"), ago(j.last_run_at, lang), st === "stalled")}
            {cell(
              tr("距上次成功", "Since last OK"),
              j.lag_secs != null ? duration(j.lag_secs, lang) : "—",
              st === "stalled",
            )}
          </div>
          <div className="col-span-2 flex flex-wrap gap-1.5 md:col-span-1">
            {backlog.length === 0 ? (
              <span className="text-footnote text-faint">{tr("无积压", "No backlog")}</span>
            ) : (
              backlog.map(([k, v]) => {
                const [label, n] = backlogText(k, v, tr, lang);
                return (
                  <span
                    key={k}
                    className={cn(
                      "inline-flex items-baseline gap-1.5 rounded-md px-2 py-0.5 text-footnote",
                      k === "dead" && v ? "bg-warning-soft" : "bg-secondary",
                    )}
                  >
                    <span className="text-muted-foreground">{label}</span>
                    <span className="tnum font-semibold">{n}</span>
                  </span>
                );
              })
            )}
          </div>
        </div>
        {j.last_error && (
          <div
            className={cn(
              "mx-4 mb-3 -mt-1 flex gap-2 rounded-lg px-3 py-2",
              st === "ok" ? "bg-window" : "bg-destructive-soft/60",
            )}
          >
            <span className={cn("tnum shrink-0 pt-px text-footnote", st === "ok" ? "text-faint" : "text-destructive")}>
              {dateTime(j.last_error_at).slice(11, 16)}
            </span>
            <RawError
              message={tr(
                `最近一次出错：${explainError(j.last_error, tr)}`,
                `Last error: ${explainError(j.last_error, tr)}`,
              )}
              raw={j.last_error}
            />
            {j.job === "mail" && (
              <Link
                to="/status?tab=mail&mail=dead"
                className="ml-auto self-start text-footnote font-medium whitespace-nowrap text-primary hover:underline"
              >
                {tr("查看失败邮件", "Failed mail")}
              </Link>
            )}
          </div>
        )}
      </li>
    );
  };
  return (
    <Card className="overflow-hidden">
      <div
        className={cn(
          "hidden gap-x-4 border-b border-separator px-4 py-2 text-footnote text-muted-foreground md:grid",
          grid,
        )}
      >
        <span>{tr("任务", "Job")}</span>
        <span>{tr("状态", "State")}</span>
        <span>{tr("上次运行", "Last run")}</span>
        <span>{tr("距上次成功", "Since last OK")}</span>
        <span>{tr("积压", "Backlog")}</span>
      </div>
      <ul className="divide-y divide-separator">
        {bad.map(row)}
        {!fold && ok.map(row)}
      </ul>
      {bad.length > 0 && ok.length > 0 && (
        <button
          type="button"
          onClick={() => setShowOk(!showOk)}
          aria-expanded={showOk}
          className="flex h-10 w-full items-center justify-center gap-1 border-t border-separator text-body text-muted-foreground hover:bg-accent"
        >
          {showOk
            ? tr("收起正常的任务", "Hide the fine jobs")
            : tr(`另有 ${ok.length} 个任务运行正常`, `${ok.length} more jobs running fine`)}
          <ChevronDown className={cn("size-4 transition-transform", showOk && "rotate-180")} aria-hidden="true" />
        </button>
      )}
    </Card>
  );
}
