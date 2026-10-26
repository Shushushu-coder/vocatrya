// SET-DESKTOP: the General settings card exposes the device-scope desktop
// lifecycle preferences through the vocatryaDesktop preload bridge. State is
// read back from the main process, writes are confirmed by the authoritative
// snapshot the IPC returns (or a fresh getState), failures roll the switch
// back instead of faking success, and rapid toggles serialize to the latest
// intent. Outside the desktop shell the section states honest availability.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { I18nProvider, type Locale } from "@/i18n";
import { SaveStatusProvider } from "@/context/SaveStatusContext";
import { SaveStatusIndicator } from "@/components/SaveStatusIndicator";
import DesktopPreferencesSettings from "@/components/settings/DesktopPreferencesSettings";
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

// jsdom lacks the pointer-capture/scroll APIs Radix Select touches (the
// language select in the mounted GeneralSettings integration test).
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

type DesktopState = VocatryaDesktopLifecycleState;

const lifecycleState = (over: Partial<DesktopState> = {}): DesktopState => ({
  closeToTray: false,
  closeToTrayActive: false,
  startMinimized: false,
  openAtLogin: false,
  openAtLoginSupported: true,
  openAtLoginError: null,
  trayAvailable: true,
  ...over,
});

const bridge = {
  getState: vi.fn(),
  setCloseToTray: vi.fn(),
  setStartMinimized: vi.fn(),
  setOpenAtLogin: vi.fn(),
  showWindow: vi.fn(),
  quit: vi.fn(),
};

function installBridge() {
  window.vocatryaDesktop = bridge as unknown as VocatryaDesktopBridge;
}

