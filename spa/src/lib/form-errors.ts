import { useCallback, useState } from 'react';
import { ApiError } from '@/api';

/**
 * 表单的内联错误（components/text-field 画出来）。
 *
 *   const f = useFieldErrors(['email', 'password']);
 *   if (!f.check({ email: !isEmail(email) && tr('请输入有效的邮箱地址'), password: … })) return;   // 有错：显示并聚焦第一个
 *   <TextField id="x-email" {...f.field('email', 'x-email')} … />
 *
 * 字段的顺序就是聚焦的顺序。用户一改那个字段，它的错误就消失（不必等下次提交）。
 */
export function useFieldErrors<K extends string>(order: readonly K[]) {
  const [errors, setErrors] = useState<Partial<Record<K, string>>>({});
  const [ids] = useState(() => new Map<K, string>());

  const focus = useCallback((k: K) => {
    const id = ids.get(k);
    if (id) requestAnimationFrame(() => document.getElementById(id)?.focus());
  }, [ids]);

  /** 设好全部错误（false / '' / undefined = 没错）；有错时聚焦第一个并返回 false */
  const check = useCallback((next: Partial<Record<K, string | false | undefined | null>>): boolean => {
    const clean: Partial<Record<K, string>> = {};
    for (const k of order) if (next[k]) clean[k] = next[k] as string;
    setErrors(clean);
    const first = order.find((k) => clean[k]);
    if (first) { focus(first); return false; }
    return true;
  }, [order, focus]);

  /** 某个字段的错误（服务端错误码、失焦时的比对）：显示，默认并聚焦它 */
  const set = useCallback((k: K, msg: string, andFocus = true) => {
    setErrors((e) => ({ ...e, [k]: msg }));
    if (andFocus) focus(k);
  }, [focus]);

  const clear = useCallback(() => setErrors({}), []);

  /** 清掉一个字段的错误（用户改了它） */
  const dismiss = useCallback((k: K) => setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e)), []);

  /** 登记字段的输入框 id（聚焦用）；不经 field() 渲染的输入（HolderConfirm 的密码框）用它 */
  const register = (k: K, id: string) => { ids.set(k, id); };

  /** 给 TextField 的属性：id、error，输入时清掉自己的错误 */
  const field = (k: K, id: string) => {
    ids.set(k, id);
    return { id, error: errors[k], onInput: () => dismiss(k) };
  };

  return { errors, check, set, clear, dismiss, register, field };
}

/** 够用的邮箱格式检查（真正的校验在面板） */
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** 六位数字验证码 */
export const isCode = (s: string) => /^\d{6}$/.test(s.trim());

/** 输入框里只留数字（验证码），最多 n 位 */
export const digits = (s: string, n = 6) => s.replace(/\D/g, '').slice(0, n);

/** 服务端错误码对应的字段（没有就是 undefined：交给 toast） */
export function fieldOf<K extends string>(err: unknown, map: Partial<Record<string, K>>): K | undefined {
  return err instanceof ApiError ? map[err.code] : undefined;
}
