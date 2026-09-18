"use client";
import { useCallback, useEffect, useState, useTransition } from "react";
import { CalendarClock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { JobTabEmptyState } from "./JobTabEmptyState";
import { ProcessStepDialog, type ProcessStepFormValues } from "./ProcessStepDialog";
import {
  completeApplicationProcessStep,
  createApplicationProcessStep,
  getApplicationTimeline,
  updateApplicationProcessStep,
} from "@/actions/application.actions";
import type {
  ApplicationProcessStepDTO,
  ApplicationTimelineDTO,
} from "@/lib/career/applicationTimeline";
import { PROCESS_STEP_SOURCE, PROCESS_STEP_STATUS } from "@/lib/career/identities";
import { toastError, toastSuccess } from "@/lib/toast";
import { useI18n } from "@/i18n";

type ApplicationTimelineTabProps = {
  jobId: string;
  refreshKey: number;
  canMutate: boolean;
};

function isCompleted(step: ApplicationProcessStepDTO): boolean {
  return (
    step.completedAt != null || step.status === PROCESS_STEP_STATUS.COMPLETED
  );
}

export function ApplicationTimelineTab({
  jobId,
  refreshKey,
  canMutate,
}: ApplicationTimelineTabProps) {
  const { t, formatDateTime } = useI18n();
  const [timeline, setTimeline] = useState<ApplicationTimelineDTO | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editStep, setEditStep] = useState<ApplicationProcessStepDTO | null>(null);
  const [completingId, startComplete] = useTransition();

  const loadTimeline = useCallback(async () => {
    const result = await getApplicationTimeline(jobId);
    if (result.success) {
      setTimeline(result.data ?? null);
    } else {
      toastError(result.message);
    }
  }, [jobId]);

  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline, refreshKey]);

  const openCreate = () => {
    setEditStep(null);
    setDialogOpen(true);
  };

  const openEdit = (step: ApplicationProcessStepDTO) => {
    setEditStep(step);
    setDialogOpen(true);
  };

  const restrictFields = Boolean(
    editStep &&
      (isCompleted(editStep) || editStep.source !== PROCESS_STEP_SOURCE.USER),
  );

  const onSave = async (values: ProcessStepFormValues) => {
    const result = editStep
      ? await updateApplicationProcessStep({
          stepId: editStep.id,
          category: restrictFields ? undefined : values.category,
          label: restrictFields ? undefined : values.label,
          scheduledAt: restrictFields ? undefined : values.scheduledAt,
          notes: values.notes || null,
          result: values.result || null,
        })
      : await createApplicationProcessStep({
          jobOpportunityId: jobId,
          category: values.category,
          label: values.label,
          scheduledAt: values.scheduledAt,
          notes: values.notes || null,
        });
    if (!result.success) {
      toastError(result.message);
      return false;
    }
    toastSuccess(editStep ? t("jobs.stepUpdated") : t("jobs.stepAdded"));
    await loadTimeline();
    return true;
  };

  const onComplete = (stepId: string) => {
    startComplete(async () => {
      const result = await completeApplicationProcessStep(stepId);
      if (!result.success) {
        toastError(result.message);
        return;
      }
      toastSuccess(t("jobs.stepCompleted"));
      await loadTimeline();
    });
  };

  const categoryLabel = (category: string) => {
    const key = `jobs.stepCategories.${category}`;
    const translated = t(key);
    return translated === key ? category : translated;
  };

  const stageLabel = (stage: string) => {
    const key = `jobs.attemptStages.${stage}`;
    const translated = t(key);
    return translated === key ? stage : translated;
  };

  const outcomeLabel = (outcome: string) => {
    const key = `jobs.attemptOutcomes.${outcome}`;
    const translated = t(key);
    return translated === key ? outcome : translated;
  };

  const statusLabel = (status: string) => {
    const key = `jobs.stepStatuses.${status}`;
    const translated = t(key);
    return translated === key ? status : translated;
  };

  const sourceLabel = (source: string) => {
    const key = `jobs.stepSources.${source}`;
    const translated = t(key);
    return translated === key ? null : translated;
  };

  const displayLabel = (step: ApplicationProcessStepDTO) => {
    if (
      step.source === PROCESS_STEP_SOURCE.SYSTEM &&
      t(`jobs.stepCategories.${step.category}`) !== `jobs.stepCategories.${step.category}`
    ) {
      return t(`jobs.stepCategories.${step.category}`);
    }
    return step.label;
  };

  if (!timeline) {
    return (
      <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
    );
  }

  if (timeline.attempts.length === 0) {
    return (
      <>
        <JobTabEmptyState
          icon={CalendarClock}
          title={t("jobs.timelineEmptyTitle")}
          description={t("jobs.timelineEmptyDescription")}
          actionLabel={canMutate ? t("jobs.addProcessStep") : undefined}
          onAction={canMutate ? openCreate : undefined}
        />
        {canMutate && (
          <ProcessStepDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onSubmit={onSave}
          />
        )}
      </>
    );
  }

  return (
    <div className="space-y-6" data-testid="application-timeline">
      {canMutate && (
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t("jobs.addProcessStep")}
          </Button>
        </div>
      )}
      {timeline.attempts.map((attempt) => (
        <section key={attempt.id} className="space-y-4 rounded-lg border p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">
                {t("jobs.attemptSubmittedAt")}
              </p>
              <p className="mt-1 font-medium">
                {attempt.submittedAt
                  ? formatDateTime(attempt.submittedAt)
                  : t("common.notAvailable")}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                {t("jobs.attemptCreatedAt")}
              </p>
              <p className="mt-1 font-medium">
                {formatDateTime(attempt.createdAt)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                {t("jobs.attemptStage")}
              </p>
              <p className="mt-1 font-medium">
                {stageLabel(attempt.currentStageCategory)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                {t("jobs.attemptOutcome")}
              </p>
              <p className="mt-1 font-medium">{outcomeLabel(attempt.outcome)}</p>
            </div>
            <div className="sm:col-span-2">
              <p className="text-sm text-muted-foreground">
                {t("jobs.submittedResume")}
              </p>
              {attempt.submittedResume ? (
                <p className="mt-1 font-medium">
                  {attempt.submittedResume.title}
                  {" · "}
                  {t("jobs.resumeVersionNumber", {
                    number: attempt.submittedResume.versionNumber,
                  })}
                </p>
              ) : (
                <div className="mt-1">
                  <p className="font-medium">{t("jobs.submittedResumeUnbound")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("jobs.submittedResumeUnboundHint")}
                  </p>
                </div>
              )}
            </div>
          </div>

          <ol className="space-y-3">
            {attempt.steps.map((step) => {
              const source = sourceLabel(step.source);
              const canComplete =
                canMutate &&
                !isCompleted(step) &&
                step.source === PROCESS_STEP_SOURCE.USER;
              return (
                <li
                  key={step.id}
                  className="rounded-md border bg-muted/30 p-3"
                  data-testid="application-process-step"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{displayLabel(step)}</p>
                      <p className="text-sm text-muted-foreground">
                        {categoryLabel(step.category)}
                        {source ? ` · ${source}` : ""}
                      </p>
                    </div>
                    <Badge
                      variant={
                        isCompleted(step)
                          ? "default"
                          : step.status === PROCESS_STEP_STATUS.IN_PROGRESS
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {statusLabel(step.status)}
                    </Badge>
                  </div>
                  <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                    {step.scheduledAt && (
                      <div>
                        <dt className="text-muted-foreground">
                          {t("jobs.stepScheduledAt")}
                        </dt>
                        <dd>{formatDateTime(step.scheduledAt)}</dd>
                      </div>
                    )}
                    {step.completedAt && (
                      <div>
                        <dt className="text-muted-foreground">
                          {t("jobs.stepCompletedAt")}
                        </dt>
                        <dd>{formatDateTime(step.completedAt)}</dd>
                      </div>
                    )}
                    {step.notes && (
                      <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">
                          {t("jobs.stepNotes")}
                        </dt>
                        <dd className="whitespace-pre-wrap">{step.notes}</dd>
                      </div>
                    )}
                    {step.result && (
                      <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">
                          {t("jobs.stepResult")}
                        </dt>
                        <dd>{step.result}</dd>
                      </div>
                    )}
                  </dl>
                  {canMutate && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => openEdit(step)}
                      >
                        {t("common.edit")}
                      </Button>
                      {canComplete && (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => onComplete(step.id)}
                          disabled={completingId}
                        >
                          {t("jobs.markStepComplete")}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {canMutate && (
        <ProcessStepDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editStep={editStep}
          restrictFields={restrictFields}
          onSubmit={onSave}
        />
      )}
    </div>
  );
}
