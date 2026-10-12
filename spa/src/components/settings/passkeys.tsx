import { useState } from 'react';
import { Fingerprint, MoreHorizontal, Pencil, Plus, RotateCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/panels';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Sk } from '@/components/loading';
import { SettingRow } from '@/components/settings/setting-row';
import { passkeyApi, type LoginMethods, type PasskeyItem } from '@/api';
import { isUserCancel, webauthnSupported } from '@/api/webauthn';
import { usePending, type ApiState } from '@/hooks/use-api';
import { useErrorText } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { defaultPasskeyName } from '@/lib/passkey-name';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useT, useTp } from '@/i18n';

/**
 * 通行密钥：头部（名称、说明、「添加」）始终完整，加载 / 出错只替换下面的列表。
 *   · 每行：名称 + 「添加于 · 最近使用」（日期不折行）；桌面行尾两个图标按钮，手机收进「⋯」菜单。
 *   · 重命名就地编辑：「保存」「取消」，空名称不能保存并说明。
 *   · 删除走确认弹窗：写明设备里那一份要自己删；删的是最后一个当前可用的密钥、又开着「只用通行密钥」时，说明它会随之失效。
 *   · 属于旧域名的行（站点换过主域名）置灰并说明已不能在本站登录，只能删除。
 *   · 添加按钮不会凭空消失：到上限、浏览器不支持时置灰并说明原因。
 */
