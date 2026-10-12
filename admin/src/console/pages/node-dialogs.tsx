// Every dialog of the nodes area (v2, proposal-v2 §4; prototype
// components/nodes-dialogs.tsx), mounted from the URL by `NodesDialogs`:
// add server (name + TLS domain → the one-time install command), install
// command / enrollment token of an existing server, the new-node wizard
// (位置 → 协议 → 配置 → 展示与入口), the node dialog (基本 / 入站 / 审计与流量
// on ?ntab=) and the entrance dialogs (entrance-dialog.tsx).
import { useQuery } from "@tanstack/react-query";
import {
  Braces,
  CircleCheck,
  Download,
  KeyRound,
  Layers,
  Plus,
  Server,
  ShieldBan,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { get, patch, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { downloadText } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented, Switch } from "../../shared/ui/form";
import { Banner, KV } from "../../shared/ui/layout";
import { ErrorState, LoadingBlock } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";
import { CopyText, Steps, Stepper, type StepState } from "../components/kit";
import { GroupChips, RadioCards } from "../components/inputs";
import { ServerStatus, serverStateOf } from "../components/status";
import { useAction } from "../data";
import { FormError, useConfirmFree } from "../kit";
import { parseRate } from "../rates";
import { navigate, useQS } from "../router";
import { holdersOf, useGroups, usePlanList, useServers } from "../servers";
import { useCrumb } from "../session";
import type { EntranceView, NodeGroup, ServerNode, ServerView } from "../types";
import { protocolName } from "../components/nodes-bits";
import { EntranceDialog, RelayDialog } from "./entrance-dialog";
import {
  JsonInbound,
  TemplateFields,
  newTemplateForm,
  parseInbound,
  toSpec,
  type TemplateForm,
  type TemplateKind,
} from "./inbound-form";
import {
  FixCount,
  PORT,
  TagsField,
  WarningList,
  chips,
  num,
  shown,
  tagValues,
  type Chips,
  type NumRule,
} from "./node-common";
import { NodeTrafficBody, useDeleteNode, useDomainCheck, useToggleNode } from "./node-server";

// The alerts page imports these from here (moved to node-common.tsx).
export { ALERT_KINDS, alertKindName } from "./node-common";

/* ================= Install command / enrollment ================= */

type InstallView = {
  url: string;
  command: string;
  command_wget: string | null;
  uninstall_command: string;
  expires_at: string;
  pin: string | null;
  warnings: string[];
};
type Enrollment = {
  id?: string;
  name: string;
  enrollment_token: string;
  expires_at: string;
  bootstrap: string;
  install?: InstallView;
};

/** What the command dialog shows: material a create returned, or a fresh link for an existing server. */
type Shown = { created: Enrollment & { id: string } } | { install: { id: string; name: string } };

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Remaining({ until }: { until: string }) {
  const tr = useTr();
  const s = Math.max(0, Math.round((Date.parse(until) - useNow()) / 1000));
  if (s === 0) return <span className="font-semibold text-destructive">{tr("已失效", "expired")}</span>;
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return <span className="tnum font-semibold">{`${mm}:${ss}`}</span>;
}

/** The dark terminal block of the v2 design (tokens only: inverted in light, window grey in dark). */
function Terminal_({ value, caption }: { value: string; caption: ReactNode }) {
  const tr = useTr();
  return (
    <div className="overflow-hidden rounded-xl bg-foreground text-background ring-1 ring-border dark:bg-window dark:text-foreground">
      <div className="flex items-center justify-between gap-2 border-b border-current/10 px-3 py-1.5 text-caption opacity-70">
        <span className="min-w-0 truncate">{caption}</span>
        <CopyText
          value={value}
          display={tr("复制", "Copy")}
          label={tr("安装命令", "the install command")}
          className="[&_button]:text-current [&>span]:font-sans"
        />
      </div>
      <pre className="overflow-x-auto px-3 py-3 font-mono text-footnote leading-5 whitespace-pre-wrap break-all">
        {value}
      </pre>
    </div>
  );
}

function BootstrapFold({ e }: { e: Enrollment }) {
  const tr = useTr();
  return (
    <details className="rounded-xl ring-1 ring-border ring-inset">
      <summary className="flex min-h-11 cursor-default items-center px-4 text-body font-medium">
        {tr("服务器不能访问面板？改用手动引导文件", "The server cannot reach the panel? Use a bootstrap file")}
      </summary>
      <div className="grid gap-2 border-t border-separator px-4 py-3 text-footnote text-muted-foreground">
        <p>
          {tr(
            "下载引导文件（含一次性注册令牌，不含私钥），上传到服务器后执行 akari-agent -config <文件>。同样只能用一次。",
            "Download the bootstrap file (a one-time token, no private key), upload it to the server and run akari-agent -config <file>. Single use as well.",
          )}
        </p>
        <Button
          size="sm"
          icon={Download}
          className="justify-self-start"
          onClick={() => downloadText(`${e.name}-bootstrap.toml`, e.bootstrap)}
        >
          {tr("下载引导文件", "Download the bootstrap file")}
        </Button>
      </div>
    </details>
  );
}

/**
 * The one-time install command (step 2 of 添加服务器, 安装命令 of an existing
 * server, or what the wizard's new server returned). Closing while the agent
 * has not connected asks first ("确定已经复制安装命令？", focus on 返回复制).
 */
function CommandDialog({ shown, onClose }: { shown: Shown; onClose: () => void }) {
  const tr = useTr();
  const servers = useServers();
  const created = "created" in shown ? shown.created : null;
  const id = created ? created.id : "install" in shown ? shown.install.id : "";
  const name = created ? created.name : "install" in shown ? shown.install.name : "";
  const [fresh, setFresh] = useState<InstallView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [asking, setAsking] = useState(false);
  // Each request issues a new link (the unused one is replaced): one per attempt.
  const issued = useRef(-1);
  useEffect(() => {
    if (created || issued.current === attempt) return;
    issued.current = attempt;
    post<InstallView>(`/servers/${id}/install`, { origin: location.origin }).then(setFresh, setError);
  }, [created, id, attempt]);
  const install = created?.install ?? fresh;
  const server = servers.data?.find((s) => s.id === id);
  // A reinstall of a connected server cannot be told apart from the old
  // agent, so only a first connection counts as "connected".
  const wasEnrolled = useRef<boolean | null>(null);
  if (wasEnrolled.current === null && server) wasEnrolled.current = server.enrolled && !created;
  const enrolled = !!server?.enrolled;
  const connected = enrolled && !wasEnrolled.current;
  const reported = connected && !!server?.online && !!server.heartbeat;
  const steps: { label: ReactNode; state: StepState; detail?: ReactNode }[] = [
    { label: tr("生成安装命令", "Issue the install command"), state: install ? "done" : "active" },
    {
      label: connected
        ? tr("agent 已连接", "The agent connected")
        : wasEnrolled.current
          ? tr("等待 agent 用新证书重新连接…", "Waiting for the agent to reconnect with a new certificate…")
          : tr("等待 agent 首次连接…", "Waiting for the agent…"),
      state: !install ? "todo" : connected ? "done" : "active",
      detail:
        install && !connected
          ? tr(
              "执行命令后通常 10–30 秒内连上，这里会自动更新",
              "Usually connects 10–30 s after the command runs; this updates by itself",
            )
          : undefined,
    },
    {
      label: tr("上报机器信息与证书", "Machine facts and certificate reported"),
      state: reported ? "done" : connected ? "active" : "todo",
    },
  ];
  const askClose = () => (install && !connected ? setAsking(true) : onClose());
  const existing = "install" in shown;
  return (
    <>
      <Dialog
        open={!asking}
        size="md"
        icon={Terminal}
        onClose={askClose}
        title={
          existing
            ? tr(`安装命令 · ${name}`, `Install command · ${name}`)
            : tr(`安装 agent · ${name}`, `Install the agent · ${name}`)
        }
        description={
          existing
            ? tr("已生成新命令，之前的命令已失效。", "A new command was issued; the previous one no longer works.")
            : tr("在服务器上以 root 执行下面的命令。", "Run the command below on the server as root.")
        }
        footer={
          <>
            <span className="flex-1 text-footnote text-muted-foreground max-sm:hidden">
              {enrolled
                ? tr("agent 已连接，可以创建节点", "The agent is connected; add a node")
                : tr("连上后可直接创建节点", "Add a node once it connects")}
            </span>
            <Button onClick={askClose}>{tr("关闭", "Close")}</Button>
            <Button
              variant="primary"
              icon={Plus}
              disabled={!enrolled}
              title={enrolled ? undefined : tr("agent 连上后可用", "Available once the agent connects")}
              onClick={() => {
                onClose();
                navigate(`/nodes/${id}?new=node&server=${id}`);
              }}
            >
              {tr("在此服务器添加节点", "Add a node here")}
            </Button>
          </>
        }
      >
        {!install && !error && <LoadingBlock rows={4} />}
        {!!error && (
          <ErrorState
            compact
            title={tr("安装命令生成失败", "Could not issue the install command")}
            error={error}
            onRetry={() => {
              setError(null);
              setAttempt((a) => a + 1);
            }}
          />
        )}
        {install && (
          <div className="grid gap-4">
            <Banner tone="warning" icon={<TriangleAlert />} title={tr("只显示这一次。", "Shown only once.")}>
              {tr(
                "关闭后无法再查看，只能重新生成。命令 ",
                "Once closed it cannot be shown again, only reissued. Expires in ",
              )}
              <Remaining until={install.expires_at} />
              {tr(" 后失效，且只能用一次。", ", single use.")}
            </Banner>
            <Terminal_
              value={install.command}
              caption={tr("bash · 以 root 执行（一次性）", "bash · run as root (single use)")}
            />
            {install.command_wget && (
              <details>
                <summary className="flex min-h-11 cursor-default items-center text-body text-muted-foreground">
                  {tr("没有 curl？用 wget", "No curl? Use wget")}
                </summary>
                <CopyText block value={install.command_wget} label={tr("wget 命令", "the wget command")} />
              </details>
            )}
            <Steps items={steps} />
            {install.pin && (
              <p className="text-footnote break-all text-muted-foreground">
                {tr(`命令钉住了面板证书公钥：${install.pin}`, `The command pins the panel's key: ${install.pin}`)}
              </p>
            )}
            <WarningList warnings={install.warnings} />
            {created ? (
              <BootstrapFold e={created} />
            ) : (
              <p className="text-footnote text-muted-foreground">
                {tr(
                  "服务器不能访问面板时，用服务器菜单里的「重新生成注册令牌」下载引导文件。",
                  "If the server cannot reach the panel, use “New enrollment token” in the server menu for a bootstrap file.",
                )}
              </p>
            )}
            <details>
              <summary className="flex min-h-11 cursor-default items-center text-body text-muted-foreground">
                {tr("卸载命令", "Uninstall command")}
              </summary>
              <CopyText block value={install.uninstall_command} label={tr("卸载命令", "the uninstall command")} />
            </details>
          </div>
        )}
      </Dialog>
      <Dialog
        open={asking}
        size="sm"
        icon={TriangleAlert}
        tone="warning"
        onClose={() => setAsking(false)}
        title={tr("确定已经复制安装命令？", "Copied the install command?")}
        footer={
          <>
            <Button onClick={onClose}>{tr("仍然关闭", "Close anyway")}</Button>
            <Button variant="primary" data-autofocus onClick={() => setAsking(false)}>
              {tr("返回复制", "Back to copy")}
            </Button>
          </>
        }
      >
        <p className="text-body text-foreground/85">
          {tr(
            "关闭后这条命令不会再显示。如果还没执行，只能到服务器页「安装命令」重新生成，旧命令会随之失效。",
            "Once closed the command is not shown again. If it has not run yet, issue a new one from the server page (“Install command”); this one then stops working.",
          )}
        </p>
      </Dialog>
    </>
  );
}

/** 添加服务器, step 1: name + TLS domain (DNS check); step 2 is the command dialog. */
function AddServerDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Shown) => void }) {
  const tr = useTr();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const dns = useDomainCheck();
  const nameError = !name.trim() ? tr("请填写名称", "Enter a name") : undefined;
  const domainError =
    domain.trim() && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain.trim())
      ? tr("请输入域名（不含 https:// 和端口）", "Enter a domain (no https:// or port)")
      : undefined;
  const submit = async () => {
    setTried(true);
    if (nameError || domainError) return;
    const r = await run(
      () =>
        post<Enrollment & { id: string }>("/servers", {
          name: name.trim(),
          tls_domain: domain.trim() || undefined,
          install: { origin: location.origin },
        }),
      { ok: tr("服务器已添加", "Server added") },
    );
    if (r) onCreated({ created: { ...r, name: r.name ?? name.trim() } });
  };
  return (
    <Dialog
      open
      size="md"
      icon={Server}
      onClose={onClose}
      onSubmit={submit}
      title={tr("添加服务器", "Add server")}
      description={tr(
        "登记后生成一次性安装命令，在服务器上执行即可接入。",
        "Registering it issues a one-time install command; run it on the server to connect.",
      )}
      footer={
        <>
          <FixCount n={tried ? [nameError, domainError].filter(Boolean).length : 0} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("生成安装命令", "Issue the install command")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field
          label={tr("名称", "Name")}
          required
          error={tried ? nameError : undefined}
          hint={tr("只在后台显示，建议「地区 + 线路 + 序号」", "Shown only here; e.g. region + carrier + number")}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Field
          label={tr("TLS 域名", "TLS domain")}
          error={domainError}
          hint={
            dns.res ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1",
                  dns.res.tone === "success" ? "text-success" : dns.res.tone === "info" ? "" : "text-warning",
                )}
              >
                {dns.res.tone === "success" && <CircleCheck className="size-3.5" aria-hidden="true" />}
                {dns.res.text}
              </span>
            ) : (
              tr(
                "先把域名 A/AAAA 记录指向这台服务器；agent 证书与直连入口都用它（可留空，之后在服务器设置里填）",
                "Point its A/AAAA record at the server first; the agent certificate and direct entrances use it (optional; set it later in the server settings)",
              )
            )
          }
        >
          <div className="flex gap-2">
            <Input
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value);
                dns.setRes(null);
              }}
              onBlur={() => domain.trim() && !domainError && void dns.check(domain)}
              className="font-mono"
              placeholder="node1.example.com"
            />
            <Button
              className="shrink-0"
              loading={dns.checking}
              disabled={!domain.trim() || !!domainError}
              onClick={() => void dns.check(domain)}
            >
              {tr("检查解析", "Check DNS")}
            </Button>
          </div>
        </Field>
        <p className="text-footnote text-muted-foreground">
          {tr(
            "流量额度、告警规则在接入后到服务器页设置。安装脚本来源与镜像见",
            "Quota and alert rules are set on the server page once it connects. Install script sources and mirrors:",
          )}{" "}
          <Link to="/settings/install" className="text-primary hover:underline">
            {tr("设置 → 安装", "Settings → Install")}
          </Link>
          {tr("。", ".")}
        </p>
      </div>
    </Dialog>
  );
}

