import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/interview/persistence/interviewErrors";

const getCurrentUser = vi.fn();
const listInterviewSessions = vi.fn();
const listInterviewSessionCards = vi.fn();
const loadSessionHistory = vi.fn();

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: () => getCurrentUser(),
}));

vi.mock("@/lib/interview/runtime", () => ({
  getInterviewRuntime: () => ({
    listInterviewSessions,
    listInterviewSessionCards,
    loadSessionHistory,
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
  updateInterviewAiSettings: vi.fn(),
  clearInterviewAiSettings: vi.fn(),
}));

import {
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
});
