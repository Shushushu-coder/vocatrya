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
} from "@/lib/career/applicationTimeline";
import { useI18n } from "@/i18n";

const CATEGORY_OPTIONS = [
  PROCESS_STEP_CATEGORY.SCREENING,
  PROCESS_STEP_CATEGORY.ASSESSMENT,
  PROCESS_STEP_CATEGORY.INTERVIEW,
  PROCESS_STEP_CATEGORY.OFFER,
  PROCESS_STEP_CATEGORY.ONBOARDING,
  PROCESS_STEP_CATEGORY.OTHER,
] as const;

export type ProcessStepFormValues = {
  applicationAttemptId: string;
  category: string;
  label: string;
  scheduledAt: Date | null;
  deadlineAt: Date | null;
  notes: string;
  result: string;
};

type ProcessStepDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editStep?: ApplicationProcessStepDTO | null;
  restrictFields?: boolean;
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
  attempts,
  onSubmit,
}: ProcessStepDialogProps) {
  const { t, formatDateTime } = useI18n();
  const [isPending, startTransition] = useTransition();
  const form = useForm<ProcessStepFormValues>({
    defaultValues: {
      applicationAttemptId: "",
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "",
      scheduledAt: null,
      deadlineAt: null,
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
    form.reset({
      applicationAttemptId: options?.length === 1 ? options[0].id : "",
      category: editStep?.category ?? PROCESS_STEP_CATEGORY.INTERVIEW,
      label: editStep?.label ?? "",
      scheduledAt: editStep?.scheduledAt ? new Date(editStep.scheduledAt) : null,
      deadlineAt: editStep?.deadlineAt ? new Date(editStep.deadlineAt) : null,
      notes: editStep?.notes ?? "",
      result: editStep?.result ?? "",
    });
  }, [editStep, form, open]);

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

  function submit(values: ProcessStepFormValues) {
    startTransition(async () => {
      const ok = await onSubmit(values);
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
                <FormField
                  control={form.control}
                  name="scheduledAt"
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
                  name="deadlineAt"
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
