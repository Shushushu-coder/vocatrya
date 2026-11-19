"use client";

import { getToolName, type ToolUIPart } from "ai";
import { AddJobResult } from "./AddJobResult";
import { GetJobResult, ListJobsResult } from "./JobReadResult";
import { GetResumeResult } from "./GetResumeResult";
import { ReviewResumeResult } from "./ReviewResumeResult";
import { MatchJobResult } from "./MatchJobResult";
import { CoverLetterResult } from "./CoverLetterResult";
import {
  NotionReadResultCard,
  NotionSearchResultCard,
  NotionWriteResultCard,
} from "./NotionResult";
import { SuggestRoleResult } from "./SuggestRoleResult";
import type {
  AgentAddJobResult,
  AgentCanonicalMatchJobResult,
  AgentCoverLetterResult,
  AgentGetJobResult,
  AgentGetResumeResult,
  AgentListJobsResult,
  AgentMatchJobResult,
  AgentNotionReadResult,
  AgentNotionSearchResult,
  AgentNotionWriteResult,
  AgentReviewResumeResult,
  AgentSuggestRoleResult as AgentSuggestRoleResultType,
} from "@/models/agent.model";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { useAgentChat } from "@/components/agent/AgentChatProvider";

export function AgentResultCard({ part }: { part: ToolUIPart }) {
  const { t } = useI18n();
  const { regenerate } = useAgentChat();
  const toolName = getToolName(part);
  if (part.state === "output-denied") {
    return (
      <div className="rounded-sm border p-3 text-sm text-muted-foreground">
        {toolName === "add_job"
          ? t("agent.addJobCancelled")
          : t("agent.cancelledNothingSaved")}
      </div>
    );
  }

  if (part.state === "output-error") {
    if (toolName === "add_job") {
      return (
        <div className="rounded-sm border p-3 text-sm">
          <p>{t("agent.addJobNotAdded")}</p>
          <Button
            className="mt-2 h-7 px-2 text-xs"
            onClick={() => void regenerate?.()}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("agent.retry")}
          </Button>
        </div>
      );
    }
    return (
      <div className="rounded-sm border p-3 text-sm">
        {t("agent.couldNotComplete")}
      </div>
    );
  }

  if (part.state !== "output-available") return null;

  const body =
    toolName === "add_job" ? (
      <AddJobResult
        output={part.output as AgentAddJobResult}
        input={(part.input ?? {}) as Record<string, unknown>}
      />
    ) : toolName === "list_jobs" ? (
      <ListJobsResult output={part.output as AgentListJobsResult} />
    ) : toolName === "get_job" ? (
      <GetJobResult output={part.output as AgentGetJobResult} />
    ) : toolName === "get_resume" ? (
      <GetResumeResult output={part.output as AgentGetResumeResult} />
    ) : toolName === "review_resume" ? (
      <ReviewResumeResult output={part.output as AgentReviewResumeResult} />
    ) : toolName === "match_job" ? (
      <MatchJobResult
        output={part.output as AgentMatchJobResult | AgentCanonicalMatchJobResult}
      />
    ) : toolName === "generate_cover_letter" ? (
      <CoverLetterResult output={part.output as AgentCoverLetterResult} />
    ) : toolName === "notion_search" ? (
      <NotionSearchResultCard output={part.output as AgentNotionSearchResult} />
    ) : toolName === "notion_read" ? (
      <NotionReadResultCard output={part.output as AgentNotionReadResult} />
    ) : toolName === "notion_create_page" ||
      toolName === "notion_append_content" ||
      toolName === "notion_update_record" ? (
      <NotionWriteResultCard output={part.output as AgentNotionWriteResult} />
    ) : toolName === "suggest_role" ? (
      <SuggestRoleResult output={part.output as AgentSuggestRoleResultType} />
    ) : null;

  return <div className="rounded-sm border p-3">{body}</div>;
}
