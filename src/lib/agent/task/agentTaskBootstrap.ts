import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { log } from "@/lib/telemetry";
import { normalizeAgentRole } from "../agentRoles";
import {
  verifyTaskGrounding,
  type GroundingLocale,
  type TaskGrounding,
} from "./agentTaskGrounding";
import { resolveTaskSessionTools } from "./agentTaskTools";

/**
 * Cold-start assembly (card C): turn a task into what a fresh Pilot session
 * needs. verifyTaskGrounding does all the checking; this layer adds the
 * session eligibility rules and failure containment.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export function normalizeGroundingLocale(locale: string | undefined): GroundingLocale {
  return locale === "en" ? "en" : "zh-CN";
}

/**
 * The verified "Active task state" line for a task, or undefined when the
 * task is missing/not owned. Throws only on infrastructure failure; callers
 * on the chat path must use resolveTaskSessionContext, which contains it.
 */
export async function buildTaskHandoffLine(
  db: Db,
  input: {
    userId: string;
    taskId: string;
    locale?: GroundingLocale;
    recordEvents?: boolean;
    now?: Date;
  },
): Promise<{ line: string; grounding: TaskGrounding } | undefined> {
  const grounding = await verifyTaskGrounding(db, input);
  if (!grounding) return undefined;
  return { line: grounding.verifiedLine, grounding };
}

export interface TaskSessionContext {
  taskId: string;
  /** Extra tools declared by the task template for this session. */
  extraTools: readonly string[];
  handoffLine?: string;
}

/**
 * Everything the chat route needs for one turn of a conversation, or null
 * when the conversation is not (or no longer) a live task session: no
 * agentTaskId, wrong role, or a task that is not ACTIVE/owned. A null result
 * means "ordinary chat": no prompt section, no extra tools, no handoff line.
 * A grounding failure never fails the turn: the session keeps its tools and
 * prompt section but runs without the line.
 */
export async function resolveTaskSessionContext(
  db: Db,
  input: {
    userId: string;
    agentTaskId: string | null | undefined;
    agentRole: string | null | undefined;
    locale?: string;
  },
): Promise<TaskSessionContext | null> {
  if (!input.agentTaskId) return null;
  if (normalizeAgentRole(input.agentRole) !== "pilot") return null;
  let extraTools: readonly string[] | null;
  try {
    extraTools = await resolveTaskSessionTools(db, input);
  } catch {
    return null;
  }
  if (extraTools === null) return null;
  try {
    const built = await buildTaskHandoffLine(db, {
      userId: input.userId,
      taskId: input.agentTaskId,
      locale: normalizeGroundingLocale(input.locale),
    });
    return { taskId: input.agentTaskId, extraTools, handoffLine: built?.line };
  } catch {
    log.info("[agent-task] grounding", { status: "failed" });
    return { taskId: input.agentTaskId, extraTools };
  }
}
