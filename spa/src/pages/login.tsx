import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { LocaleSwitch, useT } from "../i18n";
import { ApiError, login as apiLogin } from "../lib/api";
import { errorText } from "../lib/errors";

export function Login() {
  const queryClient = useQueryClient();
  const t = useT();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!login.trim() || !password) {
      setError(t("login.required"));
      return;
    }
    setBusy(true);
    try {
      const trimmed = code.trim();
      await apiLogin(trimmed ? { login, password, code: trimmed } : { login, password });
      // Stay on the requested URL (deep links survive the login).
      await queryClient.resetQueries({ queryKey: ["totp"] });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      // Every credential failure is the server's uniform 401: one message,
      // no hint which part was wrong.
      setError(err instanceof ApiError && err.status === 401 ? t("login.invalid") : errorText(err, t));
    } finally {
      setBusy(false);
    }
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
          <CardDescription>{t("login.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} noValidate>
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
            <div className="space-y-1.5">
              <Label htmlFor="code">{t("login.code")}</Label>
              <Input
                id="code"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t("login.codePlaceholder")}
                aria-describedby="code-hint"
                onChange={(e) => setCode(e.target.value)}
              />
              <p id="code-hint" className="text-xs text-muted-foreground">
                {t("login.codeHint")}
              </p>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button className="w-full" type="submit" disabled={busy}>
              {busy ? t("login.submitting") : t("login.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
