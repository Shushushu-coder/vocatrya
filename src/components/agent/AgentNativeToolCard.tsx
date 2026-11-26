"use client";

import { ClockIcon, Loader2, ShieldAlert, Wrench } from "lucide-react";
import { useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { AgentProposalInputBody } from "@/components/agent/AgentApprovalCard";
import { AgentProposalStatus } from "@/components/agent/AgentProposalStatus";
import type { AgentNativeToolPartData } from "@/models/agent.model";

const TOOL_LABEL_KEYS: Record<string, string> = {
  list_jobs: "nativeSession.tool.listJobs",
  get_job: "nativeSession.tool.getJob",
  get_resume: "nativeSession.tool.getResume",
  today_plan_read: "nativeSession.tool.todayPlanRead",
  add_job: "nativeSession.tool.addJob",
  today_plan: "nativeSession.tool.todayPlan",
  review_resume: "nativeSession.tool.reviewResume",
  match_job: "nativeSession.tool.matchJob",
  notion_search: "nativeSession.tool.notionSearch",
  notion_read: "nativeSession.tool.notionRead",
  notion_create_page: "nativeSession.tool.notionCreatePage",
  notion_append_content: "nativeSession.tool.notionAppendContent",
  notion_update_record: "nativeSession.tool.notionUpdateRecord",
  notion_update_content: "nativeSession.tool.notionUpdateContent",
  notion_delete_pages: "nativeSession.tool.notionDeletePages",
  feishu_search_docs: "nativeSession.tool.feishuSearchDocs",
  feishu_read_doc: "nativeSession.tool.feishuReadDoc",
  feishu_create_doc: "nativeSession.tool.feishuCreateDoc",
  feishu_append_content: "nativeSession.tool.feishuAppendContent",
  feishu_update_content: "nativeSession.tool.feishuUpdateContent",
};

export function AgentNativeToolCard({
  data,
}: {
  data: AgentNativeToolPartData;
}) {
  const { t } = useI18n();
  const labelKey = TOOL_LABEL_KEYS[data.tool];
  const label = labelKey ? t(labelKey) : data.tool;

  // Non-blocking approval proposal or queued external write: NEVER render as
  // "Completed" / "Saved". Hydrate authoritative state from AgentProposalStatus
  // so approve/reject/withdraw/poll/terminal receipt stay consistent with the
  // hosted AI approval flow across refreshes and restarts.
  if (data.status === "approval_required" || data.status === "queued") {
    const isQueued = data.status === "queued";
    return (
      <div
        data-testid="agent-native-tool-card"
        data-status={data.status}
        data-tool={data.tool}
        data-proposal-id={data.proposalId ?? ""}
        className="rounded-sm border bg-muted/20 p-3 text-xs text-muted-foreground"
      >
        <div className="flex items-center gap-2 font-medium text-foreground">
          {isQueued ? (
            <ClockIcon className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
          )}
          <Badge variant="secondary">
            {t(
              isQueued
                ? "nativeSession.tool.queued"
                : "nativeSession.tool.approvalRequired",
            )}
          </Badge>
          <span className="text-sm font-semibold">{label}</span>
        </div>

        {data.proposalId || data.approvalId ? (
          <AgentProposalStatus
            proposalId={data.proposalId}
            approvalId={data.approvalId}
            renderInput={(dto) => (
              <AgentProposalInputBody
                toolName={dto.toolName}
                input={dto.input}
              />
            )}
          />
        ) : data.argumentsSummary ? (
          <p className="mt-1.5 break-words text-xs text-muted-foreground">
            {t("nativeSession.tool.arguments", {
              arguments: data.argumentsSummary,
            })}
          </p>
        ) : null}
      </div>
    );
  }

  const statusKey =
    data.status === "running"
      ? "nativeSession.tool.running"
      : data.status === "completed"
        ? "nativeSession.tool.completed"
        : "nativeSession.tool.failed";

  return (
    <div
      data-testid="agent-native-tool-card"
      data-status={data.status}
      data-tool={data.tool}
      className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
    >
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        {data.status === "running" ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Wrench className="size-3.5 shrink-0" aria-hidden />
        )}
        <span>{label}</span>
        <span className="font-normal text-muted-foreground">
          {t(statusKey)}
        </span>
      </div>

      {data.argumentsSummary ? (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {t("nativeSession.tool.arguments", {
            arguments: data.argumentsSummary,
          })}
        </p>
      ) : null}

      {data.resultSummary ? (
        <p className="mt-1 break-words whitespace-pre-wrap text-xs text-muted-foreground">
          {data.resultSummary}
        </p>
      ) : null}
    </div>
  );
}
