"use client";

import { useCallback, useState } from "react";
import { resumeAgentTask } from "@/actions/agentTask.actions";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { useI18n } from "@/i18n";
import { toastError } from "@/lib/toast";

/**
 * "Open / continue a task": resume (claims the one Pilot session), then show
 * that session in the Agent window. A newly created session gets the fixed
 * kickoff text as its first turn; a reused one just opens.
 */
export function useOpenAgentTask() {
  const { t } = useI18n();
  const { openTaskSession, conversationId, activeTaskId } = useAgentChat();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);

  const openTask = useCallback(
    async (taskId: string): Promise<boolean> => {
      setPendingTaskId(taskId);
      try {
        const result = await resumeAgentTask(
          taskId,
          activeTaskId === taskId && conversationId ? { conversationId } : undefined,
        );
        if (!result.success || !result.data) {
          const held = !result.success && result.code === "HELD";
          toastError(held ? t("agentTask.heldElsewhere") : t("agentTask.openFailed"));
          return false;
        }
        const { conversationId: sessionId, created, kickoffText } = result.data;
        const ok = await openTaskSession({
          conversationId: sessionId,
          kickoffText: created ? kickoffText : undefined,
        });
        if (!ok) toastError(t("agentTask.openFailed"));
        return ok;
      } catch {
        toastError(t("agentTask.openFailed"));
        return false;
      } finally {
        setPendingTaskId(null);
      }
    },
    [activeTaskId, conversationId, openTaskSession, t],
  );

  return { openTask, pendingTaskId };
}
