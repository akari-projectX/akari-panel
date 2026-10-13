import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, KeyRound, MailCheck, TriangleAlert } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/loading';
import GuardFields from '@/components/form-guard';
import TextField from '@/components/text-field';
import { ApiError, authApi, type LoginResult } from '@/api';
import { solvePow } from '@/api/pow';
import { isUserCancel, webauthnSupported } from '@/api/webauthn';
import { usePending } from '@/hooks/use-api';
import { safeRedirect, useAuth, useSiteOptions } from '@/lib/auth';
import { useErrorText } from '@/lib/errors';
import { digits, fieldOf, isCode, isEmail, useFieldErrors } from '@/lib/form-errors';
import { useFormGuard } from '@/lib/form-guard';
import { R } from '@/lib/routes';
import { useSite } from '@/lib/site';
import { cn } from '@/lib/utils';
import { useLocale, useT, useTp } from '@/i18n';

/*
 * 登录、注册、找回密码、按邮件链接重设密码。
 *
 * 这几张表单都是面板的公开接口（/auth/*），带同一套机器人防护：表单令牌 + 蜜罐 + 最短提交时间，
 * 站长开了的话再加 Cloudflare Turnstile（见 lib/form-guard、components/form-guard）。
 * 被防护拦下的提交，面板的答复和普通失败一模一样——前端分不出来，也不该去分。
 */

/* ---------- 表单外壳 ----------
 * 跟落地页共用 SiteLayout —— 这里只剩「把一栏内容居中」这一件事。
 */
