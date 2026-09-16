"use client";

import Link from "next/link";
import { AgentMarkdown } from "@/components/agent/AgentMarkdown";
import { NoResumesNotice } from "@/components/agent/AgentResultCard/NoResumesNotice";
import { ResumeSelectionPrompt } from "@/components/agent/AgentResultCard/ResumeSelectionPrompt";
import type { AgentCoverLetterResult } from "@/models/agent.model";
import { useI18n } from "@/i18n";

// The letter comes from the tool output, not from the streamed text: the
// stream is a progress indicator and the output is what was saved.
export function CoverLetterResult({ output }: { output: AgentCoverLetterResult }) {
  const { t } = useI18n();
  if (output.status === "no_job") {
    return <p className="text-sm">{t("agent.openJobForLetter")}</p>;
  }

  if (output.status === "no_description") {
    return (
      <p className="text-sm">
        {t("agent.noRealDescription", { title: output.jobTitle })}
      </p>
    );
  }

  if (output.status === "no_resumes") {
    return <NoResumesNotice />;
  }

  if (output.status === "needs_selection") {
    return (
      <ResumeSelectionPrompt
        prompt={t("agent.whichResumeLetter")}
        resumes={output.resumes}
        messageFor={(title) => t("agent.letterUsingResume", { title })}
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
        {t("agent.couldntWriteLetter", {
          title: output.jobTitle,
          reason: output.reason,
        })}
      </p>
    );
  }

  return (
    <div className="text-sm">
      <AgentMarkdown text={output.body} />
      <p className="mt-2 text-xs text-muted-foreground">
        {t("agent.drawnFrom", {
          jobTitle: output.jobTitle,
          company: output.company ? t("agent.atCompany", { company: output.company }) : "",
          resumeTitle: output.resumeTitle,
        })}
      </p>
      {output.saved ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("agent.savedAsLetter", { title: output.coverLetterTitle ?? "" })}
          <Link href="/dashboard/profile" className="underline">
            {t("agent.editInProfileDocuments")}
          </Link>
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("agent.letterNotSaved", { error: output.saveError ?? "" })}
        </p>
      )}
    </div>
  );
}
