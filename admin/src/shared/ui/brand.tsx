// The app mark (sidebar, phone top bar, sign-in card): the uploaded logo,
// else the Akari seal — a night-coloured rounded square with a golden 灯
// (tokens --brand-mark / --brand-mark-foreground). A renamed site without a
// logo shows its own first letter on the same seal.
import { cn } from "../cn";

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
  const glyph = !name || name.trim().toLowerCase() === "akari" ? "灯" : name.trim().slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-brand-mark font-semibold text-brand-mark-foreground shadow-[inset_0_0.5px_0_rgb(255_255_255/0.2),0_1px_2px_rgb(0_0_0/0.2)]",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.5, borderRadius: radius }}
    >
      {glyph}
    </span>
  );
}
