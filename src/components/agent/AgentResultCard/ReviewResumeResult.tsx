"use client";

import { AgentReviewContent } from "@/components/agent/AgentReviewContent";
import { NoResumesNotice } from "@/components/agent/AgentResultCard/NoResumesNotice";
import { ResumeSelectionPrompt } from "@/components/agent/AgentResultCard/ResumeSelectionPrompt";
import type { AgentReviewResumeResult } from "@/models/agent.model";
import { useI18n } from "@/i18n";

// The scores and body come from the tool output, not from parsed prose — the
// review is a server-side generation now, so the card cannot disagree with
// what was saved.
export function ReviewResumeResult({ output }: { output: AgentReviewResumeResult }) {
  const { t } = useI18n();
  if (output.status === "no_resumes") {
    return <NoResumesNotice />;
  }

  if (output.status === "needs_selection") {
    return (
      <ResumeSelectionPrompt
        prompt={t("agent.whichResume")}
        resumes={output.resumes}
      />
    );
  }

  if (output.status === "unreadable" || output.status === "generation_failed") {
    return (
      <p className="text-sm">
        {t("agent.couldntReview", { title: output.title, reason: output.reason })}
      </p>
    );
  }

  return (
    <div className="text-sm">
      <AgentReviewContent body={output.body} scores={output.scores} />
      {!output.saved && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("agent.reviewNotSaved", { error: output.saveError ?? "" })}
        </p>
      )}
    </div>
  );
}
