import { render, screen } from "@testing-library/react";
import { UpcomingContainer } from "@/components/myjobs/UpcomingContainer";
import { listUpcomingApplicationEvents } from "@/actions/application.actions";
import { UPCOMING_EVENT_KIND } from "@/lib/career/upcomingReadModel";

vi.mock("@/actions/application.actions", () => ({
  listUpcomingApplicationEvents: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
}));

const listMock = vi.mocked(listUpcomingApplicationEvents);

describe("UpcomingContainer", () => {
  it("settles a failed initial load into an error instead of loading forever", async () => {
    listMock.mockResolvedValue({ success: false, message: "Upcoming unavailable" });
    render(<UpcomingContainer />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Upcoming unavailable");
    expect(screen.queryByText("Nothing upcoming")).not.toBeInTheDocument();
  });

  it("renders an empty state when there are no events", async () => {
    listMock.mockResolvedValue({
      success: true,
      data: { events: [], timeZone: "Asia/Shanghai" },
    });
    render(<UpcomingContainer />);
    expect(await screen.findByText("Nothing upcoming")).toBeInTheDocument();
  });

  it("groups events, distinguishes application deadlines, and links to job detail", async () => {
    listMock.mockResolvedValue({
      success: true,
      data: {
        timeZone: "Asia/Shanghai",
        events: [
        {
          kind: UPCOMING_EVENT_KIND.PROCESS_STEP,
          jobOpportunityId: "job-overdue",
          companyName: "Acme",
          roleTitle: "Engineer",
          applicationAttemptId: "att-1",
          processStepId: "step-1",
          category: "ASSESSMENT",
          label: "Online test",
          stepStatus: "PENDING",
          scheduledAt: "2020-01-01T00:00:00.000Z",
          scheduledAtPrecision: "minute",
          scheduledAtZone: "Asia/Shanghai",
          deadlineOn: null,
          deadlineAt: "2020-01-03T00:00:00.000Z",
          deadlinePrecision: "minute",
          deadlineZone: "Asia/Shanghai",
          attentionAt: "2020-01-01T00:00:00.000Z",
        },
        {
          kind: UPCOMING_EVENT_KIND.APPLICATION_DEADLINE,
          jobOpportunityId: "job-later",
          companyName: "Globex",
          roleTitle: "Designer",
          applicationAttemptId: null,
          processStepId: null,
          category: null,
          label: UPCOMING_EVENT_KIND.APPLICATION_DEADLINE,
          stepStatus: null,
          scheduledAt: null,
          scheduledAtPrecision: null,
          scheduledAtZone: null,
          deadlineOn: null,
          deadlineAt: "2099-12-01T00:00:00.000Z",
          deadlinePrecision: "minute",
          deadlineZone: null,
          attentionAt: "2099-12-01T00:00:00.000Z",
        },
        ],
      },
    });
    render(<UpcomingContainer />);
    expect(await screen.findByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("Later")).toBeInTheDocument();
    expect(screen.getByText("Online test")).toBeInTheDocument();
    expect(screen.getAllByText("Application deadline").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Engineer" })).toHaveAttribute(
      "href",
      "/dashboard/myjobs/job-overdue",
    );
    expect(screen.getByRole("link", { name: "Designer" })).toHaveAttribute(
      "href",
      "/dashboard/myjobs/job-later",
    );
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
  });
});
