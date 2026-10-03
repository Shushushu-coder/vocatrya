"use client";

import type { AgentGetJobResult, AgentListJobsResult } from "@/models/agent.model";
import { useI18n } from "@/i18n";

export function ListJobsResult({ output }: { output: AgentListJobsResult }) {
  const { t, formatNumber } = useI18n();
  if (output.status === "unavailable") {
    return <p className="text-sm">{t("agent.jobsUnavailable", { reason: output.reason })}</p>;
  }
  return (
    <div className="text-sm">
      <p>
        {output.truncated
          ? t("agent.listedJobsTruncated", { count: formatNumber(output.total) })
          : t("agent.listedJobs", { count: formatNumber(output.total) })}
      </p>
      {output.jobs.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {output.jobs.map((job) => (
            <li key={job.id}>
              {[job.title, job.company, job.status].filter(Boolean).join(" · ") || job.id}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function GetJobResult({ output }: { output: AgentGetJobResult }) {
  const { t } = useI18n();
  if (output.status === "unavailable") {
    return <p className="text-sm">{t("agent.jobsUnavailable", { reason: output.reason })}</p>;
  }
  if (output.status === "no_job") {
    return <p className="text-sm">{t("agent.noJobOpen")}</p>;
  }
  const company = output.job.company ? t("agent.atCompany", { company: output.job.company }) : "";
  return (
    <div className="text-sm">
      <p>{t("agent.readJob", { title: output.job.title || t("agent.fallbackJob"), company })}</p>
      {output.job.status ? (
        <p className="mt-1 text-xs text-muted-foreground">{output.job.status}</p>
      ) : null}
    </div>
  );
}
