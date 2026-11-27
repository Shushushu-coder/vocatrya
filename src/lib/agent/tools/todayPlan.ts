import {
  checkpointConversationTool,
  ConversationRequestError,
  type ConversationRequest,
} from "../conversationRequest";
import type { Prisma } from "@prisma/client";
import { tool } from "ai";
import prisma from "@/lib/db";
import { AGENT_TOOL_DESCRIPTIONS } from "@/lib/agent/prompt";
import {
  AgentTodayPlanReadSchema,
  AgentTodayPlanSchema,
  type AgentTodayPlanInput,
} from "@/models/agent.schema";
import {
  applyTodayPlanWriteInTx,
  listTodayPlanSuggestions,
  readTodayPlan,
} from "@/lib/todayPlan/service";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import type {
  AgentTodayPlanReadResult,
  AgentTodayPlanWriteResult,
} from "@/models/agent.model";
import type { TodayPlanWriteInput } from "@/lib/todayPlan/types";

const PLAN_UNAVAILABLE: AgentTodayPlanWriteResult = {
  status: "failed",
  action: "add",
  message: "no active conversation",
};

// The agent surface splits complete/uncomplete/toggle for phrasing; the
// service result records the underlying "toggle".
function serviceAction(action: AgentTodayPlanInput["action"]) {
  switch (action) {
    case "complete":
    case "uncomplete":
    case "toggle":
      return "toggle" as const;
    default:
      return action;
  }
}

export function mapAgentInput(
  input: AgentTodayPlanInput,
): { input: TodayPlanWriteInput } | { error: string } {
  switch (input.action) {
    case "add":
    case "suggest": {
      if (!input.items?.length) {
        return { error: "items is required for add/suggest" };
      }
      return {
        input: {
          action: input.action,
          titles: input.items,
          target: input.target ?? "today",
        },
      };
    }
    case "rename": {
      if (!input.title || !input.newTitle) {
        return { error: "rename needs title and newTitle" };
      }
      return {
        input: {
          action: "rename",
          selector: { itemTitle: input.title },
          newTitle: input.newTitle,
        },
      };
    }
    case "complete":
    case "uncomplete":
    case "toggle": {
      if (!input.title) return { error: "title is required" };
      return {
        input: {
          action: "toggle",
          selector: { itemTitle: input.title },
          completed:
            input.action === "toggle"
              ? "flip"
              : input.action === "complete",
        },
      };
    }
    case "move": {
      if (!input.title) return { error: "title is required" };
      return {
        input: {
          action: "move",
          selector: { itemTitle: input.title },
          // A bare "move X" means the one date a named item is not already
          // under in ordinary phrasing — tomorrow.
          target: input.target ?? "tomorrow",
        },
      };
    }
    case "reorder": {
      if (!input.titles?.length) {
        return { error: "reorder needs the full title list" };
      }
      return {
        input: {
          action: "reorder",
          target: input.target ?? "today",
          itemTitles: input.titles,
        },
      };
    }
    case "carry_over":
      return { input: { action: "carry_over" } };
    case "remove": {
      if (!input.title) return { error: "title is required" };
      return {
        input: {
          action: "remove",
          selector: { itemTitle: input.title },
        },
      };
    }
  }
}

/**
 * Read this conversation's checklist plus the suggestion snapshot the model
 * drafts a plan from. Read-only — never checkpointed, never writes.
 */
export function buildTodayPlanReadTool(
  userId: string,
  request?: ConversationRequest,
) {
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.today_plan_read,
    inputSchema: AgentTodayPlanReadSchema,
    execute: async (): Promise<AgentTodayPlanReadResult> => {
      const conversationId = request?.conversationId;
      if (!conversationId) {
        return { status: "unavailable", reason: "no_conversation" };
      }
      try {
        const timeZone = await getUserTimeZone(userId);
        const ctx = { userId, conversationId, timeZone };
        const view = await readTodayPlan(ctx);
        if (!view) return { status: "unavailable", reason: "no_conversation" };
        const suggestions = await listTodayPlanSuggestions(ctx);
        return {
          status: "ok",
          timeZone: view.timeZone,
          today: view.today,
          tomorrow: view.tomorrow,
          buckets: view.buckets,
          suggestions,
        };
      } catch {
        return { status: "unavailable", reason: "read_failed" };
      }
    },
  });
}

/**
 * The write tool. `suggest` is the only approval-gated action — it is the
 * "adopt this draft" card, and keeping its gate in every permission mode is
 * deliberate: auto-approving would save a plan the user never reviewed.
 * Every other action writes directly and reports undoable results.
 */
export function buildTodayPlanTool(
  userId: string,
  request?: ConversationRequest,
  options?: {
    /** D06 compound Step 2 code guard: AI-derived items from Step 1 must always emit an adopt-plan draft card, never direct-write `add`. */
    forceSuggestOnly?: boolean;
  },
) {
  const forceSuggestOnly = options?.forceSuggestOnly === true;
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.today_plan,
    inputSchema: AgentTodayPlanSchema,
    needsApproval: (input: { action?: string }) =>
      input?.action === "suggest" ||
      (forceSuggestOnly && input?.action === "add"),
    execute: async (raw, exec): Promise<AgentTodayPlanWriteResult> => {
      const normalizedRaw =
        forceSuggestOnly &&
        raw &&
        typeof raw === "object" &&
        (raw as { action?: string }).action === "add"
          ? { ...(raw as Record<string, unknown>), action: "suggest" }
          : raw;
      const action =
        normalizedRaw && typeof normalizedRaw === "object" && "action" in normalizedRaw
          ? ((normalizedRaw as { action?: string }).action ?? "add")
          : "add";
      const conversationId = request?.conversationId;
      if (!conversationId) {
        return { ...PLAN_UNAVAILABLE, action: action as never };
      }
      const parsed = AgentTodayPlanSchema.safeParse(normalizedRaw);
      if (!parsed.success) {
        return {
          status: "failed",
          action: serviceAction(action as AgentTodayPlanInput["action"]),
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
            .join("; "),
        };
      }
      const mapped = mapAgentInput(parsed.data);
      if ("error" in mapped) {
        return {
          status: "failed",
          action: serviceAction(parsed.data.action),
          message: mapped.error,
        };
      }
      const timeZone = await getUserTimeZone(userId);
      const mutate = (tx: Prisma.TransactionClient) =>
        applyTodayPlanWriteInTx(
          tx,
          { userId, conversationId, timeZone },
          { operationKey: exec.toolCallId, input: mapped.input },
        );
      try {
        // The admitted request carries the checkpoint: a replayed toolCall
        // returns the recorded output instead of writing twice, and the
        // durable operation ledger dedupes inside the same transaction.
        if (request) {
          return await checkpointConversationTool(
            request,
            { toolName: "today_plan", toolCallId: exec.toolCallId, input: raw },
            mutate,
          );
        }
        return await prisma.$transaction(mutate);
      } catch (error) {
        if (error instanceof ConversationRequestError) throw error;
        return {
          status: "failed",
          action: serviceAction(parsed.data.action),
          message: "write failed",
        };
      }
    },
  });
}
