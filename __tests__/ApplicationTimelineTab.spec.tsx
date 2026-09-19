import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApplicationTimelineTab } from "@/components/myjobs/job-details/ApplicationTimelineTab";
import type { ApplicationTimelineDTO } from "@/lib/career/applicationTimeline";
import {
  completeApplicationProcessStep,
  deleteApplicationProcessStep,
  getApplicationTimeline,
  getInterviewReflection,
} from "@/actions/application.actions";

vi.mock("@/actions/application.actions", () => ({
  getApplicationTimeline: vi.fn(),
  getSubmittedResumeBindings: vi.fn(),
  createApplicationProcessStep: vi.fn(),
  updateApplicationProcessStep: vi.fn(),
  completeApplicationProcessStep: vi.fn(),
  deleteApplicationProcessStep: vi.fn(),
  getInterviewReflection: vi.fn(),
  saveInterviewReflection: vi.fn(),
  submitAttemptResumeVersion: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const getTimeline = vi.mocked(getApplicationTimeline);
const completeStep = vi.mocked(completeApplicationProcessStep);
const deleteStep = vi.mocked(deleteApplicationProcessStep);
const getReflection = vi.mocked(getInterviewReflection);

function step(overrides: Partial<ApplicationTimelineDTO["attempts"][number]["steps"][number]> = {}) {
  return {
    id: "step-user",
    category: "INTERVIEW",
    label: "Hiring manager",
    status: "PENDING",
    source: "USER",
    scheduledAt: null,
    deadlineAt: "2026-10-08T00:00:00.000Z",
    completedAt: null,
    result: null,
    notes: null,
    ...overrides,
  };
}

function timeline(
  steps: ApplicationTimelineDTO["attempts"][number]["steps"],
): ApplicationTimelineDTO {
  return {
    opportunityId: "job-1",
    attempts: [
      {
        id: "att-1",
        submittedAt: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
        currentStageCategory: "SUBMITTED",
        outcome: "ACTIVE",
        transferredFromAttemptId: null,
        transferredFrom: null,
        submittedResume: null as ApplicationTimelineDTO["attempts"][number]["submittedResume"],
        steps,
      },
    ],
  };
}

describe("ApplicationTimelineTab process step actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Delete for USER steps and hides it for SYSTEM steps", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        step(),
        step({
          id: "step-system",
          label: "Interview",
          source: "SYSTEM",
          status: "IN_PROGRESS",
          deadlineAt: null,
        }),
      ]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );

    expect(await screen.findByText("Hiring manager")).toBeInTheDocument();
    const userRow = screen.getAllByTestId("application-process-step")[0];
    const systemRow = screen.getAllByTestId("application-process-step")[1];
    expect(within(userRow).getByTestId("delete-process-step")).toBeInTheDocument();
    expect(within(systemRow).queryByTestId("delete-process-step")).not.toBeInTheDocument();
    expect(within(userRow).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(userRow).getByRole("button", { name: "Mark complete" })).toBeInTheDocument();
    expect(within(systemRow).queryByRole("button", { name: "Mark complete" })).not.toBeInTheDocument();
    expect(screen.getByText("Deadline")).toBeInTheDocument();
  });

  it("cancels delete without calling the server action", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([step()]) });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    await userEvent.click(await screen.findByTestId("delete-process-step"));
    expect(
      await screen.findByText("Delete this process step?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The scheduled time, deadline, notes, and result for this step will be removed.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteStep).not.toHaveBeenCalled();
    expect(screen.getByText("Hiring manager")).toBeInTheDocument();
  });

  it("confirms delete, calls the server action, and refreshes the empty step list", async () => {
    getTimeline
      .mockResolvedValueOnce({ success: true, data: timeline([step()]) })
      .mockResolvedValue({
        success: true,
        data: timeline([]),
      });
    deleteStep.mockResolvedValue({
      success: true,
      data: step() as never,
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    await userEvent.click(await screen.findByTestId("delete-process-step"));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteStep).toHaveBeenCalledWith("step-user"));
    expect(await screen.findByTestId("timeline-steps-empty")).toBeInTheDocument();
    expect(screen.queryByText("Hiring manager")).not.toBeInTheDocument();
    expect(screen.queryByTestId("application-process-step")).not.toBeInTheDocument();
  });

  it("still marks a USER step complete", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([step()]) });
    completeStep.mockResolvedValue({
      success: true,
      data: step({ status: "COMPLETED" }) as never,
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Mark complete" }));
    await waitFor(() => expect(completeStep).toHaveBeenCalledWith("step-user"));
  });

  it("shows Delete for a completed USER step", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        step({
          status: "COMPLETED",
          completedAt: "2026-09-01T00:00:00.000Z",
        }),
      ]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    expect(await screen.findByTestId("delete-process-step")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark complete" })).not.toBeInTheDocument();
  });

  it("shows Interview reflection only for INTERVIEW steps", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        step({ id: "step-interview", category: "INTERVIEW", label: "Hiring manager" }),
        step({
          id: "step-assessment",
          category: "ASSESSMENT",
          label: "Online assessment",
          deadlineAt: null,
        }),
        step({
          id: "step-offer",
          category: "OFFER",
          label: "Offer",
          deadlineAt: null,
        }),
      ]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    expect(await screen.findByText("Hiring manager")).toBeInTheDocument();
    const rows = screen.getAllByTestId("application-process-step");
    expect(
      within(rows[0]).getByTestId("interview-reflection-entry"),
    ).toBeInTheDocument();
    expect(
      within(rows[1]).queryByTestId("interview-reflection-entry"),
    ).not.toBeInTheDocument();
    expect(
      within(rows[2]).queryByTestId("interview-reflection-entry"),
    ).not.toBeInTheDocument();
  });

  it("does not load interview reflection until the entry is clicked", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([step()]) });
    getReflection.mockResolvedValue({
      success: true,
      data: {
        applicationProcessStepId: "step-user",
        reflectionText: null,
        items: [],
      },
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    expect(await screen.findByText("Hiring manager")).toBeInTheDocument();
    expect(getReflection).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("interview-reflection-entry"));
    await waitFor(() =>
      expect(getReflection).toHaveBeenCalledWith("step-user"),
    );
  });

  it("shows Interview reflection for SYSTEM INTERVIEW steps", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        step({
          id: "step-system",
          source: "SYSTEM",
          status: "PENDING",
          deadlineAt: null,
        }),
      ]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    expect(await screen.findByTestId("interview-reflection-entry")).toBeInTheDocument();
  });

  it("hides Interview reflection when the timeline is read-only", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([step()]) });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate={false} />,
    );
    expect(await screen.findByText("Hiring manager")).toBeInTheDocument();
    expect(screen.queryByTestId("interview-reflection-entry")).not.toBeInTheDocument();
    expect(getReflection).not.toHaveBeenCalled();
  });

  it("hides Delete for IMPORT and AUTOMATION steps", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        step({
          id: "step-import",
          source: "IMPORT",
          label: "Imported",
          deadlineAt: null,
        }),
        step({
          id: "step-auto",
          source: "AUTOMATION",
          label: "Automated",
          deadlineAt: null,
        }),
      ]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    expect(await screen.findByText("Imported")).toBeInTheDocument();
    expect(screen.queryByTestId("delete-process-step")).not.toBeInTheDocument();
  });

  it("links a bound submitted resume to the historical workspace version", async () => {
    const data = timeline([]);
    data.attempts[0].submittedResume = {
      id: "ver-1",
      title: "Campus",
      versionNumber: 1,
      resumeVariantId: "var-1",
      resumeVariantVersionId: "ver-1",
    };
    getTimeline.mockResolvedValue({ success: true, data });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    const link = await screen.findByTestId("view-submitted-resume-version");
    expect(link).toHaveAttribute(
      "href",
      "/dashboard/profile/resumes/var-1?version=ver-1",
    );
    expect(link).toHaveTextContent("View submitted version (read-only)");
    expect(link.textContent).not.toContain("var-1");
    expect(link.textContent).not.toContain("ver-1");
  });

  it("does not show a historical version link when resume is unbound", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([]) });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    expect(await screen.findByText("No submitted resume linked")).toBeInTheDocument();
    expect(
      screen.queryByTestId("view-submitted-resume-version"),
    ).not.toBeInTheDocument();
  });
});
