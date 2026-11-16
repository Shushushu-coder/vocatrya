// SET-AI-SERVICES purpose rows: every registered purpose now resolves a
// real production consumer on every surface, so all rows render editable.
// CAREER_REFLECTION runs interview reflection AI drafts through the
// TEXT_ONLY one-shot seam; MATCH_ANALYSIS is resolved by the fresh-native
// fast-screening flow. This spec guards the honest-capability invariant:
// no purpose renders a fake or non-interactive "Not provided" row.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toastError } from "@/lib/toast";
import AiAssignmentsCard from "@/components/settings/AiAssignmentsCard";
import { CareerSurfacesProvider } from "@/context/CareerSurfacesContext";
import { clearBusinessAiAssignment, listBusinessAiAssignments, setBusinessAiAssignment } from "@/actions/aiAssignment.actions";

vi.mock("@/i18n", () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock("@/actions/shared", () => ({ requireUser: () => ({ id: "u" }) }));
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
// The real list actions run against this mocked projection — no connections,
// so the card exercises pure purpose-row rendering.
vi.mock("@/lib/db", () => ({
  default: {
    aIConnection: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => null),
    },
    apiKey: { findMany: vi.fn(async () => []) },
  },
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

const MATCH_ROW_TESTID = "ai-assign-row-MATCH_ANALYSIS";
const REFLECTION_ROW_TESTID = "ai-assign-row-CAREER_REFLECTION";

describe("AiAssignmentsCard — all purposes editable now that consumers exist", () => {
  beforeEach(() => {
    vi.mocked(listBusinessAiAssignments).mockResolvedValue({ success: true, data: [] });
  });

  it("renders every purpose as an editable row on the default surface", async () => {
    render(<AiAssignmentsCard />);
    await waitFor(() =>
      expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByRole("combobox")).toHaveLength(6);
    expect(
      screen.queryByTestId("ai-assign-unavailable-CAREER_REFLECTION"),
    ).not.toBeInTheDocument();
    const row = screen.getByTestId(REFLECTION_ROW_TESTID);
    expect(
      within(row).getByText("settings.aiAssignPurposeCareerReflection"),
    ).toBeInTheDocument();
    // The editable row offers the connection picker and model input.
    expect(within(row).getByRole("combobox")).toBeInTheDocument();
    expect(within(row).getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByTestId(MATCH_ROW_TESTID)).toBeInTheDocument();
  });

  it("keeps MATCH_ANALYSIS editable on the fresh-native full surface", async () => {
    render(
      <CareerSurfacesProvider freshNativeFull={true}>
        <AiAssignmentsCard />
      </CareerSurfacesProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0),
    );
    // The fresh-native fast-screening flow resolves MATCH_ANALYSIS, so the
    // full surface no longer marks it "Not provided".
    expect(
      screen.queryByTestId("ai-assign-unavailable-MATCH_ANALYSIS"),
    ).not.toBeInTheDocument();
    const matchRow = screen.getByTestId(MATCH_ROW_TESTID);
    expect(
      within(matchRow).getByText("settings.aiAssignPurposeMatchAnalysis"),
    ).toBeInTheDocument();
    expect(within(matchRow).getByRole("combobox")).toBeInTheDocument();
    expect(within(matchRow).getByRole("textbox")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(6);
    expect(screen.getByTestId(REFLECTION_ROW_TESTID)).toBeInTheDocument();
  });

  it("renders saved MATCH_ANALYSIS and CAREER_REFLECTION pairs on every surface", async () => {
    vi.mocked(listBusinessAiAssignments).mockResolvedValue({
      success: true,
      data: ["MATCH_ANALYSIS", "CAREER_REFLECTION"].map((purpose) => ({
        id: purpose, purpose, connectionId: "saved-connection", model: `${purpose}-model`,
        connection: { id: "saved-connection", provider: "DEEPSEEK", backendKind: "LOCAL_BYOK", displayName: "Saved BYOK", status: "CONNECTED" },
      })),
    });
    const view = render(<CareerSurfacesProvider freshNativeFull={true}><AiAssignmentsCard /></CareerSurfacesProvider>);
    await screen.findByTestId(MATCH_ROW_TESTID);
    expect(
      screen.getByDisplayValue("MATCH_ANALYSIS-model"),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("CAREER_REFLECTION-model"),
    ).toBeInTheDocument();
    view.rerender(<CareerSurfacesProvider freshNativeFull={false}><AiAssignmentsCard /></CareerSurfacesProvider>);
    expect(screen.getByDisplayValue("MATCH_ANALYSIS-model")).toBeInTheDocument();
    expect(clearBusinessAiAssignment).not.toHaveBeenCalled();
    expect(setBusinessAiAssignment).not.toHaveBeenCalled();
  });

  it("shows only editable purpose rows once assignments finish loading", async () => {
    let resolve!: (value: { success: boolean; data: [] }) => void;
    vi.mocked(listBusinessAiAssignments).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<CareerSurfacesProvider freshNativeFull={true}><AiAssignmentsCard /></CareerSurfacesProvider>);
    expect(screen.getByText("settings.loadingSettings")).toBeInTheDocument();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    await act(async () => { resolve({ success: true, data: [] }); });
    expect(
      screen.queryByTestId("ai-assign-unavailable-MATCH_ANALYSIS"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId(MATCH_ROW_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(REFLECTION_ROW_TESTID)).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(6);
  });
});

it("keeps other edits when one assignment is saved and restores saved values after remount", async () => {
  const rows = ["MATCH_ANALYSIS", "CAREER_REFLECTION"].map((purpose) => ({
    id: purpose, purpose, connectionId: "saved-connection", model: `${purpose}-model`,
    connection: { id: "saved-connection", provider: "DEEPSEEK", backendKind: "LOCAL_BYOK", displayName: "Saved BYOK", status: "CONNECTED" },
  }));
  vi.mocked(listBusinessAiAssignments).mockImplementation(async () => ({ success: true, data: rows.map(row => ({ ...row })) }));
  vi.mocked(setBusinessAiAssignment).mockImplementation(async (input) => {
    Object.assign(rows.find(row => row.purpose === input.purpose)!, { model: input.model });
    return { success: true, data: { ...rows.find(row => row.purpose === input.purpose)! } };
  });
  const view = render(<AiAssignmentsCard />);
  await screen.findByDisplayValue("MATCH_ANALYSIS-model");
  fireEvent.change(screen.getByDisplayValue("MATCH_ANALYSIS-model"), { target: { value: "new-match" } });
  fireEvent.change(screen.getByDisplayValue("CAREER_REFLECTION-model"), { target: { value: "draft-reflection" } });
  fireEvent.click(within(screen.getByTestId(MATCH_ROW_TESTID)).getByRole("button", { name: "common.save" }));
  await screen.findByDisplayValue("new-match");
  expect(screen.getByDisplayValue("draft-reflection")).toBeInTheDocument();
  view.unmount();
  render(<AiAssignmentsCard />);
  await screen.findByDisplayValue("new-match");
  expect(screen.getByDisplayValue("CAREER_REFLECTION-model")).toBeInTheDocument();
  expect(within(screen.getByTestId(MATCH_ROW_TESTID)).getByRole("combobox")).toHaveTextContent("Saved BYOK");
});

it("retains a saved pair when clearing cannot be confirmed", async () => {
  vi.mocked(listBusinessAiAssignments).mockResolvedValue({ success: true, data: [{
    id: "saved", purpose: "MATCH_ANALYSIS", connectionId: "saved-connection", model: "keep-model",
    connection: { id: "saved-connection", provider: "DEEPSEEK", backendKind: "LOCAL_BYOK", displayName: "Saved BYOK", status: "CONNECTED" },
  }] });
  vi.mocked(clearBusinessAiAssignment).mockRejectedValueOnce(new Error("transport"));
  render(<AiAssignmentsCard />);
  await screen.findByDisplayValue("keep-model");
  fireEvent.click(within(screen.getByTestId(MATCH_ROW_TESTID)).getByRole("button", { name: "settings.aiAssignClear" }));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith("settings.aiAssignSaveUnconfirmed"));
  expect(screen.getByDisplayValue("keep-model")).toBeInTheDocument();
});

it("shows a retryable load error instead of presenting saved assignments as empty", async () => {
  vi.mocked(listBusinessAiAssignments).mockResolvedValueOnce({ success: false, message: "offline" });
  render(<AiAssignmentsCard />);
  expect(await screen.findByRole("alert")).toHaveTextContent("settings.aiAssignLoadFailed");
  expect(screen.queryByTestId(MATCH_ROW_TESTID)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "common.retry" })).toBeEnabled();
});
