import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  DEFAULT_LOCALE,
  I18nProvider,
  LOCALE_COOKIE_NAME,
  LOCALE_STORAGE_KEY,
  hasTranslation,
  isValidLocale,
  normalizeLocale,
  translate,
  useI18n,
} from "@/i18n";
import { formatDate } from "@/i18n/formatters";
import { buildAgentChatSystemPrompt } from "@/lib/agent/prompt";
import zhCN from "@/i18n/messages/zh-CN.json";
import en from "@/i18n/messages/en.json";

function leafKeys(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") return leafKeys(value, path);
    return [path];
  });
}

function Probe({ testId = "locale" }: { testId?: string }) {
  const { locale, t } = useI18n();
  return (
    <div>
      <span data-testid={testId}>{locale}</span>
      <span data-testid={`${testId}-nav`}>{t("nav.dashboard")}</span>
    </div>
  );
}

function Switcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="label">{t("nav.jobs")}</span>
      <button type="button" onClick={() => setLocale("en")}>
        to-en
      </button>
      <button type="button" onClick={() => setLocale("zh-CN")}>
        to-zh
      </button>
      <button type="button" onClick={() => setLocale("fr" as never)}>
        to-invalid
      </button>
    </div>
  );
}

describe("i18n locale contract", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = `${LOCALE_COOKIE_NAME}=; path=/; max-age=0`;
  });

  it("defaults to zh-CN", () => {
    expect(DEFAULT_LOCALE).toBe("zh-CN");
    expect(normalizeLocale(undefined)).toBe("zh-CN");
    expect(normalizeLocale(null)).toBe("zh-CN");
  });

  it("accepts only zh-CN and en", () => {
    expect(isValidLocale("zh-CN")).toBe(true);
    expect(isValidLocale("en")).toBe(true);
    expect(isValidLocale("fr")).toBe(false);
    expect(isValidLocale("zh")).toBe(false);
    expect(isValidLocale("")).toBe(false);
  });

  it("falls back to default on invalid locale", () => {
    expect(normalizeLocale("fr")).toBe("zh-CN");
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale(123)).toBe("zh-CN");
  });

  it("switches zh-CN to en and back", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="zh-CN">
        <Switcher />
      </I18nProvider>
    );

    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
    expect(screen.getByTestId("label")).toHaveTextContent("我的职位");

    await user.click(screen.getByText("to-en"));
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(screen.getByTestId("label")).toHaveTextContent("Jobs");

    await user.click(screen.getByText("to-zh"));
    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
    expect(screen.getByTestId("label")).toHaveTextContent("我的职位");
  });

  it("invalid setLocale falls back to zh-CN", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Switcher />
      </I18nProvider>
    );

    await user.click(screen.getByText("to-invalid"));
    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
  });

  it("persists preference to cookie and localStorage", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="zh-CN">
        <Switcher />
      </I18nProvider>
    );

    await user.click(screen.getByText("to-en"));
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=en`);
  });
});

describe("translation key resolution", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = `${LOCALE_COOKIE_NAME}=; path=/; max-age=0`;
  });

  it("resolves nested keys with interpolation", () => {
    expect(translate("en", "nav.dashboard")).toBe("Dashboard");
    expect(translate("zh-CN", "nav.dashboard")).toBe("概览");
    expect(translate("en", "automations.matchThreshold", { value: 70 })).toContain("70");
    expect(translate("zh-CN", "automations.matchThreshold", { value: 70 })).toContain("70");
  });

  it("returns the key when missing, and falls back to English", () => {
    expect(translate("en", "does.not.exist")).toBe("does.not.exist");
    expect(hasTranslation("en", "nav.dashboard")).toBe(true);
    expect(hasTranslation("zh-CN", "does.not.exist")).toBe(false);
  });

  it("keeps en and zh-CN message trees in sync", () => {
    const enKeys = leafKeys(en).sort();
    const zhKeys = leafKeys(zhCN).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("renders provider initialLocale on first paint", () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <Probe />
      </I18nProvider>
    );
    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
    expect(screen.getByTestId("locale-nav")).toHaveTextContent("概览");
  });
});

describe("locale-aware formatters", () => {
  it("formats dates for zh-CN and en without changing the source value", () => {
    const date = new Date("2026-09-16T12:00:00Z");
    const zh = formatDate(date, "zh-CN");
    const english = formatDate(date, "en");
    expect(zh).toMatch(/2026/);
    expect(english).toMatch(/2026/);
    expect(english).toMatch(/Sep/i);
  });
});

describe("agent prompt locale preference", () => {
  it("instructs Simplified Chinese replies for zh-CN", () => {
    const prompt = buildAgentChatSystemPrompt("zh-CN");
    expect(prompt).toContain("Simplified Chinese");
    expect(prompt).toContain("unless the user explicitly requests another language");
    expect(prompt).not.toContain("Reply in English by default");
  });

  it("instructs English replies for en", () => {
    const prompt = buildAgentChatSystemPrompt("en");
    expect(prompt).toContain("Reply in English by default");
    expect(prompt).toContain("unless the user explicitly requests another language");
    expect(prompt).not.toContain("Simplified Chinese");
  });

  it("defaults to Chinese when locale is omitted", () => {
    expect(buildAgentChatSystemPrompt()).toContain("Simplified Chinese");
  });
});
