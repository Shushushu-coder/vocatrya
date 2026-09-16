"use client";

import type { UseFormReturn } from "react-hook-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import type { CreateAutomationInput } from "@/models/automation.schema";
import { HOURS } from "./wizardConfig";
import { useI18n } from "@/i18n";

export function StepSchedule({
  form,
  takenHours,
}: {
  form: UseFormReturn<CreateAutomationInput>;
  takenHours: Set<number>;
}) {
  const { t } = useI18n();
  return (
    <FormField
      control={form.control}
      name="scheduleHour"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t("automations.dailyRunTime")}</FormLabel>
          <Select
            onValueChange={(val) => {
              field.onChange(parseInt(val));
              form.clearErrors("scheduleHour");
            }}
            value={field.value.toString()}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder={t("automations.selectTime")} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {HOURS.map((hour) => (
                <SelectItem key={hour.value} value={hour.value.toString()}>
                  {hour.label}
                  {takenHours.has(hour.value) && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t("automations.inUse")}
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormDescription>
            {t("automations.scheduleDescription")}
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
