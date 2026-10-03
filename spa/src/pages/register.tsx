// W15 self-service registration (user bundle, zh/en): email → code by mail
// → password → signed in. The server answers the code request the same way
// for every address (no account-existence oracle), so the page always says
// "if this address can sign up, a code was sent".
import { SiteFooter, SiteMark, useFavicon } from "../components/branding";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { LocaleSwitch, useLocale, useT } from "../i18n";
import { appBase, register, registerChallenge, registerCode, type AuthOptions } from "../lib/api";
import { solvePow } from "../lib/pow";
import { errorText } from "../lib/errors";
import { navigate } from "../lib/router";

/** Seconds before the code can be requested again. */
export const RESEND_SECS = 60;

/** The invite code of a shared link (`?invite=`), if any. */
export function inviteFromLocation(search: string = location.search): string {
  return new URLSearchParams(search).get("invite")?.trim() ?? "";
}

export function PublicShell({ children }: { children: React.ReactNode }) {
  useFavicon();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 py-8">
      <div className="flex w-full max-w-sm items-center justify-between gap-2">
        <SiteMark />
        <LocaleSwitch />
      </div>
      {children}
      <SiteFooter className="w-full max-w-sm border-t-0" />
    </main>
  );
}

/** A same-bundle link (history navigation, no reload). */
export function AppLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <a
      href={to}
      className="inline-block py-1.5 font-medium text-primary underline underline-offset-4 hover:decoration-2"
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Register({ options }: { options: AuthOptions }) {
  const t = useT();
  // W24: without email verification there is no code step; the browser
  // solves a small proof of work instead (invisible to the visitor).
  const verify = options.email_verify !== false;
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState(() => inviteFromLocation());
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"code" | "submit" | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const inviteBody = () => (invite.trim() ? { invite_code: invite.trim() } : {});

  async function sendCode() {
    setError(null);
    if (!email.trim()) return setError(t("register.emailRequired"));
    if (options.invite_required && !invite.trim()) return setError(t("errors.inviteRequired"));
    setBusy("code");
    try {
      await registerCode({ email: email.trim(), locale, ...inviteBody() });
      setSent(true);
      setCooldown(RESEND_SECS);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) return setError(t("register.emailRequired"));
    if (verify && !/^\d{6}$/.test(code.trim())) return setError(t("register.codeRequired"));
    if (password.length < 8) return setError(t("register.tooShort"));
    if (password !== repeat) return setError(t("register.mismatch"));
    if (!verify && options.invite_required && !invite.trim()) return setError(t("errors.inviteRequired"));
    setBusy("submit");
    try {
      if (verify) {
        await register({ email: email.trim(), code: code.trim(), password, locale, ...inviteBody() });
      } else {
        const ch = await registerChallenge();
        const nonce = await solvePow(ch.challenge, ch.bits);
        await register({
          email: email.trim(),
          pow: { challenge: ch.challenge, nonce },
          password,
          locale,
          ...inviteBody(),
        });
      }
      navigate(appBase);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(null);
    }
  }

  return (
    <PublicShell>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{t("register.title")}</h1>
          </CardTitle>
          <CardDescription>{verify ? t("register.subtitle") : t("register.subtitleNoVerify")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="reg-email">{t("register.email")}</Label>
              <Input
                id="reg-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-describedby={options.email_domains.length ? "reg-domains" : undefined}
                required
              />
              {options.email_domains.length > 0 && (
                <p id="reg-domains" className="text-xs text-muted-foreground">
                  {t("register.domains", { domains: options.email_domains.join(", ") })}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-invite">
                {options.invite_required ? t("register.invite") : t("register.inviteOptional")}
              </Label>
              <Input
                id="reg-invite"
                value={invite}
                autoComplete="off"
                onChange={(e) => setInvite(e.target.value)}
                required={options.invite_required}
              />
            </div>
            {verify && (
              <div className="space-y-1.5">
                <Label htmlFor="reg-code">{t("register.code")}</Label>
                <div className="flex gap-2">
                  <Input
                    id="reg-code"
                    value={code}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder={t("register.codePlaceholder")}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={busy !== null || cooldown > 0}
                    onClick={() => void sendCode()}
                  >
                    {busy === "code"
                      ? t("register.sending")
                      : cooldown > 0
                        ? t("register.resendIn", { sec: cooldown })
                        : t("register.sendCode")}
                  </Button>
                </div>
                {sent && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {t("register.codeSent")}
                  </p>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="reg-password">{t("register.password")}</Label>
              <Input
                id="reg-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-repeat">{t("register.repeatPassword")}</Label>
              <Input
                id="reg-repeat"
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
            <Button className="w-full" type="submit" disabled={busy !== null}>
              {busy === "submit" ? t("register.submitting") : t("register.submit")}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              {t("register.haveAccount")} <AppLink to={appBase}>{t("register.toLogin")}</AppLink>
            </p>
          </form>
        </CardContent>
      </Card>
    </PublicShell>
  );
}
