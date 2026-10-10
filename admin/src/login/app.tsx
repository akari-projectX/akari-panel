// The admin sign-in page (W33-b, D1/D4/D7/W27) at /{prefix}/app: its own
// small bundle with no console code. Email + password with the public
// form guard (honeypot, minimum submit time, Turnstile when switched on for
// logins), passkey login, and the "bind a passkey" prompt after a password
// login. Only admins continue to the console.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, authGet, authPost, logout, post, type LoginAnswer } from "../shared/api";
import { afterLogin, loadPage, prefixBase } from "../shared/base";
import { errorTextWith, type ErrorTable } from "../shared/errors";
import { useLang, useSetLang, useTr } from "../shared/i18n";
import { createCredential, getAssertion, passkeysSupported } from "../shared/passkey";
import { mergeOptions } from "./guard";
import { useTheme } from "../shared/theme";
import { Icon } from "../shared/ui/icons";
import { Button, Callout, Checkbox, Field, Input } from "../shared/ui/primitives";

// The codes the sign-in page can meet (the console has the full table;
// scripts/check-error-codes.mjs keeps these in step with it).
export const LOGIN_ERRORS: ErrorTable = {
  "auth.captcha_failed": ["人机验证未通过，请重试", "Human verification failed, please try again"],
  "auth.captcha_unavailable": [
    "人机验证服务暂不可用，请稍后再试",
    "Human verification is unavailable, try again later",
  ],
  "auth.passkey_required": ["此账户只能使用通行密钥登录", "This account signs in with a passkey"],
  "account.passkey_exists": ["这个通行密钥已经绑定过", "This passkey is already registered"],
  "account.passkey_failed": ["通行密钥验证失败，请重试", "The passkey could not be verified, please try again"],
  "account.passkey_limit": ["每个账户最多 {max} 个通行密钥", "At most {max} passkeys per account"],
  "account.passkey_unavailable": [
    "本站暂不支持通行密钥（需要 https 主域名）",
    "Passkeys are not available on this site (needs an https main domain)",
  ],
  "request.rate_limited": ["尝试次数过多，请稍后再试", "Too many attempts. Please try again later."],
};
const errorText = (e: unknown, lang: "zh" | "en") => errorTextWith(LOGIN_ERRORS, e, lang);

type Guard = {
  form_token: string | null;
  form_min_secs: number;
  honeypot: boolean;
  turnstile: { site_key: string; login: boolean } | null;
};

export type AuthOptions = {
  site_name: string;
  branding: { logo_url: string | null; favicon_url: string | null } | null;
  guard: Guard | null;
  passkey: boolean;
};

