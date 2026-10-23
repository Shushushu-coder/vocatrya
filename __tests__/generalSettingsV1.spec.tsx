// SET-02: the General language preference applies instantly through
// I18nContext (cookie + localStorage stay render caches), persists for
// signed-in users to settings.general.locale via updateSettingsLocale
// (C-01.P atomic patch entry), reconciles the persisted value on mount, and
// reports failure honestly with a guarded rollback. Saves run serially and
// coalesce to the latest intent so an older request can never land last.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import {
  I18nProvider,
  LOCALE_COOKIE_NAME,
  LOCALE_STORAGE_KEY,
  isValidLocale,
  useI18n,
  type Locale,
} from "@/i18n";
import GeneralSettings from "@/components/settings/GeneralSettings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const getUserSettings = vi.fn();
const updateSettingsLocale = vi.fn();
vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: (...args: unknown[]) => getUserSettings(...args),
  updateSettingsLocale: (...args: unknown[]) =>
    updateSettingsLocale(...args),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/toast", () => ({
  toastError: (...args: unknown[]) => toastError(...args),
  toastSuccess: (...args: unknown[]) => toastSuccess(...args),
}));

// jsdom lacks the pointer-capture/scroll APIs Radix Select touches.
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

const persistedDoc = (locale?: string, userId = "u-1") => ({
  success: true,
  data: {
    userId,
    settings: {
      ai: { provider: "ollama", model: undefined },
      display: { theme: "system" },
      ...(locale === undefined
        ? {}
        : { settings: { general: { locale } } }),
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

function LocaleProbe() {
  const { locale, setLocale } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <button
        type="button"
        data-testid="pick-en"
        onClick={() => setLocale("en")}
      >
        en
      </button>
    </div>
  );
}

// Mirrors the production default loader in context.tsx: reads the account
// document through the mocked action and extracts a valid persisted locale.
const accountLocaleLoader = () =>
  getUserSettings().then((result: any) =>
    result?.success === true &&
    isValidLocale(result?.data?.settings?.settings?.general?.locale)
      ? (result.data.settings.settings.general.locale as Locale)
      : null,
  );

function renderProvider(
  initialLocale: Locale = "zh-CN",
  loadPersistedLocale: () => Promise<Locale | null> = accountLocaleLoader,
) {
  return render(
    <I18nProvider
      initialLocale={initialLocale}
      loadPersistedLocale={loadPersistedLocale}
    >
      <LocaleProbe />
    </I18nProvider>,
  );
}

function renderPanel(
  initialLocale: Locale = "zh-CN",
  loadPersistedLocale: () => Promise<Locale | null> = accountLocaleLoader,
) {
  return render(
    <I18nProvider
      initialLocale={initialLocale}
      loadPersistedLocale={loadPersistedLocale}
    >
      <GeneralSettings />
    </I18nProvider>,
  );
}

const languageSelect = () => screen.getByTestId("settings-language-select");

async function pickOption(label: string | RegExp) {
  const user = userEvent.setup();
  await user.click(languageSelect());
  await user.click(await screen.findByRole("option", { name: label }));
}

async function flushAsync() {
  await act(async () => {});
}

describe("I18nProvider — account locale restore (SET-02)", () => {
  beforeEach(() => {
    getUserSettings.mockReset();
    updateSettingsLocale.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    localStorage.clear();
    document.documentElement.lang = "";
    document.cookie = `${LOCALE_COOKIE_NAME}=; path=/; max-age=0`;
  });

  it("restores the persisted account locale over the cookie-derived initial value", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("en"));
    renderProvider("zh-CN");

    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
    await waitFor(() =>
      expect(screen.getByTestId("locale")).toHaveTextContent("en"),
    );
    // The normal switch path keeps the render caches consistent for SSR.
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=en`);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("keeps the default zh-CN when the account has no persisted locale", async () => {
    getUserSettings.mockResolvedValue(persistedDoc());
    renderProvider("zh-CN");

    await waitFor(() => expect(getUserSettings).toHaveBeenCalled());
    await flushAsync();
    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
  });

  it.each([["fr"], ["zh"], ["EN"], [42]])(
    "ignores the invalid persisted locale %p and keeps the current value",
    async (bad) => {
      // An unusable loader result (validated out of Locale) must not move
      // the visible locale — the provider guards with isValidLocale itself.
      const loader = vi.fn(async () => bad as Locale);
      renderProvider("zh-CN", loader);

      await waitFor(() => expect(loader).toHaveBeenCalled());
      await flushAsync();
      expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
    },
  );

  it("keeps the current locale when the loader resolves to null", async () => {
    const loader = vi.fn(async () => null);
    renderProvider("zh-CN", loader);

    await waitFor(() => expect(loader).toHaveBeenCalled());
    await flushAsync();
    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
  });

  it("keeps the current locale when the loader rejects", async () => {
    const loader = vi.fn(async () => {
      throw new Error("read unavailable");
    });
    renderProvider("zh-CN", loader);

    await waitFor(() => expect(loader).toHaveBeenCalled());
    await flushAsync();
    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("keeps the current locale silently when the account read fails (signed-out)", async () => {
    getUserSettings.mockResolvedValue({
      success: false,
      message: "Not authenticated",
    });
    renderProvider("zh-CN");

    await waitFor(() => expect(getUserSettings).toHaveBeenCalled());
    await flushAsync();
    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("keeps a valid legacy localStorage preference when the account read fails", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    getUserSettings.mockResolvedValue({
      success: false,
      message: "Not authenticated",
    });
    renderProvider("zh-CN");

    // The localStorage fallback restored en before the failed account read —
    // a failed restore must not clobber it.
    await waitFor(() =>
      expect(screen.getByTestId("locale")).toHaveTextContent("en"),
    );
    await flushAsync();
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("lets the account document win over a legacy localStorage value for a signed-in user", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    renderProvider("zh-CN");

    // localStorage fills in first (no cookie present) ...
    await waitFor(() =>
      expect(screen.getByTestId("locale")).toHaveTextContent("en"),
    );
    // ... then the account authority reconciles it back to zh-CN.
    await waitFor(() =>
      expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN"),
    );
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
  });

  it("never lets a late account read override a fresher user choice", async () => {
    const gate = deferred<Locale | null>();
    const loader = vi.fn(() => gate.promise);
    const user = userEvent.setup();
    renderProvider("zh-CN", loader);

    await waitFor(() => expect(loader).toHaveBeenCalled());
    await user.click(screen.getByTestId("pick-en"));
    expect(screen.getByTestId("locale")).toHaveTextContent("en");

    // The read started before the pick and resolves afterwards — it must not
    // drag the UI back to the stale persisted value.
    gate.resolve("zh-CN");
    await flushAsync();
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=en`);
  });
});

