// 更新 (UPD-*, DSH-06): one-click update check (status, source, auto
// check), agent releases (upload manifest + signature + binary, delete) and
// staged rollouts (create with waves, per-server state, pause / resume /
// abort); the "new version" badge for the dashboard and node list.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, del, get, post, put, putBinary } from "../../shared/api";
import { bytes, dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Drawer, useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Input,
  PageHeader,
  Progress,
  Select,
  Skeleton,
  Switch,
  type Tone,
} from "../../shared/ui/primitives";
import { DataTable, type Column } from "../../shared/ui/table";
import { FormError, useErrText, useRun } from "../kit";
import { navigate, setQuery, useRoute } from "../router";
import { useServers } from "./nodes";

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
type Status = {
  version: number;
  source_url: string | null;
  default_source_url: string;
  auto_check: boolean;
  next_auto_check_at: string | null;
  checking: boolean;
  keys_configured: boolean;
  last_check: {
    at: string;
    ok: boolean;
    result: string;
    version: string | null;
    code: string | null;
    params: Record<string, unknown> | null;
    message: string | null;
    stored: string[];
  } | null;
  latest: { version: string; platforms: string[] } | null;
  outdated_servers: number;
  update_available: string | null;
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

function useUpdateStatus(poll = false) {
  return useQuery({
    queryKey: ["agent-updates"],
    queryFn: () => get<Status>("/agent-updates"),
    refetchInterval: (q) => (poll || q.state.data?.checking ? 2000 : 60_000),
  });
}

/** "有新版本 vX" when servers run an older agent than the newest stored release. */
export function UpdateBadge() {
  const tr = useTr();
  const s = useUpdateStatus();
  if (!s.data?.update_available) return null;
  return (
    <button type="button" onClick={() => navigate("/updates")}>
      <Badge tone="info">{tr(`有新版本 ${s.data.update_available}`, `New version ${s.data.update_available}`)}</Badge>
    </button>
  );
}

function rolloutTone(s: string): Tone {
  return s === "completed" ? "success" : s === "running" ? "info" : s === "paused" ? "warning" : "danger";
}
function rolloutName(s: string, tr: Tr) {
  return (
    (
      {
        running: tr("进行中", "Running"),
        paused: tr("已暂停", "Paused"),
        halted: tr("已停止（失败过多）", "Halted"),
        aborted: tr("已中止", "Aborted"),
        completed: tr("已完成", "Completed"),
      } as Record<string, string>
    )[s] ?? s
  );
}

export function UpdatesPage() {
  const tr = useTr();
  const { query } = useRoute();
  return (
    <>
      <PageHeader
        title={tr("更新", "Updates")}
        description={tr(
          "agent 自更新：发布（签名校验）与分批灰度。",
          "Agent self-update: signed releases and staged rollouts.",
        )}
      />
      <div className="space-y-4">
        <Rollouts open={query.get("open")} />
        <UpdateCheck />
        <Releases />
      </div>
    </>
  );
}

function UpdateCheck() {
  const tr = useTr();
  const errText = useErrText();
  const s = useUpdateStatus();
  const [source, setSource] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [run, busy] = useRun();
  const qc = useQueryClient();
  const d = s.data;
  // A finished check may have stored releases: re-read the list.
  const checkedAt = d?.last_check?.at;
  useEffect(() => {
    if (checkedAt) void qc.invalidateQueries({ queryKey: ["releases"] });
  }, [checkedAt, qc]);
  if (!d) return <Skeleton className="h-32" />;
  const last = d.last_check;
  return (
    <Card>
      <CardHeader
        title={tr("一键检查更新", "Check for updates")}
        actions={
          <Button
            size="sm"
            icon="refresh"
            loading={d.checking || busy}
            disabled={!d.keys_configured}
            onClick={() =>
              void run(() => post("/agent-updates/check"), {
                ok: tr("正在检查…", "Checking…"),
                invalidate: [["agent-updates"]],
              })
            }
          >
            {tr("检查更新", "Check now")}
          </Button>
        }
      />
      <CardBody className="space-y-3 text-[13px]">
        {!d.keys_configured && (
          <Callout tone="warning">
            {tr(
              "没有信任的发布公钥（系统设置 → 安全）：无法校验发布。",
              "No trusted release key (Settings → Security): releases cannot be verified.",
            )}
          </Callout>
        )}
        <p>
          {tr("上次检查：", "Last check: ")}
          {last ? (
            <>
              {dateTime(last.at)} ·{" "}
              {last.ok ? (
                last.result === "stored" ? (
                  tr(
                    `已保存 ${last.version}（${last.stored.join(", ")}）`,
                    `stored ${last.version} (${last.stored.join(", ")})`,
                  )
                ) : (
                  tr("已是最新", "up to date")
                )
              ) : (
                <span className="text-destructive">
                  {last.code
                    ? errText(
                        new ApiError(400, last.message ?? last.code, { code: last.code, params: last.params ?? {} }),
                      )
                    : last.message}
                </span>
              )}
            </>
          ) : (
            tr("从未", "never")
          )}
        </p>
        {d.latest && (
          <p>
            {tr(
              `最新发布 ${d.latest.version}（${d.latest.platforms.join(", ")}）；${d.outdated_servers} 台服务器较旧`,
              `Newest release ${d.latest.version} (${d.latest.platforms.join(", ")}); ${d.outdated_servers} servers older`,
            )}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={tr(
              "发布源（GitHub 最新发布 API，留空 = 官方）",
              "Source (GitHub latest-release API; empty = official)",
            )}
          >
            <Input
              value={source ?? d.source_url ?? ""}
              placeholder={d.default_source_url}
              onChange={(e) => setSource(e.target.value)}
            />
          </Field>
          <label className="flex items-end gap-2 pb-2">
            <Switch
              checked={auto ?? d.auto_check}
              onChange={setAuto}
              label={tr("自动检查（每 6 小时）", "Check automatically (6 h)")}
            />
            {tr("自动检查（每 6 小时）", "Check automatically (every 6 h)")}
          </label>
        </div>
        <Button
          size="sm"
          loading={busy}
          onClick={() =>
            void run(
              () =>
                put("/agent-updates/settings", {
                  version: d.version,
                  source_url: (source ?? d.source_url ?? "").trim() || null,
                  auto_check: auto ?? d.auto_check,
                }),
              { ok: tr("已保存", "Saved"), invalidate: [["agent-updates"]] },
            ).then((r) => {
              if (r !== undefined) {
                setSource(null);
                setAuto(null);
              }
            })
          }
        >
          {tr("保存", "Save")}
        </Button>
      </CardBody>
    </Card>
  );
}

function Releases() {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const q = useQuery({ queryKey: ["releases"], queryFn: () => get<Release[]>("/agent-releases") });
  const [manifest, setManifest] = useState<File | null>(null);
  const [sig, setSig] = useState<File | null>(null);
  const [binary, setBinary] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const upload = async () => {
    if (!manifest || !sig || !binary) return;
    setError(null);
    try {
      const created = await post<Release>("/agent-releases", {
        manifest: await manifest.text(),
        sig: JSON.parse(await sig.text()) as unknown,
      });
      await putBinary(`/agent-releases/${created.id}/binary`, binary);
      toast({ tone: "success", title: tr(`已上传 ${created.version}`, `Uploaded ${created.version}`) });
      setManifest(null);
      setSig(null);
      setBinary(null);
    } catch (e) {
      setError(e);
    }
    void run(async () => undefined, { invalidate: [["releases"], ["agent-updates"]] });
  };
  const columns: Column<Release>[] = [
    {
      key: "version",
      header: tr("版本", "Version"),
      fixed: true,
      mobile: "title",
      cell: (r) => (
        <span className="flex gap-1">
          {r.version}
          {r.rollback && <Badge tone="warning">{tr("回滚", "rollback")}</Badge>}
        </span>
      ),
    },
    { key: "platform", header: tr("平台", "Platform"), cell: (r) => `${r.os}/${r.arch}` },
    { key: "size", header: tr("大小", "Size"), cell: (r) => bytes(r.size) },
    {
      key: "complete",
      header: tr("状态", "State"),
      cell: (r) => (
        <Badge tone={r.complete ? "success" : "warning"}>
          {r.complete ? tr("完整", "Complete") : tr("缺二进制", "No binary")}
        </Badge>
      ),
    },
    {
      key: "key",
      header: tr("签名公钥", "Key"),
      optional: true,
      cell: (r) => <code className="text-xs">{r.key_id}</code>,
    },
    { key: "created", header: tr("时间", "Created"), cell: (r) => dateTime(r.created_at) },
    {
      key: "del",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      fixed: true,
      cell: (r) => (
        <Button
          size="sm"
          variant="destructive-soft"
          icon="trash"
          aria-label={tr(`删除 ${r.version} ${r.arch}`, `Delete ${r.version} ${r.arch}`)}
          onClick={async () => {
            const ok = await confirm({
              title: tr(`删除发布 ${r.version}（${r.os}/${r.arch}）？`, `Delete ${r.version} (${r.os}/${r.arch})?`),
              action: () => del(`/agent-releases/${r.id}`),
            });
            if (ok) void run(async () => undefined, { ok: tr("已删除", "Deleted"), invalidate: [["releases"]] });
          }}
        />
      ),
    },
  ];
  return (
    <Card>
      <CardHeader title={tr("Agent 发布", "Agent releases")} />
      <CardBody>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={tr("清单（manifest）", "Manifest")}>
            <Input type="file" accept=".json" onChange={(e) => setManifest(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label={tr("签名", "Signature")}>
            <Input type="file" accept=".sig" onChange={(e) => setSig(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label={tr("二进制", "Binary")}>
            <Input type="file" onChange={(e) => setBinary(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" icon="upload" loading={busy} disabled={!manifest || !sig || !binary} onClick={upload}>
            {tr("上传", "Upload")}
          </Button>
          <FormError error={error} />
        </div>
      </CardBody>
      <div className="border-t border-border">
        <DataTable
          label={tr("发布", "Releases")}
          rows={q.data ?? []}
          columns={columns}
          loading={q.isPending}
          error={q.error}
        />
      </div>
    </Card>
  );
}

function Rollouts({ open }: { open: string | null }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["rollouts"],
    queryFn: () => get<Rollout[]>("/rollouts"),
    refetchInterval: (s) => ((s.state.data ?? []).some((r) => r.status === "running") ? 5000 : 30_000),
  });
  const [creating, setCreating] = useState(false);
  const columns: Column<Rollout>[] = [
    { key: "version", header: tr("版本", "Version"), fixed: true, mobile: "title", cell: (r) => r.version },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (r) => <Badge tone={rolloutTone(r.status)}>{rolloutName(r.status, tr)}</Badge>,
    },
    {
      key: "progress",
      header: tr("进度", "Progress"),
      cell: (r) => {
        const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
        const done = (r.counts.healthy ?? 0) + (r.counts.skipped ?? 0);
        return (
          <span className="flex items-center gap-2 text-xs">
            <Progress value={total ? (done / total) * 100 : 0} className="w-24" />
            {tr(`${done}/${total} · 失败 ${r.counts.failed ?? 0}`, `${done}/${total} · ${r.counts.failed ?? 0} failed`)}
          </span>
        );
      },
    },
    { key: "wave", header: tr("波次", "Wave"), cell: (r) => `${r.current_wave + 1} / ${r.waves.length}` },
    { key: "created", header: tr("创建", "Created"), cell: (r) => dateTime(r.created_at) },
  ];
  return (
    <Card>
      <CardHeader
        title={tr("灰度更新", "Rollouts")}
        actions={
          <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
            {tr("新建灰度", "New rollout")}
          </Button>
        }
      />
      <DataTable
        label={tr("灰度", "Rollouts")}
        rows={q.data ?? []}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        onRowClick={(r) => setQuery({ open: r.id }, false)}
        activeId={open}
      />
      {creating && <CreateRollout onClose={() => setCreating(false)} />}
      {open && <RolloutDrawer id={open} onClose={() => setQuery({ open: null })} />}
    </Card>
  );
}

function CreateRollout({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const releases = useQuery({ queryKey: ["releases"], queryFn: () => get<Release[]>("/agent-releases") });
  const servers = useServers();
  const versions = [...new Set((releases.data ?? []).filter((r) => r.complete).map((r) => r.version))];
  const [version, setVersion] = useState("");
  const [pct, setPct] = useState("100");
  const [waves, setWaves] = useState("10,50,100");
  const [timeout, setTimeoutS] = useState("600");
  const [ratio, setRatio] = useState("0.2");
  const [subset, setSubset] = useState<string[]>([]);
  const [run, busy] = useRun();
  const first = versions[0] ?? "";
  useEffect(() => {
    if (!version && first) setVersion(first);
  }, [version, first]);
  const submit = async () => {
    const body: Record<string, unknown> = {
      version,
      waves: waves
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number),
      health_timeout_secs: Number(timeout),
      max_failure_ratio: Number(ratio),
    };
    if (subset.length) body.server_ids = subset;
    else body.percentage = Number(pct);
    const r = await run(() => post("/rollouts", body), {
      ok: tr("灰度已开始", "Rollout started"),
      invalidate: [["rollouts"]],
    });
    if (r !== undefined) onClose();
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title={tr("新建灰度", "New rollout")}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button variant="primary" loading={busy} disabled={!version} onClick={submit}>
            {tr("开始", "Start")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={tr("版本", "Version")}>
          <Select value={version} onChange={(e) => setVersion(e.target.value)}>
            {versions.length === 0 && <option value="">{tr("没有完整的发布", "No complete release")}</option>}
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("覆盖比例（%）", "Coverage (%)")}>
            <Input
              inputMode="numeric"
              value={pct}
              disabled={subset.length > 0}
              onChange={(e) => setPct(e.target.value)}
            />
          </Field>
          <Field label={tr("分批（累计 %，逗号分隔）", "Waves (cumulative %, comma separated)")}>
            <Input value={waves} onChange={(e) => setWaves(e.target.value)} />
          </Field>
          <Field label={tr("健康超时（秒）", "Health timeout (s)")}>
            <Input inputMode="numeric" value={timeout} onChange={(e) => setTimeoutS(e.target.value)} />
          </Field>
          <Field label={tr("最大失败比例", "Max failure ratio")}>
            <Input inputMode="decimal" value={ratio} onChange={(e) => setRatio(e.target.value)} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium">
            {tr("只更新这些服务器（可选）", "Only these servers (optional)")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {(servers.data ?? []).map((s) => (
              <label
                key={s.id}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[13px]"
              >
                <Checkbox
                  checked={subset.includes(s.id)}
                  label={s.name}
                  onChange={(on) => setSubset(on ? [...subset, s.id] : subset.filter((x) => x !== s.id))}
                />
                {s.name} <span className="text-xs text-muted-foreground">{s.agent_version ?? ""}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Drawer>
  );
}

function RolloutDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const [run] = useRun();
  const q = useQuery({
    queryKey: ["rollouts", id],
    queryFn: () => get<Rollout & { servers: RolloutServer[] }>(`/rollouts/${id}`),
    refetchInterval: 5000,
  });
  const r = q.data;
  const act = async (what: "pause" | "resume" | "abort") => {
    if (
      what === "abort" &&
      !(await confirm({
        title: tr("中止灰度？", "Abort the rollout?"),
        description: tr("已更新的服务器保持新版本。", "Updated servers keep the new version."),
      }))
    )
      return;
    await run(() => post(`/rollouts/${id}/${what}`), { ok: tr("已执行", "Done"), invalidate: [["rollouts"]] });
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title={r ? tr(`灰度 ${r.version}`, `Rollout ${r.version}`) : tr("灰度", "Rollout")}
      subtitle={r && <Badge tone={rolloutTone(r.status)}>{rolloutName(r.status, tr)}</Badge>}
      footer={
        r && (
          <>
            {r.status === "running" && <Button onClick={() => void act("pause")}>{tr("暂停", "Pause")}</Button>}
            {(r.status === "paused" || r.status === "halted") && (
              <Button onClick={() => void act("resume")}>{tr("继续", "Resume")}</Button>
            )}
            {["running", "paused", "halted"].includes(r.status) && (
              <Button variant="destructive-soft" onClick={() => void act("abort")}>
                {tr("中止", "Abort")}
              </Button>
            )}
          </>
        )
      }
    >
      {q.isPending && <Skeleton className="h-40" />}
      {r?.halted_reason && <Callout tone="danger">{r.halted_reason}</Callout>}
      <ul className="mt-2 divide-y divide-border rounded-md border border-border text-[13px]">
        {r?.servers.map((s) => (
          <li key={s.server_id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
            <span className="font-medium">{s.name}</span>
            <Badge>{tr(`第 ${s.wave + 1} 批`, `wave ${s.wave + 1}`)}</Badge>
            <Badge tone={s.status === "healthy" ? "success" : s.status === "failed" ? "danger" : "info"}>
              {s.status}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {s.from_version ?? "?"} → {s.agent_version ?? "?"}
            </span>
            {s.detail && <span className="w-full text-xs text-muted-foreground">{s.detail}</span>}
          </li>
        ))}
      </ul>
    </Drawer>
  );
}