type Turnstile = {
  render: (el: HTMLElement, o: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

/** How often an open sign-in page fetches the guard settings again. */
const GUARD_POLL_MS = 30_000;

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Why the widget is not there: its script did not load (reload the page) or it failed / timed out (reset it). */
type TurnstileFailure = "script" | "widget";

/**
 * The Turnstile widget (only when switched on for logins; the page's CSP then allows it).
 * A token is single-use: the page bumps `resetKey` after every attempt that sent one, and the
 * held token is dropped before the widget fetches a new one. Expired, failed or timed-out
 * challenges drop it too, so the button stays disabled until a fresh token arrives; failures
 * and a script that cannot load are reported (`onFail`) so the page says so, with a retry.
 */
function TurnstileBox({
  siteKey,
  onToken,
  onFail,
  resetKey,
  theme,
  lang,
}: {
  siteKey: string;
  onToken: (t: string) => void;
  onFail: (kind: TurnstileFailure) => void;
  resetKey: number;
  theme: "light" | "dark";
  lang: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const fail = useRef(onFail);
  useEffect(() => {
    fail.current = onFail;
  });
  useEffect(() => {
    let cancelled = false;
    const failed = (kind: TurnstileFailure) => () => {
      onToken("");
      if (!cancelled) fail.current(kind);
    };
    const mount = () => {
      if (cancelled || !ref.current || !window.turnstile || widget.current) return;
      widget.current = window.turnstile.render(ref.current, {
        sitekey: siteKey,
        // Invisible unless Cloudflare wants an interaction; then as wide as
        // the inputs, in the page's theme and language.
        appearance: "interaction-only",
        size: "flexible",
        theme,
        language: lang === "en" ? "en" : "zh-cn",
        callback: (t: string) => onToken(t),
        "expired-callback": () => onToken(""),
        "error-callback": failed("widget"),
        "timeout-callback": failed("widget"),
      });
    };
    if (window.turnstile) mount();
    else {
      let s = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`);
      if (!s) {
        s = document.createElement("script");
        s.src = TURNSTILE_SRC;
        s.async = true;
        document.head.appendChild(s);
      }
      s.addEventListener("load", mount);
      s.addEventListener("error", failed("script"));
    }
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
      onToken("");
    };
  }, [siteKey, onToken, theme, lang]);
  useEffect(() => {
    if (resetKey && widget.current && window.turnstile) {
      onToken("");
      window.turnstile.reset(widget.current);
    }
  }, [resetKey, onToken]);
  return <div ref={ref} data-testid="turnstile" className="w-full empty:hidden" />;
}

function BindPasskey({ onDone }: { onDone: () => void }) {
  const tr = useTr();
  const lang = useLang();
  const [disablePassword, setDisablePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bind = async () => {
    setBusy(true);
    setError(null);
    try {
      const { state, options } = await post<{ state: string; options: Record<string, unknown> }>(
        "/me/passkeys/options",
      );
      const credential = await createCredential(options);
      await post("/me/passkeys", {
        state,
        credential,
        name: navigator.platform || "passkey",
        disable_password: disablePassword,
      });
      onDone();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? errorText(e, lang)
          : tr("未完成绑定（已取消或设备不支持）", "Not added (cancelled or unsupported)"),
      );
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-card">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Icon name="fingerprint" size={22} />
      </div>
      <h2 className="text-base font-semibold">{tr("绑定通行密钥", "Add a passkey")}</h2>
      <p className="mt-1.5 text-[13px] text-muted-foreground">
        {tr(
          "你刚刚用密码登录。绑定通行密钥后，可以用指纹、面容或安全密钥登录，比密码更安全。",
          "You just signed in with a password. With a passkey you sign in with fingerprint, face or a security key — safer than a password.",
        )}
      </p>
      <div className="mt-4 flex items-start gap-2 text-[13px]">
        <Checkbox
          checked={disablePassword}
          onChange={setDisablePassword}
          label={tr("绑定后关闭此账户的密码登录", "Turn off password sign-in for this account")}
        />
        <span>{tr("绑定后关闭此账户的密码登录", "Turn off password sign-in for this account")}</span>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {error}
        </p>
      )}
      <div className="mt-5 space-y-2">
        <Button variant="primary" size="lg" className="w-full" icon="fingerprint" loading={busy} onClick={bind}>
          {tr("现在绑定", "Add passkey now")}
        </Button>
        <Button variant="ghost" size="lg" className="w-full" onClick={onDone} disabled={busy}>
          {tr("稍后（下次登录还会提示）", "Later (ask again next time)")}
        </Button>
      </div>
    </div>
  );
}

export function LoginApp() {
  const tr = useTr();
  const lang = useLang();
  const setLang = useSetLang();
  const [theme, toggleTheme] = useTheme();
  const [opts, setOpts] = useState<AuthOptions | null>(null);
  const [turnstileAllowed, setTurnstileAllowed] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [website, setWebsite] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);
  const [captchaFailed, setCaptchaFailed] = useState<TurnstileFailure | null>(null);
  const onCaptcha = useCallback((t: string) => {
    setCaptcha(t);
    if (t) setCaptchaFailed(null);
  }, []);
  const retryCaptcha = () => {
    if (captchaFailed === "script") {
      location.reload();
      return;
    }
    setCaptchaFailed(null);
    setCaptchaReset((n) => n + 1);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyOnly, setPasskeyOnly] = useState(false);
  const [bind, setBind] = useState(false);
  const goConsole = useCallback(() => loadPage(afterLogin(location.search)), []);
  // The form token's age is checked against the minimum submit time: a fast
  // (autofilled) submission waits out the rest instead of being refused.
  const loadedAt = useRef(0);
  const formToken = opts?.guard?.form_token;
  useEffect(() => {
    loadedAt.current = Date.now();
  }, [formToken]);

  // The guard settings (minimum time, Turnstile on sign-in) can change while
  // this page is open, and a submission caught with stale ones only gets the
  // ordinary failure: fetch them again (with a fresh form token) after every
  // attempt, every GUARD_POLL_MS and when the window comes back.
  const loadOptions = useCallback(() => {
    authGet<AuthOptions>("/options")
      .then((o) => {
        setTurnstileAllowed((cur) => cur ?? !!o.guard?.turnstile?.login);
        // A held, still fresh form token survives the refetch (mergeOptions): no new wait.
        setOpts((cur) => mergeOptions(cur, o, Date.now() - loadedAt.current));
      })
      .catch(() => setOpts((cur) => cur ?? { site_name: "Akari", branding: null, guard: null, passkey: false }));
  }, []);
  useEffect(() => {
    loadOptions();
    const onVisible = () => {
      if (document.visibilityState === "visible") loadOptions();
    };
    const timer = window.setInterval(loadOptions, GUARD_POLL_MS);
    window.addEventListener("focus", loadOptions);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", loadOptions);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadOptions]);

  // The page's CSP allows Cloudflare's script only if Turnstile was on for
  // sign-ins when the page was served (console::app_entry): switched on
  // later, the widget cannot load (nor is it mounted), so load the page again.
  const wantTurnstile = !!opts?.guard?.turnstile?.login;
  useEffect(() => {
    if (wantTurnstile && turnstileAllowed === false) location.reload();
  }, [wantTurnstile, turnstileAllowed]);

  const siteName = opts?.site_name;
  useEffect(() => {
    if (siteName) document.title = `${siteName} · ${lang === "en" ? "Admin sign-in" : "管理后台登录"}`;
  }, [siteName, lang]);
  const favicon = opts?.branding?.favicon_url;
  useEffect(() => {
    if (!favicon) return;
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = `${prefixBase}/${favicon}`;
    document.head.appendChild(link);
    return () => link.remove();
  }, [favicon]);

  const finish = async (answer: LoginAnswer) => {
    if (answer.role !== "admin") {
      await logout().catch(() => {});
      // The token was spent on this attempt: the next one needs a fresh one.
      setCaptchaReset((n) => n + 1);
      loadOptions();
      setBusy(false);
      setError(
        tr("这不是管理员账户。用户请在门户登录。", "This is not an admin account. Users sign in on the portal."),
      );
      return;
    }
    if (answer.passkey_prompt && opts?.passkey && passkeysSupported()) {
      setBind(true);
      setBusy(false);
      return;
    }
    goConsole();
  };

  const onPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const wait = (opts?.guard?.form_min_secs ?? 0) * 1000 + 300 - (Date.now() - loadedAt.current);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const answer = await authPost<LoginAnswer>("/login", {
        email: email.trim(),
        password,
        guard: { form_token: opts?.guard?.form_token ?? null, website, turnstile: captcha || null },
      });
      await finish(answer);
    } catch (err) {
      setBusy(false);
      setCaptchaReset((n) => n + 1);
      loadOptions();
      if (err instanceof ApiError && err.code === "auth.passkey_required") {
        setPasskeyOnly(true);
        setError(null);
      } else if (err instanceof ApiError && err.status === 401) {
        setError(tr("邮箱或密码错误", "Wrong email or password"));
      } else setError(errorText(err, lang));
    }
  };

  const onPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { state, options } = await authPost<{ state: string; options: Record<string, unknown> }>(
        "/passkey/options",
      );
      const credential = await getAssertion(options);
      const answer = await authPost<LoginAnswer>("/passkey/login", { state, credential });
      await finish({ ...answer, passkey_prompt: false });
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiError && err.status === 401
          ? tr("通行密钥无效或未注册", "This passkey is not valid here")
          : err instanceof ApiError
            ? errorText(err, lang)
            : tr("已取消或设备不支持通行密钥", "Cancelled, or this device has no passkey"),
      );
    }
  };

  const turnstile = opts?.guard?.turnstile?.login && turnstileAllowed ? opts.guard.turnstile : null;
  const logo = opts?.branding?.logo_url;
  const passkeyOk = !!opts?.passkey && passkeysSupported();

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-subtle px-4 py-10">
      <div className="absolute right-3 top-3 flex gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          icon="languages"
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          aria-label={lang === "zh" ? "English" : "中文"}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          icon={theme === "dark" ? "sun" : "moon"}
          onClick={toggleTheme}
          aria-label={tr("切换主题", "Toggle theme")}
        />
      </div>
      <main className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center text-center">
          {logo ? (
            <img src={`${prefixBase}/${logo}`} alt="" className="mb-3 h-11 w-11 rounded-xl object-contain" />
          ) : (
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground shadow-card">
              {(opts?.site_name ?? "A").slice(0, 1)}
            </div>
          )}
          <h1 className="text-lg font-semibold">
            {tr(`${opts?.site_name ?? "Akari"} 管理后台`, `${opts?.site_name ?? "Akari"} admin console`)}
          </h1>
        </div>

        {bind ? (
          <BindPasskey onDone={goConsole} />
        ) : (
          <div className="rounded-xl border border-border bg-card p-6 shadow-card">
            {passkeyOk && (
              <Button
                variant={passkeyOnly ? "primary" : "secondary"}
                size="lg"
                className="w-full"
                icon="fingerprint"
                onClick={onPasskey}
                disabled={busy}
              >
                {tr("使用通行密钥登录", "Sign in with a passkey")}
              </Button>
            )}
            {passkeyOnly ? (
              <div className="mt-4">
                <Callout tone="info">
                  {tr(
                    "此账户只允许通行密钥登录。丢失设备时，请在服务器上运行 akari admin reset-login <邮箱> 恢复。",
                    "This account signs in with a passkey only. Lost the device? Run akari admin reset-login <email> on the server.",
                  )}
                </Callout>
              </div>
            ) : (
              <>
                {passkeyOk && (
                  <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
                    <div className="h-px flex-1 bg-border" />
                    {tr("或使用邮箱和密码", "or email and password")}
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                <form className="space-y-4" onSubmit={onPassword} noValidate>
                  <Field label={tr("邮箱", "Email")}>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="username webauthn"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </Field>
                  <Field label={tr("密码", "Password")}>
                    <Input
                      id="password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </Field>
                  {opts?.guard?.honeypot && (
                    <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
                      <label>
                        Website
                        <input
                          name="website"
                          tabIndex={-1}
                          autoComplete="off"
                          value={website}
                          onChange={(e) => setWebsite(e.target.value)}
                        />
                      </label>
                    </div>
                  )}
                  {turnstile && (
                    <>
                      <TurnstileBox
                        siteKey={turnstile.site_key}
                        onToken={onCaptcha}
                        onFail={setCaptchaFailed}
                        resetKey={captchaReset}
                        theme={theme}
                        lang={lang}
                      />
                      {!captcha && !captchaFailed && (
                        <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
                          <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          {tr("正在进行人机验证…", "Verifying you are human…")}
                        </p>
                      )}
                      {captchaFailed && (
                        <div role="alert" className="flex items-center gap-3 text-[13px] text-destructive">
                          <span>
                            {tr(
                              "人机验证加载失败，请刷新重试",
                              "Human verification could not load, reload and try again",
                            )}
                          </span>
                          <Button type="button" variant="ghost" size="sm" onClick={retryCaptcha}>
                            {tr("重试", "Retry")}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    className="w-full"
                    loading={busy}
                    disabled={!email || !password || (wantTurnstile && (!turnstile || !captcha))}
                  >
                    {tr("登录", "Sign in")}
                  </Button>
                </form>
              </>
            )}
            {error && (
              <p role="alert" className="mt-4 text-[13px] text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          {tr(
            "后台地址只有管理员知道；门户不会链接到这里。",
            "Only admins know this address; the portal never links here.",
          )}
        </p>
      </main>
    </div>
  );
}