function Shell({ children }: { children: React.ReactNode }) {
  const tr = useT();
  /* /auth/options 没取到：注册、找回、通行密钥的入口都按「关」处理，表单提交也会被拒——得告诉用户，而不是只少几个按钮 */
  const { error, refresh } = useSiteOptions();
  const [retrying, retry] = usePending();
  return (
    <section className="relative flex min-h-[calc(100vh-160px)] items-center justify-center px-6 pt-10 pb-20">
      {/* 极淡的品牌色光晕 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-90"
        style={{ background: 'radial-gradient(ellipse 60% 100% at 50% 0%, color-mix(in srgb, var(--brand) 7%, transparent), transparent 70%)' }}
      />
      <div className="relative w-full max-w-[360px]">
        {error && (
          <div role="alert" className="mb-8 flex items-center gap-3 rounded-xl bg-amber-500/[.08] px-4 py-3 text-[13px] leading-[1.6] dark:bg-amber-500/[.12]">
            <TriangleAlert className="size-4 shrink-0 text-warning" />
            <span className="min-w-0 flex-1">{tr('站点设置没能加载，暂时无法登录或注册。')}</span>
            <Button size="sm" variant="outline" disabled={retrying} onClick={() => retry(refresh)}>{tr('重试')}</Button>
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

/* ---------- 表单字段 ----------
 * 登录注册页用 TextField 的大号：标签 + 输入框 + 下方的内联错误。表单一律 noValidate（不用浏览器气泡），
 * 提交时用 lib/form-errors 校验并聚焦第一个出错的字段；能对应到字段的服务端错误码也画在字段下面。
 */
function Field(props: React.ComponentProps<typeof TextField>) {
  return <TextField large {...props} />;
}

function Title({ h, sub }: { h: string; sub: string }) {
  const tr = useT();
  return (
    <div className="mb-8">
      <h1 className="text-[27px] font-semibold tracking-[-0.03em]">{tr(h)}</h1>
      <p className="mt-2 text-[14.5px] text-muted-foreground">{sub}</p>
    </div>
  );
}

/** 两种登录 / 注册方式之间的「或」 */
function Divider() {
  const tr = useT();
  return (
    <div className="my-6 flex items-center gap-4">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted-foreground">{tr('或')}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}


/** 邮件语言：注册时按界面语言定，之后跟着界面语言同步（AuthProvider） */
const mailLocale = (l: string): 'zh' | 'en' => (l === 'en' ? 'en' : 'zh');

/**
 * 邮箱验证码那一行：输入框 + 发送按钮 + 60 秒冷却（按截止时间戳算，不按剩余秒数递减）。
 * 发码是一次带防护的公开表单提交：面板对任何地址都答 ok，不能据此判断邮箱是否已注册。
 */
function CodeField({
  value, onChange, onSend, disabled, error, id,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string;
  id: string;
  /** 发码；返回 true 才进入冷却 */
  onSend: () => Promise<boolean>;
  disabled?: boolean;
}) {
  const tr = useT();
  const tp = useTp();
  const [until, setUntil] = useState(0);
  const [left, setLeft] = useState(0);
  const [sending, run] = usePending();

  useEffect(() => {
    if (!until) return;
    let t: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) clearInterval(t);
    };
    t = setInterval(tick, 250);
    tick();
    return () => clearInterval(t);
  }, [until]);

  const send = () => run(async () => {
    if (await onSend()) setUntil(Date.now() + 60_000);
  });

  return (
    <div className="flex items-start gap-2.5">
      <div className="min-w-0 flex-1">
        <Field
          id={id} label={tr('邮箱验证码')} error={error}
          value={value} onChange={(e) => onChange(digits(e.target.value))}
          inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder={tr('六位数字')}
        />
      </div>
      <Button
        type="button" variant="outline" disabled={disabled || sending || left > 0}
        onClick={send} className="mt-[29px] h-11 shrink-0 rounded-xl px-3.5 text-[13px] font-medium shadow-none"
      >
        {sending && <Spinner size={14} tone="current" />}
        {left > 0 ? tp('{n} 秒', { n: left }) : tr('发送验证码')}
      </Button>
    </div>
  );
}

/** 拿到登录答复之后的收尾：取账户数据、提示、跳走。密码、通行密钥、注册几条路都走这里 */
function useFinishLogin() {
  const tr = useT();
  const nav = useNavigate();
  const { signIn } = useAuth();
  return async (result: LoginResult, to: string, description?: string) => {
    await signIn(result);
    toast.success(tr('登录成功'), description ? { description } : undefined);
    nav(to, { replace: true });
  };
}

/** 通行密钥登录：可发现凭据，不用输邮箱，设备会列出本站的通行密钥让用户选 */
function usePasskeyLogin(to: string) {
  const tr = useT();
  const errText = useErrorText();
  const finish = useFinishLogin();
  const [busy, run] = usePending();
  const login = () => run(async () => {
    try {
      await finish(await authApi.passkeyLogin(), to);
    } catch (e) {
      /* 用户在系统弹窗里点了取消，不算错误 */
      if (isUserCancel(e)) return;
      /* 浏览器认为这个域名不能用该通行密钥（不支持跨域名通行密钥的浏览器） */
      if (e instanceof DOMException && e.name === 'SecurityError') {
        toast.error(tr('当前浏览器不支持在这个域名上使用该通行密钥，请改用密码登录'));
        return;
      }
      toast.error(e instanceof ApiError && e.status === 401 ? tr('通行密钥登录失败，请重试或改用密码登录') : errText(e));
    }
  });
  return [busy, login] as const;
}

/* ================= 登录 ================= */
export function Login() {
  const tr = useT();
  const errText = useErrorText();
  const [sp] = useSearchParams();
  const site = useSite();
  const finish = useFinishLogin();
  const guard = useFormGuard('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, run] = usePending();
  /* 仅通行密钥账户用密码登录会被拒（403 auth.passkey_required）：把通行密钥按钮突出出来 */
  const [needPasskey, setNeedPasskey] = useState(false);
  const f = useFieldErrors(['email', 'password'] as const);

  const canPasskey = site.passkey && webauthnSupported();
  const to = safeRedirect(sp.get('redirect'));
  const [pkLoading, loginWithPasskey] = usePasskeyLogin(to);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.check({
      email: !email.trim() ? tr('请输入邮箱') : !isEmail(email) ? tr('请输入有效的邮箱地址') : undefined,
      password: !password && tr('请输入密码'),
    })) return;
    run(async () => {
      try {
        await finish(await authApi.login(email.trim(), password, await guard.build()), to);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'auth.passkey_required') { setNeedPasskey(true); return; }
        /* 面板对所有登录失败都答同一个 401，不区分邮箱不存在还是密码错：画在密码下面 */
        if (err instanceof ApiError && err.status === 401) f.set('password', tr('邮箱或密码错误'));
        else toast.error(errText(err));
      } finally {
        guard.after();
      }
    });
  };

  const passkeyButton = canPasskey && (
    <Button
      type="button" variant={needPasskey ? 'default' : 'outline'} disabled={loading || pkLoading} onClick={loginWithPasskey}
      className={cn('h-11 w-full gap-2 rounded-xl text-[15px]', !needPasskey && 'shadow-none')}
    >
      {pkLoading ? <Spinner size={16} tone="current" /> : <KeyRound className="size-4" />}
      {pkLoading ? tr('等待设备验证…') : tr('使用通行密钥登录')}
    </Button>
  );

  return (
    <Shell>
      <Title h="登录" sub={tr('继续使用你的订阅')} />

      {needPasskey && passkeyButton && (
        <div className="mb-6 space-y-3 rounded-xl bg-brand/5 px-4 py-4">
          <p className="text-[13px] leading-[1.8]">{tr('这个账户只能用通行密钥登录。')}</p>
          {passkeyButton}
        </div>
      )}

      <form noValidate onSubmit={submit} className="relative space-y-5">
        <Field
          {...f.field('email', 'login-email')}
          label={tr('邮箱')} type="email" autoComplete="username webauthn" placeholder="you@example.com"
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          {...f.field('password', 'login-password')}
          label={tr('密码')} type="password" autoComplete="current-password" placeholder={tr('输入密码')}
          value={password} onChange={(e) => setPassword(e.target.value)}
          hint={site.resetOpen && (
            <Link to={R.forgot} className="text-[12.5px] text-muted-foreground transition-colors hover:text-brand">{tr('忘记密码')}</Link>
          )}
        />
        <GuardFields guard={guard} />
        <Button
          type="submit" disabled={loading || pkLoading || !guard.ready || guard.unavailable}
          className="h-11 w-full rounded-xl text-[15px]"
        >
          {loading && <Spinner size={16} tone="current" />}
          {loading ? tr('登录中') : tr('登录')}
        </Button>
      </form>

      {!needPasskey && passkeyButton && (
        <>
          <Divider />
          {passkeyButton}
        </>
      )}

      {site.registerOpen && (
        <p className="mt-8 text-center text-[13.5px] text-muted-foreground">
          {tr('还没有账号？')}<Link to={R.register} className="text-brand underline-offset-4 hover:underline">{tr('注册')}</Link>
        </p>
      )}
    </Shell>
  );
}

/* ================= 注册 ================= */

/** 注册页上的进度：普通提交 / 正在做工作量证明 */
type Phase = 'idle' | 'pow' | 'submit';

export function Register() {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const { locale } = useLocale();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { signIn } = useAuth();
  const site = useSite();
  const guard = useFormGuard('register');

  const [email, setEmail] = useState('');
  const [pwd, setPwd] = useState('');
  const [code, setCode] = useState('');
  /* 邀请链接形如 /register?invite=XXXX（面板的 link_base），带进来就预填上 */
  const [invite, setInvite] = useState(sp.get('invite')?.trim() ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const f = useFieldErrors(['email', 'password', 'invite', 'code'] as const);
  /* 面板的错误码 → 字段（其余的用 toast） */
  const FIELD_CODES = {
    'signup.invalid_email': 'email', 'signup.domain_not_allowed': 'email', 'signup.unavailable': 'email',
    'account.password_too_short': 'password', 'account.password_too_long': 'password',
    'signup.invalid_invite': 'invite', 'signup.invite_required': 'invite',
    'signup.invalid_code': 'code',
  } as const;
  const emailError = () => (!email.trim() ? tr('请输入邮箱') : !isEmail(email) ? tr('请输入有效的邮箱地址') : undefined);
  const inviteError = () => (site.inviteRequired && !invite.trim() ? tr('请填写邀请码') : undefined);
  const showServerError = (err: unknown) => {
    const k = fieldOf(err, FIELD_CODES);
    if (k) f.set(k, errText(err));
    else toast.error(errText(err));
  };

  const rules = [
    { label: '至少 8 位', ok: pwd.length >= 8 },
    { label: '含字母', ok: /[a-zA-Z]/.test(pwd) },
    { label: '含数字', ok: /\d/.test(pwd) },
  ];

  /* 发码：面板对任何地址都答 ok（地址已注册的话收到的是一封「已注册」的邮件） */
  const sendCode = async (): Promise<boolean> => {
    const ee = emailError();
    if (ee) { f.set('email', ee); return false; }
    try {
      await authApi.registerCode({
        email: email.trim(),
        ...(invite.trim() ? { invite_code: invite.trim() } : {}),
        locale: mailLocale(locale),
        guard: await guard.build(),
      });
      toast.success(tr('如果这个邮箱可以注册，验证码已经发出'), { description: tr('请查收邮件，也看看垃圾邮件箱') });
      return true;
    } catch (e) {
      showServerError(e);
      return false;
    } finally {
      guard.after();
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phase !== 'idle') return;
    if (!f.check({
      email: emailError(),
      password: !pwd ? tr('请设置密码') : pwd.length < 8 ? tr('密码至少 8 位') : undefined,
      invite: inviteError(),
      code: site.emailVerify && !isCode(code) && tr('请输入 6 位数字验证码'),
    })) return;
    try {
      let pow: { challenge: string; nonce: string } | undefined;
      if (!site.emailVerify) {
        /* 不发验证码时，浏览器替用户做一小份工作量证明（几秒钟），挡住批量注册 */
        setPhase('pow');
        const ch = await authApi.registerChallenge();
        pow = { challenge: ch.challenge, nonce: await solvePow(ch.challenge, ch.bits) };
      }
      setPhase('submit');
      const result = await authApi.register({
        email: email.trim(),
        password: pwd,
        ...(site.emailVerify ? { code: code.trim() } : { pow }),
        ...(invite.trim() ? { invite_code: invite.trim() } : {}),
        locale: mailLocale(locale),
        guard: await guard.build(),
      });
      await signIn(result);
      toast.success(tr('注册成功'), result.trial ? { description: tr('已赠送试用套餐，现在就可以使用') } : undefined);
      nav(R.dashboard, { replace: true });
    } catch (err) {
      showServerError(err);
    } finally {
      guard.after();
      setPhase('idle');
    }
  };

  /* 用通行密钥注册：不填邮箱和密码，账号建好后在弹窗里绑定邮箱（面板：待绑定邮箱状态） */
  const passkeySignup = async () => {
    if (phase !== 'idle') return;
    if (!f.check({ invite: inviteError() })) return;
    try {
      setPhase('pow');
      const ch = await authApi.registerChallenge();
      const pow = { challenge: ch.challenge, nonce: await solvePow(ch.challenge, ch.bits) };
      setPhase('submit');
      const result = await authApi.registerPasskey({
        pow,
        ...(invite.trim() ? { invite_code: invite.trim() } : {}),
        locale: mailLocale(locale),
        guard: await guard.build(),
      });
      await signIn(result);
      toast.success(tr('账号已创建'), { description: tr('接下来请绑定一个邮箱') });
      nav(R.dashboard, { replace: true });
    } catch (err) {
      /* 用户在系统弹窗里点了取消，不算错误 */
      if (isUserCancel(err)) return;
      /* 这条路没有邮箱：signup.unavailable 等不对应任何字段，邀请码的错误除外 */
      const k = fieldOf(err, { 'signup.invalid_invite': 'invite', 'signup.invite_required': 'invite' } as const);
      if (k) f.set(k, errText(err));
      else toast.error(errText(err));
    } finally {
      guard.after();
      setPhase('idle');
    }
  };

  if (site.loading) {
    return <Shell><div className="flex justify-center py-16"><Spinner /></div></Shell>;
  }

  /*
   * 后台关了注册：一进来就把话说死——「网站已暂停注册新用户」。
   * 邀请链接带着邀请码进来也一样——关了就是关了。
   */
  if (!site.registerOpen) {
    return (
      <Shell>
        <Title h="暂停注册" sub={tr('网站已暂停注册新用户。')} />
        <p className="rounded-xl bg-muted/60 px-4 py-3.5 text-[13px] leading-[1.9] text-muted-foreground">
          {tr('目前不接受新账号注册，恢复开放后这里会重新出现注册表单。已有账号的用户不受影响，可以正常登录使用。')}
        </p>
        <Button asChild className="mt-6 h-11 w-full rounded-xl text-[15px]">
          <Link to={R.login}>{tr('登录已有账号')}</Link>
        </Button>
      </Shell>
    );
  }

  const domains = site.emailDomains;
  const busy = phase !== 'idle';

  return (
    <Shell>
      <Title h="创建账号" sub={tr('注册后即可取得订阅链接')} />

      <form noValidate onSubmit={submit} className="relative space-y-5">
        <Field
          {...f.field('email', 'register-email')}
          label={tr('邮箱')} type="email" autoComplete="email" placeholder="you@example.com"
          value={email} onChange={(e) => setEmail(e.target.value)}
          hint={domains.length > 0 && (
            <span className="text-[12px] text-muted-foreground">
              {tr('仅限')} {domains.slice(0, 3).join(' / ')}{domains.length > 3 ? ' …' : ''}
            </span>
          )}
        />

        <div className="space-y-2.5">
          <Field
            {...f.field('password', 'register-password')}
            label={tr('密码')} type="password" autoComplete="new-password"
            placeholder={tr('设置一个安全的密码')}
            value={pwd} onChange={(e) => setPwd(e.target.value)}
          />
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {rules.map((r) => (
              <span
                key={r.label}
                className={cn('flex items-center gap-1.5 text-[12.5px] transition-colors',
                  r.ok ? 'text-success' : 'text-muted-foreground')}
              >
                <Check className={cn('size-3 transition-opacity', r.ok ? 'opacity-100' : 'opacity-35')} />
                {tr(r.label)}
              </span>
            ))}
          </div>
        </div>

        {/* 没强制要求时邀请码也留着：从邀请链接进来的人得有地方填 */}
        <Field
          {...f.field('invite', 'register-invite')}
          label={site.inviteRequired ? tr('邀请码') : tp('{label}（选填）', { label: tr('邀请码') })}
          placeholder={tr('填写邀请码')}
          value={invite} onChange={(e) => setInvite(e.target.value)}
        />

        {site.emailVerify && (
          <CodeField
            id={f.field('code', 'register-code').id} error={f.errors.code}
            value={code} onChange={(v) => { setCode(v); f.dismiss('code'); }} onSend={sendCode} disabled={!guard.ready || guard.unavailable}
          />
        )}

        <GuardFields guard={guard} />

        <Button
          type="submit" disabled={busy || !guard.ready || guard.unavailable}
          className="h-11 w-full rounded-xl text-[15px]"
        >
          {busy && <Spinner size={16} tone="current" />}
          {phase === 'pow' ? tr('正在进行安全校验…') : phase === 'submit' ? tr('创建中') : tr('创建账号')}
        </Button>
        {phase === 'pow' && (
          <p className="text-center text-[12px] text-muted-foreground">{tr('浏览器正在做一次计算来证明你不是机器人，通常只要几秒。')}</p>
        )}

        {site.passkeyRegister && webauthnSupported() && (
          <>
            <Divider />
            <Button
              type="button" variant="outline" onClick={() => void passkeySignup()}
              disabled={busy || !guard.ready || guard.unavailable}
              className="h-11 w-full rounded-xl text-[15px]"
            >
              <KeyRound className="size-4" />
              {tr('用通行密钥注册')}
            </Button>
            <p className="text-center text-[12px] text-muted-foreground">
              {tr('不用设置密码；创建后需要绑定一个邮箱才能使用。')}
            </p>
          </>
        )}

        <p className="text-center text-[12.5px] leading-relaxed text-muted-foreground">
          {tr('注册即表示同意')}
          {site.tosUrl ? (
            <a href={site.tosUrl} target="_blank" rel="noopener noreferrer" className="text-foreground underline-offset-4 hover:underline"> {tr('服务条款')} </a>
          ) : (
            <Link to={R.terms} className="text-foreground underline-offset-4 hover:underline"> {tr('服务条款')} </Link>
          )}
          {tr('与')}
          {site.privacyUrl ? (
            <a href={site.privacyUrl} target="_blank" rel="noopener noreferrer" className="text-foreground underline-offset-4 hover:underline"> {tr('隐私政策')} </a>
          ) : (
            <Link to={R.privacy} className="text-foreground underline-offset-4 hover:underline"> {tr('隐私政策')} </Link>
          )}
        </p>
      </form>

      <p className="mt-8 text-center text-[13.5px] text-muted-foreground">
        {tr('已有账号？')}<Link to={R.login} className="text-brand underline-offset-4 hover:underline">{tr('登录')}</Link>
      </p>
    </Shell>
  );
}

/* ================= 找回密码：申请重置链接 =================
 *
 * 面板的流程是「邮件里的一次性链接（30 分钟）→ 设新密码」，不是验证码。
 * 只有已验证的邮箱才收得到；对任何地址都答 ok，页面也就只能说「如果……就会收到」。
 */
export function Forgot() {
  const tr = useT();
  const errText = useErrorText();
  const nav = useNavigate();
  const site = useSite();
  const guard = useFormGuard('reset');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, run] = usePending();
  const f = useFieldErrors(['email'] as const);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.check({ email: !email.trim() ? tr('请输入邮箱') : !isEmail(email) ? tr('请输入有效的邮箱地址') : undefined })) return;
    run(async () => {
      try {
        await authApi.resetRequest(email.trim(), await guard.build());
        setSent(true);
      } catch (err) {
        if (fieldOf(err, { 'signup.invalid_email': 'email' } as const)) f.set('email', errText(err));
        else toast.error(errText(err));
      } finally {
        guard.after();
      }
    });
  };

  if (!site.loading && !site.resetOpen) {
    return (
      <Shell>
        <Title h="找回密码" sub={tr('本站没有开放自助找回密码。')} />
        <p className="rounded-xl bg-muted/60 px-4 py-3.5 text-[13px] leading-[1.9] text-muted-foreground">
          {tr('请联系站点管理员重置密码。')}
        </p>
        <BackToLogin />
      </Shell>
    );
  }

  if (sent) {
    return (
      <Shell>
        <div className="mb-6 grid size-11 place-items-center rounded-xl bg-brand/10 text-brand"><MailCheck className="size-5" /></div>
        <Title h="查收邮件" sub={tr('如果这个邮箱已注册并验证过，重置链接已经发出，30 分钟内有效。')} />
        <p className="text-[13px] leading-[1.9] text-muted-foreground">
          {tr('没收到的话看看垃圾邮件箱。没有验证过的邮箱收不到重置邮件，请联系管理员。')}
        </p>
        <BackToLogin />
      </Shell>
    );
  }

  return (
    <Shell>
      <Title h="找回密码" sub={tr('填写登录邮箱，我们会把重置链接发给你。')} />
      <form noValidate onSubmit={submit} className="relative space-y-5">
        <Field
          {...f.field('email', 'forgot-email')}
          label={tr('邮箱')} type="email" autoComplete="email" placeholder="you@example.com"
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <GuardFields guard={guard} />
        <Button type="submit" disabled={loading || !guard.ready || guard.unavailable} className="h-11 w-full rounded-xl text-[15px]">
          {loading && <Spinner size={16} tone="current" />}
          {loading ? tr('提交中') : tr('发送重置链接')}
        </Button>
      </form>
      <button
        onClick={() => nav(R.login)}
        className="mt-7 flex w-full items-center justify-center gap-1.5 text-[13.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />{tr('返回登录')}
      </button>
    </Shell>
  );
}

