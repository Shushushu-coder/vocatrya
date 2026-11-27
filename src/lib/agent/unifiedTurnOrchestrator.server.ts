import "server-only";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  isToolUIPart,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamWriter,
} from "ai";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/db";
import { LOCALE_COOKIE_NAME, normalizeLocale } from "@/i18n";
import { APP_CONSTANTS } from "@/lib/constants";
import { AIBusinessError } from "@/lib/ai/connections";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import { log } from "@/lib/telemetry";
import {
  normalizeAgentRole,
  type AgentRole,
} from "./agentRoles";
import {
  blockingPendingApprovals,
  cancelConversationRequest,
  finishConversationRequest,
  type ConversationRequest,
} from "./conversationRequest";
import { conversationCommitStream } from "./conversationStream";
import { stubConsumedPastes } from "./paste";
import {
  pageContextFromConversation,
  type AgentConversationContextV1,
} from "./conversationContext";
import {
  buildAgentChatSystemPrompt,
} from "./prompt";
import {
  permissionInstructions,
  personalInstructionsBlock,
  type PermissionMode,
} from "./preferences";
import { buildResumeEvidencePromptAddendum } from "./skills/resumeEvidence/session";
import {
  currentUserExceedsContextBudget,
  resolveCareerDialogueBudgets,
  type CareerDialogueContextSize,
} from "./contextBudget";
import {
  AGENT_CONTEXT_USAGE_PART_TYPE,
  type AgentContextUsage,
} from "./contextUsage";
import { loadConversationSummaryStatus } from "./conversationSummaryStore";
import { scheduleCareerDialogueSummary } from "./conversationSummaryScheduler";
import { resolveVerifiedBusinessAnchors } from "./businessAnchors.server";
import {
  managedMemoryBlockForConversation,
  nativeMemoryBlockForConversation,
} from "./longTermMemory.server";
import { scheduleLongTermMemoryExtraction } from "./longTermMemoryExtractor.server";
import {
  prepareCareerDialogueTurn,
  runCareerDialogueTurn,
} from "./careerDialogueTurn";
import {
  executeNativeTurn,
  NATIVE_PATH,
} from "./nativeSession.server";
import { nativeBusinessAllowedTools } from "./nativeBusinessMcp.server";
import {
  AGENT_NATIVE_SEARCH_PART_TYPE,
  AGENT_NATIVE_TOOL_PART_TYPE,
  type AgentNativeSearchPartData,
  type AgentNativeToolPartData,
} from "@/models/agent.model";
import { agentErrorEnvelope, formatAgentStreamError } from "./errors";
import type { TaskSessionContext } from "./task/agentTaskBootstrap";
import { scheduleTaskHandoff } from "./task/agentTaskHandoffTrigger";
import {
  AGENT_UNIFIED_STATUS_PART_TYPE,
  readMessageAgentRole,
  readMessageMetadata,
  roleAttributionTag,
  type AgentUnifiedStatusData,
  type StepHandoffPayload,
  type UnifiedMessageMetadata,
} from "./unifiedChatTypes";
import {
  buildLayer1RouterPrompt,
  buildStepHandoffPayload,
  evaluateLayer0Route,
  formatStepHandoffInstruction,
  LAYER1_ROUTER_SCHEMA,
  parseLayer1RouteDecision,
  type RoutePlan,
} from "./unifiedRouter";
import {
  precheckUnifiedPlanSteps,
  resolveUnifiedRouterConfig,
  type ResolvedUnifiedStepTarget,
} from "./unifiedModelResolver.server";

function lastUserTextOf(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "user") continue;
    return (messages[i].parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
  }
  return "";
}

function createStepCaptureWriter(
  downstream: UIMessageStreamWriter,
  chunks: UIMessageChunk[],
): UIMessageStreamWriter {
  return {
    write(part) {
      chunks.push(part);
      downstream.write(part);
    },
    merge(stream) {
      downstream.merge(
        stream.pipeThrough(
          new TransformStream<UIMessageChunk, UIMessageChunk>({
            transform(chunk, controller) {
              chunks.push(chunk);
              controller.enqueue(chunk);
            },
          }),
        ),
      );
    },
    onError: downstream.onError,
  };
}

async function assembleStepMessage(
  chunks: UIMessageChunk[],
  fallbackId: string,
  fallbackMetadata: UnifiedMessageMetadata,
): Promise<UIMessage> {
  let assembled: UIMessage | null = null;
  if (chunks.length > 0) {
    try {
      const chunkStream = new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      for await (const msg of readUIMessageStream({ stream: chunkStream })) {
        assembled = msg;
      }
    } catch {
      assembled = null;
    }
  }
  if (assembled) {
    return {
      ...assembled,
      id: assembled.id || fallbackId,
      role: "assistant",
      metadata: {
        ...fallbackMetadata,
        ...(readMessageMetadata(assembled) ?? {}),
      },
    };
  }
  return {
    id: fallbackId,
    role: "assistant",
    metadata: fallbackMetadata,
    parts: [],
  };
}

function hasPendingTodoDraft(messages: UIMessage[]): boolean {
  return messages.some((m) =>
    (m.parts ?? []).some(
      (p) =>
        isToolUIPart(p) &&
        p.type === "tool-today_plan" &&
        p.state === "approval-requested",
    ),
  );
}

/**
 * Builds an incremental cross-role context prefix for a unified native step
 * when messages were appended since this role's native binding last synced (D08-Q2).
 */
