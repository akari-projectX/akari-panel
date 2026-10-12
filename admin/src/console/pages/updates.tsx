// 更新 (UPD-*; audit §5.13): in working order — check for updates, the
// agent releases (upload manifest + signature + binary with progress,
// delete), staged rollouts (create with validated waves and a "N servers"
// confirmation; per-server state; pause / resume / abort). The release
// source and the auto check live in 系统设置 → 节点 → 更新源与验签.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  PackageOpen,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Settings2,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError, del, get, post } from "../../shared/api";
import { apiBase } from "../../shared/base";
import { bytes, dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardBody, CardHeader } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Select } from "../../shared/ui/form";
import { Callout, KV, PageHeader } from "../../shared/ui/layout";
import { Meter } from "../../shared/ui/meter";
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from "../../shared/ui/states";
import { DataTable, type Column } from "../../shared/ui/table";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { useErrText } from "../kit";
import { setQuery, useRoute } from "../router";
import { useServers } from "../servers";
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

function rolloutTone(s: string): Tone {
  return s === "completed" ? "success" : s === "running" ? "info" : s === "paused" ? "warning" : "danger";
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
function serverState(s: string, tr: Tr): [string, Tone] {
  return (
    (
      {
        pending: [tr("等待", "Waiting"), "neutral"],
        offered: [tr("已下发", "Offered"), "info"],
        updating: [tr("更新中", "Updating"), "info"],
        healthy: [tr("已更新", "Updated"), "success"],
        failed: [tr("失败", "Failed"), "danger"],
        skipped: [tr("已跳过", "Skipped"), "neutral"],
      } as Record<string, [string, Tone]>
    )[s] ?? [s, "neutral"]
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
          "agent 自更新：先检查更新（或手动上传发布），再分批灰度。",
          "Agent self-update: check for updates (or upload a release), then roll out in waves.",
        )}
        actions={
          <Button size="sm" variant="ghost" icon={Settings2} asChild>
            <Link to="/settings/updates">{tr("更新源与验签", "Source and keys")}</Link>
          </Button>
        }
      />
      <div className="grid gap-4">
        <UpdateCheck />
        <Releases />
        <Rollouts open={query.get("open")} />
      </div>
    </>
  );
}

