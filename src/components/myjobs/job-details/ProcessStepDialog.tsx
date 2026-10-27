"use client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/DatePicker";
import { TimePicker } from "@/components/TimePicker";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { useEffect, useRef, useTransition } from "react";
import { Loader } from "lucide-react";
import { PROCESS_STEP_CATEGORY } from "@/lib/career/identities";
import type {
  ApplicationAttemptTimelineDTO,
  ApplicationProcessStepDTO,
  StepTimeInput,
} from "@/lib/career/applicationTimeline";
import {
  stepTimeFieldFromStored,
  stepTimeInputFromField,
  type StepTimeFieldValue,
} from "./stepTimeFields";
import { useI18n } from "@/i18n";

const CATEGORY_OPTIONS = [
  PROCESS_STEP_CATEGORY.SCREENING,
  PROCESS_STEP_CATEGORY.ASSESSMENT,
  PROCESS_STEP_CATEGORY.INTERVIEW,
  PROCESS_STEP_CATEGORY.OFFER,
  PROCESS_STEP_CATEGORY.ONBOARDING,
  PROCESS_STEP_CATEGORY.OTHER,
] as const;

/** Values handed to the caller: `scheduledAt`/`deadlineAt` arrive already in
 *  the wire contract — `undefined` means the field was never touched in edit
 *  mode, so the server leaves every stored column (and any historical
 *  unknown precision) exactly as it was. */
export type ProcessStepFormValues = {
  applicationAttemptId: string;
  category: string;
  label: string;
  scheduledAt: StepTimeInput | undefined;
  deadlineAt: StepTimeInput | undefined;
  notes: string;
  result: string;
};

type ProcessStepFormFields = {
  applicationAttemptId: string;
  category: string;
  label: string;
  scheduledDate: Date | null;
  scheduledTime: string;
  deadlineDate: Date | null;
  deadlineTime: string;
  notes: string;
  result: string;
};

type ProcessStepDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editStep?: ApplicationProcessStepDTO | null;
  restrictFields?: boolean;
  /** Account zone used to backfill wall times and resolve new input. */
  timeZone: string;
  // Live attempts the new step may be attached to. Undefined hides the
  // picker entirely (edit mode); an empty array means saving creates an
  // application draft first.
  attempts?: ApplicationAttemptTimelineDTO[];
  onSubmit: (values: ProcessStepFormValues) => Promise<boolean>;
};

