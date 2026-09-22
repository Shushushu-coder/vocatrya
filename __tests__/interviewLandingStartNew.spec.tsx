import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import InterviewLandingPage from "@/app/dashboard/interview/page";

vi.mock("@/i18n/server", () => ({
  getServerI18n: async () => ({ t: (key: string) => key }),
}));

const getInterviewConfigAction = vi.fn();
const listInterviewSessionsAction = vi.fn();
vi.mock("@/actions/interview.actions", () => ({
  getInterviewConfigAction: (...args: unknown[]) => getInterviewConfigAction(...args),
  listInterviewSessionsAction: (...args: unknown[]) => listInterviewSessionsAction(...args),
}));

describe("interview landing start-new action", () => {
  it("renders a real disabled button (not a navigable link) when unconfigured", async () => {
    getInterviewConfigAction.mockResolvedValue({
      success: true,
      data: { configured: false, provider: null, model: null },
    });
    listInterviewSessionsAction.mockResolvedValue({ success: true, data: [] });

    render(await InterviewLandingPage());

    const control = screen.getByRole("button", { name: "interview.startNew" });
    expect(control).toBeDisabled();
    // Regression: Button asChild + disabled used to render a clickable <a>
    // that silently redirected back from /dashboard/interview/new.
    expect(screen.queryByRole("link", { name: "interview.startNew" })).toBeNull();
  });

  it("links to the new-interview page when configured", async () => {
    getInterviewConfigAction.mockResolvedValue({
      success: true,
      data: { configured: true, provider: "openai", model: "gpt-4o" },
    });
    listInterviewSessionsAction.mockResolvedValue({ success: true, data: [] });

    render(await InterviewLandingPage());

    const link = screen.getByRole("link", { name: "interview.startNew" });
    expect(link).toHaveAttribute("href", "/dashboard/interview/new");
    expect(link).not.toHaveAttribute("disabled");
  });
});
