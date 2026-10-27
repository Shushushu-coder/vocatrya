import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApplicationTimelineTab } from "@/components/myjobs/job-details/ApplicationTimelineTab";
import { I18nProvider } from "@/i18n";
import type { ApplicationTimelineDTO } from "@/lib/career/applicationTimeline";
import {
  createApplicationProcessStep,
  getApplicationTimeline,
  updateApplicationProcessStep,
} from "@/actions/application.actions";
import { toastError } from "@/lib/toast";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/actions/application.actions", () => ({
  getApplicationTimeline: vi.fn(),
  getSubmittedResumeBindings: vi.fn(),
  createApplicationProcessStep: vi.fn(),
  updateApplicationProcessStep: vi.fn(),
  completeApplicationProcessStep: vi.fn(),
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
const createStep = vi.mocked(createApplicationProcessStep);
const updateStep = vi.mocked(updateApplicationProcessStep);
const errorToast = vi.mocked(toastError);

type AttemptDTO = ApplicationTimelineDTO["attempts"][number];
type StepDTO = AttemptDTO["steps"][number];

function attempt(overrides: Partial<AttemptDTO> = {}): AttemptDTO {
  return {
    id: "att-1",
    channelLabel: "Careers page",
    submittedAt: "2024-01-01T00:00:00.000Z",
    createdAt: "2024-01-01T00:00:00.000Z",
    archivedAt: null,
    currentStageCategory: "SUBMITTED",
    outcome: "ACTIVE",
    transferredFromAttemptId: null,
    transferredFrom: null,
    submittedResume: null,
    steps: [],
    ...overrides,
  };
}

function step(overrides: Partial<StepDTO> = {}): StepDTO {
  return {
    id: "step-1",
    category: "INTERVIEW",
    label: "Hiring manager",
    status: "PENDING",
    source: "USER",
    scheduledAt: null,
    scheduledAtPrecision: null,
    scheduledAtZone: null,
    deadlineOn: null,
    deadlineAt: null,
    deadlinePrecision: null,
    deadlineZone: null,
    completedAt: null,
    completedAtPrecision: null,
    result: null,
    notes: null,
    ...overrides,
  };
}

function timeline(attempts: AttemptDTO[]): ApplicationTimelineDTO {
  return { opportunityId: "job-1", timeZone: "Asia/Shanghai", attempts };
}

function twoAttempts(): ApplicationTimelineDTO {
  return timeline([
    attempt({
      id: "att-a",
      channelLabel: "BOSS直聘",
      currentStageCategory: "INTERVIEW",
      submittedAt: "2024-01-05T00:00:00.000Z",
    }),
    attempt({
      id: "att-b",
      channelLabel: "Referral",
      currentStageCategory: "DRAFT",
      submittedAt: null,
      createdAt: "2024-02-02T00:00:00.000Z",
    }),
  ]);
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>, name = "Add process step") {
  await user.click(await screen.findByRole("button", { name }));
  return screen.findByTestId("attempt-select");
}

