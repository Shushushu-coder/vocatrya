"use client";

import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import {
  AGENT_ROLE_KEYS,
  AGENT_ROSTER_LEGEND_KEY,
  copyFor,
} from "@/lib/agent/roleCopy";
import { AGENT_ROLES } from "@/lib/agent/agentRoles";
import { AgentRoleAvatar } from "@/components/agent/AgentRoleAvatar";
import { suggestionsForRole } from "@/lib/agent/roleSuggestions";
import { useI18n } from "@/i18n";
import { useState } from "react";
import { BriefcaseBusiness, FileText, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResumeEvidenceStartDialog } from "./ResumeEvidenceStartDialog";
import { EmptyStateAgentPresence } from "./EmptyStateAgentPresence";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import type { VocatryaMotionState } from "@/components/brand/VocatryaMark";
import styles from "./empty-state.module.css";

export function AgentChatEmptyState({ state = "idle" }: { state?: VocatryaMotionState }) {
  const { t, locale } = useI18n();
  const { freshNativeFull } = useCareerSurfaces();
  const { fillComposer, context, requestAddContext } =
    useAgentChat();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  // Unified chat surfaces Resume Evidence directly from the single empty state.
  const isPilot = true;
  const copy = copyFor(t, locale);
  const items = context?.items ?? [];
  const job = items.find((item) => item.kind === "job");
  const resume = items.find((item) => item.kind === "resume");

  // Four static starter prompts covering Pilot/Insight/Reflect capabilities.
  // Clicking only fills the composer (D8): no /api/ai/chat request or model call.
  const suggestions = [
    suggestionsForRole("pilot", { freshNativeFull })[0],
    suggestionsForRole("insight", { freshNativeFull })[0],
    suggestionsForRole("insight", { freshNativeFull })[1],
    suggestionsForRole("reflect", { freshNativeFull })[0],
  ];

  return (
    <div data-testid="agent-empty-state" className={`${styles.container} flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-4 text-center`}>
      <EmptyStateAgentPresence state={state} />
      <p className="text-sm font-medium text-foreground">
        {job
          ? job.labelSnapshot
          : resume
            ? resume.labelSnapshot
            : t("agent.emptyStart")}
      </p>
      <div data-testid="agent-empty-self" className="grid max-w-md gap-1 text-sm text-muted-foreground">
        <p>{copy("agent.roster.unifiedLead")}</p>
        <p>{copy("agent.roster.unifiedHandoff")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground">
        {AGENT_ROLES.map((role) => (
          <span key={role} className="inline-flex items-center gap-1.5">
            <AgentRoleAvatar role={role} size={20} />
            <span className="font-medium text-foreground">
              {copy(AGENT_ROLE_KEYS.name[role])}
            </span>
          </span>
        ))}
      </div>
      <Suggestions className={`${styles.actions} w-full`}>
        {suggestions.map((item) => (
          <Suggestion
            key={item.label}
            onClick={() => fillComposer(copy(item.fill ?? item.label))}
            suggestion={copy(item.label)}
            className={styles.action}
          >
            <span>{copy(item.label)}</span>
          </Suggestion>
        ))}
      </Suggestions>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          onClick={() => requestAddContext?.()}
        >
          <BriefcaseBusiness size={14} aria-hidden="true" />
          {t("agent.emptyPickJob")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          onClick={() => requestAddContext?.()}
        >
          <FileText size={14} aria-hidden="true" />
          {t("agent.emptyPickResume")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          onClick={() => requestAddContext?.()}
        >
          <Plus size={14} aria-hidden="true" />
          {t("agent.addContext")}
        </Button>
        {isPilot && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="resume-evidence-entry"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => setEvidenceOpen(true)}
          >
            <Search size={14} aria-hidden="true" />
            {t("agent.resumeEvidence.entry")}
          </Button>
        )}
      </div>
      {isPilot && (
        <ResumeEvidenceStartDialog
          open={evidenceOpen}
          onOpenChange={setEvidenceOpen}
        />
      )}
      <p data-testid="agent-roster-legend" className="max-w-md text-xs text-muted-foreground">
        {copy(AGENT_ROSTER_LEGEND_KEY)}
      </p>
    </div>
  );
}
