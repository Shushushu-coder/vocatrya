/**
 * Settings surface tests for the consolidated account-login card: the six
 * runtimes render through one shared path, provider+runtime labels
 * disambiguate the two ChatGPT entries, connect is gated on runtime
 * readiness (never silent-install), and per-connection operations mint a
 * ticket then call the unified IPC surface.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AiServicesLayout from "@/components/settings/AiServicesLayout";
import AiConnectionsCard from "@/components/settings/AiConnectionsCard";

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
      backendKind === "DEVIN_RUNTIME" || backendKind === "OPENCODE_RUNTIME"
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

  it("renders nothing outside the desktop bridge", () => {
    const { container } = render(<AiConnectionsCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders all six runtimes with product+runtime labels", async () => {
    installBridges();
    render(<AiConnectionsCard />);
    await waitFor(() =>
      expect(screen.getByText("Connect Devin")).toBeInTheDocument(),
    );
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
    expect(screen.getAllByText(/^Ready/).length).toBe(6);
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
    expect(screen.getAllByText("Installation guide").length).toBe(6);
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
