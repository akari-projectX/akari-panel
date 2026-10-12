// 系统状态 (ST-*, W31; audit §5.3): panel instances (host CPU / memory /
// load / disk, process RSS, version, agent sessions), PostgreSQL, Valkey,
// the reverse proxy, the background jobs (last run, lag, stale, last error,
// backlog) and the mail queue (SET-17, moved here from the mail settings).
// A failed poll keeps the last answer on screen and says so; probe errors
// are explained in words with the server's text folded away.
import { useQuery } from "@tanstack/react-query";
import { MailWarning, RefreshCw, Send } from "lucide-react";
import { useState, type ReactNode } from "react";
import { get } from "../../shared/api";
import { ago, bytes, dateTime, duration, pct } from "../../shared/format";
import { useLang, useTr, type Lang, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardBody, CardHeader } from "../../shared/ui/card";
import { Callout, KV, PageHeader } from "../../shared/ui/layout";
import { usageTone } from "../../shared/ui/meter";
import { Ring } from "../../shared/ui/ring";
import { ErrorState, Skeleton } from "../../shared/ui/states";
import { setQuery } from "../router";
import { MailQueue, TestMailDialog } from "./mail-queue";

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
type Status = {
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

/** A probe's or job's raw error (English, from a driver) → one line in words. */
export function explainError(raw: string, tr: Tr): string {
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

/** Mapped error line + the server's text in a folded detail. */
function RawError({ summary, raw, at }: { summary: ReactNode; raw: string; at?: string | null }) {
  const tr = useTr();
  return (
    <div className="grid gap-1 text-body">
      <p className="font-medium text-destructive">
        {summary}
        {at && <span className="ml-1.5 font-normal text-muted-foreground">{dateTime(at)}</span>}
      </p>
      <details className="text-footnote text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">{tr("原始信息", "Details")}</summary>
        <code className="mt-1 block rounded-md bg-window px-2 py-1.5 font-mono break-all">{raw}</code>
      </details>
    </div>
  );
}

/** Backlog keys → words. */
function backlogText(k: string, v: number | null, tr: Tr, lang: Lang): string {
  const n = v === null ? "—" : String(v);
  switch (k) {
    case "pending":
      return tr(`待发送 ${n}`, `${n} pending`);
    case "due":
      return tr(`已到发送时间 ${n}`, `${n} due`);
    case "oldest_due_secs":
      return tr(
        `最早的已等待 ${v === null ? "—" : duration(v, lang)}`,
        `oldest waiting ${v === null ? "—" : duration(v, lang)}`,
      );
    case "dead":
      return tr(`发送失败 ${n}`, `${n} failed`);
    case "pending_orders":
      return tr(`待付款订单 ${n}`, `${n} unpaid orders`);
    case "pending_deliveries":
      return tr(`待发送告警通知 ${n}`, `${n} alert deliveries pending`);
    default:
      return `${k}: ${n}`;
  }
}

function Health({ ok, label }: { ok: boolean; label?: string }) {
  const tr = useTr();
  return (
    <Badge tone={ok ? "success" : "danger"} dot>
      {label ?? (ok ? tr("正常", "OK") : tr("异常", "Down"))}
    </Badge>
  );
}

export function StatusPage() {
  const tr = useTr();
  const lang = useLang();
  const q = useQuery({
    queryKey: ["system-status"],
    queryFn: () => get<Status>("/system/status"),
    refetchInterval: 10_000,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [testing, setTesting] = useState(false);
  const s = q.data;
  const header = (
    <PageHeader
      title={tr("系统状态", "System status")}
      description={s && tr(`更新于 ${dateTime(s.generated_at)}`, `Updated ${dateTime(s.generated_at)}`)}
      actions={
        <>
          {q.isError && s && (
            <Badge tone="warning" role="status">
              {tr("刷新失败，显示的是上次的数据", "Refresh failed; showing the last data")}
            </Badge>
          )}
          <Button
            size="sm"
            variant="outline"
            icon={RefreshCw}
            loading={refreshing}
            onClick={() => {
              setRefreshing(true);
              void q.refetch().finally(() => setRefreshing(false));
            }}
          >
            {tr("刷新", "Refresh")}
          </Button>
        </>
      }
    />
  );
  if (q.isError && !s)
    return (
      <>
        {header}
        <Card>
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        </Card>
      </>
    );
  if (!s)
    return (
      <>
        {header}
        <div className="grid gap-4 md:grid-cols-2" role="status" aria-label={tr("加载中", "Loading")}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      </>
    );
  const mail = s.jobs.find((j) => j.job === "mail");
  const dead = mail?.backlog?.dead ?? 0;
  const live = s.instances.filter((i) => i.alive);
  const exited = s.instances.filter((i) => !i.alive);
  const probe = (name: string, err: string | null) =>
    err ? (
      <div className="mb-3">
        <RawError summary={`${name}：${explainError(err, tr)}`} raw={err} />
      </div>
    ) : null;
  return (
    <>
      {header}
      {dead ? (
        <div className="mb-4">
          <Callout
            tone="warning"
            title={tr(`${dead} 封邮件发送失败（重试 8 次后放弃）`, `${dead} mails failed (gave up after 8 attempts)`)}
          >
            <p className="text-footnote text-muted-foreground">
              {tr(
                "先测试发信找出原因（发信设置、服务商拒绝等），修好后在下面的邮件队列里重试。",
                "Run a test mail to find the cause (settings, provider refusal…), then retry in the mail queue below.",
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" icon={Send} onClick={() => setTesting(true)}>
                {tr("测试发信", "Test mail")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={MailWarning}
                onClick={() => {
                  setQuery({ mail: "dead" });
                  document.getElementById("mail-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {tr("查看失败邮件", "Failed mail")}
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}
      {s.instances_error && (
        <div className="mb-4">
          <Callout
            tone="danger"
            title={tr(
              "读不到其他实例的心跳（Valkey 不可用）：下面只显示当前实例",
              "Cannot read the other instances' heartbeats (Valkey down): this instance only",
            )}
          >
            <RawError summary={explainError(s.instances_error, tr)} raw={s.instances_error} />
          </Callout>
        </div>
      )}
      {exited.length > 0 && (
        <div className="mb-4">
          <Callout tone="info" title={tr(`${exited.length} 个已退出的实例`, `${exited.length} exited instance(s)`)}>
            <p className="text-footnote text-muted-foreground">
              {tr(
                "重启或升级前的面板进程；不计入后台任务统计，10 分钟后（同一主机有新实例时立即）自动移除。",
                "Panel processes from before a restart or upgrade; not counted in the job stats, removed after 10 minutes (at once when a new instance runs on the same host).",
              )}
            </p>
            <ul className="mt-1 text-footnote">
              {exited.map((i) => (
                <li key={i.id}>
                  {i.host.hostname ?? i.id.slice(0, 8)} · v{i.version} · {tr("最后心跳", "last heartbeat")}{" "}
                  {ago(i.beat_at, lang)}
                </li>
              ))}
            </ul>
          </Callout>
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {live.map((i) => {
          const h = i.host;
          const mem = h.mem_total_bytes ? pct(h.mem_used_bytes ?? 0, h.mem_total_bytes) : null;
          const disk = h.disk_total_bytes ? pct(h.disk_used_bytes ?? 0, h.disk_total_bytes) : null;
          const rings: [string, number | null][] = [
            ["CPU", h.cpu_percent == null ? null : Math.round(h.cpu_percent)],
            [tr("内存", "Memory"), mem],
            [tr("磁盘", "Disk"), disk],
          ];
          return (
            <Card key={i.id}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="break-all">{h.hostname ?? i.id.slice(0, 8)}</span>
                    {i.this && <Badge tone="primary">{tr("当前实例", "This instance")}</Badge>}
                  </span>
                }
                description={`v${i.version} (${i.git_sha.slice(0, 12)}) · ${tr("运行", "up")} ${duration((Date.now() - Date.parse(i.started_at)) / 1000, lang)}`}
                actions={<Health ok label={tr("在线", "Alive")} />}
              />
              <CardBody>
                {h.proc_hidden && (
                  <div className="mb-3">
                    <Callout tone="warning">
                      {tr(
                        "读不到 /proc/stat、/proc/meminfo、/proc/loadavg：旧版面板 systemd 单元的 ProcSubset=pid 把它们隐藏了，所以 CPU、内存、负载显示为未知。运行 akari-ctl upgrade 安装新单元即可。",
                        "/proc/stat, /proc/meminfo and /proc/loadavg are hidden by ProcSubset=pid in an older panel systemd unit, so CPU, memory and load are unknown. Run akari-ctl upgrade to install the new unit.",
                      )}
                    </Callout>
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-around gap-4">
                  {rings.map(([label, v]) => (
                    <div key={label} className="flex flex-col items-center gap-1 text-footnote text-muted-foreground">
                      {v === null ? (
                        <span className="flex h-14 items-center">{tr("未知", "unknown")}</span>
                      ) : (
                        <Ring value={v} tone={usageTone(v)} label={`${label} ${v}%`} />
                      )}
                      {label}
                    </div>
                  ))}
                </div>
                <KV
                  className="mt-4"
                  items={[
                    [
                      tr("负载", "Load"),
                      h.load
                        ? h.load.map((x) => x.toFixed(2)).join(" / ") +
                          (h.cores ? tr(`（${h.cores} 核）`, ` (${h.cores} cores)`) : "")
                        : "—",
                    ],
                    [tr("内存", "Memory"), `${bytes(h.mem_used_bytes)} / ${bytes(h.mem_total_bytes)}`],
                    [
                      tr("磁盘（数据目录）", "Disk (data dir)"),
                      `${bytes(h.disk_used_bytes)} / ${bytes(h.disk_total_bytes)}`,
                    ],
                    [tr("面板进程内存", "Panel RSS"), bytes(h.rss_bytes)],
                    [tr("agent 会话", "Agent sessions"), i.agent_sessions],
                    [tr("数据库连接池", "DB pool"), `${i.db_pool_size - i.db_pool_idle} / ${i.db_pool_size}`],
                    [tr("心跳", "Heartbeat"), ago(i.beat_at, lang)],
                  ]}
                />
              </CardBody>
            </Card>
          );
        })}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="PostgreSQL" actions={<Health ok={s.postgres.ok} />} />
          <CardBody>
            {probe("PostgreSQL", s.postgres.error)}
            <KV
              items={[
                [tr("版本", "Version"), s.postgres.version ?? "—"],
                [tr("延迟", "Latency"), s.postgres.latency_ms != null ? `${s.postgres.latency_ms} ms` : "—"],
                [tr("连接", "Connections"), `${s.postgres.connections ?? "?"} / ${s.postgres.max_connections ?? "?"}`],
                [tr("数据库大小", "Database size"), bytes(s.postgres.database_bytes)],
                [
                  tr("只读副本", "Replica"),
                  s.postgres.in_recovery == null ? "—" : s.postgres.in_recovery ? tr("是", "yes") : tr("否", "no"),
                ],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Valkey" actions={<Health ok={s.valkey.ok} />} />
          <CardBody>
            {probe("Valkey", s.valkey.error)}
            <KV
              items={[
                [tr("版本", "Version"), s.valkey.version ?? "—"],
                [tr("延迟", "Latency"), s.valkey.latency_ms != null ? `${s.valkey.latency_ms} ms` : "—"],
                [
                  tr("内存", "Memory"),
                  `${bytes(s.valkey.used_memory_bytes)}${s.valkey.max_memory_bytes ? ` / ${bytes(s.valkey.max_memory_bytes)}` : ""}`,
                ],
                [tr("客户端", "Clients"), s.valkey.connected_clients ?? "—"],
                [tr("运行", "Uptime"), duration(s.valkey.uptime_secs, lang)],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={tr("反向代理（Caddy）", "Reverse proxy (Caddy)")}
            actions={
              s.caddy.configured ? <Health ok={s.caddy.ok} /> : <Badge>{tr("未配置主域名", "No main domain")}</Badge>
            }
          />
          <CardBody>
            {probe(tr("反向代理", "Proxy"), s.caddy.error)}
            <KV
              items={[
                [tr("主机", "Host"), s.caddy.host ?? "—"],
                [tr("延迟", "Latency"), s.caddy.latency_ms != null ? `${s.caddy.latency_ms} ms` : "—"],
                ["HTTP", s.caddy.http_status ?? "—"],
                [tr("证书到期", "Certificate expires"), dateTime(s.caddy.cert_expires_at)],
              ]}
            />
          </CardBody>
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader
          title={tr("后台任务", "Background jobs")}
          description={tr("各面板实例上的周期任务（合计）", "Periodic jobs across the panel instances")}
        />
        <ul className="divide-y divide-separator">
          {s.jobs.map((j) => {
            const failing = !!(j.last_error_at && (!j.last_ok_at || j.last_error_at > j.last_ok_at));
            return (
              <li key={j.job} className="grid gap-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body font-medium">{jobName(j.job, tr)}</span>
                  <Health
                    ok={!j.stale && !failing}
                    label={j.stale ? tr("停滞", "Stale") : failing ? tr("上次运行出错", "Last run failed") : undefined}
                  />
                </div>
                <div className="text-footnote text-muted-foreground">
                  {tr("上次运行", "last run")} {ago(j.last_run_at, lang)} · {tr("上次成功", "last ok")}{" "}
                  {ago(j.last_ok_at, lang)}
                  {j.lag_secs != null &&
                    tr(` · 距上次成功 ${duration(j.lag_secs, lang)}`, ` · lag ${duration(j.lag_secs, lang)}`)}
                </div>
                {j.backlog && Object.keys(j.backlog).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(j.backlog).map(([k, v]) => (
                      <Badge key={k} tone={k === "dead" && v ? "danger" : "neutral"}>
                        {backlogText(k, v, tr, lang)}
                      </Badge>
                    ))}
                  </div>
                )}
                {j.last_error && (
                  <RawError
                    summary={tr(
                      `最近一次出错：${explainError(j.last_error, tr)}`,
                      `Last error: ${explainError(j.last_error, tr)}`,
                    )}
                    raw={j.last_error}
                    at={j.last_error_at}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      <div className="mt-4">
        <MailQueue deadCount={dead} onTest={() => setTesting(true)} />
      </div>
      {testing && <TestMailDialog onClose={() => setTesting(false)} />}
    </>
  );
}
