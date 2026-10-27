"use client";
import { useId, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { Loader, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/DatePicker";
import { TimePicker } from "@/components/TimePicker";
import {
  Form,
  FormField,
  FormItem,
} from "@/components/ui/form";
import { PROCESS_STEP_CATEGORY } from "@/lib/career/identities";
import type { StepTimeInput } from "@/lib/career/applicationTimeline";
import { stepTimeInputFromField } from "./stepTimeFields";
import { toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";

const CATEGORY_OPTIONS = [
  PROCESS_STEP_CATEGORY.ASSESSMENT,
  PROCESS_STEP_CATEGORY.INTERVIEW,
  PROCESS_STEP_CATEGORY.OFFER,
  PROCESS_STEP_CATEGORY.ONBOARDING,
  PROCESS_STEP_CATEGORY.SCREENING,
  PROCESS_STEP_CATEGORY.OTHER,
] as const;

export type QuickAddStepValues = {
  category: string;
  label: string;
  scheduledAt: StepTimeInput;
  deadlineAt: StepTimeInput;
};

type QuickAddProcessStepProps = {
  onSubmit: (values: QuickAddStepValues) => Promise<boolean>;
};

type QuickAddDates = {
  scheduledDate: Date | null;
  scheduledTime: string;
  deadlineDate: Date | null;
};

export function QuickAddProcessStep({ onSubmit }: QuickAddProcessStepProps) {
  const { t, locale } = useI18n();
  const listId = useId();
  const [category, setCategory] = useState<string>(
    PROCESS_STEP_CATEGORY.INTERVIEW,
  );
  const [label, setLabel] = useState("");
  // DatePicker's FormControl needs a form context; only the date/time inputs
  // live in this form — category and label stay plain controlled inputs.
  const form = useForm<QuickAddDates>({
    defaultValues: { scheduledDate: null, scheduledTime: "", deadlineDate: null },
  });
  const [isPending, startTransition] = useTransition();

  const categoryLabel = (value: string) => {
    const key = `jobs.stepCategories.${value}`;
    const translated = t(key);
    return translated === key ? value : translated;
  };

  // Presets are "|"-joined localized suggestions stored as flat i18n strings;
  // they only feed the datalist, the label stays free text.
  const labelPresets = (value: string): string[] => {
    const raw = t(`jobs.stepLabelPresets.${value}`);
    return raw
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);
  };

  const submit = () => {
    if (isPending) return;
    const { scheduledDate, scheduledTime, deadlineDate } = form.getValues();
    const scheduled = stepTimeInputFromField("scheduledAt", {
      date: scheduledDate,
      time: scheduledTime,
    });
    if (!scheduled.ok) {
      toastError(
        locale === "zh-CN"
          ? "安排时间需要同时选择日期和具体时间"
          : "A scheduled step needs both a date and a time",
      );
      return;
    }
    const deadline = stepTimeInputFromField("deadlineAt", {
      date: deadlineDate,
      time: "",
    });
    startTransition(async () => {
      const ok = await onSubmit({
        category,
        label: label.trim() || labelPresets(category)[0] || categoryLabel(category),
        scheduledAt: scheduled.value,
        deadlineAt: deadline.ok ? deadline.value : null,
      });
      if (ok) {
        setLabel("");
        form.reset({ scheduledDate: null, scheduledTime: "", deadlineDate: null });
      }
    });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Enter submits only from text input; on the category select or the date
    // trigger button Enter means "open/choose", not "submit".
    if (
      event.key === "Enter" &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229 &&
      event.target instanceof HTMLElement &&
      event.target.tagName === "INPUT"
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Form {...form}>
      <fieldset
        disabled={isPending}
        className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3"
        data-testid="quick-add-step"
        onKeyDown={onKeyDown}
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            {t("jobs.stepCategory")}
          </span>
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            data-testid="quick-add-category"
          >
            {CATEGORY_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {categoryLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-[140px] flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            {t("jobs.stepLabel")}
          </span>
          <Input
            className="h-9"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={labelPresets(category)[0] ?? categoryLabel(category)}
            list={listId}
            data-testid="quick-add-label"
          />
          <datalist id={listId}>
            {labelPresets(category).map((preset) => (
              <option key={preset} value={preset} />
            ))}
          </datalist>
        </div>
        <div className="flex items-end gap-1">
          <FormField
            control={form.control}
            name="scheduledDate"
            render={({ field }) => (
              <FormItem className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {t("jobs.stepScheduledAt")}
                </span>
                <DatePicker field={field} presets={false} isEnabled />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="scheduledTime"
            render={({ field }) => (
              <FormItem className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {t("common.pickTime")}
                </span>
                <TimePicker field={field} />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="deadlineDate"
          render={({ field }) => (
            <FormItem className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {t("jobs.stepDeadlineAt")}
              </span>
              <DatePicker field={field} presets={false} isEnabled />
            </FormItem>
          )}
        />
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={isPending}
          data-testid="quick-add-submit"
        >
          <Plus className="mr-1 h-4 w-4" />
          {t("jobs.quickAddStep")}
          {isPending && <Loader className="ml-2 h-4 w-4 shrink-0 spinner" />}
        </Button>
      </fieldset>
    </Form>
  );
}