function UpdateCheck() {
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
  const last = d?.last_check;
  return (
    <Card>
      <CardHeader
        title={tr("1. 检查更新", "1. Check for updates")}
        description={tr(
          "从发布源取最新的 agent，验签后存为发布；不会自动开始灰度。",
          "Fetches the newest agent from the source and stores it after verifying; never starts a rollout.",
        )}
        actions={
          d && (
            <Button
              size="sm"
              variant="primary"
              icon={RefreshCw}
              loading={d.checking || busy}
              disabled={!d.keys_configured}
              onClick={() =>
                void run(() => post("/agent-updates/check"), {
                  ok: tr("正在检查…", "Checking…"),
                })
              }
            >
              {d.checking ? tr("检查中…", "Checking…") : tr("检查更新", "Check now")}
            </Button>
          )
        }
      />
      <CardBody className="grid gap-3">
        {s.isError && !d ? (
          <ErrorState compact error={s.error} onRetry={() => void s.refetch()} />
        ) : !d ? (
          <LoadingBlock rows={3} />
        ) : (
          <>
            {!d.keys_configured && (
              <Callout tone="warning">
                {tr("没有信任的发布公钥，无法校验发布。", "No trusted release key: releases cannot be verified.")}{" "}
                <Link to="/settings/updates" className="text-primary hover:underline">
                  {tr("去添加发布公钥", "Add a release key")}
                </Link>
              </Callout>
            )}
            <KV
              items={[
                [
                  tr("上次检查", "Last check"),
                  <span key="l">
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
                                  new ApiError(400, last.message ?? last.code, {
                                    code: last.code,
                                    params: last.params ?? {},
                                  }),
                                )
                              : tr("检查失败", "Check failed")}
                          </span>
                        )}
                      </>
                    ) : (
                      tr("从未", "never")
                    )}
                  </span>,
                ],
                [
                  tr("最新发布", "Newest release"),
                  d.latest
                    ? tr(
                        `最新发布 ${d.latest.version}（${d.latest.platforms.join(", ")}）；${d.outdated_servers} 台服务器较旧`,
                        `Newest release ${d.latest.version} (${d.latest.platforms.join(", ")}); ${d.outdated_servers} servers older`,
                      )
                    : tr("还没有发布", "No release yet"),
                ],
                [
                  tr("发布源", "Source"),
                  <span key="s" className="break-all">
                    {d.source_url ?? tr(`官方（${d.default_source_url}）`, `official (${d.default_source_url})`)}
                  </span>,
                ],
                [
                  tr("自动检查", "Auto check"),
                  d.auto_check
                    ? tr(
                        `每 6 小时 · 下次 ${dateTime(d.next_auto_check_at)}`,
                        `every 6 h · next ${dateTime(d.next_auto_check_at)}`,
                      )
                    : tr("关闭", "off"),
                ],
              ]}
            />
            {last && !last.ok && last.message && (
              <details className="text-footnote text-muted-foreground">
                <summary className="cursor-pointer select-none">{tr("原始信息", "Details")}</summary>
                <code className="mt-1 block rounded-md bg-window px-2 py-1.5 font-mono break-all">{last.message}</code>
              </details>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
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

function ReleaseDelete({ r, rollouts }: { r: Release; rollouts: Rollout[] | undefined }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const using = (rollouts ?? []).filter((x) => x.version === r.version && OPEN.includes(x.status));
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      icon={Trash2}
      className="text-destructive"
      aria-label={tr(`删除 ${r.version} ${r.arch}`, `Delete ${r.version} ${r.arch}`)}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await confirm({
          title: tr(`删除发布 ${r.version}（${r.os}/${r.arch}）？`, `Delete ${r.version} (${r.os}/${r.arch})?`),
          description: tr(
            "删除后这个平台的服务器不能再更新到此版本，一键安装也改用其他版本；可以重新检查更新或手动上传。",
            "Servers on this platform can no longer update to it and installs use another version; check again or upload it to restore.",
          ),
          impact:
            using.length > 0
              ? tr(
                  `有未结束的灰度在使用 ${r.version}：先中止它，否则面板会拒绝删除。`,
                  `An open rollout uses ${r.version}: abort it first or the panel refuses.`,
                )
              : tr("没有未结束的灰度使用这个版本。", "No open rollout uses this version."),
          typeToConfirm: r.version,
          confirmLabel: tr("删除", "Delete"),
          action: () => del(`/agent-releases/${r.id}`),
        });
        if (ok) toast({ tone: "success", title: tr("已删除", "Deleted") });
      }}
    />
  );
}

