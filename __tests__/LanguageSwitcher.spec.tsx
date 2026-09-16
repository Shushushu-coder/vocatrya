import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { I18nProvider } from "@/i18n";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

describe("LanguageSwitcher", () => {
  it("marks the current locale and is keyboard accessible", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="zh-CN">
        <LanguageSwitcher />
      </I18nProvider>
    );

    const group = screen.getByRole("group", { name: "切换语言" });
    expect(group).toBeInTheDocument();

    const zh = screen.getByRole("button", { name: "切换到简体中文" });
    const en = screen.getByRole("button", { name: "Switch to English" });
    expect(zh).toHaveAttribute("aria-pressed", "true");
    expect(en).toHaveAttribute("aria-pressed", "false");

    await user.click(en);
    expect(en).toHaveAttribute("aria-pressed", "true");
    expect(zh).toHaveAttribute("aria-pressed", "false");
  });
});
