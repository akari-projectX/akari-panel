// W15 portal (user bundle, zh/en): the account's email address (bind/change
// with the current password + an emailed code) and the invite codes shown
// in the wallet's 我的邀请 card (W16).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useConfirm } from "../components/confirm-dialog";
import { QrCode } from "../components/qr-code";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { useT } from "../i18n";
import { appBase, del, get, post, type Me } from "../lib/api";
import { errorText } from "../lib/errors";
import { copyText } from "../lib/utils";

export function EmailCard({ me }: { me: Me }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setOpen(false);
    setEmail("");
    setPassword("");
    setCode("");
    setSentTo(null);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await post("/me/email/code", { email: email.trim(), password });
      setPassword("");
      setSentTo(email.trim());
    } catch (err) {
      setMsg({ ok: false, text: errorText(err, t) });
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const r = await post<{ email: string }>("/me/email/verify", { code: code.trim() });
      reset();
      setMsg({ ok: true, text: t("account.verified", { email: r.email }) });
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err, t) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("account.emailTitle")}</h2>
        </CardTitle>
        <CardDescription>
          {me.email
            ? me.email_verified
              ? t("account.emailVerified", { email: me.email })
              : t("account.emailUnverified", { email: me.email })
            : t("account.emailNone")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!open ? (
          <Button variant="outline" onClick={() => setOpen(true)}>
            {me.email ? t("account.change") : t("account.bind")}
          </Button>
        ) : sentTo === null ? (
          <form className="flex flex-wrap items-end gap-3" onSubmit={send} aria-label={t("account.sendCode")}>
            <div className="space-y-1.5">
              <Label htmlFor="email-new">{t("account.newEmail")}</Label>
              <Input
                id="email-new"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email-pw">{t("account.password")}</Label>
              <Input
                id="email-pw"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={busy || !email.trim() || !password}>
              {busy ? t("account.sending") : t("account.sendCode")}
            </Button>
            <Button type="button" variant="ghost" onClick={reset}>
              {t("account.cancel")}
            </Button>
          </form>
        ) : (
          <form className="space-y-3" onSubmit={verify} aria-label={t("account.verify")}>
            <p role="status" className="text-sm text-muted-foreground">
              {t("account.codeSent", { email: sentTo })}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="email-code">{t("account.code")}</Label>
                <Input
                  id="email-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={busy || code.trim().length !== 6}>
                {t("account.verify")}
              </Button>
              <Button type="button" variant="ghost" onClick={reset}>
                {t("account.cancel")}
              </Button>
            </div>
          </form>
        )}
        {msg && (
          <p
            role={msg.ok ? "status" : "alert"}
            className={`text-sm ${msg.ok ? "text-emerald-700" : "text-destructive"}`}
          >
            {msg.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface InviteCodesView {
  codes: { code: string; uses: number; created_at: string }[];
  limit: number;
  register_enabled: boolean;
  invite_required: boolean;
  single_use: boolean;
  invited: number;
  link_base: string | null;
}

/** The shareable registration link of an invite code. */
export function inviteLink(code: string, linkBase: string | null): string {
  return `${linkBase ?? `${location.origin}${appBase}/register?invite=`}${encodeURIComponent(code)}`;
}

/**
 * The account's invite codes (embedded in the wallet's 我的邀请 card, W16):
 * list with uses, copy link, delete, create (per-user limit). While
 * registration is closed only a note is shown.
 */
export function InviteCodes() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["invite-codes"], queryFn: () => get<InviteCodesView>("/me/invite-codes") });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  if (!q.data) return null;
  const data = q.data;
  if (!data.register_enabled) return <p className="text-muted-foreground">{t("account.inviteClosed")}</p>;

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["invite-codes"] });
    await qc.invalidateQueries({ queryKey: ["my-invite"] });
  }

  async function create() {
    setError(null);
    setBusy(true);
    try {
      await post("/me/invite-codes", {});
      await refresh();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function remove(code: string) {
    const ok = await confirm({
      title: t("account.deleteTitle"),
      body: t("account.deleteConfirm", { code }),
      confirmLabel: t("account.delete"),
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await del(`/me/invite-codes/${encodeURIComponent(code)}`);
      await refresh();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  async function copy(code: string) {
    await copyText(inviteLink(code, data.link_base));
    setCopied(code);
  }

  // W20 (Minor 6): the first code (created automatically by the server)
  // as a ready-to-share link with copy and QR.
  const primary = data.codes[0];
  const primaryLink = primary ? inviteLink(primary.code, data.link_base) : null;

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">
        {t("account.inviteDesc")} {data.single_use ? t("account.inviteSingle") : ""}
      </p>
      {primary && primaryLink && (
        <div className="space-y-2">
          <Label htmlFor="invite-link">{t("account.linkTitle")}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="invite-link"
              readOnly
              value={primaryLink}
              onFocus={(e) => e.currentTarget.select()}
              className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-muted px-3 font-mono text-xs"
            />
            <Button className="h-10" onClick={() => void copy(primary.code)}>
              {copied === primary.code ? t("common.copied") : t("account.copyLink")}
            </Button>
            <Button variant="outline" className="h-10" aria-expanded={qr} onClick={() => setQr((v) => !v)}>
              {qr ? t("account.hideQr") : t("account.showQr")}
            </Button>
          </div>
          {qr && (
            <div className="flex justify-center">
              <QrCode text={primaryLink} label={t("account.qrLabel")} size={192} />
            </div>
          )}
        </div>
      )}
      {data.codes.length === 0 ? (
        <p className="text-muted-foreground">{t("account.inviteEmpty")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("account.colCode")}</TableHead>
              <TableHead>{t("account.colUses")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("billing.colActions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.codes.map((c) => (
              <TableRow key={c.code}>
                <TableCell className="font-mono">{c.code}</TableCell>
                <TableCell>{c.uses}</TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button size="sm" variant="outline" onClick={() => void copy(c.code)}>
                    {copied === c.code ? t("common.copied") : t("account.copyLink")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(c.code)}>
                    {t("account.delete")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => void create()} disabled={busy || data.codes.length >= data.limit}>
          {t("account.inviteCreate")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("account.inviteLimit", { limit: data.limit })}</span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {confirmDialog}
    </div>
  );
}