export function ProcessStepDialog({
  open,
  onOpenChange,
  editStep,
  restrictFields = false,
  timeZone,
  attempts,
  onSubmit,
}: ProcessStepDialogProps) {
  const { t, locale, formatDateTime } = useI18n();
  const [isPending, startTransition] = useTransition();
  const form = useForm<ProcessStepFormFields>({
    defaultValues: {
      applicationAttemptId: "",
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "",
      scheduledDate: null,
      scheduledTime: "",
      deadlineDate: null,
      deadlineTime: "",
      notes: "",
      result: "",
    },
  });

  const attemptsRef = useRef(attempts);
  useEffect(() => {
    attemptsRef.current = attempts;
  }, [attempts]);

  useEffect(() => {
    if (!open) return;
    const options = attemptsRef.current;
    const scheduled: StepTimeFieldValue = editStep
      ? stepTimeFieldFromStored(
          {
            iso: editStep.scheduledAt,
            precision: editStep.scheduledAtPrecision,
            dateOnly: null,
            zone: editStep.scheduledAtZone,
          },
          timeZone,
        )
      : { date: null, time: "" };
    const deadline: StepTimeFieldValue = editStep
      ? stepTimeFieldFromStored(
          {
            iso: editStep.deadlineAt,
            precision: editStep.deadlinePrecision,
            dateOnly: editStep.deadlineOn,
            zone: editStep.deadlineZone,
          },
          timeZone,
        )
      : { date: null, time: "" };
    form.reset({
      applicationAttemptId: options?.length === 1 ? options[0].id : "",
      category: editStep?.category ?? PROCESS_STEP_CATEGORY.INTERVIEW,
      label: editStep?.label ?? "",
      scheduledDate: scheduled.date,
      scheduledTime: scheduled.time,
      deadlineDate: deadline.date,
      deadlineTime: deadline.time,
      notes: editStep?.notes ?? "",
      result: editStep?.result ?? "",
    });
  }, [editStep, form, open, timeZone]);

  // A refreshed attempt list can invalidate a selection made before the
  // refresh: clear it so the user picks again instead of the step
  // silently landing on another application.
  useEffect(() => {
    if (!open || !attempts) return;
    const current = form.getValues("applicationAttemptId");
    if (current && !attempts.some((attempt) => attempt.id === current)) {
      form.setValue("applicationAttemptId", "");
    }
  }, [attempts, form, open]);

  function submit(values: ProcessStepFormFields) {
    const dirty = form.formState.dirtyFields;
    const scheduledTouched = Boolean(
      dirty.scheduledDate || dirty.scheduledTime,
    );
    const deadlineTouched = Boolean(dirty.deadlineDate || dirty.deadlineTime);

    const scheduled = stepTimeInputFromField("scheduledAt", {
      date: values.scheduledDate,
      time: values.scheduledTime,
    });
    const deadline = stepTimeInputFromField("deadlineAt", {
      date: values.deadlineDate,
      time: values.deadlineTime,
    });
    const timeFieldMessage = (
      reason: "time-required" | "date-required" | "invalid-time",
    ) =>
      reason === "date-required"
        ? locale === "zh-CN"
          ? "请先选择日期"
          : "Pick a date first"
        : reason === "invalid-time"
          ? locale === "zh-CN"
            ? "时间格式无效"
            : "Invalid time"
          : locale === "zh-CN"
            ? "请选择具体时间"
            : "Pick a time";
    if (scheduledTouched && !scheduled.ok) {
      form.setError("scheduledTime", {
        message: timeFieldMessage(scheduled.reason),
      });
      return;
    }
    if (deadlineTouched && !deadline.ok) {
      form.setError("deadlineTime", {
        message: timeFieldMessage(deadline.reason),
      });
      return;
    }

    startTransition(async () => {
      const ok = await onSubmit({
        applicationAttemptId: values.applicationAttemptId,
        category: values.category,
        label: values.label,
        scheduledAt: scheduledTouched
          ? scheduled.ok
            ? scheduled.value
            : undefined
          : undefined,
        deadlineAt: deadlineTouched
          ? deadline.ok
            ? deadline.value
            : undefined
          : undefined,
        notes: values.notes,
        result: values.result,
      });
      if (ok) onOpenChange(false);
    });
  }

  const attemptOptionLabel = (attempt: ApplicationAttemptTimelineDTO) => {
    const stageKey = `jobs.attemptStages.${attempt.currentStageCategory}`;
    const stage = t(stageKey);
    const stageText = stage === stageKey ? attempt.currentStageCategory : stage;
    const timing = attempt.submittedAt
      ? t("jobs.attemptOptionSubmitted", {
          date: formatDateTime(attempt.submittedAt),
        })
      : t("jobs.attemptOptionRecorded", {
          date: formatDateTime(attempt.createdAt),
        });
    return `${attempt.channelLabel} · ${stageText} · ${timing}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editStep ? t("jobs.editProcessStep") : t("jobs.addProcessStep")}
          </DialogTitle>
          <DialogDescription>
            {editStep
              ? t("jobs.editProcessStep")
              : t("jobs.addProcessStep")}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            {attempts != null && attempts.length > 0 && (
              <FormField
                control={form.control}
                name="applicationAttemptId"
                rules={{ required: t("jobs.attemptSelectRequired") }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("jobs.attemptForStep")}</FormLabel>
                    <FormControl>
                      <select
                        {...field}
                        className="h-9 w-full max-w-full rounded-md border bg-background px-2 text-sm"
                        data-testid="attempt-select"
                      >
                        <option value="">
                          {t("jobs.attemptSelectPlaceholder")}
                        </option>
                        {attempts.map((attempt) => (
                          <option key={attempt.id} value={attempt.id}>
                            {attemptOptionLabel(attempt)}
                          </option>
                        ))}
                      </select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {attempts != null && attempts.length === 0 && (
              <p
                className="text-sm text-muted-foreground"
                data-testid="attempt-draft-notice"
              >
                {t("jobs.attemptDraftNotice")}
              </p>
            )}
            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("jobs.stepCategory")}</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={restrictFields}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CATEGORY_OPTIONS.map((category) => (
                        <SelectItem key={category} value={category}>
                          {t(`jobs.stepCategories.${category}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("jobs.stepLabel")}</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={restrictFields} required />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {!restrictFields && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <FormField
                    control={form.control}
                    name="scheduledDate"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("jobs.stepScheduledAt")}</FormLabel>
                        <DatePicker
                          field={field}
                          presets={false}
                          isEnabled
                          fullWidth
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="scheduledTime"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("common.pickTime")}</FormLabel>
                        <TimePicker field={field} />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <FormField
                    control={form.control}
                    name="deadlineDate"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("jobs.stepDeadlineAt")}</FormLabel>
                        <DatePicker
                          field={field}
                          presets={false}
                          isEnabled
                          fullWidth
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="deadlineTime"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("common.pickTime")}</FormLabel>
                        <TimePicker field={field} />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </>
            )}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("jobs.stepNotes")}</FormLabel>
                  <FormControl>
                    <Textarea {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {editStep && (
              <FormField
                control={form.control}
                name="result"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("jobs.stepResult")}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={isPending}>
                {t("common.save")}
                {isPending && (
                  <Loader className="ml-2 h-4 w-4 shrink-0 spinner" />
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
