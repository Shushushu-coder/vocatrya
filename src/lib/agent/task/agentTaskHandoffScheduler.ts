import "server-only";

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import {
  AGENT_TASK_HANDOFF_SCHEMA_VERSION,
  type AgentTaskHandoffState,
} from "@/models/agentTask.schema";
import { decodeHistory } from "../historyCodec";
import { AGENT_TASK_EVENT_KIND, recordTaskEvent } from "./agentTaskEvents";
import {
  buildTaskHandoffPrompt,
  parseTaskHandoffProse,
  projectTaskSessionInput,
} from "./agentTaskHandoffPrompt";
import { commitHandoff, loadLatestHandoff } from "./agentTaskHandoffStore";
import { collectInterviewSprintPointers, type MissingPointer } from "./agentTaskPointers";
import { getAgentTask } from "./agentTaskStore";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Injected model seam. Receives the prompt and a deterministic operation key
 * (`task:<taskId>:handoff:<hash16>`, stable across retries of the same
 * input so a managed executor can replay instead of re-billing) and returns
 * the raw model text. Tests pass fakes; this module never calls a model.
 */
export type GenerateHandoffProse = (input: {
  prompt: string;
  operationKey: string;
}) => Promise<string>;

export type WriteHandoffResult =
  | { status: "committed"; revision: number; stateHash: string; generationMs: number }
  | { status: "revision_conflict" }
  | {
      status: "validation_failed";
      stage: "prose" | "state" | "pointers";
      issues: string[];
      missing?: MissingPointer[];
    }
  | { status: "generation_failed"; error: string }
  | { status: "not_found"; what: "task" | "session" };

function parseMessages(raw: string): UIMessage[] {
  try {
    const parsed: unknown = JSON.parse(decodeHistory(raw));
    return Array.isArray(parsed) ? (parsed as UIMessage[]) : [];
  } catch {
    return [];
  }
}

async function recordError(
  db: Db,
  userId: string,
  taskId: string,
  code: string,
): Promise<void> {
  try {
    await recordTaskEvent(db, {
      userId,
      taskId,
      kind: AGENT_TASK_EVENT_KIND.ERROR,
      payload: { source: "handoff", code },
    });
  } catch {
    // Audit is best-effort on failure paths; never mask the typed result.
  }
}

/**
 * Write the next handoff for a task session (not wired into the chat route
 * yet; card C owns the trigger).
 *
 * Entity pointers, milestone, acceptance snapshot and constraints are
 * collected/carried by code; only summary / nextActions / blocking come from
 * `generateProse`, validated by zod. The commit re-checks every pointer's
 * existence and wins or loses on the revision CAS; the HANDOFF_COMMIT event
 * is written in the commit transaction.
 */
export async function writeHandoffForSession(input: {
  db: Db;
  userId: string;
  taskId: string;
  sessionId: string;
  expectedRevision: number;
  generateProse: GenerateHandoffProse;
}): Promise<WriteHandoffResult> {
  const { db, userId, taskId, sessionId, expectedRevision } = input;

  const task = await getAgentTask(db, { userId, taskId });
  if (!task) return { status: "not_found", what: "task" };
  if (task.revision !== expectedRevision) return { status: "revision_conflict" };

  const session = await db.chatConversation.findFirst({
    where: { id: sessionId, userId, agentTaskId: taskId },
    select: { messages: true },
  });
  if (!session) return { status: "not_found", what: "session" };

  const previous = await loadLatestHandoff(db, { userId, taskId });
  const previousState = previous?.status === "ok" ? previous.state : null;

  const pointers = await collectInterviewSprintPointers(db, {
    userId,
    jobOpportunityId: task.jobOpportunityId,
    interviewPrepGoalId: task.interviewPrepGoalId,
  });

  const projection = projectTaskSessionInput(parseMessages(session.messages));
  const prompt = buildTaskHandoffPrompt({
    taskTitle: task.title,
    milestone: task.milestone,
    acceptance: task.acceptanceItems.map(({ key, label, passes }) => ({ key, label, passes })),
    previous: previousState
      ? {
          summary: previousState.completedWork.summary,
          nextActions: previousState.nextActions.map((next) => next.action),
        }
      : null,
    projection,
  });
  const operationKey = `task:${taskId}:handoff:${createHash("sha256")
    .update(`${expectedRevision}\n${prompt}`)
    .digest("hex")
    .slice(0, 16)}`;

  const startedAt = Date.now();
  let reply: string;
  try {
    reply = await input.generateProse({ prompt, operationKey });
  } catch (error) {
    await recordError(db, userId, taskId, "generation_failed");
    return {
      status: "generation_failed",
      error: error instanceof Error ? error.message : "generation failed",
    };
  }
  const generationMs = Math.max(0, Date.now() - startedAt);

  const parsed = parseTaskHandoffProse(reply);
  if (!parsed.ok) {
    await recordError(db, userId, taskId, `prose_${parsed.reason}`);
    return { status: "validation_failed", stage: "prose", issues: parsed.issues };
  }

  const state: AgentTaskHandoffState = {
    schemaVersion: AGENT_TASK_HANDOFF_SCHEMA_VERSION,
    taskId,
    templateKey: "INTERVIEW_SPRINT",
    milestone: task.milestone as AgentTaskHandoffState["milestone"],
    completedWork: { summary: parsed.prose.summary, ...pointers },
    acceptanceSnapshot: task.acceptanceItems.map((item) => ({
      key: item.key,
      passes: item.passes,
      ...(item.evidenceRef ? { evidenceRef: item.evidenceRef } : {}),
    })),
    blocking: parsed.prose.blocking,
    nextActions: parsed.prose.nextActions,
    criticalConstraints: previousState?.criticalConstraints ?? [],
    constraintSourceIds: previousState?.constraintSourceIds ?? [],
  };

  const committed = await commitHandoff(db, {
    userId,
    taskId,
    expectedRevision,
    state,
    sessionId,
    generationMs,
  });
  switch (committed.status) {
    case "committed":
      return {
        status: "committed",
        revision: committed.revision,
        stateHash: committed.stateHash,
        generationMs,
      };
    case "revision_conflict":
      return { status: "revision_conflict" };
    case "task_not_found":
      return { status: "not_found", what: "task" };
    case "invalid":
      await recordError(db, userId, taskId, "state_invalid");
      return { status: "validation_failed", stage: "state", issues: committed.issues };
    case "pointer_missing":
      await recordError(db, userId, taskId, "pointer_missing");
      return {
        status: "validation_failed",
        stage: "pointers",
        issues: committed.missing.map((item) => `${item.key}: ${item.id}`),
        missing: committed.missing,
      };
  }
}