describe("zero live attempts", () => {
  it("labels the entry as create-draft-and-add and creates nothing until explicit save", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([]) });
    createStep.mockResolvedValue({ success: true, data: { id: "s1" } as never });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const entry = await screen.findByRole("button", {
      name: "Create application draft and add step",
    });
    await user.click(entry);
    expect(
      await screen.findByTestId("attempt-draft-notice"),
    ).toBeInTheDocument();
    expect(createStep).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByTestId("attempt-draft-notice"),
      ).not.toBeInTheDocument(),
    );
    expect(createStep).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: "Create application draft and add step",
      }),
    );
    await user.type(await screen.findByLabelText("Step name"), "Phone screen");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(createStep).toHaveBeenCalledWith(
        expect.objectContaining({
          jobOpportunityId: "job-1",
          label: "Phone screen",
          createDraftAttempt: true,
        }),
      ),
    );
    expect(
      createStep.mock.calls[0][0].applicationAttemptId,
    ).toBeUndefined();
  });

  it("offers the draft flow when every existing attempt is archived", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        attempt({
          archivedAt: "2024-02-01T00:00:00.000Z",
          currentStageCategory: "CLOSED",
        }),
      ]),
    });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    expect(await screen.findByText("Archived")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Create application draft and add step",
      }),
    );
    expect(
      await screen.findByTestId("attempt-draft-notice"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("attempt-select")).not.toBeInTheDocument();
  });

  it("keeps the draft and demands an explicit re-pick when the attempt list changed", async () => {
    getTimeline
      .mockResolvedValueOnce({ success: true, data: timeline([]) })
      .mockResolvedValue({
        success: true,
        data: timeline([
          attempt({ id: "att-new", channelLabel: "Portal" }),
        ]),
      });
    createStep
      .mockResolvedValueOnce({
        success: false,
        code: "PROCESS_STEP_ATTEMPT_STATE_CHANGED",
        message: "changed",
      })
      .mockResolvedValue({ success: true, data: { id: "s-1" } as never });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(
      await screen.findByRole("button", {
        name: "Create application draft and add step",
      }),
    );
    await user.type(await screen.findByLabelText("Step name"), "Phone screen");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(createStep).toHaveBeenCalledWith(
        expect.objectContaining({ createDraftAttempt: true }),
      ),
    );
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "The application list changed while you were editing. The list was refreshed — confirm which application this step belongs to.",
      ),
    );
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));

    // Draft fields survive the refresh; the picker appears with no implicit
    // selection so the user must confirm ownership again.
    expect(screen.getByLabelText("Step name")).toHaveValue("Phone screen");
    expect(
      screen.queryByTestId("attempt-draft-notice"),
    ).not.toBeInTheDocument();
    const select = await screen.findByTestId("attempt-select");
    expect(select).toHaveValue("");

    await user.selectOptions(select, "att-new");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(createStep).toHaveBeenLastCalledWith(
        expect.objectContaining({ applicationAttemptId: "att-new" }),
      ),
    );
    expect(
      createStep.mock.calls[1][0].createDraftAttempt,
    ).toBeUndefined();
  });
});

describe("single live attempt", () => {
  it("preselects the only attempt and passes its id explicitly", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt()]),
    });
    createStep.mockResolvedValue({ success: true, data: { id: "s1" } as never });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const select = await openCreateDialog(user);
    expect(select).toHaveValue("att-1");
    await user.type(screen.getByLabelText("Step name"), "Onsite");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(createStep).toHaveBeenCalledWith(
        expect.objectContaining({ applicationAttemptId: "att-1" }),
      ),
    );
  });
});

