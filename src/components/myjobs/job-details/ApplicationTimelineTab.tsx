"use client";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { CalendarClock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DeleteAlertDialog } from "@/components/DeleteAlertDialog";
import { JobTabEmptyState } from "./JobTabEmptyState";
import { ProcessStepDialog, type ProcessStepFormValues } from "./ProcessStepDialog";
import { InterviewReflectionDialog } from "./InterviewReflectionDialog";
import { ProcessStepsTable } from "./ProcessStepsTable";
import {
  QuickAddProcessStep,
  type QuickAddStepValues,
} from "./QuickAddProcessStep";
import {
  RescheduleStepDialog,
  type RescheduleStepValues,
} from "./RescheduleStepDialog";
import {
  CreateAttemptDialog,
  type CreateAttemptFormValues,
} from "./CreateAttemptDialog";
import { TransferAttemptDialog } from "./TransferAttemptDialog";
import {
  cancelApplicationProcessStep,
  completeApplicationProcessStep,
  createApplicationAttempt,
  createApplicationProcessStep,
  createTransferredAttempt,
  deleteApplicationProcessStep,
  getApplicationTimeline,
  updateApplicationProcessStep,
} from "@/actions/application.actions";
import { SubmittedResumePanel } from "@/components/career/resume-variant/SubmittedResumePanel";
import type {
  ApplicationAttemptTimelineDTO,
  ApplicationProcessStepDTO,
  ApplicationTimelineDTO,
} from "@/lib/career/applicationTimeline";
import {
  isTerminalAttemptOutcome,
  PROCESS_STEP_SOURCE,
  PROCESS_STEP_STATUS,
} from "@/lib/career/identities";
import { toastError, toastSuccess } from "@/lib/toast";
import { useI18n } from "@/i18n";
import type { Locale } from "@/i18n";

// INT-01 owns the shared message bundles; until the declared keys land,
// t() echoes the key and the paired fallback keeps the page readable.
function useCopy() {
  const { t, locale } = useI18n();
  return (key: string, fallback: Record<Locale, string>) => {
    const translated = t(key);
    return translated === key ? fallback[locale] : translated;
  };
}

type ApplicationTimelineTabProps = {
  jobId: string;
  refreshKey: number;
  canMutate: boolean;
  companyName?: string | null;
  roleTitle?: string | null;
};

const ATTEMPT_RESELECT_ERROR_KEYS: Record<string, string> = {
  PROCESS_STEP_ATTEMPT_AMBIGUOUS: "jobs.attemptErrorAmbiguous",
  PROCESS_STEP_ATTEMPT_STATE_CHANGED: "jobs.attemptErrorStateChanged",
  ATTEMPT_ARCHIVED: "jobs.attemptErrorArchived",
  ATTEMPT_NOT_FOUND: "jobs.attemptErrorUnavailable",
  ATTEMPT_OPPORTUNITY_MISMATCH: "jobs.attemptErrorUnavailable",
  INVALID_ID: "jobs.attemptErrorUnavailable",
};

// Codes the transfer contract can surface; anything unmapped falls back to
// the server message. All of these mean the timeline is stale, so the tab
// reloads after showing the toast.
const TRANSFER_ERROR_COPY: Record<
  string,
  { key: string; fallback: Record<Locale, string> }
> = {
  TRANSFER_SAME_OPPORTUNITY: {
    key: "jobs.transferErrorSame",
    fallback: {
      "zh-CN": "不能转投到当前职位。",
      en: "Cannot transfer to the same position.",
    },
  },
  TRANSFER_SOURCE_TERMINAL: {
    key: "jobs.transferErrorTerminal",
    fallback: {
      "zh-CN": "该轮次已结束，无法转投。",
      en: "This application has ended and cannot be transferred.",
    },
  },
  ATTEMPT_NOT_FOUND: {
    key: "jobs.transferErrorUnavailable",
    fallback: {
      "zh-CN": "所选轮次或职位已不可用，列表已刷新。",
      en: "The application or position is no longer available. The list was refreshed.",
    },
  },
  OPPORTUNITY_NOT_FOUND: {
    key: "jobs.transferErrorUnavailable",
    fallback: {
      "zh-CN": "所选轮次或职位已不可用，列表已刷新。",
      en: "The application or position is no longer available. The list was refreshed.",
    },
  },
};