/** 重新生成注册令牌: the consequences first, then the token (bootstrap file) once. */
function EnrollDialog({ server, onClose }: { server: ServerView; onClose: () => void }) {
  const tr = useTr();
  const [run, busy] = useAction();
  const [e, setE] = useState<Enrollment | null>(null);
  const issue = async () => {
    const r = await run(() => post<Enrollment>(`/servers/${server.id}/enroll-token`), {
      ok: tr("已生成新的注册令牌", "A new enrollment token was issued"),
    });
    if (r) setE(r);
  };
  const entrances = server.nodes.reduce((a, n) => a + n.entrances.length, 0);
  return (
    <Dialog
      open
      size="md"
      icon={KeyRound}
      tone={e ? "default" : "warning"}
      onClose={onClose}
      title={tr(`重新生成注册令牌 · ${server.name}`, `New enrollment token · ${server.name}`)}
      description={
        e
          ? tr("新令牌已生成，未使用的旧令牌已失效。", "A new token was issued; the unused one no longer works.")
          : tr("agent 证书失效或重装系统后使用。", "For an expired agent certificate or a reinstalled machine.")
      }
      footer={
        e ? (
          <Button variant="primary" onClick={onClose}>
            {tr("完成", "Done")}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
            <Button variant="primary" loading={busy} onClick={() => void issue()}>
              {tr("生成注册令牌", "Issue the token")}
            </Button>
          </>
        )
      }
    >
      {e ? (
        <div className="grid gap-4">
          <Banner tone="warning" icon={<TriangleAlert />} title={tr("只显示这一次。", "Shown only once.")}>
            {tr("令牌 ", "The token expires in ")}
            <Remaining until={e.expires_at} />
            {tr(" 后失效，且只能用一次。", ", single use.")}
          </Banner>
          <Field
            label={tr("引导文件（含一次性注册令牌，不含私钥）", "Bootstrap file (a one-time token, no private key)")}
          >
            <pre className="max-h-48 overflow-auto rounded-lg bg-window p-3 font-mono text-caption ring-1 ring-border ring-inset">
              {e.bootstrap}
            </pre>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <CopyText
              value={e.bootstrap}
              display={tr("复制引导文件", "Copy the file")}
              label={tr("引导文件", "the bootstrap file")}
            />
            <Button size="sm" icon={Download} onClick={() => downloadText(`${e.name}-bootstrap.toml`, e.bootstrap)}>
              {tr("下载引导文件", "Download the bootstrap file")}
            </Button>
          </div>
          <Field label={tr("在服务器上执行", "On the server")}>
            <CopyText
              block
              value="sudo akari-agent -config /etc/akari/bootstrap.toml"
              label={tr("命令", "the command")}
            />
          </Field>
        </div>
      ) : (
        <div className="grid gap-3 text-body">
          <p className="text-foreground/85">
            {tr(
              `生成新的一次性注册令牌，未使用的旧令牌（含安装命令）随即失效。agent 用新令牌重新注册后，这台服务器之前的证书会被吊销；在那之前当前 agent 照常运行，其上 ${entrances} 个入口不受影响。`,
              `Issues a new one-time token; any unused one (and its install command) stops working. Once the agent enrolls with it, the server's previous certificates are revoked; until then the running agent and its ${entrances} entrances keep working.`,
            )}
          </p>
          <p className="text-footnote text-muted-foreground">
            {tr(
              "适用于：证书校验未通过、重装了系统、或怀疑证书泄露。节点、入口和用户凭据都不变。",
              "For: certificate checks failing, a reinstalled system or a suspected leaked certificate. Nodes, entrances and user credentials stay.",
            )}
          </p>
        </div>
      )}
    </Dialog>
  );
}

