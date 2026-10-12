// W26: the admin form reads the protocol layer from the generated manifest
// schema (protocols.gen.ts); these pin what the form offers to what
// the manifest says (and what the panel's templates accept).
import { describe, expect, it } from "vitest";

import { MANIFEST } from "./protocols.gen";
import {
  FIELD_EN,
  enumValues,
  fieldHelp,
  fieldLabel,
  fieldDefault,
  networkOptionLabel,
  protocolL4,
  protocolOptionLabel,
  templateRequiresTls,
  transportFields,
  transportTemplateNetworks,
  transportTemplateProtocols,
  unsupportedFormats,
} from "./protocol-form";

describe("generated protocol form", () => {
  it("offers the stackable protocols and their transports", () => {
    expect(transportTemplateProtocols().map((p) => p.id)).toEqual(["vless", "vmess", "trojan"]);
    for (const p of ["vless", "vmess", "trojan"]) {
      expect(transportTemplateNetworks(p)).toEqual(["ws", "httpupgrade", "xhttp", "grpc"]);
    }
    expect(transportTemplateNetworks("ss2022")).toEqual([]);
  });

  it("requires TLS where the templates do (Trojan, gRPC)", () => {
    expect(templateRequiresTls("trojan", "ws")).toBe(true);
    expect(templateRequiresTls("vless", "grpc")).toBe(true);
    expect(templateRequiresTls("vmess", "grpc")).toBe(true);
    expect(templateRequiresTls("vless", "ws")).toBe(false);
    expect(templateRequiresTls("vmess", "xhttp")).toBe(false);
    expect(protocolOptionLabel(MANIFEST.protocols.find((p) => p.id === "trojan")!)).toBe("Trojan（需 TLS）");
  });

  it("labels transports with what each format leaves out", () => {
    expect(unsupportedFormats("vless", "xhttp")).toEqual(["sing-box"]);
    expect(unsupportedFormats("vmess", "xhttp")).toEqual(["Clash (mihomo)", "sing-box"]);
    expect(unsupportedFormats("vless", "ws")).toEqual([]);
    expect(networkOptionLabel("vless", "xhttp")).toBe("XHTTP（sing-box 不支持）");
    expect(networkOptionLabel("vmess", "xhttp")).toBe("XHTTP（Clash (mihomo) 不支持；sing-box 不支持）");
    expect(networkOptionLabel("vless", "grpc")).toBe("gRPC（需 TLS）");
    // Trojan always needs TLS: not repeated per transport.
    expect(networkOptionLabel("trojan", "grpc")).toBe("gRPC");
  });

  it("takes fields and choices from the manifest", () => {
    expect(transportFields("ws").map((f) => f.name)).toEqual(["path", "host"]);
    expect(transportFields("xhttp").map((f) => f.name)).toEqual(["path", "host", "mode"]);
    expect(transportFields("grpc").map((f) => f.name)).toEqual(["service_name"]);
    expect(enumValues("transport", "xhttp", "mode")).toEqual(["auto", "packet-up", "stream-up", "stream-one"]);
    expect(fieldDefault("transport", "xhttp", "mode")).toBe("auto");
    expect(enumValues("protocol", "ss2022", "method")).toEqual(["2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm"]);
    expect(enumValues("security", "reality", "fingerprint")[0]).toBe("chrome");
    expect(fieldDefault("security", "reality", "fingerprint")).toBe("chrome");
  });

  it("has an English twin for every console label of the manifest (SH-13)", () => {
    const cjk = /[\u3400-\u9fff\uff01-\uff5e\u3000-\u303f]/;
    const owners = [
      ...MANIFEST.securities.map((s) => ["security", s.id, s.fields] as const),
      ...MANIFEST.transports.map((t) => ["transport", t.id, t.fields] as const),
      ...MANIFEST.protocols.map((p) => ["protocol", p.id, p.options] as const),
    ];
    const keys: string[] = [];
    for (const [owner, id, fields] of owners) {
      for (const f of fields) {
        const key = `${owner}.${id}.${f.name}`;
        keys.push(key);
        const en = FIELD_EN[key];
        expect(en?.label, key).toBeTruthy();
        expect(cjk.test(en.label), key).toBe(false);
        if (f.help_zh !== null) expect(en.help && !cjk.test(en.help), `${key} help`).toBe(true);
        if (f.value_labels_zh.length) expect(en.values?.length, `${key} values`).toBe(f.value_labels_zh.length);
        expect(fieldLabel(owner, id, f, "en")).toBe(en.label);
        expect(fieldHelp(owner, id, f, "zh")).toBe(f.help_zh ?? "");
      }
    }
    for (const l of [...MANIFEST.securities, ...MANIFEST.transports, ...MANIFEST.protocols])
      expect(cjk.test(l.label), l.id).toBe(false);
    expect(Object.keys(FIELD_EN).sort()).toEqual(keys.sort());
    expect(networkOptionLabel("vmess", "xhttp", "en")).toBe("XHTTP (no Clash (mihomo); no sing-box)");
  });

  it("derives L4 from the manifest", () => {
    expect(protocolL4("hysteria2")).toEqual(["udp"]);
    expect(protocolL4("ss2022")).toEqual(["tcp", "udp"]);
    expect(protocolL4("vless")).toEqual(["tcp"]);
  });
});
