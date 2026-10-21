import { render, screen } from "@testing-library/react";
import GettingStarted from "@/components/dashboard/GettingStarted";
import RecentUpdates from "@/components/dashboard/RecentUpdates";
import OverviewMetrics from "@/components/dashboard/OverviewMetrics";
import type { OverviewStats } from "@/actions/dashboard.actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
}));

const stats: OverviewStats = {
  jobsBlocked: false,
  inProgress: 0,
  applied7d: 0,
  openTasks: 0,
  upcomingActivities: 0,
};

describe("GettingStarted", () => {
  it("renders the shared region with four real deep-link entries", () => {
    render(<GettingStarted />);
    expect(
      screen.getByTestId("overview-getting-started"),
    ).toBeInTheDocument();
    expect(screen.getByText("Start tracking your job search")).toBeVisible();

    const job = screen.getByTestId("getting-started-job");
    const task = screen.getByTestId("getting-started-task");
    const activity = screen.getByTestId("getting-started-activity");
    const question = screen.getByTestId("getting-started-question");

    // Real anchors into the existing create flows / surfaces: no placeholder
    // buttons, no stub routes.
    expect(job).toHaveAttribute("href", "/dashboard/myjobs?add-job=true");
    expect(task).toHaveAttribute("href", "/dashboard/tasks?add-task=true");
    expect(activity).toHaveAttribute(
      "href",
      "/dashboard/activities?add-activity=true",
    );
    expect(question).toHaveAttribute("href", "/dashboard/questions");

    // Each entry carries a visible text label that also serves as its
    // accessible name.
    expect(job).toHaveAccessibleName(/Add a position/);
    expect(task).toHaveAccessibleName(/Add a to-do/);
    expect(activity).toHaveAccessibleName(/Create an activity/);
    expect(question).toHaveAccessibleName(/Question bank/);
  });

  it("exposes all four entries to the keyboard as links", () => {
    render(<GettingStarted />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(4);
    for (const link of links) {
      expect(link).not.toHaveAttribute("tabindex", "-1");
    }
  });
});

describe("RecentUpdates compact empty state", () => {
  it("keeps the single-line hint for an account with history but no recent feed", () => {
    render(<RecentUpdates jobs={{ blocked: false, data: [] }} activities={[]} />);
    expect(screen.getByText("No recent updates")).toBeInTheDocument();
  });

  it("caps the merged feed at five rows", () => {
    const activities = Array.from({ length: 8 }, (_, i) => ({
      id: `a${i}`,
      activityName: `Activity ${i}`,
      endTime: new Date(2026, 0, i + 1).toISOString(),
      activityType: { label: "Learning" },
    }));
    render(
      <RecentUpdates jobs={{ blocked: false, data: [] }} activities={activities} />,
    );
    expect(screen.getAllByRole("link")).toHaveLength(5);
  });
});

describe("OverviewMetrics", () => {
  it("still renders the four headline metrics for an all-zero account", () => {
    render(<OverviewMetrics stats={stats} />);
    for (const key of [
      "inProgress",
      "applied7d",
      "openTasks",
      "upcomingActivities",
    ]) {
      expect(screen.getByTestId(`overview-metric-${key}`)).toHaveTextContent(
        "0",
      );
    }
  });
});
