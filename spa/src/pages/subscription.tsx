// W20 (B1): the subscription link, shown permanently (the panel stores the
// token encrypted; GET /me returns it). Copy with feedback, QR code, format
// selector, one-click import into common clients; "reset" is a secondary,
// confirmed action (it cuts off every device using the old link).
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useBranding } from "../components/branding";
import { useConfirm } from "../components/confirm-dialog";
import { QrCode } from "../components/qr-code";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { useT, type MessageKey } from "../i18n";
import { mySubUrl, post, type Me, type Platform } from "../lib/api";
import { errorText } from "../lib/errors";
import { importLinks, SUB_FORMATS, withFormat, type SubFormat } from "../lib/sub-links";
import { useSiteName } from "../lib/title";
import { copyText } from "../lib/utils";

const FORMAT_KEY = {
  auto: "sub.formatAuto",
  clash: "sub.formatClash",
  "sing-box": "sub.formatSingBox",
  links: "sub.formatLinks",
} as const satisfies Record<SubFormat, MessageKey>;

export function SubscriptionCard({ me }: { me: Me }) {
  const t = useT();
  const site = useSiteName();
  const queryClient = useQueryClient();
  const [confirm, confirmDialog] = useConfirm();
  const [format, setFormat] = useState<SubFormat>("auto");
  const [qr, setQr] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const base = mySubUrl(me);
  const url = base ? withFormat(base, format) : null;

  async function copy() {
    if (!url) return;
    const ok = await copyText(url);
    setNote({ ok, text: ok ? t("sub.copied") : t("sub.copyFailed") });
  }

  async function reset() {
    const ok = await confirm({
      title: t("sub.resetTitle"),
      body: t("sub.resetBody"),
      confirmLabel: t("sub.reset"),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setNote(null);
    try {
      await post("/me/sub-token", {});
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      setNote({ ok: true, text: t("sub.resetDone") });
    } catch (err) {
      setNote({ ok: false, text: errorText(err, t) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("sub.title")}</h2>
        </CardTitle>
        <CardDescription>{t("sub.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {me.sub_legacy && !url && (
          <div className="space-y-3">
            <p className="text-sm">{t("sub.legacy")}</p>
            <Button onClick={() => void reset()} disabled={busy}>
              {t("sub.legacyReset")}
            </Button>
          </div>
        )}
        {url && base && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="sub-url">{t("sub.linkLabel")}</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="sub-url"
                  readOnly
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-muted px-3 font-mono text-xs"
                />
                <Button onClick={() => void copy()} className="h-10">
                  {t("sub.copy")}
                </Button>
                <Button variant="outline" className="h-10" aria-expanded={qr} onClick={() => setQr((v) => !v)}>
                  {qr ? t("sub.hideQr") : t("sub.showQr")}
                </Button>
              </div>
              <p
                role="status"
                className={`min-h-5 text-sm ${note?.ok === false ? "text-destructive" : "text-emerald-700"}`}
              >
                {note?.text ?? ""}
              </p>
            </div>
            {qr && (
              <div className="flex flex-col items-center gap-2">
                <QrCode text={url} label={t("sub.qrLabel")} size={208} />
                <p className="text-xs text-muted-foreground">{t("sub.qrHint")}</p>
              </div>
            )}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("sub.format")}</legend>
              <div className="flex flex-wrap gap-2">
                {SUB_FORMATS.filter((f) => f === "auto" || !me.sub_formats || me.sub_formats.includes(f)).map((f) => (
                  <label
                    key={f}
                    className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${
                      format === f ? "border-primary bg-primary/5 font-medium" : "border-border"
                    }`}
                  >
                    <input
                      type="radio"
                      name="sub-format"
                      value={f}
                      checked={format === f}
                      onChange={() => setFormat(f)}
                    />
                    {t(FORMAT_KEY[f])}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t("sub.formatHint")}</p>
            </fieldset>
            <section aria-labelledby="sub-import" className="space-y-2">
              <h3 id="sub-import" className="text-sm font-medium">
                {t("sub.importTitle")}
              </h3>
              <div className="flex flex-wrap gap-2">
                {importLinks(base, site)
                  .filter((l) => !me.sub_import_clients || me.sub_import_clients.includes(l.id))
                  .map((l) => (
                    <a
                      key={l.id}
                      href={l.href}
                      className="inline-flex min-h-10 items-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {l.name}
                    </a>
                  ))}
              </div>
              <p className="text-xs text-muted-foreground">{t("sub.importHint")}</p>
            </section>
            <ClientDownloads />
            <div className="border-t border-border pt-4">
              <Button variant="ghost" className="text-destructive" onClick={() => void reset()} disabled={busy}>
                {t("sub.reset")}
              </Button>
            </div>
          </>
        )}
        {!url && note && (
          <p
            role={note.ok ? "status" : "alert"}
            className={note.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}
          >
            {note.text}
          </p>
        )}
      </CardContent>
      {confirmDialog}
    </Card>
  );
}

const PLATFORM_KEY = {
  windows: "brand.platformWindows",
  macos: "brand.platformMacos",
  linux: "brand.platformLinux",
  android: "brand.platformAndroid",
  ios: "brand.platformIos",
  harmony: "brand.platformHarmony",
  other: "brand.platformOther",
} as const satisfies Record<Platform, MessageKey>;

/** Ops: client download links per platform (系统设置 → 站点). */
export function ClientDownloads() {
  const t = useT();
  const downloads = useBranding()?.client_downloads ?? [];
  if (downloads.length === 0) return null;
  return (
    <section aria-labelledby="sub-downloads" className="space-y-2">
      <h3 id="sub-downloads" className="text-sm font-medium">
        {t("brand.downloads")}
      </h3>
      <p className="text-xs text-muted-foreground">{t("brand.downloadsHint")}</p>
      <ul className="flex flex-wrap gap-2">
        {downloads.map((d, i) => (
          <li key={`${i}-${d.url}`}>
            <a
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>{t(PLATFORM_KEY[d.platform])}</span>
              {d.label && <span className="text-muted-foreground">· {d.label}</span>}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
