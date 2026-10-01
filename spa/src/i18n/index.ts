// Public i18n API (implementation in core.ts; usage notes there and in
// spa/CLAUDE.md "i18n").
export { FixedLocale, LOCALES, detectLocale, setLocale, translate, useHtmlLang, useLocale, useT } from "./core";
export { LocaleSwitch } from "./locale-switch";
export type { Locale, MessageKey, TFunction, Vars } from "./types";
