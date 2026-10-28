import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OverviewMetrics from "@/components/dashboard/OverviewMetrics";
import OverviewReminders from "@/components/dashboard/OverviewReminders";
import RecentUpdates from "@/components/dashboard/RecentUpdates";
import BoardTotals from "@/components/dashboard/BoardTotals";
import AnalyticsPanel from "@/components/dashboard/AnalyticsPanel";
import type {
  OverviewStats,
  OverviewReminder,
} from "@/actions/dashboard.actions";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@nivo/bar", () => ({
  ResponsiveBar: (props: any) => (
    <div
      data-testid="trend-chart"
      data-count={props.data.length}
      data-total={props.data.reduce(
        (sum: number, row: { value: number }) => sum + row.value,
        0,
      )}
    />
  ),
}));

vi.mock("@nivo/pie", () => ({
  ResponsivePie: (props: any) => (
    <div data-testid="pie-chart" data-slices={props.data.length} />
  ),
}));

window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})) as unknown as typeof window.matchMedia;

// AnalyticsPanel persists its tab + window selection in localStorage; tests
// each expect to start on the default view.
beforeEach(() => window.localStorage.clear());

const ok = <T,>(data: T) => ({ blocked: false as const, data });
const blocked = {
  blocked: true as const,
  code: "JOBS_READ_UNAVAILABLE" as const,
  message: "blocked",
};

const stats: OverviewStats = {
  jobsBlocked: false,
  inProgress: 4,
  applied7d: 2,
  openTasks: 3,
};

describe("OverviewMetrics", () => {
  it("renders the three headline metrics", () => {
    render(<OverviewMetrics stats={stats} />);
    expect(screen.getByText("Active positions")).toBeInTheDocument();
    expect(screen.getByText("Applied (7d)")).toBeInTheDocument();
    expect(screen.getByText("Open tasks")).toBeInTheDocument();
    expect(screen.getByTestId("overview-metric-inProgress")).toHaveTextContent(
      "4",
    );
  });

  it("renders an em-dash and the notice for a blocked jobs family", () => {
    render(<OverviewMetrics stats={{ jobsBlocked: true, openTasks: 2 }} />);
    expect(screen.getByTestId("overview-metric-inProgress")).toHaveTextContent(
      "—",
    );
    expect(screen.getByTestId("overview-metric-openTasks")).toHaveTextContent(
      "2",
    );
    expect(screen.getByTestId("jobs-unavailable-notice")).toBeInTheDocument();
  });
});

describe("OverviewReminders", () => {
  const reminder: OverviewReminder = {
    id: "task:1",
    kind: "task",
    title: "Follow up",
    at: new Date(Date.now() - 86_400_000).toISOString(),
    dateOn: null,
    href: "/dashboard/tasks",
    overdue: true,
  };

  it("renders nothing when there is nothing due", () => {
    const { container } = render(
      <OverviewReminders reminders={[]} timeZone="Asia/Shanghai" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists due items and flags overdue ones", () => {
    render(
      <OverviewReminders reminders={[reminder]} timeZone="Asia/Shanghai" />,
    );
    expect(screen.getByTestId("overview-reminders")).toBeInTheDocument();
    expect(screen.getByText("Follow up")).toBeInTheDocument();
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
  });
});

describe("RecentUpdates", () => {
  const jobs = ok([
    {
      id: "j1",
      appliedDate: "2026-10-20T00:00:00Z",
      JobTitle: { label: "Engineer" },
      Company: { label: "Acme" },
      Status: { label: "Applied", value: "applied" },
    },
  ]);
  it("lists recent applications newest first", () => {
    render(<RecentUpdates jobs={jobs} />);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveTextContent("Engineer");
    expect(links[0]).toHaveAttribute("href", "/dashboard/myjobs/j1");
  });

  it("shows a compact empty state instead of a large blank card", () => {
    render(<RecentUpdates jobs={ok([])} />);
    expect(screen.getByText("No recent updates")).toBeInTheDocument();
  });

  it("degrades job rows to the notice", () => {
    render(<RecentUpdates jobs={blocked as any} />);
    expect(screen.getByTestId("jobs-unavailable-notice")).toBeInTheDocument();
  });
});

describe("BoardTotals", () => {
  it("renders all-time totals", () => {
    render(
      <BoardTotals
        totals={ok({
          total: 9,
          applied: 5,
          interviews: 2,
          offers: 1,
          inProgress: 6,
        })}
      />,
    );
    expect(screen.getByTestId("board-total-total")).toHaveTextContent("9");
    expect(screen.getByTestId("board-total-applied")).toHaveTextContent("5");
    expect(screen.getByTestId("board-total-interviews")).toHaveTextContent("2");
    expect(screen.getByTestId("board-total-offers")).toHaveTextContent("1");
  });

  it("renders the notice and em-dashes when blocked", () => {
    render(<BoardTotals totals={blocked as any} />);
    expect(screen.getByTestId("jobs-unavailable-notice")).toBeInTheDocument();
    expect(screen.getByTestId("board-total-total")).toHaveTextContent("—");
  });
});

describe("AnalyticsPanel", () => {
  const trend = ok([
    { day: "Mon", value: 0 },
    { day: "Tue", value: 2 },
    { day: "Wed", value: 1 },
  ]);
  const statusDist = ok([
    { status: "applied", count: 3 },
    { status: "interview", count: 1 },
  ]);
  const renderPanel = (
    overrides: Partial<Parameters<typeof AnalyticsPanel>[0]> = {},
  ) =>
    render(
      <AnalyticsPanel
        trend7={trend}
        trend30={trend}
        statusDist={statusDist}
        {...overrides}
      />,
    );

  it("shows the application trend by default", () => {
    renderPanel();
    expect(screen.getByTestId("trend-chart")).toHaveAttribute(
      "data-total",
      "3",
    );
  });

  it("switches to the status breakdown", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("tab", { name: "Status breakdown" }));
    expect(screen.getByTestId("pie-chart")).toHaveAttribute("data-slices", "2");
    const legend = screen.getByTestId("status-legend");
    expect(within(legend).getByText("Applied")).toBeInTheDocument();
    expect(within(legend).getByText("3")).toBeInTheDocument();
  });

  it("shows a compact note instead of an empty chart", () => {
    renderPanel({ trend7: ok([{ day: "Mon", value: 0 }]) });
    expect(screen.getByTestId("analytics-empty-note")).toHaveTextContent(
      "No applications in this window",
    );
    expect(screen.queryByTestId("trend-chart")).not.toBeInTheDocument();
  });

  it("degrades a blocked jobs family inside the affected tab", async () => {
    const user = userEvent.setup();
    renderPanel({ trend7: blocked as any, trend30: blocked as any });
    expect(screen.getByTestId("jobs-unavailable-notice")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Status breakdown" }));
    expect(
      screen.queryByTestId("jobs-unavailable-notice"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("status-legend")).toBeInTheDocument();
  });
});