function isCompleted(step: ApplicationProcessStepDTO): boolean {
  return (
    step.completedAt != null ||
    step.status === PROCESS_STEP_STATUS.COMPLETED ||
    step.status === PROCESS_STEP_STATUS.CANCELLED
  );
}

export function ApplicationTimelineTab({
  jobId,
  refreshKey,
  canMutate,
  companyName,
  roleTitle,
}: ApplicationTimelineTabProps) {
  const { t, formatDateTime } = useI18n();
  const copy = useCopy();
  const [timeline, setTimeline] = useState<ApplicationTimelineDTO | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [attemptDialogOpen, setAttemptDialogOpen] = useState(false);
  const [transferAttempt, setTransferAttempt] =
    useState<ApplicationAttemptTimelineDTO | null>(null);
  const [editStep, setEditStep] = useState<ApplicationProcessStepDTO | null>(null);
  const [rescheduleStep, setRescheduleStep] =
    useState<ApplicationProcessStepDTO | null>(null);
  const [stepToCancel, setStepToCancel] =
    useState<ApplicationProcessStepDTO | null>(null);
  const [stepToDelete, setStepToDelete] = useState<ApplicationProcessStepDTO | null>(
    null,
  );
  const [reflectionStep, setReflectionStep] =
    useState<ApplicationProcessStepDTO | null>(null);
  const [completingId, startComplete] = useTransition();
  const [cancellingId, startCancel] = useTransition();
  const [deletingId, startDelete] = useTransition();

  const rowActionBusy = Boolean(completingId || cancellingId || deletingId);

  // Mirrors the backend rule: only non-archived attempts may receive new steps.
  const liveAttempts = useMemo(
    () => (timeline?.attempts ?? []).filter((attempt) => attempt.archivedAt == null),
    [timeline],
  );

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
          deadlineAt: restrictFields ? undefined : values.deadlineAt,
          notes: values.notes || null,
          result: values.result || null,
        })
      : await createApplicationProcessStep({
          jobOpportunityId: jobId,
          // Zero live attempts means the user explicitly asked to create the
          // draft together with this step; with one or more live attempts the
          // picker's explicit id is the only accepted ownership signal. The
          // two inputs are mutually exclusive on the server.
          ...(liveAttempts.length === 0
            ? { createDraftAttempt: true }
            : { applicationAttemptId: values.applicationAttemptId || undefined }),
          category: values.category,
          label: values.label,
          scheduledAt: values.scheduledAt,
          deadlineAt: values.deadlineAt,
          notes: values.notes || null,
        });
    if (!result.success) {
      const attemptErrorKey =
        !editStep && result.code
          ? ATTEMPT_RESELECT_ERROR_KEYS[result.code]
          : undefined;
      toastError(attemptErrorKey ? t(attemptErrorKey) : result.message);
      if (attemptErrorKey) {
        await loadTimeline();
      }
      return false;
    }
    toastSuccess(editStep ? t("jobs.stepUpdated") : t("jobs.stepAdded"));
    await loadTimeline();
    return true;
  };

  const onCreateAttempt = async (values: CreateAttemptFormValues) => {
    const result = await createApplicationAttempt({
      jobOpportunityId: jobId,
      channelLabel: values.channelLabel,
      channelCategory: values.channelCategory,
      sourceUrl: values.sourceUrl,
      notes: values.notes,
    });
    if (!result.success) {
      const stale =
        result.code === "OPPORTUNITY_NOT_FOUND" || result.code === "INVALID_ID";
      toastError(
        stale
          ? copy("jobs.attemptOpportunityUnavailable", {
              "zh-CN": "该职位已不可用，列表已刷新。",
              en: "This position is no longer available. The list was refreshed.",
            })
          : result.message,
      );
      if (stale) {
        await loadTimeline();
      }
      return false;
    }
    toastSuccess(
      copy("jobs.attemptCreated", {
        "zh-CN": "已新建投递轮次",
        en: "Application round created",
      }),
    );
    await loadTimeline();
    return true;
  };

  const onTransferAttempt = async (targetJobOpportunityId: string) => {
    if (!transferAttempt) return false;
    const result = await createTransferredAttempt({
      sourceAttemptId: transferAttempt.id,
      targetJobOpportunityId,
    });
    if (!result.success) {
      const entry = result.code ? TRANSFER_ERROR_COPY[result.code] : undefined;
      toastError(entry ? copy(entry.key, entry.fallback) : result.message);
      await loadTimeline();
      return false;
    }
    toastSuccess(
      copy("jobs.transferSuccess", {
        "zh-CN": "已转投到新职位",
        en: "Application transferred",
      }),
    );
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

  const onRescheduleSave = async (values: RescheduleStepValues) => {
    if (!rescheduleStep) return false;
    const result = await updateApplicationProcessStep({
      stepId: rescheduleStep.id,
      scheduledAt: values.scheduledAt,
      deadlineAt: values.deadlineAt,
    });
    if (!result.success) {
      toastError(result.message);
      return false;
    }
    toastSuccess(t("jobs.stepRescheduled"));
    await loadTimeline();
    return true;
  };

  const onQuickAdd = async (
    attemptId: string,
    values: QuickAddStepValues,
  ) => {
    const result = await createApplicationProcessStep({
      jobOpportunityId: jobId,
      applicationAttemptId: attemptId,
      category: values.category,
      label: values.label,
      scheduledAt: values.scheduledAt,
      deadlineAt: values.deadlineAt,
    });
    if (!result.success) {
      const attemptErrorKey = result.code
        ? ATTEMPT_RESELECT_ERROR_KEYS[result.code]
        : undefined;
      toastError(attemptErrorKey ? t(attemptErrorKey) : result.message);
      if (attemptErrorKey) {
        await loadTimeline();
      }
      return false;
    }
    toastSuccess(t("jobs.stepAdded"));
    await loadTimeline();
    return true;
  };

  const onConfirmCancel = () => {
    if (!stepToCancel) return;
    const stepId = stepToCancel.id;
    startCancel(async () => {
      const result = await cancelApplicationProcessStep(stepId);
      if (!result.success) {
        toastError(result.message);
        return;
      }
      toastSuccess(t("jobs.stepCancelled"));
      setStepToCancel(null);
      await loadTimeline();
    });
  };

  const onConfirmDelete = () => {
    if (!stepToDelete) return;
    const stepId = stepToDelete.id;
    startDelete(async () => {
      const result = await deleteApplicationProcessStep(stepId);
      if (!result.success) {
        toastError(result.message);
        return;
      }
      toastSuccess(t("jobs.stepDeleted"));
      setStepToDelete(null);
      await loadTimeline();
    });
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

  if (!timeline) {
    return (
      <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
    );
  }

  // The dialogs render at a fixed position outside the attempt-count branch so
  // the process-step form survives a zero→nonzero timeline flip: a refresh
  // after PROCESS_STEP_ATTEMPT_STATE_CHANGED must keep the typed draft for an
  // explicit re-selection instead of remounting and wiping it.
  const dialogs = canMutate ? (
    <>
      <ProcessStepDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editStep={editStep}
        restrictFields={restrictFields}
        attempts={editStep ? undefined : liveAttempts}
        onSubmit={onSave}
      />
      <CreateAttemptDialog
        open={attemptDialogOpen}
        onOpenChange={setAttemptDialogOpen}
        onSubmit={onCreateAttempt}
      />
      <TransferAttemptDialog
        open={transferAttempt != null}
        onOpenChange={(open) => {
          if (!open) setTransferAttempt(null);
        }}
        sourceAttempt={transferAttempt}
        excludeJobOpportunityId={jobId}
        onSubmit={onTransferAttempt}
      />
      <RescheduleStepDialog
        open={rescheduleStep != null}
        onOpenChange={(open) => {
          if (!open) setRescheduleStep(null);
        }}
        step={rescheduleStep}
        onSubmit={onRescheduleSave}
      />
      <InterviewReflectionDialog
        open={reflectionStep != null}
        onOpenChange={(open) => {
          if (!open) setReflectionStep(null);
        }}
        step={reflectionStep}
        companyName={companyName}
        roleTitle={roleTitle}
      />
      <DeleteAlertDialog
        pageTitle=""
        open={stepToDelete != null}
        onOpenChange={(open) => {
          if (!open) setStepToDelete(null);
        }}
        onDelete={onConfirmDelete}
        alertTitle={t("jobs.deleteProcessStepTitle")}
        alertDescription={t("jobs.deleteProcessStepDescription")}
      />
      <DeleteAlertDialog
        pageTitle=""
        open={stepToCancel != null}
        onOpenChange={(open) => {
          if (!open) setStepToCancel(null);
        }}
        onDelete={onConfirmCancel}
        actionLabel={t("jobs.cancelProcessStepConfirm")}
        actionVariant="default"
        alertTitle={t("jobs.cancelProcessStepTitle")}
        alertDescription={t("jobs.cancelProcessStepDescription")}
      />
    </>
  ) : null;

  if (timeline.attempts.length === 0) {
    return (
      <>
        <JobTabEmptyState
          icon={CalendarClock}
          title={t("jobs.timelineEmptyTitle")}
          description={t("jobs.timelineEmptyDescription")}
          actionLabel={canMutate ? t("jobs.addProcessStepWithDraft") : undefined}
          onAction={canMutate ? openCreate : undefined}
        />
        {/* Keep the fixed dialog position (see `dialogs` above): siblings go after it. */}
        {dialogs}
        {canMutate && (
          <div className="-mt-4 flex justify-center pb-4">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setAttemptDialogOpen(true)}
              data-testid="add-attempt"
            >
              {copy("jobs.addAttempt", {
                "zh-CN": "新建投递轮次",
                en: "New application",
              })}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
    <div className="space-y-6" data-testid="application-timeline">
      {canMutate && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAttemptDialogOpen(true)}
            data-testid="add-attempt"
          >
            <Plus className="mr-2 h-4 w-4" />
            {copy("jobs.addAttempt", {
              "zh-CN": "新建投递轮次",
              en: "New application",
            })}
          </Button>
          <Button type="button" size="sm" onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {liveAttempts.length === 0
              ? t("jobs.addProcessStepWithDraft")
              : t("jobs.addProcessStep")}
          </Button>
        </div>
      )}
      {timeline.attempts.map((attempt) => (
        <section
          key={attempt.id}
          className="space-y-4 rounded-lg border p-4"
          data-attempt-id={attempt.id}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium" data-testid="attempt-channel">
              {attempt.channelLabel}
            </p>
            {canMutate &&
            attempt.archivedAt == null &&
            !isTerminalAttemptOutcome(attempt.outcome) ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setTransferAttempt(attempt)}
                data-testid="transfer-attempt"
              >
                {copy("jobs.transferAttempt", {
                  "zh-CN": "转投",
                  en: "Transfer",
                })}
              </Button>
            ) : null}
          </div>
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
                {attempt.archivedAt ? (
                  <Badge variant="outline" className="ml-2">
                    {t("jobs.attemptArchived")}
                  </Badge>
                ) : null}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                {t("jobs.attemptOutcome")}
              </p>
              <p className="mt-1 font-medium">{outcomeLabel(attempt.outcome)}</p>
            </div>
            {attempt.transferredFromAttemptId ? (
              <div className="sm:col-span-2">
                <p className="text-sm text-muted-foreground">
                  {t("jobs.transferredFrom")}
                </p>
                <p className="mt-1 font-medium">
                  {attempt.transferredFrom
                    ? t("jobs.transferredFromDetail", {
                        company: attempt.transferredFrom.company,
                        title: attempt.transferredFrom.title,
                      })
                    : t("jobs.transferredFromGeneric")}
                </p>
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <p className="text-sm text-muted-foreground">
                {t("jobs.submittedResume")}
              </p>
              <SubmittedResumePanel
                attemptId={attempt.id}
                submittedResume={attempt.submittedResume}
                canMutate={canMutate}
                onBound={loadTimeline}
              />
            </div>
          </div>

          {attempt.steps.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="timeline-steps-empty"
            >
              {t("jobs.timelineStepsEmpty")}
            </p>
          ) : (
            <ProcessStepsTable
              steps={attempt.steps}
              canMutate={canMutate}
              busy={rowActionBusy}
              onEdit={openEdit}
              onReschedule={setRescheduleStep}
              onComplete={(step) => onComplete(step.id)}
              onCancel={setStepToCancel}
              onDelete={setStepToDelete}
              onReflect={setReflectionStep}
            />
          )}
          {canMutate && attempt.archivedAt == null && (
            <QuickAddProcessStep
              onSubmit={(values) => onQuickAdd(attempt.id, values)}
            />
          )}
        </section>
      ))}
    </div>
    {dialogs}
    </>
  );
}
