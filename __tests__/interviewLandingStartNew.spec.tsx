import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import InterviewLandingPage from "@/app/dashboard/interview/page";

vi.mock("@/i18n/server", () => ({
  getServerI18n: async () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params
        ? `${key}:${Object.values(params).join("/")}`
        : key,
    formatDate: () => "Sep 25",
    locale: "en",
  }),
}));

const getInterviewReadinessAction = vi.fn();
const listInterviewSessionsAction = vi.fn();
vi.mock("@/actions/interview.actions", () => ({
  getInterviewReadinessAction: (...args: unknown[]) =>
    getInterviewReadinessAction(...args),
  listInterviewSessionsAction: (...args: unknown[]) =>
    listInterviewSessionsAction(...args),
}));

describe("interview landing start-new action", () => {
  it("renders a real disabled button (not a navigable link) when unconfigured", async () => {
    getInterviewReadinessAction.mockResolvedValue({
      success: true,
      data: { status: "not_configured" },
    });
    listInterviewSessionsAction.mockResolvedValue({ success: true, data: [] });

    render(await InterviewLandingPage());

    const control = screen.getByRole("button", {
      name: "interview.startInterview",
    });
    expect(control).toBeDisabled();
    // Regression: Button asChild + disabled used to render a clickable <a>
    // that silently redirected back from /dashboard/interview/new.
    expect(
      screen.queryByRole("link", { name: "interview.startInterview" }),
    ).toBeNull();
  });

  it("links to the new-interview page when ready via assignment/global/legacy", async () => {
    for (const source of [
      "BUSINESS_ASSIGNMENT",
      "GLOBAL_DEFAULT",
      "LEGACY_INTERVIEW_CONFIG",
    ]) {
      getInterviewReadinessAction.mockResolvedValue({
        success: true,
        data: {
          status: "ready",
          source,
          provider: "openai",
          model: "gpt-4o",
        },
      });
      listInterviewSessionsAction.mockResolvedValue({
        success: true,
        data: [],
      });

      const { unmount } = render(await InterviewLandingPage());
      const link = screen.getByRole("link", {
        name: "interview.startInterview",
      });
      expect(link).toHaveAttribute("href", "/dashboard/interview/new");
      unmount();
    }
  });

  it("keeps existing history readable when AI is unavailable", async () => {
    getInterviewReadinessAction.mockResolvedValue({
      success: true,
      data: { status: "not_configured" },
    });
    listInterviewSessionsAction.mockResolvedValue({
      success: true,
      data: [
        {
          session: {
            id: "e84a9f82-1111-2222-3333-444455556666",
            status: "COMPLETED",
            coachingMode: "PRACTICE",
            createdAt: new Date("2026-09-20T00:00:00Z"),
          },
          jobTitle: "产品经理",
          companyName: "字节跳动",
          jdVersionNumber: 2,
          totalQuestions: 3,
          answeredQuestions: 3,
        },
      ],
    });

    render(await InterviewLandingPage());

    // Readable derived title — never raw "DRAFT · PRACTICE · uuid".
    const link = screen.getByRole("link", { name: /字节跳动 · 产品经理/ });
    expect(link).toHaveAttribute(
      "href",
      "/dashboard/interview/e84a9f82-1111-2222-3333-444455556666",
    );
    expect(link.textContent).not.toMatch(/PRACTICE|e84a9f82/);
    expect(link.textContent).toContain("interview.statusCompleted");
  });
});
