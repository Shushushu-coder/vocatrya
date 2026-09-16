export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh-CN";

export const LOCALE_COOKIE_NAME = "vocatrya_locale";
export const LOCALE_STORAGE_KEY = "vocatrya-locale-preference";

export const LOCALE_LABELS: Record<Locale, string> = {
  "zh-CN": "中文",
  en: "EN",
};

export function isValidLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function normalizeLocale(value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
  if (isValidLocale(value)) {
    return value;
  }
  return fallback;
}
