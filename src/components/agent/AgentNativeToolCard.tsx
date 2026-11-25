"use client";

import { Loader2, Wrench } from "lucide-react";
import { useI18n } from "@/i18n";
import type { AgentNativeToolPartData } from "@/models/agent.model";

const TOOL_LABEL_KEYS: Record<string, string> = {
  list_jobs: "nativeSession.tool.listJobs",
  get_job: "nativeSession.tool.getJob",
  get_resume: "nativeSession.tool.getResume",
  today_plan_read: "nativeSession.tool.todayPlanRead",
  notion_search: "nativeSession.tool.notionSearch",
  notion_read: "nativeSession.tool.notionRead",
  feishu_search_docs: "nativeSession.tool.feishuSearchDocs",
  feishu_read_doc: "nativeSession.tool.feishuReadDoc",
};

export function AgentNativeToolCard({
  data,
}: {
  data: AgentNativeToolPartData;
}) {
  const { t } = useI18n();
  const labelKey = TOOL_LABEL_KEYS[data.tool];
  const label = labelKey ? t(labelKey) : data.tool;
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
