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
import { Form, FormField, FormItem } from "@/components/ui/form";
import type { ApplicationProcessStepDTO } from "@/lib/career/applicationTimeline";
import { useI18n } from "@/i18n";

export type RescheduleStepValues = {
  scheduledAt: Date | null;
  deadlineAt: Date | null;
};

type RescheduleStepDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  step: ApplicationProcessStepDTO | null;
  onSubmit: (values: RescheduleStepValues) => Promise<boolean>;
};

export function RescheduleStepDialog({
  open,
  onOpenChange,
  step,
  onSubmit,
}: RescheduleStepDialogProps) {
  const { t } = useI18n();
  const [isPending, startTransition] = useTransition();
  const form = useForm<RescheduleStepValues>({
    defaultValues: { scheduledAt: null, deadlineAt: null },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      scheduledAt: step?.scheduledAt ? new Date(step.scheduledAt) : null,
      deadlineAt: step?.deadlineAt ? new Date(step.deadlineAt) : null,
    });
  }, [open, step, form]);

  const submit = (values: RescheduleStepValues) => {
    if (isPending) return;
    startTransition(async () => {
      const ok = await onSubmit(values);
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
            <FormField
              control={form.control}
              name="scheduledAt"
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
              name="deadlineAt"
              render={({ field }) => (
                <FormItem className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {t("jobs.stepDeadlineAt")}
                  </span>
                  <DatePicker field={field} presets={false} isEnabled fullWidth />
                </FormItem>
              )}
            />
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
