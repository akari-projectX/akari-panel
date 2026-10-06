import { useCallback } from 'react';
import { ApiError } from '@/api';
import { CODE_KEYS, ERRORS, type ErrorKey } from '@/i18n/errors';
import { translate, useLocale, type Locale } from '@/i18n';

/**
 * 失败请求给用户看的一句话。全站的 toast、区块报错都经过这里，不直接显示 e.message。
 *   · 面板错误：按 code 查 `errors.*` 文案，用 params 填占位符；
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

export function errorMessage(key: ErrorKey, locale: Locale, vars: Vars = {}): string {
  const text = translate(locale, ERRORS[key]);
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] !== undefined ? String(vars[k]) : m));
}

export function errorText(err: unknown, locale: Locale): string {
  if (!(err instanceof ApiError)) {
    if (err instanceof TypeError) return errorMessage('errors.network', locale);
    return errorMessage('errors.generic', locale);
  }
  const key = CODE_KEYS[err.code];
  if (key) return errorMessage(key, locale, errorVars(err.params));
  if (err.status === 401) return errorMessage('errors.unauthorized', locale);
  if (err.status === 403) return errorMessage('errors.forbidden', locale);
  if (err.status === 404) return errorMessage('errors.notFound', locale);
  if (err.status === 429) return errorMessage('errors.tooMany', locale);
  if (err.status >= 500) return errorMessage('errors.server', locale);
  return errorMessage('errors.generic', locale);
}

/** 组件里用：const errText = useErrorText(); toast.error(errText(e)) */
export function useErrorText() {
  const { locale } = useLocale();
  return useCallback((err: unknown) => errorText(err, locale), [locale]);
}