function BackToLogin() {
  const tr = useT();
  return (
    <Button asChild variant="outline" className="mt-6 h-11 w-full rounded-xl text-[15px] shadow-none">
      <Link to={R.login}>{tr('返回登录')}</Link>
    </Button>
  );
}

/* ================= 按邮件链接设新密码 =================
 *
 * 邮件里的链接是 …/reset#token=…：令牌放在 # 后面，不会出现在服务器日志和 Referer 里。
 * 设好之后这个账户所有的会话都会结束，需要重新登录。
 */
export function Reset() {
  const tr = useT();
  const errText = useErrorText();
  const nav = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') ?? '');
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, run] = usePending();
  const f = useFieldErrors(['pwd', 'confirm'] as const);

  /* 令牌读到之后就从地址栏抹掉，免得被截图、被浏览器历史同步走 */
  useEffect(() => {
    if (window.location.hash) history.replaceState(history.state, '', window.location.pathname + window.location.search);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.check({
      pwd: !pwd ? tr('请输入新密码') : pwd.length < 8 ? tr('新密码至少 8 位') : undefined,
      confirm: !confirm ? tr('请再次输入新密码') : confirm !== pwd ? tr('两次输入的新密码不一致') : undefined,
    })) return;
    run(async () => {
      try {
        await authApi.reset(token, pwd);
        toast.success(tr('密码已重置，请用新密码登录'), { description: tr('所有设备上的登录都已结束') });
        nav(R.login, { replace: true });
      } catch (err) {
        const k = fieldOf(err, { 'account.password_too_short': 'pwd', 'account.password_too_long': 'pwd' } as const);
        if (k) f.set(k, errText(err));
        else toast.error(errText(err));
      }
    });
  };

  if (!token) {
    return (
      <Shell>
        <Title h="链接无效" sub={tr('这个重置链接不完整或已经用过了。')} />
        <Button asChild className="mt-2 h-11 w-full rounded-xl text-[15px]">
          <Link to={R.forgot}>{tr('重新申请重置')}</Link>
        </Button>
      </Shell>
    );
  }

  return (
    <Shell>
      <Title h="设置新密码" sub={tr('设好之后，所有设备上的登录都会结束。')} />
      <form noValidate onSubmit={submit} className="space-y-5">
        <Field
          {...f.field('pwd', 'reset-password')}
          label={tr('新密码')} type="password" autoComplete="new-password" help={tr('至少 8 位')}
          value={pwd} onChange={(e) => setPwd(e.target.value)}
        />
        <Field
          {...f.field('confirm', 'reset-confirm')}
          label={tr('确认新密码')} type="password" autoComplete="new-password" placeholder={tr('再次输入新密码')}
          value={confirm} onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => { if (confirm && confirm !== pwd) f.set('confirm', tr('两次输入的新密码不一致'), false); }}
        />
        <Button type="submit" disabled={loading} className="h-11 w-full rounded-xl text-[15px]">
          {loading && <Spinner size={16} tone="current" />}
          {loading ? tr('提交中') : tr('重置密码')}
        </Button>
      </form>
    </Shell>
  );
}

/**
 * 注销之后的结果页（公开：会话已被面板清掉）。注销那一步把「是否匿名化保留」放在路由 state 里；
 * 刷新后 state 没了，就只说账户已注销。
 */
export function AccountDeleted() {
  const tr = useT();
  const { state } = useLocation() as { state: { anonymized?: boolean } | null };
  const anonymized = state?.anonymized;
  return (
    <Shell>
      <Title
        h="账户已注销"
        sub={anonymized === true
          ? tr('你的个人数据已删除；付款与退款记录按法规匿名保留，不再与你关联。')
          : anonymized === false
            ? tr('你的账户和个人数据已全部删除。')
            : tr('你的账户已注销，所有设备上的登录都已结束。')}
      />
      <p className="mb-6 text-[13.5px] leading-[1.8] text-muted-foreground">
        {tr('这个邮箱以后可以重新注册，但原来的套餐、余额和记录不会回来。')}
      </p>
      <Button asChild className="h-11 w-full rounded-xl text-[15px]">
        <Link to={R.login} replace>{tr('返回登录页')}</Link>
      </Button>
    </Shell>
  );
}
