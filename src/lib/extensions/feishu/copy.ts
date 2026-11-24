import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "@/i18n/config";
import en from "@/i18n/messages/en.json";
import zhCN from "@/i18n/messages/zh-CN.json";

const COPY = {
  en: en.extensions.feishu.detail,
  "zh-CN": zhCN.extensions.feishu.detail,
};

export type FeishuCopyKey = keyof (typeof COPY)["zh-CN"];

export function feishuCopy(
  locale: Locale | string,
): Record<FeishuCopyKey, string> {
  const normalized = normalizeLocale(locale, DEFAULT_LOCALE);
  return COPY[normalized] as Record<FeishuCopyKey, string>;
}

export function feishuT(locale: Locale | string, key: FeishuCopyKey): string {
  return feishuCopy(locale)[key] ?? COPY["zh-CN"][key] ?? key;
}
