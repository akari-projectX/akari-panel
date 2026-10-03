import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { adminBase, ApiError, get, post, put, type AgentUpdateStatus } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { fmtDateTime } from "../lib/datetime";
import { navigate } from "../lib/router";
import { ErrorText } from "../components/status";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";

// Admin console (Chinese only). One-click agent update check (mirror of
// src/updatecheck.rs): the panel fetches the latest akari-agent release,
// verifies it and stores it like a manual upload; rollouts stay manual.

export const UPDATE_STATUS_KEY = ["agent-updates"] as const;

/** GET /agent-updates; polls every 2 s while a check runs. */
export function useUpdateStatus() {
  return useQuery({
    queryKey: UPDATE_STATUS_KEY,
    queryFn: () => get<AgentUpdateStatus>("/agent-updates"),
    refetchInterval: (q) => (q.state.data?.checking ? 2000 : 60_000),
  });
}

/** The last check's outcome in one line. */
export function lastCheckText(s: AgentUpdateStatus): string | null {
  const c = s.last_check;
  if (!c) return null;
  const at = fmtDateTime(c.at);
  if (c.ok && c.result === "stored") return `${at} 检查：已保存 ${c.version}（${c.stored.join("、")}）`;
  if (c.ok) return `${at} 检查：已是最新（${c.version}）`;
  const err = new ApiError(0, c.message ?? "", { code: c.code ?? "", params: c.params ?? {} });
  return `${at} 检查失败：${adminErrorText(err)}`;
}

/** 「有新版本 vX」 — shown on the node list and the dashboard. */
export function UpdateAvailableBadge() {
  const q = useUpdateStatus();
  const s = q.data;
  if (!s?.update_available) return null;
  return (
    <a
      href={`${adminBase}/updates`}
      title={`${s.outdated_nodes} 个节点运行的版本低于 ${s.update_available}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(`${adminBase}/updates`);
      }}
    >
      <Badge variant="success">有新版本 {s.update_available}</Badge>
    </a>
  );
}

export function UpdateCheck() {
  const qc = useQueryClient();
  const q = useUpdateStatus();
  const s = q.data;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Form state; null = not edited (show the server's value).
  const [source, setSource] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  // A finished check may have stored releases: refresh the list.
  const wasChecking = useRef(false);
  const checking = s?.checking ?? false;
  useEffect(() => {
    if (wasChecking.current && !checking) void qc.invalidateQueries({ queryKey: ["releases"] });
    wasChecking.current = checking;
  }, [checking, qc]);

  async function check() {
    setError(null);
    setSaved(null);
    try {
      qc.setQueryData(UPDATE_STATUS_KEY, await post<AgentUpdateStatus>("/agent-updates/check", {}));
    } catch (err) {
      setError(adminErrorText(err, "检查更新"));
    }
    await qc.invalidateQueries({ queryKey: UPDATE_STATUS_KEY });
  }

  async function save() {
    if (!s) return;
    setError(null);
    setSaved(null);
    try {
      const next = await put<AgentUpdateStatus>("/agent-updates/settings", {
        version: s.version,
        source_url: (source ?? s.source_url ?? "").trim() || null,
        auto_check: auto ?? s.auto_check,
      });
      qc.setQueryData(UPDATE_STATUS_KEY, next);
      setSource(null);
      setAuto(null);
      setSaved("已保存");
    } catch (err) {
      setError(adminErrorText(err, "保存失败"));
    }
  }

  const last = s ? lastCheckText(s) : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>检查更新</h2>
        </CardTitle>
        <CardDescription>
          面板从发布源获取 akari-agent 的最新发布（linux amd64 与 arm64），用内置的官方发布公钥（以及「系统设置 →
          安全」里额外信任的公钥）校验签名，并核对 SHA-256 与平台后保存，与手动上传完全相同；不会自动开始灰度更新。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isError && <ErrorText>{adminErrorText(q.error, "加载失败")}</ErrorText>}
        {s && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={s.checking || !s.keys_configured} onClick={check}>
                {s.checking ? "检查中…" : "检查更新"}
              </Button>
              {s.update_available ? (
                <Badge variant="success">
                  有新版本 {s.update_available}（{s.outdated_nodes} 个节点可更新）
                </Badge>
              ) : (
                s.latest && <span className="text-sm text-muted-foreground">面板最新发布：{s.latest.version}</span>
              )}
            </div>
            {!s.keys_configured && (
              <p className="text-sm text-amber-700">没有可用的发布公钥（系统设置 → 安全），无法检查或上传发布。</p>
            )}
            {last && (
              <p className={s.last_check?.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>{last}</p>
            )}
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <div>
                <Label htmlFor="upd-source">发布源（GitHub 最新发布 API）</Label>
                <Input
                  id="upd-source"
                  value={source ?? s.source_url ?? ""}
                  placeholder={s.default_source_url}
                  onChange={(e) => setSource(e.target.value)}
                />
              </div>
              <label htmlFor="upd-auto" className="flex items-center gap-2 pb-2 text-sm">
                <input
                  id="upd-auto"
                  type="checkbox"
                  checked={auto ?? s.auto_check}
                  onChange={(e) => setAuto(e.target.checked)}
                />
                自动检查（每 6 小时）
              </label>
              <Button variant="outline" onClick={save}>
                保存
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              留空 = 官方仓库。只会访问发布源所在的主机（官方源另含 GitHub 的下载主机），只接受 HTTPS。
              {s.auto_check && s.next_auto_check_at && ` 下次自动检查：${fmtDateTime(s.next_auto_check_at)}。`}
            </p>
            {saved && (
              <p role="status" className="text-sm text-emerald-700">
                {saved}
              </p>
            )}
          </>
        )}
        <ErrorText>{error}</ErrorText>
      </CardContent>
    </Card>
  );
}
