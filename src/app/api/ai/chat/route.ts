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
  buildPageContextMessage,
  buildPasteContextMessage,
} from "@/lib/agent/prompt";
import { LOCALE_COOKIE_NAME, normalizeLocale } from "@/i18n";
import {
  resolvePastedText,
  stubConsumedPastes,
} from "@/lib/agent/paste";
import {
  careerDialogueContextLogFields,
  currentUserExceedsContextBudget,
  selectCareerDialogueMessages,
  type CareerDialogueContextSize,
} from "@/lib/agent/contextBudget";
import { truncateForModel } from "@/lib/agent/paste.server";
import { buildAgentTools } from "@/lib/agent/tools";
import { measureTurnPrefix, type TurnPrefixMetrics } from "@/lib/agent/turnMetrics";
import {
  agentErrorEnvelope,
  formatAgentStreamError,
} from "@/lib/agent/errors";
import { getUserSettings } from "@/actions/userSettings.actions";
import { saveChatConversation } from "@/actions/agentChat.actions";
import { pageContextFromConversation } from "@/lib/agent/conversationContext";
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
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import {
  ChatConversationNotFoundError,
  contextOfRow,
  getOwnedChatConversation,
  updateChatConversationMessages,
  type ChatConversationRow,
} from "@/lib/agent/chatConversationStore";
import { chatLockFromRow } from "@/lib/agent/chatConversationLock";
import { checkStreamingTurnReadiness } from "@/lib/ai/streaming-execution";
import { careerDialogueObservabilityFields } from "@/lib/agent/careerDialogueRoute";
import {
  prepareCareerDialogueTurn,
  runCareerDialogueTurn,
} from "@/lib/agent/careerDialogueTurn";
import { AIBusinessError } from "@/lib/ai/connections";
import { loadFreshConversationSummary } from "@/lib/agent/conversationSummaryStore";
import { scheduleCareerDialogueSummary } from "@/lib/agent/conversationSummaryScheduler";

