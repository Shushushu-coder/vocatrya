import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApplicationTimelineTab } from "@/components/myjobs/job-details/ApplicationTimelineTab";
import { I18nProvider } from "@/i18n";
import type { ApplicationTimelineDTO } from "@/lib/career/applicationTimeline";
import {
  createApplicationAttempt,
  createTransferredAttempt,
  getApplicationTimeline,
  listTransferTargetOpportunities,
} from "@/actions/application.actions";
import { toastError, toastSuccess } from "@/lib/toast";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/actions/application.actions", () => ({
  getApplicationTimeline: vi.fn(),
  getSubmittedResumeBindings: vi.fn(),
  createApplicationProcessStep: vi.fn(),
  createApplicationAttempt: vi.fn(),
  createTransferredAttempt: vi.fn(),
  listTransferTargetOpportunities: vi.fn(),
  updateApplicationProcessStep: vi.fn(),
  completeApplicationProcessStep: vi.fn(),
  deleteApplicationProcessStep: vi.fn(),
  getInterviewReflection: vi.fn(),
  saveInterviewReflection: vi.fn(),
  attachAttemptResumeVersion: vi.fn(),
}));

vi.mock("@/actions/resumeVariant.actions", () => ({
  listSubmittableResumeVersions: vi
    .fn()
    .mockResolvedValue({ success: true, data: [] }),
}));

vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const getTimeline = vi.mocked(getApplicationTimeline);
const createAttempt = vi.mocked(createApplicationAttempt);
const transferAttempt = vi.mocked(createTransferredAttempt);
const listTargets = vi.mocked(listTransferTargetOpportunities);
const errorToast = vi.mocked(toastError);
const successToast = vi.mocked(toastSuccess);

type AttemptDTO = ApplicationTimelineDTO["attempts"][number];

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

function timeline(attempts: AttemptDTO[]): ApplicationTimelineDTO {
  return { opportunityId: "job-1", attempts };
}

function attemptSection(id: string): HTMLElement {
  const section = document.querySelector(`[data-attempt-id="${id}"]`);
  expect(section).not.toBeNull();
  return section as HTMLElement;
}

