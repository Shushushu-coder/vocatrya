"use client";

import { useCallback, useEffect, useState } from "react";
import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createAgentTask, listAgentTasks } from "@/actions/agentTask.actions";
import { useOpenAgentTask } from "@/components/agent/useOpenAgentTask";
import { useI18n } from "@/i18n";
import { toastError } from "@/lib/toast";

const LIVE = ["ACTIVE", "PAUSED", "BLOCKED"];

/**
 * The one creation entry for the job-search (interview sprint) task. With an
 * in-progress task on this job it becomes "打开任务" and opens that task's
 * Pilot session in the Agent window; otherwise it creates the task (one live
 * task per job) and opens its session.
 */
export function JobTaskButton({ jobOpportunityId }: { jobOpportunityId: string }) {
  const { t } = useI18n();
  const { openTask, pendingTaskId } = useOpenAgentTask();
  const [taskId, setTaskId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listAgentTasks({ jobOpportunityId })
      .then((result) => {
        if (cancelled || !result.success || !result.data) return;
        setTaskId(result.data.find((task) => LIVE.includes(task.status))?.id ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [jobOpportunityId]);

  const onClick = useCallback(async () => {
    if (taskId) {
      await openTask(taskId);
      return;
    }
    setCreating(true);
    try {
      const result = await createAgentTask({ jobOpportunityId });
      if (!result.success || !result.data) {
        toastError(t("agentTask.createFailed"));
        return;
      }
      setTaskId(result.data.task.id);
      await openTask(result.data.task.id);
    } catch {
      toastError(t("agentTask.createFailed"));
    } finally {
      setCreating(false);
    }
  }, [taskId, jobOpportunityId, openTask, t]);

  const busy = creating || pendingTaskId !== null;
  return (
    <Button
      variant="outline"
      className="cursor-pointer"
      data-testid="job-task-button"
      disabled={!loaded || busy}
      onClick={() => void onClick()}
    >
      <ListChecks className="h-4 w-4 sm:mr-2" />
      <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
        {busy
          ? t("agentTask.creating")
          : taskId
            ? t("agentTask.openTask")
            : t("agentTask.createForJob")}
      </span>
    </Button>
  );
}