function buildNativeCrossRoleSyncPrefix(input: {
  messages: UIMessage[];
  lastSyncedMessageId: string | null;
  currentRole: AgentRole;
  fallbackRole: AgentRole | null;
  handoffBlock?: string;
  businessAnchorLine?: string;
  pastedText?: string;
  fileTexts?: { name: string; text: string }[];
}): string {
  const blocks: string[] = [];
  if (input.businessAnchorLine) {
    blocks.push(input.businessAnchorLine);
  }
  if (input.handoffBlock) {
    blocks.push(input.handoffBlock);
  }
  const msgs = input.messages;
  let startIdx = 0;
  if (input.lastSyncedMessageId) {
    const found = msgs.findIndex((m) => m.id === input.lastSyncedMessageId);
    if (found >= 0) startIdx = found + 1;
  }
  // Exclude the very last user message (sent as the turn's main prompt).
  const prior = msgs.slice(startIdx, Math.max(startIdx, msgs.length - 1));
  const summaryLines: string[] = [];
  for (const m of prior.slice(-6)) {
    const text = (m.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 600);
    if (!text) continue;
    if (m.role === "user") {
      summaryLines.push(`User: ${text}`);
    } else if (m.role === "assistant") {
      const r = readMessageAgentRole(m, input.fallbackRole);
      if (r === input.currentRole && input.lastSyncedMessageId) continue;
      const tag = roleAttributionTag(r);
      summaryLines.push(`Assistant${tag ? ` ${tag}` : ""}: ${text}`);
    }
  }
  if (summaryLines.length > 0) {
    blocks.push(
      `[UNIFIED CONVERSATION CONTEXT SYNC]\n${summaryLines.join("\n")}`,
    );
  }
  if (input.pastedText) {
    blocks.push(`[PASTED CONTENT]\n${input.pastedText.slice(0, 6000)}`);
  }
  if (input.fileTexts && input.fileTexts.length > 0) {
    for (const f of input.fileTexts) {
      blocks.push(`[ATTACHED FILE: ${f.name}]\n${f.text.slice(0, 6000)}`);
    }
  }
  return blocks.join("\n\n");
}

