"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  advanceInterviewQuestionAction,
  generateInterviewFeedbackAction,
  generateInterviewSummaryAction,
  sendInterviewFollowUpAction,
  submitInterviewAnswerAction,
} from "@/actions/interview.actions";
import { toastError } from "@/lib/toast";
import { parseJson } from "@/lib/interview/persistence/json";
import type { InterviewSessionHistory } from "@/lib/interview/services/application";

type GenerationState = "idle" | "loading" | "success" | "failed";

type AttemptRow = InterviewSessionHistory["attempts"][number];

function parseEvidence(raw: string) {
  return parseJson<{
    transcriptExcerpt?: string;
    startOffset?: number;
    endOffset?: number;
    problemStatement?: string;
  }>(raw, {});
}

function parseExplanation(raw: string) {
  return parseJson<{
    underlyingCause?: string;
    performanceImpact?: string;
  }>(raw, {});
}

export default function InterviewSessionClient({
  sessionId,
  initial,
}: {
  sessionId: string;
  initial: InterviewSessionHistory;
}) {
  const { t } = useI18n();
  const [history, setHistory] = useState(initial);
  const [answerText, setAnswerText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [feedbackState, setFeedbackState] = useState<
    Record<string, GenerationState>
  >({});
  const [summaryState, setSummaryState] = useState<GenerationState>(
    initial.summary ? "success" : "idle",
  );
  const [followUp, setFollowUp] = useState("");
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const autoFeedbackFor = useRef<Record<string, boolean>>({});

  const instances = useMemo(
    () =>
      [...history.instances].sort((a, b) => a.displayOrder - b.displayOrder),
    [history.instances],
  );
  const rowByInstance = useMemo(() => {
    const map = new Map<string, AttemptRow>();
    for (const row of history.attempts) map.set(row.instance.id, row);
    return map;
  }, [history.attempts]);

  // One question at a time: the session's currentQuestionInstanceId is the
  // authority; for historical sessions without one, resume at the first
  // unanswered question.
  const currentInstance = useMemo(() => {
    const locked = instances.find(
      (row) => row.id === history.session.currentQuestionInstanceId,
    );
    if (locked) return locked;
    const unanswered = instances.find((row) => {
      const attempt = rowByInstance.get(row.id)?.attempt;
      return !attempt;
    });
    return unanswered ?? instances[instances.length - 1] ?? null;
  }, [instances, history.session.currentQuestionInstanceId, rowByInstance]);

  const currentRow = currentInstance
    ? rowByInstance.get(currentInstance.id)
    : null;
  const currentIndex = currentInstance
    ? instances.indexOf(currentInstance)
    : -1;
  const isLastQuestion =
    currentInstance != null &&
    !instances.some(
      (row) =>
        row.displayOrder > currentInstance.displayOrder &&
        row.status !== "SKIPPED",
    );
  const sessionDone =
    history.session.status === "COMPLETED" || history.summary != null;

  const feedbackStatusFor = (row: AttemptRow | null): GenerationState => {
    if (!row?.attempt) return "idle";
    return (
      feedbackState[row.attempt.id] ??
      (row.feedback?.generation.status === "SUCCEEDED" ? "success" : "idle")
    );
  };

  // Answer → feedback is the main flow: feedback starts automatically
  // after an answer exists, retries stay manual.
  useEffect(() => {
    if (sessionDone || !currentRow?.attempt) return;
    if (currentRow.feedback?.generation.status === "SUCCEEDED") return;
    const attemptId = currentRow.attempt.id;
    if (autoFeedbackFor.current[attemptId]) return;
    autoFeedbackFor.current[attemptId] = true;
    void generateFeedback(attemptId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRow?.attempt?.id, sessionDone]);

  const highlightedTranscript = (
    text: string,
    itemEvidence: string | null,
  ) => {
    if (!itemEvidence) return text;
    const evidence = parseEvidence(itemEvidence);
    if (
      typeof evidence.startOffset !== "number" ||
      typeof evidence.endOffset !== "number" ||
      evidence.startOffset < 0 ||
      evidence.endOffset > text.length
    ) {
      return text;
    }
    return (
      <>
        {text.slice(0, evidence.startOffset)}
        <mark data-testid="transcript-highlight">
          {text.slice(evidence.startOffset, evidence.endOffset)}
        </mark>
        {text.slice(evidence.endOffset)}
      </>
    );
  };

  const submitAnswer = async (instanceId: string) => {
    if (!answerText.trim()) return;
    setSubmitting(true);
    try {
      const result = await submitInterviewAnswerAction({
        questionInstanceId: instanceId,
        textContent: answerText,
      });
      if (!result.success || !("data" in result)) {
        toastError(result.message);
        return;
      }
      setHistory((current) => ({
        ...current,
        attempts: current.attempts.map((row) =>
          row.instance.id === instanceId
            ? {
                ...row,
                attempt: result.data.attempt,
                transcriptText: result.data.transcript.fullText,
              }
            : row,
        ),
      }));
      setAnswerText("");
      await generateFeedback(result.data.attempt.id);
    } finally {
      setSubmitting(false);
    }
  };

  const generateFeedback = async (attemptId: string) => {
    setFeedbackState((current) => ({ ...current, [attemptId]: "loading" }));
    const result = await generateInterviewFeedbackAction(attemptId);
    if (
      !result.success ||
      !("data" in result) ||
      result.data.generation.status !== "SUCCEEDED"
    ) {
      setFeedbackState((current) => ({ ...current, [attemptId]: "failed" }));
      if (!result.success) toastError(result.message);
      return;
    }
    setFeedbackState((current) => ({ ...current, [attemptId]: "success" }));
    setHistory((current) => ({
      ...current,
      attempts: current.attempts.map((row) =>
        row.attempt?.id === attemptId ? { ...row, feedback: result.data } : row,
      ),
    }));
  };

  const advance = async () => {
    setAdvancing(true);
    try {
      const result = await advanceInterviewQuestionAction(sessionId);
      if (!result.success || !("data" in result)) {
        toastError(result.message);
        return;
      }
      if (!result.data.advanced) return;
      setHistory((current) => ({
        ...current,
        session: result.data.session,
      }));
      setActiveItemId(null);
      setSelectedItemId(null);
    } finally {
      setAdvancing(false);
    }
  };

  const finishAndSummarize = async () => {
    setSummaryState("loading");
    const result = await generateInterviewSummaryAction(sessionId);
    if (
      !result.success ||
      !("data" in result) ||
      result.data.generation.status !== "SUCCEEDED"
    ) {
      setSummaryState("failed");
      if (!result.success) toastError(result.message);
      return;
    }
    setSummaryState("success");
    setHistory((current) => ({
      ...current,
      session: { ...current.session, status: "COMPLETED" },
      summary: result.data,
    }));
  };

  const sendFollowUp = async () => {
    if (!followUp.trim()) return;
    setSendingFollowUp(true);
    try {
      const result = await sendInterviewFollowUpAction({
        sessionId,
        userText: followUp,
        targetType: selectedItemId ? "FEEDBACK_ITEM" : "SESSION",
        commercialFeedbackItemId: selectedItemId,
      });
      if (!result.success || !("data" in result)) {
        toastError(result.message);
        return;
      }
      setFollowUp("");
      setHistory((current) => ({
        ...current,
        turns: [...current.turns, result.data],
      }));
    } finally {
      setSendingFollowUp(false);
    }
  };

  const summaryPayload = parseJson<{
    keyPatterns?: string[];
    strengths?: string[];
    developmentAreas?: string[];
  }>(history.summary?.generation.structuredPayload ?? null, {});

  const renderFeedbackItems = (row: AttemptRow) => {
    const feedback = row.feedback;
    if (!feedback?.items?.length) return null;
    const transcriptText = row.transcriptText;
    return (
      <div className="space-y-3" data-testid="feedback-panel">
        <p className="text-sm font-medium">{t("interview.feedbackTitle")}</p>
        {feedback.items.map((item) => {
          const evidence = parseEvidence(item.evidence);
          const explanation = parseExplanation(item.explanation);
          const active = item.id === activeItemId;
          return (
            <div
              key={item.id}
              className={`rounded-md border p-3 text-sm ${
                active ? "border-primary" : ""
              }`}
              data-testid="feedback-item"
            >
              <button
                type="button"
                className="w-full text-left"
                onClick={() =>
                  setActiveItemId(active ? null : item.id)
                }
              >
                <p className="font-medium">
                  {t("interview.problem")}: {item.problemLabel}
                </p>
                {evidence.problemStatement ? (
                  <p className="mt-1">{evidence.problemStatement}</p>
                ) : null}
                <p className="mt-1">
                  {t("interview.evidence")}: {evidence.transcriptExcerpt}
                </p>
                {explanation.underlyingCause ? (
                  <p className="mt-1">
                    {t("interview.explanation")}: {explanation.underlyingCause}
                  </p>
                ) : null}
                <p className="mt-1">
                  {t("interview.suggestion")}: {item.suggestion}
                </p>
              </button>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  setSelectedItemId(item.id);
                  setActiveItemId(item.id);
                }}
              >
                {t("interview.askAboutItem")}
              </Button>
            </div>
          );
        })}
        <div className="rounded-md border p-3 text-sm whitespace-pre-wrap">
          {highlightedTranscript(
            transcriptText,
            feedback.items.find((item) => item.id === activeItemId)?.evidence ??
              null,
          )}
        </div>
      </div>
    );
  };

  const renderFollowUp = () => (
    <Card>
      <CardHeader>
        <CardTitle>{t("interview.followUp")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {selectedItemId ? (
          <p className="text-xs text-muted-foreground">
            {t("interview.targetEvidence")}
          </p>
        ) : null}
        <Textarea
          value={followUp}
          onChange={(event) => setFollowUp(event.target.value)}
          placeholder={t("interview.followUpPlaceholder")}
        />
        <Button
          onClick={() => void sendFollowUp()}
          disabled={sendingFollowUp || !followUp.trim()}
        >
          {t("interview.sendFollowUp")}
        </Button>
        {history.turns.length ? (
          <ul className="space-y-2 text-sm">
            {history.turns.map((turn) => (
              <li key={turn.id} className="rounded-md border p-2">
                <p>
                  <strong>{t("interview.you")}:</strong> {turn.userText}
                </p>
                <p>
                  <strong>{t("interview.coach")}:</strong> {turn.assistantReply}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );

  const renderSummary = () => (
    <Card>
      <CardHeader>
        <CardTitle>{t("interview.summary")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {history.summary?.generation.bodyText ? (
          <div className="space-y-2 text-sm">
            <p className="whitespace-pre-wrap">
              {history.summary.generation.bodyText}
            </p>
            <p>
              {t("interview.keyPatterns")}:{" "}
              {(summaryPayload.keyPatterns ?? []).join("、")}
            </p>
            <p>
              {t("interview.strengths")}:{" "}
              {(summaryPayload.strengths ?? []).join("、")}
            </p>
            <p>
              {t("interview.developmentAreas")}:{" "}
              {(summaryPayload.developmentAreas ?? []).join("、")}
            </p>
          </div>
        ) : summaryState === "loading" ? (
          <p className="text-sm">{t("interview.generating")}</p>
        ) : summaryState === "failed" ? (
          <Button variant="outline" onClick={() => void finishAndSummarize()}>
            {t("interview.retry")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );

  // Completed sessions render a read-only review: every question with its
  // transcript + feedback, then the summary and dialogue history.
  if (sessionDone) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">{t("interview.title")}</h1>
        {renderSummary()}
        {history.attempts.map((row, index) => (
          <Card key={row.instance.id}>
            <CardHeader>
              <CardTitle className="text-base">
                {t("interview.questionProgress", {
                  current: index + 1,
                  total: instances.length,
                })}
                · {row.instance.displayedText}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {row.transcriptText ? (
                <p
                  className="whitespace-pre-wrap text-sm"
                  data-testid="interview-transcript"
                >
                  {highlightedTranscript(
                    row.transcriptText,
                    row.feedback?.items.find(
                      (item) => item.id === activeItemId,
                    )?.evidence ?? null,
                  )}
                </p>
              ) : null}
              {renderFeedbackItems(row)}
            </CardContent>
          </Card>
        ))}
        {renderFollowUp()}
      </div>
    );
  }

  if (!currentInstance || !currentRow) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">{t("interview.title")}</h1>
        {renderSummary()}
      </div>
    );
  }

  const status = feedbackStatusFor(currentRow);
  const attempt = currentRow.attempt;
  const transcriptText = currentRow.transcriptText;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          {t("interview.questionProgress", {
            current: currentIndex + 1,
            total: instances.length,
          })}
        </p>
        <h1 className="text-xl font-semibold">{t("interview.title")}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base" data-testid="current-question">
            {currentInstance.displayedText}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!attempt ? (
            <>
              <Textarea
                value={answerText}
                onChange={(event) => setAnswerText(event.target.value)}
                placeholder={t("interview.answerPlaceholder")}
                rows={6}
              />
              <Button
                onClick={() => void submitAnswer(currentInstance.id)}
                disabled={submitting || !answerText.trim()}
              >
                {submitting
                  ? t("interview.generating")
                  : t("interview.submitAnswer")}
              </Button>
            </>
          ) : (
            <p
              className="whitespace-pre-wrap text-sm"
              data-testid="interview-transcript"
            >
              {transcriptText}
            </p>
          )}

          {attempt && status === "loading" && (
            <p className="text-sm text-muted-foreground">
              {t("interview.generating")}
            </p>
          )}
          {attempt && status === "failed" && (
            <div className="space-y-2">
              <p className="text-sm text-destructive">
                {t("interview.failed")}
              </p>
              <Button
                variant="outline"
                onClick={() => void generateFeedback(attempt.id)}
              >
                {t("interview.retry")}
              </Button>
            </div>
          )}
          {attempt && status === "success" && renderFeedbackItems(currentRow)}
        </CardContent>
      </Card>

      {attempt && status === "success" && (
        <div className="flex justify-end">
          {isLastQuestion ? (
            <Button
              onClick={() => void finishAndSummarize()}
              disabled={summaryState === "loading"}
            >
              {summaryState === "loading"
                ? t("interview.generating")
                : t("interview.finishInterview")}
            </Button>
          ) : (
            <Button onClick={() => void advance()} disabled={advancing}>
              {t("interview.nextQuestion")}
            </Button>
          )}
        </div>
      )}

      {attempt && status === "success" && renderFollowUp()}
    </div>
  );
}