/* ================= New node wizard ================= */

type Proto = { kind: TemplateKind | "json"; title: string; desc: string; protocol: string };

function protoCards(tr: Tr): Proto[] {
  return [
    {
      kind: "vless_reality",
      title: "VLESS + REALITY",
      desc: tr("推荐。无需证书，伪装成目标网站", "Recommended. No certificate; looks like the target site"),
      protocol: "vless",
    },
    {
      kind: "vless_reality_xhttp",
      title: "REALITY + XHTTP",
      desc: tr("无需证书，XHTTP 传输", "No certificate, XHTTP transport"),
      protocol: "vless",
    },
    {
      kind: "vless_tls_vision",
      title: "VLESS + Vision",
      desc: tr("TLS 证书（自动签发）+ XTLS Vision", "TLS certificate (automatic) + XTLS Vision"),
      protocol: "vless",
    },
    {
      kind: "vless_ws_tls",
      title: "VLESS + WS",
      desc: tr("WebSocket + TLS，可过 CDN", "WebSocket + TLS, CDN friendly"),
      protocol: "vless",
    },
    {
      kind: "trojan_tls",
      title: "Trojan",
      desc: tr("TLS + 密码，老客户端兼容", "TLS + password, old clients"),
      protocol: "trojan",
    },
    {
      kind: "vmess_ws",
      title: "VMess + WS",
      desc: tr("WebSocket，可选 TLS", "WebSocket, optional TLS"),
      protocol: "vmess",
    },
    {
      kind: "vmess_tcp",
      title: "VMess + TCP",
      desc: tr("无 TLS，仅兼容旧客户端", "No TLS, legacy clients"),
      protocol: "vmess",
    },
    {
      kind: "transport",
      title: tr("自选传输", "Pick a transport"),
      desc: tr("VLESS/VMess/Trojan × WS/HTTPUpgrade/XHTTP/gRPC", "VLESS/VMess/Trojan × WS/HTTPUpgrade/XHTTP/gRPC"),
      protocol: "",
    },
    {
      kind: "shadowsocks_2022",
      title: "Shadowsocks 2022",
      desc: tr("简单、兼容性最好；无伪装", "Simple, most compatible; no camouflage"),
      protocol: "shadowsocks",
    },
    {
      kind: "hysteria2",
      title: "Hysteria 2",
      desc: tr("基于 QUIC，弱网表现好；需开放 UDP", "QUIC, good on bad networks; needs UDP"),
      protocol: "hysteria",
    },
    {
      kind: "json",
      title: tr("高级 JSON", "Advanced JSON"),
      desc: tr("直接写 xray 入站配置", "Write the xray inbound yourself"),
      protocol: "",
    },
  ];
}

const l4 = (protocol: string | null | undefined): string[] =>
  protocol === "hysteria" ? ["udp"] : protocol === "shadowsocks" ? ["tcp", "udp"] : ["tcp"];

/** Ports already used on a server (node inbounds and relay listen ports), with who uses them. */
function usedPorts(
  s: ServerView | undefined,
  except?: string,
): { port: number; by: string; protocol: string | null }[] {
  const out: { port: number; by: string; protocol: string | null }[] = [];
  for (const n of s?.nodes ?? []) {
    if (n.id === except) continue;
    if (n.port) out.push({ port: n.port, by: n.name, protocol: n.protocol });
    for (const e of n.entrances)
      if (e.kind === "relay" && e.listen_port)
        out.push({ port: e.listen_port, by: `${n.name} / ${e.name}`, protocol: n.protocol });
  }
  return out;
}

