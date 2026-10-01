import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { appBase, login as apiLogin } from "../lib/api";
import { navigate } from "../lib/router";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";

export function Login() {
  const queryClient = useQueryClient();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmed = code.trim();
      await apiLogin(trimmed ? { login, password, code: trimmed } : { login, password });
      await queryClient.resetQueries({ queryKey: ["totp"] });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate(`${appBase}/`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Use your account credentials.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="login">Login</Label>
              <Input
                id="login"
                value={login}
                autoComplete="username"
                onChange={(e) => setLogin(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
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
              <Label htmlFor="code">Authentication code</Label>
              <Input
                id="code"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="if two-factor is enabled"
                onChange={(e) => setCode(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Authenticator code, or a recovery code. Leave empty if you have not set up two-factor
                authentication.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" type="submit" disabled={busy}>
              {busy ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
