// W26: the node form, generated from the protocol manifest
// (proto/protocols.toml → protocols.gen.ts, `make gen-protocols`).
// Which protocols the free "transport" template offers, which transports
// each protocol has, which of them need TLS, the fields a transport takes
// (labels, help, choices) and what each subscription format leaves out all
// come from the manifest; the common templates (REALITY, Vision, …) are
// per-template UI overrides in inbound-form.tsx that read their choices
// (fingerprints, XHTTP modes, SS methods) from here too.
import type { Lang } from "../shared/i18n";
import { MANIFEST, type ManifestField, type ManifestProtocol } from "./protocols.gen";

const byId = <T extends { id: string }>(list: T[], id: string): T | undefined => list.find((x) => x.id === id);

function protocolSpec(id: string): ManifestProtocol | undefined {
  return byId(MANIFEST.protocols, id);
}

/** Transports with their own settings: the ones the free template stacks. */
function stackableTransports(): string[] {
  return MANIFEST.transports.filter((t) => t.fields.length > 0).map((t) => t.id);
}

/** Protocols the free "transport" template offers (those that stack). */
export function transportTemplateProtocols(): ManifestProtocol[] {
  const stack = stackableTransports();
  return MANIFEST.protocols.filter((p) => p.transports.some((t) => stack.includes(t)));
}

/** Transports of `protocol` the free template offers. */
export function transportTemplateNetworks(protocol: string): string[] {
  const stack = stackableTransports();
  return (protocolSpec(protocol)?.transports ?? []).filter((t) => stack.includes(t));
}

function selects(sel: Record<string, string[]>, values: Record<string, string>): boolean {
  return Object.entries(sel).every(([k, vs]) => values[k] !== undefined && vs.includes(values[k]));
}

/** The templates put this combination behind TLS (protocol flag or a
 * template rule that refuses it without TLS). */
export function templateRequiresTls(protocol: string, transport: string): boolean {
  if (protocolSpec(protocol)?.template_requires_tls) return true;
  const sel = { protocol, transport, security: "none" };
  return MANIFEST.rules.some((r) => selects(r.when, sel) && !selects(r.require, sel));
}

/** The form fields of a transport (manifest order). */
export function transportFields(transport: string): ManifestField[] {
  return byId(MANIFEST.transports, transport)?.fields ?? [];
}

export function transportLabel(transport: string, lang: Lang = "zh"): string {
  const t = byId(MANIFEST.transports, transport);
  return (lang === "en" ? t?.label : t?.label_zh) ?? transport;
}

/** Subscription formats that leave this combination out ("sing-box 不支持"). */
export function unsupportedFormats(protocol: string, transport: string): string[] {
  return MANIFEST.formats
    .filter((f) =>
      f.unsupported.some(
        (u) =>
          (u.protocol.length === 0 || u.protocol.includes(protocol)) &&
          !u.protocol_not.includes(protocol) &&
          (u.transport.length === 0 || u.transport.includes(transport)),
      ),
    )
    .map((f) => f.label);
}

/** The option label of a transport in the free template's select. */
export function networkOptionLabel(protocol: string, transport: string, lang: Lang = "zh"): string {
  const notes: string[] = unsupportedFormats(protocol, transport).map((f) =>
    lang === "en" ? `no ${f}` : `${f} 不支持`,
  );
  if (templateRequiresTls(protocol, transport) && !protocolSpec(protocol)?.template_requires_tls)
    notes.push(lang === "en" ? "needs TLS" : "需 TLS");
  const label = transportLabel(transport, lang);
  if (!notes.length) return label;
  const sep = lang === "en" ? "; " : "；";
  return lang === "en" ? `${label} (${notes.join(sep)})` : `${label}（${notes.join(sep)}）`;
}

export function protocolOptionLabel(p: ManifestProtocol, lang: Lang = "zh"): string {
  const label = lang === "en" ? p.label : p.label_zh;
  return p.template_requires_tls ? (lang === "en" ? `${label} (needs TLS)` : `${label}（需 TLS）`) : label;
}

