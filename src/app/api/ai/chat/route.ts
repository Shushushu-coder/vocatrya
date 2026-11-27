import { nativeChatResponse } from "@/lib/agent/nativeChatResponse";
import { nativeBusinessAllowedTools } from "@/lib/agent/nativeBusinessMcp.server";
import { loadAgentPreferences } from "@/lib/agent/preferences.server";
import { personalInstructionsBlock, permissionInstructions, permissionModeOfContext } from "@/lib/agent/preferences";
import { assertManagedHistoricalExecution } from "@/lib/ai/managed-provenance";
import { hasArchivedJobReference } from "@/lib/agent/archiveVisibility";
import { generateId } from "ai";
import { admitConversationRequest, cancelConversationRequest, finishConversationRequest, ConversationRequestError, type ConversationRequest } from "@/lib/agent/conversationRequest";
import { resolveNotionAgentToolNames } from "@/lib/extensions/notion/service";
import { resolveFeishuAgentToolNames } from "@/lib/extensions/feishu/service";
import { conversationCommitStream } from "@/lib/agent/conversationStream";
import "server-only";

import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  hasToolCall,
  isToolUIPart,
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type StopCondition,
  type UIMessage,
} from "ai";
import { getModel, type ProviderType } from "@/lib/ai/providers";
import { checkRateLimit } from "@/lib/ai/rate-limiter";
import { TEMPERATURES } from "@/lib/ai/config";
import { APP_CONSTANTS } from "@/lib/constants";
import { AgentChatRequestSchema } from "@/models/agent.schema";
import {
  buildAgentChatSystemPrompt,
  AGENT_PASTE_ONLY_USER_MESSAGE,
  buildFileContextMessage,
  buildPageContextMessage,
  buildPasteContextMessage,
} from "@/lib/agent/prompt";
import { buildResumeEvidencePromptAddendum } from "@/lib/agent/skills/resumeEvidence/session";
import { LOCALE_COOKIE_NAME, normalizeLocale } from "@/i18n";
import {
  resolvePastedText,
  stubConsumedPastes,
} from "@/lib/agent/paste";
import {
  agentFilePlaceholder,
  resolveFileTexts,
} from "@/lib/agent/agentFiles";
import {
  careerDialogueContextLogFields,
  currentUserExceedsContextBudget,
  resolveCareerDialogueBudgets,
  selectCareerDialogueMessages,
  type CareerDialogueContextSize,
} from "@/lib/agent/contextBudget";
import {
  AGENT_CONTEXT_USAGE_PART_TYPE,
  type AgentContextUsage,
} from "@/lib/agent/contextUsage";
import { isAgentFilePart } from "@/models/agent.model";
import { truncateForModel } from "@/lib/agent/paste.server";
import { buildAgentTools } from "@/lib/agent/tools";
import { measureTurnPrefix, type TurnPrefixMetrics } from "@/lib/agent/turnMetrics";
import {
  agentErrorEnvelope,
  formatAgentStreamError,
} from "@/lib/agent/errors";
import { getUserSettings } from "@/actions/userSettings.actions";
import {
  pageContextFromConversation,
  type AgentConversationContextV1,
} from "@/lib/agent/conversationContext";
import { AiProvider } from "@/models/ai.model";
import {
  genAiRequestAttrs,
  genAiResponseAttrs,
  log,
  runInSpan,
  startSpan,
  SURFACES,
} from "@/lib/telemetry";
import { addJobSettled, AGENT_CHAT_TERMINAL_TOOLS } from "@/models/agent.model";
import prisma from "@/lib/db";
import { isFullAbCapabilityEnabled } from "@/lib/career/capabilities";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import {
  contextOfRow,
  getOwnedChatConversation,
} from "@/lib/agent/chatConversationStore";
import { chatLockFromRow } from "@/lib/agent/chatConversationLock";
import { checkStreamingTurnReadiness } from "@/lib/ai/streaming-execution";
import { careerDialogueObservabilityFields } from "@/lib/agent/careerDialogueRoute";
import {
  prepareCareerDialogueTurn,
  runCareerDialogueTurn,
} from "@/lib/agent/careerDialogueTurn";
import { AIBusinessError, classifyAIConnection } from "@/lib/ai/connections";
import { loadConversationSummaryStatus } from "@/lib/agent/conversationSummaryStore";
import { scheduleCareerDialogueSummary } from "@/lib/agent/conversationSummaryScheduler";
import { resolveVerifiedBusinessAnchors } from "@/lib/agent/businessAnchors.server";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import {
  resolveTaskSessionContext,
  type TaskSessionContext,
} from "@/lib/agent/task/agentTaskBootstrap";
import { scheduleTaskHandoff } from "@/lib/agent/task/agentTaskHandoffTrigger";
import {
  managedMemoryBlockForConversation,
  nativeMemoryBlockForConversation,
} from "@/lib/agent/longTermMemory.server";
import {
  scheduleLongTermMemoryExtraction,
  scheduleNativeMemoryExtractionAfterRelease,
} from "@/lib/agent/longTermMemoryExtractor.server";
import { unifiedChatResponse } from "@/lib/agent/unifiedTurnOrchestrator.server";
import { userHasUnifiedModelConfig } from "@/lib/agent/unifiedModelResolver.server";

// The one terminal tool whose stop condition is not "was it called" — see
// addJobSettled.
const addJobSettledStop: StopCondition<any> = ({ steps }) =>
  addJobSettled(steps[steps.length - 1] ?? {});

// Task-session handoff trigger. scheduleTaskHandoff is already fire-and-forget
// and non-throwing; the catch is the last line of defence so a handoff problem
// can never surface in the user's turn (their reply is already committed).
function triggerTaskHandoff(input: Parameters<typeof scheduleTaskHandoff>[0]) {
  try {
    scheduleTaskHandoff(input);
  } catch {
    log.info("[agent-task] handoff", { status: "failed", reason: "trigger" });
  }
}

