// The Alipay payment QR, rendered locally (no CDN, CSP-safe inline SVG).
// The only file that knows the QR encoder: swap `uqr` for the shared
// encoder here if one lands.
import { useMemo } from "react";
import { encode } from "uqr";

export function PayQr({ value, label, size = 208 }: { value: string; label: string; size?: number }) {
  const path = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d, n: qr.size };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${path.n} ${path.n}`}
      shapeRendering="crispEdges"
      className="rounded-md bg-white"
    >
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}
