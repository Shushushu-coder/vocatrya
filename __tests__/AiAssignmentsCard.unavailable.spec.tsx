// SET-AI-SERVICES honest-capability rows: a purpose is editable only when a
// real production consumer resolves it in the current runtime mode.
// CAREER_REFLECTION now has a consumer (interview reflection AI drafts run
// through the TEXT_ONLY one-shot seam), so it renders as a normal editable
// row gated on local one-shot capability like INTERVIEW. MATCH_ANALYSIS is
// consumed only by legacy-gated automation/match surfaces, so the
// fresh-native full surface still marks it "Not provided" instead of a
// saveable assignment.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import AiAssignmentsCard from "@/components/settings/AiAssignmentsCard";
import { CareerSurfacesProvider } from "@/context/CareerSurfacesContext";
import { clearBusinessAiAssignment, listBusinessAiAssignments, setBusinessAiAssignment } from "@/actions/aiAssignment.actions";

vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
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

const MATCH_TESTID = "ai-assign-unavailable-MATCH_ANALYSIS";
const REFLECTION_ROW_TESTID = "ai-assign-row-CAREER_REFLECTION";

function expectNoInteractiveControls(container: HTMLElement) {
  expect(
    container.querySelector(
      'button, input, select, textarea, a[href], [role="switch"], [role="checkbox"], [tabindex]',
    ),
  ).toBeNull();
}

describe("AiAssignmentsCard — purposes without a reachable consumer", () => {
  beforeEach(() => {
    vi.mocked(listBusinessAiAssignments).mockResolvedValue({ success: true, data: [] });
  });

  it("renders CAREER_REFLECTION as an editable row now that a consumer resolves it", async () => {
    render(<AiAssignmentsCard />);
    await waitFor(() =>
      expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0),
    );
    // Every purpose is editable outside the fresh-native gate.
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
    expect(screen.queryByTestId(MATCH_TESTID)).not.toBeInTheDocument();
  });

  it("marks MATCH_ANALYSIS Not provided on the fresh-native full surface while CAREER_REFLECTION stays editable", async () => {
    render(
      <CareerSurfacesProvider freshNativeFull={true}>
        <AiAssignmentsCard />
      </CareerSurfacesProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0),
    );
    const matchRow = screen.getByTestId(MATCH_TESTID);
    expect(
      within(matchRow).getByText("settings.capabilityNotProvided"),
    ).toBeInTheDocument();
    expect(
      within(matchRow).getByText("settings.aiAssignPurposeMatchAnalysis"),
    ).toBeInTheDocument();
    expectNoInteractiveControls(matchRow);
    // GLOBAL_DEFAULT / RESUME / CAREER_REFLECTION / CAREER_DIALOGUE /
    // INTERVIEW stay editable on the full surface.
    expect(screen.getAllByRole("combobox")).toHaveLength(5);
    expect(screen.getByTestId(REFLECTION_ROW_TESTID)).toBeInTheDocument();
  });

  it("preserves a saved MATCH_ANALYSIS row while unavailable and keeps CAREER_REFLECTION editable", async () => {
    vi.mocked(listBusinessAiAssignments).mockResolvedValue({
      success: true,
      data: ["MATCH_ANALYSIS", "CAREER_REFLECTION"].map((purpose) => ({
        id: purpose, purpose, connectionId: "saved-connection", model: `${purpose}-model`,
        connection: { id: "saved-connection", provider: "DEEPSEEK", backendKind: "LOCAL_BYOK", displayName: "Saved BYOK", status: "CONNECTED" },
      })),
    });
    const view = render(<CareerSurfacesProvider freshNativeFull={true}><AiAssignmentsCard /></CareerSurfacesProvider>);
    await screen.findByTestId(MATCH_TESTID);
    expectNoInteractiveControls(screen.getByTestId(MATCH_TESTID));
    expect(screen.queryByDisplayValue("MATCH_ANALYSIS-model")).toBeNull();
    // A saved CAREER_REFLECTION assignment renders its saved pair — the
    // row is a normal editable purpose now.
    expect(
      screen.getByDisplayValue("CAREER_REFLECTION-model"),
    ).toBeInTheDocument();
    view.rerender(<CareerSurfacesProvider freshNativeFull={false}><AiAssignmentsCard /></CareerSurfacesProvider>);
    expect(screen.getByDisplayValue("MATCH_ANALYSIS-model")).toBeInTheDocument();
    expect(clearBusinessAiAssignment).not.toHaveBeenCalled();
    expect(setBusinessAiAssignment).not.toHaveBeenCalled();
  });

  it("does not expose unavailable controls while assignments load asynchronously", async () => {
    let resolve!: (value: { success: boolean; data: [] }) => void;
    vi.mocked(listBusinessAiAssignments).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<CareerSurfacesProvider freshNativeFull={true}><AiAssignmentsCard /></CareerSurfacesProvider>);
    expect(screen.getByText("settings.loadingSettings")).toBeInTheDocument();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    await act(async () => { resolve({ success: true, data: [] }); });
    expectNoInteractiveControls(screen.getByTestId(MATCH_TESTID));
    expect(screen.getByTestId(REFLECTION_ROW_TESTID)).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(5);
  });
});
