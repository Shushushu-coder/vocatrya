/**
 * Settings surface tests for the consolidated account-login card: the
 * runtimes render through one shared path, provider+runtime labels
 * disambiguate the two ChatGPT entries, connect is gated on runtime
 * readiness (never silent-install), and per-connection operations mint a
 * ticket then call the unified IPC surface.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AiServicesLayout from "@/components/settings/AiServicesLayout";
import AiConnectionsCard from "@/components/settings/AiConnectionsCard";
import { ErrorNoticeHost } from "@/components/common/ErrorNoticeHost";
import { resetErrorNoticesForTests } from "@/lib/errorNotices";

vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

const actionMocks = vi.hoisted(() => ({
  listAiConnections: vi.fn(
    async (): Promise<{ success: boolean; data?: any[]; message?: string }> => ({
      success: true,
      data: [],
    }),
  ),
  mintAiConnectionTicket: vi.fn(async () => ({
    success: true,
    data: { ticket: "ticket-1", operationId: "op_1" },
  })),
}));

vi.mock("@/actions/aiConnection.actions", () => actionMocks);

const RUNTIME_DISPLAY = {
  CODEX_RUNTIME: "OpenAI Codex CLI",
  CLAUDE_RUNTIME: "Anthropic Claude Code",
  OPENCODE_RUNTIME: "OpenCode CLI",
  GROK_RUNTIME: "xAI Grok CLI",
  CURSOR_RUNTIME: "Cursor Agent CLI",
  DEVIN_RUNTIME: "Devin CLI",
  ANTIGRAVITY_RUNTIME: "Antigravity CLI",
} as const;

const CAPABILITY_STUB = (backendKind: string) => ({
  backendKind,
  displayName: RUNTIME_DISPLAY[backendKind as keyof typeof RUNTIME_DISPLAY],
  runtimeVendor: backendKind.split("_")[0],
  supportedAccountProviders: [],
  implemented: true,
  capabilities: {
    accountLogin: true,
    browserLogin: true,
    deviceLogin: false,
    authVerification: "STATUS_COMMAND",
    accountIdentity: true,
    dynamicModelDiscovery: true,
    customModel: true,
    localOneShot: true,
    acp: false,
    install: { available: true, executionEnabled: false },
    update: {
      available: true,
      executionEnabled: false,
      selfUpdate: true,
      autoUpdate: "NONE_OBSERVED",
    },
    multiAccountIsolation: true,
  },
  login: {
    interaction:
      backendKind === "DEVIN_RUNTIME" ||
      backendKind === "OPENCODE_RUNTIME" ||
      backendKind === "ANTIGRAVITY_RUNTIME"
        ? "VISIBLE_CONSOLE"
        : backendKind === "CODEX_RUNTIME" || backendKind === "CLAUDE_RUNTIME"
          ? "RUNTIME_MANAGED_BROWSER"
          : "BROWSER",
    surfacesAuthorizationUrl: ["GROK_RUNTIME", "CURSOR_RUNTIME"].includes(
      backendKind,
    ),
  },
  auth: {
    verification: "STATUS_COMMAND",
    accountIdentity: true,
    requiredMethod: null,
  },
  models: { strategy: "RUNTIME", dynamicDiscovery: true, customModel: true },
  execution: { localOneShot: true },
  permission: {
    level: "BEST_EFFORT_RUNTIME_PERMISSIONS",
    osSandbox: "NONE",
    toolRestriction: "DENY_ALL",
    summary: "",
  },
  profile: {
    strategy: "PROFILE_DIR_ENV",
    credentialBoundary: ["X_HOME"],
    isolationRoots: [],
    browserLoginEnvPassthrough: [],
  },
  verification: {
    realLoginE2E: "PENDING",
    authProbe: "PASS",
    realModelCatalog: "PENDING",
    realInferenceE2E: "PENDING",
    adversarialPermissions: "PENDING",
  },
});

function installBridges({
  state = "READY",
  connections = [] as any[],
}: { state?: string; connections?: any[] } = {}) {
  actionMocks.listAiConnections.mockImplementation(async () => ({
    success: true,
    data: connections,
  }));
  window.vocatryaRuntime = {
    list: vi.fn(async () =>
      Object.keys(RUNTIME_DISPLAY).map((backendKind) => ({
        backendKind,
        runtimeVendor: "V",
        supportedAccountProviders: [],
        displayName:
          RUNTIME_DISPLAY[backendKind as keyof typeof RUNTIME_DISPLAY],
        profileStrategy: "PROFILE_DIR_ENV",
        capabilities: CAPABILITY_STUB(backendKind),
      })),
    ),
    detect: vi.fn(async (backendKind: string) => ({
      backendKind,
      runtimeVendor: "V",
      state,
      installed: state !== "NOT_INSTALLED",
      version: state === "READY" ? "1.0.0" : undefined,
    })),
    getVersion: vi.fn(async () => ({
      backendKind: "",
      installed: false,
      version: null,
      state: "NOT_INSTALLED",
    })),
    getStatus: vi.fn(async () => ({
      backendKind: "",
      runtimeVendor: "V",
      state,
      installed: state !== "NOT_INSTALLED",
      authState: null,
    })),
    getInstallInfo: vi.fn(async () => ({
      backendKind: "",
      executionEnabled: false,
      methods: [
        {
          kind: "winget",
          summary: "winget install vendor.runtime",
          executable: "winget",
          args: ["install", "vendor.runtime"],
          documentationUrl: "https://example.com/install",
        },
      ],
    })),
    getUpdateInfo: vi.fn(async () => ({
      backendKind: "",
      executionEnabled: false,
      methods: [
        {
          kind: "self-update",
          summary: "runtime update",
          executable: "runtime",
          args: ["update"],
        },
      ],
    })),
  } as any;
  window.vocatryaAi = {
    startLogin: vi.fn(async () => ({ ok: true, connection: {} })),
    cancelOperation: vi.fn(async () => ({ ok: true, cancelled: true })),
    reconnect: vi.fn(async () => ({ ok: true, connection: {} })),
    disconnect: vi.fn(async () => ({ ok: true, connection: {} })),
    verify: vi.fn(async () => ({ ok: true, connection: {} })),
    listModels: vi.fn(async () => ({ ok: true, models: [] })),
    runSmoke: vi.fn(async () => ({ ok: true, matched: true, text: "ok" })),
    onOAuthUrl: vi.fn(() => () => {}),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete window.vocatryaRuntime;
  delete window.vocatryaAi;
});

describe("AiConnectionsCard", () => {
  it("shows the authorization link during reconnect and clears it when login ends", async () => {
    installBridges({ connections: [{ id: "reconnect-test", backendKind: "CODEX_RUNTIME", displayName: "Reconnect account", status: "REAUTH_REQUIRED" }] });
    let emitUrl!: (url: string) => void;
    window.vocatryaAi!.onOAuthUrl = vi.fn((handler) => {
      emitUrl = handler;
      return () => {};
    });
    let finish!: (value: { ok: false; code: string }) => void;
    window.vocatryaAi!.reconnect = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    render(<AiConnectionsCard />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(window.vocatryaAi!.reconnect).toHaveBeenCalled());
    act(() => emitUrl("https://auth.openai.com/authorize?test=reconnect"));
    expect(await screen.findByRole("button", { name: "Open authorization page" })).toBeInTheDocument();
    await act(async () => finish({ ok: false, code: "AUTH_CANCELLED" }));
    expect(screen.queryByRole("button", { name: "Open authorization page" })).not.toBeInTheDocument();
  });

  it("reports a failed manual recheck after a successful automatic check", async () => {
    installBridges();
    window.vocatryaRuntime!.checkUpdate = vi.fn(async (_backendKind, options) => {
      if (options?.force) throw new Error("IPC unavailable");
      return {
        currentVersion: "1.0.0",
        check: { status: "UP_TO_DATE", latestVersion: "1.0.0", error: null },
        compatibility: { current: null },
      } as any;
    });
    const user = userEvent.setup();
    render(<AiConnectionsCard />);
    const card = (await screen.findByText("via OpenAI Codex CLI")).closest("section")!;
    await waitFor(() => expect(within(card).getByText(/Up to date/)).toBeInTheDocument());
    await user.click(within(card).getByRole("button", { name: /Recheck/ }));
    await waitFor(() => expect(within(card).getByText(/Update check failed/)).toBeInTheDocument());
    expect(within(card).queryByText(/Up to date/)).not.toBeInTheDocument();
  });

  it("shows the Codex version in use, verified versions and multiple installs with stale marked", async () => {
    installBridges();
    const NPM = "C:/u/npm/@openai/codex/vendor/codex.exe";
    const OLD = "C:/u/Programs/OpenAI/Codex/bin/codex.exe";
    const STALE = "C:/u/npm/@openai/.codex-AbCd/codex.exe";
    const detect = window.vocatryaRuntime!.detect as any;
    window.vocatryaRuntime!.detect = vi.fn(async (backendKind: string) =>
      backendKind === "CODEX_RUNTIME"
        ? {
            backendKind, runtimeVendor: "V", state: "READY", installed: true,
            executablePath: OLD, version: "0.165.0", verifiedVersions: ["0.169.0", "0.170.0"],
            installs: [
              { path: OLD, source: "standalone", version: "0.165.0", verified: false, stale: false, selected: true, selectedFor: ["default", "exec"] },
              { path: NPM, source: "npm", version: "0.170.0", verified: true, stale: false, selected: false, selectedFor: ["native"] },
              { path: STALE, source: "npm-staging", version: "0.170.0", verified: true, stale: true, selected: false, selectedFor: [] },
            ],
          }
        : detect(backendKind),
    ) as any;
    render(<AiConnectionsCard />);
    const card = (await screen.findByText("via OpenAI Codex CLI")).closest("section")!;
    const installs = await within(card).findByTestId("runtime-installs");
    expect(installs).toHaveTextContent(`In use: v0.165.0 · ${OLD}`);
    expect(installs).toHaveTextContent(`Native sessions: v0.170.0 · ${NPM}`);
    expect(installs).not.toHaveTextContent("Streaming: v");
    expect(installs).toHaveTextContent("Verified versions: v0.169.0, v0.170.0");
    expect(installs).toHaveTextContent("Multiple installs detected");
    const rows = within(installs).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("v0.165.0");
    expect(rows[0]).toHaveTextContent("not verified");
    expect(rows[0]).toHaveTextContent("in use");
    expect(rows[0]).toHaveTextContent("streaming");
    expect(rows[1]).toHaveTextContent("native");
    expect(rows[1]).not.toHaveTextContent("in use");
    expect(rows[2]).toHaveTextContent("stale");
    expect(rows[2]).not.toHaveTextContent("in use");
  });

  it("renders nothing outside the desktop bridge", () => {
    const { container } = render(<AiConnectionsCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders every account runtime with product and runtime labels", async () => {
    installBridges();
    render(<AiConnectionsCard />);
    await waitFor(() => {
      expect(screen.getByText("Connect Devin")).toBeInTheDocument();
      expect(screen.getByText("Connect Antigravity")).toBeInTheDocument();
    });
    expect(screen.getByText("via OpenAI Codex CLI")).toBeInTheDocument();
    expect(screen.getByText("via OpenCode CLI")).toBeInTheDocument();
    expect(screen.getByText("Connect ChatGPT")).toBeInTheDocument();
    // OpenCode is its own account ecosystem: the card offers Go/Zen and
    // never presents a ChatGPT login.
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(screen.getByText("Connect OpenCode Go")).toBeInTheDocument();
    expect(screen.getByText("Connect OpenCode Zen")).toBeInTheDocument();
    expect(
      screen.queryByText(/ChatGPT via OpenCode/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Connect Claude")).toBeInTheDocument();
    expect(screen.getByText("Connect Grok")).toBeInTheDocument();
    expect(screen.getByText("Connect Cursor")).toBeInTheDocument();
    // Runtime state chips are rendered per backend.
    expect(screen.getAllByText(/^Ready/).length).toBe(7);
  });

  it("disables connect and shows install info when the runtime is missing", async () => {
    installBridges({ state: "NOT_INSTALLED" });
    render(<AiConnectionsCard />);
    await waitFor(() =>
      expect(
        screen.getAllByText("winget install vendor.runtime").length,
      ).toBeGreaterThan(0),
    );
    for (const label of [
      "Connect ChatGPT",
      "Connect Claude",
      "Connect OpenCode Go",
      "Connect OpenCode Zen",
      "Connect Grok",
      "Connect Cursor",
      "Connect Devin",
    ]) {
      expect(
        screen.getByRole("button", { name: label }),
      ).toBeDisabled();
    }
    expect(screen.getAllByText("Installation guide").length).toBe(7);
  });

  it("connects through the unified ticket + startLogin path", async () => {
    installBridges();
    const user = userEvent.setup();
    render(<AiConnectionsCard />);
    const connect = await screen.findByRole("button", {
      name: "Connect Claude",
    });
    await user.click(connect);
    expect(actionMocks.mintAiConnectionTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "login",
        backendKind: "CLAUDE_RUNTIME",
        accountProvider: "ANTHROPIC",
      }),
    );
    expect(window.vocatryaAi!.startLogin).toHaveBeenCalledWith({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "ticket-1",
    });
  });

  it("pins the chosen OpenCode product on the login ticket", async () => {
    installBridges();
    const user = userEvent.setup();
    render(<AiConnectionsCard />);
    await user.click(
      await screen.findByRole("button", { name: "Connect OpenCode Go" }),
    );
    expect(actionMocks.mintAiConnectionTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "login",
        backendKind: "OPENCODE_RUNTIME",
        accountProvider: "OPENCODE_GO",
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Connect OpenCode Zen" }),
    );
    expect(actionMocks.mintAiConnectionTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "login",
        backendKind: "OPENCODE_RUNTIME",
        accountProvider: "OPENCODE_ZEN",
      }),
    );
  });

  it("renders connection rows with runtime label and lifecycle actions", async () => {
    installBridges({
      connections: [
        {
          id: "c1",
          userId: "u1",
          provider: "OPENAI",
          authType: "ACCOUNT_LOGIN",
          backendKind: "CODEX_RUNTIME",
          displayName: "ChatGPT via Codex",
          accountIdentity: "me@example.com",
          status: "CONNECTED",
          credentialRef: null,
          runtimeProfileRef: "rp_11111111-1111-4111-8111-111111111111",
          lastVerifiedAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const user = userEvent.setup();
    render(<AiConnectionsCard />);
    await screen.findByText("ChatGPT via Codex");
    expect(screen.getByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(actionMocks.mintAiConnectionTicket).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "verify", connectionId: "c1" }),
    );
    expect(window.vocatryaAi!.verify).toHaveBeenCalledWith({
      connectionId: "c1",
      ticket: "ticket-1",
    });
  });
});

it("keeps recorded connections in the center and new services in the rail", async () => {
  installBridges({ connections: [{ id: "saved", backendKind: "CODEX_RUNTIME", displayName: "Saved account", status: "REAUTH_REQUIRED" }] });
  render(<AiServicesLayout><AiConnectionsCard /></AiServicesLayout>);
  await within(screen.getByTestId("ai-services-account-connected")).findByText("Saved account");
  expect(within(screen.getByTestId("ai-services-account-available")).getByText("Claude")).toBeInTheDocument();
  expect(within(screen.getByTestId("ai-services-account-available")).queryByText("Saved account")).not.toBeInTheDocument();
});

it("shows an honest desktop-only notice in the Web rail", () => {
  render(<AiServicesLayout><AiConnectionsCard /></AiServicesLayout>);
  expect(within(screen.getByTestId("ai-services-account-available")).getByText(/Account sign-in is available in the desktop app/)).toBeInTheDocument();
});

it("keeps installation guidance reachable from a disabled compact service", async () => {
  installBridges({ state: "NOT_INSTALLED" });
  render(<AiServicesLayout><AiConnectionsCard /></AiServicesLayout>);
  const connect = await screen.findByRole("button", { name: "Connect Claude" });
  expect(connect).toBeDisabled();
  expect(screen.queryByText("winget install vendor.runtime")).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Claude" }));
  const detail = await screen.findByRole("dialog");
  expect(within(detail).getByText("winget install vendor.runtime")).toBeInTheDocument();
  expect(within(detail).getByRole("button", { name: "Installation guide" })).toBeEnabled();
});

it("uses the selected OpenCode product from the compact connect menu", async () => {
  installBridges();
  render(<AiServicesLayout><AiConnectionsCard /></AiServicesLayout>);
  const name = await screen.findByRole("button", { name: "OpenCode" });
  const row = name.parentElement!.parentElement!;
  const user = userEvent.setup();
  const connect = within(row).getByRole("button", { name: "Connect" });
  await waitFor(() => expect(connect).toBeEnabled());
  await user.click(connect);
  await user.click(await screen.findByRole("menuitem", { name: "Connect OpenCode Zen" }));
  expect(actionMocks.mintAiConnectionTicket).toHaveBeenCalledWith(expect.objectContaining({ backendKind: "OPENCODE_RUNTIME", accountProvider: "OPENCODE_ZEN" }));
});

// Re-clicking "Connect" on an already-connected provider mints a duplicate
// connection row and another login jump — the button hides per provider
// (Go connected still offers Zen, a different product on the same runtime).
it("hides connect for providers that already have a connection row", async () => {
  installBridges({
    connections: [
      {
        id: "c1",
        provider: "OPENAI",
        authType: "ACCOUNT_LOGIN",
        backendKind: "CODEX_RUNTIME",
        displayName: "ChatGPT via Codex",
        status: "CONNECTED",
      },
      {
        id: "c2",
        provider: "OPENCODE_GO",
        authType: "ACCOUNT_LOGIN",
        backendKind: "OPENCODE_RUNTIME",
        displayName: "OpenCode Go",
        status: "DISCONNECTED",
      },
    ],
  });
  render(<AiConnectionsCard />);
  await screen.findByText("ChatGPT via Codex");
  expect(
    screen.queryByRole("button", { name: "Connect ChatGPT" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Connect OpenCode Go" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Connect OpenCode Zen" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Connect Claude" }),
  ).toBeInTheDocument();
});

it("mirrors a REAUTH_REQUIRED connection into one top-left error notice", async () => {
  resetErrorNoticesForTests();
  installBridges({ connections: [
    { id: "a", backendKind: "CODEX_RUNTIME", displayName: "A", status: "REAUTH_REQUIRED" },
    { id: "b", backendKind: "CLAUDE_RUNTIME", displayName: "B", status: "REAUTH_REQUIRED" },
  ] });
  render(<><ErrorNoticeHost /><AiServicesLayout><AiConnectionsCard /></AiServicesLayout></>);
  const notices = await screen.findAllByTestId("error-notice");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toHaveAttribute("data-kind", "ai-connection:REAUTH_REQUIRED");
  resetErrorNoticesForTests();
});