describe("new application entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an explicit second round and shows it after refresh", async () => {
    getTimeline
      .mockResolvedValueOnce({ success: true, data: timeline([attempt()]) })
      .mockResolvedValue({
        success: true,
        data: timeline([
          attempt(),
          attempt({
            id: "att-2",
            channelLabel: "官网投递",
            currentStageCategory: "DRAFT",
            submittedAt: null,
            createdAt: "2024-02-01T00:00:00.000Z",
          }),
        ]),
      });
    createAttempt.mockResolvedValue({
      success: true,
      data: { id: "att-2" },
    });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(
      await screen.findByRole("button", { name: "New application" }),
    );
    await user.type(
      await screen.findByTestId("attempt-channel-input"),
      "官网投递",
    );
    await user.click(screen.getByTestId("create-attempt-save"));

    await waitFor(() =>
      expect(createAttempt).toHaveBeenCalledWith({
        jobOpportunityId: "job-1",
        channelLabel: "官网投递",
        channelCategory: null,
        sourceUrl: null,
        notes: null,
      }),
    );
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    expect(
      successToast.mock.calls.some(([text]) => text === "Application round created"),
    ).toBe(true);
    expect(await screen.findByText("官网投递")).toBeInTheDocument();
    expect(
      within(attemptSection("att-2")).getByTestId("attempt-channel"),
    ).toHaveTextContent("官网投递");
  });

  it("requires a channel and keeps the draft on failure", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt()]),
    });
    createAttempt
      .mockResolvedValueOnce({ success: false, message: "server down" })
      .mockResolvedValue({ success: true, data: { id: "att-2" } });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(
      await screen.findByRole("button", { name: "New application" }),
    );
    await user.click(await screen.findByTestId("create-attempt-save"));
    expect(
      await screen.findByTestId("attempt-channel-error"),
    ).toHaveTextContent("Channel is required.");
    expect(createAttempt).not.toHaveBeenCalled();

    await user.type(screen.getByTestId("attempt-channel-input"), "Referral");
    await user.click(screen.getByTestId("create-attempt-save"));
    await waitFor(() => expect(createAttempt).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith("server down"),
    );
    // Failed submit keeps the dialog open with the typed channel intact.
    expect(screen.getByTestId("attempt-channel-input")).toHaveValue("Referral");

    await user.click(screen.getByTestId("create-attempt-save"));
    await waitFor(() => expect(createAttempt).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByTestId("attempt-channel-input"),
      ).not.toBeInTheDocument(),
    );
  });

  it("submits on Enter inside the form and closes on Escape", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt()]),
    });
    createAttempt.mockResolvedValue({ success: true, data: { id: "att-2" } });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(
      await screen.findByRole("button", { name: "New application" }),
    );
    await user.type(
      await screen.findByTestId("attempt-channel-input"),
      "内推{Enter}",
    );
    await waitFor(() => expect(createAttempt).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.queryByTestId("attempt-channel-input"),
      ).not.toBeInTheDocument(),
    );

    await user.click(
      await screen.findByRole("button", { name: "New application" }),
    );
    await screen.findByTestId("attempt-channel-input");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByTestId("attempt-channel-input"),
      ).not.toBeInTheDocument(),
    );
  });

  it("offers the entry in the empty timeline state", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([]) });
    createAttempt.mockResolvedValue({
      success: true,
      data: { id: "att-1" },
    });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(await screen.findByTestId("add-attempt"));
    await user.type(
      await screen.findByTestId("attempt-channel-input"),
      "BOSS直聘",
    );
    await user.type(
      screen.getByTestId("attempt-channel-category-input"),
      " 招聘网站 ",
    );
    await user.type(
      screen.getByTestId("attempt-source-url-input"),
      "https://example.com/jobs/1",
    );
    await user.type(
      screen.getByTestId("attempt-notes-input"),
      "优先跟进",
    );
    await user.click(screen.getByTestId("create-attempt-save"));
    await waitFor(() =>
      expect(createAttempt).toHaveBeenCalledWith({
        jobOpportunityId: "job-1",
        channelLabel: "BOSS直聘",
        channelCategory: "招聘网站",
        sourceUrl: "https://example.com/jobs/1",
        notes: "优先跟进",
      }),
    );
  });

  it("hides both mutation entries when the timeline is read-only", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt()]),
    });
    render(
      <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate={false} />,
    );
    expect(
      await screen.findByTestId("application-timeline"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("add-attempt")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transfer-attempt")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New application" }),
    ).not.toBeInTheDocument();
  });

  it("disables the save while a creation is in flight", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt()]),
    });
    let resolveSave: ((value: unknown) => void) | undefined;
    createAttempt.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }) as never,
    );
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(
      await screen.findByRole("button", { name: "New application" }),
    );
    await user.type(
      await screen.findByTestId("attempt-channel-input"),
      "Portal",
    );
    const save = screen.getByTestId("create-attempt-save");
    await user.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    await user.click(save);
    expect(createAttempt).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("attempt-channel-input")).toHaveValue("Portal");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("attempt-channel-input")).toHaveValue("Portal");

    resolveSave?.({ success: true, data: { id: "att-2" } });
    await waitFor(() =>
      expect(
        screen.queryByTestId("attempt-channel-input"),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("transfer entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reaches later target pages and keeps the dialog open while transferring", async () => {
    getTimeline.mockResolvedValue({ success: true, data: timeline([attempt()]) });
    listTargets.mockResolvedValueOnce({ success: true, data: {
      items: [{ id: "job-2", title: "First page", company: "Company" }], nextOffset: 200,
    } }).mockResolvedValue({ success: true, data: {
      items: [{ id: "job-201", title: "Older position", company: "Company" }], nextOffset: null,
    } });
    let finishTransfer!: (value: { success: true; data: { id: string } }) => void;
    transferAttempt.mockReturnValue(new Promise((resolve) => { finishTransfer = resolve; }));
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);
    await user.click(await screen.findByTestId("transfer-attempt"));
    await user.click(await screen.findByRole("button", { name: "Next page" }));
    await screen.findByRole("option", { name: "Older position · Company" });
    expect(listTargets).toHaveBeenLastCalledWith("job-1", 200);
    await user.selectOptions(screen.getByTestId("transfer-target-select"), "job-201");
    await user.click(screen.getByTestId("transfer-attempt-confirm"));
    await waitFor(() => expect(screen.getByTestId("transfer-attempt-confirm")).toBeDisabled());
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("transfer-attempt-dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("transfer-attempt-dialog")).toBeInTheDocument();
    finishTransfer({ success: true, data: { id: "att-new" } });
    await waitFor(() => expect(screen.queryByTestId("transfer-attempt-dialog")).not.toBeInTheDocument());
    expect(transferAttempt).toHaveBeenCalledWith({ sourceAttemptId: "att-1", targetJobOpportunityId: "job-201" });
  });

  it("shows Transfer only on live, non-terminal attempts", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([
        attempt({ id: "att-active", outcome: "ACTIVE" }),
        attempt({ id: "att-offer", outcome: "OFFER" }),
        attempt({ id: "att-rejected", outcome: "REJECTED" }),
        attempt({ id: "att-transferred", outcome: "TRANSFERRED" }),
        attempt({ id: "att-archived", archivedAt: "2024-03-01T00:00:00.000Z" }),
      ]),
    });
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    expect(await screen.findByTestId("application-timeline")).toBeInTheDocument();
    expect(
      within(attemptSection("att-active")).getByTestId("transfer-attempt"),
    ).toBeInTheDocument();
    expect(
      within(attemptSection("att-offer")).getByTestId("transfer-attempt"),
    ).toBeInTheDocument();
    for (const id of ["att-rejected", "att-transferred", "att-archived"]) {
      expect(
        within(attemptSection(id)).queryByTestId("transfer-attempt"),
      ).not.toBeInTheDocument();
    }
  });

  it("transfers to the picked position and refreshes the timeline", async () => {
    getTimeline
      .mockResolvedValueOnce({ success: true, data: timeline([attempt()]) })
      .mockResolvedValue({
        success: true,
        data: timeline([attempt({ outcome: "TRANSFERRED" })]),
      });
    listTargets.mockResolvedValue({
      success: true,
      data: { items: [
        { id: "job-2", title: "云计算工程师", company: "Tencent" },
        { id: "job-3", title: "数据分析师", company: "OtherCo" },
      ], nextOffset: null },
    });
    transferAttempt.mockResolvedValue({
      success: true,
      data: { id: "att-new" },
    });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(await screen.findByTestId("transfer-attempt"));
    await waitFor(() =>
      expect(listTargets).toHaveBeenCalledWith("job-1", 0),
    );
    const select = await screen.findByTestId("transfer-target-select");
    expect(
      within(select).getByRole("option", { name: "云计算工程师 · Tencent" }),
    ).toBeInTheDocument();

    await user.selectOptions(select, "job-3");
    await user.click(screen.getByTestId("transfer-attempt-confirm"));

    await waitFor(() =>
      expect(transferAttempt).toHaveBeenCalledWith({
        sourceAttemptId: "att-1",
        targetJobOpportunityId: "job-3",
      }),
    );
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    expect(
      successToast.mock.calls.some(
        ([text]) => text === "Application transferred",
      ),
    ).toBe(true);
    // The transferred source stays on this job with its terminal outcome.
    expect(
      within(attemptSection("att-1")).queryByTestId("transfer-attempt"),
    ).not.toBeInTheDocument();
  });

  it("requires a target before confirming", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt()]),
    });
    listTargets.mockResolvedValue({
      success: true,
      data: { items: [{ id: "job-2", title: "云计算工程师", company: "Tencent" }], nextOffset: null },
    });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(await screen.findByTestId("transfer-attempt"));
    await screen.findByTestId("transfer-target-select");
    await user.click(screen.getByTestId("transfer-attempt-confirm"));
    expect(
      await screen.findByTestId("transfer-target-error"),
    ).toHaveTextContent("Select the position to transfer to.");
    expect(transferAttempt).not.toHaveBeenCalled();
  });

  it("disables confirm when no legal target exists", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt()]),
    });
    listTargets.mockResolvedValue({ success: true, data: { items: [], nextOffset: null } });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(await screen.findByTestId("transfer-attempt"));
    expect(
      await screen.findByTestId("transfer-targets-empty"),
    ).toHaveTextContent("No other positions to transfer to.");
    expect(screen.getByTestId("transfer-attempt-confirm")).toBeDisabled();
    expect(transferAttempt).not.toHaveBeenCalled();
  });

  it("surfaces the terminal-source error and refreshes the timeline", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt()]),
    });
    listTargets.mockResolvedValue({
      success: true,
      data: { items: [{ id: "job-2", title: "云计算工程师", company: "Tencent" }], nextOffset: null },
    });
    transferAttempt.mockResolvedValue({
      success: false,
      code: "TRANSFER_SOURCE_TERMINAL",
      message: "terminal",
    });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(await screen.findByTestId("transfer-attempt"));
    const select = await screen.findByTestId("transfer-target-select");
    await user.selectOptions(select, "job-2");
    await user.click(screen.getByTestId("transfer-attempt-confirm"));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "This application has ended and cannot be transferred.",
      ),
    );
    await waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2));
    // A rejected transfer keeps the dialog open for another try.
    expect(screen.getByTestId("transfer-attempt-dialog")).toBeInTheDocument();
  });

  it("surfaces a target-list failure inside the dialog", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt()]),
    });
    listTargets.mockResolvedValue({
      success: false,
      message: "timeline unavailable",
    });
    const user = userEvent.setup();
    render(<ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />);

    await user.click(await screen.findByTestId("transfer-attempt"));
    expect(
      await screen.findByTestId("transfer-targets-error"),
    ).toHaveTextContent("timeline unavailable");
    expect(screen.getByTestId("transfer-attempt-confirm")).toBeDisabled();
  });
});

describe("locales", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the new entries in zh-CN", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: timeline([attempt()]),
    });
    listTargets.mockResolvedValue({ success: true, data: { items: [], nextOffset: null } });
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="zh-CN">
        <ApplicationTimelineTab jobId="job-1" refreshKey={0} canMutate />
      </I18nProvider>,
    );

    expect(
      await screen.findByRole("button", { name: "新建投递轮次" }),
    ).toBeInTheDocument();
    await user.click(await screen.findByTestId("transfer-attempt"));
    expect(await screen.findByText("转投申请")).toBeInTheDocument();
    expect(
      await screen.findByTestId("transfer-targets-empty"),
    ).toHaveTextContent("没有其他可转投的职位。");
    await user.click(screen.getByRole("button", { name: "取消" }));

    await user.click(
      screen.getByRole("button", { name: "新建投递轮次" }),
    );
    expect(
      await screen.findByTestId("attempt-channel-input"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("投递渠道")).toBeInTheDocument();
    await user.click(screen.getByTestId("create-attempt-save"));
    expect(
      await screen.findByTestId("attempt-channel-error"),
    ).toHaveTextContent("请填写投递渠道。");
  });
});
