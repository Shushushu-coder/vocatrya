"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n";
import { createInterviewSessionAction } from "@/actions/interview.actions";
import { toastError } from "@/lib/toast";

type Props = {
  presets: Array<{
    questionId: string;
    promptText: string;
    title: string;
    displayOrder: number;
  }>;
  questions: Array<{ id: string; promptText: string }>;
  jobs: Array<{
    id: string;
    title: string;
    jdVersions: Array<{ id: string; versionNumber: number }>;
  }>;
};

export default function NewInterviewForm({ presets, questions, jobs }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const [jobId, setJobId] = useState("");
  const [jdId, setJdId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const jds = useMemo(
    () => jobs.find((job) => job.id === jobId)?.jdVersions ?? [],
    [jobs, jobId],
  );

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const onCreate = async () => {
    if (!selected.length) {
      toastError(t("interview.selectQuestionHint"));
      return;
    }
    if ((jobId && !jdId) || (!jobId && jdId)) {
      toastError(t("interview.optionalJob"));
      return;
    }
    setSaving(true);
    try {
      const result = await createInterviewSessionAction({
        questionIds: selected,
        jobOpportunityId: jobId || null,
        jobDescriptionVersionId: jdId || null,
      });
      if (!result.success || !("data" in result)) {
        toastError(result.message);
        return;
      }
      router.push(`/dashboard/interview/${result.data.session.id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label>{t("interview.optionalJob")}</Label>
        <select
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={jobId}
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
        {jobId ? (
          <select
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={jdId}
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
      </div>
      <div className="space-y-2">
        <Label>{t("interview.presets")}</Label>
        <ul className="space-y-2">
          {presets.map((item) => (
            <li key={item.questionId}>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(item.questionId)}
                  onChange={() => toggle(item.questionId)}
                />
                <span>{item.promptText}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-2">
        <Label>{t("interview.myQuestions")}</Label>
        <ul className="space-y-2">
          {questions.map((item) => (
            <li key={item.id}>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <span>{item.promptText}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      <Button onClick={() => void onCreate()} disabled={saving}>
        {t("interview.createSession")}
      </Button>
    </div>
  );
}