// English twins of the manifest's field labels, help texts and value
// labels. proto/protocols.toml carries only the console's Chinese
// (`label_zh`, `help_zh`, `value_labels_zh`): the agent vendors that file
// and decodes it strictly (unknown keys are errors), so English fields there
// would need a coordinated agent change. protocol-form.test.ts fails when a
// manifest field has no twin here. Key: `<owner>.<id>.<field>`.
type FieldEn = { label: string; help?: string; values?: string[] };
const PATH_HELP = "Starts with /; empty = random";
const HOST_HELP = "Host header the client sends (optional)";
export const FIELD_EN: Record<string, FieldEn> = {
  "security.tls.server_name": { label: "Certificate domain (SNI)", help: "Empty = the node domain" },
  "security.reality.dest": {
    label: "Target site",
    help: "host or host:port (default 443); empty = first in the list",
  },
  "security.reality.server_name": { label: "SNI", help: "Empty = the target site's domain" },
  "security.reality.fingerprint": { label: "uTLS fingerprint" },
  "transport.ws.path": { label: "Path", help: PATH_HELP },
  "transport.ws.host": { label: "Host", help: HOST_HELP },
  "transport.httpupgrade.path": { label: "Path", help: PATH_HELP },
  "transport.httpupgrade.host": { label: "Host", help: HOST_HELP },
  "transport.xhttp.path": { label: "Path", help: PATH_HELP },
  "transport.xhttp.host": { label: "Host", help: HOST_HELP },
  "transport.xhttp.mode": { label: "Mode" },
  "transport.grpc.service_name": { label: "serviceName", help: "Empty = random" },
  "protocol.vless.flow": { label: "Flow", values: ["None", "Vision (xtls-rprx-vision)"] },
  "protocol.vless.encryption": { label: "Encryption" },
  "protocol.ss2022.method": { label: "Cipher" },
  "protocol.ss2022.psk": { label: "Server key" },
  "protocol.ss2022.network": { label: "Network" },
};

type Owner = "security" | "transport" | "protocol";

/** A manifest field's label in the console language. */
export function fieldLabel(owner: Owner, id: string, f: ManifestField, lang: Lang = "zh"): string {
  return lang === "en" ? (FIELD_EN[`${owner}.${id}.${f.name}`]?.label ?? f.name) : f.label_zh;
}

/** A manifest field's help text (placeholder) in the console language. */
export function fieldHelp(owner: Owner, id: string, f: ManifestField, lang: Lang = "zh"): string {
  if (f.help_zh === null) return "";
  return lang === "en" ? (FIELD_EN[`${owner}.${id}.${f.name}`]?.help ?? "") : f.help_zh;
}

/** The label of an enum value (the value itself when the manifest names none). */
export function valueLabel(owner: Owner, id: string, f: ManifestField, value: string, lang: Lang = "zh"): string {
  const i = f.values.indexOf(value);
  const labels = lang === "en" ? FIELD_EN[`${owner}.${id}.${f.name}`]?.values : f.value_labels_zh;
  return (i >= 0 ? labels?.[i] : undefined) || value;
}

/** Enum choices of a field of a security layer, transport or protocol. */
export function enumValues(owner: "security" | "transport" | "protocol", id: string, field: string): string[] {
  const fields =
    owner === "protocol"
      ? (protocolSpec(id)?.options ?? [])
      : (byId(owner === "security" ? MANIFEST.securities : MANIFEST.transports, id)?.fields ?? []);
  return fields.find((f) => f.name === field)?.values ?? [];
}

export function fieldDefault(owner: "security" | "transport" | "protocol", id: string, field: string): string {
  const fields =
    owner === "protocol"
      ? (protocolSpec(id)?.options ?? [])
      : (byId(owner === "security" ? MANIFEST.securities : MANIFEST.transports, id)?.fields ?? []);
  return fields.find((f) => f.name === field)?.default ?? "";
}

/** Which L4 an inbound of `protocol` listens on (manifest `l4`; an
 * option-backed list at its default). */
export function protocolL4(protocol: string): ("tcp" | "udp")[] {
  const p = protocolSpec(protocol);
  if (!p) return ["tcp"];
  if (p.l4 === "tcp" || p.l4 === "udp") return [p.l4];
  const opt = p.options.find((o) => o.name === p.l4.replace(/^option:/, ""));
  return (opt?.default ?? "tcp").split(",").filter((x): x is "tcp" | "udp" => x === "tcp" || x === "udp");
}
