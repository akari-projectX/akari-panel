// W15 password reset (user bundle, zh/en): "forgot password" asks for the
// email (the answer never says whether it has an account); the mailed link
// opens /app/reset#token=… — the token lives in the URL fragment, which
// browsers never send to a server, and is removed from the address bar as
// soon as the page has read it.
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useT } from "../i18n";
import { appBase, appHome, requestReset, resetPassword } from "../lib/api";
import { errorText } from "../lib/errors";
import { AppLink, PublicShell } from "./register";

/** The reset token of `#token=…` (empty if absent). */
export function tokenFromHash(hash: string = location.hash): string {
  return new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? "";
}

export function ForgotPassword() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) return setError(t("register.emailRequired"));
    setBusy(true);
    try {
      await requestReset({ email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{t("reset.forgotTitle")}</h1>
          </CardTitle>
          <CardDescription>{t("reset.forgotSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="forgot-email">{t("reset.email")}</Label>
              <Input
                id="forgot-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            {sent && (
              <p role="status" className="text-sm text-emerald-700">
                {t("reset.sent")}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button className="w-full" type="submit" disabled={busy}>
              {busy ? t("reset.sending") : t("reset.send")}
            </Button>
            <p className="text-center text-sm">
              <AppLink to={appHome}>{t("reset.toLogin")}</AppLink>
            </p>
          </form>
        </CardContent>
      </Card>
    </PublicShell>
  );
}

export function ResetPassword() {
  const t = useT();
  // Read once, then drop the fragment from the address bar and history.
  const [token] = useState(() => tokenFromHash());
  useEffect(() => {
    if (location.hash) history.replaceState(null, "", location.pathname);
  }, []);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError(t("reset.tooShort"));
    if (password !== repeat) return setError(t("reset.mismatch"));
    setBusy(true);
    try {
      await resetPassword({ token, password });
      setDone(true);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{t("reset.title")}</h1>
          </CardTitle>
          <CardDescription>{t("reset.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          {!token ? (
            <div className="space-y-4">
              <p role="alert" className="text-sm text-destructive">
                {t("reset.missingToken")}
              </p>
              <AppLink to={`${appBase}/forgot`}>{t("reset.again")}</AppLink>
            </div>
          ) : done ? (
            <div className="space-y-4">
              <p role="status" className="text-sm text-emerald-700">
                {t("reset.done")}
              </p>
              <AppLink to={appHome}>{t("reset.toLogin")}</AppLink>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={submit} noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="reset-password">{t("reset.password")}</Label>
                <Input
                  id="reset-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reset-repeat">{t("reset.repeatPassword")}</Label>
                <Input
                  id="reset-repeat"
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  required
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button className="w-full" type="submit" disabled={busy}>
                {busy ? t("reset.submitting") : t("reset.submit")}
              </Button>
              <p className="text-center text-sm">
                <AppLink to={`${appBase}/forgot`}>{t("reset.again")}</AppLink>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </PublicShell>
  );
}
