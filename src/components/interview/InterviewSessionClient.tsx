"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  generateInterviewFeedbackAction,
  generateInterviewSummaryAction,
  sendInterviewFollowUpAction,
  submitInterviewAnswerAction,
} from "@/actions/interview.actions";
import { toastError } from "@/lib/toast";
import { parseJson } from "@/lib/interview/persistence/json";
import type { InterviewSessionHistory } from "@/lib/interview/services/application";

type GenerationState = "idle" | "loading" | "success" | "failed";

export default function InterviewSessionClient({
  sessionId,
  initial,
  configured,
}: {
  sessionId: string;
  initial: InterviewSessionHistory;
  configured: boolean;
}) {
  const { t } = useI18n();
  const [history, setHistory] = useState(initial);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [feedbackState, setFeedbackState] = useState<Record<string, GenerationState>>({});
  const [summaryState, setSummaryState] = useState<GenerationState>(
    initial.summary ? "success" : "idle",
  );
  const [followUp, setFollowUp] = useState("");
  const [followTarget, setFollowTarget] = useState<"SESSION" | "FEEDBACK_ITEM">("SESSION");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);

  const currentAttempt = useMemo(() => {
    return history.attempts.find((row) => row.attempt)?.attempt ?? null;
  }, [history.attempts]);

  if (!configured) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p>{t("interview.notConfigured")}</p>
          <Button asChild>
            <Link href="/dashboard/settings">{t("interview.goSettings")}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const parseEvidence = (raw: string) =>
    parseJson<{
      transcriptExcerpt?: string;
      startOffset?: number;
      endOffset?: number;
      problemStatement?: string;
    }>(raw, {});

  const parseExplanation = (raw: string) =>
    parseJson<{
      underlyingCause?: string;
      performanceImpact?: string;
    }>(raw, {});

  const highlightedTranscript = (text: string, itemEvidence: string | null) => {
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
    const text = answers[instanceId] ?? "";
    const result = await submitInterviewAnswerAction({
      questionInstanceId: instanceId,
      textContent: text,
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
  };

  const generateFeedback = async (attemptId: string) => {
    setFeedbackState((current) => ({ ...current, [attemptId]: "loading" }));
    const result = await generateInterviewFeedbackAction(attemptId);
    if (!result.success || !("data" in result) || result.data.generation.status !== "SUCCEEDED") {
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

  const generateSummary = async () => {
    setSummaryState("loading");
    const result = await generateInterviewSummaryAction(sessionId);
    if (!result.success || !("data" in result) || result.data.generation.status !== "SUCCEEDED") {
      setSummaryState("failed");
      if (!result.success) toastError(result.message);
      return;
    }
    setSummaryState("success");
    setHistory((current) => ({ ...current, summary: result.data }));
  };

  const sendFollowUp = async () => {
    const result = await sendInterviewFollowUpAction({
      sessionId,
      userText: followUp,
      targetType: followTarget,
      commercialFeedbackItemId:
        followTarget === "FEEDBACK_ITEM" ? selectedItemId : null,
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
  };

  const summaryPayload = parseJson<{
    keyPatterns?: string[];
    strengths?: string[];
    developmentAreas?: string[];
  }>(history.summary?.generation.structuredPayload ?? null, {});

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("interview.title")}</h1>
      {history.attempts.map(({ instance, attempt, transcriptText, feedback }) => {
        const state = attempt
          ? feedbackState[attempt.id] ?? (feedback?.generation.status === "SUCCEEDED" ? "success" : "idle")
          : "idle";
        const activeEvidence =
          feedback?.items.find((item) => item.id === activeItemId)?.evidence ?? null;
        return (
          <Card key={instance.id}>
            <CardHeader>
              <CardTitle className="text-base">{instance.displayedText}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!attempt ? (
                <>
                  <Textarea
                    value={answers[instance.id] ?? ""}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [instance.id]: event.target.value,
                      }))
                    }
                    placeholder={t("interview.answerPlaceholder")}
                  />
                  <Button onClick={() => void submitAnswer(instance.id)}>
                    {t("interview.submitAnswer")}
                  </Button>
                </>
              ) : (
                <p className="whitespace-pre-wrap text-sm" data-testid="interview-transcript">
                  {highlightedTranscript(
                    transcriptText || answers[instance.id] || "",
                    activeEvidence,
                  )}
                </p>
              )}
              {attempt && state === "idle" && (
                <Button onClick={() => void generateFeedback(attempt.id)}>
                  {t("interview.generateFeedback")}
                </Button>
              )}
              {attempt && state === "loading" && <p>{t("interview.generating")}</p>}
              {attempt && state === "failed" && (
                <div className="space-y-2">
                  <p className="text-sm text-destructive">{t("interview.failed")}</p>
                  <Button
                    variant="outline"
                    onClick={() => void generateFeedback(attempt.id)}
                  >
                    {t("interview.retry")}
                  </Button>
                </div>
              )}
              {feedback?.items?.length ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    {feedback.items.map((item) => {
                      const evidence = parseEvidence(item.evidence);
                      const explanation = parseExplanation(item.explanation);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className="w-full rounded-md border p-3 text-left text-sm"
                          onClick={() => {
                            setActiveItemId(item.id);
                            setSelectedItemId(item.id);
                          }}
                        >
                          <p className="font-medium">
                            {t("interview.problem")}: {item.problemLabel}
                          </p>
                          <p>
                            {t("interview.evidence")}: {evidence.transcriptExcerpt}
                          </p>
                          <p>
                            {t("interview.explanation")}: {explanation.underlyingCause}
                          </p>
                          <p>
                            {t("interview.suggestion")}: {item.suggestion}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                  <div className="rounded-md border p-3 text-sm whitespace-pre-wrap">
                    {highlightedTranscript(
                      transcriptText || answers[instance.id] || "",
                      activeEvidence,
                    )}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader>
          <CardTitle>{t("interview.followUp")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <select
            className="rounded-md border bg-background px-3 py-2 text-sm"
            value={followTarget}
            onChange={(event) =>
              setFollowTarget(event.target.value as "SESSION" | "FEEDBACK_ITEM")
            }
          >
            <option value="SESSION">{t("interview.targetSession")}</option>
            <option value="FEEDBACK_ITEM">{t("interview.targetEvidence")}</option>
          </select>
          <Textarea
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            placeholder={t("interview.followUpPlaceholder")}
          />
          <Button onClick={() => void sendFollowUp()}>{t("interview.sendFollowUp")}</Button>
          <ul className="space-y-2 text-sm">
            {history.turns.map((turn) => (
              <li key={turn.id} className="rounded-md border p-2">
                <p>
                  <strong>You:</strong> {turn.userText}
                </p>
                <p>
                  <strong>Coach:</strong> {turn.assistantReply}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("interview.summary")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {summaryState === "idle" && (
            <Button onClick={() => void generateSummary()} disabled={!currentAttempt}>
              {t("interview.generateSummary")}
            </Button>
          )}
          {summaryState === "loading" && <p>{t("interview.generating")}</p>}
          {summaryState === "failed" && (
            <Button variant="outline" onClick={() => void generateSummary()}>
              {t("interview.retry")}
            </Button>
          )}
          {history.summary?.generation.bodyText ? (
            <div className="space-y-2 text-sm">
              <p className="whitespace-pre-wrap">{history.summary.generation.bodyText}</p>
              <p>
                {t("interview.keyPatterns")}: {(summaryPayload.keyPatterns ?? []).join("、")}
              </p>
              <p>
                {t("interview.strengths")}: {(summaryPayload.strengths ?? []).join("、")}
              </p>
              <p>
                {t("interview.developmentAreas")}:{" "}
                {(summaryPayload.developmentAreas ?? []).join("、")}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
