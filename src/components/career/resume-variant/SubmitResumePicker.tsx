"use client";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { listSubmittableResumeVersions } from "@/actions/resumeVariant.actions";
import { submitAttemptResumeVersion } from "@/actions/application.actions";
import { toastError, toastSuccess } from "@/lib/toast";
import { useI18n } from "@/i18n";

type VersionOption = {
  id: string;
  versionNumber: number;
  status: string;
};

type VariantOption = {
  id: string;
  name: string;
  versions: VersionOption[];
};

type SubmitResumePickerProps = {
  attemptId: string;
  locked: boolean;
  onBound: () => Promise<void> | void;
};

function statusKey(status: string): string {
  if (status === "FROZEN") return "resumeVariants.statusFrozen";
  if (status === "SUBMITTED") return "resumeVariants.statusSubmitted";
  if (status === "ARCHIVED") return "resumeVariants.statusArchived";
  return "resumeVariants.statusDraft";
}

export function SubmitResumePicker({
  attemptId,
  locked,
  onBound,
}: SubmitResumePickerProps) {
  const { t } = useI18n();
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const [variantId, setVariantId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (locked) return;
    void listSubmittableResumeVersions().then((result) => {
      if (result.success) {
        setVariants((result.data as VariantOption[]) ?? []);
      }
    });
  }, [locked]);

  if (locked) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        {t("jobs.submitResumeLocked")}
      </p>
    );
  }

  const selected = variants.find((variant) => variant.id === variantId);
  const versions = selected?.versions ?? [];
  const selectedVersion = versions.find((version) => version.id === versionId);

  const onSubmit = () => {
    if (!versionId) return;
    startTransition(async () => {
      const result = await submitAttemptResumeVersion({
        attemptId,
        submittedResumeVersionId: versionId,
      });
      if (!result.success) {
        toastError(result.message);
        return;
      }
      toastSuccess(t("jobs.submitResumeSuccess"));
      await onBound();
    });
  };

  if (variants.length === 0) {
    return (
      <div className="mt-3 space-y-2" data-testid="submit-resume-picker-empty">
        <p className="text-sm font-medium">{t("jobs.bindSubmittedResume")}</p>
        <p className="text-sm text-muted-foreground">
          {t("jobs.submitResumeEmptyVariants")}
        </p>
        <Button size="sm" variant="outline" asChild>
          <Link href="/dashboard/profile/resumes">
            {t("jobs.submitResumeCreateLink")}
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2" data-testid="submit-resume-picker">
      <p className="text-sm font-medium">{t("jobs.bindSubmittedResume")}</p>
      <div className="flex flex-wrap gap-2">
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={variantId}
          onChange={(event) => {
            setVariantId(event.target.value);
            setVersionId("");
          }}
          aria-label={t("jobs.selectResumeVariant")}
        >
          <option value="">{t("jobs.selectResumeVariant")}</option>
          {variants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variant.name}
            </option>
          ))}
        </select>
        {selected && versions.length === 0 ? (
          <div data-testid="submit-resume-picker-no-versions">
            <p className="text-sm text-muted-foreground">
              {t("jobs.submitResumeEmptyVersions")}
            </p>
            <Button size="sm" variant="outline" asChild>
              <Link href={`/dashboard/profile/resumes/${selected.id}`}>
                {t("jobs.submitResumeOpenLink")}
              </Link>
            </Button>
          </div>
        ) : (
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={versionId}
            onChange={(event) => setVersionId(event.target.value)}
            disabled={!selected}
            aria-label={t("jobs.selectResumeVersion")}
          >
            <option value="">{t("jobs.selectResumeVersion")}</option>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {t("resumeVariants.versionNumber", { number: version.versionNumber })}
                {" · "}
                {t(statusKey(version.status))}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" onClick={onSubmit} disabled={!versionId || pending}>
          {t("jobs.submitResumeBind")}
        </Button>
      </div>
      {selectedVersion?.status === "DRAFT" ? (
        <p
          className="text-sm text-amber-700"
          data-testid="submit-draft-lock-warning"
        >
          {t("jobs.submitDraftLockWarning")}
        </p>
      ) : null}
    </div>
  );
}
