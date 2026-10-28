// The admin sign-in page (W33-b, D1/D4/D7/W27; v2 login-*) at /{prefix}/app:
// its own small bundle with no console code. A quiet centred card under the
// site's logo and name: the passkey button first (one step), then "or with
// email and password" (the main button) with the public form guard
// (honeypot, minimum submit time, Turnstile when switched on for logins).
// States: wrong credentials (a red notice at the top, both inputs red, the
// password cleared and focused), passkey busy (the passkey button spins, the
// form is disabled, cancel), passkey-only (only the passkey button and the
// recovery command), not an admin (the session ended, "use another
// account"), session expired (`?next=`: where the sign-in returns to),
// signed out (`?signed_out=1`), and the "bind a passkey" prompt after a
// password login. Only admins continue to the console.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, authGet, authPost, logout, post, type LoginAnswer } from "../shared/api";
import { adminBase, afterLogin, loadPage, prefixBase } from "../shared/base";
import { errorTextWith, type ErrorTable } from "../shared/errors";
import { useLang, useSetLang, useTr } from "../shared/i18n";
import { createCredential, getAssertion, passkeysSupported } from "../shared/passkey";
import { mergeOptions } from "./guard";
import { useTheme } from "../shared/theme";
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Eye,
  EyeOff,
  Fingerprint,
  History,
  KeyRound,
  Languages,
  LoaderCircle,
  Moon,
  ShieldCheck,
  ShieldX,
  Sun,
  Terminal,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../shared/cn";
import { BrandMark, isDefaultBrand, Wordmark } from "../shared/ui/brand";
import { Button } from "../shared/ui/button";
import { Checkbox, Field, Input } from "../shared/ui/form";

/** The sign-in card (design login-*.png). */
const card = "rounded-[22px] bg-card p-6 shadow-dialog max-sm:p-5";

// The codes the sign-in page can meet (the console has the full table;
// scripts/check-error-codes.mjs keeps these in step with it).
const LOGIN_ERRORS: ErrorTable = {
  "auth.captcha_failed": ["人机验证未通过，请重试", "Human verification failed, please try again"],
  "auth.captcha_unavailable": [
    "人机验证服务暂不可用，请稍后再试",
    "Human verification is unavailable, try again later",
  ],
  "auth.passkey_required": ["此账户只能使用通行密钥登录", "This account signs in with a passkey"],
  "auth.fallback_unavailable": [
    "此账户没有已验证的邮箱（或站点未开启邮件发送），不能用邮箱验证码登录；请站点运维为你重置登录方式",
    "This account has no verified email address (or mail sending is off), so the emailed code cannot be used; ask the site operator to reset your login method",
  ],
  "auth.fallback_unneeded": ["此账户可以直接用密码登录", "This account can sign in with its password"],
  "account.passkey_exists": ["这个通行密钥已经绑定过", "This passkey is already registered"],
  "account.passkey_failed": ["通行密钥验证失败，请重试", "The passkey could not be verified, please try again"],
  "account.passkey_limit": ["每个账户最多 {max} 个通行密钥", "At most {max} passkeys per account"],
  "account.passkey_unavailable": [
    "本站暂不支持通行密钥（需要 https 主域名）",
    "Passkeys are not available on this site (needs an https main domain)",
  ],
  "request.rate_limited": ["尝试次数过多，请稍后再试", "Too many attempts. Please try again later."],
  "request.busy": ["服务器繁忙，请稍后再试", "The server is busy. Please try again shortly."],
  "request.cross_site": [
    "请求来自其他网站，已被拒绝。请回到本站页面再操作",
    "The request came from another site and was refused. Go back to this site and try again.",
  ],
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

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "info" | "danger" | "success";
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "mb-4 flex gap-2.5 rounded-xl px-3 py-2.5 text-body [&>svg]:mt-px [&>svg]:size-4 [&>svg]:shrink-0",
        tone === "info" && "bg-info-soft text-info",
        tone === "danger" && "bg-destructive-soft text-destructive",
        tone === "success" && "bg-success-soft text-success",
      )}
    >
      {icon}
      <div className="min-w-0 text-foreground/85">{children}</div>
    </div>
  );
}

