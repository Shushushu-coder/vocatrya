"use client";
import { useEffect, useTransition } from "react";
import { useForm } from "react-hook-form";
import { Loader } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/DatePicker";
import { TimePicker } from "@/components/TimePicker";
import { Form, FormField, FormItem, FormMessage } from "@/components/ui/form";
import type {
  ApplicationProcessStepDTO,
  StepTimeInput,
} from "@/lib/career/applicationTimeline";
import {
  stepTimeFieldFromStored,
  stepTimeInputFromField,
} from "./stepTimeFields";
import { useI18n } from "@/i18n";

export type RescheduleStepValues = {
  /** `undefined` = field untouched; the server keeps the stored value and
   *  precision exactly as it was. */
  scheduledAt: StepTimeInput | undefined;
  deadlineAt: StepTimeInput | undefined;
};

type RescheduleStepDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  step: ApplicationProcessStepDTO | null;
  /** Account zone used to backfill wall times and resolve new input. */
  timeZone: string;
  onSubmit: (values: RescheduleStepValues) => Promise<boolean>;
};

type RescheduleStepFields = {
  scheduledDate: Date | null;
  scheduledTime: string;
  deadlineDate: Date | null;
  deadlineTime: string;
};

export function RescheduleStepDialog({
  open,
  onOpenChange,
  step,
  timeZone,
  onSubmit,
}: RescheduleStepDialogProps) {
  const { t, locale } = useI18n();
  const [isPending, startTransition] = useTransition();
  const form = useForm<RescheduleStepFields>({
    defaultValues: {
      scheduledDate: null,
      scheduledTime: "",
      deadlineDate: null,
      deadlineTime: "",
    },
  });

  useEffect(() => {
    if (!open) return;
    const scheduled = step
      ? stepTimeFieldFromStored(
          {
            iso: step.scheduledAt,
            precision: step.scheduledAtPrecision,
            dateOnly: null,
            zone: step.scheduledAtZone,
          },
          timeZone,
        )
      : { date: null, time: "" };
    const deadline = step
      ? stepTimeFieldFromStored(
          {
            iso: step.deadlineAt,
            precision: step.deadlinePrecision,
            dateOnly: step.deadlineOn,
            zone: step.deadlineZone,
          },
          timeZone,
        )
      : { date: null, time: "" };
    form.reset({
      scheduledDate: scheduled.date,
      scheduledTime: scheduled.time,
      deadlineDate: deadline.date,
      deadlineTime: deadline.time,
    });
  }, [open, step, form, timeZone]);

  const submit = (values: RescheduleStepFields) => {
    if (isPending) return;
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
      });
      if (ok) onOpenChange(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("jobs.rescheduleStepTitle")}</DialogTitle>
          <DialogDescription>{step?.label}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <fieldset disabled={isPending} className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
            <FormField
              control={form.control}
              name="scheduledDate"
              render={({ field }) => (
                <FormItem className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {t("jobs.stepScheduledAt")}
                  </span>
                  <DatePicker field={field} presets={false} isEnabled fullWidth />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="scheduledTime"
              render={({ field }) => (
                <FormItem className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {t("common.pickTime")}
                  </span>
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
                <FormItem className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {t("jobs.stepDeadlineAt")}
                  </span>
                  <DatePicker field={field} presets={false} isEnabled fullWidth />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="deadlineTime"
              render={({ field }) => (
                <FormItem className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {t("common.pickTime")}
                  </span>
                  <TimePicker field={field} />
                  <FormMessage />
                </FormItem>
              )}
            />
            </div>
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
            </fieldset>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
