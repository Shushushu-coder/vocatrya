"use client";

import type { UseFormReturn } from "react-hook-form";
import { Input } from "@/components/ui/input";
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
import { useI18n } from "@/i18n";

export function StepBasics({
  form,
}: {
  form: UseFormReturn<CreateAutomationInput>;
}) {
  const { t } = useI18n();
  return (
    <>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("automations.automationName")}</FormLabel>
            <FormControl>
              <Input placeholder={t("automations.namePlaceholder")} {...field} />
            </FormControl>
            <FormDescription>
              {t("automations.nameDescription")}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="jobBoard"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("automations.jobBoard")}</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder={t("automations.selectJobBoard")} />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="greenhouse">
                  {t("automations.boards.greenhouse")}
                </SelectItem>
                <SelectItem value="lever">{t("automations.boards.lever")}</SelectItem>
                <SelectItem value="ashby">{t("automations.boards.ashby")}</SelectItem>
              </SelectContent>
            </Select>
            <FormDescription>
              {t("automations.jobBoardDescription")}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}
