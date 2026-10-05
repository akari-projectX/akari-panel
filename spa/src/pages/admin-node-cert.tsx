// 节点域名与自动证书（W10，agent 协议 6）：向导/编辑里的「节点域名」输入与解析
// 预检（只警告），以及节点页上的证书状态（中文、可操作的错误说明）。
// 后台只做中文（R18）。
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { post, type CertStatus, type CheckDomainView, type NodeView } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { fmtDate, fmtDateTime } from "../lib/datetime";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

/** Agents from this protocol on obtain the certificate themselves. */
export const ACME_PROTOCOL = 6;

const CERT_FILE = "/run/credentials/akari-agent.service/tls_fullchain.pem";

function readsNodeCert(inbound: NodeView["inbound"]): boolean {
  return inbound !== null && JSON.stringify(inbound).includes(CERT_FILE);
}

function fmt(ts: string | null): string {
  return fmtDateTime(ts);
}

function fmtDay(ts: string | null): string {
  return fmtDate(ts);
}

/** One line about a DNS pre-flight result (warn only). */
export function describeCheck(c: CheckDomainView): { ok: boolean; text: string } {
  if (c.error) {
    return { ok: false, text: `域名 ${c.domain} 无法解析（${c.error}）：请添加 A/AAAA 记录指向节点 IP` };
  }
  const got = c.addresses.join("、");
  if (c.cloudflare) {
    return {
      ok: false,
      text: `域名解析到 Cloudflare 代理（${got}）：节点域名必须是「仅 DNS」（灰色云朵），否则证书申请与 TLS 入站都会失败`,
    };
  }
  if (c.matches === false) {
    return { ok: false, text: `域名未解析到本机 IP ${c.expected.join("、")}（当前解析到 ${got}）` };
  }
  if (c.matches === true) return { ok: true, text: `解析正确：${got}` };
  return { ok: true, text: `当前解析到 ${got}（节点地址未知，安装后可在节点页再检查）` };
}

async function checkDomain(domain: string, nodeId?: string, connectHost?: string): Promise<CheckDomainView> {
  return post<CheckDomainView>("/inbound-templates/check-domain", {
    domain,
    node_id: nodeId,
    connect_host: connectHost?.trim() || undefined,
  });
}

/**
 * 「节点域名」输入框 + 解析预检。为空 = 不自动申请证书（证书文件手工放到节点上）。
 */