// One structured line per turn. Sizes and outcomes only — never the pasted
// posting and never the extracted arguments.
function logTurn(fields: Record<string, unknown>) {
  log.info("[agent-chat] turn", fields);
}

function outcomeOf(message: UIMessage | undefined): {
  tool: string | null;
  state: string | null;
  outcome: string;
} {
  for (const part of message?.parts ?? []) {
    if (!isToolUIPart(part)) continue;
    const tool = part.type.replace(/^tool-/, "");
    if (part.state !== "output-available") {
      return { tool, state: part.state, outcome: part.state };
    }
    const output = part.output as
      | { status?: string; created?: boolean; validationError?: string }
      | undefined;
    // Discriminated on shape, not on tool name: a name allowlist logged a
    // resume read as "duplicate" once already. Status-carrying results report
    // their own outcome, and add_job is the only shape without a status field,
    // so it is the fallback rather than the default.
    if (typeof output?.status === "string") {
      return { tool, state: part.state, outcome: output.status };
    }
    const outcome = output?.validationError
      ? "validation"
      : output?.created
        ? "created"
        : "duplicate";
    return { tool, state: part.state, outcome };
  }
  return { tool: null, state: null, outcome: "none" };
}

/**
 * The ACCOUNT lock path: the conversation's pinned AIConnection + model run
 * every step of the turn on the managed runtime — Vocatrya owns the tool
 * orchestration, the runtime only produces text and decisions.
 */
