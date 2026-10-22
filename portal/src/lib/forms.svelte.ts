import { tick } from 'svelte';
import { ApiError } from '@/api';

/**
 * 表单的内联错误（components/TextField 画出来；与 React 门户 spa/src/lib/form-errors.ts 相同的规则）。
 *
 *   const f = new FieldErrors(['email', 'password'] as const);
 *   if (!f.check({ email: !isEmail(email) && t('请输入有效的邮箱地址'), password: … })) return;  // 有错：显示并聚焦第一个
 *   <TextField {...f.field('email', 'x-email')} … />
 *
 * 字段的顺序就是聚焦的顺序。用户一改那个字段，它的错误就消失（不必等下次提交）。
 */
export class FieldErrors<K extends string> {
  errors = $state<Partial<Record<K, string>>>({});
  #ids = new Map<K, string>();
  #order: readonly K[];

  constructor(order: readonly K[]) {
    this.#order = order;
  }

  #focus(k: K) {
    const id = this.#ids.get(k);
    if (id) void tick().then(() => requestAnimationFrame(() => document.getElementById(id)?.focus()));
  }

  /** 设好全部错误（false / '' / undefined = 没错）；有错时聚焦第一个并返回 false */
  check(next: Partial<Record<K, string | false | undefined | null>>): boolean {
    const clean: Partial<Record<K, string>> = {};
    for (const k of this.#order) if (next[k]) clean[k] = next[k] as string;
    this.errors = clean;
    const first = this.#order.find((k) => clean[k]);
    if (first) { this.#focus(first); return false; }
    return true;
  }

  /** 某个字段的错误（服务端错误码、失焦时的比对）：显示，默认并聚焦它 */
  set(k: K, msg: string, andFocus = true) {
    this.errors = { ...this.errors, [k]: msg };
    if (andFocus) this.#focus(k);
  }

  /** 清掉一个字段的错误（用户改了它） */
  dismiss(k: K) {
    if (this.errors[k]) this.errors = { ...this.errors, [k]: undefined };
  }

  /** 给 TextField 的属性：id、error，输入时清掉自己的错误 */
  field(k: K, id: string) {
    this.#ids.set(k, id);
    return { id, error: this.errors[k], oninput: () => this.dismiss(k) };
  }
}

/** 够用的邮箱格式检查（真正的校验在面板） */
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** 六位数字验证码 */
export const isCode = (s: string) => /^\d{6}$/.test(s.trim());

/** 输入框里只留数字（验证码），最多 n 位 */
export const digits = (s: string, n = 6) => s.replace(/\D/g, '').slice(0, n);

/** 服务端错误码对应的字段（没有就是 undefined：交给提示条） */
export function fieldOf<K extends string>(err: unknown, map: Partial<Record<string, K>>): K | undefined {
  return err instanceof ApiError ? map[err.code] : undefined;
}

/** 一个异步动作是否在进行中（按钮转圈、防止连点）：`busy.run(async () => …)` */
export class Pending {
  busy = $state(false);
  async run(fn: () => Promise<unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await fn(); } finally { this.busy = false; }
  }
}

/** 截止时间戳式的倒计时（发码后 60 秒才能再发）：按截止时间算，不按剩余秒数递减，标签页挂后台回来也准 */
export class Countdown {
  left = $state(0);
  #timer: ReturnType<typeof setInterval> | undefined;

  start(secs = 60) {
    const until = Date.now() + secs * 1000;
    clearInterval(this.#timer);
    const tick = () => {
      this.left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      if (this.left === 0) clearInterval(this.#timer);
    };
    this.#timer = setInterval(tick, 250);
    tick();
  }

  stop() {
    clearInterval(this.#timer);
  }
}
