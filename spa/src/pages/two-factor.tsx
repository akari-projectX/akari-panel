import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { QrCode } from "../components/qr-code";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useT } from "../i18n";
import { get, post, type TotpEnrollment, type TotpStatus } from "../lib/api";
import { errorText } from "../lib/errors";
import { copyText, downloadText } from "../lib/utils";

// Recovery codes are shown exactly once (the server keeps only keyed
// hashes): offer copy and a .txt download before the user moves on.
export function RecoveryCodes({ codes, login, onAck }: { codes: string[]; login: string; onAck: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = `${t("twofa.recoveryFile", { login })}\n${codes.join("\n")}\n`;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("twofa.recoveryIntro")}</p>
      <ul aria-label={t("twofa.title")} className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={async () => setCopied(await copyText(codes.join("\n")))}
        >
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
        <Button type="button" variant="outline" onClick={() => downloadText(`akari-recovery-codes-${login}.txt`, text)}>
          {t("common.download")} .txt
        </Button>
        <Button type="button" onClick={onAck}>
          {t("twofa.saved")}
        </Button>
      </div>
    </div>
  );
}

// Enrollment: generate a secret (QR code + base32, shown once), confirm with
// a current code. On success the server ends the account's other sessions
// and gives this one a full session cookie.
export function TotpEnroll({ login, onDone }: { login: string; onDone: () => void }) {
  const t = useT();
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      setEnrollment(await post<TotpEnrollment>("/me/totp/enroll", {}));
      setCode("");
    } catch (err) {
      setError(t("twofa.startFailed", { message: errorText(err, t) }));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await post<{ recovery_codes: string[] }>("/me/totp/confirm", { code: code.trim() });
      setEnrollment(null);
      setCodes(res.recovery_codes);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (codes) return <RecoveryCodes codes={codes} login={login} onAck={onDone} />;

  return (
    <div className="space-y-4">
      {!enrollment ? (
        <Button onClick={start} disabled={busy}>
          {t("twofa.setup")}
        </Button>
      ) : (
        <form className="space-y-4" onSubmit={confirm}>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">{t("twofa.scan")}</p>
            <QrCode text={enrollment.otpauth_uri} label={t("twofa.qrLabel")} />
            <p className="text-muted-foreground">{t("twofa.manual")}</p>
            <pre className="overflow-auto rounded-lg bg-muted p-3 text-sm tracking-wider">{enrollment.secret}</pre>
            <p>
              <a className="text-muted-foreground underline" href={enrollment.otpauth_uri}>
                {t("twofa.openLink")}
              </a>
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="totp-confirm">{t("twofa.codeFromApp")}</Label>
            <Input
              id="totp-confirm"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {t("twofa.activate")}
            </Button>
            <Button type="button" variant="outline" onClick={start} disabled={busy}>
              {t("twofa.newKey")}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// Shown instead of the console only with auth.require_admin_2fa, to an
// admin without 2FA (enrollment-only session). Admin surface: Chinese.
export function EnrollPage({ status, onLogout }: { status: TotpStatus; onLogout: () => void }) {
  const queryClient = useQueryClient();
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>
            <h1>需要开启两步验证</h1>
          </CardTitle>
          <CardDescription>
            本面板要求管理员账户使用身份验证器 App。完成设置后即可以 <span className="font-medium">{status.login}</span>{" "}
            的身份继续。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <TotpEnroll
            login={status.login}
            onDone={async () => {
              await queryClient.resetQueries({ queryKey: ["totp"] });
              await queryClient.resetQueries({ queryKey: ["me"] });
            }}
          />
          <Button variant="ghost" size="sm" onClick={onLogout}>
            退出登录
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

// Account security card (console account page and portal): enroll, or
// regenerate recovery codes with a current authenticator code.
export function TwoFactorCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["totp"], queryFn: () => get<TotpStatus>("/me/totp") });
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function regenerate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await post<{ recovery_codes: string[] }>("/me/totp/recovery-codes", { code: code.trim() });
      setCodes(res.recovery_codes);
      setCode("");
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  const s = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("twofa.title")}</h2>
        </CardTitle>
        <CardDescription>
          {s?.enabled ? t("twofa.enabledStatus", { count: s.recovery_codes_left }) : t("twofa.disabledStatus")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isPending && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
        {status.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(status.error, t)}
          </p>
        )}
        {s && !s.enabled && (
          <TotpEnroll login={s.login} onDone={() => queryClient.invalidateQueries({ queryKey: ["totp"] })} />
        )}
        {s?.enabled &&
          (codes ? (
            <RecoveryCodes
              codes={codes}
              login={s.login}
              onAck={() => {
                setCodes(null);
                void queryClient.invalidateQueries({ queryKey: ["totp"] });
              }}
            />
          ) : (
            <form className="flex flex-wrap items-end gap-3" onSubmit={regenerate}>
              <div className="space-y-1.5">
                <Label htmlFor="totp-regen">{t("twofa.regenCode")}</Label>
                <Input
                  id="totp-regen"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" variant="outline">
                {t("twofa.regenerate")}
              </Button>
            </form>
          ))}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