const persistedDoc = (locale = "zh-CN") => ({
  success: true,
  data: {
    userId: "u-1",
    settings: {
      ai: { provider: "ollama", model: undefined },
      display: { theme: "system" },
      settings: { general: { locale } },
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

const nullLocaleLoader = async (): Promise<Locale | null> => null;

function renderPanel() {
  return render(
    <I18nProvider initialLocale="zh-CN" loadPersistedLocale={nullLocaleLoader}>
      <SaveStatusProvider>
        <SaveStatusIndicator />
        <DesktopPreferencesSettings />
      </SaveStatusProvider>
    </I18nProvider>,
  );
}

async function flushAsync() {
  await act(async () => {});
}

const switchOf = (id: string) => screen.getByTestId(id);
const saveStatus = () => screen.getByTestId("save-status");

beforeEach(() => {
  vi.clearAllMocks();
  delete window.vocatryaDesktop;
});

describe("DesktopPreferencesSettings — bridge availability", () => {
  it("states honest availability when the desktop bridge is absent", async () => {
    renderPanel();

    expect(
      await screen.findByTestId("desktop-preferences-unavailable"),
    ).toBeInTheDocument();
    // Accurate availability: the desktop-only capability is marked, and no
    // fake switches are offered to a session that cannot persist them.
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(bridge.getState).not.toHaveBeenCalled();
  });

  it("probes the bridge only after mount (SSR-safe)", () => {
    // Without a bridge there is no crash and no synchronous desktop read.
    renderPanel();
    expect(bridge.getState).not.toHaveBeenCalled();
  });
});

describe("DesktopPreferencesSettings — state backfill", () => {
  it("backfills all three toggles from the authoritative getState snapshot", async () => {
    installBridge();
    bridge.getState.mockResolvedValue(
      lifecycleState({
        openAtLogin: true,
        startMinimized: true,
        closeToTray: true,
        closeToTrayActive: true,
      }),
    );
    renderPanel();

    await waitFor(() =>
      expect(switchOf("desktop-pref-open-at-login")).toHaveAttribute(
        "data-state",
        "checked",
      ),
    );
    expect(switchOf("desktop-pref-start-minimized")).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(switchOf("desktop-pref-close-to-tray")).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(bridge.getState).toHaveBeenCalledTimes(1);
  });

  it("disables the login toggle with a note when the platform is unsupported", async () => {
    installBridge();
    bridge.getState.mockResolvedValue(
      lifecycleState({ openAtLoginSupported: false }),
    );
    renderPanel();

    await waitFor(() =>
      expect(switchOf("desktop-pref-open-at-login")).toBeDisabled(),
    );
    expect(
      screen.getByText("当前平台不支持管理系统自启项。"),
    ).toBeInTheDocument();
  });

  it("notes when the OS login-item state could not be read", async () => {
    installBridge();
    bridge.getState.mockResolvedValue(
      lifecycleState({ openAtLoginError: "registry read failed" }),
    );
    renderPanel();

    await waitFor(() =>
      expect(switchOf("desktop-pref-open-at-login")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("无法读取系统自启状态，显示值可能不准确。"),
    ).toBeInTheDocument();
  });

  it("warns that close-to-tray falls back to quitting while no tray exists", async () => {
    installBridge();
    bridge.getState.mockResolvedValue(
      lifecycleState({
        closeToTray: true,
        closeToTrayActive: false,
        trayAvailable: false,
      }),
    );
    renderPanel();

    await waitFor(() =>
      expect(switchOf("desktop-pref-close-to-tray")).toHaveAttribute(
        "data-state",
        "checked",
      ),
    );
    expect(
      screen.getByText("系统托盘当前不可用，关闭窗口将直接退出应用。"),
    ).toBeInTheDocument();
  });

  it("shows an honest load error with a working retry", async () => {
    installBridge();
    bridge.getState
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValueOnce(lifecycleState({ startMinimized: true }));
    const user = userEvent.setup();
    renderPanel();

    await screen.findByTestId("desktop-preferences-error");
    await user.click(screen.getByTestId("desktop-preferences-retry"));

    await waitFor(() =>
      expect(switchOf("desktop-pref-start-minimized")).toHaveAttribute(
        "data-state",
        "checked",
      ),
    );
    expect(bridge.getState).toHaveBeenCalledTimes(2);
  });
});

describe("DesktopPreferencesSettings — writes", () => {
  it("persists a toggle through the setter and reports saved", async () => {
    installBridge();
    bridge.getState.mockResolvedValue(lifecycleState());
    bridge.setCloseToTray.mockImplementation(async (enabled: boolean) =>
      lifecycleState({ closeToTray: enabled, closeToTrayActive: enabled }),
    );
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(switchOf("desktop-pref-close-to-tray")).toBeInTheDocument(),
    );

    await user.click(switchOf("desktop-pref-close-to-tray"));

    await waitFor(() =>
      expect(bridge.setCloseToTray).toHaveBeenCalledWith(true),
    );
    await waitFor(() =>
      expect(saveStatus()).toHaveAttribute("data-state", "saved"),
    );
    expect(switchOf("desktop-pref-close-to-tray")).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("rolls back and reports error when the write rejects", async () => {
    installBridge();
    bridge.getState.mockResolvedValue(lifecycleState());
    bridge.setStartMinimized.mockRejectedValue(new Error("disk full"));
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(switchOf("desktop-pref-start-minimized")).toBeInTheDocument(),
    );

    await user.click(switchOf("desktop-pref-start-minimized"));

    await waitFor(() =>
      expect(saveStatus()).toHaveAttribute("data-state", "error"),
    );
    // The optimistic switch rolled back: the re-read getState reported the
    // real persisted value (still off).
    expect(switchOf("desktop-pref-start-minimized")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    expect(toastError).toHaveBeenCalledWith("桌面偏好保存失败。");
  });

  it("treats an echo that disagrees with the intent as a failure", async () => {
    installBridge();
    bridge.getState.mockResolvedValue(lifecycleState());
    // The setter resolves but the authoritative snapshot never landed the
    // intent — a bare resolved promise is not proof of persistence.
    bridge.setOpenAtLogin.mockResolvedValue(
      lifecycleState({ openAtLogin: false }),
    );
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(switchOf("desktop-pref-open-at-login")).toBeInTheDocument(),
    );

    await user.click(switchOf("desktop-pref-open-at-login"));

    await waitFor(() =>
      expect(saveStatus()).toHaveAttribute("data-state", "error"),
    );
    expect(switchOf("desktop-pref-open-at-login")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    expect(toastError).toHaveBeenCalledWith("桌面偏好保存失败。");
  });

  it("serializes rapid toggles so the last write is the latest intent", async () => {
    installBridge();
    bridge.getState.mockResolvedValue(lifecycleState());
    const first = deferred<DesktopState>();
    bridge.setCloseToTray
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (enabled: boolean) =>
        lifecycleState({ closeToTray: enabled }),
      );
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(switchOf("desktop-pref-close-to-tray")).toBeInTheDocument(),
    );

    await user.click(switchOf("desktop-pref-close-to-tray")); // on
    await user.click(switchOf("desktop-pref-close-to-tray")); // off — latest intent

    // The newer intent queues behind the in-flight write, never fires in
    // parallel — otherwise the older request could land last on disk.
    expect(bridge.setCloseToTray).toHaveBeenCalledTimes(1);
    expect(bridge.setCloseToTray).toHaveBeenLastCalledWith(true);

    first.resolve(lifecycleState({ closeToTray: true }));

    await waitFor(() =>
      expect(bridge.setCloseToTray).toHaveBeenCalledTimes(2),
    );
    expect(bridge.setCloseToTray).toHaveBeenLastCalledWith(false);
    await waitFor(() =>
      expect(saveStatus()).toHaveAttribute("data-state", "saved"),
    );
    expect(switchOf("desktop-pref-close-to-tray")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("keeps the newest toggle when an earlier in-flight write fails", async () => {
    installBridge();
    bridge.getState.mockResolvedValue(lifecycleState());
    const first = deferred<DesktopState>();
    bridge.setStartMinimized
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (enabled: boolean) =>
        lifecycleState({ startMinimized: enabled }),
      );
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(switchOf("desktop-pref-start-minimized")).toBeInTheDocument(),
    );

    await user.click(switchOf("desktop-pref-start-minimized")); // on
    await user.click(switchOf("desktop-pref-start-minimized")); // off

    // The first write fails after the user already moved back to off — the
    // stale failure must not flip the newer intent back on.
    first.reject(new Error("write failed"));

    await waitFor(() =>
      expect(bridge.setStartMinimized).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(saveStatus()).toHaveAttribute("data-state", "saved"),
    );
    expect(switchOf("desktop-pref-start-minimized")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    expect(toastError).toHaveBeenCalledWith("桌面偏好保存失败。");
  });
});

describe("DesktopPreferencesSettings — mounted inside GeneralSettings", () => {
  it("renders the desktop section under the General card", async () => {
    installBridge();
    getUserSettings.mockResolvedValue(persistedDoc());
    bridge.getState.mockResolvedValue(lifecycleState());
    render(
      <I18nProvider
        initialLocale="zh-CN"
        loadPersistedLocale={nullLocaleLoader}
      >
        <GeneralSettings />
      </I18nProvider>,
    );

    // The card's own language load finishes first, then the desktop section
    // probes the bridge and fills in real state.
    await waitFor(() =>
      expect(screen.getByTestId("desktop-pref-close-to-tray")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("desktop-preferences")).toBeInTheDocument();
    expect(bridge.getState).toHaveBeenCalled();
  });
});