/** "本服务器已占用：443、8443" / "Used on this server: 443, 8443". */
function usedPortsText(used: ReturnType<typeof usedPorts>, tr: Tr): string {
  const ports = [...new Set(used.map((u) => u.port))].join(tr("、", ", "));
  return ports
    ? tr(`本服务器已占用：${ports}`, `Used on this server: ${ports}`)
    : tr("本服务器已占用：无", "Used on this server: none");
}

function clashOf(
  tr: Tr,
  used: ReturnType<typeof usedPorts>,
  port: number | null,
  protocol: string,
): string | undefined {
  if (port === null) return undefined;
  const mine = l4(protocol || null);
  const hit = used.find((u) => u.port === port && l4(u.protocol).some((x) => mine.includes(x)));
  return hit
    ? tr(`端口 ${port} 已被本服务器的「${hit.by}」使用`, `Port ${port} is used by "${hit.by}" on this server`)
    : undefined;
}

const SORT: NumRule = { min: -2_147_483_648, max: 2_147_483_647, int: true, optional: true };
const SORT_REQ: NumRule = { ...SORT, optional: false };

function NewNodeWizard({
  servers,
  groups,
  preset,
  onClose,
  onShown,
}: {
  servers: ServerView[];
  groups: NodeGroup[];
  preset: string | null;
  onClose: () => void;
  onShown: (s: Shown) => void;
}) {
  const tr = useTr();
  const plans = usePlanList();
  const confirmFree = useConfirmFree();
  const [run, busy] = useAction();
  const choices = servers.filter((s) => !s.deleting_at);
  const presetOk = !!preset && choices.some((s) => s.id === preset);
  const [step, setStep] = useState(presetOk ? 1 : 0);
  const [where, setWhere] = useState<string>(presetOk ? preset! : (choices[0]?.id ?? "new"));
  const [newDomain, setNewDomain] = useState("");
  const [proto, setProto] = useState<TemplateKind | "json">("vless_reality");
  const [tpl, setTpl] = useState<TemplateForm>(() => newTemplateForm("443"));
  const [json, setJson] = useState('{\n  "protocol": "vless",\n  "port": 443\n}');
  const [f, setF] = useState({ name: "", display: "", region: "", sort: "", visible: true });
  const [d, setD] = useState<{ name: string; host: string; port: string; rate: string; tags: Chips; groups: string[] }>(
    {
      name: "",
      host: "",
      port: "",
      rate: "1",
      tags: chips([]),
      groups: [],
    },
  );
  const [tried, setTried] = useState<boolean[]>([false, false, false, false]);
  const srv = choices.find((s) => s.id === where);
  const domain = where === "new" ? newDomain.trim() : (srv?.tls_domain ?? "");
  const used = usedPorts(srv);
  const form: TemplateForm = { ...tpl, template: proto === "json" ? tpl.template : proto };
  const spec = proto === "json" ? parseInbound(json, tr) : toSpec(form, tr, domain);
  const cards = protoCards(tr);
  const protocol =
    proto === "json"
      ? typeof spec === "string"
        ? ""
        : String(spec.protocol ?? "")
      : proto === "transport"
        ? tpl.protocol
        : (cards.find((c) => c.kind === proto)?.protocol ?? "");
  const port =
    proto === "json" ? (typeof spec === "string" ? null : Number(spec.port) || null) : num(tpl.port, PORT, tr)[0];
  const clash = clashOf(tr, used, port, protocol);
  const [sortV, sortErr] = num(f.sort, SORT, tr);
  const [dPortV, dPortErr] = num(d.port, { ...PORT, optional: true }, tr);
  const rate = parseRate(d.rate);
  const errs = [
    [] as (string | undefined)[],
    [],
    [typeof spec === "string" ? spec : undefined, clash],
    [
      !f.name.trim() ? tr("请填写名称", "Enter a name") : undefined,
      sortErr,
      dPortErr,
      rate === null
        ? tr(
            "请填写倍率：0–100，最多 3 位小数（留空不会当作 0）",
            "Enter a multiplier: 0–100, at most 3 decimals (empty is not 0)",
          )
        : undefined,
      tagValues(d.tags).length > 8 ? "tags" : undefined,
    ],
  ];
  const count = (i: number) => (tried[i] ? errs[i].filter(Boolean).length : 0);
  const users =
    plans.data && d.groups.length
      ? plans.data.filter((p) => p.group_ids.some((g) => d.groups.includes(g))).reduce((n, p) => n + p.active_users, 0)
      : 0;
  const create = async () => {
    if (typeof spec === "string" || rate === null) return;
    const body: Record<string, unknown> = { name: f.name.trim(), region: f.region.trim() || undefined };
    if (where === "new") {
      body.tls_domain = newDomain.trim() || undefined;
      body.install = { origin: location.origin };
    } else body.server_id = where;
    if (proto === "json") body.inbound = spec;
    else body.template = spec;
    if (f.display.trim()) body.display_name = f.display.trim();
    if (sortV !== null) body.sort = sortV;
    if (!f.visible) body.visible = false;
    if (rate === 0 && !(await confirmFree(tr("直连入口", "the direct entrance")))) return;
    const direct: Record<string, unknown> = {};
    if (d.name.trim()) direct.name = d.name.trim();
    if (d.host.trim()) direct.connect_host = d.host.trim();
    if (dPortV !== null) direct.connect_port = dPortV;
    if (rate !== 1) direct.rate = rate;
    if (d.groups.length) direct.group_ids = d.groups;
    if (tagValues(d.tags).length) direct.tags = tagValues(d.tags);
    if (Object.keys(direct).length) body.direct = direct;
    const r = await run(
      () => post<{ id: string; server_id: string; name: string } & Partial<Enrollment>>("/nodes", body),
      { ok: tr(`已创建节点「${f.name.trim()}」`, `Node "${f.name.trim()}" created`) },
    );
    if (!r) return;
    onClose();
    if (r.enrollment_token && r.bootstrap && r.expires_at)
      onShown({
        created: {
          id: r.server_id,
          name: r.name,
          enrollment_token: r.enrollment_token,
          expires_at: r.expires_at,
          bootstrap: r.bootstrap,
          install: r.install,
        },
      });
    else navigate(`/nodes/${r.server_id}`);
  };
  const next = () => {
    setTried((t) => t.map((v, i) => (i === step ? true : v)));
    if (errs[step].some(Boolean)) return;
    if (step === 3) void create();
    else setStep(step + 1);
  };
  const labels = [
    tr("位置", "Where"),
    tr("协议", "Protocol"),
    tr("配置", "Configure"),
    tr("展示与入口", "Display and entrance"),
  ];
  return (
    <Dialog
      open
      size="lg"
      icon={Layers}
      onClose={onClose}
      onSubmit={next}
      title={tr("新建落地节点", "New landing node")}
      description={
        where !== "new" && srv
          ? tr(
              `在 ${srv.name} 上创建一个入站，并自动生成一个直连入口`,
              `Creates an inbound on ${srv.name} and its direct entrance`,
            )
          : tr("选择一台服务器，或同时新建一台", "Pick a server, or add one with it")
      }
      tabs={<Stepper steps={labels} current={step} onJump={setStep} />}
      footer={
        <>
          {step > 0 && <Button onClick={() => setStep(step - 1)}>{tr("上一步", "Back")}</Button>}
          <span className="flex-1 text-right text-footnote text-muted-foreground max-sm:hidden">
            {count(step) ? null : tr(`第 ${step + 1} / 4 步`, `Step ${step + 1} of 4`)}
          </span>
          <FixCount n={count(step)} />
          <Button className="max-sm:hidden" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {step === 3 ? tr("创建节点", "Create node") : tr("下一步", "Next")}
          </Button>
        </>
      }
    >
      {step === 0 && (
        <div className="grid gap-4">
          <RadioCards
            cols={2}
            label={tr("服务器", "Server")}
            value={where}
            onChange={setWhere}
            items={[
              ...choices.map((s) => ({
                value: s.id,
                icon: <Server />,
                title: s.name,
                desc: (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {serverStateOf(s) !== "online" && <ServerStatus server={s} />}
                    {tr(`已有 ${s.nodes.length} 个节点`, `${s.nodes.length} nodes`)}
                    {usedPorts(s).length > 0 &&
                      tr(
                        ` · 占用端口 ${[...new Set(usedPorts(s).map((u) => u.port))].join(tr("、", ", "))}`,
                        ` · ports ${[...new Set(usedPorts(s).map((u) => u.port))].join(", ")}`,
                      )}
                  </span>
                ),
              })),
              {
                value: "new",
                icon: <Plus />,
                title: tr("新建服务器", "New server"),
                desc: tr("同时登记一台新服务器（与节点同名）", "Register a new server too (named like the node)"),
              },
            ]}
          />
          {where === "new" && (
            <div className="grid gap-2 rounded-xl bg-window p-4 ring-1 ring-border ring-inset">
              <Field
                label={tr("TLS 域名", "TLS domain")}
                hint={tr(
                  "可留空；创建后会给出一次性安装命令，服务器名称之后可在设置里改",
                  "Optional; you get a one-time install command after creating; rename the server in its settings later",
                )}
              >
                <Input
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  className="font-mono"
                  placeholder="node1.example.com"
                />
              </Field>
            </div>
          )}
        </div>
      )}
      {step === 1 && (
        <div className="grid gap-3">
          <RadioCards
            cols={3}
            label={tr("协议模板", "Template")}
            value={proto}
            onChange={setProto}
            items={cards.map((c) => ({
              value: c.kind,
              title: c.title,
              desc: c.desc,
              icon: c.kind === "json" ? <Braces /> : c.kind === "vless_reality" ? <Sparkles /> : <Zap />,
            }))}
          />
          <p className="text-footnote text-muted-foreground">
            {tr(
              "表单由协议模板生成；之后可在节点的「入站」里换模板或改成 JSON。一个节点就是一个入站。",
              "The form comes from the template; change the template or switch to JSON later in the node's Inbound section. One node = one inbound.",
            )}
          </p>
        </div>
      )}
      {step === 2 &&
        (proto === "json" ? (
          <div className="grid gap-2">
            <JsonInbound
              value={json}
              onChange={setJson}
              error={tried[2] ? (typeof spec === "string" ? spec : clash) : undefined}
            />
            <p className="text-footnote text-muted-foreground">{usedPortsText(used, tr)}</p>
          </div>
        ) : (
          <TemplateFields
            form={form}
            onChange={(v) => setTpl(v)}
            nodeDomain={domain}
            tried={tried[2]}
            hideTemplate
            portClash={clash}
            portHint={usedPortsText(used, tr)}
          />
        ))}
      {step === 3 && (
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={tr("节点名称", "Node name")}
              required
              hint={tr("后台用，唯一", "Internal, unique")}
              error={tried[3] ? errs[3][0] : undefined}
            >
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-autofocus />
            </Field>
            <Field
              label={tr("显示名", "Display name")}
              hint={tr("用户在门户看到的名称", "What users see in the portal")}
            >
              <Input value={f.display} onChange={(e) => setF({ ...f, display: e.target.value })} />
            </Field>
            <Field label={tr("地区", "Region")}>
              <Input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} />
            </Field>
            <Field
              label={tr("排序", "Sort")}
              hint={tr("越小越靠前", "Smaller first")}
              error={shown(f.sort, sortErr, tried[3])}
            >
              <Input
                inputMode="numeric"
                value={f.sort}
                onChange={(e) => setF({ ...f, sort: e.target.value })}
                className="tnum"
                placeholder="0"
              />
            </Field>
          </div>
          <div className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-window px-4 py-3 ring-1 ring-border ring-inset">
            <span>
              <span className="block text-body font-medium">{tr("对用户显示", "Shown to users")}</span>
              <span className="text-footnote text-muted-foreground">
                {tr("关闭时可以先自己测试，用户订阅里看不到", "Off: test it yourself first; users do not see it")}
              </span>
            </span>
            <Switch
              checked={f.visible}
              onChange={(v) => setF({ ...f, visible: v })}
              label={tr("对用户显示", "Shown to users")}
            />
          </div>
          <section className="grid gap-4 rounded-xl p-4 ring-1 ring-border ring-inset">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info">{tr("直连入口", "Direct entrance")}</Badge>
              <span className="text-footnote text-muted-foreground">
                {tr("随节点一起创建；中转入口之后在节点上添加", "Created with the node; add relays on the node later")}
              </span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tr("入口名称", "Entrance name")} hint={tr("留空 = 直连", "Empty = direct")}>
                <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
              </Field>
              <TagsField value={d.tags} onChange={(v) => setD({ ...d, tags: v })} />
              <Field
                label={tr("连接地址", "Dial host")}
                hint={
                  domain
                    ? tr(`默认：${domain}`, `Default: ${domain}`)
                    : tr("默认是服务器 TLS 域名", "Defaults to the server's TLS domain")
                }
              >
                <Input
                  value={d.host}
                  onChange={(e) => setD({ ...d, host: e.target.value })}
                  className="font-mono"
                  placeholder={domain || undefined}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label={tr("端口", "Port")}
                  hint={tr("留空 = 入站端口", "Empty = inbound's")}
                  error={shown(d.port, dPortErr, tried[3])}
                >
                  <Input
                    inputMode="numeric"
                    value={d.port}
                    onChange={(e) => setD({ ...d, port: e.target.value })}
                    className="tnum"
                    placeholder={port ? String(port) : undefined}
                  />
                </Field>
                <Field label={tr("倍率", "Multiplier")} required error={shown(d.rate, errs[3][3], tried[3])}>
                  <Input
                    inputMode="decimal"
                    value={d.rate}
                    onChange={(e) => setD({ ...d, rate: e.target.value })}
                    className="tnum"
                  />
                </Field>
              </div>
            </div>
            <Field
              group
              label={tr("节点组", "Node groups")}
              hint={tr("谁能用：套餐 → 节点组 → 入口", "Who gets it: plan → node group → entrance")}
            >
              <GroupChips
                groups={groups}
                value={d.groups}
                onChange={(g) => setD({ ...d, groups: g })}
                manageTo="/plans/groups"
              />
            </Field>
          </section>
          <p className="text-footnote text-muted-foreground">
            {d.groups.length
              ? tr(
                  `创建后：订阅里出现 1 条线路，按当前套餐约 ${users.toLocaleString()} 名用户可用。`,
                  `Then: one more line in subscriptions, for about ${users.toLocaleString()} users (from current plans).`,
                )
              : tr(
                  "还没选节点组：创建后没有用户能用这个入口，之后可在入口里加。",
                  "No node group yet: nobody can use the entrance until you add one.",
                )}
          </p>
        </div>
      )}
    </Dialog>
  );
}

