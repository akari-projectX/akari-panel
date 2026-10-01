import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { get, post, type TotpEnrollment, type TotpStatus } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// Recovery codes are shown exactly once (the server keeps only keyed hashes).
function RecoveryCodes({ codes, onAck }: { codes: string[]; onAck: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Recovery codes — each works once if you lose your authenticator. They are shown only now:
        store them somewhere safe.
      </p>
      <pre className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-3 text-sm">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </pre>
      <Button onClick={onAck}>I have saved them</Button>
    </div>
  );
}

// Enrollment: generate a secret (shown once), confirm with a current code.
// On success the server ends the account's other sessions and gives this
// one a full session cookie.
export function TotpEnroll({
  onDone,
  needsEnrollCode = false,
}: {
  onDone: () => void;
  needsEnrollCode?: boolean;
}) {
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [enrollCode, setEnrollCode] = useState("");
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
      setError(errorText(err, "Could not start enrollment"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, string> = { code: code.trim() };
      if (needsEnrollCode) body.enrollment_code = enrollCode.trim();
      const res = await post<{ recovery_codes: string[] }>("/me/totp/confirm", body);
      setEnrollment(null);
      setCodes(res.recovery_codes);
    } catch (err) {
      setError(errorText(err, "Confirmation failed"));
    } finally {
      setBusy(false);
    }
  }

  if (codes) return <RecoveryCodes codes={codes} onAck={onDone} />;

  return (
    <div className="space-y-4">
      {!enrollment ? (
        <Button onClick={start} disabled={busy}>
          Set up authenticator
        </Button>
      ) : (
        <form className="space-y-4" onSubmit={confirm}>
          <div className="space-y-1.5 text-sm">
            <p className="text-muted-foreground">
              Add this key to your authenticator app (TOTP, SHA-1, 6 digits, 30 s). It is shown only
              during setup.
            </p>
            <pre className="overflow-auto rounded-lg bg-muted p-3 text-sm tracking-wider">{enrollment.secret}</pre>
            <p className="text-muted-foreground">
              Or open it on the device with the authenticator:{" "}
              <a className="underline" href={enrollment.otpauth_uri}>
                otpauth link
              </a>
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="totp-confirm">Code from the app</Label>
            <Input
              id="totp-confirm"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </div>
          {needsEnrollCode && (
            <div className="space-y-1.5">
              <Label htmlFor="totp-enroll-code">Enrollment code</Label>
              <Input
                id="totp-enroll-code"
                autoComplete="off"
                placeholder="XXXX-XXXX-…"
                value={enrollCode}
                onChange={(e) => setEnrollCode(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                The one-time code from <code>akari admin add</code> / <code>admin reset-2fa</code> (or
                from the administrator who reset your 2FA).
              </p>
            </div>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Activate
            </Button>
            <Button type="button" variant="outline" onClick={start} disabled={busy}>
              New key
            </Button>
          </div>
        </form>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

// Shown instead of the console to an admin without 2FA (enrollment-only
// session): nothing else is reachable until it is set up.
export function EnrollPage({ status, onLogout }: { status: TotpStatus; onLogout: () => void }) {
  const queryClient = useQueryClient();
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Two-factor authentication required</CardTitle>
          <CardDescription>
            Administrator accounts must use an authenticator app. Set it up to continue as{" "}
            <span className="font-medium">{status.login}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <TotpEnroll
            needsEnrollCode={status.enroll_code_required}
            onDone={async () => {
              await queryClient.resetQueries({ queryKey: ["totp"] });
              await queryClient.resetQueries({ queryKey: ["me"] });
            }}
          />
          <Button variant="ghost" size="sm" onClick={onLogout}>
            Log out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// Account security card (console and portal): enroll, or regenerate
// recovery codes with a current authenticator code.
export function TwoFactorCard() {
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
      setError(errorText(err, "Regeneration failed"));
    }
  }

  const s = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>
          {s?.enabled
            ? `Enabled · ${s.recovery_codes_left} recovery codes left`
            : "Protect your account with an authenticator app."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {s && !s.enabled && (
          <TotpEnroll
            needsEnrollCode={s.enroll_code_required}
            onDone={() => queryClient.invalidateQueries({ queryKey: ["totp"] })}
          />
        )}
        {s?.enabled &&
          (codes ? (
            <RecoveryCodes
              codes={codes}
              onAck={() => {
                setCodes(null);
                void queryClient.invalidateQueries({ queryKey: ["totp"] });
              }}
            />
          ) : (
            <form className="flex flex-wrap items-end gap-3" onSubmit={regenerate}>
              <div className="space-y-1.5">
                <Label htmlFor="totp-regen">Authenticator code</Label>
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
                New recovery codes
              </Button>
            </form>
          ))}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
