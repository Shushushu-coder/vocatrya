"use client";
import { useId, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { Loader, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/DatePicker";
import {
  Form,
  FormField,
  FormItem,
} from "@/components/ui/form";
import { PROCESS_STEP_CATEGORY } from "@/lib/career/identities";
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
  scheduledAt: Date | null;
  deadlineAt: Date | null;
};

type QuickAddProcessStepProps = {
  onSubmit: (values: QuickAddStepValues) => Promise<boolean>;
};

type QuickAddDates = {
  scheduledAt: Date | null;
  deadlineAt: Date | null;
};

export function QuickAddProcessStep({ onSubmit }: QuickAddProcessStepProps) {
  const { t } = useI18n();
  const listId = useId();
  const [category, setCategory] = useState<string>(
    PROCESS_STEP_CATEGORY.INTERVIEW,
  );
  const [label, setLabel] = useState("");
  // DatePicker's FormControl needs a form context; only the two dates live in
  // this form — category and label stay plain controlled inputs.
  const form = useForm<QuickAddDates>({
    defaultValues: { scheduledAt: null, deadlineAt: null },
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
    const { scheduledAt, deadlineAt } = form.getValues();
    startTransition(async () => {
      const ok = await onSubmit({
        category,
        label: label.trim() || labelPresets(category)[0] || categoryLabel(category),
        scheduledAt,
        deadlineAt,
      });
      if (ok) {
        setLabel("");
        form.reset({ scheduledAt: null, deadlineAt: null });
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
        <FormField
          control={form.control}
          name="scheduledAt"
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
          name="deadlineAt"
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
