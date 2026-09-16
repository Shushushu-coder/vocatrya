"use client";

import type { UseFormReturn } from "react-hook-form";
import { Slider } from "@/components/ui/slider";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import type { CreateAutomationInput } from "@/models/automation.schema";
import { useI18n } from "@/i18n";

export function StepMatching({
  form,
}: {
  form: UseFormReturn<CreateAutomationInput>;
}) {
  const { t } = useI18n();
  return (
    <FormField
      control={form.control}
      name="matchThreshold"
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            {t("automations.matchThreshold", { value: field.value })}
          </FormLabel>
          <FormControl>
            <Slider
              min={0}
              max={100}
              step={5}
              value={[field.value]}
              onValueChange={(value) => field.onChange(value[0])}
            />
          </FormControl>
          <FormDescription>
            {t("automations.matchThresholdDescription")}
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