describe("multiple live attempts", () => {
  it("requires a selection before submitting", async () => {
    getTimeline.mockResolvedValue({ success: true, data: twoAttempts() });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const select = await openCreateDialog(user);
    expect(select).toHaveClass("w-full", "max-w-full");
    await user.type(screen.getByLabelText("Step name"), "HR call");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "Select which application this step belongs to.",
      ),
    ).toBeInTheDocument();
    expect(createStep).not.toHaveBeenCalled();
  });

  it("writes to the explicitly chosen attempt and labels options by channel, stage, and date", async () => {
    getTimeline.mockResolvedValue({ success: true, data: twoAttempts() });
    createStep.mockResolvedValue({ success: true, data: { id: "s1" } as never });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const select = (await openCreateDialog(user)) as HTMLSelectElement;
    expect(
      within(select).getByRole("option", {
        name: /BOSS直聘 · Interview · Submitted/,
      }),
    ).toBeInTheDocument();
    expect(
      within(select).getByRole("option", {
        name: /Referral · Draft · Recorded/,
      }),
    ).toBeInTheDocument();

    await user.selectOptions(select, "att-b");
    await user.type(screen.getByLabelText("Step name"), "Round 2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(createStep).toHaveBeenCalledWith(
        expect.objectContaining({ applicationAttemptId: "att-b" }),
      ),
    );
  });

  it("lands the saved step under the chosen attempt after refresh", async () => {
    const refreshed = timeline([
      attempt({ id: "att-a", channelLabel: "BOSS直聘" }),
      attempt({
        id: "att-b",
        channelLabel: "Referral",
        steps: [step({ id: "s-new", label: "Round 2" })],
      }),
    ]);
    getTimeline
      .mockResolvedValueOnce({ success: true, data: twoAttempts() })
      .mockResolvedValue({ success: true, data: refreshed });
    createStep.mockResolvedValue({
      success: true,
      data: { id: "s-new" } as never,
    });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const select = await openCreateDialog(user);
    await user.selectOptions(select, "att-b");
    await user.type(screen.getByLabelText("Step name"), "Round 2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Round 2");
    const sectionB = document.querySelector('[data-attempt-id="att-b"]');
    const sectionA = document.querySelector('[data-attempt-id="att-a"]');
    expect(sectionB).not.toBeNull();
    expect(within(sectionB as HTMLElement).getByText("Round 2")).toBeInTheDocument();
    expect(
      within(sectionA as HTMLElement).queryByText("Round 2"),
    ).not.toBeInTheDocument();
  });

  it("surfaces the ambiguous error, refreshes, and lets the user reselect", async () => {
    getTimeline.mockResolvedValue({ success: true, data: twoAttempts() });
    createStep
      .mockResolvedValueOnce({
        success: false,
        code: "PROCESS_STEP_ATTEMPT_AMBIGUOUS",
        message: "ambiguous",
      })
      .mockResolvedValue({ success: true, data: { id: "s2" } as never });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const select = await openCreateDialog(user);
    await user.selectOptions(select, "att-a");
    await user.type(screen.getByLabelText("Step name"), "HR call");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "Several applications exist — choose which one this step belongs to.",
      ),
    );
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Step name")).toHaveValue("HR call");

    await user.selectOptions(screen.getByTestId("attempt-select"), "att-b");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(createStep).toHaveBeenLastCalledWith(
        expect.objectContaining({ applicationAttemptId: "att-b" }),
      ),
    );
  });

  it("clears an archived selection after refresh while keeping the draft", async () => {
    const afterArchive = timeline([
      attempt({
        id: "att-a",
        channelLabel: "BOSS直聘",
        archivedAt: "2024-03-01T00:00:00.000Z",
      }),
      attempt({
        id: "att-b",
        channelLabel: "Referral",
        currentStageCategory: "DRAFT",
        submittedAt: null,
      }),
    ]);
    getTimeline
      .mockResolvedValueOnce({ success: true, data: twoAttempts() })
      .mockResolvedValue({ success: true, data: afterArchive });
    createStep.mockResolvedValue({
      success: false,
      code: "ATTEMPT_ARCHIVED",
      message: "archived",
    });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const select = await openCreateDialog(user);
    await user.selectOptions(select, "att-a");
    await user.type(screen.getByLabelText("Step name"), "Follow up");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "That application was archived and can no longer accept steps. The list was refreshed — choose an application again.",
      ),
    );
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("attempt-select")).toHaveValue(""),
    );
    expect(screen.getByLabelText("Step name")).toHaveValue("Follow up");
    expect(
      within(screen.getByTestId("attempt-select")).queryByRole("option", {
        name: /BOSS直聘/,
      }),
    ).not.toBeInTheDocument();
  });
});

describe("saved steps and locales", () => {
  it("does not offer the attempt picker when editing a saved step", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt({ steps: [step()] })]),
    });
    updateStep.mockResolvedValue({ success: true, data: step() as never });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(
      await screen.findByRole("button", { name: "Edit" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Edit process step" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("attempt-select")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("attempt-draft-notice"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateStep).toHaveBeenCalled());
    expect(updateStep.mock.calls[0][0]).not.toHaveProperty(
      "applicationAttemptId",
    );
  });

  it("renders the picker copy in zh-CN", async () => {
    getTimeline.mockResolvedValue({ success: true, data: twoAttempts() });
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="zh-CN">
        <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />
      </I18nProvider>,
    );

    await user.click(
      await screen.findByRole("button", { name: "添加流程步骤" }),
    );
    expect(await screen.findByText("所属申请")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("attempt-select")).getByRole("option", {
        name: "选择申请记录",
      }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("步骤名称"), "一面");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(
      await screen.findByText("请选择此事件所属的申请记录。"),
    ).toBeInTheDocument();
    expect(createStep).not.toHaveBeenCalled();
  });

  it("closes on Escape without side effects and frees focus from the dialog", async () => {
    getTimeline.mockResolvedValue({ success: true, data: twoAttempts() });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    const addButton = await screen.findByRole("button", {
      name: "Add process step",
    });
    await user.click(addButton);
    const dialog = await screen.findByRole("dialog");
    expect(await screen.findByTestId("attempt-select")).toBeInTheDocument();
    // Keyboard focus is delivered into the dialog, then released back to
    // the page when the dialog closes.
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByTestId("attempt-select")).not.toBeInTheDocument(),
    );
    expect(createStep).not.toHaveBeenCalled();
    expect(document.activeElement?.closest('[role="dialog"]')).toBeNull();
  });
});
