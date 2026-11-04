"use client";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { JobConnectionsDTO } from "@/lib/career/applicationTimeline";
import { useI18n } from "@/i18n";
import type { Locale } from "@/i18n";

// INT-01 owns the shared message bundles; until the declared keys land,
// t() echoes the key and the paired fallback keeps the page readable.
function useCopy() {
  const { t, locale } = useI18n();
  return (
    key: string,
    fallback: Record<Locale, string>,
    params?: Record<string, string | number>,
  ) => {
    const translated = t(key, params);
    if (translated !== key) return translated;
    const template = fallback[locale];
    return params
      ? template.replace(/\{(\w+)\}/g, (raw, name: string) =>
          name in params ? String(params[name]) : raw,
        )
      : template;
  };
}

const VERSION_STATUS_KEYS: Record<string, string> = {
  DRAFT: "resumeVariants.statusDraft",
  FROZEN: "resumeVariants.statusFrozen",
  SUBMITTED: "resumeVariants.statusSubmitted",
  ARCHIVED: "resumeVariants.statusArchived",
};

/**
 * P-B JOB-CONNECTIONS job-level summary: which resume variants are planned
 * for this job (mutable binding) and how many practice sessions it has —
 * the two halves of the "planned vs actual" comparison that sit above the
 * per-attempt immutable submission facts. Read-only in every mode,
 * including archived jobs.
 */
export function JobConnectionsSummary({
  connections,
}: {
  connections: JobConnectionsDTO;
}) {
  const { t } = useI18n();
  const copy = useCopy();
  const { plannedResumeVariants, practiceSessions } = connections;

  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      data-testid="job-connections-summary"
    >
      <div>
        <p className="text-sm font-medium">
          {copy("jobs.plannedResumes", {
            "zh-CN": "计划简历",
            en: "Planned resumes",
          })}
        </p>
        {plannedResumeVariants.length === 0 ? (
          <p
            className="mt-1 text-sm text-muted-foreground"
            data-testid="planned-resumes-empty"
          >
            {copy("jobs.plannedResumesNone", {
              "zh-CN": "尚未为本职位绑定计划简历。",
              en: "No resume planned for this job yet.",
            })}
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {plannedResumeVariants.map((variant) => (
              <li
                key={variant.id}
                className="text-sm"
                data-testid="planned-resume-variant"
              >
                <Link
                  className="text-primary underline"
                  href={`/dashboard/profile/resumes/${variant.id}`}
                >
                  {variant.name}
                </Link>
                {variant.currentVersion ? (
                  <span className="text-muted-foreground">
                    {" · "}
                    {t("resumeVariants.currentVersion")}
                    {" "}
                    {t("resumeVariants.versionNumber", {
                      number: variant.currentVersion.versionNumber,
                    })}
                    {" · "}
                    {VERSION_STATUS_KEYS[variant.currentVersion.status]
                      ? t(VERSION_STATUS_KEYS[variant.currentVersion.status])
                      : variant.currentVersion.status}
                  </span>
                ) : null}
                {variant.archivedAt ? (
                  <Badge variant="outline" className="ml-2">
                    {t("resumeVariants.archived")}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="text-sm font-medium">
          {copy("jobs.practiceSessions", {
            "zh-CN": "练习会话",
            en: "Practice sessions",
          })}
        </p>
        <p className="mt-1 text-sm" data-testid="practice-sessions-count">
          {practiceSessions.total === 0
            ? copy("jobs.practiceSessionsNone", {
                "zh-CN": "本职位暂无练习会话。",
                en: "No practice sessions for this job yet.",
              })
            : copy(
                "jobs.practiceSessionsCount",
                {
                  "zh-CN": "{count} 次练习会话",
                  en: "{count} practice session(s)",
                },
                { count: practiceSessions.total },
              )}
        </p>
        {practiceSessions.byJdVersion.length > 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="practice-sessions-by-jd"
          >
            {practiceSessions.byJdVersion
              .map((entry) =>
                copy(
                  "jobs.practiceSessionsJdCount",
                  {
                    "zh-CN": "JD v{version}：{count} 次",
                    en: "JD v{version}: {count}",
                  },
                  { version: entry.versionNumber, count: entry.count },
                ),
              )
              .join(" · ")}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {copy("jobs.practiceSessionsNote", {
            "zh-CN": "模拟练习会话计数；真实面试轮次见下方流程步骤。",
            en: "Mock practice sessions linked to this job; real interview rounds are the INTERVIEW steps below.",
          })}
        </p>
      </div>
    </section>
  );
}
