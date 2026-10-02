import "server-only";

import {
  asSchema,
  generateId,
  isToolUIPart,
  getToolName,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { executeAIConnectionTextStream } from "@/lib/ai/streaming-execution";
import { runStructuredValidation } from "@/lib/ai/structured-output";
import { AI_BUSINESS_ERROR_CODES, AIBusinessError } from "@/lib/ai/connections";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  AGENT_CHAT_TERMINAL_TOOLS,
  addJobSettled,
  isAgentPastePart,
  type PageContext,
} from "@/models/agent.model";
import {
  AGENT_TOOL_DESCRIPTIONS,
  buildPageContextMessage,
  buildPasteContextMessage,
} from "./prompt";
import { truncateForModel } from "./paste.server";
import { buildAgentTools } from "./tools";
import { createAccountRuntimeLanguageModel } from "./accountLanguageModel";

/**
 * Provider-neutral agent orchestration for ACCOUNT_LOGIN-locked
 * conversations.
 *
 * The managed runtimes speak text — not a provider-native tool protocol —
 * so Vocatrya owns the loop:
 *
 *   decision step  → structured one-shot (parse → schema → ≤1 retry)
 *                  → "assistant_response" | "tool_call"
 *   tool_call      → allowlist + per-tool argument schema validation
 *                  → approval gate when the tool requires it
 *                  → Vocatrya executes the tool itself
 *                  → result appended to the transcript, loop repeats
 *   final answer   → execute-stream → real text deltas to the UI stream
 *
 * The whole turn runs on the conversation's locked connectionId + model —
 * decision, tool executions and the final stream never re-resolve the
 * assignment and never switch runtimes mid-turn.
 */

// ---------------------------------------------------------------------------
// Decision protocol
// ---------------------------------------------------------------------------

// Strict-schema compliant: native-schema transports (codex
// `--output-schema` → OpenAI strict response_format) require every
// property in `required` and forbid free-form objects — `arguments`
// therefore travels as a JSON-encoded string, null for plain answers.
// PROMPT_AND_VALIDATE runtimes follow the same wire contract.
const AGENT_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "tool", "arguments"],
  properties: {
    type: { type: "string", enum: ["assistant_response", "tool_call"] },
    tool: { type: ["string", "null"] },
    arguments: {
      type: ["string", "null"],
      description:
        "JSON-encoded arguments object for the tool call, or null",
    },
  },
} as const;

const AGENT_DECISION_SCHEMA_NAME = "vocatrya_agent_decision";

// Failure codes surfaced through the agent error taxonomy. These are the
// "model produced something we cannot act on" bucket — never raw output.
export const AGENT_PROTOCOL_ERROR_CODES = {
  TOOL_NOT_ALLOWED: AI_BUSINESS_ERROR_CODES.AGENT_TOOL_NOT_ALLOWED,
  TOOL_ARGUMENT_INVALID: AI_BUSINESS_ERROR_CODES.AGENT_TOOL_ARGUMENT_INVALID,
  PROTOCOL_FAILED: AI_BUSINESS_ERROR_CODES.AGENT_TOOL_PROTOCOL_FAILED,
  STEP_LIMIT: AI_BUSINESS_ERROR_CODES.AGENT_STEP_LIMIT_REACHED,
} as const;

// One corrective re-ask per decision position after the model picks an
// unknown tool or sends bad arguments — the schema retry inside
// runStructuredValidation covers malformed JSON, this covers semantically
// wrong but well-formed decisions.
const DECISION_CORRECTION_ATTEMPTS = 1;

// The decision prompt must stay inside the argv-bound prompt budget of the
// locked-down one-shot invocation; the transcript is the elastic part.
const DECISION_TRANSCRIPT_MAX_CHARS = 16_000;
export const ANSWER_TRANSCRIPT_MAX_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Transcript serialization — UIMessage[] → the plain-text conversation the
// runtime sees. Tool parts are narrated explicitly; data-* parts are never
// model content (the paste head arrives via buildPasteContextMessage).
// ---------------------------------------------------------------------------

