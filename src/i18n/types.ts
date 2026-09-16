import type { Locale } from "./config";
import zhCNMessages from "./messages/zh-CN.json";

export type Messages = typeof zhCNMessages;

export type TranslationParams = Record<string, string | number>;

export type TranslateFn = (key: string, params?: TranslationParams) => string;

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TranslateFn;
  formatDate: (
    date: Date | string | number | null | undefined,
    options?: Intl.DateTimeFormatOptions
  ) => string;
  formatMonthYear: (date: Date | string | number | null | undefined) => string;
  formatDateTime: (
    date: Date | string | number | null | undefined,
    options?: Intl.DateTimeFormatOptions
  ) => string;
  formatNumber: (
    num: number | null | undefined,
    options?: Intl.NumberFormatOptions
  ) => string;
}
