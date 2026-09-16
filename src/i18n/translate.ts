import type { Locale } from "./config";
import type { TranslationParams } from "./types";
import zhCN from "./messages/zh-CN.json";
import en from "./messages/en.json";

const MESSAGES_BY_LOCALE: Record<Locale, unknown> = {
  "zh-CN": zhCN,
  en,
};

function resolveKeyPath(obj: unknown, path: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

export function translate(
  locale: Locale,
  key: string,
  params?: TranslationParams
): string {
  const currentMessages = MESSAGES_BY_LOCALE[locale];
  let text = resolveKeyPath(currentMessages, key);

  if (text === undefined && locale !== "en") {
    text = resolveKeyPath(MESSAGES_BY_LOCALE.en, key);
  }

  if (text === undefined) {
    return key;
  }

  if (params && Object.keys(params).length > 0) {
    return text.replace(/\{(\w+)\}/g, (_, placeholder: string) => {
      return params[placeholder] !== undefined
        ? String(params[placeholder])
        : `{${placeholder}}`;
    });
  }

  return text;
}

export function hasTranslation(locale: Locale, key: string): boolean {
  return resolveKeyPath(MESSAGES_BY_LOCALE[locale], key) !== undefined;
}
