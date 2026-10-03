// W26: the admin form reads the protocol layer from the generated manifest
// schema (admin-protocols.gen.ts); these pin what the form offers to what
// the manifest says (and what the panel's templates accept).
import { describe, expect, it } from "vitest";

import { MANIFEST } from "./admin-protocols.gen";
import {
  enumValues,
  fieldDefault,
  networkOptionLabel,
  protocolL4,
  protocolOptionLabel,
  templateRequiresTls,
  transportFields,
  transportTemplateNetworks,
  transportTemplateProtocols,
  unsupportedFormats,
} from "./admin-protocol-form";

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

  it("derives L4 from the manifest", () => {
    expect(protocolL4("hysteria2")).toEqual(["udp"]);
    expect(protocolL4("ss2022")).toEqual(["tcp", "udp"]);
    expect(protocolL4("vless")).toEqual(["tcp"]);
  });
});
