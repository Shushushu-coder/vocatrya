import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApplicationTimelineTab } from "@/components/myjobs/job-details/ApplicationTimelineTab";
import type { ApplicationTimelineDTO } from "@/lib/career/applicationTimeline";
import {
  cancelApplicationProcessStep,
  completeApplicationProcessStep,
  createApplicationProcessStep,
  deleteApplicationProcessStep,
  getApplicationTimeline,
  getInterviewReflection,
  updateApplicationProcessStep,
} from "@/actions/application.actions";

vi.mock("@/actions/application.actions", () => ({
  getApplicationTimeline: vi.fn(),
  getSubmittedResumeBindings: vi.fn(),
  createApplicationProcessStep: vi.fn(),
  updateApplicationProcessStep: vi.fn(),
  completeApplicationProcessStep: vi.fn(),
  cancelApplicationProcessStep: vi.fn(),
  deleteApplicationProcessStep: vi.fn(),
  getInterviewReflection: vi.fn(),
  saveInterviewReflection: vi.fn(),
  attachAttemptResumeVersion: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const getTimeline = vi.mocked(getApplicationTimeline);
const completeStep = vi.mocked(completeApplicationProcessStep);
const cancelStep = vi.mocked(cancelApplicationProcessStep);
const createStep = vi.mocked(createApplicationProcessStep);
const updateStep = vi.mocked(updateApplicationProcessStep);
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
        channelLabel: "Careers page",
        submittedAt: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
        archivedAt: null,
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
    expect(
      within(screen.getByTestId("process-steps-table")).getByText("Deadline"),
    ).toBeInTheDocument();
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

  it("renders steps in a table with event, timing, and status columns", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        step(),
        step({
          id: "step-offer",
          category: "OFFER",
          label: "Offer reply",
          deadlineAt: null,
        }),
      ]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    const table = await screen.findByTestId("process-steps-table");
    expect(within(table).getByText("Step name")).toBeInTheDocument();
    expect(within(table).getByText("Scheduled time")).toBeInTheDocument();
    expect(within(table).getByText("Deadline")).toBeInTheDocument();
    expect(within(table).getByText("Status")).toBeInTheDocument();
    const rows = screen.getAllByTestId("application-process-step");
    expect(rows[0]).toHaveTextContent("Hiring manager");
    expect(rows[0]).toHaveTextContent("Pending");
    expect(rows[1]).toHaveTextContent("Offer reply");
  });

  it("quick-adds an event to the section's attempt", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([]) });
    createStep.mockResolvedValue({
      success: true,
      data: step() as never,
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    const quickAdd = await screen.findByTestId("quick-add-step");
    await userEvent.selectOptions(
      within(quickAdd).getByTestId("quick-add-category"),
      "ASSESSMENT",
    );
    await userEvent.type(
      within(quickAdd).getByTestId("quick-add-label"),
      "Written test",
    );
    await userEvent.click(within(quickAdd).getByTestId("quick-add-submit"));
    await waitFor(() =>
      expect(createStep).toHaveBeenCalledWith(
        expect.objectContaining({
          jobOpportunityId: "job-1",
          applicationAttemptId: "att-1",
          category: "ASSESSMENT",
          label: "Written test",
        }),
      ),
    );
  });

  it("keeps composing Enter from submitting a quick-add draft", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([]) });
    createStep.mockResolvedValue({ success: true, data: step() as never });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);
    const input = await screen.findByTestId("quick-add-label");
    fireEvent.change(input, { target: { value: "一面" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(createStep).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(createStep).toHaveBeenCalledTimes(1));
  });

  it("locks a quick-add draft while saving and preserves it on failure", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([]) });
    let finish!: (value: Awaited<ReturnType<typeof createApplicationProcessStep>>) => void;
    createStep.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);
    const input = await screen.findByTestId("quick-add-label");
    await userEvent.type(input, "一面");
    await userEvent.click(screen.getByTestId("quick-add-submit"));
    await waitFor(() => expect(input).toBeDisabled());
    expect(screen.getByTestId("quick-add-category")).toBeDisabled();
    await act(async () => { finish({ success: false, message: "Save failed" }); });
    await waitFor(() => expect(input).not.toBeDisabled());
    expect(input).toHaveValue("一面");
  });

  it("keeps the reschedule dialog open while saving and retains it on failure", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([step()]) });
    let finish!: (value: Awaited<ReturnType<typeof updateApplicationProcessStep>>) => void;
    updateStep.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);
    await userEvent.click(await screen.findByTestId("reschedule-process-step"));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled());
    await userEvent.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    await act(async () => { finish({ success: false, message: "Save failed" }); });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save" })).not.toBeDisabled());
    expect(dialog).toBeInTheDocument();
  });

  it("hides quick-add for archived attempts", async () => {
    const data = timeline([]);
    data.attempts[0].archivedAt = "2024-02-01T00:00:00.000Z";
    getTimeline.mockResolvedValue({ success: true, data });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    expect(await screen.findByText("Careers page")).toBeInTheDocument();
    expect(screen.queryByTestId("quick-add-step")).not.toBeInTheDocument();
  });

  it("reschedules a step through the reschedule dialog", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([step()]) });
    updateStep.mockResolvedValue({
      success: true,
      data: step() as never,
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    await userEvent.click(
      await screen.findByTestId("reschedule-process-step"),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Reschedule event"),
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save" }),
    );
    await waitFor(() =>
      expect(updateStep).toHaveBeenCalledWith(
        expect.objectContaining({
          stepId: "step-user",
          scheduledAt: null,
          deadlineAt: new Date("2026-10-08T00:00:00.000Z"),
        }),
      ),
    );
  });

  it("cancels a step after confirmation and keeps the cancelled record", async () => {
    getTimeline
      .mockResolvedValueOnce({ success: true, data: timeline([step()]) })
      .mockResolvedValue({
        success: true,
        data: timeline([
          step({
            status: "CANCELLED",
            completedAt: "2026-10-01T12:00:00.000Z",
          }),
        ]),
      });
    cancelStep.mockResolvedValue({
      success: true,
      data: step({ status: "CANCELLED" }) as never,
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    await userEvent.click(await screen.findByTestId("cancel-process-step"));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Cancel this event?"),
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel event" }),
    );
    await waitFor(() => expect(cancelStep).toHaveBeenCalledWith("step-user"));
    const row = await screen.findByTestId("application-process-step");
    expect(row).toHaveTextContent("Cancelled");
    expect(
      within(row).queryByRole("button", { name: "Mark complete" }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByTestId("reschedule-process-step"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("cancel-process-step")).not.toBeInTheDocument();
  });
});
