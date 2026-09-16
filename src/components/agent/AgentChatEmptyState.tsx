"use client";

import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { AGENT_ADD_JOB_INTRO } from "@/lib/agent/prompt";
import { useI18n } from "@/i18n";

// None need editing first, so they act on click. "Review resume" runs a real
// turn. "Match a job" and "Generate cover letter" have no page context here,
// so the tools reply with a graceful "no_job" result telling the user to open
// a job's page first. ADD_JOB is the one whose answer is knowable without the
// model — see AGENT_ADD_JOB_INTRO.

export function AgentChatEmptyState() {
  const { t, locale } = useI18n();
  const { sendMessage, seedExchange, preflight } = useAgentChat();

  const addJob = t("agent.suggestions.addJob");
  const examples = [
    addJob,
    t("agent.suggestions.reviewResume"),
    t("agent.suggestions.matchJob"),
    t("agent.suggestions.coverLetter"),
  ];

  const handleClick = (example: string) => {
    if (!preflight.ok) return;
    if (example === addJob) {
      seedExchange(
        example,
        locale === "zh-CN" ? t("agent.addJobIntro") : AGENT_ADD_JOB_INTRO,
      );
      return;
    }
    void sendMessage({ parts: [{ type: "text", text: example }] });
  };

  return (
    <div className="flex flex-1 flex-col justify-end gap-4 p-4">
      {/* Stated up front rather than left to the model to confess: a local 8B
          asked what it can do will happily invent capabilities. */}
      <p className="text-sm text-muted-foreground">{t("agent.emptyGreeting")}</p>

      <Suggestions>
        {examples.map((example) => (
          <Suggestion
            disabled={!preflight.ok}
            key={example}
            onClick={handleClick}
            suggestion={example}
          />
        ))}
      </Suggestions>
    </div>
  );
}
