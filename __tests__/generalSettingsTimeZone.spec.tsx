// P-TZ: the General time-zone preference renders the persisted
// settings.general.timeZone (or "follow system" when unset/dirty),
// persists picks through updateSettingsTimeZone — undefined for
// follow-system — and reports failure honestly with a guarded rollback.
// Writes share the card's serial pump with locale, so the newest intent
// always lands last.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { I18nProvider, type Locale } from "@/i18n";
import GeneralSettings from "@/components/settings/GeneralSettings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const getUserSettings = vi.fn();
const updateSettingsLocale = vi.fn();
const updateSettingsTimeZone = vi.fn();
vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: (...args: unknown[]) => getUserSettings(...args),
  updateSettingsLocale: (...args: unknown[]) =>
    updateSettingsLocale(...args),
  updateSettingsTimeZone: (...args: unknown[]) =>
    updateSettingsTimeZone(...args),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/toast", () => ({
  toastError: (...args: unknown[]) => toastError(...args),
  toastSuccess: (...args: unknown[]) => toastSuccess(...args),
}));

// jsdom lacks the pointer-capture/scroll APIs Radix and cmdk touch.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const RUNTIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const persistedDoc = (
  general: { locale?: string; timeZone?: string } = {},
  userId = "u-1",
) => ({
  success: true,
  data: {
    userId,
    settings: {
      ai: { provider: "ollama", model: undefined },
      display: { theme: "system" },
      settings: { general: { ...general } },
    },
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPanel(initialLocale: Locale = "zh-CN") {
  return render(
    <I18nProvider
      initialLocale={initialLocale}
      loadPersistedLocale={async () => null}
    >
      <GeneralSettings />
    </I18nProvider>,
  );
}

const zoneTrigger = () => screen.getByTestId("settings-timezone-select");

async function openZonePicker() {
  const user = userEvent.setup();
  await user.click(zoneTrigger());
  return user;
}

async function pickZoneOption(testId: string) {
  const user = await openZonePicker();
  await user.click(await screen.findByTestId(testId));
}

async function flushAsync() {
  await act(async () => {});
}

describe("GeneralSettings — account time zone (P-TZ)", () => {
  beforeEach(() => {
    getUserSettings.mockReset();
    updateSettingsLocale.mockReset();
    updateSettingsTimeZone.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  it("shows the persisted account zone after load", async () => {
    getUserSettings.mockResolvedValue(
      persistedDoc({ locale: "zh-CN", timeZone: "Asia/Tokyo" }),
    );
    renderPanel();

    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("Asia/Tokyo"),
    );
    expect(updateSettingsTimeZone).not.toHaveBeenCalled();
  });

  it("shows follow-system with the runtime zone when nothing is stored", async () => {
    getUserSettings.mockResolvedValue(persistedDoc({ locale: "zh-CN" }));
    renderPanel();

    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent(
        `跟随系统 (${RUNTIME_ZONE})`,
      ),
    );
  });

  it("shows follow-system when the stored zone is not canonical", async () => {
    getUserSettings.mockResolvedValue(
      persistedDoc({ timeZone: "CST" }),
    );
    renderPanel();

    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("跟随系统"),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("applies a pick instantly and persists it through updateSettingsTimeZone", async () => {
    getUserSettings.mockResolvedValue(persistedDoc());
    updateSettingsTimeZone.mockResolvedValue(
      persistedDoc({ timeZone: "Asia/Shanghai" }),
    );
    renderPanel();
    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("跟随系统"),
    );

    await pickZoneOption("settings-timezone-option-Asia/Shanghai");

    expect(zoneTrigger()).toHaveTextContent("Asia/Shanghai");
    await waitFor(() =>
      expect(updateSettingsTimeZone).toHaveBeenCalledWith("Asia/Shanghai"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("sends undefined — key deletion — when picking follow system", async () => {
    getUserSettings.mockResolvedValue(
      persistedDoc({ timeZone: "Asia/Shanghai" }),
    );
    updateSettingsTimeZone.mockResolvedValue(persistedDoc());
    renderPanel();
    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("Asia/Shanghai"),
    );

    await pickZoneOption("settings-timezone-option-system");

    expect(zoneTrigger()).toHaveTextContent("跟随系统");
    await waitFor(() =>
      expect(updateSettingsTimeZone).toHaveBeenCalledWith(undefined),
    );
    expect(updateSettingsTimeZone.mock.calls[0]).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
  });

  it("filters the option list through the search input", async () => {
    getUserSettings.mockResolvedValue(persistedDoc());
    renderPanel();
    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("跟随系统"),
    );

    const user = await openZonePicker();
    await user.type(screen.getByTestId("settings-timezone-search"), "tokyo");

    await waitFor(() =>
      expect(
        screen.getByTestId("settings-timezone-option-Asia/Tokyo"),
      ).toBeVisible(),
    );
    expect(
      screen.queryByTestId("settings-timezone-option-Europe/Berlin"),
    ).not.toBeInTheDocument();
  });

  it("rolls back to the confirmed zone when the save fails", async () => {
    getUserSettings.mockResolvedValue(
      persistedDoc({ timeZone: "Asia/Shanghai" }),
    );
    updateSettingsTimeZone.mockResolvedValue({
      success: false,
      message: "db write failed",
    });
    renderPanel();
    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("Asia/Shanghai"),
    );

    await pickZoneOption("settings-timezone-option-Asia/Tokyo");

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(zoneTrigger()).toHaveTextContent("Asia/Shanghai");
    expect(toastError).toHaveBeenCalledWith(expect.any(String));
  });

  it("treats a persistence echo that differs from the intent as a failure", async () => {
    getUserSettings.mockResolvedValue(persistedDoc());
    // success:true but the stored document does not echo the intent.
    updateSettingsTimeZone.mockResolvedValue(
      persistedDoc({ timeZone: "Europe/Berlin" }),
    );
    renderPanel();
    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("跟随系统"),
    );

    await pickZoneOption("settings-timezone-option-Asia/Tokyo");

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(zoneTrigger()).toHaveTextContent("跟随系统");
    expect(toastError).toHaveBeenCalledWith(expect.any(String));
  });

  it("serializes rapid switches so the last write is the latest intent", async () => {
    getUserSettings.mockResolvedValue(persistedDoc());
    const first = deferred<unknown>();
    updateSettingsTimeZone
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(persistedDoc({ timeZone: "Asia/Tokyo" }));
    renderPanel();
    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("跟随系统"),
    );

    await pickZoneOption("settings-timezone-option-Asia/Shanghai");
    await pickZoneOption("settings-timezone-option-Asia/Tokyo");

    // The newer intent queues behind the in-flight write, never fires in
    // parallel — otherwise the older request could land last in the DB.
    expect(updateSettingsTimeZone).toHaveBeenCalledTimes(1);
    expect(updateSettingsTimeZone).toHaveBeenLastCalledWith("Asia/Shanghai");

    first.resolve(persistedDoc({ timeZone: "Asia/Shanghai" }));

    await waitFor(() =>
      expect(updateSettingsTimeZone).toHaveBeenCalledTimes(2),
    );
    expect(updateSettingsTimeZone).toHaveBeenLastCalledWith("Asia/Tokyo");
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
    expect(zoneTrigger()).toHaveTextContent("Asia/Tokyo");
  });

  it("keeps the newest selection when an earlier in-flight save fails", async () => {
    getUserSettings.mockResolvedValue(persistedDoc());
    const first = deferred<unknown>();
    updateSettingsTimeZone
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(persistedDoc({ timeZone: "Asia/Tokyo" }));
    renderPanel();
    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("跟随系统"),
    );

    await pickZoneOption("settings-timezone-option-Asia/Shanghai");
    await pickZoneOption("settings-timezone-option-Asia/Tokyo");

    first.resolve({ success: false, message: "conflict" });

    await waitFor(() =>
      expect(updateSettingsTimeZone).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
    expect(zoneTrigger()).toHaveTextContent("Asia/Tokyo");
    expect(toastError).toHaveBeenCalledWith(expect.any(String));
  });

  it("issues no write when re-selecting the already applied zone", async () => {
    getUserSettings.mockResolvedValue(
      persistedDoc({ timeZone: "Asia/Shanghai" }),
    );
    updateSettingsTimeZone.mockResolvedValue(
      persistedDoc({ timeZone: "Asia/Shanghai" }),
    );
    renderPanel();
    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("Asia/Shanghai"),
    );

    await pickZoneOption("settings-timezone-option-Asia/Shanghai");

    expect(updateSettingsTimeZone).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("does not touch the persisted locale when saving a zone", async () => {
    getUserSettings.mockResolvedValue(
      persistedDoc({ locale: "zh-CN", timeZone: undefined }),
    );
    updateSettingsTimeZone.mockResolvedValue(
      persistedDoc({ locale: "zh-CN", timeZone: "Asia/Tokyo" }),
    );
    renderPanel();
    await waitFor(() =>
      expect(zoneTrigger()).toHaveTextContent("跟随系统"),
    );

    await pickZoneOption("settings-timezone-option-Asia/Tokyo");

    await waitFor(() =>
      expect(updateSettingsTimeZone).toHaveBeenCalledWith("Asia/Tokyo"),
    );
    // The locale write path stays untouched — zh-CN survives on screen.
    expect(updateSettingsLocale).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-language-select")).toHaveTextContent(
      "简体中文",
    );
  });
  it("preserves both fields when language and zone queue behind a save", async () => {
    getUserSettings.mockResolvedValue(persistedDoc({ locale: "zh-CN" }));
    const first = deferred<unknown>();
    updateSettingsTimeZone.mockReturnValueOnce(first.promise)
      .mockResolvedValue(persistedDoc({ locale: "en", timeZone: "Asia/Tokyo" }));
    updateSettingsLocale.mockResolvedValue(persistedDoc({ locale: "en" }));
    renderPanel();
    await waitFor(() => expect(zoneTrigger()).toHaveTextContent("跟随系统"));
    await pickZoneOption("settings-timezone-option-Asia/Shanghai");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("settings-language-select"));
    await user.click(await screen.findByRole("option", { name: "English" }));
    await pickZoneOption("settings-timezone-option-Asia/Tokyo");
    first.resolve(persistedDoc({ timeZone: "Asia/Shanghai" }));
    await waitFor(() => expect(updateSettingsLocale).toHaveBeenCalledWith("en"));
    await waitFor(() => expect(updateSettingsTimeZone).toHaveBeenLastCalledWith("Asia/Tokyo"));
    await waitFor(() => expect(screen.getByTestId("save-status")).toHaveAttribute("data-state", "saved"));
    expect(screen.getByTestId("settings-language-select")).toHaveTextContent("English");
    expect(zoneTrigger()).toHaveTextContent("Asia/Tokyo");
  });

  it("rolls back a failed zone even when a language change is pending", async () => {
    getUserSettings.mockResolvedValue(persistedDoc({ locale: "zh-CN", timeZone: "Asia/Shanghai" }));
    const first = deferred<unknown>();
    updateSettingsTimeZone.mockReturnValueOnce(first.promise);
    updateSettingsLocale.mockResolvedValue(persistedDoc({ locale: "en", timeZone: "Asia/Shanghai" }));
    renderPanel();
    await waitFor(() => expect(zoneTrigger()).toHaveTextContent("Asia/Shanghai"));
    await pickZoneOption("settings-timezone-option-Asia/Tokyo");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("settings-language-select"));
    await user.click(await screen.findByRole("option", { name: "English" }));
    first.resolve({ success: false });
    await waitFor(() => expect(updateSettingsLocale).toHaveBeenCalledWith("en"));
    await waitFor(() => expect(zoneTrigger()).toHaveTextContent("Asia/Shanghai"));
    expect(toastError).toHaveBeenCalled();
  });

});
