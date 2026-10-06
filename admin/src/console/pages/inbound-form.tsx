// The node's one inbound (D2): a protocol template (nodetpl.rs InboundSpec;
// the free "transport" template is generated from the manifest, W26) or an
// xray inbound object (advanced JSON). REALITY dests can be checked from
// the panel (TLS 1.3 + h2).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { get, post } from "../../shared/api";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Button, Checkbox, Field, Input, Select, Textarea } from "../../shared/ui/primitives";
import { useErrText } from "../kit";
import {
  fieldDefault,
  networkOptionLabel,
  protocolOptionLabel,
  templateRequiresTls,
  transportFields,
  transportLabel,
  transportTemplateNetworks,
  transportTemplateProtocols,
} from "../protocol-form";

export type TemplateKind =
  | "vless_reality"
  | "vless_reality_xhttp"
  | "vless_tls_vision"
  | "vless_ws_tls"
  | "vmess_ws"
  | "vmess_tcp"
  | "trojan_tls"
  | "transport"
  | "shadowsocks_2022"
  | "hysteria2";

export const TEMPLATES: TemplateKind[] = [
  "vless_reality",
  "vless_reality_xhttp",
  "vless_tls_vision",
  "vless_ws_tls",
  "vmess_ws",
  "vmess_tcp",
  "trojan_tls",
  "transport",
  "shadowsocks_2022",
  "hysteria2",
];

export function templateLabel(k: TemplateKind, tr: Tr): string {
  return {
    vless_reality: tr(
      "VLESS + REALITY + Vision（推荐，无需证书与域名）",
      "VLESS + REALITY + Vision (recommended, no certificate)",
    ),
    vless_reality_xhttp: tr("VLESS + REALITY + XHTTP（无需证书）", "VLESS + REALITY + XHTTP (no certificate)"),
    vless_tls_vision: tr("VLESS + TCP + TLS + Vision（需证书）", "VLESS + TCP + TLS + Vision (certificate)"),
    vless_ws_tls: tr("VLESS + WebSocket + TLS（需证书）", "VLESS + WebSocket + TLS (certificate)"),
    vmess_ws: tr("VMess + WebSocket（可选 TLS）", "VMess + WebSocket (optional TLS)"),
    vmess_tcp: tr("VMess + TCP（无 TLS）", "VMess + TCP (no TLS)"),
    trojan_tls: tr("Trojan + TLS（需证书）", "Trojan + TLS (certificate)"),
    transport: tr(
      "VLESS/VMess/Trojan + 自选传输（WS / HTTPUpgrade / XHTTP / gRPC）",
      "VLESS/VMess/Trojan + a transport (WS / HTTPUpgrade / XHTTP / gRPC)",
    ),
    shadowsocks_2022: tr("Shadowsocks 2022（多用户，TCP+UDP）", "Shadowsocks 2022 (multi-user, TCP+UDP)"),
    hysteria2: tr("Hysteria 2（QUIC/UDP，需证书）", "Hysteria 2 (QUIC/UDP, certificate)"),
  }[k];
}

export type TemplateForm = {
  template: TemplateKind;
  port: string;
  dest: string;
  customDest: string;
  serverName: string;
  fingerprint: string;
  vision: boolean;
  domain: string;
  path: string;
  tls: boolean;
  protocol: string;
  network: string;
  host: string;
  mode: string;
  serviceName: string;
  method: string;
};

export function newTemplateForm(port = "443"): TemplateForm {
  return {
    template: "vless_reality",
    port,
    dest: "",
    customDest: "",
    serverName: "",
    fingerprint: fieldDefault("security", "reality", "fingerprint"),
    vision: true,
    domain: "",
    path: "",
    tls: false,
    protocol: "vless",
    network: "ws",
    host: "",
    mode: fieldDefault("transport", "xhttp", "mode"),
    serviceName: "",
    method: "",
  };
}

