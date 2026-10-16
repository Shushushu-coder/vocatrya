import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InterviewReflectionDialog } from "@/components/myjobs/job-details/InterviewReflectionDialog";
import { I18nProvider } from "@/i18n";
import {
  getInterviewReflection,
  saveInterviewReflection,
} from "@/actions/application.actions";
import type { ApplicationProcessStepDTO } from "@/lib/career/applicationTimeline";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/actions/application.actions", () => ({
  getInterviewReflection: vi.fn(),
  saveInterviewReflection: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const getReflection = vi.mocked(getInterviewReflection);
const saveReflection = vi.mocked(saveInterviewReflection);

const step: ApplicationProcessStepDTO = {
  id: "step-interview",
  category: "INTERVIEW",
  label: "Hiring manager",
  status: "PENDING",
  source: "USER",
  scheduledAt: null,
  deadlineAt: null,
  completedAt: null,
  result: null,
  notes: "timeline notes stay separate",
};

function existingReflection() {
  return {
    applicationProcessStepId: "step-interview",
    reflectionText: "项目经历回答还是太散。",
    items: [
      {
        id: "item-a",
        questionText: "介绍一下你的推荐系统项目",
        answerNotes: "讲了模型，但没有明确个人贡献",
        sortOrder: 10,
      },
      {
        id: "item-b",
        questionText: "最大的技术挑战是什么",
        answerNotes: "冷启动",
        sortOrder: 20,
      },
    ],
  };
}

