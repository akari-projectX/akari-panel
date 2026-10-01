import jsQR from "jsqr";
import { describe, expect, it } from "vitest";

import { encodeQr, type QrMatrix } from "./qr";

// Render to RGBA (4 px per module, 4-module quiet zone) and decode with an
// independent decoder (jsQR, test-only dependency).
function decode(qr: QrMatrix): string | null {
  const scale = 4;
  const border = 4;
  const dim = (qr.size + border * 2) * scale;
  const px = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = (((y + border) * scale + dy) * dim + (x + border) * scale + dx) * 4;
          px[o] = px[o + 1] = px[o + 2] = 0;
        }
      }
    }
  }
  return jsQR(px, dim, dim)?.data ?? null;
}

describe("QR encoder", () => {
  it("round-trips otpauth URIs through an independent decoder", () => {
    const uri =
      "otpauth://totp/Akari:root?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Akari&algorithm=SHA1&digits=6&period=30";
    const qr = encodeQr(uri);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(decode(qr)).toBe(uri);
  });

  it("covers small, multi-block and version-info sizes and every mask", () => {
    const masks = new Set<number>();
    for (const len of [1, 14, 40, 100, 180, 300, 600, 1200]) {
      const text = Array.from({ length: len }, (_, i) => "akari-0123456789"[i % 16]).join("");
      const qr = encodeQr(text);
      masks.add(qr.mask);
      expect(decode(qr), `len ${len} v${qr.version}`).toBe(text);
    }
    expect(encodeQr("x".repeat(1200)).version).toBeGreaterThanOrEqual(7);
    expect(masks.size).toBeGreaterThan(0);
  });

  it("encodes UTF-8", () => {
    const text = "otpauth://totp/Akari:用户?secret=ABC";
    expect(decode(encodeQr(text))).toBe(text);
  });

  it("refuses text beyond version 40", () => {
    expect(() => encodeQr("x".repeat(3000))).toThrow();
  });
});