function Releases() {
  const tr = useTr();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["releases"], queryFn: () => get<Release[]>("/agent-releases") });
  const rollouts = useQuery({ queryKey: ["rollouts"], queryFn: () => get<Rollout[]>("/rollouts") });
  const [manifest, setManifest] = useState<File | null>(null);
  const [sig, setSig] = useState<File | null>(null);
  const [binary, setBinary] = useState<File | null>(null);
  const [inputs, setInputs] = useState(0);
  const [stage, setStage] = useState<null | "manifest" | number>(null);
  const [error, setError] = useState<unknown>(null);
  const errText = useErrText();
  const busy = stage !== null;
  const upload = async () => {
    if (!manifest || !sig || !binary || busy) return;
    setError(null);
    setStage("manifest");
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
      setManifest(null);
      setSig(null);
      setBinary(null);
      setInputs((n) => n + 1);
    } catch (e) {
      setError(e);
      void qc.invalidateQueries({ queryKey: ["releases"] });
    } finally {
      setStage(null);
    }
  };
  const columns: Column<Release>[] = [
    {
      key: "version",
      header: tr("版本", "Version"),
      fixed: true,
      mobile: "title",
      cell: (r) => (
        <span className="flex items-center gap-1.5">
          {r.version}
          {r.rollback && <Badge tone="warning">{tr("回滚版", "Rollback")}</Badge>}
        </span>
      ),
    },
    { key: "platform", header: tr("平台", "Platform"), cell: (r) => `${r.os}/${r.arch}` },
    { key: "size", header: tr("大小", "Size"), align: "right", cell: (r) => bytes(r.size) },
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
      cell: (r) => <code className="font-mono text-footnote">{r.key_id}</code>,
    },
    { key: "created", header: tr("时间", "Created"), cell: (r) => dateTime(r.created_at) },
    {
      key: "del",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      fixed: true,
      align: "right",
      cell: (r) => <ReleaseDelete r={r} rollouts={rollouts.data} />,
    },
  ];
  return (
    <Card>
      <CardHeader
        title={tr("2. Agent 发布", "2. Agent releases")}
        description={tr(
          "检查更新会自动存入；也可以手动上传 manifest + 签名 + 二进制（高级）。",
          "Checks store them automatically; or upload manifest + signature + binary by hand (advanced).",
        )}
      />
      <CardBody>
        <form
          className="grid gap-3"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void upload();
          }}
        >
          <div key={inputs} className="grid gap-3 sm:grid-cols-3">
            <Field label={tr("清单（manifest）", "Manifest")}>
              <Input
                type="file"
                accept=".json"
                disabled={busy}
                onChange={(e) => setManifest(e.target.files?.[0] ?? null)}
              />
            </Field>
            <Field label={tr("签名", "Signature")}>
              <Input type="file" accept=".sig" disabled={busy} onChange={(e) => setSig(e.target.files?.[0] ?? null)} />
            </Field>
            <Field label={tr("二进制", "Binary")} hint={binary ? bytes(binary.size) : undefined}>
              <Input type="file" disabled={busy} onChange={(e) => setBinary(e.target.files?.[0] ?? null)} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" icon={Upload} loading={busy} disabled={!manifest || !sig || !binary}>
              {tr("上传", "Upload")}
            </Button>
            {stage === "manifest" && (
              <span className="text-footnote text-muted-foreground" role="status">
                {tr("正在校验清单与签名…", "Verifying the manifest and signature…")}
              </span>
            )}
            {typeof stage === "number" && (
              <span
                className="flex min-w-48 flex-1 items-center gap-2 text-footnote text-muted-foreground"
                role="status"
              >
                <Meter value={stage} className="flex-1" label={tr("上传进度", "Upload progress")} />
                <span className="tnum">{stage}%</span>
              </span>
            )}
          </div>
          {error ? (
            <p role="alert" className="text-body text-destructive">
              {errText(error)}
            </p>
          ) : null}
        </form>
      </CardBody>
      <div className="border-t border-separator">
        <DataTable
          label={tr("发布", "Releases")}
          rows={q.data ?? []}
          columns={columns}
          loading={q.isPending}
          error={q.error}
          onRetry={() => void q.refetch()}
          empty={
            <EmptyState
              icon={PackageOpen}
              title={tr("还没有发布", "No releases yet")}
              description={tr(
                "点上面的「检查更新」取官方发布。",
                "Use “Check now” above to fetch the official release.",
              )}
            />
          }
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
  const busyRollout = (q.data ?? []).find((r) => OPEN.includes(r.status));
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
          <span className="flex items-center gap-2 text-footnote">
            <Meter value={total ? (done / total) * 100 : 0} className="w-20 sm:w-24" />
            {tr(`${done}/${total} · 失败 ${r.counts.failed ?? 0}`, `${done}/${total} · ${r.counts.failed ?? 0} failed`)}
          </span>
        );
      },
    },
    {
      key: "wave",
      header: tr("批次", "Wave"),
      cell: (r) => tr(`第 ${r.current_wave + 1} / ${r.waves.length} 批`, `${r.current_wave + 1} / ${r.waves.length}`),
    },
    { key: "created", header: tr("创建", "Created"), cell: (r) => dateTime(r.created_at) },
  ];
  return (
    <Card>
      <CardHeader
        title={tr("3. 灰度更新", "3. Rollouts")}
        description={tr(
          "按批次把服务器更新到某个版本；失败过多会自动停止。同一时间只能有一个未结束的灰度。",
          "Updates servers in waves; stops by itself on too many failures. One open rollout at a time.",
        )}
        actions={
          <Button
            size="sm"
            variant="primary"
            icon={Plus}
            onClick={() => setCreating(true)}
            disabled={!!busyRollout}
            title={busyRollout ? tr("先结束当前的灰度", "Finish the open rollout first") : undefined}
          >
            {tr("新建灰度", "New rollout")}
          </Button>
        }
      />
      <div className="border-t border-separator">
        <DataTable
          label={tr("灰度", "Rollouts")}
          rows={q.data ?? []}
          columns={columns}
          loading={q.isPending}
          error={q.error}
          onRetry={() => void q.refetch()}
          onRowClick={(r) => setQuery({ open: r.id }, false)}
          activeId={open}
          rowProps={() => ({ "data-rollout": "" })}
          empty={
            <EmptyState
              icon={Rocket}
              title={tr("还没有灰度", "No rollouts yet")}
              description={tr(
                "有完整的发布后，新建一个灰度把服务器更新过去。",
                "With a complete release, start a rollout.",
              )}
            />
          }
        />
      </div>
      {creating && <CreateRollout onClose={() => setCreating(false)} />}
      {open && <RolloutDialog id={open} onClose={() => setQuery({ open: null })} />}
    </Card>
  );
}

