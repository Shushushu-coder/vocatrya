"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n";
import { createInterviewSessionAction } from "@/actions/interview.actions";
import { toastError } from "@/lib/toast";

type Props = {
  jobs: Array<{
    id: string;
    title: string;
    jdVersions: Array<{ id: string; versionNumber: number }>;
  }>;
  /** Prep-goal deep link: the job/JD pair is fixed by the goal. */
  initialJobId?: string | null;
  initialJdId?: string | null;
  interviewPrepGoalId?: string | null;
};

export default function NewInterviewForm({
  jobs,
  initialJobId = null,
  initialJdId = null,
  interviewPrepGoalId = null,
}: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const [jobId, setJobId] = useState(initialJobId ?? "");
  const [jdId, setJdId] = useState(initialJdId ?? "");
  const [saving, setSaving] = useState(false);
  const goalBound = Boolean(interviewPrepGoalId);

  const jds = useMemo(
    () => jobs.find((job) => job.id === jobId)?.jdVersions ?? [],
    [jobs, jobId],
  );

  const onCreate = async () => {
    // A job with exactly one JD version binds it implicitly; several
    // versions require a choice (job+JD stay a frozen pair).
    let resolvedJdId = jdId;
    if (jobId && !resolvedJdId) {
      if (jds.length === 1) {
        resolvedJdId = jds[0].id;
      } else if (jds.length > 1) {
        toastError(t("interview.selectJd"));
        return;
      } else {
        toastError(t("interview.jobNeedsJd"));
        return;
      }
    }
    setSaving(true);
    try {
      const result = await createInterviewSessionAction({
        jobOpportunityId: jobId || null,
        jobDescriptionVersionId: resolvedJdId || null,
        interviewPrepGoalId,
      });
      if (!result.success || !("data" in result)) {
        toastError(result.message);
        return;
      }
      const base = goalBound ? "/dashboard/interview-prep" : "/dashboard/interview";
      router.push(`${base}/${result.data.session.id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-2">
        <Label htmlFor="interview-job">{t("interview.optionalJob")}</Label>
        <select
          id="interview-job"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={jobId}
          disabled={goalBound}
          onChange={(event) => {
            setJobId(event.target.value);
            setJdId("");
          }}
        >
          <option value="">{t("interview.noJob")}</option>
          {jobs.map((job) => (
            <option key={job.id} value={job.id}>
              {job.title}
            </option>
          ))}
        </select>
        {jobId && (jds.length > 1 || goalBound) ? (
          <select
            aria-label={t("interview.selectJd")}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={jdId}
            disabled={goalBound}
            onChange={(event) => setJdId(event.target.value)}
          >
            <option value="">{t("interview.selectJd")}</option>
            {jds.map((jd) => (
              <option key={jd.id} value={jd.id}>
                v{jd.versionNumber}
              </option>
            ))}
          </select>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {t("interview.jobBindingHint")}
        </p>
      </div>
      <Button onClick={() => void onCreate()} disabled={saving}>
        {saving ? t("interview.creating") : t("interview.startInterviewCta")}
      </Button>
    </div>
  );
}
