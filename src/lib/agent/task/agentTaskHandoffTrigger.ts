import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import { AIBusinessError } from "@/lib/ai/connections";
import prisma from "@/lib/db";
import { log } from "@/lib/telemetry";
import { conversationSummaryBackoffMs } from "../conversationSummaryCoverage";
import {
  defaultSummarySchedulerDeps,
  type SummarySchedulerDeps,
} from "../conversationSummaryScheduler";
import type { SummaryRepository } from "../conversationSummaryStore";
import { writeHandoffForSession, type WriteHandoffResult } from "./agentTaskHandoffScheduler";
import { syncAgentTaskDerivation } from "./agentTaskMilestone";
import {
  AGENT_TASK_STATUS,
  claimAgentTaskSession,
  getAgentTask,
} from "./agentTaskStore";

/**
 * Turn-finish trigger for the structured task handoff (card C).
 *
 * Mirrors scheduleCareerDialogueSummary: fire-and-forget after the user's
 * turn is already committed, one in-flight run per task, the conversation's
 * own locked connection/model (managed bindings forward provenance + the
 * deterministic operationKey, so a retried write replays instead of
 * re-billing), and exponential backoff on failure using the summary
 * pipeline's schedule (conversationSummaryBackoffMs). Unlike the summary the
 * failure counter is process-local: the ledger has no failure column and a
 * restart merely allows one early retry. Nothing here can fail the user's
 * turn: every path returns a result and swallows its own errors.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export type TaskHandoffTriggerResult = {
  status: "skipped" | "committed" | "failed";
  reason: string;
  revision?: number;
  failureCount?: number;
};

export type TaskHandoffTriggerDeps = {
  db: Db;
  now: () => number;
  loadSession: SummaryRepository["load"];
  executeText: SummarySchedulerDeps["executeText"];
  onResult?: (result: TaskHandoffTriggerResult) => void;
};

const inFlight = new Map<string, Promise<void>>();
const failures = new Map<string, { failureCount: number; lastFailureAt: number }>();

export function taskHandoffInFlight(taskId: string): Promise<void> | undefined {
  return inFlight.get(taskId);
}

export function resetTaskHandoffStateForTests(): void {
  inFlight.clear();
  failures.clear();
}

function defaultDeps(): TaskHandoffTriggerDeps {
  const summaryDeps = defaultSummarySchedulerDeps();
  return {
    db: prisma,
    now: () => Date.now(),
    loadSession: (userId, conversationId) =>
      summaryDeps.repository.load(userId, conversationId),
    executeText: summaryDeps.executeText,
  };
}

function lastIsCompleteAssistant(messages: readonly UIMessage[]): boolean {
  const last = messages[messages.length - 1];
  return (
    last?.role === "assistant" &&
    last.parts.some((part) => part.type === "text" && part.text.trim() !== "")
  );
}

/** Fire-and-forget entry point for the chat route's onFinish. Never throws. */
export function scheduleTaskHandoff(
  input: {
    userId: string;
    conversationId: string;
    taskId: string;
    messages: UIMessage[];
  },
  deps?: TaskHandoffTriggerDeps,
): { opened: boolean } {
  try {
    if (inFlight.has(input.taskId)) return { opened: false };
    if (!lastIsCompleteAssistant(input.messages)) return { opened: false };
    const resolved = deps ?? defaultDeps();
    const run: Promise<void> = Promise.resolve()
      .then(() => runTaskHandoff(input, resolved))
      .then(() => undefined)
      .catch(() => {
        log.info("[agent-task] handoff", { status: "failed", reason: "unexpected" });
      })
      .finally(() => {
        if (inFlight.get(input.taskId) === run) inFlight.delete(input.taskId);
      });
    inFlight.set(input.taskId, run);
    return { opened: true };
  } catch {
    return { opened: false };
  }
}

function writeOutcome(result: WriteHandoffResult): TaskHandoffTriggerResult {
  switch (result.status) {
    case "committed":
      return { status: "committed", reason: "committed", revision: result.revision };
    case "revision_conflict":
      return { status: "skipped", reason: "conflict" };
    case "not_found":
      return { status: "skipped", reason: `${result.what}_not_found` };
    case "validation_failed":
      return { status: "failed", reason: `validation_${result.stage}` };
    case "generation_failed":
      return { status: "failed", reason: "generation" };
  }
}

