"use client";

import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { AGENT_ADD_JOB_INTRO } from "@/lib/agent/prompt";
import { useI18n } from "@/i18n";

type SuggestionItem = { label: string; run: () => void };

export function AgentChatEmptyState() {
  const { t, locale } = useI18n();
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
  const suggestions: SuggestionItem[] = job
    ? prompts([
        "agent.emptyJobAnalyze",
        "agent.emptyJobMatch",
        "agent.emptyJobReview",
        "agent.emptyJobInterview",
      ])
    : resume
      ? prompts([
          "agent.emptyResumeReview",
          "agent.emptyResumeOptimize",
          "agent.emptyResumeExperience",
        ])
      : [
          { label: t("agent.emptyPickJob"), run: () => requestAddContext?.() },
          {
            label: t("agent.emptyPickResume"),
            run: () => requestAddContext?.(),
          },
          { label: t("agent.addContext"), run: () => requestAddContext?.() },
          {
            label: addJob,
            run: () => {
              if (!preflight.ok) return;
              seedExchange(
                addJob,
                locale === "zh-CN" ? t("agent.addJobIntro") : AGENT_ADD_JOB_INTRO,
              );
            },
          },
        ];

  return (
    <div className="flex flex-1 flex-col justify-end gap-4 p-4">
      <p className="text-sm text-muted-foreground">
        {job
          ? job.labelSnapshot
          : resume
            ? resume.labelSnapshot
            : t("agent.emptyStart")}
      </p>
      <Suggestions>
        {suggestions.map((item) => (
          <Suggestion
            disabled={!preflight.ok}
            key={item.label}
            onClick={() => item.run()}
            suggestion={item.label}
          />
        ))}
      </Suggestions>
    </div>
  );
}
