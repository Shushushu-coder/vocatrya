"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Loader, Plus, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  getInterviewReflection,
  saveInterviewReflection,
} from "@/actions/application.actions";
import { generateInterviewReflectionDraft } from "@/actions/interviewReflectionAi.actions";
import { resolveBusinessAiConfig } from "@/actions/aiAssignment.actions";
import type { ApplicationProcessStepDTO } from "@/lib/career/applicationTimeline";
import { toastError, toastSuccess } from "@/lib/toast";
import { useI18n } from "@/i18n";

type DraftItem = {
  key: string;
  id?: string;
  questionText: string;
  answerNotes: string;
};

type InterviewReflectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  step: ApplicationProcessStepDTO | null;
  companyName?: string | null;
  roleTitle?: string | null;
};

function newDraftKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isBlankDraft(item: DraftItem): boolean {
  return item.questionText.trim() === "" && item.answerNotes.trim() === "";
}

type AiAvailability = "loading" | "ready" | "not_configured" | "invalid";

type AiDraft = {
  reflectionText: string;
  items: DraftItem[];
};

export function InterviewReflectionDialog({
  open,
  onOpenChange,
  step,
  companyName,
  roleTitle,
}: InterviewReflectionDialogProps) {
  const { t } = useI18n();
  const [isPending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [reflectionText, setReflectionText] = useState("");
  const [ready, setReady] = useState(false);
  const [aiAvailability, setAiAvailability] = useState<AiAvailability>("loading");
  const [aiInvalidCode, setAiInvalidCode] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiDraft | null>(null);

  const subtitle = useMemo(() => {
    if (!step) return null;
    if (companyName && roleTitle) {
      return t("jobs.interviewReflectionContext", {
        label: step.label,
        company: companyName,
        title: roleTitle,
      });
    }
    return step.label;
  }, [companyName, roleTitle, step, t]);

  useEffect(() => {
    if (!open || !step) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setFormError(null);
    setReady(false);
    setItems([]);
    setReflectionText("");
    setGenerating(false);
    setDraftError(null);
    setDraft(null);
    setAiInvalidCode(null);
    setAiAvailability("loading");

    void resolveBusinessAiConfig({ purpose: "CAREER_REFLECTION" })
      .then((result) => {
        if (cancelled) return;
        const data = result.success ? result.data : undefined;
        if (data?.status === "RESOLVED" || data?.status === "LEGACY_INTERVIEW_CONFIG") {
          setAiAvailability("ready");
          return;
        }
        if (data?.status === "INVALID_ASSIGNMENT") {
          setAiAvailability("invalid");
          setAiInvalidCode(data.code ?? null);
          return;
        }
        if (data?.status === "NOT_CONFIGURED") {
          setAiAvailability("not_configured");
          return;
        }
        // The availability check failed — generation re-resolves
        // server-side anyway, so keep the button usable rather than
        // guessing a state we could not verify.
        setAiAvailability("ready");
      })
      .catch(() => {
        if (!cancelled) setAiAvailability("ready");
      });

    void getInterviewReflection(step.id)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setLoadError(result.message);
          setLoading(false);
          return;
        }
        const data = result.data;
        setItems(
          (data?.items ?? []).map((item) => ({
            key: item.id,
            id: item.id,
            questionText: item.questionText,
            answerNotes: item.answerNotes ?? "",
          })),
        );
        setReflectionText(data?.reflectionText ?? "");
        setReady(true);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(t("jobs.interviewReflectionLoadFailed"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, step, t]);

  const addQuestion = () => {
    setItems((current) => [
      ...current,
      { key: newDraftKey(), questionText: "", answerNotes: "" },
    ]);
  };

  const removeQuestion = (key: string) => {
    setItems((current) => current.filter((item) => item.key !== key));
  };

  const updateItem = (
    key: string,
    field: "questionText" | "answerNotes",
    value: string,
  ) => {
    setItems((current) =>
      current.map((item) =>
        item.key === key ? { ...item, [field]: value } : item,
      ),
    );
  };

  const onGenerateDraft = () => {
    if (!step || generating) return;
    setGenerating(true);
    setDraftError(null);
    void generateInterviewReflectionDraft({
      applicationProcessStepId: step.id,
      current: {
        reflectionText,
        items: items.map((item) => ({
          questionText: item.questionText,
          answerNotes: item.answerNotes,
        })),
      },
    })
      .then((result) => {
        if (!result.success || !result.data) {
          setDraftError(
            (!result.success && result.message) ||
              t("jobs.interviewReflectionAiFailed"),
          );
          return;
        }
        const outcome = result.data;
        if (outcome.status === "DRAFT") {
          setAiAvailability("ready");
          setDraft({
            reflectionText: outcome.draft.reflectionText ?? "",
            items: outcome.draft.items.map((item) => ({
              key: newDraftKey(),
              questionText: item.questionText,
              answerNotes: item.answerNotes ?? "",
            })),
          });
          return;
        }
        setDraft(null);
        if (outcome.status === "INVALID_ASSIGNMENT") {
          setAiAvailability("invalid");
          setAiInvalidCode(outcome.code ?? null);
        } else {
          setAiAvailability("not_configured");
        }
      })
      .catch(() => {
        setDraftError(t("jobs.interviewReflectionAiFailed"));
      })
      .finally(() => {
        setGenerating(false);
      });
  };

  const updateDraftItem = (
    key: string,
    field: "questionText" | "answerNotes",
    value: string,
  ) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) =>
              item.key === key ? { ...item, [field]: value } : item,
            ),
          }
        : current,
    );
  };

  const removeDraftItem = (key: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            items: current.items.filter((item) => item.key !== key),
          }
        : current,
    );
  };

  // Apply is the only path from draft to form — and the form only persists
  // via Save below. An empty draft text never clears typed content.
  const applyDraft = () => {
    if (!draft) return;
    if (draft.reflectionText.trim() !== "") {
      setReflectionText(draft.reflectionText);
    }
    const accepted = draft.items.filter(
      (item) => item.questionText.trim() !== "",
    );
    if (accepted.length > 0) {
      setItems((current) => [...current, ...accepted]);
    }
    setDraft(null);
  };

  const onSave = () => {
    if (!step) return;
    const submitted = items.filter((item) => !isBlankDraft(item));
    if (submitted.some((item) => !item.questionText.trim())) {
      setFormError(t("jobs.interviewReflectionQuestionRequired"));
      return;
    }
    setFormError(null);
    startTransition(async () => {
      const result = await saveInterviewReflection({
        applicationProcessStepId: step.id,
        reflectionText,
        items: submitted.map((item) => ({
          ...(item.id ? { id: item.id } : {}),
          questionText: item.questionText,
          answerNotes: item.answerNotes,
        })),
      });
      if (!result.success) {
        toastError(result.message);
        return;
      }
      toastSuccess(t("jobs.interviewReflectionSaved"));
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[600px] max-h-[80vh] flex flex-col overflow-hidden"
        data-testid="interview-reflection-dialog"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("jobs.interviewReflection")}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="interview-reflection-body"
        >
          {loading ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="interview-reflection-loading"
            >
              {t("common.loading")}
            </p>
          ) : loadError ? (
            <p
              className="text-sm text-destructive"
              data-testid="interview-reflection-error"
            >
              {loadError}
            </p>
          ) : ready ? (
            <div className="space-y-6">
            <section className="space-y-3" data-testid="interview-reflection-ai">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onGenerateDraft}
                  disabled={generating || aiAvailability !== "ready"}
                  data-testid="interview-reflection-ai-generate"
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  {t("jobs.interviewReflectionAiGenerate")}
                  {generating && (
                    <Loader className="ml-2 h-4 w-4 shrink-0 spinner" />
                  )}
                </Button>
                {aiAvailability === "not_configured" && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="interview-reflection-ai-unavailable"
                  >
                    {t("jobs.interviewReflectionAiUnavailable")}{" "}
                    <Link
                      href="/dashboard/settings#ai-assignments"
                      className="underline underline-offset-2"
                    >
                      {t("jobs.interviewReflectionAiSettingsLink")}
                    </Link>
                  </p>
                )}
                {aiAvailability === "invalid" && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="interview-reflection-ai-invalid"
                  >
                    {t("jobs.interviewReflectionAiInvalid", {
                      code: aiInvalidCode ?? "",
                    })}
                  </p>
                )}
              </div>
              {draftError ? (
                <p
                  className="text-sm text-destructive"
                  data-testid="interview-reflection-ai-error"
                >
                  {draftError}
                </p>
              ) : null}
              {draft ? (
                <div
                  className="space-y-3 rounded-md border border-dashed p-3"
                  data-testid="interview-reflection-draft"
                >
                  <div className="space-y-1">
                    <h3 className="text-sm font-medium">
                      {t("jobs.interviewReflectionAiDraftTitle")}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t("jobs.interviewReflectionAiDraftHint")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="interview-reflection-draft-overall">
                      {t("jobs.overallReflection")}
                    </Label>
                    <Textarea
                      id="interview-reflection-draft-overall"
                      value={draft.reflectionText}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                reflectionText: event.target.value,
                              }
                            : current,
                        )
                      }
                      data-testid="interview-reflection-draft-overall"
                    />
                  </div>
                  {draft.items.map((item, index) => (
                    <div
                      key={item.key}
                      className="space-y-2 rounded-md border p-3"
                      data-testid="interview-reflection-draft-row"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          {t("jobs.interviewReflectionQuestionIndex", {
                            number: index + 1,
                          })}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground"
                          onClick={() => removeDraftItem(item.key)}
                          data-testid="interview-reflection-draft-remove"
                        >
                          {t("jobs.removeInterviewQuestion")}
                        </Button>
                      </div>
                      <Textarea
                        aria-label={t("jobs.interviewQuestion")}
                        value={item.questionText}
                        onChange={(event) =>
                          updateDraftItem(
                            item.key,
                            "questionText",
                            event.target.value,
                          )
                        }
                        data-testid="interview-reflection-draft-question"
                      />
                      <Textarea
                        aria-label={t("jobs.interviewAnswerNotes")}
                        value={item.answerNotes}
                        onChange={(event) =>
                          updateDraftItem(
                            item.key,
                            "answerNotes",
                            event.target.value,
                          )
                        }
                        data-testid="interview-reflection-draft-answer"
                      />
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={applyDraft}
                      data-testid="interview-reflection-draft-apply"
                    >
                      {t("jobs.interviewReflectionAiApply")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDraft(null)}
                      data-testid="interview-reflection-draft-discard"
                    >
                      {t("jobs.interviewReflectionAiDiscard")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>
            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {t("jobs.interviewQuestion")}
              </h3>
              {items.map((item, index) => (
                <div
                  key={item.key}
                  className="space-y-3 rounded-md border p-3"
                  data-testid="interview-reflection-question-row"
                >
                  <p className="text-sm font-medium">
                    {t("jobs.interviewReflectionQuestionIndex", {
                      number: index + 1,
                    })}
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor={`interview-question-${item.key}`}>
                      {t("jobs.interviewQuestion")}
                    </Label>
                    <Textarea
                      id={`interview-question-${item.key}`}
                      value={item.questionText}
                      onChange={(event) =>
                        updateItem(item.key, "questionText", event.target.value)
                      }
                      data-testid="interview-reflection-question"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`interview-answer-${item.key}`}>
                      {t("jobs.interviewAnswerNotes")}
                    </Label>
                    <Textarea
                      id={`interview-answer-${item.key}`}
                      value={item.answerNotes}
                      onChange={(event) =>
                        updateItem(item.key, "answerNotes", event.target.value)
                      }
                      data-testid="interview-reflection-answer"
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => removeQuestion(item.key)}
                    data-testid="interview-reflection-remove-question"
                  >
                    {t("jobs.removeInterviewQuestion")}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addQuestion}
                data-testid="interview-reflection-add-question"
              >
                <Plus className="mr-2 h-4 w-4" />
                {t("jobs.addInterviewQuestion")}
              </Button>
            </section>
            <section className="space-y-2">
              <Label htmlFor="interview-overall-reflection">
                {t("jobs.overallReflection")}
              </Label>
              <Textarea
                id="interview-overall-reflection"
                value={reflectionText}
                onChange={(event) => setReflectionText(event.target.value)}
                data-testid="interview-reflection-overall"
              />
            </section>
            {formError ? (
              <p
                className="text-sm text-destructive"
                data-testid="interview-reflection-form-error"
              >
                {formError}
              </p>
            ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter className="shrink-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={isPending || loading || !ready}
            data-testid="interview-reflection-save"
          >
            {t("jobs.saveInterviewReflection")}
            {isPending && (
              <Loader className="ml-2 h-4 w-4 shrink-0 spinner" />
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
