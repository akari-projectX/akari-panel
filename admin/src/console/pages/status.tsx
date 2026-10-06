// 系统状态 (ST-*, W31): panel instances (host CPU / memory / load / disk,
// process RSS, version, agent sessions), PostgreSQL, Valkey, the reverse
// proxy, and the background jobs (last run, lag, stale, last error,
// backlog); dead letters link to the mail test.
import { useQuery } from "@tanstack/react-query";
import { get } from "../../shared/api";
import { ago, bytes, dateTime, duration, pct } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Ring } from "../../shared/ui/charts";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  KV,
  PageHeader,
  Skeleton,
  usageTone,
} from "../../shared/ui/primitives";
import { navigate } from "../router";

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
  const s = q.data;
  const header = (
    <PageHeader
      title={tr("系统状态", "System status")}
      description={s && tr(`更新于 ${dateTime(s.generated_at)}`, `Updated ${dateTime(s.generated_at)}`)}
      actions={
        <Button size="sm" icon="refresh" onClick={() => void q.refetch()}>
          {tr("刷新", "Refresh")}
        </Button>
      }
    />
  );
  if (q.isError)
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
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </>
    );
  const mail = s.jobs.find((j) => j.job === "mail");
  const dead = mail?.backlog?.dead ?? 0;
  return (
    <>
      {header}
      {dead ? (
        <div className="mb-4">
          <Callout tone="warning" title={tr(`${dead} 封邮件发送失败（死信）`, `${dead} mails failed (dead letters)`)}>
            <div className="mt-1 flex gap-2">
              <Button size="sm" onClick={() => navigate("/settings/mail?outbox=dead")}>
                {tr("查看失败邮件", "Failed mail")}
              </Button>
              <Button size="sm" onClick={() => navigate("/settings/mail")}>
                {tr("测试发信", "Test mail")}
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}
      {s.instances_error && (
        <div className="mb-4">
          <Callout tone="danger">{s.instances_error}</Callout>
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {s.instances.map((i) => {
          const h = i.host;
          const mem = h.mem_total_bytes ? pct(h.mem_used_bytes ?? 0, h.mem_total_bytes) : null;
          const disk = h.disk_total_bytes ? pct(h.disk_used_bytes ?? 0, h.disk_total_bytes) : null;
          return (
            <Card key={i.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {h.hostname ?? i.id.slice(0, 8)}
                    {i.this && <Badge tone="primary">{tr("当前实例", "This instance")}</Badge>}
                  </span>
                }
                description={`v${i.version} (${i.git_sha.slice(0, 12)}) · ${tr("运行", "up")} ${duration((Date.now() - Date.parse(i.started_at)) / 1000, lang)}`}
                actions={<Health ok={i.alive} label={i.alive ? tr("在线", "Alive") : tr("失联", "Lost")} />}
              />
              <CardBody>
                <div className="flex flex-wrap items-center justify-around gap-4">
                  {[
                    ["CPU", h.cpu_percent == null ? null : Math.round(h.cpu_percent)],
                    [tr("内存", "Memory"), mem],
                    [tr("磁盘", "Disk"), disk],
                  ].map(([label, v]) => (
                    <div key={String(label)} className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
                      {v === null ? (
                        <span className="flex h-14 items-center">{tr("未知", "unknown")}</span>
                      ) : (
                        <Ring
                          value={v as number}
                          tone={usageTone(v as number) === "primary" ? "primary" : usageTone(v as number)}
                          label={`${label} ${v}%`}
                        />
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
            {s.postgres.error && <p className="mb-2 text-[13px] text-destructive">{s.postgres.error}</p>}
            <KV
              items={[
                [tr("版本", "Version"), s.postgres.version ?? "—"],
                [tr("延迟", "Latency"), s.postgres.latency_ms != null ? `${s.postgres.latency_ms} ms` : "—"],
                [tr("连接", "Connections"), `${s.postgres.connections ?? "?"} / ${s.postgres.max_connections ?? "?"}`],
                [tr("数据库大小", "Database size"), bytes(s.postgres.database_bytes)],
                [tr("只读副本", "Replica"), s.postgres.in_recovery ? tr("是", "yes") : tr("否", "no")],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Valkey" actions={<Health ok={s.valkey.ok} />} />
          <CardBody>
            {s.valkey.error && <p className="mb-2 text-[13px] text-destructive">{s.valkey.error}</p>}
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
            {s.caddy.error && <p className="mb-2 text-[13px] text-destructive">{s.caddy.error}</p>}
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
        <CardHeader title={tr("后台任务", "Background jobs")} />
        <ul className="divide-y divide-border">
          {s.jobs.map((j) => (
            <li key={j.job} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px] sm:px-5">
              <span className="w-36 font-medium">{jobName(j.job, tr)}</span>
              <Health
                ok={!j.stale && !(j.last_error_at && (!j.last_ok_at || j.last_error_at > j.last_ok_at))}
                label={j.stale ? tr("停滞", "Stale") : undefined}
              />
              <span className="text-xs text-muted-foreground">
                {tr("上次运行", "last run")} {ago(j.last_run_at, lang)} · {tr("上次成功", "last ok")}{" "}
                {ago(j.last_ok_at, lang)}
                {j.lag_secs != null && tr(` · 延迟 ${j.lag_secs} 秒`, ` · lag ${j.lag_secs}s`)}
              </span>
              {j.backlog && (
                <span className="text-xs text-muted-foreground">
                  {Object.entries(j.backlog)
                    .map(([k, v]) => `${k}: ${v ?? "—"}`)
                    .join(" · ")}
                </span>
              )}
              {j.last_error && (
                <span className="w-full text-xs text-destructive">
                  {j.last_error} ({dateTime(j.last_error_at)})
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