export function TlsDomainField({
  id,
  value,
  onChange,
  nodeId,
  connectHost,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  nodeId?: string;
  connectHost?: string;
}) {
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    const d = value.trim();
    if (!d) return;
    setBusy(true);
    setCheck(null);
    try {
      setCheck(describeCheck(await checkDomain(d, nodeId, connectHost)));
    } catch (err) {
      setCheck({ ok: false, text: adminErrorText(err, "检查失败") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>节点域名（TLS，可选）</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          className="w-64"
          value={value}
          placeholder="node1.example.com"
          onChange={(e) => {
            onChange(e.target.value);
            setCheck(null);
          }}
          onBlur={() => void run()}
        />
        <Button type="button" variant="outline" size="sm" disabled={busy || !value.trim()} onClick={() => void run()}>
          {busy ? "检查中…" : "检查解析"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        填写后 agent 自动向 Let&apos;s Encrypt 申请并续期证书（需域名解析到节点、TCP 80 可从公网访问），TLS
        模板默认使用它；留空则使用手工放到节点上的证书。
      </p>
      {check && (
        <p
          role={check.ok ? "status" : "alert"}
          className={`text-xs ${check.ok ? "text-emerald-700" : "text-amber-600"}`}
        >
          {check.text}
        </p>
      )}
    </div>
  );
}

/** The actionable sentence for a failed order (Chinese). */
export function certErrorText(c: CertStatus, agentAddr: string | null | undefined): string {
  const ip = agentAddr ? `本机 IP ${agentAddr}` : "节点的公网 IP";
  const retry = c.next_attempt ? `，agent 将于 ${fmt(c.next_attempt)} 自动重试` : "";
  switch (c.error_kind) {
    case "dns":
      return `域名 ${c.domain} 无法解析：请添加 A/AAAA 记录指向${ip}${retry}`;
    case "connection":
      return `Let's Encrypt 无法访问本节点：请确认域名 ${c.domain} 解析到${ip}，并在防火墙/安全组放行 TCP 80（80 端口不可达）${retry}`;
    case "port_busy":
      return `80 端口被占用，且 443 端口被入站占用或不可用：请停止占用 TCP 80 的程序（如 nginx/apache）${retry}`;
    case "rate_limited":
      return `触发 Let's Encrypt 频率限制${retry}；无需操作，频繁重装或更换域名会加重限制`;
    case "caa":
      return `域名的 CAA 记录不允许 Let's Encrypt 签发：请在 DNS 中允许 letsencrypt.org 或删除 CAA 记录${retry}`;
    case "rejected":
      return `证书颁发机构拒绝为 ${c.domain} 签发证书：请更换节点域名`;
    case "ca_unreachable":
      return `节点无法连接证书颁发机构：请检查节点的出站网络与 DNS${retry}`;
    default:
      return `证书申请失败${retry}`;
  }
}

/** 节点页上的证书状态（只在设置了节点域名时出现）。 */
export function NodeCertStatus({ node }: { node: NodeView }) {
  const domain = node.tls_domain;
  const cert = node.heartbeat?.cert ?? null;
  const failed = cert?.state === "failed" && (cert.error_kind === "dns" || cert.error_kind === "connection");
  // DNS problems: say what the domain resolves to, from the panel.
  const dns = useQuery({
    queryKey: ["check-domain", node.id, domain],
    queryFn: () => checkDomain(domain ?? "", node.id),
    enabled: !!domain && failed,
    staleTime: 60_000,
    retry: false,
  });
  if (!domain) return null;
  const needs = readsNodeCert(node.inbound);
  let tone = "text-muted-foreground";
  let text: string;
  if (!needs) {
    text = "没有需要证书的入站（如仅 REALITY），不会申请证书";
  } else if (node.agent_protocol !== null && node.agent_protocol < ACME_PROTOCOL) {
    tone = "text-amber-600";
    text = "agent 版本过旧，不会自动申请证书：请升级 agent（更新页），或手工放置证书";
  } else if (!cert) {
    text = node.status === "online" ? "等待 agent 上报证书状态…" : "节点上线后自动申请证书";
  } else if (cert.state === "valid") {
    tone = "text-emerald-700";
    text = `证书有效，到期 ${fmtDay(cert.not_after)}，将于 ${fmtDay(cert.next_attempt)} 前后自动续期`;
  } else if (cert.state === "pending") {
    text = "正在申请证书…";
  } else {
    tone = "text-destructive";
    text = certErrorText(cert, node.agent_addr);
    if (cert.not_after) text += `（当前证书仍有效至 ${fmtDay(cert.not_after)}）`;
  }
  const dnsLine = failed && dns.data ? describeCheck(dns.data) : null;
  return (
    <div className="space-y-1 text-sm" data-testid="node-cert-status">
      <p>
        <span className="font-medium">证书（{domain}）：</span>
        <span role={tone === "text-destructive" ? "alert" : "status"} className={tone}>
          {text}
        </span>
      </p>
      {dnsLine && !dnsLine.ok && <p className="text-xs text-amber-600">{dnsLine.text}</p>}
      {cert?.last_error && cert.state !== "valid" && (
        <details className="text-xs text-muted-foreground">
          <summary>
            详细错误（{cert.challenge ?? "—"}，连续失败 {cert.failures} 次，{fmt(cert.last_error_at)}）
          </summary>
          <code className="break-all">{cert.last_error}</code>
        </details>
      )}
    </div>
  );
}
