// Business-purpose grid ordering: GLOBAL_DEFAULT renders as its own
// full-width row above the reorderable grid; the business order is a
// per-device display preference stored in localStorage. A stored order
// must merge safely — unknown purposes dropped, new purposes appended —
// so it can never hide a row.
import { render, screen, waitFor } from "@testing-library/react";
import AiAssignmentsCard, {
  clearAiAssignmentsSessionCache,
} from "@/components/settings/AiAssignmentsCard";
import { APP_CONSTANTS } from "@/lib/constants";

vi.mock("@/i18n", () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock("@/actions/shared", () => ({ requireUser: () => ({ id: "u" }) }));
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
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

const rowOrder = () =>
  screen
    .getAllByTestId(/^ai-assign-row-/)
    .map((row) => row.getAttribute("data-testid"));

beforeEach(() => {
  clearAiAssignmentsSessionCache();
  window.localStorage.removeItem(APP_CONSTANTS.AI_ASSIGNMENT_ORDER_STORAGE_KEY);
});

it("renders Base (Default + Router), AI Roles (Pilot/Insight/Reflect), and reorderable Specialized features in order", async () => {
  render(<AiAssignmentsCard />);
  await waitFor(() =>
    expect(screen.getByTestId("ai-assign-row-RESUME")).toBeInTheDocument(),
  );
  expect(rowOrder()).toEqual([
    "ai-assign-row-GLOBAL_DEFAULT",
    "ai-assign-row-AGENT_ROUTER",
    "ai-assign-row-AGENT_PILOT",
    "ai-assign-row-AGENT_INSIGHT",
    "ai-assign-row-AGENT_REFLECT",
    "ai-assign-row-RESUME",
    "ai-assign-row-MATCH_ANALYSIS",
    "ai-assign-row-CAREER_REFLECTION",
  ]);
  expect(screen.queryByTestId("ai-assign-row-INTERVIEW")).not.toBeInTheDocument();
  expect(screen.queryByTestId("ai-assign-row-CAREER_DIALOGUE")).not.toBeInTheDocument();
});

it("applies a stored specialized order while Base and AI Roles stay pinned first", async () => {
  window.localStorage.setItem(
    APP_CONSTANTS.AI_ASSIGNMENT_ORDER_STORAGE_KEY,
    JSON.stringify(["CAREER_REFLECTION", "MATCH_ANALYSIS", "RESUME"]),
  );
  render(<AiAssignmentsCard />);
  await waitFor(() =>
    expect(screen.getAllByTestId(/^ai-assign-row-/)).toHaveLength(8),
  );
  expect(rowOrder()).toEqual([
    "ai-assign-row-GLOBAL_DEFAULT",
    "ai-assign-row-AGENT_ROUTER",
    "ai-assign-row-AGENT_PILOT",
    "ai-assign-row-AGENT_INSIGHT",
    "ai-assign-row-AGENT_REFLECT",
    "ai-assign-row-CAREER_REFLECTION",
    "ai-assign-row-MATCH_ANALYSIS",
    "ai-assign-row-RESUME",
  ]);
});

it("drops unknown entries and appends specialized purposes missing from a stale stored order", async () => {
  window.localStorage.setItem(
    APP_CONSTANTS.AI_ASSIGNMENT_ORDER_STORAGE_KEY,
    JSON.stringify(["INTERVIEW", "REMOVED_PURPOSE", "CAREER_REFLECTION"]),
  );
  render(<AiAssignmentsCard />);
  await waitFor(() =>
    expect(screen.getAllByTestId(/^ai-assign-row-/)).toHaveLength(8),
  );
  expect(rowOrder()).toEqual([
    "ai-assign-row-GLOBAL_DEFAULT",
    "ai-assign-row-AGENT_ROUTER",
    "ai-assign-row-AGENT_PILOT",
    "ai-assign-row-AGENT_INSIGHT",
    "ai-assign-row-AGENT_REFLECT",
    "ai-assign-row-CAREER_REFLECTION",
    "ai-assign-row-RESUME",
    "ai-assign-row-MATCH_ANALYSIS",
  ]);
});

it("exposes drag handles on specialized rows only — Base and AI Role rows are fixed", async () => {
  render(<AiAssignmentsCard />);
  await waitFor(() =>
    expect(screen.getByTestId("ai-assign-row-RESUME")).toBeInTheDocument(),
  );
  for (const purpose of ["RESUME", "MATCH_ANALYSIS", "CAREER_REFLECTION"]) {
    expect(
      screen.getByTestId(`ai-assign-drag-${purpose}`),
    ).toBeInTheDocument();
  }
  for (const fixed of [
    "GLOBAL_DEFAULT",
    "AGENT_ROUTER",
    "AGENT_PILOT",
    "AGENT_INSIGHT",
    "AGENT_REFLECT",
  ]) {
    expect(
      screen.queryByTestId(`ai-assign-drag-${fixed}`),
    ).not.toBeInTheDocument();
  }
});
