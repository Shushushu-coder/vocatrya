"use client";

import { NoResumesNotice } from "@/components/agent/AgentResultCard/NoResumesNotice";
import { ResumeSelectionPrompt } from "@/components/agent/AgentResultCard/ResumeSelectionPrompt";
import type { AgentGetResumeResult } from "@/models/agent.model";
import { useI18n } from "@/i18n";

// The resume text itself is never rendered: the user is about to read the
// review, not the serialization, and the card would be a wall of text.
export function GetResumeResult({ output }: { output: AgentGetResumeResult }) {
  const { t, formatNumber } = useI18n();
  if (output.status === "unavailable") {
    return <p className="text-sm">{t("agent.jobsUnavailable", { reason: output.reason })}</p>;
  }

  if (output.status === "no_resumes") {
    return <NoResumesNotice />;
  }

  if (output.status === "unreadable") {
    return (
      <p className="text-sm">
        {t("agent.couldntRead", { title: output.title, reason: output.reason })}
      </p>
    );
  }

  if (output.status === "needs_selection") {
    return (
      <ResumeSelectionPrompt
        prompt={t("agent.whichResume")}
        resumes={output.resumes}
      />
    );
  }

  const sourceNote =
    output.source === "default"
      ? t("agent.defaultResumeNote")
      : output.source === "page"
        ? t("agent.viewingResumeNote")
        : "";

  return (
    <div className="text-sm">
      <p>{t("agent.readResume", { title: output.title, source: sourceNote })}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("agent.charsMeta", { chars: formatNumber(output.chars) })}
        {output.truncated ? t("agent.truncatedSuffix") : ""}
        {output.ambiguousTitle ? t("agent.ambiguousTitleSuffix") : ""}
      </p>
    </div>
  );
}
