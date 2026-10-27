"use client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_SOURCE,
  PROCESS_STEP_STATUS,
} from "@/lib/career/identities";
import type { ApplicationProcessStepDTO } from "@/lib/career/applicationTimeline";
import { businessTimeFromColumns, formatBusinessTime } from "@/lib/datetime";
import { useI18n, type Locale } from "@/i18n";

function isClosed(step: ApplicationProcessStepDTO): boolean {
  return (
    step.completedAt != null ||
    step.status === PROCESS_STEP_STATUS.COMPLETED ||
    step.status === PROCESS_STEP_STATUS.CANCELLED
  );
}

export type ProcessStepsTableProps = {
  steps: ApplicationProcessStepDTO[];
  canMutate: boolean;
  busy?: boolean;
  /** Account zone every instant renders in — comes from the timeline DTO. */
  timeZone: string;
  onEdit: (step: ApplicationProcessStepDTO) => void;
  onReschedule: (step: ApplicationProcessStepDTO) => void;
  onComplete: (step: ApplicationProcessStepDTO) => void;
  onCancel: (step: ApplicationProcessStepDTO) => void;
  onDelete: (step: ApplicationProcessStepDTO) => void;
  onReflect: (step: ApplicationProcessStepDTO) => void;
};

function scheduledDisplay(
  step: ApplicationProcessStepDTO,
  locale: Locale,
  timeZone: string,
): string {
  return formatBusinessTime(
    businessTimeFromColumns({
      dateOnly: null,
      instant: step.scheduledAt,
      precision: step.scheduledAtPrecision,
    }),
    locale,
    timeZone,
  );
}

function deadlineDisplay(
  step: ApplicationProcessStepDTO,
  locale: Locale,
  timeZone: string,
): string {
  return formatBusinessTime(
    businessTimeFromColumns({
      dateOnly: step.deadlineOn,
      instant: step.deadlineAt,
      precision: step.deadlinePrecision,
    }),
    locale,
    timeZone,
  );
}

function completedDisplay(
  step: ApplicationProcessStepDTO,
  locale: Locale,
  timeZone: string,
): string {
  return formatBusinessTime(
    businessTimeFromColumns({
      dateOnly: null,
      instant: step.completedAt,
      precision: step.completedAtPrecision,
    }),
    locale,
    timeZone,
  );
}

export function ProcessStepsTable({
  steps,
  canMutate,
  busy = false,
  timeZone,
  onEdit,
  onReschedule,
  onComplete,
  onCancel,
  onDelete,
  onReflect,
}: ProcessStepsTableProps) {
  const { t, locale } = useI18n();

  const categoryLabel = (category: string) => {
    const key = `jobs.stepCategories.${category}`;
    const translated = t(key);
    return translated === key ? category : translated;
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
      t(`jobs.stepCategories.${step.category}`) !==
        `jobs.stepCategories.${step.category}`
    ) {
      return t(`jobs.stepCategories.${step.category}`);
    }
    return step.label;
  };

  const statusVariant = (step: ApplicationProcessStepDTO) => {
    if (step.status === PROCESS_STEP_STATUS.COMPLETED) return "default" as const;
    if (step.status === PROCESS_STEP_STATUS.IN_PROGRESS)
      return "secondary" as const;
    return "outline" as const;
  };

  const closedAtLabel = (step: ApplicationProcessStepDTO) =>
    step.status === PROCESS_STEP_STATUS.CANCELLED
      ? t("jobs.stepCancelledAt")
      : t("jobs.stepCompletedAt");

  return (
    <Table data-testid="process-steps-table">
      <TableHeader>
        <TableRow>
          <TableHead>{t("jobs.stepLabel")}</TableHead>
          <TableHead className="whitespace-nowrap">
            {t("jobs.stepScheduledAt")}
          </TableHead>
          <TableHead className="whitespace-nowrap">
            {t("jobs.stepDeadlineAt")}
          </TableHead>
          <TableHead>{t("jobs.stepStatus")}</TableHead>
          <TableHead>{t("jobs.stepResult")}</TableHead>
          {canMutate && (
            <TableHead className="whitespace-nowrap">
              {t("jobs.stepActions")}
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {steps.map((step) => {
          const source = sourceLabel(step.source);
          const isUserStep = step.source === PROCESS_STEP_SOURCE.USER;
          const closed = isClosed(step);
          const canTransition = canMutate && isUserStep && !closed;
          const canOpenReflection =
            canMutate && step.category === PROCESS_STEP_CATEGORY.INTERVIEW;
          return (
            <TableRow
              key={step.id}
              data-testid="application-process-step"
              data-step-source={step.source}
              data-step-status={step.status}
            >
              <TableCell>
                <p className="font-medium">{displayLabel(step)}</p>
                <p className="text-xs text-muted-foreground">
                  {categoryLabel(step.category)}
                  {source ? ` · ${source}` : ""}
                </p>
                {step.notes && (
                  <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                    {step.notes}
                  </p>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {scheduledDisplay(step, locale, timeZone) || "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {deadlineDisplay(step, locale, timeZone) || "—"}
              </TableCell>
              <TableCell>
                <Badge variant={statusVariant(step)}>
                  {statusLabel(step.status)}
                </Badge>
                {step.completedAt && (
                  <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                    {closedAtLabel(step)}{" "}
                    {completedDisplay(step, locale, timeZone)}
                  </p>
                )}
              </TableCell>
              <TableCell>{step.result ?? "—"}</TableCell>
              {canMutate && (
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {canTransition && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => onReschedule(step)}
                          disabled={busy}
                          data-testid="reschedule-process-step"
                        >
                          {t("jobs.rescheduleStep")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => onComplete(step)}
                          disabled={busy}
                        >
                          {t("jobs.markStepComplete")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => onCancel(step)}
                          disabled={busy}
                          data-testid="cancel-process-step"
                        >
                          {t("jobs.cancelProcessStep")}
                        </Button>
                      </>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onEdit(step)}
                    >
                      {t("common.edit")}
                    </Button>
                    {canOpenReflection && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onReflect(step)}
                        data-testid="interview-reflection-entry"
                      >
                        {t("jobs.interviewReflection")}
                      </Button>
                    )}
                    {canMutate && isUserStep && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        onClick={() => onDelete(step)}
                        disabled={busy}
                        data-testid="delete-process-step"
                      >
                        {t("common.delete")}
                      </Button>
                    )}
                  </div>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
