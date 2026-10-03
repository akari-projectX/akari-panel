// W26: the admin node form, generated from the protocol manifest
// (proto/protocols.toml → admin-protocols.gen.ts, `make gen-protocols`).
// Which protocols the free "transport" template offers, which transports
// each protocol has, which of them need TLS, the fields a transport takes
// (labels, help, choices) and what each subscription format leaves out all
// come from the manifest; the common templates (REALITY, Vision, …) are
// per-template UI overrides in admin-nodes.tsx that read their choices
// (fingerprints, XHTTP modes, SS methods) from here too.
import { MANIFEST, type ManifestField, type ManifestProtocol } from "./admin-protocols.gen";

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

export function transportLabel(transport: string): string {
  return byId(MANIFEST.transports, transport)?.label_zh ?? transport;
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
export function networkOptionLabel(protocol: string, transport: string): string {
  const notes: string[] = unsupportedFormats(protocol, transport).map((f) => `${f} 不支持`);
  if (templateRequiresTls(protocol, transport) && !protocolSpec(protocol)?.template_requires_tls) notes.push("需 TLS");
  return notes.length ? `${transportLabel(transport)}（${notes.join("；")}）` : transportLabel(transport);
}

export function protocolOptionLabel(p: ManifestProtocol): string {
  return p.template_requires_tls ? `${p.label_zh}（需 TLS）` : p.label_zh;
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
