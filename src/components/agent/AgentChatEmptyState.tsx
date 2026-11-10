"use client";

import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { copyFor } from "@/lib/agent/roleCopy";
import { suggestionsForRole } from "@/lib/agent/roleSuggestions";
import { useI18n } from "@/i18n";
import { BriefcaseBusiness, FileText, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyStateAgentPresence } from "./EmptyStateAgentPresence";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import type { VocatryaMotionState } from "@/components/brand/VocatryaMark";
import styles from "./empty-state.module.css";

export function AgentChatEmptyState({ state = "idle" }: { state?: VocatryaMotionState }) {
  const { t, locale } = useI18n();
  const { freshNativeFull } = useCareerSurfaces();
  const { fillComposer, activeRole, context, requestAddContext } =
    useAgentChat();
  const copy = copyFor(t, locale);
  const items = context?.items ?? [];
  const job = items.find((item) => item.kind === "job");
  const resume = items.find((item) => item.kind === "resume");

  // Four static items per role. A click only fills the composer (D8): no
  // /api/ai/chat request, no conversation creation, no model call — and it
  // stays clickable while AI is unavailable, because nothing here sends.
  const suggestions = suggestionsForRole(activeRole, { freshNativeFull });

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
      </div>
    </div>
  );
}
