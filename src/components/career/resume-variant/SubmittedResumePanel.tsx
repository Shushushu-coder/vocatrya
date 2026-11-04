"use client";
import Link from "next/link";
import { SubmitResumePicker } from "@/components/career/resume-variant/SubmitResumePicker";
import type {
  SubmittedArtifactDTO,
  SubmittedJdVersionDTO,
  SubmittedResumeDTO,
} from "@/lib/career/applicationTimeline";
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

/**
 * P-B JOB-CONNECTIONS: the rest of an attempt's immutable submission facts
 * (artifact + submitted-against JD version) alongside the resume version.
 * `undefined` means the surface does not load them — nothing renders, so the
 * restricted binding panel keeps its previous shape. Once provided, bound
 * fields show their summary and missing ones get a neutral N/A; `submitted`
 * (attempt.submittedAt set) forces the block visible even when every fact is
 * unbound, so a real submission with no recorded materials is never silent.
 */
export type SubmittedMaterialFacts = {
  artifact: SubmittedArtifactDTO;
  submittedAgainstJdVersion: SubmittedJdVersionDTO;
  currentJdVersion: { id: string; versionNumber: number } | null;
  submitted: boolean;
};

type SubmittedResumePanelProps = {
  attemptId: string;
  submittedResume: SubmittedResumeDTO;
  submissionFacts?: SubmittedMaterialFacts;
  canMutate: boolean;
  onBound: () => Promise<void> | void;
};

export function SubmittedResumePanel({
  attemptId,
  submittedResume,
  submissionFacts,
  canMutate,
  onBound,
}: SubmittedResumePanelProps) {
  const { t, formatDateTime } = useI18n();
  const copy = useCopy();

  const showFacts = Boolean(
    submissionFacts &&
      (submissionFacts.submitted ||
        submittedResume ||
        submissionFacts.artifact ||
        submissionFacts.submittedAgainstJdVersion),
  );
  const factsBlock = showFacts && submissionFacts ? (
    <div
      className="mt-2 space-y-1 text-sm"
      data-testid="submitted-material-facts"
    >
      <p>
        <span className="text-muted-foreground">
          {copy("jobs.submittedArtifact", {
            "zh-CN": "投递文件",
            en: "Submitted file",
          })}
        </span>
        {"："}
        {submissionFacts.artifact ? (
          <>
            <span title={submissionFacts.artifact.sha256}>
              {submissionFacts.artifact.fileName}
            </span>
            {" · "}
            {submissionFacts.artifact.format}
            {" · "}
            <a
              className="text-primary underline"
              href={`/api/profile/resume-artifacts/${submissionFacts.artifact.id}`}
              data-testid="download-submitted-artifact"
            >
              {t("common.download")}
            </a>
          </>
        ) : (
          t("common.notAvailable")
        )}
      </p>
      <p>
        <span className="text-muted-foreground">
          {copy("jobs.submittedJdVersion", {
            "zh-CN": "投递时 JD",
            en: "JD at submission",
          })}
        </span>
        {"："}
        {submissionFacts.submittedAgainstJdVersion ? (
          <>
            {t("resumeVariants.versionNumber", {
              number: submissionFacts.submittedAgainstJdVersion.versionNumber,
            })}
            {" · "}
            {formatDateTime(submissionFacts.submittedAgainstJdVersion.capturedAt)}
            {submissionFacts.currentJdVersion &&
            submissionFacts.currentJdVersion.id !==
              submissionFacts.submittedAgainstJdVersion.id ? (
              <span className="text-muted-foreground">
                {" · "}
                {copy(
                  "jobs.currentJdVersionHint",
                  {
                    "zh-CN": "当前 JD 为 v{version}",
                    en: "current JD is v{version}",
                  },
                  {
                    version: submissionFacts.currentJdVersion.versionNumber,
                  },
                )}
              </span>
            ) : null}
          </>
        ) : (
          t("common.notAvailable")
        )}
      </p>
    </div>
  ) : null;

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
        {factsBlock}
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
      {factsBlock}
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
