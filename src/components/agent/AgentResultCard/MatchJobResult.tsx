"use client";

import { AgentMatchContent } from "@/components/agent/AgentMatchContent";
import { NoResumesNotice } from "@/components/agent/AgentResultCard/NoResumesNotice";
import { ResumeSelectionPrompt } from "@/components/agent/AgentResultCard/ResumeSelectionPrompt";
import { Badge } from "@/components/ui/badge";
import {
  errorMessageKey,
  verdictLabel,
  verdictVariant,
} from "@/components/myjobs/job-details/MatchAnalysisPanel";
import type {
  AgentCanonicalMatchJobResult,
  AgentMatchJobResult,
} from "@/models/agent.model";
import { useI18n } from "@/i18n";

type OkCanonical = Extract<AgentCanonicalMatchJobResult, { status: "ok" }>;

const CANONICAL_SECTION_KEYS = [
  { key: "reasons", label: "matchAnalysis.sections.reasons" },
  { key: "hardRequirements", label: "matchAnalysis.sections.hardRequirements" },
  { key: "coreMatch", label: "matchAnalysis.sections.coreMatch" },
  {
    key: "preferenceMatch",
    label: "matchAnalysis.sections.preferenceMatch",
  },
] as const;

function CanonicalMatchJobResult({ output }: { output: OkCanonical }) {
  const { t } = useI18n();
  const sourceLabel =
    output.source.kind === "career-profile"
      ? t("matchAnalysis.sourceCareerProfile")
      : `${output.source.resumeTitle} · v${output.source.versionNumber}`;
  return (
    <div className="text-sm">
      <div className="flex items-center gap-2">
        <Badge {...verdictVariant(output.verdict)}>
          {verdictLabel(output.verdict, t)}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {t("matchAnalysis.sourceLabel")}: {sourceLabel}
        </span>
      </div>
      <div className="mt-2 space-y-2">
        {CANONICAL_SECTION_KEYS.map(({ key, label }) => {
          const text = output[key];
          if (!text) return null;
          return (
            <div key={key}>
              <p className="text-xs font-medium text-muted-foreground">
                {t(label)}
              </p>
              <p className="whitespace-pre-wrap">{text}</p>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t("agent.matchSavedToHistory", {
          jobTitle: output.jobTitle,
          company: output.company,
        })}
        {output.provider || output.model
          ? ` · ${t("matchAnalysis.ranWith", {
              provider: output.provider ?? "",
              model: output.model ?? "",
            })}`
          : ""}
      </p>
    </div>
  );
}

// The score and body come from the tool output, not from parsed prose — the
// match is a server-side generation, so the card cannot disagree with what
// was saved. The canonical (fresh-native/full) tool returns a FAST_SCREENING
// verdict instead of a legacy score; `analysisId` is what tells them apart.
export function MatchJobResult({
  output,
}: {
  output: AgentMatchJobResult | AgentCanonicalMatchJobResult;
}) {
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

  // Canonical failure unions: unavailable is a broken/absent setup, failed is
  // a retryable run outcome — both render through the shared match error map.
  if (output.status === "unavailable" || output.status === "failed") {
    return (
      <p className="text-sm">{t(errorMessageKey(output.code), { code: output.code })}</p>
    );
  }

  if ("analysisId" in output) {
    return <CanonicalMatchJobResult output={output} />;
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
