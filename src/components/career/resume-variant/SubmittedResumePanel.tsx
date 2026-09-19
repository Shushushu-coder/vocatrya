"use client";
import Link from "next/link";
import { SubmitResumePicker } from "@/components/career/resume-variant/SubmitResumePicker";
import type { SubmittedResumeDTO } from "@/lib/career/applicationTimeline";
import { useI18n } from "@/i18n";

type SubmittedResumePanelProps = {
  attemptId: string;
  submittedResume: SubmittedResumeDTO;
  canMutate: boolean;
  onBound: () => Promise<void> | void;
};

export function SubmittedResumePanel({
  attemptId,
  submittedResume,
  canMutate,
  onBound,
}: SubmittedResumePanelProps) {
  const { t } = useI18n();

  if (submittedResume) {
    return (
      <div className="mt-1" data-testid="submitted-resume-panel">
        <p className="font-medium">
          {submittedResume.title}
          {" · "}
          {t("jobs.resumeVersionNumber", {
            number: submittedResume.versionNumber,
          })}
        </p>
        {submittedResume.resumeVariantId &&
        submittedResume.resumeVariantVersionId ? (
          <Link
            className="mt-1 inline-block text-sm text-primary underline"
            href={`/dashboard/profile/resumes/${submittedResume.resumeVariantId}?version=${submittedResume.resumeVariantVersionId}`}
            data-testid="view-submitted-resume-version"
          >
            {t("jobs.viewSubmittedResumeVersion")}
          </Link>
        ) : null}
        {canMutate ? (
          <SubmitResumePicker attemptId={attemptId} locked onBound={onBound} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-1" data-testid="submitted-resume-panel">
      <p className="font-medium">{t("jobs.submittedResumeUnbound")}</p>
      <p className="text-sm text-muted-foreground">
        {t("jobs.submittedResumeUnboundHint")}
      </p>
      {canMutate ? (
        <SubmitResumePicker
          attemptId={attemptId}
          locked={false}
          onBound={onBound}
        />
      ) : null}
    </div>
  );
}
