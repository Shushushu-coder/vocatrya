// SET-07: the About page shows facts read from real signals — the injected
// package version, NODE_ENV build source, the Electron shell marker — and
// the diagnostics copy is a whitelist of version/environment facts: runtime
// entries pass through displayName/backendKind/vendor only, so credentials,
// mechanism strings, capability internals, and filesystem paths can never
// reach the clipboard.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AboutSettings from "@/components/settings/AboutSettings";
import { I18nProvider, type Locale } from "@/i18n";

const writeText = vi.fn();
const toastError = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/toast", () => ({
  toastError: (...args: unknown[]) => toastError(...args),
}));

const nullLocaleLoader = async (): Promise<Locale | null> => null;

// userEvent.setup() installs its own clipboard stub over navigator.clipboard,
// so the spy must be installed after setup() to observe the copy.
function stubClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

function renderAbout(locale: Locale = "en") {
  return render(
    <I18nProvider initialLocale={locale} loadPersistedLocale={nullLocaleLoader}>
      <AboutSettings />
    </I18nProvider>,
  );
}

const runtimeEntry = (extras: Record<string, unknown> = {}) => ({
  backendKind: "claude-code",
  displayName: "Claude Code",
  runtimeVendor: "anthropic",
  supportedAccountProviders: ["anthropic"],
  profileStrategy: "managed",
  capabilities: {},
  ...extras,
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.vocatryaWindow;
  delete window.vocatryaRuntime;
});

describe("AboutSettings — facts", () => {
  it("renders the injected version, dev build, browser environment, and MIT license", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "9.9.9-test");
    renderAbout();

    expect(screen.getByTestId("about-settings")).toBeInTheDocument();
    expect(screen.getByTestId("about-version")).toHaveTextContent("9.9.9-test");
    expect(screen.getByTestId("about-build")).toHaveTextContent(
      "Development build",
    );
    // The shell marker resolves after mount; until then the row shows a dash.
    await waitFor(() =>
      expect(screen.getByTestId("about-environment")).toHaveTextContent(
        "Browser",
      ),
    );
    expect(screen.getByTestId("about-license")).toHaveTextContent("MIT");
  });

  it("labels the Electron desktop shell once the marker resolves", async () => {
    window.vocatryaWindow = { setTheme: vi.fn() };
    renderAbout();

    await waitFor(() =>
      expect(screen.getByTestId("about-environment")).toHaveTextContent(
        "Electron desktop",
      ),
    );
  });

  it("labels a production bundle as the installed build", () => {
    vi.stubEnv("NODE_ENV", "production");
    renderAbout();

    expect(screen.getByTestId("about-build")).toHaveTextContent(
      "Installed build",
    );
  });

  it("renders zh-CN labels", async () => {
    renderAbout("zh-CN");

    expect(screen.getByText("关于")).toBeInTheDocument();
    expect(screen.getByText("应用版本")).toBeInTheDocument();
    expect(screen.getByText("构建来源")).toBeInTheDocument();
    expect(screen.getByText("开源许可")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("about-environment")).toHaveTextContent(
        "浏览器",
      ),
    );
  });
});

describe("AboutSettings — diagnostics copy", () => {
  it("writes version and environment facts, skipping runtimes with no bridge", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "9.9.9-test");
    const user = userEvent.setup();
    stubClipboard();
    renderAbout();

    await user.click(screen.getByTestId("about-copy-diagnostics"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("version: 9.9.9-test");
    expect(text).toContain("build: development");
    expect(text).toContain("environment: browser");
    expect(text).toContain("locale: en");
    expect(text).toMatch(/timezone: \S+/);
    expect(text).not.toContain("runtimes:");
  });

  it("includes whitelisted runtime entries and reports the electron shell", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "9.9.9-test");
    window.vocatryaWindow = { setTheme: vi.fn() };
    window.vocatryaRuntime = {
      list: vi.fn().mockResolvedValue([
        runtimeEntry({ backendKind: "codex", displayName: "Codex" }),
        runtimeEntry(),
      ]),
    } as unknown as VocatryaRuntimeBridge;
    const user = userEvent.setup();
    stubClipboard();
    renderAbout();

    await user.click(screen.getByTestId("about-copy-diagnostics"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("environment: electron");
    expect(text).toContain("Codex (backend=codex, vendor=anthropic)");
    expect(text).toContain(
      "Claude Code (backend=claude-code, vendor=anthropic)",
    );
  });

  it("never leaks sensitive fields from runtime entries", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "9.9.9-test");
    window.vocatryaRuntime = {
      list: vi.fn().mockResolvedValue([
        runtimeEntry({
          executablePath: "C:\\Users\\alice\\AppData\\tool.exe",
          token: "sk-secret-value",
          capabilities: {
            profile: { credentialBoundary: ["ANTHROPIC_API_KEY"] },
          },
        }),
      ]),
    } as unknown as VocatryaRuntimeBridge;
    const user = userEvent.setup();
    stubClipboard();
    renderAbout();

    await user.click(screen.getByTestId("about-copy-diagnostics"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    for (const leaked of [
      "executablePath",
      "alice",
      "sk-secret-value",
      "ANTHROPIC_API_KEY",
      "credentialBoundary",
      "capabilities",
      "token",
      "supportedAccountProviders",
      "profileStrategy",
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("Claude Code (backend=claude-code");
  });

  it("still copies the base facts when the runtime probe fails", async () => {
    window.vocatryaRuntime = {
      list: vi.fn().mockRejectedValue(new Error("ipc down")),
    } as unknown as VocatryaRuntimeBridge;
    const user = userEvent.setup();
    stubClipboard();
    renderAbout();

    await user.click(screen.getByTestId("about-copy-diagnostics"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("environment: browser");
    expect(text).not.toContain("runtimes:");
  });

  it("reports a toast error when the clipboard write fails", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const user = userEvent.setup();
    stubClipboard();
    renderAbout();

    await user.click(screen.getByTestId("about-copy-diagnostics"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not copy diagnostics."),
    );
  });
});
