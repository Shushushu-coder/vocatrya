import React from "react";
import { DeepMatchSection } from "@/components/myjobs/job-details/DeepMatchSection";
import type {
  DeepMatchAnalysisItem,
  DeepMatchTaskDTO,
} from "@/lib/career/deepMatchContract";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  cancelDeepMatchTask,
  getDeepMatchTask,
  getDeepMatchTaskForJob,
  listDeepMatchAnalysisItems,
  retryDeepMatchTask,
  startDeepMatchTask,
} from "@/actions/deepMatchTask.actions";

vi.mock("@/actions/deepMatchTask.actions", () => ({
  cancelDeepMatchTask: vi.fn(),
  getDeepMatchTask: vi.fn(),
  getDeepMatchTaskForJob: vi.fn(),
  listDeepMatchAnalysisItems: vi.fn(),
  retryDeepMatchTask: vi.fn(),
  startDeepMatchTask: vi.fn(),
}));

const mockedGetForJob = vi.mocked(getDeepMatchTaskForJob);
const mockedGetTask = vi.mocked(getDeepMatchTask);
const mockedList = vi.mocked(listDeepMatchAnalysisItems);
const mockedStart = vi.mocked(startDeepMatchTask);
const mockedCancel = vi.mocked(cancelDeepMatchTask);
const mockedRetry = vi.mocked(retryDeepMatchTask);

const RESUME_VERSIONS = [
  {
    versionId: "ver-1",
    variantId: "var-1",
    variantName: "General",
    versionNumber: 3,
    status: "DRAFT",
  },
];

function makeTask(overrides: Partial<DeepMatchTaskDTO> = {}): DeepMatchTaskDTO {
  return {
    id: "task-1",
    status: "QUEUED",
    currentStep: null,
    recovered: false,
    attemptCount: 0,
    cancelRequested: false,
    failureCode: null,
    inputLost: false,
    resultAnalysisId: null,
    jobOpportunityId: "job-1",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    startedAt: null,
    completedAt: null,
    source: {
      jobOpportunityId: "job-1",
      jobDescriptionVersionId: "jd-1",
      jdVersionNumber: 2,
      resumeVariantVersionId: "ver-1",
      resumeVariantName: "General",
      resumeVersionNumber: 3,
    },
    ...overrides,
  };
}

function makeAnalysis(
  overrides: Partial<DeepMatchAnalysisItem> = {},
): DeepMatchAnalysisItem {
  return {
    id: "ana-1",
    createdAt: new Date("2026-01-01T10:05:00Z"),
    completedAt: new Date("2026-01-01T10:05:00Z"),
    provider: "DEVIN",
    model: "deep-model-1",
    isStale: false,
    staleReasonCodes: [],
    deepMatchDetail: {
      overallSummary: "Strong senior fit.",
      overallScore: 84,
      hardRequirements: "Meets them.",
      responsibilityAlignment: null,
      experienceRelevance: null,
      skillCoverage: null,
      educationExperienceFit: null,
      strengths: null,
      gaps: null,
      resumeOptimizationOpportunities: null,
      nonFixableGaps: null,
    },
    taskId: "task-1",
    source: {
      jdVersionNumber: 2,
      resumeVariantVersionId: "ver-1",
      resumeVariantName: "General",
      resumeVersionNumber: 3,
    },
    ...overrides,
  };
}

function ok<T>(data: T) {
  return { success: true as const, data };
}

function renderSection(props?: Partial<Parameters<typeof DeepMatchSection>[0]>) {
  return render(
    <DeepMatchSection
      jobId="job-1"
      resumeVersions={RESUME_VERSIONS}
      hasJobDescription={true}
      {...props}
    />,
  );
}

beforeAll(() => {
  // Radix Select needs pointer APIs jsdom does not implement.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  mockedGetForJob.mockResolvedValue(ok({ task: null }));
  mockedGetTask.mockResolvedValue(ok({ task: makeTask() }));
  mockedList.mockResolvedValue(ok([]));
  mockedStart.mockResolvedValue(ok({ task: makeTask(), created: true }));
  mockedCancel.mockResolvedValue(ok({ status: "CANCELLING" }));
  mockedRetry.mockResolvedValue(ok({ task: makeTask({ status: "QUEUED" }) }));
});