function noteFailure(taskId: string, at: number): number {
  const count = (failures.get(taskId)?.failureCount ?? 0) + 1;
  failures.set(taskId, { failureCount: count, lastFailureAt: at });
  return count;
}

/** One handoff attempt. Exposed for tests; the route uses scheduleTaskHandoff. */
export async function runTaskHandoff(
  input: { userId: string; conversationId: string; taskId: string },
  deps: TaskHandoffTriggerDeps,
): Promise<TaskHandoffTriggerResult> {
  const finish = (result: TaskHandoffTriggerResult): TaskHandoffTriggerResult => {
    log.info("[agent-task] handoff", { status: result.status, reason: result.reason });
    deps.onResult?.(result);
    return result;
  };
  try {
    const previous = failures.get(input.taskId);
    if (
      previous &&
      deps.now() - previous.lastFailureAt < conversationSummaryBackoffMs(previous.failureCount)
    ) {
      return finish({ status: "skipped", reason: "backoff", failureCount: previous.failureCount });
    }

    const snapshot = await deps.loadSession(input.userId, input.conversationId);
    if (!snapshot || snapshot.archived) return finish({ status: "skipped", reason: "archived" });
    if (snapshot.lockInvalid) return finish({ status: "failed", reason: snapshot.lockInvalid });
    if (!snapshot.resolvedConnectionId || !snapshot.resolvedModel) {
      return finish({ status: "skipped", reason: "legacy" });
    }

    const task = await getAgentTask(deps.db, { userId: input.userId, taskId: input.taskId });
    if (!task || task.status !== AGENT_TASK_STATUS.ACTIVE) {
      return finish({ status: "skipped", reason: "not_active" });
    }
    // Only the claim holder writes the note; the claim is renewed so a live
    // session does not age into the stale window while it works.
    const claim = await claimAgentTaskSession(deps.db, {
      userId: input.userId,
      taskId: input.taskId,
      sessionId: input.conversationId,
      now: new Date(deps.now()),
    });
    if (!claim.ok) {
      return finish({ status: "skipped", reason: `claim_${claim.reason.toLowerCase()}` });
    }

    await syncAgentTaskDerivation(deps.db, { userId: input.userId, taskId: input.taskId });
    const fresh = await getAgentTask(deps.db, { userId: input.userId, taskId: input.taskId });
    if (!fresh) return finish({ status: "skipped", reason: "task_not_found" });

    const connectionId = snapshot.resolvedConnectionId;
    const model = snapshot.resolvedModel;
    const managed = snapshot.managed;
    const result = await writeHandoffForSession({
      db: deps.db,
      userId: input.userId,
      taskId: input.taskId,
      sessionId: input.conversationId,
      expectedRevision: fresh.revision,
      generateProse: async ({ prompt, operationKey }) => {
        const executed = await deps.executeText({
          userId: input.userId,
          connectionId,
          model,
          prompt,
          // Managed binding: the handoff is a business operation of the
          // conversation. operationKey is deterministic per (revision, prompt),
          // so a retried write replays the same invocation.
          ...(managed
            ? {
                managedAiProvenance: managed.provenance,
                managedResource: {
                  business: "CAREER_DIALOGUE",
                  resourceKey: `conversation:${input.conversationId}`,
                },
                operationId: operationKey,
                attemptIndex: 0,
              }
            : {}),
        });
        return executed.text ?? "";
      },
    });
    const outcome = writeOutcome(result);
    if (outcome.status === "failed") {
      return finish({ ...outcome, failureCount: noteFailure(input.taskId, deps.now()) });
    }
    if (outcome.status === "committed") failures.delete(input.taskId);
    return finish(outcome);
  } catch (error) {
    return finish({
      status: "failed",
      reason: error instanceof AIBusinessError ? error.code : "unexpected",
      failureCount: noteFailure(input.taskId, deps.now()),
    });
  }
}
