// The app brand (sidebar, phone top bar, sign-in card). An uploaded logo
// always wins. Without one the default is the L3 "akari" logo
// (design/brand-backup-2026-10/akari-l3-logo/, the same as the portal's):
// - BrandMark: the icon, a night-coloured rounded square with the white
//   lowercase "a" and its brand-blue dot (tokens --brand-mark /
//   --brand-mark-foreground / --brand-mark-dot). A renamed site without a
//   logo shows its own first letter on the same square.
// - Wordmark: the lowercase "akari" in the text colour with a brand-blue
//   i-dot (currentColor + --primary, so it follows light and dark); shown in
//   place of the site name while the site is still called "Akari" and has no
//   uploaded logo (isDefaultBrand).
// Inline SVG: no extra request, nothing the CSP has to allow.
import { cn } from "../cn";

const STROKE = { fill: "none", strokeWidth: 15, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Whether the site shows the default Akari brand (no uploaded logo, the default name). */
export function isDefaultBrand(name: string, logoUrl?: string | null): boolean {
  return !logoUrl && (!name || name.trim().toLowerCase() === "akari");
}

export function BrandMark({
  name,
  logoUrl,
  size = 28,
  className,
}: {
  name: string;
  logoUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const radius = Math.round(size * 0.27);
  if (logoUrl)
    return (
      <img
        src={logoUrl}
        alt=""
        className={cn("shrink-0 object-contain", className)}
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  const seal = cn(
    "inline-flex shrink-0 items-center justify-center bg-brand-mark text-brand-mark-foreground shadow-[inset_0_0.5px_0_rgb(255_255_255/0.2),0_1px_2px_rgb(0_0_0/0.2)]",
    className,
  );
  if (isDefaultBrand(name))
    return (
      <span
        aria-hidden="true"
        data-brand="akari"
        className={seal}
        style={{ width: size, height: size, borderRadius: radius }}
      >
        <svg viewBox="0 0 128 128" width={size} height={size} focusable="false">
          <g transform="translate(35,-6)">
            <path d="M52,40 V100" stroke="currentColor" {...STROKE} />
            <circle cx="26" cy="70" r="26" stroke="currentColor" {...STROKE} />
            <circle cx="70" cy="26" r="10" className="fill-brand-mark-dot" />
          </g>
        </svg>
      </span>
    );
  return (
    <span
      aria-hidden="true"
      className={cn(seal, "font-semibold")}
      style={{ width: size, height: size, fontSize: size * 0.5, borderRadius: radius }}
    >
      {name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The default "akari" wordmark, `height` px tall (width follows, 314:122). */
export function Wordmark({ height, className }: { height: number; className?: string }) {
  return (
    <svg
      viewBox="-11 -11 314 122"
      height={height}
      width={Math.round((height * 314) / 122)}
      aria-hidden="true"
      focusable="false"
      data-brand="akari-wordmark"
      className={cn("shrink-0 text-foreground", className)}
    >
      <g stroke="currentColor" {...STROKE}>
        <path d="M52,40 V100" />
        <circle cx="26" cy="70" r="26" />
        <g transform="translate(82,0)">
          <path d="M0,0 V100" />
          <path d="M46,40 L0,74" />
          <path d="M20,59 L48,100" />
        </g>
        <g transform="translate(154,0)">
          <path d="M52,40 V100" />
          <circle cx="26" cy="70" r="26" />
        </g>
        <path transform="translate(234,0)" d="M0,100 V68 A28,28 0 0 1 36,42" />
        <path transform="translate(292,0)" d="M0,46 V100" />
      </g>
      <circle cx="292" cy="18" r="9.5" className="fill-primary" />
    </svg>
  );
}