describe("GeneralSettings — account persistence (SET-02)", () => {
  beforeEach(() => {
    getUserSettings.mockReset();
    updateSettingsLocale.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    localStorage.clear();
    document.documentElement.lang = "";
    document.cookie = `${LOCALE_COOKIE_NAME}=; path=/; max-age=0`;
  });

  it("shows the persisted account locale as the selected value after load", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("en"));
    renderPanel("zh-CN");

    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("English"),
    );
    expect(updateSettingsLocale).not.toHaveBeenCalled();
  });

  it("keeps the current locale when the persisted value is missing or invalid", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("fr"));
    renderPanel("zh-CN");

    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("applies a pick instantly and persists it through updateSettingsLocale", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    updateSettingsLocale.mockResolvedValue(persistedDoc("en"));
    renderPanel();
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");

    expect(languageSelect()).toHaveTextContent("English");
    await waitFor(() =>
      expect(updateSettingsLocale).toHaveBeenCalledWith("en"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=en`);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("routes every write through the single updateSettingsLocale entry", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    updateSettingsLocale.mockResolvedValue(persistedDoc("en"));
    renderPanel();
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");

    await waitFor(() => expect(updateSettingsLocale).toHaveBeenCalledTimes(1));
    // Single-argument call: the action owns the
    // { settings: { general: { locale } } } patch shape internally.
    expect(updateSettingsLocale).toHaveBeenLastCalledWith("en");
    expect(updateSettingsLocale.mock.calls[0]).toHaveLength(1);
  });

  it("treats a persistence echo that differs from the intent as a failure", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    // success:true but the stored document does not echo the intent.
    updateSettingsLocale.mockResolvedValue(persistedDoc("zh-CN"));
    renderPanel();
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(languageSelect()).toHaveTextContent("简体中文");
    expect(toastError).toHaveBeenCalledWith(expect.any(String));
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=zh-CN`);
  });

  it("rolls back to the confirmed locale when the save fails", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    updateSettingsLocale.mockResolvedValue({
      success: false,
      message: "db write failed",
    });
    renderPanel();
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(languageSelect()).toHaveTextContent("简体中文");
    expect(toastError).toHaveBeenCalledWith(expect.any(String));
  });

  it("rolls back when the save promise rejects", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    updateSettingsLocale.mockRejectedValue(new Error("network down"));
    renderPanel();
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(languageSelect()).toHaveTextContent("简体中文");
    expect(toastError).toHaveBeenCalledWith(expect.any(String));
  });

  it("surfaces a SETTINGS_CONFLICT result as an honest failure", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    updateSettingsLocale.mockResolvedValue({
      success: false,
      code: "SETTINGS_CONFLICT",
      message: "Settings changed while saving. Please retry.",
    });
    renderPanel();
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(languageSelect()).toHaveTextContent("简体中文");
    expect(toastError).toHaveBeenCalledWith(expect.any(String));
  });

  it("serializes rapid switches so the last write is the latest intent", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    const first = deferred<ReturnType<typeof persistedDoc>>();
    updateSettingsLocale
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(persistedDoc("zh-CN"));
    renderPanel();
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");
    await pickOption(/简体中文/);

    // The newer intent queues behind the in-flight write, never fires in
    // parallel — otherwise the older request could land last in the DB.
    expect(updateSettingsLocale).toHaveBeenCalledTimes(1);
    expect(updateSettingsLocale).toHaveBeenLastCalledWith("en");

    first.resolve(persistedDoc("en"));

    await waitFor(() =>
      expect(updateSettingsLocale).toHaveBeenCalledTimes(2),
    );
    expect(updateSettingsLocale).toHaveBeenLastCalledWith("zh-CN");
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
    expect(languageSelect()).toHaveTextContent("简体中文");
  });

  it("keeps the newest selection when an earlier in-flight save fails", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    const first = deferred<unknown>();
    updateSettingsLocale
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(persistedDoc("zh-CN"));
    renderPanel();
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");
    await pickOption(/简体中文/);

    // The en save fails after the user already moved back to zh-CN: its stale
    // failure must not revert the newer selection.
    first.resolve({ success: false, message: "conflict" });

    await waitFor(() =>
      expect(updateSettingsLocale).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );
    expect(languageSelect()).toHaveTextContent("简体中文");
    expect(toastError).toHaveBeenCalledWith(expect.any(String));
  });

  it("issues no write when re-selecting the already applied locale", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    updateSettingsLocale.mockResolvedValue(persistedDoc("en"));
    renderPanel();
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption(/简体中文/);

    expect(updateSettingsLocale).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("stays usable when the account read fails — no fake persisted state", async () => {
    getUserSettings.mockResolvedValue({
      success: false,
      message: "Not authenticated",
    });
    const write = deferred<unknown>();
    updateSettingsLocale.mockReturnValue(write.promise);
    renderPanel();

    // The panel still renders and allows interaction; the failed write is
    // surfaced honestly instead of pretending it persisted.
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");
    // The pick applies instantly while the write is still in flight.
    expect(languageSelect()).toHaveTextContent("English");
    expect(updateSettingsLocale).toHaveBeenCalledWith("en");

    write.resolve({ success: false, message: "Not authenticated" });

    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "error",
      ),
    );
    expect(languageSelect()).toHaveTextContent("简体中文");
    expect(toastError).toHaveBeenCalledWith(expect.any(String));
  });
});

