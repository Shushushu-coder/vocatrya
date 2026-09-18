"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Loader, Plus } from "lucide-react";
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

    void getInterviewReflection(step.id).then((result) => {
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
    });

    return () => {
      cancelled = true;
    };
  }, [open, step]);

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
        className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto"
        data-testid="interview-reflection-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("jobs.interviewReflection")}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
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
        <DialogFooter>
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