// The one terminal tool whose stop condition is not "was it called" — see
// addJobSettled.
const addJobSettledStop: StopCondition<any> = ({ steps }) =>
  addJobSettled(steps[steps.length - 1] ?? {});

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
  req,
  userId,
  conversationId,
  messages,
  pastedText,
  pageContext,
  lock,
  freshNativeFull,
}: {
  req: NextRequest;
  userId: string;
  conversationId: string;
  messages: UIMessage[];
  pastedText: string | undefined;
  pageContext: Parameters<typeof buildPageContextMessage>[0];
  lock: { connectionId: string; model: string | null };
  freshNativeFull: boolean;
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
  try {
    await checkStreamingTurnReadiness({
      connection,
      model: lock.model,
    });
  } catch (error) {
    return deny(error);
  }

  const rawLocale = req.cookies?.get?.(LOCALE_COOKIE_NAME)?.value;
  const locale = normalizeLocale(rawLocale);
  const systemPrompt = buildAgentChatSystemPrompt(locale, { freshNativeFull });

  // Route on the full request. Budgeting happens inside the turn, after
  // the local router has seen the current utterance.
  if (currentUserExceedsContextBudget(messages)) {
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
      provider: `account:${connection.provider}`,
      backendKind: connection.backendKind,
      outcome: "capability_blocked",
    });
    return deny(prepared.error);
  }

  // Same abort contract as the legacy path: client disconnect / stop()
  // aborts the runtime child through the execute-stream socket.
  const turnSignal = AbortSignal.any([
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
  const alreadyMapped = new Set<string>();
  const mapTurnError = (error: unknown): string =>
    runInSpan(turnSpan, () => {
      const message = error instanceof Error ? error.message : "";
      if (alreadyMapped.has(message)) return message;
      const mapped = formatAgentStreamError(error, errorContext);
      alreadyMapped.add(mapped);
      return mapped;
    });

  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: async ({ writer }) => {
      await runInSpan(turnSpan, async () => {
        const summary = await loadFreshConversationSummary({
          userId,
          conversationId,
          messages,
        });
        const result = await runCareerDialogueTurn({
          userId,
          connectionId: connection.id,
          provider: connection.provider,
          backendKind: connection.backendKind,
          modelName: lock.model ?? "",
          systemPrompt,
          messages,
          pastedText,
          pageContext,
          summary,
          writer,
          signal: turnSignal,
          decision: prepared.decision,
          routerDurationMs: prepared.routerDurationMs,
          freshNativeFull,
        });
        contextSize = result.contextSize;
      });
    },
    onFinish: async ({ messages: finalMessages, responseMessage, isAborted }) => {
      const { tool, state, outcome } = outcomeOf(responseMessage);
      runInSpan(turnSpan, () =>
        logTurn({
          ...routeFields,
          provider: `account:${connection.provider}`,
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
      if (isAborted) return;
      const saved = await saveChatConversation(
        conversationId,
        stubConsumedPastes(finalMessages),
      );
      if (!saved.success) return;
      scheduleCareerDialogueSummary({
        userId,
        conversationId,
        resolvedConnectionId: lock.connectionId,
        resolvedModel: lock.model,
        messages: finalMessages,
      });
    },
    onError: mapTurnError,
  });

  return createUIMessageStreamResponse({ stream });
}

export const POST = async (req: NextRequest) => {
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

  const parsed = AgentChatRequestSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid chat request.", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const messages = parsed.data.messages as UIMessage[];
  const { conversationId } = parsed.data;

  const pastedText = resolvePastedText(messages);

  // The row already exists — creation (and its immutable lock) happened
  // before the first turn. This write only stores the transcript of that
  // exact conversation, and only when the caller owns it.
  let conversation: ChatConversationRow | null;
  try {
    conversation = await getOwnedChatConversation(userId, conversationId);
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found", code: "CONVERSATION_NOT_FOUND" },
        { status: 404 },
      );
    }
    conversation = await updateChatConversationMessages(
      userId,
      conversationId,
      messages,
    );
  } catch (error) {
    if (error instanceof ChatConversationNotFoundError) {
      return NextResponse.json(
        { error: "Conversation not found", code: "CONVERSATION_NOT_FOUND" },
        { status: 404 },
      );
    }
    throw error;
  }
  const lock = chatLockFromRow(conversation);
  const pageContext = pageContextFromConversation(contextOfRow(conversation));

  // One resolution per turn: fresh-native full withholds the deferred write
  // tools from the registry, the system prompt and the page-context line.
  const careerRuntime = await resolveCareerRuntimeMode(prisma);
  const freshNativeFull = isFreshNativeFullSurface(careerRuntime);

  if (lock.kind === "account") {
    return accountChatResponse({
      req,
      userId,
      conversationId,
      messages,
      pastedText,
      pageContext,
      lock,
      freshNativeFull,
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
  if (currentUserExceedsContextBudget(messages)) {
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
  const retained = convertible ? selectCareerDialogueMessages(messages) : messages;
  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(retained);
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
  modelMessages = modelMessages.flatMap((message) => {
    if (!(Array.isArray(message.content) && message.content.length === 0)) {
      return [message];
    }
    if (message.role !== "user") return [];
    return [{ role: "user" as const, content: AGENT_PASTE_ONLY_USER_MESSAGE }];
  });

  // Injected only on the turn that introduced the paste. On the approval POST
  // the last message is the assistant's, so nothing is re-injected — and the
  // full text never reaches the model on any turn.
  const lastIsUser = messages[messages.length - 1]?.role === "user";
  // Whether a job is open is a per-turn fact, but a no_job tool result sits
  // in history looking permanent — the model replayed one for two turns.
  // Recency is what has to beat it, so this rides at the end of the messages
  // rather than in the system prompt. A pasted posting still lands last.
  if (lastIsUser) {
    modelMessages.push({
      role: "user",
      content: buildPageContextMessage(pageContext, { freshNativeFull }),
    });
  }
  if (pastedText && lastIsUser) {
    const { block } = truncateForModel(pastedText);
    modelMessages.push({ role: "user", content: buildPasteContextMessage(block) });
  }

  // req.signal is what makes stop()/Clear/close actually stop generating: the
  // client aborting its fetch is otherwise invisible here, and streamText would
  // keep pulling tokens until the deadline. Tools inherit this via execute's
  // abortSignal, so a nested generation is cancelled too.
  const turnSignal = AbortSignal.any([
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
  const systemPrompt = buildAgentChatSystemPrompt(locale, { freshNativeFull });

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
  const alreadyMapped = new Set<string>();
  const mapTurnError = (error: unknown): string =>
    runInSpan(turnSpan, () => {
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
        const tools = buildAgentTools({
          userId,
          pastedText,
          pageContext,
          model,
          provider,
          modelName,
          writer,
          freshNativeFull,
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
      if (isAborted) return;
      // Stubbing happens here so it lives in exactly one place.
      const saved = await saveChatConversation(
        conversationId,
        stubConsumedPastes(finalMessages),
      );
      if (!saved.success) return;
      scheduleCareerDialogueSummary({
        userId,
        conversationId,
        resolvedConnectionId: null,
        resolvedModel: null,
        messages: finalMessages,
      });
    },
    // NOTE: this signature takes the error directly, unlike streamText's
    // onError which takes { error }.
    onError: mapTurnError,
  });

  return createUIMessageStreamResponse({ stream });
};
