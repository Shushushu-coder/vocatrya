// Version probes spawn a process on the Electron main thread. The card
// must show assignments before those probes finish, probe only runtimes
// the user can actually assign, and reuse the result when the section
// is opened again.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AiAssignmentsCard, {
  clearAiAssignmentsSessionCache,
} from "@/components/settings/AiAssignmentsCard";

const { getVersion, listConnections } = vi.hoisted(() => ({
  getVersion: vi.fn(),
  listConnections: vi.fn(async () => ({
    success: true,
    data: [
      {
        id: "codex-1",
        provider: "OPENAI",
        authType: "ACCOUNT_LOGIN",
        backendKind: "CODEX_RUNTIME",
        displayName: "Codex",
        accountIdentity: null,
        status: "CONNECTED",
        runtimeProfileRef: null,
        lastVerifiedAt: null,
        createdAt: new Date(),
      },
    ],
  })),
}));

vi.mock("@/i18n", () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/actions/aiConnection.actions", () => ({
  listAssignableAiConnections: listConnections,
  mintAiConnectionTicket: vi.fn(),
}));
vi.mock("@/actions/aiAssignment.actions", () => ({
  listBusinessAiAssignments: vi.fn(async () => ({ success: true, data: [] })),
  resolveBusinessAiConfig: async () => ({
    success: true,
    data: { status: "NOT_CONFIGURED" },
  }),
  clearBusinessAiAssignment: vi.fn(),
  setBusinessAiAssignment: vi.fn(),
}));
vi.mock("@/actions/managedAi.actions", () => ({
  getManagedAiOverview: async () => ({
    success: true,
    data: {
      availability: "COMING_SOON",
      connection: null,
      entitlement: null,
      usage: null,
      models: [],
      errorCode: null,
    },
  }),
  assignManagedBusinessAiSource: vi.fn(),
}));

const DIALOGUE_ROW = "ai-assign-row-AGENT_PILOT";

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
});

beforeEach(() => {
  clearAiAssignmentsSessionCache();
  getVersion.mockReset();
  window.vocatryaRuntime = {
    list: async () => [
      {
        backendKind: "CODEX_RUNTIME",
        runtimeVendor: "OPENAI",
        supportedAccountProviders: ["OPENAI"],
        displayName: "Codex",
        profileStrategy: "PROFILE_DIR_ENV",
        capabilities: {
          implemented: true,
          execution: { localOneShot: true, streaming: false },
        },
      },
      {
        backendKind: "CLAUDE_RUNTIME",
        runtimeVendor: "ANTHROPIC",
        supportedAccountProviders: ["ANTHROPIC"],
        displayName: "Claude",
        profileStrategy: "PROFILE_DIR_ENV",
        capabilities: {
          implemented: true,
          execution: { localOneShot: true, streaming: false },
        },
      },
    ],
    getVersion,
  } as unknown as NonNullable<Window["vocatryaRuntime"]>;
});

afterEach(() => {
  delete window.vocatryaRuntime;
});

async function openDialoguePicker() {
  const user = userEvent.setup();
  await user.click(within(screen.getByTestId(DIALOGUE_ROW)).getByRole("combobox"));
  return user;
}

it("shows assignments before version probes finish and only probes assigned runtimes", async () => {
  let resolveVersion: (value: { version: string | null }) => void = () => undefined;
  getVersion.mockImplementation(() => new Promise((resolve) => {
    resolveVersion = resolve;
  }));

  render(<AiAssignmentsCard />);

  await waitFor(() =>
    expect(screen.queryByText("settings.loadingSettings")).not.toBeInTheDocument(),
  );
  expect(screen.getByTestId(DIALOGUE_ROW)).toBeInTheDocument();
  expect(getVersion).toHaveBeenCalledTimes(1);
  expect(getVersion).toHaveBeenCalledWith("CODEX_RUNTIME");
  expect(getVersion).not.toHaveBeenCalledWith("CLAUDE_RUNTIME");

  await openDialoguePicker();
  expect(
    await screen.findByRole("option", { name: /settings\.aiAssignRuntimeChecking/ }),
  ).toBeInTheDocument();

  await act(async () => {
    resolveVersion({ version: null });
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("option", { name: /settings\.aiAssignRuntimeChecking/ }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("option", { name: /settings\.aiAssignStreamingNotReady/ }),
  ).toBeInTheDocument();
});

it("paints the cached card on return without probing runtimes again", async () => {
  getVersion.mockResolvedValue({ version: null });
  const first = render(<AiAssignmentsCard />);
  await screen.findByTestId(DIALOGUE_ROW);
  await waitFor(() => expect(getVersion).toHaveBeenCalledTimes(1));
  const readsBeforeReturn = listConnections.mock.calls.length;

  first.unmount();
  render(<AiAssignmentsCard />);

  expect(screen.queryByText("settings.loadingSettings")).not.toBeInTheDocument();
  expect(screen.getByTestId(DIALOGUE_ROW)).toBeInTheDocument();
  await waitFor(() =>
    expect(listConnections.mock.calls.length).toBeGreaterThan(readsBeforeReturn),
  );
  expect(getVersion).toHaveBeenCalledTimes(1);
});