/** Field checks of the new-rollout form (null = fine). */
function checkWaves(text: string, tr: Tr): string | null {
  const parts = text.split(/[\s,，]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 10) return tr("填 1–10 个累计百分比", "1–10 cumulative percentages");
  if (!parts.every((p) => /^\d+$/.test(p))) return tr("只能填整数，用逗号分隔", "Whole numbers, comma separated");
  const n = parts.map(Number);
  for (let i = 0; i < n.length; i++)
    if (n[i] < 1 || n[i] > 100 || (i > 0 && n[i] <= n[i - 1]))
      return tr("必须在 1–100 之间且逐个增大", "1–100, strictly ascending");
  if (n[n.length - 1] !== 100) return tr("最后一批必须是 100", "The last wave must be 100");
  return null;
}
function intIn(text: string, lo: number, hi: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const v = Number(text.trim());
  return v >= lo && v <= hi ? v : null;
}

function CreateRollout({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const releases = useQuery({ queryKey: ["releases"], queryFn: () => get<Release[]>("/agent-releases") });
  const servers = useServers();
  const versions = [...new Set((releases.data ?? []).filter((r) => r.complete).map((r) => r.version))];
  const [version, setVersion] = useState("");
  const [pct, setPct] = useState("100");
  const [waves, setWaves] = useState("10,50,100");
  const [timeout, setTimeoutS] = useState("600");
  const [ratio, setRatio] = useState("0.2");
  const [subset, setSubset] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const first = versions[0] ?? "";
  useEffect(() => {
    if (!version && first) setVersion(first);
  }, [version, first]);
  // Eligible = enrolled, not being deleted (rollout.rs create).
  const eligible = (servers.data ?? []).filter((s) => s.enrolled && !s.deleting_at);
  const errs = {
    version: !version ? tr("先选一个完整的发布", "Pick a complete release") : null,
    pct: subset.length === 0 && intIn(pct, 1, 100) === null ? tr("1–100 的整数", "A whole number 1–100") : null,
    waves: checkWaves(waves, tr),
    timeout: intIn(timeout, 30, 86400) === null ? tr("30–86400 的整数（秒）", "Whole seconds 30–86400") : null,
    ratio: !/^(0(\.\d+)?|1(\.0+)?)$/.test(ratio.trim())
      ? tr("0 到 1 之间的小数，如 0.2", "A decimal 0–1, e.g. 0.2")
      : null,
  };
  const bad = Object.values(errs).filter(Boolean).length;
  const show = (k: keyof typeof errs, touched: boolean) => ((tried || touched) && errs[k]) || undefined;
  const affected = subset.length
    ? subset.length
    : Math.max(1, Math.ceil((eligible.length * (intIn(pct, 1, 100) ?? 0)) / 100));
  const submit = async () => {
    setTried(true);
    if (bad || busy) return;
    const ok = await confirm({
      title: tr(`开始灰度 ${version}？`, `Start rolling out ${version}?`),
      description: tr(
        "服务器会按批次下载并安装新版本；失败比例超过阈值时自动停止。",
        "Servers download and install the new version in waves; it stops by itself above the failure ratio.",
      ),
      impact: tr(`将影响 ${affected} 台服务器`, `Affects ${affected} server(s)`),
      impacts: [
        {
          label: tr("批次（累计 %）", "Waves (cumulative %)"),
          value: waves
            .split(/[\s,，]+/)
            .filter(Boolean)
            .join(" → "),
        },
        { label: tr("健康超时", "Health timeout"), value: tr(`${timeout} 秒`, `${timeout} s`) },
        { label: tr("最大失败比例", "Max failure ratio"), value: ratio },
      ],
      tone: "warning",
      confirmLabel: tr("开始", "Start"),
    });
    if (!ok) return;
    const body: Record<string, unknown> = {
      version,
      waves: waves
        .split(/[\s,，]+/)
        .filter(Boolean)
        .map(Number),
      health_timeout_secs: Number(timeout),
      max_failure_ratio: Number(ratio),
    };
    if (subset.length) body.server_ids = subset;
    else body.percentage = Number(pct);
    const r = await run(() => post("/rollouts", body), { ok: tr("灰度已开始", "Rollout started") });
    if (r !== undefined) onClose();
  };
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      icon={Rocket}
      title={tr("新建灰度", "New rollout")}
      onSubmit={() => void submit()}
      footer={
        <>
          {tried && bad > 0 && (
            <span className="mr-auto text-footnote text-destructive">{tr(`${bad} 处需要修正`, `${bad} to fix`)}</span>
          )}
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={tried && bad > 0}>
            {tr("开始", "Start")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label={tr("版本", "Version")} error={show("version", false)}>
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
          <Field
            label={tr("覆盖比例（%）", "Coverage (%)")}
            hint={
              subset.length
                ? tr("已选择服务器：比例不生效", "Servers picked: coverage ignored")
                : tr(`共 ${eligible.length} 台已注册服务器`, `${eligible.length} enrolled servers`)
            }
            error={show("pct", !!touched.pct)}
          >
            <Input
              inputMode="numeric"
              value={pct}
              disabled={subset.length > 0}
              onChange={(e) => setPct(e.target.value)}
              onBlur={blur("pct")}
            />
          </Field>
          <Field
            label={tr("分批（累计 %，逗号分隔）", "Waves (cumulative %, comma separated)")}
            hint={tr("如 10,50,100：先 10%，再到 50%，最后全部", "e.g. 10,50,100")}
            error={show("waves", !!touched.waves)}
          >
            <Input value={waves} onChange={(e) => setWaves(e.target.value)} onBlur={blur("waves")} />
          </Field>
          <Field label={tr("健康超时（秒）", "Health timeout (s)")} error={show("timeout", !!touched.timeout)}>
            <Input
              inputMode="numeric"
              value={timeout}
              onChange={(e) => setTimeoutS(e.target.value)}
              onBlur={blur("timeout")}
            />
          </Field>
          <Field
            label={tr("最大失败比例", "Max failure ratio")}
            hint={tr("超过即自动停止，0–1", "Stops above it, 0–1")}
            error={show("ratio", !!touched.ratio)}
          >
            <Input
              inputMode="decimal"
              value={ratio}
              onChange={(e) => setRatio(e.target.value)}
              onBlur={blur("ratio")}
            />
          </Field>
        </div>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-footnote font-medium text-muted-foreground">
            {tr("只更新这些服务器（可选）", "Only these servers (optional)")}
          </legend>
          {servers.isPending ? (
            <Skeleton className="h-9" />
          ) : servers.isError ? (
            <ErrorState compact error={servers.error} onRetry={() => void servers.refetch()} />
          ) : eligible.length === 0 ? (
            <p className="text-body text-muted-foreground">{tr("没有已注册的服务器。", "No enrolled servers.")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {eligible.map((s) => (
                <label
                  key={s.id}
                  className="flex min-h-9 items-center gap-2 rounded-md bg-window px-2.5 py-1 text-body"
                >
                  <Checkbox
                    checked={subset.includes(s.id)}
                    label={s.name}
                    onChange={(on) => setSubset(on ? [...subset, s.id] : subset.filter((x) => x !== s.id))}
                  />
                  {s.name}
                  <span className="text-footnote text-muted-foreground">{s.agent_version ?? ""}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </div>
    </Dialog>
  );
}

/** One rollout action button with its own busy state. */
function RolloutAction({
  id,
  what,
  label,
  icon,
  danger,
}: {
  id: string;
  what: "pause" | "resume" | "abort";
  label: string;
  icon: typeof Pause;
  danger?: boolean;
}) {
  const tr = useTr();
  const confirm = useConfirm();
  const [run, busy] = useAction();
  return (
    <Button
      variant={danger ? "destructive-soft" : "secondary"}
      icon={icon}
      loading={busy}
      className={danger ? "mr-auto" : undefined}
      onClick={async () => {
        if (
          what === "abort" &&
          !(await confirm({
            title: tr("中止灰度？", "Abort the rollout?"),
            description: tr(
              "还没更新的服务器不再更新；已更新的保持新版本。中止后不能继续。",
              "Servers not yet updated stay as they are; updated ones keep the new version. Cannot be resumed.",
            ),
            confirmLabel: tr("中止", "Abort"),
          }))
        )
          return;
        await run(() => post(`/rollouts/${id}/${what}`), {
          ok:
            what === "pause"
              ? tr("已暂停", "Paused")
              : what === "resume"
                ? tr("已继续", "Resumed")
                : tr("已中止", "Aborted"),
        });
      }}
    >
      {label}
    </Button>
  );
}

function RolloutDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["rollouts", id],
    queryFn: () => get<Rollout & { servers: RolloutServer[] }>(`/rollouts/${id}`),
    refetchInterval: (s) => (s.state.data && !OPEN.includes(s.state.data.status) ? false : 5000),
  });
  const r = q.data;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={Rocket}
      title={r ? tr(`灰度 ${r.version}`, `Rollout ${r.version}`) : tr("灰度", "Rollout")}
      description={
        r && (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={rolloutTone(r.status)}>{rolloutName(r.status, tr)}</Badge>
            <span>
              {tr(
                `第 ${r.current_wave + 1} / ${r.waves.length} 批 · 由 ${r.created_by} 创建于 ${dateTime(r.created_at)}`,
                `wave ${r.current_wave + 1} / ${r.waves.length} · by ${r.created_by} ${dateTime(r.created_at)}`,
              )}
            </span>
          </span>
        )
      }
      footer={
        r && OPEN.includes(r.status) ? (
          <>
            <RolloutAction id={id} what="abort" label={tr("中止", "Abort")} icon={Square} danger />
            {r.status === "running" && <RolloutAction id={id} what="pause" label={tr("暂停", "Pause")} icon={Pause} />}
            {(r.status === "paused" || r.status === "halted") && (
              <RolloutAction id={id} what="resume" label={tr("继续", "Resume")} icon={Play} />
            )}
          </>
        ) : (
          <Button onClick={onClose}>{tr("关闭", "Close")}</Button>
        )
      }
    >
      {q.isPending ? (
        <LoadingBlock rows={5} />
      ) : q.isError && !r ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : r ? (
        <div className="grid gap-3">
          {r.halted_reason && (
            <Callout tone="danger" title={tr("失败过多，已自动停止", "Stopped: too many failures")}>
              <span className="text-footnote break-words">{r.halted_reason}</span>
            </Callout>
          )}
          <KV
            items={[
              [tr("批次（累计 %）", "Waves (cumulative %)"), r.waves.join(" → ")],
              [tr("覆盖比例", "Coverage"), `${r.percentage}%`],
              [tr("健康超时", "Health timeout"), tr(`${r.health_timeout_secs} 秒`, `${r.health_timeout_secs} s`)],
              [tr("最大失败比例", "Max failure ratio"), String(r.max_failure_ratio)],
            ]}
          />
          {r.servers.length === 0 ? (
            <EmptyState icon={CircleCheck} title={tr("没有服务器", "No servers")} />
          ) : (
            <ul className="divide-y divide-separator overflow-hidden rounded-lg bg-window">
              {r.servers.map((s) => {
                const [label, tone] = serverState(s.status, tr);
                return (
                  <li key={s.server_id} className="grid gap-1 px-3 py-2 text-body">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-all">{s.name}</span>
                      <Badge>{tr(`第 ${s.wave + 1} 批`, `wave ${s.wave + 1}`)}</Badge>
                      <Badge tone={tone}>{label}</Badge>
                      <span className="text-footnote text-muted-foreground">
                        {s.from_version ?? "?"} → {s.agent_version ?? "?"}
                      </span>
                    </div>
                    {s.detail && <p className="text-footnote break-words text-muted-foreground">{s.detail}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {q.isError && (
            <p className="text-footnote text-warning" role="status">
              {tr("刷新失败，显示的是上次的数据", "Refresh failed; showing the last data")}
            </p>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