export async function unifiedChatResponse(input: {
  req: NextRequest;
  userId: string;
  conversationId: string;
  conversation: {
    id: string;
    chatMode: string;
    activeRole: string | null;
    agentRole: string | null;
    executionPath: string;
    context: string | null;
    agentTaskId: string | null;
  };
  request: ConversationRequest;
  operation: "send" | "regenerate" | "approval" | "retry_step" | "reanswer";
  forcedRole?: AgentRole | null;
  retryTurnId?: string;
  retryStepIndex?: number;
  reanswerTargetMessageId?: string;
  permissionMode: PermissionMode;
  personalInstructions: string;
  pastedText?: string;
  fileTexts: { name: string; text: string }[];
  conversationContext: AgentConversationContextV1;
  freshNativeFull: boolean;
  canonicalJobs: boolean;
  notionTools: readonly string[];
  feishuTools: readonly string[];
  taskSession: TaskSessionContext | null;
}) {
  const {
    req,
    userId,
    conversationId,
    conversation,
    request,
    operation,
    permissionMode,
    personalInstructions,
    pastedText,
    fileTexts,
    conversationContext,
    freshNativeFull,
    canonicalJobs,
    notionTools,
    feishuTools,
    taskSession,
  } = input;

  const locale = normalizeLocale(req.cookies?.get?.(LOCALE_COOKIE_NAME)?.value);
  const pageContext = pageContextFromConversation(conversationContext);
  const messages = request.messages;
  const currentActiveRole =
    normalizeAgentRole(conversation.activeRole) ??
    normalizeAgentRole(conversation.agentRole);
  const hasHistory = messages.some((m) => m.role === "assistant");
  const userText = lastUserTextOf(messages);
  const preferNative = conversation.executionPath === NATIVE_PATH;

  // --- Operation: retry_step safety check & state load (D05/D06/D07) ---
  let existingRetryTurn: {
    id: string;
    step1MessageId: string | null;
    step1Role: AgentRole;
    step1Objective: string;
    retryStepId: string;
    retryRole: AgentRole;
    retryObjective: string;
    handoffJson: string | null;
  } | null = null;

  if (operation === "retry_step") {
    const turnId = input.retryTurnId!;
    const stepIndex = input.retryStepIndex!;
    const turnRow = await prisma.chatTurn.findFirst({
      where: { id: turnId, userId, conversationId },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    const targetStep = turnRow?.steps.find((s) => s.stepIndex === stepIndex);
    if (!turnRow || !targetStep || !["FAILED", "CANCELLED"].includes(targetStep.status)) {
      return NextResponse.json(
        { error: "Step is not eligible for retry.", code: "CONVERSATION_TURN_CONFLICT" },
        { status: 409 },
      );
    }
    // H04 C03/C06 guard: never blind-retry a step with committed/dispatched/uncertain external writes.
    const turnKey = turnRow.userMessageId ?? "";
    if (turnKey) {
      const riskyProposal = await prisma.agentOperationProposal.findFirst({
        where: {
          userId,
          conversationId,
          turnKey,
          OR: [
            { status: "APPROVED" },
            { dispatchedAt: { not: null } },
            { outcomeStatus: "UNCERTAIN" },
          ],
        },
        select: { id: true, outcomeStatus: true },
      });
      if (riskyProposal) {
        return NextResponse.json(
          {
            error: "This step has a committed or uncertain write receipt and cannot be automatically retried.",
            code: "CONVERSATION_TURN_CONFLICT",
          },
          { status: 409 },
        );
      }
    }
    const step0 = turnRow.steps.find((s) => s.stepIndex === 0);
    existingRetryTurn = {
      id: turnRow.id,
      step1MessageId: step0?.messageId ?? null,
      step1Role: normalizeAgentRole(step0?.role) ?? "pilot",
      step1Objective: step0?.objective ?? "",
      retryStepId: targetStep.id,
      retryRole: normalizeAgentRole(targetStep.role) ?? "pilot",
      retryObjective: targetStep.objective ?? userText,
      handoffJson: targetStep.handoffJson ?? null,
    };
  }

  // --- Layer 0 deterministic fast-path check ---
  const approvalRole =
    operation === "approval"
      ? readMessageAgentRole(messages.at(-1), currentActiveRole)
      : null;

  const layer0 = evaluateLayer0Route({
    operation,
    userText,
    activeRole: currentActiveRole,
    hasHistory,
    forcedRole: existingRetryTurn?.retryRole ?? input.forcedRole ?? null,
    approvalRole,
    hasActiveTask: Boolean(taskSession),
  });

  // Pre-resolve Router config BEFORE opening the stream if Layer 1 will run (D07 fail-fast).
  let routerTarget: Awaited<ReturnType<typeof resolveUnifiedRouterConfig>> | null = null;
  if (!layer0.hit) {
    try {
      routerTarget = await resolveUnifiedRouterConfig(userId);
    } catch (error) {
      return NextResponse.json(agentErrorEnvelope(error), { status: 503 });
    }
  }

  // If Layer 0 hit, pre-check all planned steps BEFORE opening the stream (D07 fail-fast).
  let precheckedLayer0Steps: ResolvedUnifiedStepTarget[] | null = null;
  if (layer0.hit) {
    try {
      precheckedLayer0Steps = await precheckUnifiedPlanSteps(
        userId,
        layer0.plan.steps,
        { conversationId, preferNative },
      );
    } catch (error) {
      return NextResponse.json(agentErrorEnvelope(error), { status: 503 });
    }
  }

  const executionAbort = new AbortController();
  request.abort = () => executionAbort.abort();
  const turnSignal = AbortSignal.any([
    executionAbort.signal,
    req.signal,
    AbortSignal.timeout(APP_CONSTANTS.AGENT_CHAT_TIMEOUT_MS),
  ]);

  let turnFailed = false;
  let lastCompletedRole: AgentRole | null = null;
  let lastManagedStep: ResolvedUnifiedStepTarget | null = null;
  let createdTurnId: string | null = existingRetryTurn?.id ?? null;
  const producedMessages: UIMessage[] = [];
  request.responseMessageIds = [];

  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: async ({ writer }) => {
      const emitStatus = (data: AgentUnifiedStatusData) => {
        writer.write({
          type: AGENT_UNIFIED_STATUS_PART_TYPE,
          transient: true,
          data,
        });
      };

      request.onCheckpoint = () =>
        writer.write({
          type: "data-conversation",
          transient: true,
          data: {
            conversationId,
            requestId: request.requestId,
            revision: request.revision,
            durable: true,
            released: false,
            wrote: request.wrote,
          },
        });

      // --- Step A: Determine Route Plan (Layer 0 or Layer 1) ---
      let plan: RoutePlan;
      let lockedSteps: ResolvedUnifiedStepTarget[];

      if (layer0.hit && precheckedLayer0Steps) {
        plan = layer0.plan;
        lockedSteps = precheckedLayer0Steps;
      } else {
        // D05: while Layer 1 classifies, emit neutral routing status without pre-attaching any role avatar.
        emitStatus({ phase: "routing" });
        const routerPrompt = buildLayer1RouterPrompt({
          activeRole: currentActiveRole,
          hasHistory,
          messages,
          userText,
          hasPendingTodoDraft: hasPendingTodoDraft(messages),
        });
        let routerRaw = "";
        try {
          const routerRes = await executeAIConnectionText({
            userId,
            connectionId: routerTarget!.connectionId,
            model: routerTarget!.model,
            prompt: routerPrompt,
            structuredOutput: {
              schema: LAYER1_ROUTER_SCHEMA as unknown as Record<string, unknown>,
              schemaName: "vocatrya_unified_router",
            },
            disableReasoning: true,
            maxOutputTokens: 160,
            timeoutMs: 25_000,
            signal: turnSignal,
            ...(routerTarget!.managedAiProvenance
              ? {
                  managedAiProvenance: routerTarget!.managedAiProvenance,
                  managedResource: {
                    business: "CAREER_DIALOGUE",
                    resourceKey: `router:${userId}`,
                  },
                  operationId: `router:${conversationId}:${request.requestId}`,
                  attemptIndex: 0,
                }
              : {}),
          });
          routerRaw = routerRes.text ?? "";
        } catch (error) {
          // D07: explicit broken router fails honestly instead of silently spending another connection.
          if (error instanceof AIBusinessError) {
            throw error;
          }
          routerRaw = "";
        }

        plan = parseLayer1RouteDecision(routerRaw, {
          activeRole: currentActiveRole,
          hasHistory,
          userText,
        });

        // D07 Turn-entry fail-fast: pre-check & lock ALL planned steps before calling Step 1.
        lockedSteps = await precheckUnifiedPlanSteps(
          userId,
          plan.steps,
          { conversationId, preferNative },
        );
      }

      // --- Step B: Persist ChatTurn + ChatTurnStep rows ---
      const userMessageId =
        [...messages].reverse().find((m) => m.role === "user")?.id ?? null;

      let stepRowIds: string[] = [];
      if (existingRetryTurn) {
        createdTurnId = existingRetryTurn.id;
        const target = lockedSteps[0];
        await prisma.chatTurnStep.update({
          where: { id: existingRetryTurn.retryStepId },
          data: {
            resolvedConnectionId: target.connectionId,
            resolvedModel: target.model,
            executionPath: target.executionPath,
            configSource: target.configSource,
            status: "PENDING",
            errorCode: null,
          },
        });
        await prisma.chatTurn.update({
          where: { id: existingRetryTurn.id },
          data: { status: "RUNNING", requestId: request.requestId },
        });
        stepRowIds = [existingRetryTurn.retryStepId];
      } else {
        const turnRow = await prisma.chatTurn.create({
          data: {
            userId,
            conversationId,
            requestId: request.requestId,
            userMessageId,
            operation,
            routeLayer: plan.layer,
            routeReason: plan.reason,
            plannedStepCount: lockedSteps.length,
            status: "RUNNING",
            steps: {
              create: lockedSteps.map((step, idx) => ({
                userId,
                conversationId,
                stepIndex: idx,
                role: step.role,
                objective: step.objective,
                resolvedConnectionId: step.connectionId,
                resolvedModel: step.model,
                executionPath: step.executionPath,
                configSource: step.configSource,
                status: "PENDING",
              })),
            },
          },
          include: { steps: { orderBy: { stepIndex: "asc" } } },
        });
        createdTurnId = turnRow.id;
        stepRowIds = turnRow.steps.map((s) => s.id);
      }

      // --- Step C: Strictly sequential execution (1 or max 2 steps, D03) ---
      // Working message timeline shared across Step 1 -> Step 2.
      const workingMessages: UIMessage[] = [...messages];
      // D04: M2.1 session-frozen memory block stays stable across role switches.
      const frozenManagedMemory =
        (await managedMemoryBlockForConversation(userId, conversationId).catch(() => "")) ||
        undefined;

      for (let i = 0; i < lockedSteps.length; i += 1) {
        if (turnSignal.aborted) {
          for (let j = i; j < stepRowIds.length; j += 1) {
            await prisma.chatTurnStep.update({
              where: { id: stepRowIds[j] },
              data: { status: "CANCELLED" },
            });
          }
          break;
        }

        const step = lockedSteps[i];
        const stepId = stepRowIds[i];
        const isStep2 = i === 1 || (existingRetryTurn !== null && input.retryStepIndex === 1);
        const stepMessageId =
          operation === "approval" && workingMessages.at(-1)?.role === "assistant"
            ? workingMessages.at(-1)!.id
            : generateId();

        request.responseMessageId = stepMessageId;
        if (!request.responseMessageIds!.includes(stepMessageId)) {
          request.responseMessageIds!.push(stepMessageId);
        }

        // Build Step 2 programmatic handoff payload (D03: 0 extra LLM calls).
        let handoffInstruction = "";
        let handoffPayload: StepHandoffPayload | null = null;
        if (isStep2) {
          if (existingRetryTurn?.handoffJson) {
            try {
              handoffPayload = JSON.parse(existingRetryTurn.handoffJson) as StepHandoffPayload;
            } catch {
              handoffPayload = null;
            }
          }
          if (!handoffPayload) {
            const step1Message = existingRetryTurn
              ? workingMessages.find((m) => m.id === existingRetryTurn.step1MessageId)
              : producedMessages[0];
            handoffPayload = buildStepHandoffPayload({
              step1Role: existingRetryTurn ? existingRetryTurn.step1Role : lockedSteps[0].role,
              step1Objective: existingRetryTurn ? existingRetryTurn.step1Objective : lockedSteps[0].objective,
              step2Objective: step.objective,
              step1Message,
            });
          }
          handoffInstruction = formatStepHandoffInstruction(handoffPayload);
        }

        await prisma.chatTurnStep.update({
          where: { id: stepId },
          data: {
            status: "RUNNING",
            messageId: stepMessageId,
            ...(handoffPayload ? { handoffJson: JSON.stringify(handoffPayload) } : {}),
          },
        });

        emitStatus({
          phase: i === 0 ? "step_running" : "step_handoff",
          turnId: createdTurnId!,
          stepIndex: existingRetryTurn ? input.retryStepIndex! : i,
          stepCount: existingRetryTurn ? 2 : lockedSteps.length,
          role: step.role,
          nextRole: lockedSteps[i + 1]?.role,
        });

        const stepMetadata: UnifiedMessageMetadata = {
          agentRole: step.role,
          turnId: createdTurnId!,
          stepIndex: existingRetryTurn ? input.retryStepIndex! : i,
          stepCount: existingRetryTurn ? 2 : lockedSteps.length,
          model: step.model,
          connectionId: step.connectionId,
          executionPath: step.executionPath,
          configSource: step.configSource,
          stepStatus: "COMPLETED",
          ...(input.reanswerTargetMessageId
            ? { reanswerOfMessageId: input.reanswerTargetMessageId }
            : {}),
        };

        try {
          if (step.executionPath === NATIVE_PATH) {
            // --- Native Codex Step (D08-Q2 per-role binding) ---
            const nativeMemory = await nativeMemoryBlockForConversation(userId, conversationId);
            const binding = await prisma.nativeConversationBinding.findUnique({
              where: {
                conversationId_roleKey: { conversationId, roleKey: step.role },
              },
              select: { lastSyncedMessageId: true },
            });
            const timeZone = await getUserTimeZone(userId).catch(() => "UTC");
            const anchors = await resolveVerifiedBusinessAnchors(prisma, {
              userId,
              conversationId,
              context: conversationContext,
              locale,
              timeZone,
            }).catch(() => null);

            const syncPrefix = buildNativeCrossRoleSyncPrefix({
              messages: workingMessages,
              lastSyncedMessageId: binding?.lastSyncedMessageId ?? null,
              currentRole: step.role,
              fallbackRole: currentActiveRole,
              handoffBlock: handoffInstruction || undefined,
              businessAnchorLine: anchors?.renderedBlock || undefined,
              pastedText: i === 0 ? pastedText : undefined,
              fileTexts: i === 0 ? fileTexts : undefined,
            });
            const promptText = syncPrefix
              ? `${syncPrefix}\n\n[CURRENT USER REQUEST]\n${userText}`
              : userText;

            const allowedBusinessTools = nativeBusinessAllowedTools({
              agentRole: step.role,
              freshNativeFull,
              notionTools,
              feishuTools,
              taskExtraTools: taskSession?.extraTools,
              unified: true,
            });
            const turnKey = userMessageId ?? request.requestId;
            const instructions =
              buildAgentChatSystemPrompt(locale, {
                freshNativeFull,
                agentRole: step.role,
                notionTools,
                feishuTools,
                taskExtraTools: taskSession?.extraTools,
                unified: true,
              }) +
              permissionInstructions(permissionMode) +
              personalInstructionsBlock(personalInstructions) +
              nativeMemory;

            const searchParts = new Map<string, AgentNativeSearchPartData>();
            const toolParts = new Map<string, AgentNativeToolPartData>();
            let textPartIndex = 0;
            let activeTextId: string | null = null;
            let collectedText = "";
            let nativeCreatedProposal = false;

            const closeText = () => {
              if (!activeTextId) return;
              writer.write({ type: "text-end", id: activeTextId });
              activeTextId = null;
            };

            writer.write({
              type: "start",
              messageId: stepMessageId,
              messageMetadata: stepMetadata,
            });

            for await (const event of executeNativeTurn({
              request,
              connectionId: step.connectionId,
              model: step.model,
              prompt: promptText,
              instructions,
              signal: turnSignal,
              origin: req.nextUrl.origin,
              allowedBusinessTools,
              permissionMode,
              agentRole: step.role,
              turnKey,
              freshNativeFull,
              canonicalJobs,
              pageJobId: pageContext?.jobId ?? null,
              pageResumeId: pageContext?.resumeId ?? null,
              taskExtraTools: taskSession?.extraTools,
              roleKey: step.role,
              unified: true,
              stepId,
              forceTodayPlanSuggestOnly: isStep2,
              lastSyncedMessageId: stepMessageId,
            })) {
              if (turnSignal.aborted) throw new DOMException("Stopped", "AbortError");
              if (event.type === "native-session") {
                writer.write({
                  type: "data-native-session",
                  transient: true,
                  data: {
                    conversationId,
                    requestId: request.requestId,
                    resumed: event.resumed,
                  },
                });
              } else if (event.type === "native-event" && event.kind === "search") {
                closeText();
                const payload = event.payload as Extract<
                  typeof event.payload,
                  { actionType?: unknown }
                >;
                const prev = searchParts.get(event.itemId);
                const merged: AgentNativeSearchPartData = {
                  version: 1,
                  kind: "search",
                  itemId: event.itemId,
                  status: (payload as { status: AgentNativeSearchPartData["status"] }).status,
                  actionType: (payload.actionType as AgentNativeSearchPartData["actionType"]) ?? prev?.actionType ?? "other",
                  query: (payload as { query?: string }).query || prev?.query || "",
                  queries: (payload as { queries?: string[] }).queries ?? prev?.queries ?? [],
                  sources: (payload as { sources?: AgentNativeSearchPartData["sources"] }).sources ?? prev?.sources ?? [],
                  occurredAt: event.occurredAt,
                };
                searchParts.set(event.itemId, merged);
                writer.write({
                  type: AGENT_NATIVE_SEARCH_PART_TYPE,
                  id: `native-search-${event.itemId}`,
                  data: merged,
                });
              } else if (event.type === "native-event") {
                closeText();
                const payload = event.payload as Extract<
                  typeof event.payload,
                  { tool?: unknown }
                >;
                if (
                  payload.status === "approval_required" &&
                  payload.tool !== "today_plan"
                ) {
                  nativeCreatedProposal = true;
                }
                const merged: AgentNativeToolPartData = {
                  version: 1,
                  kind: "tool",
                  itemId: event.itemId,
                  tool: String(payload.tool ?? ""),
                  status: payload.status as AgentNativeToolPartData["status"],
                  ...(payload.argumentsSummary ? { argumentsSummary: String(payload.argumentsSummary) } : {}),
                  ...(payload.resultSummary ? { resultSummary: String(payload.resultSummary) } : {}),
                  ...(payload.proposalId ? { proposalId: String(payload.proposalId) } : {}),
                  ...(payload.approvalId ? { approvalId: String(payload.approvalId) } : {}),
                  ...(payload.taskId ? { taskId: String(payload.taskId) } : {}),
                  ...(payload.expiresAt ? { expiresAt: String(payload.expiresAt) } : {}),
                  occurredAt: event.occurredAt,
                };
                toolParts.set(event.itemId, merged);
                writer.write({
                  type: AGENT_NATIVE_TOOL_PART_TYPE,
                  id: `native-tool-${event.itemId}`,
                  data: merged,
                });
              } else if (event.type === "text-delta") {
                if (!activeTextId) {
                  activeTextId = textPartIndex === 0 ? stepMessageId : `${stepMessageId}-text-${textPartIndex}`;
                  textPartIndex += 1;
                  writer.write({ type: "text-start", id: activeTextId });
                }
                collectedText += event.delta;
                writer.write({ type: "text-delta", id: activeTextId, delta: event.delta });
              }
            }
            closeText();

            const stepMessage: UIMessage = {
              id: stepMessageId,
              role: "assistant",
              metadata: {
                ...stepMetadata,
                ...(nativeCreatedProposal && lockedSteps[i + 1]
                  ? {
                      stepStatus: "BLOCKED_APPROVAL",
                      skippedNextRole: lockedSteps[i + 1].role,
                      skippedNextObjective: lockedSteps[i + 1].objective,
                    }
                  : {}),
              },
              parts: collectedText ? [{ type: "text", text: collectedText }] : [],
            };
            producedMessages.push(stepMessage);
            workingMessages.push(stepMessage);

            if (nativeCreatedProposal) {
              await prisma.chatTurnStep.update({
                where: { id: stepId },
                data: { status: "BLOCKED_APPROVAL" },
              });
              if (stepRowIds[i + 1]) {
                await prisma.chatTurnStep.update({
                  where: { id: stepRowIds[i + 1] },
                  data: { status: "SKIPPED", errorCode: "STEP1_APPROVAL_REQUIRED" },
                });
                emitStatus({
                  phase: "step_blocked",
                  turnId: createdTurnId!,
                  stepIndex: i,
                  stepCount: lockedSteps.length,
                  role: step.role,
                  nextRole: lockedSteps[i + 1].role,
                });
              }
              writer.write({ type: "finish" });
              lastCompletedRole = step.role;
              break;
            }

            await prisma.chatTurnStep.update({
              where: { id: stepId },
              data: { status: "COMPLETED" },
            });
            lastCompletedRole = step.role;
            writer.write({ type: "finish" });
          } else {
            // --- Managed / BYOK / Account Orchestrated Step ---
            const systemPrompt =
              buildAgentChatSystemPrompt(locale, {
                freshNativeFull,
                agentRole: step.role,
                notionTools,
                feishuTools,
                taskExtraTools: taskSession?.extraTools,
                unified: true,
              }) +
              personalInstructionsBlock(personalInstructions) +
              permissionInstructions(permissionMode) +
              buildResumeEvidencePromptAddendum({ messages: workingMessages, agentRole: step.role }) +
              handoffInstruction +
              (plan.truncatedExtraGoals && i === lockedSteps.length - 1
                ? "\n\nNote: The user asked for more than 2 cross-role goals; briefly mention that any remaining goals can be continued in the next turn."
                : "");

            const managedTurn = step.managedAiProvenance
              ? {
                  provenance: step.managedAiProvenance,
                  resourceKey: `conversation:${conversationId}`,
                  operationId: `dialogue:${conversationId}:${request.requestId}:s${i}`,
                }
              : undefined;

            const resolvedBudgets = resolveCareerDialogueBudgets({
              model: step.model,
              upstreamModelId: managedTurn?.provenance.upstreamModelId,
              provider: step.provider,
              backendKind: step.backendKind,
            });
            if (currentUserExceedsContextBudget(workingMessages, resolvedBudgets.budgets)) {
              throw new AIBusinessError(
                "AI_REQUEST_TOO_LARGE",
                "Current user message exceeds the Career Dialogue input budget",
              );
            }

            const prepared = await prepareCareerDialogueTurn({
              messages: workingMessages,
              pageContext,
              connection: {
                backendKind: step.backendKind,
                provider: step.provider,
              },
              managed: managedTurn ? { userId, model: step.model } : undefined,
            });
            if (!prepared.ok) throw prepared.error;

            const summaryStatus = await loadConversationSummaryStatus({
              userId,
              conversationId,
              messages: workingMessages,
              maxSummaryTokens: resolvedBudgets.budgets.summaryTokens,
            });

            let businessAnchorLine: string | undefined;
            if (summaryStatus.freshSummary) {
              try {
                const timeZone = await getUserTimeZone(userId).catch(() => "UTC");
                const anchors = await resolveVerifiedBusinessAnchors(prisma, {
                  userId,
                  conversationId,
                  context: conversationContext,
                  locale,
                  timeZone,
                });
                if (anchors.renderedBlock) businessAnchorLine = anchors.renderedBlock;
              } catch {
                // Best-effort grounding
              }
            }

            // Capture chunks emitted during this step so Step 1 -> Step 2 handoff
            // and multi-step durable persistence always have each step's exact UIMessage.
            const stepChunks: UIMessageChunk[] = [];
            const stepWriter = createStepCaptureWriter(writer, stepChunks);
            let stepContextSize: CareerDialogueContextSize | undefined;
            const result = await runCareerDialogueTurn({
              userId,
              connectionId: step.connectionId,
              provider: step.provider,
              backendKind: step.backendKind,
              modelName: step.model,
              managed: managedTurn,
              systemPrompt,
              messages: workingMessages,
              pastedText: i === 0 ? pastedText : undefined,
              fileTexts: i === 0 ? fileTexts : undefined,
              pageContext,
              summary: summaryStatus.freshSummary,
              budgets: resolvedBudgets.budgets,
              // D04: never auto-insert L2 compaction between Step 1 and Step 2.
              autoCompactTriggerTokens: isStep2
                ? Number.MAX_SAFE_INTEGER
                : resolvedBudgets.autoCompactTriggerTokens,
              businessAnchorLine,
              longTermMemoryLine: frozenManagedMemory,
              writer: stepWriter,
              signal: turnSignal,
              decision: prepared.decision,
              routerDurationMs: prepared.routerDurationMs,
              freshNativeFull,
              canonicalJobs,
              request,
              agentRole: step.role,
              notionTools,
              feishuTools,
              permissionMode,
              agentTaskId: taskSession?.taskId,
              handoffLine: taskSession?.handoffLine,
              taskExtraTools: taskSession?.extraTools,
              unified: true,
              forceTodayPlanSuggestOnly: isStep2,
              messageMetadata: stepMetadata,
            });

            stepContextSize = result.contextSize;
            lastManagedStep = step;

            if (stepContextSize && i === lockedSteps.length - 1) {
              const usage: AgentContextUsage = {
                conversationId,
                requestId: request.requestId,
                profile: stepContextSize.contextProfile,
                estimatedInputTokens: stepContextSize.estimatedInputTokens,
                recentTurnCount: stepContextSize.recentTurnCount,
                droppedTurnCount: stepContextSize.droppedTurnCount,
                modelContextWindowTokens: resolvedBudgets.contextWindowTokens,
                modelContextWindowSource: resolvedBudgets.contextWindowSource,
                autoCompactTriggerTokens: resolvedBudgets.autoCompactTriggerTokens,
                microCompactedToolCount: stepContextSize.microCompactedToolCount,
                compactedTurnCount: stepContextSize.compactedTurnCount,
                hasSummary: Boolean(summaryStatus.freshSummary),
                circuitBreakerOpen: summaryStatus.circuitBreakerOpen,
                failureCount: summaryStatus.failureCount,
                tokens: {
                  system: stepContextSize.systemTokens,
                  currentUser: stepContextSize.currentUserTokens,
                  history: stepContextSize.historyTokens,
                  explicitContext: stepContextSize.explicitContextTokens,
                  toolResult: stepContextSize.toolResultTokens,
                  summary: stepContextSize.summaryTokens,
                  dynamic: stepContextSize.dynamicTokens,
                  ...(stepContextSize.businessAnchorTokens > 0
                    ? { businessAnchor: stepContextSize.businessAnchorTokens }
                    : {}),
                  ...(stepContextSize.handoffTokens > 0
                    ? { handoff: stepContextSize.handoffTokens }
                    : {}),
                  ...(stepContextSize.longTermMemoryTokens > 0
                    ? { longTermMemory: stepContextSize.longTermMemoryTokens }
                    : {}),
                },
                budgets: { ...resolvedBudgets.budgets },
              };
              writer.write({
                type: AGENT_CONTEXT_USAGE_PART_TYPE,
                transient: true,
                data: usage,
              });
            }

            // Assemble the complete step UIMessage from captured stream chunks (falling back to checkpointed parts).
            const assembledStepMsg = await assembleStepMessage(
              stepChunks,
              stepMessageId,
              stepMetadata,
            );
            const latestStepMsg =
              assembledStepMsg.parts.length > 0
                ? assembledStepMsg
                : (request.messages.find((m) => m.id === stepMessageId) ??
                  assembledStepMsg);

            // D03: if Step 1 paused on a blocking PROPOSED approval, stop immediately & skip Step 2!
            const pausedBlocking =
              result.paused &&
              blockingPendingApprovals([latestStepMsg]).length > 0;
            const finalStepMsg: UIMessage =
              result.paused && lockedSteps[i + 1]
                ? {
                    ...latestStepMsg,
                    metadata: {
                      ...stepMetadata,
                      ...(readMessageMetadata(latestStepMsg) ?? {}),
                      stepStatus: pausedBlocking ? "BLOCKED_APPROVAL" : "COMPLETED",
                      skippedNextRole: lockedSteps[i + 1].role,
                      skippedNextObjective: lockedSteps[i + 1].objective,
                    },
                  }
                : latestStepMsg;
            producedMessages.push(finalStepMsg);
            workingMessages.push(finalStepMsg);

            if (result.paused) {
              await prisma.chatTurnStep.update({
                where: { id: stepId },
                data: { status: pausedBlocking ? "BLOCKED_APPROVAL" : "COMPLETED" },
              });
              if (stepRowIds[i + 1]) {
                await prisma.chatTurnStep.update({
                  where: { id: stepRowIds[i + 1] },
                  data: { status: "SKIPPED", errorCode: "STEP1_APPROVAL_REQUIRED" },
                });
                emitStatus({
                  phase: "step_blocked",
                  turnId: createdTurnId!,
                  stepIndex: i,
                  stepCount: lockedSteps.length,
                  role: step.role,
                  nextRole: lockedSteps[i + 1].role,
                });
              }
              lastCompletedRole = step.role;
              break;
            }

            await prisma.chatTurnStep.update({
              where: { id: stepId },
              data: { status: "COMPLETED" },
            });
            lastCompletedRole = step.role;
          }
        } catch (stepError) {
          const isAbort =
            turnSignal.aborted ||
            (stepError instanceof Error && stepError.name === "AbortError");
          const errCode =
            stepError instanceof AIBusinessError ? stepError.code : "STEP_EXECUTION_FAILED";
          await prisma.chatTurnStep.update({
            where: { id: stepId },
            data: {
              status: isAbort ? "CANCELLED" : "FAILED",
              errorCode: isAbort ? "CANCELLED" : errCode,
            },
          });
          for (let j = i + 1; j < stepRowIds.length; j += 1) {
            await prisma.chatTurnStep.update({
              where: { id: stepRowIds[j] },
              data: { status: isAbort ? "CANCELLED" : "SKIPPED" },
            });
          }
          // D05/D07: if Step 1 succeeded and Step 2 failed at runtime, preserve Step 1
          // and surface honest Step 2 failure with single-step retry metadata instead of aborting Step 1!
          if (i > 0 && !isAbort) {
            emitStatus({
              phase: "step_failed",
              turnId: createdTurnId!,
              stepIndex: i,
              stepCount: lockedSteps.length,
              role: step.role,
              errorCode: errCode,
              message: formatAgentStreamError(stepError, {
                provider: step.provider,
                model: step.model,
              }),
            });
            break;
          }
          throw stepError;
        }
      }

      emitStatus({ phase: "done", turnId: createdTurnId ?? undefined });
    },
    onError: (error) => {
      turnFailed = true;
      return formatAgentStreamError(error);
    },
    onFinish: async ({ messages: finalMessages, isAborted }) => {
      if (isAborted || turnFailed) {
        if (createdTurnId) {
          await prisma.chatTurn
            .update({
              where: { id: createdTurnId },
              data: { status: isAborted ? "CANCELLED" : "FAILED" },
            })
            .catch(() => undefined);
        }
        await cancelConversationRequest(userId, conversationId, request.requestId);
        return;
      }

      const finalRole = lastCompletedRole ?? currentActiveRole ?? "pilot";
      // For multi-step turns (or Step 2 runtime failure preserving Step 1, or approval stop),
      // persist each step as its own UIMessage with immutable role metadata instead of AI SDK's
      // single merged response message.
      let persistedMessages: UIMessage[];
      if (producedMessages.length > 1) {
        persistedMessages = [...messages, ...producedMessages];
      } else if (producedMessages.length === 1) {
        const only = producedMessages[0];
        if (operation === "approval" && messages.at(-1)?.id === only.id) {
          // For approval continuation, let finalMessages keep the resolved approval parts while preserving metadata.
          persistedMessages = finalMessages.map((m) =>
            m.id === only.id
              ? {
                  ...m,
                  metadata: {
                    ...(readMessageMetadata(only) ?? {}),
                    ...(readMessageMetadata(m) ?? {}),
                  },
                }
              : m,
          );
        } else if (only.parts.length > 0) {
          persistedMessages = [...messages, only];
        } else {
          persistedMessages = finalMessages;
        }
      } else {
        persistedMessages = finalMessages;
      }
      await finishConversationRequest(request, stubConsumedPastes(persistedMessages));
      await prisma.chatConversation
        .updateMany({
          where: { id: conversationId, userId },
          data: { activeRole: finalRole },
        })
        .catch(() => undefined);

      if (createdTurnId) {
        const steps = await prisma.chatTurnStep.findMany({
          where: { turnId: createdTurnId },
          select: { status: true },
        });
        const anyFailed = steps.some((s) => s.status === "FAILED");
        const anyBlocked = steps.some((s) => s.status === "BLOCKED_APPROVAL");
        const turnStatus = anyBlocked
          ? "BLOCKED_APPROVAL"
          : anyFailed
            ? "PARTIAL"
            : "COMPLETED";
        await prisma.chatTurn
          .update({
            where: { id: createdTurnId },
            data: { status: turnStatus },
          })
          .catch(() => undefined);
      }

      // M1 summary (session-level, only when a managed/BYOK/account orchestrated step ran).
      if (lastManagedStep) {
        scheduleCareerDialogueSummary({
          userId,
          conversationId,
          resolvedConnectionId: lastManagedStep.connectionId,
          resolvedModel: lastManagedStep.model,
          resolvedProvider: lastManagedStep.provider,
          resolvedBackendKind: lastManagedStep.backendKind,
          resolvedUpstreamModelId: lastManagedStep.managedAiProvenance?.upstreamModelId,
          messages: request.messages,
        });
      }

      // D04: M2.1 background memory curation fires ONCE per Turn.
      scheduleLongTermMemoryExtraction({ userId, conversationId });

      if (taskSession) {
        try {
          scheduleTaskHandoff({
            userId,
            conversationId,
            taskId: taskSession.taskId,
            messages: request.messages,
          });
        } catch {
          log.info("[agent-task] handoff", { status: "failed", reason: "trigger" });
        }
      }
    },
  });

  return createUIMessageStreamResponse({
    stream: conversationCommitStream(stream, request),
  });
}
