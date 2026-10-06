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

export function protocolSpec(id: string): ManifestProtocol | undefined {
  return byId(MANIFEST.protocols, id);
}

/** Transports with their own settings: the ones the free template stacks. */
export function stackableTransports(): string[] {
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
  const en = lang === "en";
  const notes: string[] = unsupportedFormats(protocol, transport).map((f) => (en ? `no ${f}` : `${f} 不支持`));
  if (templateRequiresTls(protocol, transport) && !protocolSpec(protocol)?.template_requires_tls)
    notes.push(en ? "needs TLS" : "需 TLS");
  const label = transportLabel(transport, lang);
  return notes.length ? (en ? `${label} (${notes.join("; ")})` : `${label}（${notes.join("；")}）`) : label;
}

export function protocolOptionLabel(p: ManifestProtocol, lang: Lang = "zh"): string {
  const label = lang === "en" ? p.label : p.label_zh;
  return p.template_requires_tls ? (lang === "en" ? `${label} (needs TLS)` : `${label}（需 TLS）`) : label;
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
