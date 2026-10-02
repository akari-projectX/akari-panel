import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { LocaleSwitch, useT } from "../i18n";
import { ApiError, appBase, login as apiLogin, type AuthOptions } from "../lib/api";
import { errorText } from "../lib/errors";
import { useDocumentTitle } from "../lib/title";
import { AppLink } from "./register";

// W20 (M9): two steps. The password goes first; only if the server says
// the (verified) password belongs to an account with 2FA (`totp_required`)
// does the code field appear, and password + code are sent together again.
// Every other credential failure stays the server's uniform 401.
export function Login({ options }: { options?: AuthOptions } = {}) {
  const queryClient = useQueryClient();
  const t = useT();
  useDocumentTitle(t("login.title"));
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!login.trim() || !password) {
      setError(t("login.required"));
      return;
    }
    const trimmed = code.trim();
    if (needCode && !trimmed) {
      setError(t("login.codeRequired"));
      return;
    }
    setBusy(true);
    try {
      await apiLogin(needCode ? { login, password, code: trimmed } : { login, password });
      // Stay on the requested URL (deep links survive the login).
      await queryClient.resetQueries({ queryKey: ["totp"] });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.body.totp_required === true) {
        setNeedCode(true);
      } else if (err instanceof ApiError && err.status === 401) {
        // At the code step the password was just accepted, so a 401 is
        // about the code (wrong, or already used).
        setError(needCode ? t("login.codeInvalid") : t("login.invalid"));
        if (needCode) setCode("");
      } else {
        setError(errorText(err, t));
      }
    } finally {
      setBusy(false);
    }
  }

  function back() {
    setNeedCode(false);
    setCode("");
    setPassword("");
    setError(null);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4">
      <div className="flex w-full max-w-sm justify-end">
        <LocaleSwitch />
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{t("login.title")}</h1>
          </CardTitle>
          <CardDescription>{needCode ? t("login.codeStep") : t("login.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} noValidate>
            {!needCode ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="login">{t("login.login")}</Label>
                  <Input
                    id="login"
                    value={login}
                    autoComplete="username"
                    onChange={(e) => setLogin(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">{t("login.password")}</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    autoComplete="current-password"
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="code">{t("login.code")}</Label>
                <Input
                  id="code"
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder={t("login.codePlaceholder")}
                  aria-describedby="code-hint"
                  // The step appears in response to the user's submit.
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  onChange={(e) => setCode(e.target.value)}
                />
                <p id="code-hint" className="text-xs text-muted-foreground">
                  {t("login.codeHint")}
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button className="h-10 w-full" type="submit" disabled={busy}>
              {busy ? t("login.submitting") : needCode ? t("login.verify") : t("login.submit")}
            </Button>
            {needCode && (
              <Button type="button" variant="ghost" className="w-full" onClick={back}>
                {t("login.back")}
              </Button>
            )}
            {!needCode && (options?.register || options?.reset) && (
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                {options.reset ? <AppLink to={`${appBase}/forgot`}>{t("login.forgotLink")}</AppLink> : <span />}
                {options.register && (
                  <span className="text-muted-foreground">
                    {t("login.noAccount")} <AppLink to={`${appBase}/register`}>{t("login.registerLink")}</AppLink>
                  </span>
                )}
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
