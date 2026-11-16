import { vi } from "vitest";
import NewPrepInterviewPage from "@/app/dashboard/interview-prep/new/page";
import PrepInterviewSessionPage from "@/app/dashboard/interview-prep/[sessionId]/page";

const mocks = vi.hoisted(() => ({ goal: vi.fn(), createPage: vi.fn(), sessionPage: vi.fn(), session: vi.fn(), gate: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
}));
vi.mock("@/actions/shared", () => ({ requireUser: async () => ({ id: "owner" }) }));
vi.mock("@/actions/interviewPrep.actions", () => ({ continueInterviewPrepGoal: mocks.goal }));
vi.mock("@/lib/db", () => ({ default: { interviewSession: { findFirst: mocks.session } } }));
vi.mock("@/lib/interviewPrep/surfaceGate", () => ({ assertPrepSurfaceEnabled: mocks.gate }));
vi.mock("@/app/dashboard/interview/new/page", () => ({ default: mocks.createPage }));
vi.mock("@/app/dashboard/interview/[sessionId]/page", () => ({ default: mocks.sessionPage }));

beforeEach(() => { vi.resetAllMocks(); });

it("creates from the server-owned goal material, ignoring forged URL material", async () => {
  mocks.goal.mockResolvedValue({ success: true, data: { goal: {
    id: "goal", jobOpportunityId: "job", pinnedJd: { versionId: "jd" }, nextAction: { kind: "START_PRACTICE" },
  } } });
  await NewPrepInterviewPage({ searchParams: Promise.resolve({ prepGoal: "goal", job: "forged", jd: "forged" }) });
  expect(await mocks.createPage.mock.calls[0][0].searchParams).toEqual({ prepGoal: "goal", job: "job", jd: "jd" });
});

it("reopens the existing session instead of creating another one", async () => {
  mocks.goal.mockResolvedValue({ success: true, data: { goal: { nextAction: { kind: "OPEN_SESSION", sessionId: "same" } } } });
  await expect(NewPrepInterviewPage({ searchParams: Promise.resolve({ prepGoal: "goal" }) })).rejects.toThrow("REDIRECT:/dashboard/interview-prep/same");
  expect(mocks.createPage).not.toHaveBeenCalled();
});

it("rejects missing, forbidden and blocked preparation goals", async () => {
  await expect(NewPrepInterviewPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  mocks.goal.mockResolvedValue({ success: false });
  await expect(NewPrepInterviewPage({ searchParams: Promise.resolve({ prepGoal: "foreign" }) })).rejects.toThrow("NOT_FOUND");
  mocks.goal.mockResolvedValue({ success: true, data: { goal: { nextAction: { kind: "RESUME_GOAL" } } } });
  await expect(NewPrepInterviewPage({ searchParams: Promise.resolve({ prepGoal: "paused" }) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.createPage).not.toHaveBeenCalled();
});

it("only opens owned goal-bound sessions under the existing capability gate", async () => {
  mocks.session.mockResolvedValue({ id: "same" });
  await PrepInterviewSessionPage({ params: Promise.resolve({ sessionId: "same" }) });
  expect(mocks.gate).toHaveBeenCalledTimes(1);
  expect(mocks.session).toHaveBeenCalledWith({ where: { id: "same", userId: "owner", interviewPrepGoalId: { not: null } }, select: { id: true } });
  expect(await mocks.sessionPage.mock.calls[0][0].params).toEqual({ sessionId: "same" });
  mocks.session.mockResolvedValue(null);
  await expect(PrepInterviewSessionPage({ params: Promise.resolve({ sessionId: "foreign" }) })).rejects.toThrow("NOT_FOUND");
});

it("does not query or render a session when capability is denied", async () => {
  mocks.gate.mockRejectedValue(new Error("PREP_GOAL_UNAVAILABLE"));
  await expect(PrepInterviewSessionPage({ params: Promise.resolve({ sessionId: "same" }) })).rejects.toThrow("PREP_GOAL_UNAVAILABLE");
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.sessionPage).not.toHaveBeenCalled();
});