type Catalog = { reality_dests: string[]; fingerprints: string[]; ss_methods?: string[]; xhttp_modes?: string[] };

const FIELD_KEYS: Record<string, "path" | "host" | "mode" | "serviceName"> = {
  path: "path",
  host: "host",
  mode: "mode",
  service_name: "serviceName",
};

/** The API spec of the form, or an error text. `nodeDomain` = the server's TLS domain. */
export function toSpec(r: TemplateForm, tr: Tr, nodeDomain = ""): Record<string, unknown> | string {
  const port = Number(r.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return tr("端口须为 1–65535", "The port must be 1–65535");
  const domain = r.domain.trim();
  const hasNode = nodeDomain.trim() !== "";
  const und = (v: string) => (v.trim() ? v.trim() : undefined);
  const reality = () => ({
    dest: r.dest === "custom" ? und(r.customDest) : und(r.dest),
    server_name: und(r.serverName),
    fingerprint: und(r.fingerprint),
  });
  if (
    (r.template === "vless_reality" || r.template === "vless_reality_xhttp") &&
    r.dest === "custom" &&
    !r.customDest.trim()
  )
    return tr("请填写自定义目标站点", "Enter the custom target");
  switch (r.template) {
    case "vless_reality":
      return { template: r.template, port, ...reality(), vision: r.vision ? undefined : false };
    case "vless_reality_xhttp":
      return {
        template: r.template,
        port,
        ...reality(),
        path: und(r.path),
        mode: r.mode && r.mode !== "auto" ? r.mode : undefined,
      };
    case "vless_ws_tls":
    case "trojan_tls":
    case "vless_tls_vision":
    case "hysteria2":
      if (!domain && !hasNode)
        return tr(
          "请填写证书域名（或先设置服务器域名）",
          "Enter the certificate domain (or set the server's TLS domain)",
        );
      return r.template === "vless_ws_tls"
        ? { template: r.template, port, domain: domain || undefined, path: und(r.path) }
        : { template: r.template, port, domain: domain || undefined };
    case "vmess_ws":
      if (r.tls && !domain && !hasNode) return tr("启用 TLS 时请填写证书域名", "TLS needs a certificate domain");
      return {
        template: r.template,
        port,
        path: und(r.path),
        tls_domain: r.tls ? domain || undefined : undefined,
        tls: r.tls && !domain ? true : undefined,
      };
    case "vmess_tcp":
      return { template: r.template, port };
    case "transport": {
      const networks = transportTemplateNetworks(r.protocol);
      const network = networks.includes(r.network) ? r.network : (networks[0] ?? "ws");
      const tls = r.tls || templateRequiresTls(r.protocol, network);
      if (tls && !domain && !hasNode)
        return tr("该组合需要 TLS：请填写证书域名", "This combination needs TLS: enter the certificate domain");
      const fields: Record<string, string | undefined> = {};
      for (const f of transportFields(network)) {
        const v = (r[FIELD_KEYS[f.name]] ?? "").trim();
        fields[f.name] = v && (f.type !== "enum" || v !== (f.default ?? "")) ? v : undefined;
      }
      return {
        template: "transport",
        port,
        protocol: r.protocol,
        network,
        path: fields.path,
        host: fields.host,
        mode: fields.mode,
        service_name: fields.service_name,
        tls_domain: tls ? domain || undefined : undefined,
        tls: tls && !domain ? true : undefined,
      };
    }
    case "shadowsocks_2022":
      return { template: r.template, port, method: und(r.method) };
  }
}

export function useCatalog() {
  return useQuery({
    queryKey: ["inbound-templates"],
    queryFn: () => get<Catalog>("/inbound-templates"),
    staleTime: 300_000,
  });
}

export function TemplateFields({
  form,
  onChange,
  nodeDomain = "",
}: {
  form: TemplateForm;
  onChange: (f: TemplateForm) => void;
  nodeDomain?: string;
}) {
  const tr = useTr();
  const lang = useLang();
  const errText = useErrText();
  const catalog = useCatalog();
  const [check, setCheck] = useState<string | null>(null);
  const set = (p: Partial<TemplateForm>) => onChange({ ...form, ...p });
  const t = form.template;
  const reality = t === "vless_reality" || t === "vless_reality_xhttp";
  const needDomain =
    ["vless_tls_vision", "vless_ws_tls", "trojan_tls", "hysteria2"].includes(t) || (t === "vmess_ws" && form.tls);
  const domainHint = nodeDomain ? tr(`默认：${nodeDomain}`, `default: ${nodeDomain}`) : "node1.example.com";
  const checkDest = async () => {
    const dest = form.dest === "custom" ? form.customDest.trim() : form.dest || catalog.data?.reality_dests[0];
    if (!dest) return;
    setCheck(tr("检测中…", "Checking…"));
    try {
      const v = await post<{ ok: boolean; trusted: boolean; error: string | null }>("/inbound-templates/check-dest", {
        dest,
      });
      setCheck(
        v.ok
          ? tr(
              `可用：TLS 1.3 + h2${v.trusted ? "" : "（证书非公共信任）"}`,
              `Usable: TLS 1.3 + h2${v.trusted ? "" : " (certificate not publicly trusted)"}`,
            )
          : tr(`不可用：${v.error ?? "未知原因"}`, `Not usable: ${v.error ?? "unknown"}`),
      );
    } catch (e) {
      setCheck(errText(e));
    }
  };
  const networks = transportTemplateNetworks(form.protocol);
  const network = networks.includes(form.network) ? form.network : (networks[0] ?? "ws");
  const tlsRequired = t === "transport" && templateRequiresTls(form.protocol, network);
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <Field label={tr("协议模板", "Template")} className="sm:col-span-3">
        <Select value={t} onChange={(e) => set({ template: e.target.value as TemplateKind })}>
          {TEMPLATES.map((k) => (
            <option key={k} value={k}>
              {templateLabel(k, tr)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={tr("端口", "Port")}>
        <Input inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value })} />
      </Field>
      {reality && (
        <>
          <Field label={tr("目标站点（dest）", "Target (dest)")} className="sm:col-span-2">
            <Select value={form.dest} onChange={(e) => set({ dest: e.target.value })}>
              <option value="">{tr("随机选一个推荐站点", "Random recommended site")}</option>
              {catalog.data?.reality_dests.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              <option value="custom">{tr("自定义…", "Custom…")}</option>
            </Select>
          </Field>
          {form.dest === "custom" ? (
            <Field label={tr("自定义目标（域名[:端口]）", "Custom target (host[:port])")} className="sm:col-span-2">
              <Input value={form.customDest} onChange={(e) => set({ customDest: e.target.value })} />
            </Field>
          ) : (
            <Field label="SNI" className="sm:col-span-2" hint={tr("可选", "optional")}>
              <Input value={form.serverName} onChange={(e) => set({ serverName: e.target.value })} />
            </Field>
          )}
          <Field label={tr("客户端指纹", "Fingerprint")}>
            <Select value={form.fingerprint} onChange={(e) => set({ fingerprint: e.target.value })}>
              {(catalog.data?.fingerprints ?? [form.fingerprint]).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end gap-2 sm:col-span-3">
            <Button size="sm" onClick={checkDest}>
              {tr("检测目标站点", "Check target")}
            </Button>
            {check && (
              <span role="status" className="pb-1.5 text-xs text-muted-foreground">
                {check}
              </span>
            )}
          </div>
          {t === "vless_reality" && (
            <label className="flex items-center gap-2 text-[13px] sm:col-span-4">
              <Checkbox checked={form.vision} onChange={(v) => set({ vision: v })} label="Vision" />
              {tr("启用 Vision 流控（推荐）", "Vision flow (recommended)")}
            </label>
          )}
        </>
      )}
      {(t === "vless_reality_xhttp" || t === "vless_ws_tls" || t === "vmess_ws") && (
        <Field label={tr("路径（可选）", "Path (optional)")} className="sm:col-span-2">
          <Input value={form.path} placeholder="/" onChange={(e) => set({ path: e.target.value })} />
        </Field>
      )}
      {t === "vless_reality_xhttp" && (
        <Field label={tr("XHTTP 模式", "XHTTP mode")} className="sm:col-span-2">
          <Select value={form.mode} onChange={(e) => set({ mode: e.target.value })}>
            {(catalog.data?.xhttp_modes ?? ["auto"]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {t === "vmess_ws" && (
        <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
          <Checkbox checked={form.tls} onChange={(v) => set({ tls: v })} label="TLS" />
          {tr("启用 TLS", "Enable TLS")}
        </label>
      )}
      {t === "transport" && (
        <>
          <Field label={tr("代理协议", "Protocol")} className="sm:col-span-2">
            <Select value={form.protocol} onChange={(e) => set({ protocol: e.target.value })}>
              {transportTemplateProtocols().map((p) => (
                <option key={p.id} value={p.id}>
                  {protocolOptionLabel(p, lang)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr("传输方式", "Transport")} className="sm:col-span-2">
            <Select value={network} onChange={(e) => set({ network: e.target.value })}>
              {networks.map((n) => (
                <option key={n} value={n}>
                  {networkOptionLabel(form.protocol, n, lang)}
                </option>
              ))}
            </Select>
          </Field>
          {!tlsRequired && (
            <label className="flex items-center gap-2 text-[13px] sm:col-span-4">
              <Checkbox checked={form.tls} onChange={(v) => set({ tls: v })} label="TLS" />
              {tr("启用 TLS", "Enable TLS")}
            </label>
          )}
          {transportFields(network).map((f) => {
            const key = FIELD_KEYS[f.name];
            if (!key) return null;
            const label = `${transportLabel(network, lang)} ${lang === "en" ? f.name : f.label_zh}`;
            return (
              <Field
                key={f.name}
                label={label}
                className="sm:col-span-2"
                hint={f.required || f.type === "enum" ? undefined : tr("可选", "optional")}
              >
                {f.type === "enum" ? (
                  <Select value={form[key] || (f.default ?? "")} onChange={(e) => set({ [key]: e.target.value })}>
                    {f.values.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    value={form[key]}
                    placeholder={f.help_zh ?? ""}
                    onChange={(e) => set({ [key]: e.target.value })}
                  />
                )}
              </Field>
            );
          })}
        </>
      )}
      {(needDomain || (t === "transport" && (form.tls || tlsRequired))) && (
        <Field
          label={tr("证书域名", "Certificate domain")}
          className="sm:col-span-2"
          hint={tr("留空 = 服务器域名", "empty = the server's TLS domain")}
        >
          <Input value={form.domain} placeholder={domainHint} onChange={(e) => set({ domain: e.target.value })} />
        </Field>
      )}
      {t === "shadowsocks_2022" && (
        <Field label={tr("加密方式", "Method")} className="sm:col-span-2">
          <Select value={form.method} onChange={(e) => set({ method: e.target.value })}>
            <option value="">{tr("默认", "Default")}</option>
            {(catalog.data?.ss_methods ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  );
}

/** Raw xray inbound JSON (an object without tag). */
export function JsonInbound({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tr = useTr();
  return (
    <Field label={tr("Xray 入站 JSON（对象，不含 tag）", "Xray inbound JSON (an object, no tag)")}>
      <Textarea rows={12} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </Field>
  );
}

/** Parse the JSON editor: an object or an error text. */
export function parseInbound(text: string, tr: Tr): Record<string, unknown> | string {
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v))
      return tr("入站必须是 JSON 对象", "The inbound must be a JSON object");
    return v as Record<string, unknown>;
  } catch (e) {
    return tr(`JSON 格式错误：${String(e)}`, `Invalid JSON: ${String(e)}`);
  }
}
