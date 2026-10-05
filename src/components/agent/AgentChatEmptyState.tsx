"use client";

import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { AGENT_ADD_JOB_INTRO } from "@/lib/agent/prompt";
import { useI18n } from "@/i18n";
import { BriefcaseBusiness, BriefcaseMedical, FileText, Plus, type LucideIcon } from "lucide-react";
import { EmptyStateAgentPresence } from "./EmptyStateAgentPresence";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import type { VocatryaMotionState } from "@/components/brand/VocatryaMark";
import styles from "./empty-state.module.css";

type SuggestionItem = { label: string; run: () => void; icon?: LucideIcon };

export function AgentChatEmptyState({ state = "idle" }: { state?: VocatryaMotionState }) {
  const { t, locale } = useI18n();
  const { freshNativeFull } = useCareerSurfaces();
  const { sendMessage, seedExchange, preflight, context, requestAddContext } =
    useAgentChat();
  const items = context?.items ?? [];
  const job = items.find((item) => item.kind === "job");
  const resume = items.find((item) => item.kind === "resume");

  const send = (text: string) => {
    if (!preflight.ok) return;
    void sendMessage({ parts: [{ type: "text", text }] });
  };
  const prompts = (keys: string[]): SuggestionItem[] =>
    keys.map((key) => {
      const label = t(key);
      return { label, run: () => send(label) };
    });

  const addJob = t("agent.suggestions.addJob");
  const addCanonicalJob = t("agent.suggestions.addCanonicalJob");
  // Fresh + full may suggest adding a job opportunity. It does not suggest
  // match or cover-letter actions.
  const suggestions: SuggestionItem[] = job
    ? prompts(
        freshNativeFull
          ? [
              "agent.emptyJobAnalyze",
              "agent.emptyJobReview",
              "agent.emptyJobInterview",
            ]
          : [
              "agent.emptyJobAnalyze",
              "agent.emptyJobMatch",
              "agent.emptyJobReview",
              "agent.emptyJobInterview",
            ],
      )
    : resume
      ? prompts([
          "agent.emptyResumeReview",
          "agent.emptyResumeOptimize",
          "agent.emptyResumeExperience",
        ])
      : [
          { label: t("agent.emptyPickJob"), run: () => requestAddContext?.(), icon: BriefcaseBusiness },
          {
            label: t("agent.emptyPickResume"),
            run: () => requestAddContext?.(),
            icon: FileText,
          },
          { label: t("agent.addContext"), run: () => requestAddContext?.(), icon: Plus },
          {
            label: freshNativeFull ? addCanonicalJob : addJob,
            icon: BriefcaseMedical,
            run: () => {
              if (!preflight.ok) return;
              seedExchange(
                freshNativeFull ? addCanonicalJob : addJob,
                freshNativeFull
                  ? t("agent.addCanonicalJobIntro")
                  : locale === "zh-CN"
                    ? t("agent.addJobIntro")
                    : AGENT_ADD_JOB_INTRO,
              );
            },
          },
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
      <Suggestions className={`${styles.actions} w-full`}>
        {suggestions.map((item) => (
          <Suggestion
            disabled={!preflight.ok}
            key={item.label}
            onClick={() => item.run()}
            suggestion={item.label}
            className={styles.action}
          >
            {item.icon ? <item.icon size={16} aria-hidden="true" /> : null}
            <span>{item.label}</span>
          </Suggestion>
        ))}
      </Suggestions>
    </div>
  );
}