/* ================= Node dialog (基本 / 入站 / 审计与流量) ================= */

type FullNode = {
  id: string;
  name: string;
  display_name: string | null;
  region: string | null;
  tags: string[];
  sort: number;
  visible: boolean;
  enabled: boolean;
  server_id: string;
  server_name: string;
  tls_domain: string | null;
  inbound: Record<string, unknown> | null;
  entrances: EntranceView[];
  warnings: string[];
};
type BlockStatus = {
  enabled: boolean;
  agent_supported: boolean;
  in_sync: boolean;
  error: string | null;
  days: { day: string; rule_id: number; name: string; hits: number }[];
};
type BlockRules = { rules: { id: number; name: string; enabled: boolean; entries: number; kind: string }[] };

/** A node: display fields, the inbound and the block switch in one form (?ntab=basic|inbound|audit). */
export function NodeDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({ queryKey: ["nodes", "full", id], queryFn: () => get<FullNode>(`/nodes/${id}`) });
  const block = useQuery({
    queryKey: ["nodes", id, "block-rules"],
    queryFn: () => get<BlockStatus>(`/nodes/${id}/block-rules`),
  });
  useCrumb(q.data ? q.data.display_name || q.data.name : null);
  if (!q.data || !block.data)
    return (
      <Dialog
        open
        size="lg"
        icon={Layers}
        onClose={onClose}
        title={tr("节点", "Node")}
        footer={<Button onClick={onClose}>{tr("关闭", "Close")}</Button>}
      >
        {q.isError || block.isError ? (
          <ErrorState
            compact
            title={tr("节点加载失败", "Could not load the node")}
            error={q.error ?? block.error}
            onRetry={() => void (q.refetch(), block.refetch())}
          />
        ) : (
          <LoadingBlock rows={6} />
        )}
      </Dialog>
    );
  return <NodeEditor key={q.data.id} n={q.data} block={block.data} onClose={onClose} />;
}