describe("InterviewReflectionDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows existing question text, answer notes, and overall reflection", async () => {
    getReflection.mockResolvedValue({
      success: true,
      data: existingReflection(),
    });
    render(
      <InterviewReflectionDialog
        open
        onOpenChange={vi.fn()}
        step={step}
        companyName="Acme"
        roleTitle="Software Engineer"
      />,
    );
    expect(
      await screen.findByDisplayValue("介绍一下你的推荐系统项目"),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("讲了模型，但没有明确个人贡献"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("最大的技术挑战是什么")).toBeInTheDocument();
    expect(screen.getByDisplayValue("冷启动")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("项目经历回答还是太散。"),
    ).toBeInTheDocument();
    expect(screen.getByText("Hiring manager · Acme / Software Engineer")).toBeInTheDocument();
    expect(screen.queryByText("should-not-be-round-source")).not.toBeInTheDocument();
  });

  it("adds a question row locally without saving", async () => {
    getReflection.mockResolvedValue({
      success: true,
      data: {
        applicationProcessStepId: "step-interview",
        reflectionText: null,
        items: [],
      },
    });
    render(
      <InterviewReflectionDialog open onOpenChange={vi.fn()} step={step} />,
    );
    await screen.findByTestId("interview-reflection-add-question");
    expect(
      screen.queryByTestId("interview-reflection-question-row"),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("interview-reflection-add-question"));
    expect(screen.getAllByTestId("interview-reflection-question-row")).toHaveLength(1);
    expect(saveReflection).not.toHaveBeenCalled();
  });

  it("removes an unsaved question without calling the server", async () => {
    getReflection.mockResolvedValue({
      success: true,
      data: {
        applicationProcessStepId: "step-interview",
        reflectionText: null,
        items: [],
      },
    });
    render(
      <InterviewReflectionDialog open onOpenChange={vi.fn()} step={step} />,
    );
    await userEvent.click(
      await screen.findByTestId("interview-reflection-add-question"),
    );
    await userEvent.click(screen.getByTestId("interview-reflection-remove-question"));
    expect(
      screen.queryByTestId("interview-reflection-question-row"),
    ).not.toBeInTheDocument();
    expect(saveReflection).not.toHaveBeenCalled();
  });

  it("saves existing ids, omits new item ids, and keeps array order", async () => {
    getReflection.mockResolvedValue({
      success: true,
      data: existingReflection(),
    });
    saveReflection.mockResolvedValue({
      success: true,
      data: existingReflection(),
    });
    const onOpenChange = vi.fn();
    render(
      <InterviewReflectionDialog
        open
        onOpenChange={onOpenChange}
        step={step}
      />,
    );
    await screen.findByDisplayValue("介绍一下你的推荐系统项目");
    await userEvent.click(screen.getByTestId("interview-reflection-add-question"));
    const questionFields = screen.getAllByTestId("interview-reflection-question");
    await userEvent.type(questionFields[2], "你还有什么想问我们的");
    await userEvent.click(screen.getByTestId("interview-reflection-save"));
    await waitFor(() => expect(saveReflection).toHaveBeenCalledTimes(1));
    expect(saveReflection).toHaveBeenCalledWith({
      applicationProcessStepId: "step-interview",
      reflectionText: "项目经历回答还是太散。",
      items: [
        {
          id: "item-a",
          questionText: "介绍一下你的推荐系统项目",
          answerNotes: "讲了模型，但没有明确个人贡献",
        },
        {
          id: "item-b",
          questionText: "最大的技术挑战是什么",
          answerNotes: "冷启动",
        },
        {
          questionText: "你还有什么想问我们的",
          answerNotes: "",
        },
      ],
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not save when Cancel is clicked after edits", async () => {
    getReflection.mockResolvedValue({
      success: true,
      data: {
        applicationProcessStepId: "step-interview",
        reflectionText: null,
        items: [],
      },
    });
    const onOpenChange = vi.fn();
    render(
      <InterviewReflectionDialog
        open
        onOpenChange={onOpenChange}
        step={step}
      />,
    );
    await userEvent.click(
      await screen.findByTestId("interview-reflection-add-question"),
    );
    await userEvent.type(
      screen.getByTestId("interview-reflection-question"),
      "介绍一下你自己",
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(saveReflection).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not submit a row with empty question text", async () => {
    getReflection.mockResolvedValue({
      success: true,
      data: {
        applicationProcessStepId: "step-interview",
        reflectionText: null,
        items: [],
      },
    });
    render(
      <InterviewReflectionDialog open onOpenChange={vi.fn()} step={step} />,
    );
    await userEvent.click(
      await screen.findByTestId("interview-reflection-add-question"),
    );
    await userEvent.type(
      screen.getByTestId("interview-reflection-answer"),
      "只有回答没有问题",
    );
    await userEvent.click(screen.getByTestId("interview-reflection-save"));
    expect(saveReflection).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("interview-reflection-form-error"),
    ).toHaveTextContent("Interview question is required.");
    expect(screen.getByTestId("interview-reflection-dialog")).toBeInTheDocument();
  });

  it("keeps the dialog open with typed content when save fails", async () => {
    getReflection.mockResolvedValue({
      success: true,
      data: {
        applicationProcessStepId: "step-interview",
        reflectionText: null,
        items: [],
      },
    });
    saveReflection.mockResolvedValue({
      success: false,
      message: "save exploded",
    });
    const onOpenChange = vi.fn();
    render(
      <InterviewReflectionDialog
        open
        onOpenChange={onOpenChange}
        step={step}
      />,
    );
    await userEvent.click(
      await screen.findByTestId("interview-reflection-add-question"),
    );
    await userEvent.type(
      screen.getByTestId("interview-reflection-question"),
      "介绍一下你的推荐系统项目",
    );
    await userEvent.type(
      screen.getByTestId("interview-reflection-overall"),
      "整场复盘草稿",
    );
    await userEvent.click(screen.getByTestId("interview-reflection-save"));
    await waitFor(() => expect(saveReflection).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("interview-reflection-dialog")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("介绍一下你的推荐系统项目"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("整场复盘草稿")).toBeInTheDocument();
  });

  it("shows the load error instead of an empty form", async () => {
    getReflection.mockResolvedValue({
      success: false,
      message: "Failed to load interview reflection.",
    });
    render(
      <InterviewReflectionDialog open onOpenChange={vi.fn()} step={step} />,
    );
    expect(
      await screen.findByTestId("interview-reflection-error"),
    ).toHaveTextContent("Failed to load interview reflection.");
    expect(
      screen.queryByTestId("interview-reflection-add-question"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("interview-reflection-overall")).not.toBeInTheDocument();
  });

  it("shows the load failure message when the reflection request rejects", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      getReflection.mockRejectedValueOnce(new Error("network down"));
      render(
        <InterviewReflectionDialog open onOpenChange={vi.fn()} step={step} />,
      );
      expect(
        await screen.findByTestId("interview-reflection-error"),
      ).toHaveTextContent(
        "Failed to load the reflection. Please close and reopen the dialog.",
      );
      expect(
        screen.queryByTestId("interview-reflection-loading"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("interview-reflection-save")).toBeDisabled();
      // The catch handler renders the error before this point; a missing
      // handler would surface as an unhandled rejection on the next tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("pins header and footer outside a dedicated scrollable body", async () => {
    getReflection.mockResolvedValue({
      success: true,
      data: existingReflection(),
    });
    render(
      <InterviewReflectionDialog open onOpenChange={vi.fn()} step={step} />,
    );
    await screen.findByDisplayValue("介绍一下你的推荐系统项目");

    const content = screen.getByTestId("interview-reflection-dialog");
    expect(content).toHaveClass("flex", "flex-col", "overflow-hidden");
    expect(content.className).toContain("max-h-");

    const body = screen.getByTestId("interview-reflection-body");
    expect(body).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(body.parentElement).toBe(content);

    // Header and footer are siblings of the scroll region, not children, so
    // the actions stay put when question rows overflow the max height.
    const headerTitle = screen.getByText("Interview reflection");
    expect(body.contains(headerTitle)).toBe(false);
    const save = screen.getByTestId("interview-reflection-save");
    expect(save).toBeEnabled();
    expect(body.contains(save)).toBe(false);
    expect(
      body.contains(screen.getByRole("button", { name: "Cancel" })),
    ).toBe(false);
  });

  it("closes via Escape and the X button through the shared dialog paths", async () => {
    getReflection.mockResolvedValue({
      success: true,
      data: existingReflection(),
    });
    const onOpenChange = vi.fn();
    render(
      <InterviewReflectionDialog
        open
        onOpenChange={onOpenChange}
        step={step}
      />,
    );
    await screen.findByDisplayValue("介绍一下你的推荐系统项目");

    const dialog = screen.getByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();

    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders zh-CN chrome under the zh-CN provider", async () => {
    getReflection.mockResolvedValue({
      success: true,
      data: existingReflection(),
    });
    render(
      <I18nProvider initialLocale="zh-CN">
        <InterviewReflectionDialog
          open
          onOpenChange={vi.fn()}
          step={step}
          companyName="Acme"
          roleTitle="软件工程师"
        />
      </I18nProvider>,
    );
    expect(await screen.findByText("面试复盘")).toBeInTheDocument();
    expect(
      screen.getByTestId("interview-reflection-save"),
    ).toHaveTextContent("保存复盘");
    expect(
      screen.getByRole("button", { name: "取消" }),
    ).toBeInTheDocument();
  });
});
