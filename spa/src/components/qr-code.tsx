import { useMemo } from "react";

import { encodeQr, qrPath } from "../lib/qr";

const BORDER = 4; // quiet zone, modules

/**
 * A QR code drawn as inline SVG from a local encoder: the encoded text (the
 * TOTP secret) never leaves the page and nothing is fetched, so it works
 * under the panel's CSP. Always dark-on-white (scanners need the contrast).
 */
export function QrCode({ text, label, size = 192 }: { text: string; label: string; size?: number }) {
  const qr = useMemo(() => encodeQr(text), [text]);
  const dim = qr.size + BORDER * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      className="rounded-md border border-border"
      data-qr-version={qr.version}
    >
      <rect width={dim} height={dim} fill="#fff" />
      <path d={qrPath(qr, BORDER)} fill="#000" />
    </svg>
  );
}
