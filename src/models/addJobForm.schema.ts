import { z } from "zod";
import { APP_CONSTANTS } from "@/lib/constants";
import { translate } from "@/i18n/translate";

// User-facing validation text must follow the active locale, so the schema is
// built per render with the component's `t`. The English instance below stays
// exported for non-React callers that only need the inferred type.
export function createAddJobFormSchema(t: (key: string) => string) {
  return z.object({
    id: z.string().optional(),
    userId: z.string().optional(),
    title: z
      .string({
        error: t("jobs.validation.jobTitleRequired"),
      })
      .min(2, {
        message: t("jobs.validation.jobTitleMin"),
      }),
    company: z
      .string({
        error: t("jobs.validation.companyRequired"),
      })
      .min(2, {
        message: t("jobs.validation.companyMin"),
      }),
    location: z
      .string({
        error: t("jobs.validation.locationRequired"),
      })
      .min(2, {
        message: t("jobs.validation.locationMin"),
      }),
    type: z.string().min(1),
    workplaceType: z.string().optional(),
    source: z
      .string({
        error: t("jobs.validation.sourceRequired"),
      })
      .min(2, {
        message: t("jobs.validation.sourceMin"),
      }),
    status: z
      .string({
        error: t("jobs.validation.statusRequired"),
      })
      .min(2, {
        message: t("jobs.validation.statusMin"),
      }),
    dueDate: z.date().optional().nullable(),
    recruitmentCohort: z.string().optional().nullable(),
    recruitmentBatch: z.string().optional().nullable(),
    /**
     * Note: Timezone offsets can be allowed by setting the offset option to true.
     * z.string().datetime({ offset: true });
     */
    //
    dateApplied: z.date().optional(),
    salaryRange: z
      .string()
      .max(APP_CONSTANTS.MAX_SALARY_RANGE_LENGTH, {
        message: t("jobs.validation.salaryMax"),
      })
      .optional(),
    jobDescription: z
      .string({
        error: t("jobs.validation.descriptionRequired"),
      })
      .refine((val) => val === "N/A" || val.length >= 10, {
        message: t("jobs.validation.descriptionMin"),
      }),
    jobUrl: z.string().optional(),
    applied: z.boolean().default(false),
    resume: z.string().optional(),
    coverLetter: z.string().optional(),
    tags: z
      .array(z.string())
      .max(APP_CONSTANTS.MAX_JOB_TAGS)
      .optional()
      .default([]),
  });
}

export const AddJobFormSchema = createAddJobFormSchema((key) =>
  translate("en", key),
);

export type AddJobFormValues = z.infer<typeof AddJobFormSchema>;
