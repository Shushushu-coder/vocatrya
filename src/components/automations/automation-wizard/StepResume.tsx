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
import type { WizardResume } from "./wizardConfig";
import { useI18n } from "@/i18n";

export function StepResume({
  form,
  resumes,
}: {
  form: UseFormReturn<CreateAutomationInput>;
  resumes: WizardResume[];
}) {
  const { t } = useI18n();
  return (
    <>
      <FormField
        control={form.control}
        name="resumeId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("automations.resumeForMatching")}</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder={t("automations.selectResume")} />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {resumes.map((resume) => (
                  <SelectItem key={resume.id} value={resume.id}>
                    {resume.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription>
              {t("automations.resumeDescription")}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      {resumes.length === 0 && (
        <p className="text-sm text-orange-600 dark:text-orange-500">
          {t("automations.noResumesForMatching")}
        </p>
      )}
    </>
  );
}