function Recovery() {
  const tr = useTr();
  return (
    <details
      open
      className="mt-5 rounded-xl bg-window px-3 py-2.5 text-footnote text-muted-foreground ring-1 ring-border ring-inset"
    >
      <summary className="cursor-default font-medium text-foreground">
        {tr("丢失了全部通行密钥？", "Lost every passkey?")}
      </summary>
      <p className="mt-2">
        {tr(
          "请站点运维在服务器上运行下面的命令，为你的账户恢复密码登录，然后用密码登录并重新绑定通行密钥：",
          "Ask the site's operator to run this on the server; it restores password sign-in for your account. Then sign in with the password and add a passkey again:",
        )}
      </p>
      <code className="mt-2 flex items-center gap-2 rounded-md bg-card px-2.5 py-1.5 font-mono break-all text-foreground shadow-card">
        <Terminal className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
        {tr("akari admin reset-login <邮箱>", "akari admin reset-login <email>")}
      </code>
    </details>
  );
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
  const only = tr("之后只用通行密钥登录", "From now on, sign in with a passkey only");
  return (
    <div>
      <div className="flex flex-col items-center text-center">
        <span className="mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-primary-soft text-primary">
          <KeyRound className="size-6" aria-hidden="true" />
        </span>
        <h1 className="text-headline font-semibold">{tr("为这个账户绑定通行密钥", "Add a passkey to this account")}</h1>
        <p className="mt-1.5 text-body text-muted-foreground">
          {tr(
            "下次用指纹、面容或设备密码一步登录，不怕密码泄露。只需要 10 秒。",
            "Next time sign in in one step with fingerprint, face or the device PIN — a leaked password no longer matters. Takes 10 seconds.",
          )}
        </p>
      </div>
      <div className="mt-5 flex gap-2.5 rounded-xl bg-window p-3 ring-1 ring-border ring-inset">
        <span className="pt-0.5">
          <Checkbox id="bind-only" checked={disablePassword} onChange={setDisablePassword} label={only} />
        </span>
        <label htmlFor="bind-only" className="text-body">
          <span className="font-medium">{only}</span>
          <span className="mt-0.5 block text-footnote text-muted-foreground">
            {tr(
              "关闭这个账户的密码登录。丢失全部通行密钥时，可在服务器上运行 ",
              "Turns password sign-in off for this account. If every passkey is lost, run ",
            )}
            <code className="font-mono text-foreground">akari admin reset-login</code>
            {tr(" 恢复。", " on the server to recover.")}
          </span>
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-body text-destructive">
          {error}
        </p>
      )}
      <Button variant="primary" size="lg" className="mt-5 w-full" icon={Fingerprint} loading={busy} onClick={bind}>
        {tr("绑定通行密钥", "Add passkey")}
      </Button>
      <Button variant="ghost" size="lg" className="mt-2 w-full text-muted-foreground" onClick={onDone} disabled={busy}>
        {tr("以后再说", "Not now")}
      </Button>
      <p className="mt-2 text-center text-footnote text-faint">
        {tr("之后也可以在「我的账户」里添加。", "You can also add one later in My account.")}
      </p>
    </div>
  );
}