function toolResultLine(part: { type: string; [k: string]: unknown }): string {
  const name = getToolName(part as never);
  switch (part.state as string) {
    case "approval-requested":
      return `Assistant proposed tool ${name} with arguments ${JSON.stringify(part.input ?? {})} — awaiting the user's confirmation.`;
    case "approval-responded": {
      const approval = part.approval as
        | { approved?: boolean; reason?: string }
        | undefined;
      return approval?.approved
        ? `The user approved the ${name} proposal.`
        : `The user declined the ${name} proposal${approval?.reason ? `: ${approval.reason}` : "."}`;
    }
    case "output-available":
      return `Tool ${name} returned: ${JSON.stringify(part.output ?? null)}`;
    case "output-denied":
      return `The user declined to run ${name}.`;
    case "output-error":
      return `Tool ${name} failed.`;
    default:
      return `Assistant called tool ${name} with arguments ${JSON.stringify(part.input ?? {})}.`;
  }
}

export function serializeChatTranscript(messages: UIMessage[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    const parts = message.parts ?? [];
    if (message.role === "user") {
      const text = parts
        .map((part) => {
          if (part.type === "text") return part.text;
          if (isAgentPastePart(part)) return "(pasted job posting)";
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (text) lines.push(`User: ${text}`);
      continue;
    }
    if (message.role === "assistant") {
      for (const part of parts) {
        if (part.type === "text") {
          if (part.text) lines.push(`Assistant: ${part.text}`);
        } else if (isToolUIPart(part)) {
          lines.push(toolResultLine(part));
        }
        // data-* parts never reach the model.
      }
    }
  }
  return lines;
}

export function boundedTranscript(lines: string[], maxChars: number): string {
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    total += line.length + 1;
    if (total > maxChars && kept.length) break;
    kept.unshift(line);
  }
  return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Tool catalog for the decision prompt — names, descriptions, argument
// schemas. Names come from the actual registry so the allowlist and the
// documentation can never drift apart.
// ---------------------------------------------------------------------------

function describeToolsForPrompt(tools: ToolSet): string {
  return Object.entries(tools)
    .map(([name, tool]) => {
      const description =
        AGENT_TOOL_DESCRIPTIONS[name as keyof typeof AGENT_TOOL_DESCRIPTIONS] ??
        (tool as { description?: string }).description ??
        "";
      const schema = asSchema(tool.inputSchema).jsonSchema;
      return `- ${name}: ${description}\n  arguments JSON schema: ${JSON.stringify(schema)}`;
    })
    .join("\n");
}

function buildDecisionPrompt({
  systemPrompt,
  toolsBlock,
  transcript,
  correction,
}: {
  systemPrompt: string;
  toolsBlock: string;
  transcript: string;
  correction?: string;
}): string {
  return [
    // The runtime is an agentic assistant — the routing contract must be
    // stated first and framed as data, or the model answers the user
    // instead of emitting the decision envelope.
    [
      "You are the routing layer of a chat application. Your ONLY output is one JSON object.",
      "Do not answer the user. Do not explain. Do not run any tool, command, or file operation yourself.",
      "No prose, no markdown fences, no reasoning — a single JSON object and nothing else.",
    ].join("\n"),
    `If the next step needs a Vocatrya tool, output exactly:\n{"type":"tool_call","tool":"<tool name>","arguments":"<JSON-encoded arguments object>"}\nIf the next step is a natural-language reply to the user, output exactly:\n{"type":"assistant_response","tool":null,"arguments":null}`,
    `Available tools (only these may appear in "tool"):\n${toolsBlock}`,
    `Application system context:\n${systemPrompt}`,
    `Conversation so far:\n${transcript}`,
    ...(correction ? [`Your previous decision was not usable: ${correction}. Return a corrected JSON object.`] : []),
    "Decision JSON:",
  ].join("\n\n");
}

const DIRECT_CHAT_CONSTRAINT =
  "This reply has no Vocatrya tools available. Do not claim that a job was saved, a resume was read or reviewed, a match was scored, or a cover letter was generated.";

export function buildAnswerPrompt({
  systemPrompt,
  transcript,
  directChat = false,
}: {
  systemPrompt: string;
  transcript: string;
  /** Fast Chat only. The agent final answer keeps the historical prompt. */
  directChat?: boolean;
}): string {
  return [
    systemPrompt,
    ...(directChat ? [DIRECT_CHAT_CONSTRAINT] : []),
    `Conversation:\n${transcript}`,
    "Write your reply to the user now — natural language only, in the conversation's language. Do not emit JSON, tool markup, or code fences.",
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Decision parsing — the provider-neutral contract.
// ---------------------------------------------------------------------------

export type AgentDecision =
  | { kind: "answer" }
  | { kind: "tool_call"; toolName: string; input: unknown }
  | { kind: "invalid"; reason: string };

export function parseAgentDecision(
  value: unknown,
  tools: ToolSet,
): AgentDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid", reason: "response was not a JSON object" };
  }
  const decision = value as { type?: unknown; tool?: unknown; arguments?: unknown };
  if (decision.type === "assistant_response") {
    return { kind: "answer" };
  }
  if (decision.type !== "tool_call") {
    return { kind: "invalid", reason: "type must be assistant_response or tool_call" };
  }
  if (typeof decision.tool !== "string" || !(decision.tool in tools)) {
    return {
      kind: "invalid",
      reason: `unknown tool ${JSON.stringify(decision.tool)}`,
    };
  }
  // Wire shape is a JSON-encoded string (strict schemas cannot express a
  // free-form object); tolerate a plain object for runtimes that emit one.
  let input: unknown = {};
  if (typeof decision.arguments === "string" && decision.arguments.trim()) {
    try {
      input = JSON.parse(decision.arguments);
    } catch {
      return { kind: "invalid", reason: "arguments is not valid JSON" };
    }
  } else if (decision.arguments && typeof decision.arguments === "object") {
    input = decision.arguments;
  }
  return {
    kind: "tool_call",
    toolName: decision.tool,
    input,
  };
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export type AccountAgentTurnInput = {
  userId: string;
  connectionId: string;
  provider: string;
  backendKind: string;
  modelName: string;
  systemPrompt: string;
  /** Windowed client messages (same windowing the legacy path applies). */
  messages: UIMessage[];
  pastedText?: string;
  pageContext?: PageContext;
  writer: UIMessageStreamWriter;
  signal: AbortSignal;
};

export type AccountAgentTurnResult = {
  paused: boolean;
  answerChars: number;
  steps: number;
};

export function assembleCareerDialogueTranscript({
  messages,
  pageContext,
  pastedText,
}: {
  messages: UIMessage[];
  pageContext?: PageContext;
  pastedText?: string;
}): string[] {
  const transcriptLines = serializeChatTranscript(messages);
  const lastMessage = messages[messages.length - 1];
  const lastIsUser = lastMessage?.role === "user";
  if (lastIsUser) {
    transcriptLines.push(buildPageContextMessage(pageContext));
  }
  if (pastedText && lastIsUser) {
    const { block } = truncateForModel(pastedText);
    transcriptLines.push(buildPasteContextMessage(block));
  }
  return transcriptLines;
}

export async function runAccountAgentTurn(
  input: AccountAgentTurnInput,
): Promise<AccountAgentTurnResult> {
  const {
    userId,
    connectionId,
    provider,
    modelName,
    systemPrompt,
    messages,
    pastedText,
    pageContext,
    writer,
    signal,
  } = input;

  // The nested tools run their generations through the same locked pair —
  // a LanguageModel adapter over the same execute seam, not the legacy
  // provider.
  const nestedModel = createAccountRuntimeLanguageModel({
    userId,
    connectionId,
    modelName,
    timeoutMs: APP_CONSTANTS.AGENT_CHAT_TIMEOUT_MS,
  });
  const tools = buildAgentTools({
    userId,
    pastedText,
    pageContext,
    model: nestedModel,
    provider,
    modelName,
    writer,
  });
  const toolsBlock = describeToolsForPrompt(tools);

  // The transcript starts from the persisted window and grows as this turn
  // executes tools — the model's decision loop sees its own tool results.
  const transcriptLines = assembleCareerDialogueTranscript({
    messages,
    pageContext,
    pastedText,
  });

  const lastMessage = messages[messages.length - 1];

  // --- Approval continuation -------------------------------------------
  // The POST body carries the assistant message whose tool part is
  // approval-responded. Vocatrya decides what to do with it — the model
  // only ever PROPOSED the call.
  const resumePart = findApprovalResponse(lastMessage);

  // Message id: a continuation appends to the existing assistant message —
  // same convention as toUIMessageStream's responseMessageId.
  const messageId =
    lastMessage?.role === "assistant" ? lastMessage.id : generateId();
  writer.write({ type: "start", messageId });

  let stepsUsed = 0;
  let answerChars = 0;

  if (resumePart) {
    writer.write({ type: "start-step" });
    const toolName = getToolName(resumePart);
    const tool = tools[toolName];
    const approval = resumePart.approval as
      | { approved?: boolean; reason?: string }
      | undefined;
    if (!approval?.approved) {
      writer.write({
        type: "tool-output-denied",
        toolCallId: resumePart.toolCallId,
      });
      transcriptLines.push(
        `The user declined to run ${toolName}${approval?.reason ? `: ${approval.reason}` : "."}`,
      );
    } else if (!tool?.execute) {
      transcriptLines.push(`Tool ${toolName} is not executable.`);
      writer.write({
        type: "tool-output-error",
        toolCallId: resumePart.toolCallId,
        errorText: "tool unavailable",
      });
    } else {
      // Re-validate before executing — the input round-trips through the
      // client's approval response, so it must still satisfy the schema.
      const rechecked = await asSchema(tool.inputSchema).validate?.(
        resumePart.input,
      );
      if (!rechecked || !rechecked.success) {
        throw new AIBusinessError(
          AGENT_PROTOCOL_ERROR_CODES.TOOL_ARGUMENT_INVALID,
          `approved input no longer satisfies ${toolName}'s schema`,
        );
      }
      let output: unknown;
      let failed = false;
      try {
        output = await tool.execute(rechecked.value, {
          toolCallId: resumePart.toolCallId,
          messages: [],
          abortSignal: signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        failed = true;
        writer.write({
          type: "tool-output-error",
          toolCallId: resumePart.toolCallId,
          errorText: "tool failed",
        });
        output = { status: "generation_failed", reason: "execution failed" };
      }
      if (!failed) {
        writer.write({
          type: "tool-output-available",
          toolCallId: resumePart.toolCallId,
          output,
        });
      }
      transcriptLines.push(
        `Tool ${toolName} returned: ${JSON.stringify(output)}`,
      );
    }
    writer.write({ type: "finish-step" });
    stepsUsed += 1;
  }

  // --- Decision loop ----------------------------------------------------
  let correction: string | undefined;
  let correctionsUsed = 0;

  while (stepsUsed < APP_CONSTANTS.AGENT_CHAT_MAX_STEPS) {
    if (signal.aborted) {
      throw Object.assign(new Error("Execution aborted"), {
        name: "AbortError",
      });
    }
    stepsUsed += 1;

    const decisionResult = await runStructuredValidation({
      prompt: buildDecisionPrompt({
        systemPrompt,
        toolsBlock,
        transcript: boundedTranscript(
          transcriptLines,
          DECISION_TRANSCRIPT_MAX_CHARS,
        ),
        correction,
      }),
      schema: AGENT_DECISION_SCHEMA,
      schemaName: AGENT_DECISION_SCHEMA_NAME,
      signal,
      execute: async ({ prompt }) => {
        try {
          const result = await executeAIConnectionText({
            userId,
            connectionId,
            model: modelName,
            prompt,
            structuredOutput: {
              schema: AGENT_DECISION_SCHEMA,
              schemaName: AGENT_DECISION_SCHEMA_NAME,
            },
            timeoutMs: APP_CONSTANTS.AGENT_CHAT_TIMEOUT_MS,
            signal,
          });
          return { ok: true as const, text: result.text };
        } catch (error) {
          return {
            ok: false as const,
            code:
              error instanceof AIBusinessError
                ? error.code
                : AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
          };
        }
      },
    });

    if (
      decisionResult.status !== "VALID" &&
      decisionResult.status !== "VALID_AFTER_RETRY"
    ) {
      // The runtime-level failure code travels; parse/schema exhaustion is
      // the protocol failure.
      const code = decisionResult.attempts.find((a) => a.code)?.code;
      // issueSummary is a field-path summary (never raw model output) —
      // it is what makes a protocol failure diagnosable in the logs.
      const detail = decisionResult.issueSummary
        ? ` — ${decisionResult.issueSummary}`
        : "";
      throw new AIBusinessError(
        code === AI_BUSINESS_ERROR_CODES.REAUTH_REQUIRED ||
          code === AI_BUSINESS_ERROR_CODES.CONNECTION_DISCONNECTED ||
          code === AI_BUSINESS_ERROR_CODES.CONNECTION_ERROR ||
          code === AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT ||
          code === AI_BUSINESS_ERROR_CODES.STREAMING_NOT_VERIFIED ||
          code === AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_NOT_VERIFIED
          ? code
          : AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
        `agent decision failed: ${decisionResult.status}${detail}`,
      );
    }

    const decision = parseAgentDecision(decisionResult.value, tools);

    if (decision.kind === "invalid") {
      if (
        correctionsUsed < DECISION_CORRECTION_ATTEMPTS &&
        decision.reason.startsWith("unknown tool")
      ) {
        correctionsUsed += 1;
        correction = decision.reason;
        stepsUsed -= 1; // the correction retries the same position
        continue;
      }
      throw new AIBusinessError(
        decision.reason.startsWith("unknown tool")
          ? AGENT_PROTOCOL_ERROR_CODES.TOOL_NOT_ALLOWED
          : AGENT_PROTOCOL_ERROR_CODES.PROTOCOL_FAILED,
        `agent decision unusable: ${decision.reason}`,
      );
    }

    if (decision.kind === "answer") {
      answerChars = await streamFinalAnswer({
        userId,
        connectionId,
        modelName,
        prompt: buildAnswerPrompt({
          systemPrompt,
          transcript: boundedTranscript(
            transcriptLines,
            ANSWER_TRANSCRIPT_MAX_CHARS,
          ),
        }),
        writer,
        signal,
      });
      writer.write({ type: "finish" });
      return { paused: false, answerChars, steps: stepsUsed };
    }

    // tool_call — validate arguments against the tool's own schema.
    const tool = tools[decision.toolName];
    const validated = await asSchema(tool.inputSchema).validate?.(
      decision.input,
    );
    if (!validated || !validated.success) {
      if (correctionsUsed < DECISION_CORRECTION_ATTEMPTS) {
        correctionsUsed += 1;
        correction = `invalid arguments for ${decision.toolName}`;
        stepsUsed -= 1;
        continue;
      }
      throw new AIBusinessError(
        AGENT_PROTOCOL_ERROR_CODES.TOOL_ARGUMENT_INVALID,
        `agent decision had invalid arguments for ${decision.toolName}`,
      );
    }
    const toolInput = validated.value;
    correction = undefined;

    const toolCallId = generateId();
    writer.write({ type: "start-step" });
    writer.write({
      type: "tool-input-start",
      toolCallId,
      toolName: decision.toolName,
    });
    writer.write({
      type: "tool-input-available",
      toolCallId,
      toolName: decision.toolName,
      input: toolInput,
    });

    const needsApproval =
      tool.needsApproval === true
        ? true
        : typeof tool.needsApproval === "function"
          ? await tool.needsApproval(toolInput, { toolCallId, messages: [] })
          : false;

    if (needsApproval) {
      // The turn pauses — nothing executes until the user's response posts
      // back through this same route.
      const approvalId = generateId();
      writer.write({
        type: "tool-approval-request",
        approvalId,
        toolCallId,
      });
      writer.write({ type: "finish-step" });
      // Same wire shape as the SDK's approval pause: a finished assistant
      // message whose tool part is still awaiting the response.
      writer.write({ type: "finish", finishReason: "tool-calls" });
      return { paused: true, answerChars, steps: stepsUsed };
    }

    if (!tool.execute) {
      throw new AIBusinessError(
        AGENT_PROTOCOL_ERROR_CODES.PROTOCOL_FAILED,
        `tool ${decision.toolName} has no execute`,
      );
    }

    let output: unknown;
    let failed = false;
    try {
      output = await tool.execute(toolInput, {
        toolCallId,
        messages: [],
        abortSignal: signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      failed = true;
      writer.write({
        type: "tool-output-error",
        toolCallId,
        errorText: "tool failed",
      });
      output = { status: "generation_failed", reason: "execution failed" };
    }
    if (!failed) {
      writer.write({
        type: "tool-output-available",
        toolCallId,
        output,
      });
    }
    transcriptLines.push(
      `Tool ${decision.toolName} returned: ${JSON.stringify(output)}`,
    );
    writer.write({ type: "finish-step" });

    // Terminal tools end the turn once their outcome is settled — same
    // semantic as the legacy stopWhen list, including add_job's
    // settled-vs-called distinction.
    if (isTerminalOutcome(decision.toolName, output)) {
      writer.write({ type: "finish" });
      return { paused: false, answerChars, steps: stepsUsed };
    }
  }

  throw new AIBusinessError(
    AGENT_PROTOCOL_ERROR_CODES.STEP_LIMIT,
    "agent step limit reached",
  );
}

// add_job's stop rule needs its result shape — reuse the shared predicate
// rather than re-deriving "settled" here.
function isTerminalOutcome(toolName: string, output: unknown): boolean {
  if (!(AGENT_CHAT_TERMINAL_TOOLS as readonly string[]).includes(toolName)) {
    return false;
  }
  if (toolName !== "add_job") return true;
  return addJobSettled({
    toolCalls: [{ toolName, invalid: false }],
    toolResults: [{ toolName, output }],
  });
}

function findApprovalResponse(message: UIMessage | undefined) {
  if (!message || message.role !== "assistant") return undefined;
  for (const part of message.parts ?? []) {
    if (isToolUIPart(part) && part.state === "approval-responded") {
      return part;
    }
  }
  return undefined;
}

export async function streamFinalAnswer({
  userId,
  connectionId,
  modelName,
  prompt,
  writer,
  signal,
}: {
  userId: string;
  connectionId: string;
  modelName: string;
  prompt: string;
  writer: UIMessageStreamWriter;
  signal: AbortSignal;
}): Promise<number> {
  const textId = generateId();
  let opened = false;
  let chars = 0;
  let sawTerminal = false;
  for await (const event of executeAIConnectionTextStream({
    userId,
    connectionId,
    model: modelName,
    prompt,
    timeoutMs: APP_CONSTANTS.AGENT_CHAT_TIMEOUT_MS,
    signal,
  })) {
    if (event.type === "text-delta") {
      if (!opened) {
        writer.write({ type: "start-step" });
        writer.write({ type: "text-start", id: textId });
        opened = true;
      }
      chars += event.delta.length;
      writer.write({ type: "text-delta", id: textId, delta: event.delta });
    } else if (event.type === "completed") {
      sawTerminal = true;
      if (!opened && event.text) {
        writer.write({ type: "start-step" });
        writer.write({ type: "text-start", id: textId });
        chars += event.text.length;
        writer.write({ type: "text-delta", id: textId, delta: event.text });
        opened = true;
      }
    } else if (event.type === "error") {
      throw new AIBusinessError(
        mapTerminalError(event.code),
        `stream failed: ${event.code}`,
      );
    }
  }
  if (!sawTerminal) {
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
      "stream ended without a terminal event",
    );
  }
  if (opened) {
    writer.write({ type: "text-end", id: textId });
    writer.write({ type: "finish-step" });
  }
  return chars;
}

function mapTerminalError(code: string): never {
  const known = new Set<string>([
    AI_BUSINESS_ERROR_CODES.REAUTH_REQUIRED,
    AI_BUSINESS_ERROR_CODES.CONNECTION_DISCONNECTED,
    AI_BUSINESS_ERROR_CODES.CONNECTION_ERROR,
    AI_BUSINESS_ERROR_CODES.STREAMING_NOT_VERIFIED,
    AI_BUSINESS_ERROR_CODES.STREAMING_NOT_SUPPORTED,
    AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT,
    AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE,
  ]);
  return (known.has(code)
    ? code
    : AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED) as never;
}
