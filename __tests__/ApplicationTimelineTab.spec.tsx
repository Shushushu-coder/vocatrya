import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApplicationTimelineTab } from "@/components/myjobs/job-details/ApplicationTimelineTab";
import type {
  ApplicationTimelineDTO,
  JobConnectionsDTO,
} from "@/lib/career/applicationTimeline";
import {
  cancelApplicationProcessStep,
  completeApplicationProcessStep,
  createApplicationProcessStep,
  deleteApplicationProcessStep,
  getApplicationTimeline,
  getInterviewReflection,
  updateApplicationProcessStep,
} from "@/actions/application.actions";
import { getJobConnections } from "@/actions/jobConnections.actions";
import { resolveBusinessAiConfig } from "@/actions/aiAssignment.actions";

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

vi.mock("@/actions/jobConnections.actions", () => ({
  getJobConnections: vi.fn(),
}));

vi.mock("@/actions/question.actions", () => ({
  getQuestionsList: vi.fn(),
}));

vi.mock("@/actions/interviewReflectionAi.actions", () => ({
  generateInterviewReflectionDraft: vi.fn(),
}));

vi.mock("@/actions/aiAssignment.actions", () => ({
  resolveBusinessAiConfig: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const getTimeline = vi.mocked(getApplicationTimeline);
const getConnections = vi.mocked(getJobConnections);
const completeStep = vi.mocked(completeApplicationProcessStep);
const cancelStep = vi.mocked(cancelApplicationProcessStep);
const createStep = vi.mocked(createApplicationProcessStep);
const updateStep = vi.mocked(updateApplicationProcessStep);
const deleteStep = vi.mocked(deleteApplicationProcessStep);
const getReflection = vi.mocked(getInterviewReflection);
const resolveConfig = vi.mocked(resolveBusinessAiConfig);

function step(overrides: Partial<ApplicationTimelineDTO["attempts"][number]["steps"][number]> = {}) {
  return {
    id: "step-user",
    category: "INTERVIEW",
    label: "Hiring manager",
    status: "PENDING",
    source: "USER",
    scheduledAt: null,
    scheduledAtPrecision: null,
    scheduledAtZone: null,
    deadlineOn: null,
    deadlineAt: "2026-10-08T00:00:00.000Z",
    deadlinePrecision: null,
    deadlineZone: null,
    completedAt: null,
    completedAtPrecision: null,
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
    timeZone: "Asia/Shanghai",
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

function connections(
  overrides: Partial<JobConnectionsDTO> = {},
): JobConnectionsDTO {
  return {
    opportunityId: "job-1",
    currentJdVersion: null,
    plannedResumeVariants: [],
    practiceSessions: { total: 0, byJdVersion: [] },
    attemptMaterials: [],
    ...overrides,
  };
}

describe("ApplicationTimelineTab process step actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConnections.mockResolvedValue({
      success: true,
      data: connections(),
    });
    resolveConfig.mockResolvedValue({
      success: true,
      data: { status: "NOT_CONFIGURED" },
    } as never);
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

  it("warns about the interview detail cascade when deleting a detail-backed INTERVIEW step", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([step({ interviewDetailPresent: true })]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    await userEvent.click(await screen.findByTestId("delete-process-step"));
    expect(
      await screen.findByText(
        "Deleting this interview round also deletes its interview detail. This cannot be undone.",
      ),
    ).toBeInTheDocument();
  });

  it("includes the reflection item count in the cascade warning", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        step({ interviewDetailPresent: true, reflectionItemCount: 3 }),
      ]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    await userEvent.click(await screen.findByTestId("delete-process-step"));
    expect(
      await screen.findByText(
        "Deleting this interview round also deletes its interview detail and 3 reflection item(s). This cannot be undone.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the generic delete warning for steps without interview detail", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        step({ id: "step-plain", label: "Plain interview" }),
        step({
          id: "step-assessment",
          category: "ASSESSMENT",
          label: "Take-home",
          interviewDetailPresent: true,
        }),
      ]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />,
    );
    // INTERVIEW without a detail, and a detail-flagged non-INTERVIEW step,
    // both keep the original generic description.
    const generic =
      "The scheduled time, deadline, notes, and result for this step will be removed.";
    await userEvent.click(
      within(
        (await screen.findAllByTestId("application-process-step"))[0],
      ).getByTestId("delete-process-step"),
    );
    expect(await screen.findByText(generic)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(
      within(
        (await screen.findAllByTestId("application-process-step"))[1],
      ).getByTestId("delete-process-step"),
    );
    expect(await screen.findByText(generic)).toBeInTheDocument();
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
        reflectionCompletedAt: null,
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

  it("opens a read-only reflection when the timeline is read-only", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([step()]) });
    getReflection.mockResolvedValue({
      success: true,
      data: {
        applicationProcessStepId: "step-user",
        reflectionText: "It went okay.",
        reflectionCompletedAt: "2026-10-10T09:00:00.000Z",
        items: [],
      },
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate={false} />,
    );
    const row = await screen.findByTestId("application-process-step");
    // Read-only mode shows only the reflection entry in the actions column —
    // every mutation button stays hidden.
    expect(within(row).getAllByRole("button")).toHaveLength(1);
    const entry = within(row).getByTestId("interview-reflection-entry");
    expect(entry).toHaveTextContent("View reflection");

    await userEvent.click(entry);
    await waitFor(() => expect(getReflection).toHaveBeenCalledWith("step-user"));
    expect(
      await screen.findByTestId("interview-reflection-dialog"),
    ).toBeInTheDocument();
    // Read-only dialog: no AI section, no add-question, no save — but the
    // convert-to-task escape hatch stays usable.
    await waitFor(() =>
      expect(screen.getByTestId("interview-reflection-to-task")).toBeEnabled(),
    );
    expect(
      screen.queryByTestId("interview-reflection-save"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("interview-reflection-ai"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("interview-reflection-add-question"),
    ).not.toBeInTheDocument();
  });

  it("keeps non-INTERVIEW rows fully read-only when the timeline is read-only", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        step({ id: "step-interview", label: "Hiring manager" }),
        step({ id: "step-task", category: "ASSESSMENT", label: "Take-home" }),
      ]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate={false} />,
    );
    const rows = await screen.findAllByTestId("application-process-step");
    // The INTERVIEW row keeps its read-only entry; the ASSESSMENT row's
    // actions cell is rendered but empty.
    expect(
      within(rows[0]).getByTestId("interview-reflection-entry"),
    ).toBeInTheDocument();
    expect(within(rows[1]).queryAllByRole("button")).toHaveLength(0);
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
          scheduledAt: undefined,
          deadlineAt: undefined,
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


describe("ApplicationTimelineTab job connections view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConnections.mockResolvedValue({ success: true, data: connections() });
  });

  it("renders planned variants and the practice session count", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([]) });
    getConnections.mockResolvedValue({
      success: true,
      data: connections({
        currentJdVersion: { id: "jd-2", versionNumber: 2 },
        plannedResumeVariants: [
          {
            id: "var-1",
            name: "Campus",
            archivedAt: null,
            currentVersion: { id: "ver-2", versionNumber: 2, status: "FROZEN" },
          },
          {
            id: "var-2",
            name: "Old",
            archivedAt: "2024-01-02T00:00:00.000Z",
            currentVersion: { id: "ver-9", versionNumber: 9, status: "ARCHIVED" },
          },
        ],
        practiceSessions: {
          total: 3,
          byJdVersion: [
            { jdVersionId: "jd-1", versionNumber: 1, count: 2 },
            { jdVersionId: "jd-2", versionNumber: 2, count: 1 },
          ],
        },
      }),
    });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const summary = await screen.findByTestId("job-connections-summary");
    const variants = within(summary).getAllByTestId("planned-resume-variant");
    expect(variants[0]).toHaveTextContent("Campus");
    expect(variants[0]).toHaveTextContent("v2");
    expect(variants[0]).toHaveTextContent("Frozen");
    expect(variants[0].querySelector("a")).toHaveAttribute(
      "href",
      "/dashboard/profile/resumes/var-1",
    );
    expect(variants[1]).toHaveTextContent("Archived");
    expect(within(summary).getByTestId("practice-sessions-count")).toHaveTextContent(
      "3 practice session(s)",
    );
    expect(within(summary).getByTestId("practice-sessions-by-jd")).toHaveTextContent(
      "JD v1: 2",
    );
    expect(within(summary).getByTestId("practice-sessions-by-jd")).toHaveTextContent(
      "JD v2: 1",
    );
  });

  it("shows neutral empty states when nothing is planned or practiced", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([]) });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const summary = await screen.findByTestId("job-connections-summary");
    expect(within(summary).getByTestId("planned-resumes-empty")).toHaveTextContent(
      "No resume planned for this job yet.",
    );
    expect(within(summary).getByTestId("practice-sessions-count")).toHaveTextContent(
      "No practice sessions for this job yet.",
    );
    expect(
      within(summary).queryByTestId("practice-sessions-by-jd"),
    ).not.toBeInTheDocument();
  });

  it("shows the attempt's artifact and submitted JD version with a download entry", async () => {
    const data = timeline([]);
    data.attempts[0].submittedResume = {
      id: "ver-1",
      title: "Campus",
      versionNumber: 1,
      resumeVariantId: "var-1",
      resumeVariantVersionId: "ver-1",
    };
    getTimeline.mockResolvedValue({ success: true, data });
    getConnections.mockResolvedValue({
      success: true,
      data: connections({
        currentJdVersion: { id: "jd-2", versionNumber: 2 },
        attemptMaterials: [
          {
            attemptId: "att-1",
            submittedArtifact: {
              id: "art-1",
              kind: "EXPORT",
              format: "PDF",
              fileName: "campus.pdf",
              sha256: "abc123",
              byteSize: 1024,
            },
            submittedAgainstJdVersion: {
              id: "jd-1",
              versionNumber: 1,
              capturedAt: "2024-01-01T00:00:00.000Z",
            },
          },
        ],
      }),
    });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const facts = await screen.findByTestId("submitted-material-facts");
    expect(facts).toHaveTextContent("campus.pdf");
    expect(facts).toHaveTextContent("PDF");
    expect(within(facts).getByTestId("download-submitted-artifact")).toHaveAttribute(
      "href",
      "/api/profile/resume-artifacts/art-1",
    );
    expect(facts).toHaveTextContent("JD at submission");
    expect(facts).toHaveTextContent("v1");
    expect(facts).toHaveTextContent("current JD is v2");
  });

  it("renders neutral N/A for a submitted attempt with no bound materials", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([]) });
    getConnections.mockResolvedValue({
      success: true,
      data: connections({
        attemptMaterials: [
          {
            attemptId: "att-1",
            submittedArtifact: null,
            submittedAgainstJdVersion: null,
          },
        ],
      }),
    });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const facts = await screen.findByTestId("submitted-material-facts");
    expect(facts).toHaveTextContent("Submitted file");
    expect(facts).toHaveTextContent("N/A");
    expect(facts).toHaveTextContent("JD at submission");
    expect(
      within(facts).queryByTestId("download-submitted-artifact"),
    ).not.toBeInTheDocument();
  });

  it("hides material facts entirely for a draft attempt with nothing bound", async () => {
    const data = timeline([]);
    data.attempts[0].submittedAt = null;
    getTimeline.mockResolvedValue({ success: true, data });
    getConnections.mockResolvedValue({
      success: true,
      data: connections({
        attemptMaterials: [
          {
            attemptId: "att-1",
            submittedArtifact: null,
            submittedAgainstJdVersion: null,
          },
        ],
      }),
    });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    expect(await screen.findByText("No submitted resume linked")).toBeInTheDocument();
    expect(screen.queryByTestId("submitted-material-facts")).not.toBeInTheDocument();
  });

  it("marks whether the submitted resume belongs to a planned variant", async () => {
    const data = timeline([]);
    data.attempts[0].submittedResume = {
      id: "ver-1",
      title: "Campus",
      versionNumber: 1,
      resumeVariantId: "var-1",
      resumeVariantVersionId: "ver-1",
    };
    getTimeline.mockResolvedValue({ success: true, data });
    getConnections.mockResolvedValue({
      success: true,
      data: connections({
        plannedResumeVariants: [
          {
            id: "var-1",
            name: "Campus",
            archivedAt: null,
            currentVersion: { id: "ver-2", versionNumber: 2, status: "DRAFT" },
          },
        ],
      }),
    });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);
    expect(await screen.findByTestId("submitted-vs-planned")).toHaveTextContent(
      "From a planned resume",
    );
  });

  it("marks a submitted resume outside the planned set", async () => {
    const data = timeline([]);
    data.attempts[0].submittedResume = {
      id: "ver-1",
      title: "Other",
      versionNumber: 3,
      resumeVariantId: "var-9",
      resumeVariantVersionId: "ver-1",
    };
    getTimeline.mockResolvedValue({ success: true, data });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);
    expect(await screen.findByTestId("submitted-vs-planned")).toHaveTextContent(
      "Not a planned resume",
    );
  });

  it("keeps the connections view readable in read-only mode", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([]) });
    getConnections.mockResolvedValue({
      success: true,
      data: connections({
        plannedResumeVariants: [
          {
            id: "var-1",
            name: "Campus",
            archivedAt: null,
            currentVersion: { id: "ver-2", versionNumber: 2, status: "DRAFT" },
          },
        ],
        attemptMaterials: [
          {
            attemptId: "att-1",
            submittedArtifact: {
              id: "art-1",
              kind: "EXPORT",
              format: "PDF",
              fileName: "campus.pdf",
              sha256: "abc123",
              byteSize: 1024,
            },
            submittedAgainstJdVersion: null,
          },
        ],
      }),
    });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate={false} />);

    expect(await screen.findByTestId("job-connections-summary")).toBeInTheDocument();
    expect(await screen.findByTestId("submitted-material-facts")).toBeInTheDocument();
  });

  it("still renders the timeline when the connections read fails", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([step()]) });
    getConnections.mockResolvedValue({
      success: false,
      message: "unavailable",
    });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    expect(await screen.findByText("Hiring manager")).toBeInTheDocument();
    expect(screen.queryByTestId("job-connections-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("submitted-material-facts")).not.toBeInTheDocument();
  });
});
