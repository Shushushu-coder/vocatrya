import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import NewInterviewPage from "@/app/dashboard/interview/new/page";

vi.mock("@/i18n/server", () => ({ getServerI18n: async () => ({ t: (key: string) => key }) }));
vi.mock("@/actions/interview.actions", () => ({
  getInterviewReadinessAction: async () => ({ success: true, data: { status: "unavailable" } }),
  listInterviewJobsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));

it("keeps unavailable goal-bound practice in place with an AI setup action", async () => {
  render(await NewInterviewPage({ searchParams: Promise.resolve({ prepGoal: "goal" }) }));
  expect(screen.getByRole("status")).toHaveTextContent("interview.needsAiSetup");
  expect(screen.getByRole("link")).toHaveAttribute("href", "/dashboard/settings");
});

it("preserves the generic interview readiness redirect", async () => {
  await expect(NewInterviewPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("REDIRECT:/dashboard/interview");
});
