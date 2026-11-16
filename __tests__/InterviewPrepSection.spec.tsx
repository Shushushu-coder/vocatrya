// InterviewPrepSection is server-authoritative: mount only reads via
// getInterviewPrepGoalForJob (zero model calls, zero session creation),
// "继续准备" re-verifies via continueInterviewPrepGoal and routes strictly
// by the server's nextAction — OPEN_SESSION opens the SAME session, never
// a new one.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { InterviewPrepSection } from "@/components/myjobs/job-details/InterviewPrepSection";
import type { PrepGoalDTO } from "@/lib/interviewPrep/contract";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join("/")}` : key,
    formatDateTime: (v: unknown) => String(v),
  }),
}));

vi.mock("@/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const getGoal = vi.fn();
const createGoal = vi.fn();
const continueGoal = vi.fn();
const pauseGoal = vi.fn();
const resumeGoal = vi.fn();
const endGoal = vi.fn();
const newRound = vi.fn();
const listLinkable = vi.fn();
const linkSession = vi.fn();
vi.mock("@/actions/interviewPrep.actions", () => ({
  getInterviewPrepGoalForJob: (...a: unknown[]) => getGoal(...a),
  createInterviewPrepGoal: (...a: unknown[]) => createGoal(...a),
  continueInterviewPrepGoal: (...a: unknown[]) => continueGoal(...a),
  pauseInterviewPrepGoal: (...a: unknown[]) => pauseGoal(...a),
  resumeInterviewPrepGoal: (...a: unknown[]) => resumeGoal(...a),
  endInterviewPrepGoal: (...a: unknown[]) => endGoal(...a),
  startNewInterviewPrepRound: (...a: unknown[]) => newRound(...a),
  listLinkableInterviewPrepSessions: (...a: unknown[]) => listLinkable(...a),
  linkInterviewPrepSession: (...a: unknown[]) => linkSession(...a),
}));

function goalFixture(overrides: Partial<PrepGoalDTO> = {}): PrepGoalDTO {
  return {
    id: "goal-1",
    status: "ACTIVE",
    revision: 3,
    jobOpportunityId: "job-1",
    jobTitle: "Backend Engineer",
    jobArchived: false,
    pinnedJd: { versionId: "jd-1", versionNumber: 1, contentHash: "h1" },
    currentJd: { versionId: "jd-1", versionNumber: 1 },
    jdDrift: false,
    session: {
      id: "sess-1",
      status: "IN_PROGRESS",
      coachingMode: "PRACTICE",
      questionsTotal: 4,
      answeredCount: 2,
      feedbackReadyCount: 2,
      summaryReady: false,
      summaryGenerationId: null,
      summaryCompletedAt: null,
      summaryFailed: false,
      currentQuestionDisplayOrder: 3,
    },
    progress: {
      completed: ["GOAL_CREATED", "PRACTICE_STARTED"],
      pending: ["ANSWER_QUESTIONS"],
    },
    blockers: [],
    nextAction: { kind: "OPEN_SESSION", sessionId: "sess-1" },
    handoffVerifiedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    pausedAt: null,
    completedAt: null,
    endedAt: null,
    ...overrides,
  };
}

const ok = (goal: PrepGoalDTO | null) => ({ success: true, data: { goal } });

beforeEach(() => {
  push.mockReset();
});

async function renderLoaded() {
  render(<InterviewPrepSection jobId="job-1" />);
  await waitFor(() =>
    expect(screen.getByTestId("interview-prep-section")).toBeInTheDocument(),
  );
}

describe("InterviewPrepSection", () => {
  it("loads server state on mount without creating anything", async () => {
    getGoal.mockResolvedValue(ok(goalFixture()));
    await renderLoaded();

    expect(getGoal).toHaveBeenCalledTimes(1);
    expect(getGoal).toHaveBeenCalledWith({ jobOpportunityId: "job-1" });
    expect(createGoal).not.toHaveBeenCalled();
    expect(continueGoal).not.toHaveBeenCalled();
    // Pinned JD source and real progress come from the server DTO.
    expect(screen.getByTestId("prep-source")).toHaveTextContent(
      "interviewPrep.source.pinnedJd:1",
    );
    expect(screen.getByTestId("prep-progress")).toHaveTextContent(
      "interviewPrep.progress.answeredPartial:2/4",
    );
    expect(screen.getByTestId("prep-next-action")).toHaveTextContent(
      "interviewPrep.nextAction.OPEN_SESSION",
    );
  });

  it("surfaces first-read failure and recovers on retry", async () => {
    getGoal
      .mockResolvedValueOnce({ success: false, message: "boom" })
      .mockResolvedValueOnce(ok(null));
    render(<InterviewPrepSection jobId="job-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("prep-load-failed")).toBeInTheDocument(),
    );
    await userEvent.setup().click(
      screen.getByRole("button", { name: "interviewPrep.retry" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("interview-prep-section")).toBeInTheDocument(),
    );
    expect(getGoal).toHaveBeenCalledTimes(2);
    // No goal → explicit create entry, not an auto-created one.
    expect(screen.getByTestId("prep-create")).toBeInTheDocument();
  });

  it("continue re-verifies then routes to the SAME bound session", async () => {
    const goal = goalFixture();
    getGoal.mockResolvedValue(ok(goal));
    continueGoal.mockResolvedValue(ok(goal));
    await renderLoaded();

    await userEvent
      .setup()
      .click(screen.getByTestId("prep-continue"));
    await waitFor(() => expect(continueGoal).toHaveBeenCalledTimes(1));
    expect(continueGoal).toHaveBeenCalledWith({ goalId: "goal-1" });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/dashboard/interview-prep/sess-1"),
    );
  });

  it("routes START_PRACTICE into the existing creation flow with pinned context", async () => {
    const goal = goalFixture({
      session: null,
      progress: { completed: ["GOAL_CREATED"], pending: ["START_PRACTICE"] },
      nextAction: { kind: "START_PRACTICE", sessionId: null },
    });
    getGoal.mockResolvedValue(ok(goal));
    continueGoal.mockResolvedValue(ok(goal));
    await renderLoaded();

    await userEvent.setup().click(screen.getByTestId("prep-continue"));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        "/dashboard/interview-prep/new?job=job-1&jd=jd-1&prepGoal=goal-1",
      ),
    );
  });

  it("shows JD drift truthfully instead of a fabricated up-to-date state", async () => {
    getGoal.mockResolvedValue(
      ok(
        goalFixture({
          currentJd: { versionId: "jd-2", versionNumber: 2 },
          jdDrift: true,
        }),
      ),
    );
    await renderLoaded();
    expect(screen.getByTestId("prep-jd-drift")).toHaveTextContent(
      "interviewPrep.source.jdDrift:1/2",
    );
  });

  it("navigates with the NEW goal returned by the new-round call", async () => {
    const oldGoal = goalFixture({
      status: "COMPLETED",
      nextAction: { kind: "NEW_ROUND", sessionId: null },
    });
    const nextGoal = goalFixture({
      id: "goal-2",
      status: "ACTIVE",
      revision: 0,
      pinnedJd: { versionId: "jd-2", versionNumber: 2, contentHash: "h2" },
      currentJd: { versionId: "jd-2", versionNumber: 2 },
      session: null,
      progress: { completed: ["GOAL_CREATED"], pending: ["START_PRACTICE"] },
      nextAction: { kind: "START_PRACTICE", sessionId: null },
    });
    getGoal.mockResolvedValue(ok(oldGoal));
    continueGoal.mockResolvedValue(ok(oldGoal));
    newRound.mockResolvedValue(ok(nextGoal));
    await renderLoaded();

    await userEvent.setup().click(screen.getByTestId("prep-new-round"));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        "/dashboard/interview-prep/new?job=job-1&jd=jd-2&prepGoal=goal-2",
      ),
    );
    expect(newRound).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: "goal-1" }),
    );
  });

  it("reuses the request key for the same new-round intent and mints a new one after success", async () => {
    const done = goalFixture({
      status: "COMPLETED",
      nextAction: { kind: "NEW_ROUND", sessionId: null },
    });
    const round2 = goalFixture({
      id: "goal-2",
      status: "COMPLETED",
      nextAction: { kind: "NEW_ROUND", sessionId: null },
    });
    getGoal.mockResolvedValue(ok(done));
    await renderLoaded();
    const user = userEvent.setup();

    // First intent fails (response lost) → the retry retransmits the SAME key.
    newRound.mockResolvedValueOnce({ success: false, message: "lost" });
    await user.click(screen.getByTestId("prep-new-round"));
    await waitFor(() => expect(newRound).toHaveBeenCalledTimes(1));
    const firstKey = (newRound.mock.calls[0][0] as { requestKey: string })
      .requestKey;

    newRound.mockResolvedValueOnce(ok(round2));
    await user.click(screen.getByTestId("prep-new-round"));
    await waitFor(() => expect(newRound).toHaveBeenCalledTimes(2));
    expect(
      (newRound.mock.calls[1][0] as { requestKey: string }).requestKey,
    ).toBe(firstKey);

    // A subsequent explicit new round is a distinct intent → a new key.
    newRound.mockResolvedValueOnce(ok(done));
    await user.click(screen.getByTestId("prep-new-round"));
    await waitFor(() => expect(newRound).toHaveBeenCalledTimes(3));
    expect(
      (newRound.mock.calls[2][0] as { requestKey: string }).requestKey,
    ).not.toBe(firstKey);
  });

  it("shows the server's restricted-mode denial instead of a retry loop", async () => {
    getGoal.mockResolvedValue({
      success: false,
      code: "PREP_GOAL_UNAVAILABLE",
      message: "denied in this mode",
    });
    render(<InterviewPrepSection jobId="job-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("prep-unavailable")).toHaveTextContent(
        "denied in this mode",
      ),
    );
    expect(
      screen.queryByRole("button", { name: "interviewPrep.retry" }),
    ).toBeNull();
    expect(screen.queryByTestId("prep-create")).toBeNull();
  });

  it("create sends one request keyed call and renders the returned goal", async () => {
    getGoal.mockResolvedValue(ok(null));
    createGoal.mockResolvedValue(ok(goalFixture()));
    await renderLoaded();

    await userEvent.setup().click(screen.getByTestId("prep-create"));
    await waitFor(() => expect(createGoal).toHaveBeenCalledTimes(1));
    const arg = createGoal.mock.calls[0][0] as {
      jobOpportunityId: string;
      requestKey: string;
    };
    expect(arg.jobOpportunityId).toBe("job-1");
    expect(arg.requestKey).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("prep-status")).toHaveTextContent(
        "interviewPrep.status.ACTIVE",
      ),
    );
  });
});
