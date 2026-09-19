"use client";
import { useCallback, useEffect, useState } from "react";
import { getSubmittedResumeBindings } from "@/actions/application.actions";
import { SubmittedResumePanel } from "@/components/career/resume-variant/SubmittedResumePanel";
import type { SubmittedResumeBindingsDTO } from "@/lib/career/applicationTimeline";
import { toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";

type ApplicationResumeBindingPanelProps = {
  jobId: string;
  refreshKey: number;
};

export function ApplicationResumeBindingPanel({
  jobId,
  refreshKey,
}: ApplicationResumeBindingPanelProps) {
  const { t, formatDateTime } = useI18n();
  const [bindings, setBindings] = useState<SubmittedResumeBindingsDTO | null>(
    null,
  );

  const loadBindings = useCallback(async () => {
    const result = await getSubmittedResumeBindings(jobId);
    if (result.success) {
      setBindings(result.data ?? { opportunityId: null, attempts: [] });
    } else {
      toastError(result.message);
      setBindings({ opportunityId: null, attempts: [] });
    }
  }, [jobId]);

  useEffect(() => {
    void loadBindings();
  }, [loadBindings, refreshKey]);

  if (!bindings) {
    return (
      <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
    );
  }

  if (bindings.attempts.length === 0) {
    return (
      <div>
        <p className="text-sm font-medium">{t("jobs.submittedResume")}</p>
        <p
          className="mt-2 text-sm text-muted-foreground"
          data-testid="restricted-submitted-resume-no-attempt"
        >
          {t("jobs.submittedResumeNoAttempt")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{t("jobs.submittedResume")}</p>
      {bindings.attempts.map((attempt) => (
        <section
          key={attempt.id}
          className="rounded-lg border p-4"
          data-testid="restricted-submitted-resume-attempt"
          data-attempt-id={attempt.id}
        >
          <p
            className="text-sm text-muted-foreground"
            data-testid="restricted-attempt-heading"
          >
            {t("jobs.attemptChannel")}
            {": "}
            {attempt.channelLabel}
            {" · "}
            {t("jobs.attemptCreatedAt")}
            {": "}
            {formatDateTime(attempt.createdAt)}
            {attempt.submittedAt ? (
              <>
                {" · "}
                {t("jobs.attemptSubmittedAt")}
                {": "}
                {formatDateTime(attempt.submittedAt)}
              </>
            ) : null}
          </p>
          <SubmittedResumePanel
            attemptId={attempt.id}
            submittedResume={attempt.submittedResume}
            canMutate
            onBound={loadBindings}
          />
        </section>
      ))}
    </div>
  );
}
