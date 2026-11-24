"use server";
import { z } from "zod";
import { requireUser } from "./shared";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import {
  applyTodayPlanWrite,
  readTodayPlan,
  undoTodayPlanOperation,
} from "@/lib/todayPlan/service";
import type {
  TodayPlanUndoResult,
  TodayPlanView,
  TodayPlanWriteInput,
  TodayPlanWriteResult,
} from "@/lib/todayPlan/types";

type ActionResult<T> = {
  success: boolean;
  data?: T;
  message?: string;
  code?: string;
};

const fail = (error: unknown, message: string): ActionResult<never> => {
  if (error instanceof Error && error.message === "Not authenticated") {
    return { success: false, message, code: "NOT_AUTHENTICATED" };
  }
  return { success: false, message, code: "REQUEST_FAILED" };
};

const SelectorSchema = z.union([
  z.object({ itemId: z.string().min(1).max(120) }),
  z.object({ itemTitle: z.string().min(1).max(240) }),
]);

const TitleList = z.array(z.string().min(1).max(200)).min(1).max(20);

// The manual-write contract. Server-side re-validation is mandatory — a
// client can post anything to an action endpoint, and the service layer's
// ownership checks assume a structurally sane input.
const WriteInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["add", "suggest"]),
    titles: TitleList,
    target: z.enum(["today", "tomorrow"]),
  }),
  z.object({
    action: z.literal("rename"),
    selector: SelectorSchema,
    newTitle: z.string().min(1).max(200),
  }),
  z.object({
    action: z.literal("toggle"),
    selector: SelectorSchema,
    completed: z.union([z.boolean(), z.literal("flip")]),
  }),
  z.object({
    action: z.literal("reorder"),
    target: z.enum(["today", "tomorrow"]),
    itemIds: z.array(z.string().min(1).max(120)).max(200).optional(),
    itemTitles: TitleList.optional(),
  }),
  z.object({
    action: z.literal("move"),
    selector: SelectorSchema,
    target: z.enum(["today", "tomorrow"]),
  }),
  z.object({ action: z.literal("carry_over") }),
  z.object({ action: z.literal("remove"), selector: SelectorSchema }),
]);

export const getTodayPlan = async (
  conversationId: string,
): Promise<ActionResult<TodayPlanView>> => {
  try {
    const user = await requireUser();
    if (typeof conversationId !== "string" || !conversationId) {
      return {
        success: false,
        code: "CONVERSATION_NOT_FOUND",
        message: "Conversation not found",
      };
    }
    const timeZone = await getUserTimeZone(user.id);
    const view = await readTodayPlan({ userId: user.id, conversationId, timeZone });
    if (!view) {
      return {
        success: false,
        code: "CONVERSATION_NOT_FOUND",
        message: "Conversation not found",
      };
    }
    return { success: true, data: view };
  } catch (error) {
    return fail(error, "Failed to load the checklist.");
  }
};

export const mutateTodayPlan = async (input: {
  conversationId: string;
  operationKey: string;
  write: TodayPlanWriteInput;
}): Promise<ActionResult<TodayPlanWriteResult>> => {
  try {
    const user = await requireUser();
    if (typeof input?.conversationId !== "string" || !input.conversationId) {
      return {
        success: false,
        code: "CONVERSATION_NOT_FOUND",
        message: "Conversation not found",
      };
    }
    if (typeof input.operationKey !== "string" || !input.operationKey) {
      return {
        success: false,
        code: "INVALID_OPERATION",
        message: "Missing operation key",
      };
    }
    const parsed = WriteInputSchema.safeParse(input.write);
    if (!parsed.success) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "Invalid checklist operation",
      };
    }
    const timeZone = await getUserTimeZone(user.id);
    const result = await applyTodayPlanWrite(
      { userId: user.id, conversationId: input.conversationId, timeZone },
      { operationKey: input.operationKey, input: parsed.data as TodayPlanWriteInput },
    );
    return { success: true, data: result };
  } catch (error) {
    return fail(error, "Failed to update the checklist.");
  }
};

export const undoTodayPlan = async (input: {
  conversationId: string;
  operationId: string;
}): Promise<ActionResult<TodayPlanUndoResult>> => {
  try {
    const user = await requireUser();
    if (typeof input?.conversationId !== "string" || !input.conversationId) {
      return {
        success: false,
        code: "CONVERSATION_NOT_FOUND",
        message: "Conversation not found",
      };
    }
    if (typeof input.operationId !== "string" || !input.operationId) {
      return {
        success: false,
        code: "INVALID_OPERATION",
        message: "Missing operation id",
      };
    }
    const result = await undoTodayPlanOperation(
      { userId: user.id, conversationId: input.conversationId },
      input.operationId,
    );
    return { success: true, data: result };
  } catch (error) {
    return fail(error, "Failed to undo the change.");
  }
};
