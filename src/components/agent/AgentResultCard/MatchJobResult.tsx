"use client";

import { AgentMatchContent } from "@/components/agent/AgentMatchContent";
import { NoResumesNotice } from "@/components/agent/AgentResultCard/NoResumesNotice";
import { ResumeSelectionPrompt } from "@/components/agent/AgentResultCard/ResumeSelectionPrompt";
import type { AgentMatchJobResult } from "@/models/agent.model";
import { useI18n } from "@/i18n";

// The score and body come from the tool output, not from parsed prose — the
// match is a server-side generation, so the card cannot disagree with what
// was saved.
export function MatchJobResult({ output }: { output: AgentMatchJobResult }) {
  const { t } = useI18n();
  if (output.status === "no_job") {
    return <p className="text-sm">{t("agent.openJobToMatch")}</p>;
  }

  if (output.status === "no_resumes") {
    return <NoResumesNotice />;
  }

  if (output.status === "needs_selection") {
    return (
      <ResumeSelectionPrompt
        prompt={t("agent.whichResumeMatch")}
        resumes={output.resumes}
        messageFor={(title) => t("agent.matchAgainstResume", { title })}
      />
    );
  }

  if (output.status === "unreadable") {
    return (
      <p className="text-sm">
        {t("agent.couldntRead", { title: output.title, reason: output.reason })}
      </p>
    );
  }

  if (output.status === "generation_failed") {
    return (
      <p className="text-sm">
        {t("agent.couldntMatch", {
          title: output.jobTitle,
          reason: output.reason,
        })}
      </p>
    );
  }

  return (
    <div className="text-sm">
      <AgentMatchContent body={output.body} scores={output.scores} />
      <p className="mt-2 text-xs text-muted-foreground">
        {t("agent.matchedAgainst", {
          jobTitle: output.jobTitle,
          company: output.company ? t("agent.atCompany", { company: output.company }) : "",
          resumeTitle: output.resumeTitle,
        })}
      </p>
      {!output.saved && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("agent.matchNotSaved", { error: output.saveError ?? "" })}
        </p>
      )}
    </div>
  );
}