describe("SET-02 CV-1 — lifecycle & recovery seams", () => {
  beforeEach(() => {
    getUserSettings.mockReset();
    updateSettingsLocale.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    localStorage.clear();
    document.documentElement.lang = "";
    document.cookie = `${LOCALE_COOKIE_NAME}=; path=/; max-age=0`;
  });

  it("isolates an unmounted instance's late read from the remounted provider", async () => {
    const staleRead = deferred<Locale | null>();
    const firstLoader = vi.fn(() => staleRead.promise);
    const first = renderProvider("zh-CN", firstLoader);
    await waitFor(() => expect(firstLoader).toHaveBeenCalled());

    // Torn down while its account read is still in flight.
    first.unmount();

    // A fresh instance mounts and reconciles to the account value.
    const secondLoader = vi.fn(async () => "en" as Locale);
    renderProvider("zh-CN", secondLoader);
    await waitFor(() =>
      expect(screen.getByTestId("locale")).toHaveTextContent("en"),
    );

    // The first read resolves only now: the cancelled flag must keep the
    // stale value out of the live instance and the render caches.
    staleRead.resolve("zh-CN");
    await flushAsync();
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=en`);
    expect(document.documentElement.lang).toBe("en");
    expect(updateSettingsLocale).not.toHaveBeenCalled();
  });

  it("lets an in-flight save settle after unmount — failure still surfaces and caches converge to the confirmed locale", async () => {
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    const write = deferred<unknown>();
    updateSettingsLocale.mockReturnValue(write.promise);
    const view = renderPanel("zh-CN");
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");
    await waitFor(() =>
      expect(updateSettingsLocale).toHaveBeenCalledTimes(1),
    );
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");

    // The pump has no unmount cancellation (registered semantics): the
    // in-flight write still settles, the failure is surfaced once, and the
    // render caches converge back to the last confirmed locale. No retry,
    // no second write.
    view.unmount();
    write.resolve({ success: false, message: "write lost" });
    await flushAsync();
    expect(updateSettingsLocale).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(expect.any(String));
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=zh-CN`);
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("keeps a remounted user's reconcile isolated from a previous user's late read", async () => {
    // u-1's read is still in flight when the session unmounts.
    const userARead = deferred<ReturnType<typeof persistedDoc>>();
    getUserSettings.mockImplementationOnce(() => userARead.promise);
    const first = renderProvider("zh-CN");
    await waitFor(() => expect(getUserSettings).toHaveBeenCalledTimes(1));
    first.unmount();

    // u-2 signs in on the same device: the remount re-reads the account
    // document and applies u-2's authoritative locale.
    getUserSettings.mockResolvedValue(persistedDoc("en", "u-2"));
    renderProvider("zh-CN");
    await waitFor(() =>
      expect(screen.getByTestId("locale")).toHaveTextContent("en"),
    );
    expect(getUserSettings).toHaveBeenCalledTimes(2);

    // u-1's stale read finally resolves — the live instance and the device
    // caches stay on u-2's locale.
    userARead.resolve(persistedDoc("zh-CN", "u-1"));
    await flushAsync();
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=en`);
    expect(updateSettingsLocale).not.toHaveBeenCalled();
  });

  it("never lets the provider's late reconcile revert a pick already persisted by the panel", async () => {
    // The panel's own mount read resolves promptly; the provider-level
    // account reconcile is still in flight when the user picks.
    const providerRead = deferred<Locale | null>();
    getUserSettings.mockResolvedValue(persistedDoc("zh-CN"));
    updateSettingsLocale.mockResolvedValue(persistedDoc("en"));
    renderPanel("zh-CN", () => providerRead.promise);
    await waitFor(() =>
      expect(languageSelect()).toHaveTextContent("简体中文"),
    );

    await pickOption("English");
    await waitFor(() =>
      expect(screen.getByTestId("save-status")).toHaveAttribute(
        "data-state",
        "saved",
      ),
    );

    // The earlier account read completes only now — the userSelectedRef
    // latch set by the pick must keep the stale persisted value out.
    providerRead.resolve("zh-CN");
    await flushAsync();
    expect(languageSelect()).toHaveTextContent("English");
    expect(updateSettingsLocale).toHaveBeenCalledTimes(1);
    expect(updateSettingsLocale).toHaveBeenLastCalledWith("en");
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=en`);
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("short-circuits only the uninjected default loader under NODE_ENV=test", async () => {
    expect(process.env.NODE_ENV).toBe("test");

    // A bare provider must never reach the actions/db chain: the default
    // loader is skipped entirely in the test environment.
    const bare = render(
      <I18nProvider initialLocale="zh-CN">
        <LocaleProbe />
      </I18nProvider>,
    );
    await flushAsync();
    expect(getUserSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
    bare.unmount();

    // The short-circuit is not an unconditional skip: injecting a loader
    // still drives the real actions seam and the full reconcile path.
    getUserSettings.mockResolvedValue(persistedDoc("en"));
    renderProvider("zh-CN", accountLocaleLoader);
    await waitFor(() => expect(getUserSettings).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("locale")).toHaveTextContent("en"),
    );
  });

  // The panel's mount read exercises the real extraction path
  // result.data.settings.settings.general.locale against real
  // getUserSettings document shapes — anything that is not a valid locale
  // at that exact key leaves the current value untouched.
  it.each([
    ["a document without a settings namespace", persistedDoc()],
    [
      "a locale nested outside the settings.general path",
      {
        success: true,
        data: {
          userId: "u-1",
          settings: {
            ai: { provider: "ollama", model: undefined },
            display: { theme: "system" },
            general: { locale: "en" },
          },
        },
      },
    ],
    ["a rejected read", new Error("read unavailable")],
  ])(
    "keeps the current locale when the mount read returns %s",
    async (_label, outcome) => {
      if (outcome instanceof Error) {
        getUserSettings.mockRejectedValue(outcome);
      } else {
        getUserSettings.mockResolvedValue(outcome);
      }
      renderPanel("zh-CN");

      await waitFor(() =>
        expect(languageSelect()).toHaveTextContent("简体中文"),
      );
      expect(updateSettingsLocale).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    },
  );
});
