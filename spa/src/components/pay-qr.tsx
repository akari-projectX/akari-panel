// The Alipay payment QR: the shared local encoder (lib/qr.ts via QrCode),
// inline SVG, no CDN, CSP-safe.
import { QrCode } from "./qr-code";

export function PayQr({ value, label, size = 208 }: { value: string; label: string; size?: number }) {
  return <QrCode text={value} label={label} size={size} />;
}
