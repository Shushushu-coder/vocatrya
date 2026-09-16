"use client";

import { getToolName, type ToolUIPart } from "ai";
import { AgentStatusRow } from "@/components/agent/AgentStatusRow";
import { useI18n } from "@/i18n";

// Confirmation renders null for these states, so this is not redundant with
// it. On a local 8B, deciding on a tool call is the longest phase of a turn.
export function AgentToolRunningCard({ part }: { part: ToolUIPart }) {
  const { t } = useI18n();
  const toolName = getToolName(part);
  const label =
    toolName === "add_job"
      ? t("agent.preparingAddJob")
      : toolName === "get_resume"
        ? t("agent.readingResume")
        : toolName === "review_resume"
          ? t("agent.reviewingResume")
          : toolName === "match_job"
            ? t("agent.matchingResume")
            : toolName === "generate_cover_letter"
              ? t("agent.writingCoverLetter")
              : t("agent.working");

  return <AgentStatusRow label={label} />;
}