type NodeTab = "basic" | "inbound" | "audit";

const streamOf = (inbound: Record<string, unknown> | null) => {
  const st = (inbound?.streamSettings ?? {}) as Record<string, unknown>;
  return { network: String(st.network ?? "tcp"), security: String(st.security ?? "none") };
};

function NodeEditor({ n, block, onClose }: { n: FullNode; block: BlockStatus; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const groups = useGroups();
  const plans = usePlanList();
  const servers = useServers();
  const toggle = useToggleNode();
  const remove = useDeleteNode();
  const [qs, patchQs] = useQS();
  const tab: NodeTab = (["inbound", "audit"] as const).find((t) => t === qs.get("ntab")) ?? "basic";
  const setTab = (t: NodeTab) => patchQs({ ntab: t === "basic" ? null : t }, true);
  const start = {
    name: n.name,
    display_name: n.display_name ?? "",
    region: n.region ?? "",
    sort: String(n.sort),
    visible: n.visible,
  };
  const [f, setF] = useState(start);
  const initialJson = JSON.stringify(n.inbound ?? {}, null, 2);
  const port0 = String((n.inbound?.port as number | undefined) ?? 443);
  const [mode, setMode] = useState<"view" | "template" | "json">("view");
  const [proto, setProto] = useState<TemplateKind>("vless_reality");
  const [tpl, setTpl] = useState<TemplateForm>(() => newTemplateForm(port0));
  const [json, setJson] = useState(initialJson);
  const [blockOn, setBlockOn] = useState(block.enabled);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useAction();
  const server = servers.data?.find((s) => s.id === n.server_id);
  const cards = protoCards(tr).filter((c) => c.kind !== "json");
  const before = String(n.inbound?.protocol ?? "");
  const form: TemplateForm = { ...tpl, template: proto };
  const spec =
    mode === "template" ? toSpec(form, tr, n.tls_domain ?? "") : mode === "json" ? parseInbound(json, tr) : null;
  const inboundEdited = mode === "template" || (mode === "json" && json !== initialJson);
  const after =
    mode === "template"
      ? proto === "transport"
        ? tpl.protocol
        : (cards.find((c) => c.kind === proto)?.protocol ?? "")
      : mode === "json" && spec && typeof spec !== "string"
        ? String(spec.protocol ?? "")
        : before;
  const protoChanged = inboundEdited && !!n.inbound && !!after && after !== before;
  const newPort =
    mode === "template"
      ? num(tpl.port, PORT, tr)[0]
      : spec && typeof spec !== "string"
        ? Number(spec.port) || null
        : null;
  const clash = inboundEdited ? clashOf(tr, usedPorts(server, n.id), newPort, after) : undefined;
  const nameError = !f.name.trim() ? tr("请填写名称", "Enter a name") : undefined;
  const [sortV, sortError] = num(f.sort, SORT_REQ, tr);
  const inboundError = inboundEdited ? (typeof spec === "string" ? spec : clash) : undefined;
  const basicErrors = [nameError, sortError].filter(Boolean).length;
  const errCount = tried ? basicErrors + (inboundError ? 1 : 0) : 0;
  const basicsChanged = JSON.stringify(f) !== JSON.stringify(start);
  const changed = [
    f.name !== start.name && tr("名称", "name"),
    f.display_name !== start.display_name && tr("显示名", "display name"),
    f.region !== start.region && tr("地区", "region"),
    f.sort !== start.sort && tr("排序", "sort"),
    f.visible !== start.visible && tr("对用户显示", "shown to users"),
    inboundEdited && tr("入站", "inbound"),
    blockOn !== block.enabled && tr("出站拦截", "blocking"),
  ].filter(Boolean) as string[];
  const users =
    groups.data && plans.data
      ? holdersOf(
          n.entrances.map((e) => e.id),
          groups.data,
          plans.data,
        )
      : null;
  const { network, security } = streamOf(n.inbound);

  const save = async () => {
    setTried(true);
    setError(null);
    if (basicErrors) return setTab("basic");
    if (inboundError) return setTab("inbound");
    if (!changed.length) return onClose();
    let inbound: Record<string, unknown> | null = null;
    if (inboundEdited && spec && typeof spec !== "string") {
      if (mode === "template") {
        try {
          const r = await post<{ inbound: Record<string, unknown> }>("/inbound-templates/render", {
            template: spec,
            tls_domain: n.tls_domain ?? undefined,
          });
          inbound = r.inbound;
        } catch (e) {
          setTab("inbound");
          return setError(e);
        }
      } else inbound = spec;
      const to = String(inbound.protocol ?? "");
      if (n.inbound && to !== before) {
        const ok = await confirm({
          title: tr(
            `协议从 ${protocolName(before, tr)} 改为 ${protocolName(to, tr)}，重新发放全部凭据？`,
            `Switch from ${protocolName(before, tr)} to ${protocolName(to, tr)} and reissue every credential?`,
          ),
          description: tr(
            "换协议后旧凭据全部失效。用户的客户端要重新拉取订阅才能恢复；没有自动更新订阅的用户会断线直到手动更新。",
            "Old credentials stop working. Clients must refresh the subscription; users without automatic updates stay cut off until they refresh by hand.",
          ),
          impacts: [
            {
              label: tr("重新发放凭据的用户（按当前套餐估算）", "Users reissued (estimated from current plans)"),
              value: users ?? tr("未知", "unknown"),
            },
            { label: tr("一起重建的入口", "Entrances rebuilt with it"), value: n.entrances.length },
          ],
          confirmLabel: tr("保存并重新发放", "Save and reissue"),
          tone: "danger",
        });
        if (!ok) return;
      }
    }
    if (blockOn !== block.enabled) {
      const ok = await confirm({
        title: blockOn ? tr("开启出站拦截？", "Turn on blocking?") : tr("关闭出站拦截？", "Turn off blocking?"),
        description: tr(
          "开关会重建这个节点的入站，在线连接断开后自动重连（规则内容变化热更新，不断线）。之后命中所选规则集的连接会被丢弃，命中次数按天统计。",
          "Switching rebuilds the node's inbound; live connections drop and reconnect (rule edits apply live). Connections matching the enabled rule sets are then dropped, counted per day.",
        ),
        confirmLabel: blockOn ? tr("开启并重建", "Turn on and rebuild") : tr("关闭并重建", "Turn off and rebuild"),
        tone: "warning",
      });
      if (!ok) return;
    }
    const done = await run(
      async () => {
        if (basicsChanged)
          await patch(`/nodes/${n.id}`, {
            name: f.name.trim(),
            display_name: f.display_name.trim() || null,
            region: f.region.trim() || null,
            sort: sortV ?? 0,
            visible: f.visible,
          });
        if (inbound) await put(`/nodes/${n.id}/inbound`, { inbound });
        if (blockOn !== block.enabled) await put(`/nodes/${n.id}/block-rules`, { enabled: blockOn });
        return true;
      },
      {
        ok: inbound
          ? tr("入站已保存，agent 将重建配置", "Inbound saved; the agent rebuilds")
          : blockOn !== block.enabled
            ? blockOn
              ? tr("出站拦截已开启", "Blocking on")
              : tr("出站拦截已关闭", "Blocking off")
            : tr("已保存节点", "Node saved"),
      },
    );
    if (done) onClose();
  };

  return (
    <Dialog
      open
      size="lg"
      icon={Layers}
      onClose={onClose}
      dirty={changed.length > 0}
      onSubmit={save}
      title={tr(`节点 · ${n.name}`, `Node · ${n.name}`)}
      description={
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {n.server_name}
          {n.inbound?.protocol ? ` · ${protocolName(before, tr)} · ${network} · :${String(n.inbound.port ?? "")}` : ""}
          {users !== null && tr(` · 授权 ${users.toLocaleString()}`, ` · ${users.toLocaleString()} users`)}
          {!n.enabled && <Badge>{tr("已停用", "Disabled")}</Badge>}
        </span>
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          label={tr("节点", "Node")}
          tabs={[
            { value: "basic", label: tr("基本", "Basics") },
            {
              value: "inbound",
              label: (
                <>
                  {tr("入站", "Inbound")}
                  {protoChanged && (
                    <span className="text-warning" aria-label={tr("协议会变化", "protocol changes")}>
                      ●
                    </span>
                  )}
                </>
              ),
            },
            { value: "audit", label: tr("审计与流量", "Blocking and traffic") },
          ]}
        />
      }
      footer={
        <>
          <Button
            variant="destructive-soft"
            icon={Trash2}
            className="max-sm:px-2.5"
            onClick={async () => {
              if (await remove(n)) onClose();
            }}
          >
            <span className="max-sm:sr-only">{tr("删除节点", "Delete node")}</span>
          </Button>
          <div className="min-w-0 flex-1 truncate text-right text-footnote text-muted-foreground">
            {errCount ? (
              <FixCount n={errCount} />
            ) : changed.length ? (
              tr(`改动：${changed.join(tr("、", ", "))}`, `Changed: ${changed.join(", ")}`)
            ) : null}
          </div>
          <Button className="max-sm:hidden" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!changed.length}>
            {protoChanged ? tr("保存…", "Save…") : tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <WarningList warnings={n.warnings} />
      {tab === "basic" && (
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={tr("名称", "Name")}
              required
              hint={tr("后台用", "Internal")}
              error={tried ? nameError : undefined}
            >
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field
              label={tr("显示名称", "Display name")}
              hint={tr("门户线路列表显示", "Shown in the portal's line list")}
            >
              <Input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
            </Field>
            <Field label={tr("地区", "Region")}>
              <Input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} />
            </Field>
            <Field
              label={tr("排序", "Sort")}
              hint={tr("越小越靠前", "Smaller first")}
              error={shown(f.sort, sortError, tried)}
            >
              <Input
                inputMode="numeric"
                className="tnum"
                value={f.sort}
                onChange={(e) => setF({ ...f, sort: e.target.value })}
              />
            </Field>
          </div>
          <div className="divide-y divide-separator overflow-hidden rounded-xl ring-1 ring-border ring-inset">
            <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">{tr("对用户显示", "Shown to users")}</span>
                <span className="text-footnote text-muted-foreground">
                  {tr(
                    "关闭后订阅与门户都看不到，但节点照常运行（适合内测）",
                    "Off: left out of subscriptions and the portal, still serving (for testing)",
                  )}
                </span>
              </span>
              <Switch
                checked={f.visible}
                onChange={(v) => setF({ ...f, visible: v })}
                label={tr("对用户显示", "Shown to users")}
              />
            </div>
            <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">{tr("启用", "Enabled")}</span>
                <span className="text-footnote text-muted-foreground">
                  {tr(
                    "停用 = 下发空配置，在线用户立即断开（立即生效，会先确认）",
                    "Off = the empty configuration, online users are cut off (applies at once, asks first)",
                  )}
                </span>
              </span>
              <Switch
                checked={n.enabled}
                label={tr("启用节点", "Node enabled")}
                onChange={() =>
                  void toggle(
                    { id: n.id, name: n.name, enabled: n.enabled, entrances: n.entrances },
                    server?.heartbeat?.metrics?.online_users ?? null,
                  )
                }
              />
            </div>
          </div>
        </div>
      )}
      {tab === "inbound" && (
        <div className="grid gap-5">
          <div className="rounded-xl bg-window p-4 ring-1 ring-border ring-inset">
            <div className="mb-2 text-footnote font-semibold text-muted-foreground">
              {tr("当前入站", "Current inbound")}
            </div>
            {n.inbound ? (
              <KV
                cols={4}
                items={[
                  { k: tr("协议", "Protocol"), v: protocolName(before, tr) },
                  { k: tr("传输", "Transport"), v: network },
                  { k: tr("端口", "Port"), v: <span className="tnum">{String(n.inbound.port ?? "—")}</span> },
                  { k: tr("安全", "Security"), v: security },
                ]}
              />
            ) : (
              <p className="text-body text-muted-foreground">{tr("还没有入站", "No inbound yet")}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              value={mode}
              onChange={setMode}
              label={tr("入站编辑方式", "How to edit")}
              options={[
                { value: "view", label: tr("查看", "View") },
                { value: "template", label: tr("从模板替换", "Replace from template") },
                { value: "json", label: tr("编辑 JSON", "Edit JSON") },
              ]}
            />
            <span className="text-footnote text-muted-foreground">
              {tr("保存前不会影响节点", "Nothing changes until you save")}
            </span>
          </div>
          {mode === "view" && (
            <pre className="max-h-72 overflow-auto rounded-lg bg-window p-3 font-mono text-caption ring-1 ring-border ring-inset">
              {n.inbound ? initialJson : tr("（未配置）", "(none)")}
            </pre>
          )}
          {mode === "template" && (
            <>
              <RadioCards
                cols={3}
                label={tr("协议模板", "Template")}
                value={proto}
                onChange={(v) => setProto(v as TemplateKind)}
                items={cards.map((c) => ({ value: c.kind, title: c.title, desc: c.desc }))}
              />
              <TemplateFields
                form={form}
                onChange={setTpl}
                nodeDomain={n.tls_domain ?? ""}
                tried={tried}
                hideTemplate
                portClash={clash}
              />
            </>
          )}
          {mode === "json" && <JsonInbound value={json} onChange={setJson} error={tried ? inboundError : clash} />}
          {mode !== "view" &&
            (protoChanged ? (
              <Banner tone="warning" icon={<TriangleAlert />} title={tr("协议会变化：", "The protocol changes:")}>
                {tr(
                  `${protocolName(before, tr)} → ${protocolName(after, tr)}。保存时会为全部 ${users ?? "?"} 名用户重新发放凭据（按当前套餐估算），保存前会再次确认。`,
                  `${protocolName(before, tr)} → ${protocolName(after, tr)}. Saving reissues credentials for all ${users ?? "?"} users (estimated from current plans); you confirm before it is saved.`,
                )}
              </Banner>
            ) : (
              <p className="text-footnote text-muted-foreground">
                {tr(
                  "协议不变：用户凭据保留，保存后 agent 重建入站，在线用户约 2 秒内重连。",
                  "Same protocol: credentials stay; the agent rebuilds the inbound and online users reconnect in about 2 s.",
                )}
              </p>
            ))}
          <FormError error={error} />
        </div>
      )}
      {tab === "audit" && (
        <div className="grid gap-5">
          <BlockSection status={block} on={blockOn} onChange={setBlockOn} />
          <section>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-body font-semibold">{tr("节点流量 · 30 天", "Node traffic · 30 days")}</h4>
              <Link
                to={`/nodes/${n.server_id}?tab=monitor`}
                className="text-footnote font-medium text-primary hover:underline"
              >
                {tr("在监控中查看", "Open the monitor")}
              </Link>
            </div>
            <NodeTrafficBody id={n.id} height={170} topN={3} />
          </section>
        </div>
      )}
    </Dialog>
  );
}

/** The block switch (part of the form) and the global rule sets with this node's 7-day hits (read-only). */
function BlockSection({ status, on, onChange }: { status: BlockStatus; on: boolean; onChange: (v: boolean) => void }) {
  const tr = useTr();
  const rules = useQuery({ queryKey: ["block-rules"], queryFn: () => get<BlockRules>("/block-rules") });
  const hits = new Map<number, number>();
  for (const x of status.days) hits.set(x.rule_id, (hits.get(x.rule_id) ?? 0) + x.hits);
  const enabled = (rules.data?.rules ?? []).filter((r) => r.enabled);
  return (
    <section className="overflow-hidden rounded-xl ring-1 ring-border ring-inset">
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary"
          aria-hidden="true"
        >
          <ShieldBan className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-semibold">{tr("出站拦截", "Outbound blocking")}</span>
          <span className="text-footnote text-muted-foreground">
            {!status.agent_supported ? (
              <span className="text-warning">
                {tr("这台服务器的 agent 不支持，升级后生效", "This server's agent lacks support; update it")}
              </span>
            ) : status.enabled && !status.in_sync ? (
              <span className="text-warning">
                {tr("规则已改，等待节点同步（约 30 秒）", "Changed; waiting for the node (about 30 s)")}
              </span>
            ) : (
              tr(
                "丢弃命中规则集的连接；开关会重建入站（保存时确认）",
                "Drops connections matching the rule sets; switching rebuilds the inbound (confirmed on save)",
              )
            )}
          </span>
        </span>
        <Switch checked={on} onChange={onChange} label={tr("出站拦截", "Outbound blocking")} />
      </div>
      {status.error && (
        <details className="border-t border-separator px-4 py-2 text-body text-destructive">
          <summary className="cursor-default">
            {tr("agent 应用规则失败", "The agent failed to apply the rules")}
          </summary>
          <p className="font-mono text-caption break-all">{status.error}</p>
        </details>
      )}
      {on && (
        <div className="divide-y divide-separator border-t border-separator">
          {rules.isError && <ErrorState compact error={rules.error} onRetry={() => void rules.refetch()} />}
          {rules.isPending && <LoadingBlock rows={2} />}
          {rules.data && enabled.length === 0 && (
            <p className="px-4 py-3 text-footnote text-muted-foreground">
              {tr("还没有开启任何规则集", "No rule set is on")}
            </p>
          )}
          {enabled.map((r) => (
            <div key={r.id} className="flex min-h-12 items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">{r.name}</span>
                <span className="text-footnote text-muted-foreground">
                  {tr(`${r.entries} 条`, `${r.entries} entries`)}
                </span>
              </span>
              <span className="tnum text-footnote text-muted-foreground">
                {tr(
                  `7 天命中 ${(hits.get(r.id) ?? 0).toLocaleString()}`,
                  `${(hits.get(r.id) ?? 0).toLocaleString()} hits in 7 days`,
                )}
              </span>
            </div>
          ))}
          <div className="px-4 py-2 text-footnote text-muted-foreground">
            {tr(
              "规则集对所有开启拦截的节点生效，内容与开关在",
              "Rule sets apply to every node with blocking on; edit them in",
            )}{" "}
            <Link to="/settings/block" className="text-primary hover:underline">
              {tr("设置 → 出站拦截", "Settings → Blocking")}
            </Link>
            {tr("。", ".")}
          </div>
        </div>
      )}
    </section>
  );
}

/* ================= Mount from the URL ================= */

/**
 * Every dialog of the nodes area, mounted from the URL: `?new=server|node|relay`
 * (`&server=` preselects, `&for=<node>` the relay's node), `?node=<id>&ntab=`,
 * `?entrance=<id>&etab=`, `?action=install|enroll` (on a server page).
 */
export function NodesDialogs({ serverId }: { serverId?: string }) {
  const [query, patchQs] = useQS();
  const servers = useServers();
  const groups = useGroups();
  const [shown, setShown] = useState<Shown | null>(null);
  const list = servers.data ?? [];
  const creating = query.get("new");
  const action = query.get("action");
  const server = serverId ? list.find((s) => s.id === serverId) : undefined;
  const nodeId = query.get("node");
  const entId = query.get("entrance");
  const forId = query.get("for");
  let ent: { e: EntranceView; n: ServerNode; s: ServerView } | null = null;
  let forNode: { n: ServerNode; s: ServerView } | undefined;
  for (const s of list)
    for (const n of s.nodes) {
      if (n.id === forId) forNode = { n, s };
      for (const e of n.entrances) if (e.id === entId) ent = { e, n, s };
    }
  return (
    <>
      {creating === "server" && (
        <AddServerDialog
          onClose={() => patchQs({ new: null })}
          onCreated={(s) => {
            patchQs({ new: null });
            setShown(s);
          }}
        />
      )}
      {creating === "node" && servers.isSuccess && (
        <NewNodeWizard
          servers={list}
          groups={groups.data ?? []}
          preset={query.get("server")}
          onClose={() => patchQs({ new: null, server: null })}
          onShown={setShown}
        />
      )}
      {creating === "relay" && servers.isSuccess && (
        <RelayDialog
          target={forNode}
          servers={list}
          groups={groups.data ?? []}
          onClose={() => patchQs({ new: null, for: null })}
        />
      )}
      {server && action === "install" && (
        <CommandDialog
          shown={{ install: { id: server.id, name: server.name } }}
          onClose={() => patchQs({ action: null })}
        />
      )}
      {server && action === "enroll" && <EnrollDialog server={server} onClose={() => patchQs({ action: null })} />}
      {shown && <CommandDialog shown={shown} onClose={() => setShown(null)} />}
      {nodeId && <NodeDialog id={nodeId} onClose={() => patchQs({ node: null, ntab: null })} />}
      {ent && (
        <EntranceDialog
          key={ent.e.id}
          entrance={ent.e}
          node={ent.n}
          server={ent.s}
          groups={groups.data ?? []}
          onClose={() => patchQs({ entrance: null, etab: null })}
        />
      )}
    </>
  );
}