export function PasskeyList({ methods }: { methods: ApiState<LoginMethods> }) {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const [adding, runAdd] = usePending();
  const [busy, runBusy] = usePending();
  const [editing, setEditing] = useState<{ id: string; name: string; error?: string } | null>(null);
  const [removing, setRemoving] = useState<PasskeyItem | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const m = methods.data;
  const supported = webauthnSupported();
  const items = m?.passkeys ?? [];
  const current = items.filter((k) => k.current).length;
  const full = !!m && items.length >= m.max;

  const add = () => runAdd(async () => {
    try {
      await passkeyApi.add(defaultPasskeyName());
      methods.reload();
      toast.success(tr('通行密钥已添加'), { description: tr('以后可以直接用它登录') });
    } catch (e) {
      if (!isUserCancel(e)) toast.error(errText(e));
    }
  });

  const saveName = () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setEditing({ ...editing, error: tr('名称不能为空') }); return; }
    runBusy(async () => {
      try {
        await passkeyApi.rename(editing.id, name);
        setEditing(null);
        methods.reload();
      } catch (e) {
        setEditing((v) => (v ? { ...v, error: errText(e) } : v));
      }
    });
  };

  const remove = () => runBusy(async () => {
    if (!removing) return;
    setRemoveError(null);
    try {
      await passkeyApi.remove(removing.id);
      methods.reload();
      toast.success(tr('通行密钥已删除'), { description: tr('设备里保存的那一份需要在设备上自行删除') });
    } catch (e) {
      setRemoveError(errText(e));
      throw e;
    }
  });

  const lastCurrent = !!removing?.current && current === 1 && !!m?.password_login_disabled;

  const actions = (k: PasskeyItem) => (
    <>
      {/* 桌面：两个图标按钮 */}
      <div className="hidden items-center gap-0.5 sm:flex">
        {k.current && (
          <Button variant="ghost" size="icon-sm" aria-label={tp('重命名 {n}', { n: k.name })} title={tr('重命名')} onClick={() => setEditing({ id: k.id, name: k.name })}>
            <Pencil />
          </Button>
        )}
        <Button
          variant="ghost" size="icon-sm" aria-label={tp('删除 {n}', { n: k.name })} title={tr('删除')} disabled={busy}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => { setRemoveError(null); setRemoving(k); }}
        >
          <Trash2 />
        </Button>
      </div>
      {/* 手机：收进「⋯」 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="sm:hidden" aria-label={tp('{n} 的操作', { n: k.name })}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          {k.current && (
            <DropdownMenuItem onSelect={() => setEditing({ id: k.id, name: k.name })}><Pencil />{tr('重命名')}</DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onSelect={() => { setRemoveError(null); setRemoving(k); }}><Trash2 />{tr('删除')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <div className="set-row set-row-block">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 max-w-[52ch]">
          <div className="set-row-t">{tr('通行密钥')}</div>
          <div className="set-row-d">
            {!m ? tr('用 Face ID、指纹或 Windows Hello 登录，不用输密码。')
              : m.available
                ? tp('用 Face ID、指纹或 Windows Hello 登录，不用输密码。每个账户最多 {n} 个。', { n: m.max })
                : tr('本站暂不支持通行密钥（需要 https 主域名）。')}
          </div>
        </div>
        {(!m || m.available) && (
          <div className="flex flex-col items-end gap-1.5">
            <Button className="h-9" disabled={!m || adding || full || !supported} onClick={add}>
              <Plus />{adding ? tr('等待设备验证…') : tr('添加通行密钥')}
            </Button>
            {m && full && <span className="text-[12px] text-muted-foreground">{tp('已达上限 {n} 个', { n: m.max })}</span>}
            {m && !supported && <span className="max-w-[28ch] text-right text-[12px] text-muted-foreground">{tr('当前浏览器不支持通行密钥，请换用新版 Safari、Chrome 或 Edge。')}</span>}
          </div>
        )}
      </div>

      <div className="mt-4">
        {methods.loading && !m ? (
          <div aria-busy className="space-y-3 py-1">
            <Sk className="h-[13px] w-1/3" /><Sk className="h-[11px] w-1/2" d={0.05} />
          </div>
        ) : methods.error && !m ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3 text-[13px]">
            <span>{errText(methods.error)}</span>
            <Button size="sm" variant="outline" onClick={methods.reload}><RotateCw className="size-3.5" />{tr('重试')}</Button>
          </div>
        ) : items.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{tr('还没有通行密钥。添加后，登录页点「使用通行密钥登录」就能直接进来。')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((k) => (
              <li key={k.id} className={cn('flex items-start gap-3 py-3', !k.current && 'text-muted-foreground')}>
                <span className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted', !k.current && 'opacity-60')}>
                  <Fingerprint className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  {editing?.id === k.id ? (
                    <form noValidate onSubmit={(e) => { e.preventDefault(); saveName(); }} className="space-y-1.5">
                      <div className="flex flex-wrap gap-2">
                        <Input
                          aria-label={tr('通行密钥名称')} autoFocus maxLength={64} value={editing.name} className="h-9 max-w-[260px] flex-1"
                          aria-invalid={editing.error ? true : undefined} aria-describedby={editing.error ? `pk-name-${k.id}` : undefined}
                          onChange={(e) => setEditing({ id: k.id, name: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
                        />
                        <Button type="submit" size="sm" className="h-9" disabled={busy || !editing.name.trim()}>{tr('保存')}</Button>
                        <Button type="button" size="sm" variant="ghost" className="h-9" onClick={() => setEditing(null)}>{tr('取消')}</Button>
                      </div>
                      {editing.error && <p id={`pk-name-${k.id}`} role="alert" className="state-in text-[12.5px] text-danger">{editing.error}</p>}
                    </form>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-foreground">
                        <span className={cn('min-w-0 break-words', !k.current && 'opacity-60')}>{k.name}</span>
                        {!k.current && <Badge variant="secondary" className="rounded-full bg-muted text-muted-foreground">{tr('属于旧域名')}</Badge>}
                      </div>
                      {k.current ? (
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12.5px] text-muted-foreground">
                          <span className="whitespace-nowrap">{tp('添加于 {d}', { d: formatDate(k.created_at) })}</span>
                          <span className="whitespace-nowrap">{k.last_used_at ? tp('最近使用 {d}', { d: formatDateTime(k.last_used_at) }) : tr('还没用它登录过')}</span>
                        </div>
                      ) : (
                        <p className="mt-0.5 text-[12.5px] leading-[1.6]">{tr('站点换过域名，这个通行密钥已不能在本站登录，可以删除。')}</p>
                      )}
                    </>
                  )}
                </div>
                {editing?.id !== k.id && <div className="shrink-0">{actions(k)}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => { if (!o) setRemoving(null); }}
        tone="danger"
        icon={<Trash2 />}
        title={removing ? tp('删除通行密钥「{n}」？', { n: removing.name }) : ''}
        consequences={[
          tr('以后不能再用它登录本站'),
          tr('设备里保存的那一份需要在设备上自行删除'),
          ...(lastCurrent ? [tr('这是最后一个可用的通行密钥：「只用通行密钥登录」会随之失效，恢复为可以用密码登录')] : []),
        ]}
        confirmLabel={busy ? tr('删除中') : tr('删除')}
        pending={busy}
        error={removeError}
        onConfirm={remove}
      />
    </div>
  );
}

/**
 * 「只用通行密钥登录」：开关紧贴说明。打开前确认（它决定还能不能用密码登录）；关掉直接生效。
 * 关掉密码登录前必须有一个当前可用的通行密钥（面板 409 account.passkey_required）。
 */
export function PasskeyOnly({ methods }: { methods: ApiState<LoginMethods> }) {
  const tr = useT();
  const errText = useErrorText();
  const [busy, run] = usePending();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = methods.data;
  if (!m || !m.available || !m.password_set) return null;
  const current = m.passkeys.filter((k) => k.current).length;

  const set = (only: boolean) => run(async () => {
    setError(null);
    try {
      methods.setData(await passkeyApi.setPasswordLogin(!only));
      toast.success(only ? tr('已改为只用通行密钥登录') : tr('已恢复密码登录'));
    } catch (e) {
      if (only) { setError(errText(e)); throw e; }
      toast.error(errText(e));
    }
  });

  return (
    <SettingRow
      title={<label htmlFor="passkey-only">{tr('只用通行密钥登录')}</label>}
      desc={current === 0
        ? tr('先添加一个通行密钥，才能关闭密码登录。')
        : !m.password_login && !m.password_login_disabled
          ? tr('站点要求这个账户只用通行密钥登录。')
          : tr('打开后不能再用密码登录。通行密钥全部丢失时，需要联系管理员恢复。')}
    >
      <Switch
        id="passkey-only"
        checked={m.password_login_disabled}
        disabled={busy || current === 0}
        onCheckedChange={(on) => { if (on) { setError(null); setAsking(true); } else void set(false); }}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        tone="warning"
        icon={<ShieldCheck />}
        title={tr('只用通行密钥登录？')}
        consequences={[
          tr('密码登录随即关闭，登录页只能用通行密钥'),
          tr('通行密钥全部丢失时，需要联系管理员恢复'),
          tr('随时可以在这里改回来'),
        ]}
        confirmLabel={busy ? tr('提交中') : tr('确认开启')}
        pending={busy}
        error={error}
        onConfirm={() => set(true)}
      />
    </SettingRow>
  );
}
