import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizeAgentRole } from "../agentRoles";
import { AGENT_TASK_STATUS } from "./agentTaskStore";
import { taskExtraToolsFor } from "./agentTaskTemplates";

/**
 * 任务扩展: the ONE place that decides which extra tools a conversation gets
 * because it is a task session. The chat route (tool registry + prompt) and
 * the permission preview both call this; effectiveAgentToolNames only
 * receives its result. A conversation qualifies when ALL hold:
 *  - it carries an agentTaskId and its role is Pilot (task sessions never
 *    use agentRole NULL);
 *  - that task is owned by the same user, ACTIVE and not archived.
 * Anything else (no task, paused/blocked/done task, foreign task, other
 * role) returns null: the role's normal allowlist applies unchanged.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export async function resolveTaskSessionTools(
  db: Db,
  input: {
    userId: string;
    agentTaskId: string | null | undefined;
    agentRole: string | null | undefined;
  },
): Promise<readonly string[] | null> {
  if (!input.agentTaskId) return null;
  if (normalizeAgentRole(input.agentRole) !== "pilot") return null;
  const task = await db.agentTask.findFirst({
    where: {
      id: input.agentTaskId,
      userId: input.userId,
      status: AGENT_TASK_STATUS.ACTIVE,
      archivedAt: null,
    },
    select: { templateKey: true },
  });
  return task ? taskExtraToolsFor(task.templateKey) : null;
}
