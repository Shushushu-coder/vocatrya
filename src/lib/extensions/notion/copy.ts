import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "@/i18n/config";
import en from "@/i18n/messages/en.json";
import zhCN from "@/i18n/messages/zh-CN.json";

const COPY = { en: en.extensions.notion.detail, "zh-CN": zhCN.extensions.notion.detail };

export type NotionCopyKey = keyof (typeof COPY)["zh-CN"];

export function notionCopy(locale: Locale | string): Record<NotionCopyKey, string> {
  const normalized = normalizeLocale(locale, DEFAULT_LOCALE);
  return COPY[normalized] as Record<NotionCopyKey, string>;
}

export function notionT(
  locale: Locale | string,
  key: NotionCopyKey,
): string {
  return notionCopy(locale)[key] ?? COPY["zh-CN"][key] ?? key;
}
