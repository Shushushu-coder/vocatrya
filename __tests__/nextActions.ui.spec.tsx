// JOURNEY-OVERVIEW stage cards + NEXT-ACTIONS strip rendering contract
// (frozen §2.1–§2.4, §4.5): real routes only, capability-gated entries
// hidden rather than disabled, the agent slot only calls open(), and the
// suggestions block disappears entirely on a clean read.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import JourneySection from "@/components/dashboard/JourneySection";
import NextActions from "@/components/dashboard/NextActions";
import {
  NEXT_ACTION_RULE,
  type NextActionItem,
} from "@/lib/career/nextActionsContract";
import type { NextActionsData } from "@/actions/dashboard/nextActions";
import enFragment from "../.tmp/p2-overview-actions/i18n.en.json";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  surfaces: {
    freshNativeFull: false,
    jobMutationsEnabled: true,
    resumeV1Enabled: true,
    legacyResumeMutationsEnabled: true,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({ open: mocks.open }),
}));

vi.mock("@/context/CareerSurfacesContext", () => ({
  useCareerSurfaces: () => mocks.surfaces,
}));

const dict: Record<string, string> = {};
for (const [namespace, entries] of Object.entries(enFragment)) {
  for (const [key, value] of Object.entries(
    entries as Record<string, string>,
  )) {
    dict[`${namespace}.${key}`] = value;
  }
}

