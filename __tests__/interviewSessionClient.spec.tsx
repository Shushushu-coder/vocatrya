import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import InterviewSessionClient from "@/components/interview/InterviewSessionClient";
import type { InterviewSessionHistory } from "@/lib/interview/services/application";

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join("/")}` : key,
  }),
}));

vi.mock("@/lib/toast", () => ({ toastError: vi.fn() }));

const submitInterviewAnswerAction = vi.fn();
const generateInterviewFeedbackAction = vi.fn();
const advanceInterviewQuestionAction = vi.fn();
const sendInterviewFollowUpAction = vi.fn();
const generateInterviewSummaryAction = vi.fn();
vi.mock("@/actions/interview.actions", () => ({
  submitInterviewAnswerAction: (...args: unknown[]) =>
    submitInterviewAnswerAction(...args),
  generateInterviewFeedbackAction: (...args: unknown[]) =>
    generateInterviewFeedbackAction(...args),
  advanceInterviewQuestionAction: (...args: unknown[]) =>
    advanceInterviewQuestionAction(...args),
  sendInterviewFollowUpAction: (...args: unknown[]) =>
    sendInterviewFollowUpAction(...args),
  generateInterviewSummaryAction: (...args: unknown[]) =>
    generateInterviewSummaryAction(...args),
}));

function instance(id: string, order: number, text: string, status = "PENDING") {
  return {
    id,
    sessionId: "s-1",
    displayOrder: order,
    displayedText: text,
    sourceKind: "AI_GENERATED",
    sourceQuestionId: null,
    category: "behavioral",
    status,
  } as never;
}

function freshHistory(): InterviewSessionHistory {
  const instances = [
    instance("q1", 0, "Question one?"),
    instance("q2", 1, "Question two?"),
    instance("q3", 2, "Question three?"),
  ];
  return {
    session: {
      id: "s-1",
      userId: "u-1",
      status: "DRAFT",
      coachingMode: "PRACTICE",
      currentQuestionInstanceId: "q1",
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    } as never,
    instances,
    attempts: instances.map((row) => ({
      instance: row,
      attempt: null,
      transcriptText: "",
      feedback: null,
    })),
    turns: [],
    summary: null,
  } as InterviewSessionHistory;
}

const ANSWER = "I led the launch under a two-week freeze.";

function feedbackSuccess(attemptId = "a-1") {
  return {
    success: true,
    data: {
      generation: { id: "g-1", status: "SUCCEEDED", isCurrent: true },
      items: [
        {
          id: "fi-1",
          problemLabel: "Missing Situation Context",
          suggestion: "Add the team and constraint first.",
          evidence: JSON.stringify({
            transcriptExcerpt: "I led the launch",
            startOffset: 0,
            endOffset: "I led the launch".length,
            problemStatement: "Situation missing",
          }),
          explanation: JSON.stringify({
            underlyingCause: "Jumped to action",
            performanceImpact: "Hard to judge scope",
          }),
        },
      ],
    },
  };
}

describe("InterviewSessionClient one-question flow", () => {
  beforeEach(() => {
    submitInterviewAnswerAction.mockReset();
    generateInterviewFeedbackAction.mockReset();
    advanceInterviewQuestionAction.mockReset();
    sendInterviewFollowUpAction.mockReset();
    generateInterviewSummaryAction.mockReset();
  });

  it("shows only the current question", () => {
    render(
      <InterviewSessionClient sessionId="s-1" initial={freshHistory()} />,
    );
    expect(screen.getByTestId("current-question").textContent).toBe(
      "Question one?",
    );
    expect(screen.queryByText("Question two?")).toBeNull();
    expect(screen.queryByText("Question three?")).toBeNull();
    expect(screen.getByText("interview.questionProgress:1/3")).toBeTruthy();
  });

  it("submits the answer, auto-generates feedback, and renders items", async () => {
    submitInterviewAnswerAction.mockResolvedValue({
      success: true,
      data: {
        attempt: { id: "a-1", status: "COMPLETED" },
        transcript: { id: "t-1", fullText: ANSWER },
      },
    });
    generateInterviewFeedbackAction.mockResolvedValue(feedbackSuccess());
    render(
      <InterviewSessionClient sessionId="s-1" initial={freshHistory()} />,
    );
    fireEvent.change(
      screen.getByPlaceholderText("interview.answerPlaceholder"),
      { target: { value: ANSWER } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "interview.submitAnswer" }),
    );
    await waitFor(() =>
      expect(generateInterviewFeedbackAction).toHaveBeenCalledWith("a-1"),
    );
    await screen.findByText(/Missing Situation Context/);
    expect(screen.getByText(/Add the team and constraint/)).toBeTruthy();
    // Selecting the item highlights its evidence in the transcript.
    fireEvent.click(
      screen.getByRole("button", { name: "interview.askAboutItem" }),
    );
    expect(screen.getByTestId("transcript-highlight").textContent).toBe(
      "I led the launch",
    );
    expect(
      screen.getByRole("button", { name: "interview.nextQuestion" }),
    ).toBeInTheDocument();
  });

  it("triggers feedback generation exactly once per submitted answer", async () => {
    submitInterviewAnswerAction.mockResolvedValue({
      success: true,
      data: {
        attempt: { id: "a-1", status: "COMPLETED" },
        transcript: { id: "t-1", fullText: ANSWER },
      },
    });
    // Defer the action resolution by a macrotask so the intermediate
    // "attempt exists, feedback still pending" render actually commits —
    // that is the window where the auto-effect used to fire a second
    // generation call.
    generateInterviewFeedbackAction.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(feedbackSuccess()), 0),
        ),
    );
    render(
      <InterviewSessionClient sessionId="s-1" initial={freshHistory()} />,
    );
    fireEvent.change(
      screen.getByPlaceholderText("interview.answerPlaceholder"),
      { target: { value: ANSWER } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "interview.submitAnswer" }),
    );
    await screen.findByText(/Missing Situation Context/);
    // One answer submission must equal one generation request — the submit
    // path and the auto-effect must not both reach the server action.
    expect(generateInterviewFeedbackAction).toHaveBeenCalledTimes(1);
  });

  it("does not regenerate when a resumed attempt already has feedback", async () => {
    const history = freshHistory();
    history.attempts[0].attempt = {
      id: "a-1",
      status: "COMPLETED",
    } as never;
    history.attempts[0].transcriptText = ANSWER;
    history.attempts[0].feedback = feedbackSuccess("a-1").data as never;
    render(<InterviewSessionClient sessionId="s-1" initial={history} />);
    await screen.findByText(/Missing Situation Context/);
    expect(generateInterviewFeedbackAction).not.toHaveBeenCalled();
  });

  it("auto-generates once for a resumed attempt without feedback", async () => {
    const history = freshHistory();
    history.attempts[0].attempt = {
      id: "a-1",
      status: "COMPLETED",
    } as never;
    history.attempts[0].transcriptText = ANSWER;
    generateInterviewFeedbackAction.mockResolvedValue(feedbackSuccess());
    render(<InterviewSessionClient sessionId="s-1" initial={history} />);
    await screen.findByText(/Missing Situation Context/);
    expect(generateInterviewFeedbackAction).toHaveBeenCalledTimes(1);
    expect(generateInterviewFeedbackAction).toHaveBeenCalledWith("a-1");
  });

  it("keeps a failed feedback retryable and blocks advancing", async () => {
    submitInterviewAnswerAction.mockResolvedValue({
      success: true,
      data: {
        attempt: { id: "a-1", status: "COMPLETED" },
        transcript: { id: "t-1", fullText: ANSWER },
      },
    });
    generateInterviewFeedbackAction.mockResolvedValueOnce({
      success: true,
      data: {
        generation: { id: "g-1", status: "FAILED", isCurrent: false },
        items: [],
      },
    });
    generateInterviewFeedbackAction.mockResolvedValue(feedbackSuccess());
    render(
      <InterviewSessionClient sessionId="s-1" initial={freshHistory()} />,
    );
    fireEvent.change(
      screen.getByPlaceholderText("interview.answerPlaceholder"),
      { target: { value: ANSWER } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "interview.submitAnswer" }),
    );
    await screen.findByRole("button", { name: "interview.retry" });
    expect(
      screen.queryByRole("button", { name: "interview.nextQuestion" }),
    ).toBeNull();
    // Manual retry after failure stays available: it issues a new
    // generation call even though the auto attempt already ran.
    fireEvent.click(screen.getByRole("button", { name: "interview.retry" }));
    await screen.findByText(/Missing Situation Context/);
    expect(generateInterviewFeedbackAction).toHaveBeenCalledTimes(2);
  });

  it("advances to the next question through the server action", async () => {
    submitInterviewAnswerAction.mockResolvedValue({
      success: true,
      data: {
        attempt: { id: "a-1", status: "COMPLETED" },
        transcript: { id: "t-1", fullText: ANSWER },
      },
    });
    generateInterviewFeedbackAction.mockResolvedValue(feedbackSuccess());
    advanceInterviewQuestionAction.mockResolvedValue({
      success: true,
      data: {
        advanced: true,
        nextInstanceId: "q2",
        session: {
          ...freshHistory().session,
          status: "IN_PROGRESS",
          currentQuestionInstanceId: "q2",
        },
      },
    });
    render(
      <InterviewSessionClient sessionId="s-1" initial={freshHistory()} />,
    );
    fireEvent.change(
      screen.getByPlaceholderText("interview.answerPlaceholder"),
      { target: { value: ANSWER } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "interview.submitAnswer" }),
    );
    await screen.findByRole("button", { name: "interview.nextQuestion" });
    fireEvent.click(
      screen.getByRole("button", { name: "interview.nextQuestion" }),
    );
    await waitFor(() =>
      expect(advanceInterviewQuestionAction).toHaveBeenCalledWith("s-1"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("current-question").textContent).toBe(
        "Question two?",
      ),
    );
  });

  it("targets follow-ups at the selected feedback item", async () => {
    submitInterviewAnswerAction.mockResolvedValue({
      success: true,
      data: {
        attempt: { id: "a-1", status: "COMPLETED" },
        transcript: { id: "t-1", fullText: ANSWER },
      },
    });
    generateInterviewFeedbackAction.mockResolvedValue(feedbackSuccess());
    sendInterviewFollowUpAction.mockResolvedValue({
      success: true,
      data: { id: "turn-1", userText: "Why?", assistantReply: "Because." },
    });
    render(
      <InterviewSessionClient sessionId="s-1" initial={freshHistory()} />,
    );
    fireEvent.change(
      screen.getByPlaceholderText("interview.answerPlaceholder"),
      { target: { value: ANSWER } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "interview.submitAnswer" }),
    );
    await screen.findByText(/Missing Situation Context/);
    fireEvent.click(
      screen.getByRole("button", { name: "interview.askAboutItem" }),
    );
    fireEvent.change(
      screen.getByPlaceholderText("interview.followUpPlaceholder"),
      { target: { value: "Why is this a problem?" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "interview.sendFollowUp" }),
    );
    await waitFor(() =>
      expect(sendInterviewFollowUpAction).toHaveBeenCalledWith({
        sessionId: "s-1",
        userText: "Why is this a problem?",
        targetType: "FEEDBACK_ITEM",
        commercialFeedbackItemId: "fi-1",
      }),
    );
    await screen.findByText("Because.");
  });

  it("finishes the last question with summary and shows it", async () => {
    const history = freshHistory();
    history.session.currentQuestionInstanceId = "q3";
    history.session.status = "IN_PROGRESS";
    // Previous questions answered.
    history.instances[0] = instance("q1", 0, "Question one?", "ANSWERED");
    history.instances[1] = instance("q2", 1, "Question two?", "ANSWERED");
    history.attempts = history.instances.map((row) => ({
      instance: row,
      attempt: null,
      transcriptText: "",
      feedback: null,
    }));

    submitInterviewAnswerAction.mockResolvedValue({
      success: true,
      data: {
        attempt: { id: "a-3", status: "COMPLETED" },
        transcript: { id: "t-3", fullText: ANSWER },
      },
    });
    generateInterviewFeedbackAction.mockResolvedValue(feedbackSuccess());
    generateInterviewSummaryAction.mockResolvedValue({
      success: true,
      data: {
        generation: {
          id: "sg-1",
          status: "SUCCEEDED",
          bodyText: "Solid session summary.",
          structuredPayload: JSON.stringify({
            keyPatterns: ["skip setup"],
            strengths: ["clear action"],
            developmentAreas: ["add context"],
          }),
        },
        inputs: [],
      },
    });
    render(<InterviewSessionClient sessionId="s-1" initial={history} />);
    expect(screen.getByTestId("current-question").textContent).toBe(
      "Question three?",
    );
    fireEvent.change(
      screen.getByPlaceholderText("interview.answerPlaceholder"),
      { target: { value: ANSWER } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "interview.submitAnswer" }),
    );
    const finish = await screen.findByRole("button", {
      name: "interview.finishInterview",
    });
    fireEvent.click(finish);
    await waitFor(() =>
      expect(generateInterviewSummaryAction).toHaveBeenCalledWith("s-1"),
    );
    await screen.findByText("Solid session summary.");
  });
});
