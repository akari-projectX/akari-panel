import { SiteFooter, SiteMark, useFavicon } from "../components/branding";
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

// D1: everyone (admins too) logs in with the email address. Every
// credential failure is the server's uniform 401.
export function Login({ options }: { options?: AuthOptions } = {}) {
  const queryClient = useQueryClient();
  const t = useT();
  useDocumentTitle(t("login.title"));
  useFavicon();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError(t("login.required"));
      return;
    }
    setBusy(true);
    try {
      await apiLogin({ email: email.trim(), password });
      // Stay on the requested URL (deep links survive the login).
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError(t("login.invalid"));
      } else {
        setError(errorText(err, t));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4">
      <div className="flex w-full max-w-sm items-center justify-between gap-2">
        <SiteMark />
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
              <Label htmlFor="email">{t("login.email")}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
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
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button className="h-10 w-full" type="submit" disabled={busy}>
              {busy ? t("login.submitting") : t("login.submit")}
            </Button>
            {(options?.register || options?.reset) && (
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
      <SiteFooter className="w-full max-w-sm border-t-0" />
    </main>
  );
}
