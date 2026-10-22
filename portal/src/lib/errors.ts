import { ApiError } from '@/api';
import { CODE_KEYS, ERRORS, type ErrorKey } from '@/i18n/errors';
import { t } from './i18n.svelte';

/**
 * 失败请求给用户看的一句话（与 React 门户 spa/src/lib/errors.ts 相同）。全站的提示条、区块报错都经过这里，不直接显示 e.message。
 *   · 面板错误：按 code 查 `errors.*` 文案（共用 spa/src/i18n/errors.ts），用 params 填占位符；
 *   · 没有 code 的：按状态码给通用说法（401 登录失效、429 太频繁、5xx 服务器出错……）；
 *   · fetch 本身失败（断网）：TypeError。
 */
type Vars = Record<string, string | number>;

/** 错误的占位符：params 原样，外加每个 `<p>_cents` 的 `<p>_yuan` */
export function errorVars(params: ApiError['params']): Vars {
  const vars: Vars = {};
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    vars[k] = typeof v === 'number' ? v : String(v);
    if (k.endsWith('_cents') && typeof v === 'number') {
      const yuan = (v / 100).toFixed(2);
      vars[`${k.slice(0, -'_cents'.length)}_yuan`] = yuan;
      vars[`${k}_yuan`] = yuan;
    }
  }
  return vars;
}

function message(key: ErrorKey, vars: Vars = {}): string {
  return t(ERRORS[key]).replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] !== undefined ? String(vars[k]) : m));
}

export function errorText(err: unknown): string {
  if (!(err instanceof ApiError)) {
    if (err instanceof TypeError) return message('errors.network');
    return message('errors.generic');
  }
  const key = CODE_KEYS[err.code];
  if (key) return message(key, errorVars(err.params));
  if (err.status === 401) return message('errors.unauthorized');
  if (err.status === 403) return message('errors.forbidden');
  if (err.status === 404) return message('errors.notFound');
  if (err.status === 429) return message('errors.tooMany');
  if (err.status >= 500) return message('errors.server');
  return message('errors.generic');
}
