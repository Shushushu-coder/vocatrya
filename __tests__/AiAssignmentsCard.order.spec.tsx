// Business-purpose grid ordering: GLOBAL_DEFAULT renders as its own
// full-width row above the reorderable grid; the business order is a
// per-device display preference stored in localStorage. A stored order
// must merge safely — unknown purposes dropped, new purposes appended —
// so it can never hide a row.
import { render, screen, waitFor } from "@testing-library/react";
import AiAssignmentsCard from "@/components/settings/AiAssignmentsCard";
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
  window.localStorage.removeItem(APP_CONSTANTS.AI_ASSIGNMENT_ORDER_STORAGE_KEY);
});

it("renders the global default as its own row above the registry-ordered business grid", async () => {
  render(<AiAssignmentsCard />);
  await waitFor(() =>
    expect(screen.getByTestId("ai-assign-row-RESUME")).toBeInTheDocument(),
  );
  expect(rowOrder()).toEqual([
    "ai-assign-row-GLOBAL_DEFAULT",
    "ai-assign-row-RESUME",
    "ai-assign-row-MATCH_ANALYSIS",
    "ai-assign-row-CAREER_REFLECTION",
    "ai-assign-row-CAREER_DIALOGUE",
    "ai-assign-row-INTERVIEW",
  ]);
});

it("applies a stored business order while the global default stays pinned first", async () => {
  window.localStorage.setItem(
    APP_CONSTANTS.AI_ASSIGNMENT_ORDER_STORAGE_KEY,
    JSON.stringify(["INTERVIEW", "CAREER_DIALOGUE", "RESUME", "MATCH_ANALYSIS", "CAREER_REFLECTION"]),
  );
  render(<AiAssignmentsCard />);
  await waitFor(() =>
    expect(screen.getAllByTestId(/^ai-assign-row-/)).toHaveLength(6),
  );
  expect(rowOrder()).toEqual([
    "ai-assign-row-GLOBAL_DEFAULT",
    "ai-assign-row-INTERVIEW",
    "ai-assign-row-CAREER_DIALOGUE",
    "ai-assign-row-RESUME",
    "ai-assign-row-MATCH_ANALYSIS",
    "ai-assign-row-CAREER_REFLECTION",
  ]);
});

it("drops unknown entries and appends purposes missing from a stale stored order", async () => {
  window.localStorage.setItem(
    APP_CONSTANTS.AI_ASSIGNMENT_ORDER_STORAGE_KEY,
    JSON.stringify(["INTERVIEW", "REMOVED_PURPOSE", "RESUME"]),
  );
  render(<AiAssignmentsCard />);
  await waitFor(() =>
    expect(screen.getAllByTestId(/^ai-assign-row-/)).toHaveLength(6),
  );
  expect(rowOrder()).toEqual([
    "ai-assign-row-GLOBAL_DEFAULT",
    "ai-assign-row-INTERVIEW",
    "ai-assign-row-RESUME",
    "ai-assign-row-MATCH_ANALYSIS",
    "ai-assign-row-CAREER_REFLECTION",
    "ai-assign-row-CAREER_DIALOGUE",
  ]);
});

it("exposes drag handles on business rows only — the global default row is fixed", async () => {
  render(<AiAssignmentsCard />);
  await waitFor(() =>
    expect(screen.getByTestId("ai-assign-row-RESUME")).toBeInTheDocument(),
  );
  for (const purpose of [
    "RESUME",
    "MATCH_ANALYSIS",
    "CAREER_REFLECTION",
    "CAREER_DIALOGUE",
    "INTERVIEW",
  ]) {
    expect(
      screen.getByTestId(`ai-assign-drag-${purpose}`),
    ).toBeInTheDocument();
  }
  expect(
    screen.queryByTestId("ai-assign-drag-GLOBAL_DEFAULT"),
  ).not.toBeInTheDocument();
});
