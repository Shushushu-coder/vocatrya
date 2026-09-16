"use client";

import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

interface LanguageSwitcherProps {
  className?: string;
}

export function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n();

  return (
    <div
      role="group"
      aria-label={t("common.switchLanguage")}
      className={cn(
        "inline-flex items-center rounded-md border bg-muted/60 p-0.5 text-xs font-medium text-muted-foreground",
        className
      )}
    >
      <button
        type="button"
        onClick={() => setLocale("zh-CN")}
        aria-label="切换到简体中文"
        aria-pressed={locale === "zh-CN"}
        className={cn(
          "rounded px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          locale === "zh-CN"
            ? "bg-background text-foreground shadow-xs font-semibold"
            : "hover:text-foreground"
        )}
      >
        中文
      </button>
      <span className="text-muted-foreground/30 text-[10px]" aria-hidden="true">
        |
      </span>
      <button
        type="button"
        onClick={() => setLocale("en")}
        aria-label="Switch to English"
        aria-pressed={locale === "en"}
        className={cn(
          "rounded px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          locale === "en"
            ? "bg-background text-foreground shadow-xs font-semibold"
            : "hover:text-foreground"
        )}
      >
        EN
      </button>
    </div>
  );
}