async function accountChatResponse({
  permissionMode,
  personalInstructions,
  req,
  userId,
  conversationId,
  messages,
  pastedText,
  fileTexts,
  pageContext,
  conversationContext,
  lock,
  freshNativeFull,
  canonicalJobs,
  request,
  agentRole,
  notionTools,
  feishuTools,
  taskSession,
  managed,
}: {
  permissionMode: import("@/lib/agent/preferences").PermissionMode;
  personalInstructions: string;
  req: NextRequest;
  userId: string;
  conversationId: string;
  messages: UIMessage[];
  pastedText: string | undefined;
  fileTexts: { name: string; text: string }[];
  pageContext: Parameters<typeof buildPageContextMessage>[0];
  conversationContext?: AgentConversationContextV1;
  lock: { connectionId: string; model: string | null };
  freshNativeFull: boolean;
  canonicalJobs: boolean;
  request: ConversationRequest;
  /**
   * Multi-agent role read from the persisted conversation row — never from
   * the request body. It narrows the tool registry and selects the prompt
   * variant; NULL keeps the general assistant.
   */
  agentRole?: string | null;
  /**
   * EXT-NOTION: agent-tool names the connected session serves, resolved in
   * the route's admission step. Empty/omitted registers nothing.
   */
  notionTools?: readonly string[];
  /** EXT-FEISHU: same contract as notionTools, resolved beside it. */
  feishuTools?: readonly string[];
  /**
   * Agent long-task session context (Pilot conversation bound to an ACTIVE
   * task), resolved by the route. Null/omitted for ordinary conversations,
   * which then take none of the task paths below.
   */
  taskSession?: TaskSessionContext | null;
  /** Managed-locked turn — provenance + operation identity (M4). */
  managed?: import("@/lib/agent/accountTurn").ManagedTurnContext;
}) {
  // The lock is a provenance pointer — the connection's CURRENT state is
  // re-checked every turn (disconnect/reauth/archive degrade it), and it is
  // ownership-scoped, so a lock can never name another user's connection.
  const connection = await prisma.aIConnection.findFirst({
    where: { id: lock.connectionId, userId },
    select: {
      id: true,
      status: true,
      backendKind: true,
      provider: true,
      authType: true,
      credentialRef: true,
      runtimeProfileRef: true,
      accountIdentity: true,
      archivedAt: true,
    },
  });
  const errorContext = {
    provider: connection?.provider ?? "account runtime",
    model: lock.model ?? undefined,
  };
  const deny = (error: unknown) =>
    NextResponse.json(agentErrorEnvelope(error, errorContext), { status: 503 });
  if (!connection || connection.archivedAt) {
    return deny(
      new AIBusinessError(
        "ASSIGNED_CONNECTION_UNAVAILABLE",
        "The locked AI connection is not available",
      ),
    );
  }
  if (!managed && classifyAIConnection(connection) === "MANAGED") {
    // Half-state (M4): the row names a Managed connection but carries no
    // provenance — fail closed rather than silently binding at run time.
    return deny(
      new AIBusinessError(
        "MANAGED_PROVENANCE_INVALID",
        "The conversation's Managed binding record is incomplete",
      ),
    );
  }
  try {
    await checkStreamingTurnReadiness({
      connection,
      model: lock.model,
      userId,
    });
  } catch (error) {
    return deny(error);
  }

  const rawLocale = req.cookies?.get?.(LOCALE_COOKIE_NAME)?.value;
  const locale = normalizeLocale(rawLocale);
  const systemPrompt = buildAgentChatSystemPrompt(locale, {
    freshNativeFull,
    agentRole,
    notionTools,
    feishuTools,
    taskExtraTools: taskSession?.extraTools,
  }) + personalInstructionsBlock(personalInstructions) + permissionInstructions(permissionMode)
    + buildResumeEvidencePromptAddendum({ messages, agentRole });

  const resolvedBudgets = resolveCareerDialogueBudgets({
    model: lock.model,
    upstreamModelId: managed?.provenance.upstreamModelId,
    provider: connection.provider,
    backendKind: connection.backendKind,
  });

  // Route on the full request. Budgeting happens inside the turn, after
  // the local router has seen the current utterance.
  if (currentUserExceedsContextBudget(messages, resolvedBudgets.budgets)) {
    return deny(
      new AIBusinessError(
        "AI_REQUEST_TOO_LARGE",
        "Current user message exceeds the Career Dialogue input budget",
      ),
    );
  }
  const prepared = await prepareCareerDialogueTurn({
    messages,
    pageContext,
    connection: {
      backendKind: connection.backendKind,
      provider: connection.provider,
    },
    managed: managed
      ? { userId, model: lock.model ?? "" }
      : undefined,
  });
  const routeFields = careerDialogueObservabilityFields({
    decision: prepared.decision,
    routerDurationMs: prepared.routerDurationMs,
    conversationId,
    connectionId: connection.id,
    model: lock.model,
  });
  if (!prepared.ok) {
    logTurn({
      ...routeFields,
      provider: managed ? "managed:VOCATRYA" : `account:${connection.provider}`,
      backendKind: connection.backendKind,
      outcome: "capability_blocked",
    });
    return deny(prepared.error);
  }

  // Same abort contract as the legacy path: client disconnect / stop()
  // aborts the runtime child through the execute-stream socket.
  const executionAbort = new AbortController();
  request.abort = () => executionAbort.abort();
  const turnSignal = AbortSignal.any([
    executionAbort.signal,
    req.signal,
    AbortSignal.timeout(APP_CONSTANTS.AGENT_CHAT_TIMEOUT_MS),
  ]);

  const turnSpan = startSpan("agent.chat.turn", {
    ...genAiRequestAttrs({
      provider: connection.provider,
      model: lock.model ?? "",
      temperature: TEMPERATURES.ANALYSIS,
      numCtx: APP_CONSTANTS.AGENT_CHAT_NUM_CTX,
      surface: SURFACES.AGENT_CHAT,
      system: systemPrompt,
      prompt: [],
    }),
    "jobsync.user_id": userId,
    "jobsync.backend_kind": connection.backendKind,
    "jobsync.connection_id": connection.id,
  });

  let contextSize: CareerDialogueContextSize | undefined;
  let turnFailed = false;
  const alreadyMapped = new Set<string>();
  const mapTurnError = (error: unknown): string =>
    runInSpan(turnSpan, () => {
      turnFailed = true;
      const message = error instanceof Error ? error.message : "";
      if (alreadyMapped.has(message)) return message;
      const mapped = formatAgentStreamError(error, errorContext);
      alreadyMapped.add(mapped);
      return mapped;
    });

  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: async ({ writer }) => {
      request.onCheckpoint = () => writer.write({ type: "data-conversation", transient: true, data: { conversationId, requestId: request.requestId, revision: request.revision, durable: true, released: false, wrote: request.wrote } });
      await runInSpan(turnSpan, async () => {
        const summaryStatus = await loadConversationSummaryStatus({
          userId,
          conversationId,
          messages,
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
            // Best-effort grounding; never fail a live turn.
          }
        }
        // M2.1: untrusted cross-session memory via the session-frozen
        // block — background extraction must not mutate the next turn's
        // prefix (prefix-cache protection). Refreshed only on new session,
        // compaction commit, or user memory edits; best-effort like the
        // anchor, never fails a turn.
        const longTermMemoryLine =
          (await managedMemoryBlockForConversation(userId, conversationId).catch(() => "")) || undefined;
        const result = await runCareerDialogueTurn({
          userId,
          connectionId: connection.id,
          provider: connection.provider,
          backendKind: connection.backendKind,
          modelName: lock.model ?? "",
          managed,
          systemPrompt,
          messages,
          pastedText,
          fileTexts,
          pageContext,
          summary: summaryStatus.freshSummary,
          budgets: resolvedBudgets.budgets,
          autoCompactTriggerTokens: resolvedBudgets.autoCompactTriggerTokens,
          businessAnchorLine,
          longTermMemoryLine,
          writer,
          signal: turnSignal,
          decision: prepared.decision,
          routerDurationMs: prepared.routerDurationMs,
          freshNativeFull,
          canonicalJobs,
          request,
          agentRole,
          notionTools,
          feishuTools,
          permissionMode,
          agentTaskId: taskSession?.taskId,
          handoffLine: taskSession?.handoffLine,
          taskExtraTools: taskSession?.extraTools,
        });
        contextSize = result.contextSize;
        // The budgeter's estimate for the turn that just ran, streamed back
        // so the composer toolbar can show real assembly usage. Transient —
        // it is transport, not transcript.
        if (contextSize) {
          const usage: AgentContextUsage = {
            conversationId,
            requestId: request.requestId,
            profile: contextSize.contextProfile,
            estimatedInputTokens: contextSize.estimatedInputTokens,
            recentTurnCount: contextSize.recentTurnCount,
            droppedTurnCount: contextSize.droppedTurnCount,
            modelContextWindowTokens: resolvedBudgets.contextWindowTokens,
            modelContextWindowSource: resolvedBudgets.contextWindowSource,
            autoCompactTriggerTokens: resolvedBudgets.autoCompactTriggerTokens,
            microCompactedToolCount: contextSize.microCompactedToolCount,
            compactedTurnCount: contextSize.compactedTurnCount,
            hasSummary: Boolean(summaryStatus.freshSummary),
            circuitBreakerOpen: summaryStatus.circuitBreakerOpen,
            failureCount: summaryStatus.failureCount,
            tokens: {
              system: contextSize.systemTokens,
              currentUser: contextSize.currentUserTokens,
              history: contextSize.historyTokens,
              explicitContext: contextSize.explicitContextTokens,
              toolResult: contextSize.toolResultTokens,
              summary: contextSize.summaryTokens,
              dynamic: contextSize.dynamicTokens,
              ...(contextSize.businessAnchorTokens > 0
                ? { businessAnchor: contextSize.businessAnchorTokens }
                : {}),
              ...(contextSize.handoffTokens > 0
                ? { handoff: contextSize.handoffTokens }
                : {}),
              ...(contextSize.longTermMemoryTokens > 0
                ? { longTermMemory: contextSize.longTermMemoryTokens }
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
      });
    },
    onFinish: async ({ messages: finalMessages, responseMessage, isAborted }) => {
      const { tool, state, outcome } = outcomeOf(responseMessage);
      runInSpan(turnSpan, () =>
        logTurn({
          ...routeFields,
          provider: managed ? "managed:VOCATRYA" : `account:${connection.provider}`,
          backendKind: connection.backendKind,
          tool,
          toolState: state,
          outcome,
          aborted: isAborted,
          pasteChars: pastedText?.length ?? 0,
          messageCount: finalMessages.length,
          historyDropped: contextSize?.droppedTurnCount ?? 0,
          ...(contextSize ? careerDialogueContextLogFields(contextSize) : {}),
        }),
      );
      turnSpan.end({
        "jobsync.route": prepared.decision.route,
        "jobsync.reason_code": prepared.decision.reason,
        "jobsync.router_ms": routeFields.routerDurationMs,
        "jobsync.tool": tool,
        "jobsync.tool_state": state,
        "jobsync.outcome": outcome,
        "jobsync.aborted": isAborted,
        "jobsync.paste_chars": pastedText?.length ?? 0,
        "jobsync.message_count": finalMessages.length,
        "jobsync.history_dropped": contextSize?.droppedTurnCount ?? 0,
        ...(contextSize
          ? {
              "jobsync.context_profile": contextSize.contextProfile,
              "jobsync.estimated_input_tokens": contextSize.estimatedInputTokens,
              "jobsync.recent_turn_count": contextSize.recentTurnCount,
              "jobsync.dropped_turn_count": contextSize.droppedTurnCount,
              "jobsync.explicit_context_units": contextSize.explicitContextTokens,
              "jobsync.tool_result_units": contextSize.toolResultTokens,
              "jobsync.summary_units": contextSize.summaryTokens,
            }
          : {}),
      });
      // Same write-on-finish contract as the legacy path: a cancelled turn
      // never writes back (Clear would otherwise resurrect).
      if (isAborted || turnFailed) {
        await cancelConversationRequest(userId, conversationId, request.requestId);
        return;
      }
      await finishConversationRequest(request, stubConsumedPastes(finalMessages));
      scheduleCareerDialogueSummary({
        userId,
        conversationId,
        resolvedConnectionId: lock.connectionId,
        resolvedModel: lock.model,
        resolvedProvider: connection.provider,
        resolvedBackendKind: connection.backendKind,
        resolvedUpstreamModelId: managed?.provenance.upstreamModelId,
        messages: request.messages,
      });
      // M2: detached background memory extraction — prefilter-gated,
      // circuit-broken, never awaited. A failure only delays learning.
      scheduleLongTermMemoryExtraction({ userId, conversationId });
      // Task sessions only. Fire-and-forget and self-containing: a handoff
      // failure is logged and backed off, never surfaced to this turn.
      if (taskSession) {
        triggerTaskHandoff({
          userId,
          conversationId,
          taskId: taskSession.taskId,
          messages: request.messages,
        });
      }
    },
    onError: mapTurnError,
  });

  return createUIMessageStreamResponse({ stream: conversationCommitStream(stream, request) });
}

const executePost = async (req: NextRequest, admitted: (request: ConversationRequest) => void) => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!session || !userId) {
    return NextResponse.json(
      { error: "Not Authenticated", code: "NOT_AUTHENTICATED" },
      { status: 401 },
    );
  }

  const rateLimit = checkRateLimit(userId, "chat");
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: `Rate limit exceeded. Try again in ${Math.ceil(rateLimit.resetIn / 1000)} seconds.`,
        code: "RATE_LIMITED",
      },
      { status: 429 },
    );
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid chat request.", code: "INVALID_REQUEST" }, { status: 400 }); }
  const parsed = AgentChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid chat request.", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const { conversationId } = parsed.data;
  const nativeCandidate = await getOwnedChatConversation(userId, conversationId);
  if (
    nativeCandidate?.executionPath === "NATIVE_CODEX_V1" &&
    nativeCandidate.chatMode !== "UNIFIED" &&
    (parsed.data.operation !== "send" ||
      parsed.data.newMessage.parts.some(part => part.type !== "text"))
  ) {
    throw new AIBusinessError("NATIVE_TEXT_ONLY", "Native sessions do not regenerate or replay tools");
  }
  const request = await admitConversationRequest({ ...parsed.data, userId });
  request.responseMessageId = request.messages.at(-1)?.role === "assistant" ? request.messages.at(-1)!.id : generateId();
  admitted(request);
  const messages = request.messages;
  const pastedText = resolvePastedText(messages);
  // Extracted text of the files attached to THIS send — injected on this
  // turn only (AWU-FILES). Later turns see the part's placeholder line.
  const fileTexts = resolveFileTexts(messages);
  const conversation = await getOwnedChatConversation(userId, conversationId);
  if (!conversation) throw new ConversationRequestError("CONVERSATION_NOT_FOUND");
  if (conversation.archivedAt || await hasArchivedJobReference(
    prisma, userId, conversation.context, conversation.messages, request.messages,
  )) {
    throw new ConversationRequestError("CONVERSATION_ARCHIVED_CONTENT");
  }
  const preferences = await loadAgentPreferences(userId);
  const permissionMode = permissionModeOfContext(conversation.context);
  const unifiedHeader = req.headers?.get?.("x-vocatrya-unified-chat") === "1";
  const shouldRunUnified =
    conversation.chatMode === "UNIFIED" ||
    parsed.data.operation === "retry_step" ||
    parsed.data.operation === "reanswer" ||
    (unifiedHeader &&
      conversation.executionPath !== "NATIVE_CODEX_V1" &&
      (await userHasUnifiedModelConfig(userId)));
  if (shouldRunUnified) {
    const unifiedConversationContext = contextOfRow(conversation);
    const [unifiedTaskSession, unifiedCareerRuntime, unifiedNotionTools, unifiedFeishuTools] =
      await Promise.all([
        resolveTaskSessionContext(prisma, {
          userId,
          agentTaskId: conversation.agentTaskId,
          agentRole: conversation.activeRole ?? conversation.agentRole ?? "pilot",
          locale: normalizeLocale(req.cookies?.get?.(LOCALE_COOKIE_NAME)?.value),
        }),
        resolveCareerRuntimeMode(prisma),
        resolveNotionAgentToolNames(userId).catch(() => []),
        resolveFeishuAgentToolNames(userId).catch(() => []),
      ]);
    const unifiedFreshNativeFull = isFreshNativeFullSurface(unifiedCareerRuntime);
    const unifiedCanonicalJobs = isFullAbCapabilityEnabled(
      unifiedCareerRuntime.mode,
      unifiedCareerRuntime.rolloutScope,
    );
    return unifiedChatResponse({
      req,
      userId,
      conversationId,
      conversation,
      request,
      operation: parsed.data.operation,
      forcedRole: parsed.data.operation === "reanswer" ? parsed.data.role : null,
      retryTurnId: parsed.data.operation === "retry_step" ? parsed.data.turnId : undefined,
      retryStepIndex: parsed.data.operation === "retry_step" ? parsed.data.stepIndex : undefined,
      reanswerTargetMessageId:
        parsed.data.operation === "reanswer" ? parsed.data.targetMessageId : undefined,
      permissionMode,
      personalInstructions: preferences.personalInstructions,
      pastedText,
      fileTexts,
      conversationContext: unifiedConversationContext,
      freshNativeFull: unifiedFreshNativeFull,
      canonicalJobs: unifiedCanonicalJobs,
      notionTools: unifiedNotionTools,
      feishuTools: unifiedFeishuTools,
      taskSession: unifiedTaskSession,
    });
  }
  let lock: ReturnType<typeof chatLockFromRow>;
  let managedTurn: import("@/lib/agent/accountTurn").ManagedTurnContext | undefined;
  try {
    lock = chatLockFromRow(conversation);
    if (lock.kind === "managed") {
      const connection = lock.connectionId ? await prisma.aIConnection.findFirst({
        where: { id: lock.connectionId, userId },
      }) : null;
      // M4: the persisted binding is executable — validate it is intact,
      // then run every model call in this turn on the stored provenance.
      // `conversation:<id>` is the same resourceKey the creation-time
      // bind used; requestId makes the turn a durable operation.
      assertManagedHistoricalExecution(lock, connection, userId);
      managedTurn = {
        provenance: lock.provenance,
        resourceKey: `conversation:${conversationId}`,
        operationId: `dialogue:${conversationId}:${request.requestId}`,
      };
    }
  } catch (error) {
    // Preserve explicit Managed errors through the request settlement wrapper.
    if (error instanceof AIBusinessError) {
      return NextResponse.json(agentErrorEnvelope(error), { status: 503 });
    }
    throw error;
  }
  if (conversation.executionPath === "NATIVE_CODEX_V1") {
    if (lock.kind !== "account" || !lock.model || contextOfRow(conversation).items.length) throw new AIBusinessError("NATIVE_TEXT_ONLY", "Start a plain-text native conversation without page context");
    // M2: the memory block a native thread was created with is frozen on
    // the conversation row — every later turn of that thread re-uses it so
    // a mid-thread memory update never invalidates the prompt-hash binding.
    const nativeMemory = await nativeMemoryBlockForConversation(userId, conversationId);
    scheduleNativeMemoryExtractionAfterRelease(request, { userId, conversationId });
    // Slice-2 business bridge: reuse the exact runtime mode, role, task, and
    // integration capability resolvers the in-app path uses — never hardcode
    // static role write lists.
    const [careerRuntime, nativeNotionTools, nativeFeishuTools, nativeTaskSession] = await Promise.all([
      resolveCareerRuntimeMode(prisma),
      resolveNotionAgentToolNames(userId).catch(() => []),
      resolveFeishuAgentToolNames(userId).catch(() => []),
      resolveTaskSessionContext(prisma, {
        userId,
        agentTaskId: conversation.agentTaskId,
        agentRole: conversation.agentRole,
        locale: normalizeLocale(req.cookies?.get?.(LOCALE_COOKIE_NAME)?.value),
      }).catch(() => null),
    ]);
    const nativeFreshNativeFull = isFreshNativeFullSurface(careerRuntime);
    const nativeCanonicalJobs = isFullAbCapabilityEnabled(
      careerRuntime.mode,
      careerRuntime.rolloutScope,
    );
    const allowedBusinessTools = nativeBusinessAllowedTools({
      agentRole: conversation.agentRole,
      freshNativeFull: nativeFreshNativeFull,
      notionTools: nativeNotionTools,
      feishuTools: nativeFeishuTools,
      taskExtraTools: nativeTaskSession?.extraTools,
    });
    const turnKey =
      [...request.messages].reverse().find((m) => m.role === "user")?.id ??
      request.requestId;
    return nativeChatResponse({
      request,
      signal: req.signal,
      connectionId: lock.connectionId,
      model: lock.model,
      origin: req.nextUrl.origin,
      allowedBusinessTools,
      permissionMode,
      agentRole: conversation.agentRole,
      turnKey,
      freshNativeFull: nativeFreshNativeFull,
      canonicalJobs: nativeCanonicalJobs,
      taskExtraTools: nativeTaskSession?.extraTools,
      instructions:
        "You are Vocatrya, a career conversation assistant. Native web search is enabled and you may use it when current or external web information is needed. Controlled business tools for the user's Vocatrya data (jobs, resumes, today's plan, and any connected Notion or Feishu tools permitted for this session) are available through the vocatrya_business MCP server — use tool_search to discover and call them when needed. Skills are not loaded in this session. Never claim to have searched the web unless you actually used web search. When a write tool returns status \"approval_required\" with a proposalId, explain clearly that a confirmation card has been created and is awaiting user approval — never claim the write was saved or completed. When a write tool returns status \"queued\", explain that it is queued for background execution — never claim it is already written. Never claim a business read or write succeeded unless the tool returned a verified result." +
        permissionInstructions(permissionMode) +
        personalInstructionsBlock(preferences.personalInstructions) +
        nativeMemory,
    });
  }
  const conversationContext = contextOfRow(conversation);
  const pageContext = pageContextFromConversation(conversationContext);

  // Agent long-task harness: null (no DB access) unless the conversation is
  // bound to a task, so ordinary chats are untouched.
  const taskSession = await resolveTaskSessionContext(prisma, {
    userId,
    agentTaskId: conversation.agentTaskId,
    agentRole: conversation.agentRole,
    locale: normalizeLocale(req.cookies?.get?.(LOCALE_COOKIE_NAME)?.value),
  });

  // One resolution per turn. Fresh-native full keeps add_job and withholds
  // match_job and generate_cover_letter. Any AB_ENABLED + full runtime,
  // including migrated full, writes add_job through the canonical service.
  const careerRuntime = await resolveCareerRuntimeMode(prisma);
  const freshNativeFull = isFreshNativeFullSurface(careerRuntime);
  const canonicalJobs = isFullAbCapabilityEnabled(
    careerRuntime.mode,
    careerRuntime.rolloutScope,
  );

  // EXT-NOTION / EXT-FEISHU: one indexed row read per turn. Connection state
  // is re-asserted inside each tool at execution time, so a mid-turn
  // disconnect still cannot run a remote call.
  const notionTools = await resolveNotionAgentToolNames(userId).catch(
    () => [],
  );
  const feishuTools = await resolveFeishuAgentToolNames(userId).catch(
    () => [],
  );

  if (lock.kind === "account" || lock.kind === "managed") {
    return accountChatResponse({
      permissionMode,
      personalInstructions: preferences.personalInstructions,
      req,
      userId,
      conversationId,
      messages,
      pastedText,
      fileTexts,
      pageContext,
      conversationContext,
      lock: lock as { connectionId: string; model: string | null },
      freshNativeFull,
      canonicalJobs,
      request,
      agentRole: conversation.agentRole,
      notionTools,
      feishuTools,
      taskSession,
      managed: managedTurn,
    });
  }

  // Legacy path — historical null-lock conversations and conversations
  // created while no CAREER_DIALOGUE/GLOBAL_DEFAULT assignment exists keep
  // the settings.ai provider/model semantics exactly as before.
  const settings = await getUserSettings();
  const ai = settings?.data?.settings?.ai;
  // provider is always present — defaultUserSettings supplies it. model is
  // not, and it is NOT substituted: picking a model the user never chose
  // turns a knowable configuration error into a mid-stream "model not
  // found" naming something they never configured.
  const provider = (ai?.provider ?? AiProvider.OLLAMA) as ProviderType;
  const modelName = ai?.model;
  if (!modelName) {
    return NextResponse.json(
      {
        error: "No AI model is configured. Pick one in Settings to use the assistant.",
        code: "AI_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }
  const errorContext = { provider, model: modelName };

  let model;
  try {
    model = await getModel(provider, modelName, userId);
  } catch (error) {
    return NextResponse.json(agentErrorEnvelope(error, errorContext), {
      status: 503,
    });
  }

  // Async in ai@6 (correction #5), and the messages array is client-supplied
  // — a shape z.array(z.any()) let through can reject the conversion, and
  // that is a bad request, not a server crash.
  const legacyBudgets = resolveCareerDialogueBudgets({
    model: modelName,
    provider,
  }).budgets;
  if (currentUserExceedsContextBudget(messages, legacyBudgets)) {
    return NextResponse.json(
      agentErrorEnvelope(
        new AIBusinessError(
          "AI_REQUEST_TOO_LARGE",
          "Current user message exceeds the Career Dialogue input budget",
        ),
        errorContext,
      ),
      { status: 503 },
    );
  }

  // Same budgeter as the account runtimes. windowMessages remains the older
  // count-based helper; retained turns are what this path sends.
  // An unknown role is a bad request. Budgeting only understands user and
  // assistant turns, so the SDK still has to see the original array and
  // reject it.
  const convertible = messages.every(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const retained = convertible ? selectCareerDialogueMessages(messages, legacyBudgets) : messages;
  let modelMessages;
  try {
    // An approved request that was cancelled before its tool checkpoint must
    // never be transparently resumed by a subsequent ordinary SDK send.
    const executionMessages = retained.map(message => ({ ...message, parts: message.parts.map(part => {
      if (isToolUIPart(part) && (part.state === "approval-responded" || part.state === "approval-requested") && part.toolCallId !== request.approvalToolCallId) {
        return { ...part, state: "output-error" as const, approval: undefined, errorText: part.state === "approval-requested" ? "This proposal is awaiting a separate user decision." : "The earlier request stopped before this operation was saved." };
      }
      return part;
    }) }));
    modelMessages = await convertToModelMessages(executionMessages);
  } catch {
    return NextResponse.json(
      { error: "Invalid chat request.", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  // A chip-only send — paste, then Send without typing — has no text part,
  // and the paste part is not a model part, so the message converts to empty
  // content. Ollama rejects the whole request on it (its content field is a
  // string; the provider serializes empty content as []), and it keeps doing
  // so on every later turn while the shell stays in the window.
  //
  // It is given a body rather than dropped. Dropping it removed a user turn
  // that really happened, which moved the last-user-message boundary back
  // over an older assistant reply — and DeepSeek's thinking mode requires
  // reasoning_content on every assistant message after that boundary, so a
  // reasoning-free reply from two turns ago 400'd the whole request. No
  // provider is special-cased here: the transcript is simply true again.
  // The paste context message below is what actually carries the posting.
  // The fallback names what the empty shell actually carried — a data-file
  // part's name, else the paste body — so the stand-in text is never a claim
  // the user's message did not make. Converted user messages correspond to
  // the persisted user messages in order.
  const originalUsers = messages.filter((m) => m.role === "user");
  let originalUserIndex = 0;
  modelMessages = modelMessages.flatMap((message) => {
    if (!(Array.isArray(message.content) && message.content.length === 0)) {
      if (message.role === "user") originalUserIndex += 1;
      return [message];
    }
    if (message.role !== "user") return [];
    const original = originalUsers[originalUserIndex];
    originalUserIndex += 1;
    const filePart = original?.parts.find(isAgentFilePart);
    const content = filePart
      ? agentFilePlaceholder(filePart.data.name)
      : AGENT_PASTE_ONLY_USER_MESSAGE;
    return [{ role: "user" as const, content }];
  });

  // Injected only on the turn that introduced the paste. On the approval POST
  // the last message is the assistant's, so nothing is re-injected — and the
  // full text never reaches the model on any turn.
  const lastIsUser = messages[messages.length - 1]?.role === "user";
  // Whether a job is open is a per-turn fact, but a no_job tool result sits
  // in history looking permanent — the model replayed one for two turns.
  // Recency is what has to beat it, so this rides at the end of the messages
  // rather than in the system prompt. A pasted posting still lands last.
  // The legacy path has no budgeter transcript to extend, so a task session's
  // verified state line rides as a context message ahead of the page line.
  if (lastIsUser && taskSession?.handoffLine) {
    modelMessages.push({ role: "user", content: taskSession.handoffLine });
  }
  if (lastIsUser) {
    modelMessages.push({
      role: "user",
      content: buildPageContextMessage(pageContext, {
        freshNativeFull,
        agentRole: conversation.agentRole,
      }),
    });
  }
  if (pastedText && lastIsUser) {
    const { block } = truncateForModel(pastedText);
    modelMessages.push({ role: "user", content: buildPasteContextMessage(block) });
  }
  // Same arriving-turn-only rule as the paste: one line per attached file,
  // after it, so the file content is the last thing before the session tail.
  if (fileTexts.length && lastIsUser) {
    for (const file of fileTexts) {
      const { block } = truncateForModel(file.text);
      modelMessages.push({
        role: "user",
        content: buildFileContextMessage(file.name, block),
      });
    }
  }

  // req.signal is what makes stop()/Clear/close actually stop generating: the
  // client aborting its fetch is otherwise invisible here, and streamText would
  // keep pulling tokens until the deadline. Tools inherit this via execute's
  // abortSignal, so a nested generation is cancelled too.
  const executionAbort = new AbortController();
  request.abort = () => executionAbort.abort();
  const turnSignal = AbortSignal.any([
    executionAbort.signal,
    req.signal,
    AbortSignal.timeout(APP_CONSTANTS.AGENT_CHAT_TIMEOUT_MS),
  ]);

  // Written inside execute, read in onFinish, which runs after it.
  let prefixMetrics: TurnPrefixMetrics | undefined;

  // Written by streamText's own onFinish, read in the outer onFinish. Must be
  // totalUsage, not one step's usage: stopWhen permits AGENT_CHAT_MAX_STEPS.
  let turnUsage: LanguageModelUsage | undefined;
  let turnFinishReason: string | undefined;

  const rawLocale = req.cookies?.get?.(LOCALE_COOKIE_NAME)?.value;
  const locale = normalizeLocale(rawLocale);
  const systemPrompt = buildAgentChatSystemPrompt(locale, {
    freshNativeFull,
    agentRole: conversation.agentRole,
    notionTools,
    feishuTools,
    taskExtraTools: taskSession?.extraTools,
  }) + personalInstructionsBlock(preferences.personalInstructions) + permissionInstructions(permissionMode)
    + buildResumeEvidencePromptAddendum({ messages, agentRole: conversation.agentRole });

  const turnSpan = startSpan("agent.chat.turn", {
    ...genAiRequestAttrs({
      provider,
      model: modelName,
      temperature: TEMPERATURES.ANALYSIS,
      numCtx: APP_CONSTANTS.AGENT_CHAT_NUM_CTX,
      surface: SURFACES.AGENT_CHAT,
      system: systemPrompt,
      prompt: modelMessages,
    }),
    "jobsync.user_id": userId,
  });

  // toUIMessageStream maps and logs a stream failure, then the SDK re-wraps
  // the mapped string as an Error and hands it to createUIMessageStream's
  // onError, which would map and log the same failure a second time. Passing
  // an already-mapped string straight back keeps it to one line per failure.
  let turnFailed = false;
  const alreadyMapped = new Set<string>();
  const mapTurnError = (error: unknown): string =>
    runInSpan(turnSpan, () => {
      turnFailed = true;
      const message = error instanceof Error ? error.message : "";
      if (alreadyMapped.has(message)) return message;
      const mapped = formatAgentStreamError(error, errorContext);
      alreadyMapped.add(mapped);
      return mapped;
    });

  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: ({ writer }) =>
      runInSpan(turnSpan, () => {
        request.onCheckpoint = () => writer.write({ type: "data-conversation", transient: true, data: { conversationId, requestId: request.requestId, revision: request.revision, durable: true, released: false, wrote: request.wrote } });
        const tools = buildAgentTools({
          userId,
          pastedText,
          pageContext,
          messages,
          model,
          provider,
          modelName,
          writer,
          freshNativeFull,
          canonicalJobs,
          request,
          agentRole: conversation.agentRole,
          notionTools,
          feishuTools,
          permissionMode,
          taskExtraTools: taskSession?.extraTools,
        });
        prefixMetrics = measureTurnPrefix({
          userId,
          conversationId,
          system: systemPrompt,
          tools,
          modelMessages,
        });
        const result = streamText({
          model,
          system: systemPrompt,
          messages: modelMessages,
          tools,
          // Which tools end the turn — and why — lives beside the tool metadata
          // in agent.model.ts, where a new tool is registered.
          stopWhen: [
            stepCountIs(APP_CONSTANTS.AGENT_CHAT_MAX_STEPS),
            ...AGENT_CHAT_TERMINAL_TOOLS.map((name) =>
              name === "add_job" ? addJobSettledStop : hasToolCall(name),
            ),
          ],
          // Argument extraction wants determinism.
          temperature: TEMPERATURES.ANALYSIS,
          abortSignal: turnSignal,
          providerOptions: {
            // qwen3.5 is a hybrid-reasoning model and the provider defaults
            // think to false. With the thinking channel shut it deliberates in
            // the content channel, and content and a tool call are mutually
            // exclusive — add_job measured 1/7 with it off, 7/7 with it on.
            ollama: { think: true, options: { num_ctx: APP_CONSTANTS.AGENT_CHAT_NUM_CTX } },
          },
          // streamText's onFinish, not createUIMessageStream's: result is
          // scoped inside execute while the span ends in the outer onFinish.
          onFinish: ({ totalUsage, finishReason }) => {
            turnUsage = totalUsage;
            turnFinishReason = finishReason;
          },
        });
        // createUIMessageStream emits no start/finish of its own — the merged
        // stream carries them, so this is byte-identical to the old response.
        // Load-bearing: toUIMessageStream catches stream errors itself and
        // emits an error part, so createUIMessageStream's onError below never
        // sees them. Without this the user gets the SDK's "An error occurred."
        // and mapAgentError — the only thing that logs — never runs.
        writer.merge(
          result.toUIMessageStream({
            onError: mapTurnError,
            generateMessageId: () => request.responseMessageId,
          }),
        );
      }),
    onFinish: async ({ messages: finalMessages, responseMessage, isAborted }) => {
      const { tool, state, outcome } = outcomeOf(responseMessage);
      const fields = {
        provider,
        model: modelName,
        tool,
        toolState: state,
        outcome,
        aborted: isAborted,
        pasteChars: pastedText?.length ?? 0,
        messageCount: finalMessages.length,
        // Windowing is invisible to the user, so this is the only signal that
        // the model was given less history than the transcript holds.
        historyDropped: messages.length - retained.length,
        // What was actually sent. prefixChanged is the cache signal: the
        // system prompt and tool material must stay byte-identical within a
        // conversation or Ollama recomputes the whole prefix.
        systemChars: prefixMetrics?.systemChars ?? 0,
        toolChars: prefixMetrics?.toolChars ?? 0,
        messageChars: prefixMetrics?.messageChars ?? 0,
        prefixChanged: prefixMetrics?.prefixChanged ?? false,
      };
      // onFinish runs outside execute, so the span context has to be
      // re-entered for the record to carry the turn's trace id.
      runInSpan(turnSpan, () => logTurn(fields));
      // The same curated field set, on the span rather than only in the log,
      // so it is queryable beside latency, tokens and the tool waterfall.
      turnSpan.end({
        ...genAiResponseAttrs({
          usage: turnUsage,
          finishReason: turnFinishReason,
        }),
        "jobsync.tool": fields.tool,
        "jobsync.tool_state": fields.toolState,
        "jobsync.outcome": fields.outcome,
        "jobsync.aborted": fields.aborted,
        "jobsync.paste_chars": fields.pasteChars,
        "jobsync.message_count": fields.messageCount,
        "jobsync.history_dropped": fields.historyDropped,
        "jobsync.system_chars": fields.systemChars,
        "jobsync.tool_chars": fields.toolChars,
        "jobsync.message_chars": fields.messageChars,
        "jobsync.prefix_changed": fields.prefixChanged,
      });
      // A cancelled turn never writes back. Clear deletes the conversation and
      // this fires afterwards on the stream's cancel path, so saving here would
      // restore exactly what the user just deleted. The write-on-receipt above
      // already made their message durable, and an incomplete review is not
      // worth persisting.
      if (isAborted || turnFailed) {
        await cancelConversationRequest(userId, conversationId, request.requestId);
        return;
      }
      // Stubbing happens here so it lives in exactly one place.
      await finishConversationRequest(request, stubConsumedPastes(finalMessages));
      scheduleCareerDialogueSummary({
        userId,
        conversationId,
        resolvedConnectionId: null,
        resolvedModel: null,
        messages: request.messages,
      });
      // M2: the extractor self-gates — a null-lock legacy row never reaches
      // the model; a managed/account one learns memory in the background.
      scheduleLongTermMemoryExtraction({ userId, conversationId });
      if (taskSession) {
        triggerTaskHandoff({
          userId,
          conversationId,
          taskId: taskSession.taskId,
          messages: request.messages,
        });
      }
    },
    // NOTE: this signature takes the error directly, unlike streamText's
    // onError which takes { error }.
    onError: mapTurnError,
  });

  return createUIMessageStreamResponse({ stream: conversationCommitStream(stream, request) });
};

export const POST = async (req: NextRequest) => {
  let request: ConversationRequest | undefined;
  try {
    const response = await executePost(req, owned => {
      request = owned;
      const cancel = () => { void cancelConversationRequest(owned.userId, owned.conversationId, owned.requestId).catch(() => { owned.failure = new ConversationRequestError("CONVERSATION_PERSISTENCE_FAILED"); owned.abort?.(); }); };
      req.signal.addEventListener("abort", cancel, { once: true });
      if (req.signal.aborted) cancel();
    });
    if (response.status !== 200 && request) await cancelConversationRequest(request.userId, request.conversationId, request.requestId);
    return response;
  } catch (error) {
    if (request) {
      try { await cancelConversationRequest(request.userId, request.conversationId, request.requestId); }
      catch { error = new ConversationRequestError("CONVERSATION_PERSISTENCE_FAILED"); }
    }
    if (error instanceof AIBusinessError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    const failure = error instanceof ConversationRequestError ? error : new ConversationRequestError("CONVERSATION_PERSISTENCE_FAILED");
    return NextResponse.json(agentErrorEnvelope(failure), { status: failure.code === "CONVERSATION_NOT_FOUND" ? 404 : failure.code === "CONVERSATION_PERSISTENCE_FAILED" ? 500 : 409 });
  }
};