describe("DeepMatchSection", () => {
  it("surfaces a failed initial load and retries into the live state", async () => {
    mockedGetForJob.mockResolvedValueOnce({
      success: false,
      code: "INTERNAL",
      message: "boom",
    });
    const user = userEvent.setup();
    renderSection();
    // The failure must render as an error + retry, never as "no task".
    expect(
      await screen.findByTestId("deepmatch-load-error"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Couldn't load the deep match task."),
    ).toBeInTheDocument();

    mockedGetForJob.mockResolvedValue(
      ok({ task: makeTask({ status: "SUCCEEDED", resultAnalysisId: "ana-1" }) }),
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("deepmatch-task")).toBeInTheDocument();
    expect(screen.getByTestId("deepmatch-task-status")).toHaveTextContent(
      "Completed",
    );
  });

  it("rediscovers the latest task on mount and never auto-starts", async () => {
    mockedGetForJob.mockResolvedValue(ok({ task: makeTask({ status: "FAILED" }) }));
    renderSection();
    expect(await screen.findByTestId("deepmatch-task")).toBeInTheDocument();
    expect(mockedGetForJob).toHaveBeenCalledWith({ jobOpportunityId: "job-1" });
    expect(mockedStart).not.toHaveBeenCalled();
    expect(screen.getByTestId("deepmatch-task-status")).toHaveTextContent(
      "Failed",
    );
  });

  it("starts a task for the selected resume version with a stable request key", async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByTestId("deepmatch-start");

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /General · v3/ }));
    await user.click(screen.getByTestId("deepmatch-start"));

    expect(mockedStart).toHaveBeenCalledTimes(1);
    const arg = mockedStart.mock.calls[0][0];
    expect(arg.jobOpportunityId).toBe("job-1");
    expect(arg.resumeVariantVersionId).toBe("ver-1");
    expect(arg.requestKey).toMatch(/^deepmatch:/);
    expect(await screen.findByTestId("deepmatch-task")).toBeInTheDocument();
  });

  it("polls while active, stops on terminal state and opens the bound result", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const running = makeTask({
        status: "RUNNING",
        currentStep: "RUN_ANALYSIS",
      });
      const succeeded = makeTask({
        status: "SUCCEEDED",
        resultAnalysisId: "ana-1",
        completedAt: new Date("2026-01-01T10:05:00Z"),
      });
      mockedGetForJob.mockResolvedValue(ok({ task: running }));
      mockedGetTask.mockResolvedValue(ok({ task: succeeded }));
      mockedList.mockResolvedValue(ok([makeAnalysis()]));

      renderSection();
      expect(await screen.findByTestId("deepmatch-task-status")).toHaveTextContent(
        "Running",
      );
      expect(screen.getByTestId("deepmatch-task-step")).toHaveTextContent(
        "Analyzing",
      );

      await vi.advanceTimersByTimeAsync(2100);
      await waitFor(() =>
        expect(screen.getByTestId("deepmatch-task-status")).toHaveTextContent(
          "Completed",
        ),
      );
      const polls = mockedGetTask.mock.calls.length;
      // Terminal state stops the poll loop.
      await vi.advanceTimersByTimeAsync(6000);
      expect(mockedGetTask.mock.calls.length).toBe(polls);

      const user = userEvent.setup({
        advanceTimers: (ms) => vi.advanceTimersByTime(ms),
      });
      await user.click(await screen.findByTestId("deepmatch-view-result"));
      const result = await screen.findByTestId("deepmatch-result");
      expect(result).toHaveTextContent("Strong senior fit.");
      expect(screen.getByTestId("deepmatch-result-source")).toHaveTextContent(
        "JD v2",
      );
      expect(screen.getByTestId("deepmatch-result-source")).toHaveTextContent(
        "General v3",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests cancel and shows the honest pending state", async () => {
    const running = makeTask({ status: "RUNNING", currentStep: "RUN_ANALYSIS" });
    mockedGetForJob.mockResolvedValue(ok({ task: running }));
    mockedGetTask.mockResolvedValue(
      ok({ task: makeTask({ status: "CANCELLING", cancelRequested: true }) }),
    );
    const user = userEvent.setup();
    renderSection();
    await screen.findByTestId("deepmatch-cancel");
    await user.click(screen.getByTestId("deepmatch-cancel"));

    expect(mockedCancel).toHaveBeenCalledWith({ taskId: "task-1" });
    expect(
      await screen.findByTestId("deepmatch-task-status"),
    ).toHaveTextContent("Cancelling");
    expect(
      screen.getByText(/Cancel requested — the running step will stop shortly/),
    ).toBeInTheDocument();
  });

  it("offers retry on a retryable failure and a distinct hint when an input is lost", async () => {
    mockedGetForJob.mockResolvedValue(
      ok({
        task: makeTask({ status: "FAILED", failureCode: "AI_EXECUTION_FAILED" }),
      }),
    );
    const user = userEvent.setup();
    renderSection();
    const retry = await screen.findByTestId("deepmatch-retry");
    expect(screen.getByText(/You can retry/)).toBeInTheDocument();
    await user.click(retry);
    expect(mockedRetry).toHaveBeenCalledWith({ taskId: "task-1" });
  });

  it("hides retry when the pinned input is gone", async () => {
    mockedGetForJob.mockResolvedValue(
      ok({
        task: makeTask({
          status: "FAILED",
          failureCode: "DEEP_RESUME_VERSION_MISSING",
          inputLost: true,
        }),
      }),
    );
    renderSection();
    await screen.findByTestId("deepmatch-task-error");
    expect(screen.getByText(/An input this analysis pinned is gone/)).toBeInTheDocument();
    expect(screen.queryByTestId("deepmatch-retry")).not.toBeInTheDocument();
  });

  it("renders deep results with score, source and stale badge", async () => {
    mockedList.mockResolvedValue(
      ok([
        makeAnalysis({ isStale: true, staleReasonCodes: ["JD_CHANGED"] }),
      ]),
    );
    renderSection();
    const item = await screen.findByTestId("deepmatch-history-item");
    expect(item).toHaveTextContent("84/100");
    const detail = await screen.findByTestId("deepmatch-result");
    expect(detail).toHaveTextContent("Strong senior fit.");
    expect(screen.getByTestId("deepmatch-stale-badge")).toBeInTheDocument();
  });
});