vi.mock("@/i18n", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/i18n")>();
  return {
    ...mod,
    useI18n: () => ({
      locale: "en",
      setLocale: () => {},
      t: (key: string, params?: Record<string, string | number>) =>
        (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) =>
          String(params?.[name] ?? `{${name}}`),
        ),
      formatDate: () => "",
      formatMonthYear: () => "",
      formatDateTime: () => "",
      formatNumber: () => "",
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.surfaces = {
    freshNativeFull: false,
    jobMutationsEnabled: true,
    resumeV1Enabled: true,
    legacyResumeMutationsEnabled: true,
  };
});

describe("JourneySection", () => {
  it("renders the three stage cards with real-route entries", () => {
    render(<JourneySection dataState="nonempty" jobsAbRead />);
    expect(screen.getByTestId("journey-overview")).toBeInTheDocument();
    expect(screen.getByText("Your job-search journey")).toBeInTheDocument();
    for (const stage of ["prepare", "act", "review"]) {
      expect(
        screen.getByTestId(`journey-stage-${stage}`),
      ).toBeInTheDocument();
    }
    for (const [testid, href] of [
      ["journey-entry-prepare-materials", "/dashboard/profile"],
      ["journey-entry-prepare-resumes", "/dashboard/profile/resumes"],
      ["journey-entry-prepare-questions", "/dashboard/questions"],
      ["journey-entry-act-jobs", "/dashboard/myjobs"],
      ["journey-entry-act-addJob", "/dashboard/myjobs?add-job=true"],
      ["journey-entry-act-upcoming", "/dashboard/myjobs?tab=upcoming"],
      ["journey-entry-act-tasks", "/dashboard/tasks"],
      ["journey-entry-act-addTask", "/dashboard/tasks?add-task=true"],
      ["journey-entry-review-reflection", "/dashboard/myjobs"],
      ["journey-entry-review-practice", "/dashboard/interview"],
    ] as const) {
      expect(screen.getByTestId(testid)).toHaveAttribute("href", href);
    }
  });

  it("switches the intro copy between empty and populated accounts", () => {
    const { rerender } = render(
      <JourneySection dataState="empty" jobsAbRead />,
    );
    expect(
      screen.getByText(/Start with Prepare, Act, Review/),
    ).toBeInTheDocument();
    rerender(<JourneySection dataState="nonempty" jobsAbRead />);
    expect(
      screen.getByText(/Work in three stages/),
    ).toBeInTheDocument();
  });

  it("hides gated entries instead of disabling them", () => {
    mocks.surfaces.jobMutationsEnabled = false;
    mocks.surfaces.resumeV1Enabled = false;
    render(<JourneySection dataState="nonempty" jobsAbRead={false} />);
    expect(
      screen.queryByTestId("journey-entry-act-addJob"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("journey-entry-prepare-resumes"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("journey-entry-act-upcoming"),
    ).not.toBeInTheDocument();
    // Ungated entries stay visible.
    expect(screen.getByTestId("journey-entry-act-jobs")).toBeInTheDocument();
  });

  it("opens the existing agent panel from every stage slot — nothing else", async () => {
    const user = userEvent.setup();
    render(<JourneySection dataState="nonempty" jobsAbRead />);
    const buttons = screen.getAllByRole("button", {
      name: /Ask Vocatrya/,
    });
    expect(buttons).toHaveLength(3);
    await user.click(buttons[0]);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    await user.click(buttons[2]);
    expect(mocks.open).toHaveBeenCalledTimes(2);
    // No conversation, message, or prefilled context: open() is the whole
    // contract and takes no arguments.
    expect(mocks.open).toHaveBeenCalledWith();
  });
});

describe("NextActions", () => {
  function data(partial: Partial<NextActionsData> = {}): NextActionsData {
    return {
      items: [],
      overflowCount: 0,
      timeZone: "Asia/Shanghai",
      jobsReadFamily: "ab",
      resumeReadFamily: "ab",
      ...partial,
    };
  }

  function item(
    partial: Omit<NextActionItem, "id" | "entityKey"> & {
      entityKey: string;
    },
  ): NextActionItem {
    return { ...partial, id: `${partial.ruleId}:${partial.entityKey}` };
  }

  it("renders nothing when no rule hits", () => {
    const { container } = render(<NextActions data={data()} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("next-actions")).not.toBeInTheDocument();
  });

  it("links each suggestion to its real surface", () => {
    render(
      <NextActions
        data={data({
          items: [
            item({
              ruleId: NEXT_ACTION_RULE.R1,
              entityKey: "account",
              variant: "default",
              href: "/dashboard/profile",
            }),
            item({
              ruleId: NEXT_ACTION_RULE.R4,
              entityKey: "opp-1",
              variant: "default",
              href: "/dashboard/profile/resumes",
              jobTitle: "Staff Engineer",
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText("Next steps")).toBeInTheDocument();
    expect(
      screen.getByTestId("next-action-R1:account"),
    ).toHaveAttribute("href", "/dashboard/profile");
    expect(
      screen.getByText("Start your career materials"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("next-action-R4:opp-1"),
    ).toHaveAttribute("href", "/dashboard/profile/resumes");
    expect(
      screen.getByText(/Staff Engineer/),
    ).toBeInTheDocument();
  });

  it("distinguishes the R5 prepare and confirm-status variants", () => {
    render(
      <NextActions
        data={data({
          items: [
            item({
              ruleId: NEXT_ACTION_RULE.R5,
              entityKey: "step-1",
              variant: "prepare",
              href: "/dashboard/myjobs/opp-1?tab=timeline",
              jobTitle: "Engineer",
              stepLabel: "Phone screen",
              attentionAt: "2026-11-15T01:00:00.000Z",
              overdue: false,
            }),
            item({
              ruleId: NEXT_ACTION_RULE.R5,
              entityKey: "step-2",
              variant: "confirmStatus",
              href: "/dashboard/myjobs/opp-2?tab=timeline",
              jobTitle: "Designer",
              stepLabel: "Onsite",
              attentionAt: "2026-11-05T01:00:00.000Z",
              overdue: true,
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText("Interview prep: Engineer")).toBeInTheDocument();
    expect(
      screen.getByText("Confirm interview status: Designer"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("next-action-R5:step-1"),
    ).toHaveAttribute("href", "/dashboard/myjobs/opp-1?tab=timeline");
  });

  it("renders a DateOnly deadline as a calendar day, not an instant", () => {
    render(
      <NextActions
        data={data({
          items: [
            item({
              ruleId: NEXT_ACTION_RULE.R5,
              entityKey: "step-1",
              variant: "prepare",
              href: "/dashboard/myjobs/opp-1?tab=timeline",
              jobTitle: "Engineer",
              stepLabel: "Interview",
              attentionAt: "2026-11-16T16:00:00.000Z",
              dateOn: "2026-11-17",
              overdue: false,
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText(/Nov 17/)).toBeInTheDocument();
  });

  it("summarizes capped candidates as a +N count", () => {
    render(
      <NextActions
        data={data({
          items: [
            item({
              ruleId: NEXT_ACTION_RULE.R3,
              entityKey: "account",
              variant: "noJobs",
              href: "/dashboard/myjobs?add-job=true",
            }),
          ],
          overflowCount: 2,
        })}
      />,
    );
    expect(
      screen.getByTestId("next-actions-overflow"),
    ).toHaveTextContent("+2 more suggestions");
  });

  it("uses the noJobs and legacy R3 variants distinctly", () => {
    render(
      <NextActions
        data={data({
          items: [
            item({
              ruleId: NEXT_ACTION_RULE.R3,
              entityKey: "account",
              variant: "noJobs",
              href: "/dashboard/myjobs?add-job=true",
            }),
            item({
              ruleId: NEXT_ACTION_RULE.R3,
              entityKey: "account-legacy",
              variant: "unappliedLegacy",
              href: "/dashboard/myjobs",
            }),
          ],
        })}
      />,
    );
    expect(
      screen.getByText("Add your first target position"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Mark your first application"),
    ).toBeInTheDocument();
  });
});
