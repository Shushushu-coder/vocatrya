import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";

type Db = PrismaClient | Prisma.TransactionClient;

/** Append-only task event kinds. Payloads carry pointers and short codes. */
export const AGENT_TASK_EVENT_KIND = {
  CREATED: "CREATED",
  STATUS: "STATUS",
  MILESTONE: "MILESTONE",
  SESSION_START: "SESSION_START",
  SESSION_END: "SESSION_END",
  GROUNDING: "GROUNDING",
  STEP: "STEP",
  BLOCKED: "BLOCKED",
  RESUMED: "RESUMED",
  HANDOFF_COMMIT: "HANDOFF_COMMIT",
  ERROR: "ERROR",
} as const;
export type AgentTaskEventKind =
  (typeof AGENT_TASK_EVENT_KIND)[keyof typeof AGENT_TASK_EVENT_KIND];

export type AgentTaskEventPayload = Record<
  string,
  string | number | boolean | null
>;

export interface AgentTaskEventDTO {
  id: string;
  taskId: string;
  kind: string;
  payload: AgentTaskEventPayload;
  createdAt: Date;
}

export class AgentTaskEventError extends Error {
  constructor(
    readonly code: "TASK_NOT_FOUND" | "INVALID_KIND" | "PAYLOAD_TOO_LARGE",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AgentTaskEventError";
  }
}

function isEventKind(value: string): value is AgentTaskEventKind {
  return (Object.values(AGENT_TASK_EVENT_KIND) as string[]).includes(value);
}

/**
 * Append one event. The task must belong to `userId` (events never trust a
 * bare task id). Payloads are flat primitives only — pointers and short
 * codes, never prose — and capped, so the audit log cannot become a second
 * transcript.
 */
export async function recordTaskEvent(
  db: Db,
  input: {
    userId: string;
    taskId: string;
    kind: AgentTaskEventKind;
    payload?: AgentTaskEventPayload;
  },
): Promise<AgentTaskEventDTO> {
  if (!isEventKind(input.kind)) {
    throw new AgentTaskEventError("INVALID_KIND", `Unknown event kind ${input.kind}`);
  }
  const serialized = JSON.stringify(input.payload ?? {});
  if (serialized.length > APP_CONSTANTS.AGENT_TASK_EVENT_PAYLOAD_MAX_CHARS) {
    throw new AgentTaskEventError("PAYLOAD_TOO_LARGE");
  }
  const owned = await db.agentTask.findFirst({
    where: { id: input.taskId, userId: input.userId },
    select: { id: true },
  });
  if (!owned) throw new AgentTaskEventError("TASK_NOT_FOUND");
  const row = await db.agentTaskEvent.create({
    data: { taskId: input.taskId, kind: input.kind, payload: serialized },
  });
  return toEventDTO(row);
}

/** Newest-last timeline for one owned task. */
export async function listTaskEvents(
  db: Db,
  input: { userId: string; taskId: string; limit?: number },
): Promise<AgentTaskEventDTO[]> {
  const take = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await db.agentTaskEvent.findMany({
    where: { taskId: input.taskId, task: { userId: input.userId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
  return rows.reverse().map(toEventDTO);
}

function toEventDTO(row: {
  id: string;
  taskId: string;
  kind: string;
  payload: string;
  createdAt: Date;
}): AgentTaskEventDTO {
  let payload: AgentTaskEventPayload = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as AgentTaskEventPayload;
    }
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    payload,
    createdAt: row.createdAt,
  };
}
