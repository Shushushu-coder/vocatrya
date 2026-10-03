import "server-only";

import { generateId } from "ai";
import { AI_BUSINESS_ERROR_CODES, AIBusinessError } from "@/lib/ai/connections";
import { fetchAccountRuntimeState } from "@/lib/ai/streaming-execution";
import {
  checkStructuredOutputReadiness,
  type AccountRuntimeCapabilities,
} from "@/lib/ai/runtime/capabilities";
import {
  renderCareerDialoguePrompt,
  runAccountAgentTurn,
  streamFinalAnswer,
  type AccountAgentTurnInput,
  type AccountAgentTurnResult,
} from "./accountTurn";
import type { CareerDialogueContextSize } from "./contextBudget";
import {
  routeCareerDialogueTurn,
  type CareerDialogueRouteDecision,
  type CareerDialogueRouteMessage,
} from "./careerDialogueRoute";

export type { CareerDialogueRouteDecision };

/**
 * Per-turn capability split:
 *
 * - FAST_CHAT requires the streaming gate the route already applied.
 *   Structured-output readiness is not required, and a failure here must
 *   not start a structured decision.
 * - AGENT requires streaming and verified structured output. A structured
 *   miss rejects the turn. It is never rewritten as FAST_CHAT.
 *
 * Opening a conversation (getAgentChatPreflight) stays streaming-only so a
 * direct chat can run when structured output is unverified. Assignment
 * selection is unchanged.
 */
export async function assertAgentStructuredReadiness(connection: {
  backendKind: string;
  provider: string;
}): Promise<void> {
  const state = await fetchAccountRuntimeState({
    backendKind: connection.backendKind,
    accountProvider: connection.provider,
  });
  const capabilities = state.capabilities as AccountRuntimeCapabilities | null;
  const eligibility = checkStructuredOutputReadiness({ capabilities });
  const structured = capabilities?.structuredOutput;
  const versionOk =
    Boolean(structured?.verifiedRuntimeVersion) &&
    state.runtimeVersion === structured?.verifiedRuntimeVersion;
  if (
    (eligibility !== "ELIGIBLE_NATIVE" &&
      eligibility !== "ELIGIBLE_PROMPT_RETRY") ||
    !versionOk
  ) {
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_NOT_VERIFIED,
      "Career Dialogue agent path requires verified structured output",
    );
  }
}

export type CareerDialoguePreparation =
  | {
      ok: true;
      decision: CareerDialogueRouteDecision;
      routerDurationMs: number;
    }
  | {
      ok: false;
      decision: CareerDialogueRouteDecision;
      routerDurationMs: number;
      error: unknown;
    };

export async function prepareCareerDialogueTurn(input: {
  messages: CareerDialogueRouteMessage[];
  pageContext?: unknown;
  connection: { backendKind: string; provider: string };
}): Promise<CareerDialoguePreparation> {
  const started = performance.now();
  const decision = routeCareerDialogueTurn({
    messages: input.messages,
    pageContext: input.pageContext,
  });
  const routerDurationMs = performance.now() - started;
  if (decision.route === "AGENT") {
    try {
      await assertAgentStructuredReadiness(input.connection);
    } catch (error) {
      return { ok: false, decision, routerDurationMs, error };
    }
  }
  return { ok: true, decision, routerDurationMs };
}

export async function runCareerDialogueTurn(
  input: AccountAgentTurnInput & {
    decision: CareerDialogueRouteDecision;
    routerDurationMs?: number;
  },
): Promise<
  AccountAgentTurnResult & {
    decision: CareerDialogueRouteDecision;
    routerDurationMs: number;
    contextSize?: CareerDialogueContextSize;
  }
> {
  const decision = input.decision;
  const routerDurationMs = input.routerDurationMs ?? 0;
  if (decision.route === "AGENT") {
    const result = await runAccountAgentTurn(input);
    return { ...result, decision, routerDurationMs };
  }

  const { messages, systemPrompt, writer, signal } = input;
  if (signal.aborted) {
    throw Object.assign(new Error("Execution aborted"), { name: "AbortError" });
  }

  const lastMessage = messages[messages.length - 1];
  const messageId =
    lastMessage?.role === "assistant" ? lastMessage.id : generateId();
  writer.write({ type: "start", messageId });

  const rendered = renderCareerDialoguePrompt({
    profile: "FAST_CHAT",
    systemPrompt,
    messages,
    pageContext: input.pageContext,
    pastedText: input.pastedText,
    summary: input.summary,
    directChat: true,
  });
  const answerChars = await streamFinalAnswer({
    userId: input.userId,
    connectionId: input.connectionId,
    modelName: input.modelName,
    prompt: rendered.prompt,
    writer,
    signal,
  });
  writer.write({ type: "finish" });
  return {
    paused: false,
    answerChars,
    steps: 0,
    decision,
    routerDurationMs,
    contextSize: rendered.size,
  };
}
