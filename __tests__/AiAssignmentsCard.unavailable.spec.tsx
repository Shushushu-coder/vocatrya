// SET-AI-SERVICES honest-capability rows: a purpose is editable only when a
// real production consumer resolves it in the current runtime mode.
// CAREER_REFLECTION has no consumer in any mode; MATCH_ANALYSIS is consumed
// only by legacy-gated automation/match surfaces, so the fresh-native full
// surface also marks it "Not provided" instead of a saveable assignment.
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

const UNAVAILABLE_TESTID = "ai-assign-unavailable-CAREER_REFLECTION";
const MATCH_TESTID = "ai-assign-unavailable-MATCH_ANALYSIS";

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

  it("marks CAREER_REFLECTION Not provided and renders no controls for it", async () => {
    render(<AiAssignmentsCard />);
    // Editable purposes still render their connection pickers.
    await waitFor(() =>
      expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0),
    );
    const row = screen.getByTestId(UNAVAILABLE_TESTID);
    expect(
      within(row).getByText("settings.capabilityNotProvided"),
    ).toBeInTheDocument();
    expect(
      within(row).getByText("settings.aiAssignPurposeCareerReflection"),
    ).toBeInTheDocument();
    expectNoInteractiveControls(row);
    // Every other purpose keeps an editable picker outside fresh-native.
    expect(screen.getAllByRole("combobox")).toHaveLength(5);
    expect(screen.queryByTestId(MATCH_TESTID)).not.toBeInTheDocument();
  });

  it("also marks MATCH_ANALYSIS Not provided on the fresh-native full surface", async () => {
    render(
      <CareerSurfacesProvider freshNativeFull={true}>
        <AiAssignmentsCard />
      </CareerSurfacesProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0),
    );
    expect(screen.getByTestId(UNAVAILABLE_TESTID)).toBeInTheDocument();
    const matchRow = screen.getByTestId(MATCH_TESTID);
    expect(
      within(matchRow).getByText("settings.capabilityNotProvided"),
    ).toBeInTheDocument();
    expect(
      within(matchRow).getByText("settings.aiAssignPurposeMatchAnalysis"),
    ).toBeInTheDocument();
    expectNoInteractiveControls(matchRow);
    // GLOBAL_DEFAULT / RESUME / CAREER_DIALOGUE / INTERVIEW stay editable.
    expect(screen.getAllByRole("combobox")).toHaveLength(4);
  });

  it("preserves saved assignments while unavailable and exposes match again in Legacy", async () => {
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
    expectNoInteractiveControls(screen.getByTestId(UNAVAILABLE_TESTID));
    expect(screen.queryByDisplayValue("MATCH_ANALYSIS-model")).toBeNull();
    view.rerender(<CareerSurfacesProvider freshNativeFull={false}><AiAssignmentsCard /></CareerSurfacesProvider>);
    expect(screen.getByDisplayValue("MATCH_ANALYSIS-model")).toBeInTheDocument();
    expectNoInteractiveControls(screen.getByTestId(UNAVAILABLE_TESTID));
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
    expectNoInteractiveControls(screen.getByTestId(UNAVAILABLE_TESTID));
    expect(screen.getAllByRole("combobox")).toHaveLength(4);
  });
});