function NotAdmin({ email, onAgain }: { email: string; onAgain: () => void }) {
  const tr = useTr();
  return (
    <div role="alert" className="flex flex-col items-center text-center">
      <span className="mb-3 inline-flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning">
        <ShieldX className="size-6" aria-hidden="true" />
      </span>
      <h1 className="text-headline font-semibold">{tr("不是管理员账户", "Not an admin account")}</h1>
      <p className="mt-1.5 text-body text-muted-foreground">
        {email ? <b className="font-medium break-all text-foreground">{email}</b> : tr("这个账户", "This account")}
        {tr(
          " 是普通用户账户，不能进入管理后台。这次登录已结束，账户没有受到影响。用户请在门户登录。",
          " is a user account and cannot enter the admin console. This sign-in has ended; the account is not affected. Users sign in on the portal.",
        )}
      </p>
      <Button variant="primary" size="lg" className="mt-5 w-full" onClick={onAgain}>
        {tr("换个账户登录", "Use another account")}
      </Button>
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
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);
  const [badCreds, setBadCreds] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyOnly, setPasskeyOnly] = useState(false);
  // The passkey cannot be used here (the browser refused it for the site's
  // origins): the emailed-code fallback becomes the main action.
  const [passkeyBroken, setPasskeyBroken] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [fbCode, setFbCode] = useState("");
  const [notAdmin, setNotAdmin] = useState<string | null>(null);
  const [bind, setBind] = useState(false);
  const pwInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const search = useRef(new URLSearchParams(location.search));
  const [signedOut, setSignedOut] = useState(search.current.get("signed_out") === "1");
  const next = search.current.get("next");
  const nextView = next && afterLogin(location.search) === next ? next.slice(adminBase.length + 1) : null;
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
    if (siteName) document.title = `${siteName} · ${tr("管理后台登录", "Admin sign-in")}`;
  }, [siteName, tr]);
  const favicon = opts?.branding?.favicon_url;
  useEffect(() => {
    if (!favicon) return;
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = `${prefixBase}/${favicon}`;
    document.head.appendChild(link);
    return () => link.remove();
  }, [favicon]);
  // Wrong credentials: the password is cleared and focused.
  useEffect(() => {
    if (badCreds) pwInput.current?.focus();
  }, [badCreds]);

  const finish = async (answer: LoginAnswer, who: string) => {
    if (answer.role !== "admin") {
      await logout().catch(() => {});
      // The token was spent on this attempt: the next one needs a fresh one.
      setCaptchaReset((n) => n + 1);
      loadOptions();
      setBusy(null);
      setPassword("");
      setNotAdmin(who);
      return;
    }
    if (answer.passkey_prompt && opts?.passkey && passkeysSupported()) {
      setBind(true);
      setBusy(null);
      return;
    }
    goConsole();
  };

  const onPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy("password");
    setError(null);
    setBadCreds(false);
    setSignedOut(false);
    const wait = (opts?.guard?.form_min_secs ?? 0) * 1000 + 300 - (Date.now() - loadedAt.current);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const answer = await authPost<LoginAnswer>("/login", {
        email: email.trim(),
        password,
        guard: { form_token: opts?.guard?.form_token ?? null, website, turnstile: captcha || null },
      });
      await finish(answer, email.trim());
    } catch (err) {
      setBusy(null);
      setCaptchaReset((n) => n + 1);
      loadOptions();
      if (err instanceof ApiError && err.code === "auth.passkey_required") {
        setPasskeyOnly(true);
        setError(null);
      } else if (err instanceof ApiError && err.status === 401) {
        setPassword("");
        setBadCreds(true);
      } else setError(errorText(err, lang));
    }
  };

  const minWait = async () => {
    const wait = (opts?.guard?.form_min_secs ?? 0) * 1000 + 300 - (Date.now() - loadedAt.current);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };

  // Passkey-only fallback: password + a code mailed to the verified address.
  const onSendCode = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !email || !password) return;
    setBusy("password");
    setError(null);
    await minWait();
    try {
      // Checks the password, so it carries the sign-in's bot protection.
      await authPost("/login/fallback/code", {
        email: email.trim(),
        password,
        guard: { form_token: opts?.guard?.form_token ?? null, website, turnstile: captcha || null },
      });
      setCodeSent(true);
      setFbCode("");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? tr("邮箱或密码不正确。", "Wrong email or password.")
          : errorText(err, lang),
      );
    } finally {
      setBusy(null);
      // A Turnstile token is single use; the sign-in that follows needs a new one.
      setCaptchaReset((n) => n + 1);
      loadOptions();
    }
  };

  const onFallbackLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !fbCode.trim()) return;
    setBusy("password");
    setError(null);
    await minWait();
    try {
      const answer = await authPost<LoginAnswer>("/login", {
        email: email.trim(),
        password,
        fallback_code: fbCode.trim(),
        guard: { form_token: opts?.guard?.form_token ?? null, website, turnstile: captcha || null },
      });
      await finish(answer, email.trim());
    } catch (err) {
      setBusy(null);
      setCaptchaReset((n) => n + 1);
      loadOptions();
      setFbCode("");
      setError(
        err instanceof ApiError && err.status === 401
          ? tr("验证码不正确或已失效，请重新获取。", "The code is wrong or no longer valid. Request a new one.")
          : errorText(err, lang),
      );
    }
  };

  const onPasskey = async () => {
    setBusy("passkey");
    setError(null);
    setBadCreds(false);
    setSignedOut(false);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const { state, options } = await authPost<{ state: string; options: Record<string, unknown> }>(
        "/passkey/options",
      );
      const credential = await getAssertion(options, ctl.signal);
      const answer = await authPost<LoginAnswer>("/passkey/login", { state, credential });
      await finish({ ...answer, passkey_prompt: false }, "");
    } catch (err) {
      setBusy(null);
      if (ctl.signal.aborted) return;
      if (err instanceof DOMException && err.name === "SecurityError") {
        // The browser does not accept this site's passkeys (no related-origin
        // support, or the passkey domain is unreachable).
        setPasskeyBroken(true);
        setPasskeyOnly(true);
        setFallbackOpen(true);
        setError(
          tr(
            "这个浏览器无法使用本站的通行密钥。可以改用密码 + 邮箱验证码登录。",
            "This browser cannot use this site's passkeys. You can sign in with your password and an emailed code instead.",
          ),
        );
        return;
      }
      setError(
        err instanceof ApiError && err.status === 401
          ? tr("通行密钥无效或未注册", "This passkey is not valid here")
          : err instanceof ApiError
            ? errorText(err, lang)
            : tr("已取消或设备不支持通行密钥", "Cancelled, or this device has no passkey"),
      );
    } finally {
      abort.current = null;
    }
  };

  const turnstile = opts?.guard?.turnstile?.login && turnstileAllowed ? opts.guard.turnstile : null;
  const logo = opts?.branding?.logo_url;
  const passkeyOk = !!opts?.passkey && passkeysSupported();
  const name = opts?.site_name ?? "Akari";
  const formBusy = busy !== null;
  const turnstileBlock = turnstile && (
    <div className="grid gap-1.5">
      <TurnstileBox
        siteKey={turnstile.site_key}
        onToken={onCaptcha}
        onFail={setCaptchaFailed}
        resetKey={captchaReset}
        theme={theme}
        lang={lang}
      />
      {!captcha && !captchaFailed && (
        <p role="status" className="flex items-center gap-2 text-body text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {tr("正在确认你是真人…", "Checking that you are human…")}
        </p>
      )}
      {captchaFailed && (
        <div role="alert" className="flex items-center gap-3 text-body text-destructive">
          <span>{tr("人机验证加载失败，请刷新重试", "Human verification could not load, reload and try again")}</span>
          <Button type="button" variant="ghost" size="sm" onClick={retryCaptcha}>
            {tr("重试", "Retry")}
          </Button>
        </div>
      )}
    </div>
  );

  const passkeyButton = (
    <Button
      variant={passkeyOnly ? "primary" : "outline"}
      size="lg"
      className="w-full [&_svg]:size-[18px]"
      icon={busy === "passkey" ? undefined : Fingerprint}
      onClick={onPasskey}
      disabled={formBusy}
    >
      {busy === "passkey" && <LoaderCircle className="animate-spin" aria-hidden="true" />}
      {busy === "passkey"
        ? tr("等待通行密钥…", "Waiting for the passkey…")
        : tr("使用通行密钥登录", "Sign in with a passkey")}
    </Button>
  );

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-10">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -top-48 left-1/2 size-[720px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--primary)_14%,transparent),transparent)]" />
      </div>
      <div className="absolute top-4 right-4 flex gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          icon={Languages}
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          aria-label={lang === "zh" ? "English" : "中文"} // i18n-ok: the other language's own name
        />
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          icon={theme === "dark" ? Moon : Sun}
          onClick={toggleTheme}
          aria-label={tr("切换主题", "Toggle theme")}
        />
      </div>
      <main className="relative w-full max-w-[380px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandMark name={name} logoUrl={logo ? `${prefixBase}/${logo}` : null} size={48} />
          {isDefaultBrand(name, logo) ? (
            <div className="mt-3 mb-1.5">
              <Wordmark height={30} />
              <span className="sr-only">{name}</span>
            </div>
          ) : (
            <div className="mt-3 text-title3 font-semibold tracking-[-0.015em]">{name}</div>
          )}
          <div className="text-body text-muted-foreground">{tr("管理后台", "Admin console")}</div>
        </div>
        <div className={card}>
          {bind ? (
            <BindPasskey onDone={goConsole} />
          ) : notAdmin !== null ? (
            <NotAdmin
              email={notAdmin}
              onAgain={() => {
                setNotAdmin(null);
                setEmail("");
              }}
            />
          ) : (
            <>
              <h1 className="mb-4 text-headline font-semibold">{tr("登录", "Sign in")}</h1>
              {nextView && !badCreds && !error && (
                <Notice tone="info" icon={<History />}>
                  {tr("登录已过期，请重新登录。登录后回到 ", "Your session ended; sign in again. You return to ")}
                  <b className="font-mono font-semibold break-all">{nextView}</b>
                  {tr("。", ".")}
                </Notice>
              )}
              {signedOut && (
                <Notice tone="success" icon={<CircleCheck />}>
                  {tr("已退出登录。", "Signed out.")}
                </Notice>
              )}
              {badCreds && (
                <Notice tone="danger" icon={<CircleAlert />}>
                  {tr(
                    "邮箱或密码不正确。连续失败几次后会要求人机验证。",
                    "Wrong email or password. After several failures a human check may be required.",
                  )}
                </Notice>
              )}
              {error && (
                <Notice tone="danger" icon={<CircleAlert />}>
                  {error}
                </Notice>
              )}
              {passkeyOnly ? (
                <>
                  <p className="mb-4 text-body text-muted-foreground">
                    {tr(
                      "此账户只能用通行密钥登录。使用这台设备上保存的通行密钥，或插入安全密钥。",
                      "This account signs in with a passkey only. Use a passkey saved on this device, or insert a security key.",
                    )}
                  </p>
                  {passkeyOk && !passkeyBroken ? (
                    passkeyButton
                  ) : (
                    <p className="text-body text-warning">
                      {passkeyBroken
                        ? tr("这个浏览器无法使用本站的通行密钥。", "This browser cannot use this site's passkeys.")
                        : tr("这个浏览器或站点不支持通行密钥。", "This browser or site does not support passkeys.")}
                    </p>
                  )}
                  <div className="mt-4" data-testid="passkey-fallback">
                    {!fallbackOpen && !(!passkeyOk || passkeyBroken) ? (
                      <button
                        type="button"
                        className="text-footnote text-primary hover:underline"
                        onClick={() => setFallbackOpen(true)}
                      >
                        {tr(
                          "通行密钥用不了？改用密码 + 邮箱验证码",
                          "Passkey not working? Use your password + an emailed code",
                        )}
                      </button>
                    ) : (
                      <form
                        className="grid gap-3 rounded-xl bg-window p-3 ring-1 ring-border ring-inset"
                        onSubmit={codeSent ? onFallbackLogin : onSendCode}
                        noValidate
                      >
                        <p className="text-footnote font-medium text-foreground">
                          {tr("密码 + 邮箱验证码登录", "Password + emailed code")}
                        </p>
                        {codeSent ? (
                          <>
                            <p role="status" className="text-footnote text-muted-foreground">
                              {tr(
                                "验证码已发送到账户的已验证邮箱，10 分钟内有效。",
                                "A code was sent to the account's verified address; it is valid for 10 minutes.",
                              )}
                            </p>
                            <Field label={tr("邮箱验证码", "Emailed code")}>
                              <Input
                                id="fallback-code"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                maxLength={6}
                                value={fbCode}
                                onChange={(e) => setFbCode(e.target.value.replace(/\D/g, ""))}
                                className="h-10 rounded-[10px] font-mono tracking-widest"
                                required
                              />
                            </Field>
                            {turnstileBlock}
                            <Button
                              type="submit"
                              variant="primary"
                              size="lg"
                              className="w-full"
                              loading={busy === "password"}
                              disabled={fbCode.length !== 6 || (wantTurnstile && (!turnstile || !captcha))}
                            >
                              {tr("登录", "Sign in")}
                            </Button>
                            <button
                              type="button"
                              className="text-footnote text-primary hover:underline"
                              onClick={() => void onSendCode()}
                              disabled={formBusy}
                            >
                              {tr("重新发送验证码", "Send a new code")}
                            </button>
                          </>
                        ) : (
                          <>
                            <Field label={tr("邮箱", "Email")}>
                              <Input
                                id="fallback-email"
                                type="email"
                                autoComplete="username"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="h-10 rounded-[10px]"
                                required
                              />
                            </Field>
                            <Field label={tr("密码", "Password")}>
                              <Input
                                id="fallback-password"
                                type="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="h-10 rounded-[10px]"
                                required
                              />
                            </Field>
                            <Button
                              type="submit"
                              variant={!passkeyOk || passkeyBroken ? "primary" : "outline"}
                              size="lg"
                              className="w-full"
                              loading={busy === "password"}
                              disabled={!email || !password}
                            >
                              {tr("发送邮箱验证码", "Email me a code")}
                            </Button>
                          </>
                        )}
                      </form>
                    )}
                  </div>
                  <Recovery />
                </>
              ) : (
                <>
                  {passkeyOk && (
                    <>
                      {passkeyButton}
                      {busy === "passkey" && (
                        <p className="mt-2 text-center text-footnote text-muted-foreground">
                          {tr("请在浏览器弹出的窗口里确认。", "Confirm in the browser's window. ")}
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => abort.current?.abort()}
                          >
                            {tr("取消", "Cancel")}
                          </button>
                        </p>
                      )}
                      <div className="my-5 flex items-center gap-3 text-footnote text-faint">
                        <span className="h-px flex-1 bg-separator" />
                        {tr("或用邮箱和密码", "or with email and password")}
                        <span className="h-px flex-1 bg-separator" />
                      </div>
                    </>
                  )}
                  <form className="grid gap-3.5" onSubmit={onPassword} noValidate>
                    <Field label={tr("邮箱", "Email")}>
                      <Input
                        id="email"
                        type="email"
                        autoComplete="username webauthn"
                        value={email}
                        disabled={busy === "passkey"}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          setBadCreds(false);
                        }}
                        aria-invalid={badCreds || undefined}
                        className="h-10 rounded-[10px]"
                        required
                      />
                    </Field>
                    <Field label={tr("密码", "Password")}>
                      <div className="relative">
                        <Input
                          id="password"
                          ref={pwInput}
                          type={showPw ? "text" : "password"}
                          autoComplete="current-password"
                          value={password}
                          disabled={busy === "passkey"}
                          onChange={(e) => {
                            setPassword(e.target.value);
                            setBadCreds(false);
                          }}
                          aria-invalid={badCreds || undefined}
                          className="h-10 rounded-[10px] pr-10"
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowPw((v) => !v)}
                          aria-label={showPw ? tr("隐藏密码", "Hide password") : tr("显示密码", "Show password")}
                          aria-pressed={showPw}
                          className="absolute top-1/2 right-1 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-faint hover:text-foreground"
                        >
                          {showPw ? (
                            <EyeOff className="size-4" aria-hidden="true" />
                          ) : (
                            <Eye className="size-4" aria-hidden="true" />
                          )}
                        </button>
                      </div>
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
                    {turnstileBlock}
                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      className="mt-1 w-full"
                      loading={busy === "password"}
                      disabled={
                        busy === "passkey" || !email || !password || (wantTurnstile && (!turnstile || !captcha))
                      }
                    >
                      {tr("登录", "Sign in")}
                      {busy !== "password" && <ArrowRight aria-hidden="true" />}
                    </Button>
                  </form>
                </>
              )}
            </>
          )}
        </div>
        <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-footnote text-faint">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          {tr("仅限管理员 · 由 Akari 驱动", "Administrators only · powered by Akari")}
        </p>
      </main>
    </div>
  );
}
