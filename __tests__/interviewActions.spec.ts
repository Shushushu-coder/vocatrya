import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/interview/persistence/interviewErrors";

const getCurrentUser = vi.fn();
const listInterviewSessions = vi.fn();
const listInterviewSessionCards = vi.fn();
const loadSessionHistory = vi.fn();
const createInterviewSession = vi.fn();
const validatePrepSessionCreation = vi.fn();

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: () => getCurrentUser(),
}));

vi.mock("@/lib/db", () => ({ default: {} }));

vi.mock("@/lib/career/runtimeMode", () => ({
  resolveCareerRuntimeMode: vi.fn(async () => ({
    mode: "LEGACY_ONLY",
    rolloutScope: "none",
  })),
}));

vi.mock("@/lib/interviewPrep/service", () => ({
  validatePrepSessionCreation: (...args: unknown[]) =>
    validatePrepSessionCreation(...args),
}));

vi.mock("@/lib/interview/runtime", () => ({
  getInterviewRuntime: () => ({
    listInterviewSessions,
    listInterviewSessionCards,
    loadSessionHistory,
    createInterviewSession,
    ensurePreset: vi.fn(),
    listPresets: vi.fn(async () => []),
    listUserQuestions: vi.fn(async () => []),
    listUserJobs: vi.fn(async () => []),
  }),
}));

vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: vi.fn(async () => ({
    success: true,
    data: { settings: { ai: {} } },
  })),
}));

import {
  createInterviewSessionAction,
  getInterviewSessionAction,
  listInterviewSessionsAction,
} from "@/actions/interview.actions";

describe("interview server actions", () => {
  beforeEach(() => {
    getCurrentUser.mockReset();
    listInterviewSessions.mockReset();
    listInterviewSessionCards.mockReset();
    loadSessionHistory.mockReset();
  });

  it("uses the authenticated user and never trusts a client userId", async () => {
    getCurrentUser.mockResolvedValue({ id: "user-a" });
    listInterviewSessionCards.mockResolvedValue([]);
    const result = await listInterviewSessionsAction();
    expect(result.success).toBe(true);
    expect(listInterviewSessionCards).toHaveBeenCalledWith("user-a");
  });

  it("maps cross-user session access to a safe product error", async () => {
    getCurrentUser.mockResolvedValue({ id: "user-b" });
    loadSessionHistory.mockRejectedValue(
      new DomainError("SESSION_FORBIDDEN", "Session is not owned by the current user"),
    );
    const result = await getInterviewSessionAction("session-a");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("SESSION_FORBIDDEN");
      expect(result.message).not.toMatch(/prisma|sql|sk-/i);
    }
  });

  // The goal-bound creation path must obey the same full-AB surface gate as
  // the prep-goal actions — a direct call in a restricted mode is denied
  // before any validation, planning or session write can run.
  it("rejects goal-bound session creation in a restricted runtime mode", async () => {
    getCurrentUser.mockResolvedValue({ id: "user-a" });
    const result = await createInterviewSessionAction({
      jobOpportunityId: "job-1",
      jobDescriptionVersionId: "jd-1",
      interviewPrepGoalId: "goal-1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("PREP_GOAL_UNAVAILABLE");
    }
    expect(validatePrepSessionCreation).not.toHaveBeenCalled();
    expect(createInterviewSession).not.toHaveBeenCalled();
  });
});
