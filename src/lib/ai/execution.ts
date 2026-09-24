/**
 * Business TEXT_ONLY execution seam — the single provider-neutral entry
 * point business surfaces call to run a prompt against an assigned
 * AIConnection.
 *
 * Flow: connection ownership + status gate → mint a single-use
 * "executeText" ticket → POST {ticket, model, prompt, permissionScope} to
 * the Electron main internal execution endpoint → the desktop resolves the
 * ticket back into the trusted connection binding (profile ref, provider,
 * backendKind), runs the adapter's one-shot invocation in a fresh
 * Vocatrya-owned temp cwd, and returns normalized text.
 *
 * This module never picks an executable, args, env, cwd, or credential —
 * it sends identifiers and data only. When the desktop channel is absent
 * (plain web/dev mode) execution reports RUNTIME_NOT_AVAILABLE.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import prisma from "@/lib/db";
import {
  AI_BUSINESS_ERROR_CODES,
  AIBusinessError,
  isAIBackendKind,
  type AIBusinessErrorCode,
} from "@/lib/ai/connections";
import { mintConnectionTicket } from "@/lib/ai/connection-tickets";
import type { AIConnectionExecutionResult } from "@/lib/ai/runtime/capabilities";
import type { PrismaClient } from "@prisma/client";

type DbClient = Pick<PrismaClient, "aIConnection">;

/** Prompts are business data, not commands — bounded like any request body. */
export const AI_EXECUTION_MAX_PROMPT_BYTES = 256 * 1024;
/** A structured-output schema is Vocatrya-owned metadata — bounded. */
export const AI_EXECUTION_MAX_SCHEMA_BYTES = 64 * 1024;
export const AI_EXECUTION_MAX_SCHEMA_NAME_CHARS = 128;
export const AI_EXECUTION_DEFAULT_TIMEOUT_MS = 120_000;
export const AI_EXECUTION_MAX_TIMEOUT_MS = 300_000;

const EXEC_URL_ENV = "VOCATRYA_DESKTOP_EXEC_URL";
const INTERNAL_TOKEN_ENV = "VOCATRYA_DESKTOP_INTERNAL_TOKEN";
const EXECUTE_PATH = "/internal/ai-connections/execute";

export interface ExecuteAIConnectionTextInput {
  userId: string;
  connectionId: string;
  model: string;
  prompt: string;
  /**
   * Structured-output validation contract. When present, the desktop
   * applies the runtime's native schema mechanism if it has one (e.g.
   * `codex exec --output-schema`) and reports which strategy actually
   * ran; prompt-only runtimes ignore the payload because the caller has
   * already embedded the schema in `prompt`. The schema object is
   * Vocatrya-owned — never a user-supplied filesystem path.
   */
  structuredOutput?: {
    schema: Record<string, unknown>;
    schemaName: string;
  };
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecuteAIConnectionTextDeps {
  dbClient?: DbClient;
  execUrl?: string;
  internalToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface AIConnectionTextResult extends AIConnectionExecutionResult {
  connectionId: string;
  durationMs?: number;
  /**
   * Which structured-output mechanism the runtime applied for this call
   * — present only when the request carried `structuredOutput`. The
   * desktop reports the truth; callers never assume it from backendKind.
   */
  structuredStrategy?: string | null;
  /** Runtime-reported stop reason when the CLI envelope exposes one. */
  stopReason?: string | null;
}

function fail(code: AIBusinessErrorCode, message: string): never {
  throw new AIBusinessError(code, message);
}

// Maps a runtime-layer failure code onto the stable business taxonomy.
// Provider-specific detail never reaches this layer — codes only.
function mapDesktopErrorCode(code: string | undefined): AIBusinessErrorCode {
  switch (code) {
    case "RUNTIME_NOT_INSTALLED":
      return AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_INSTALLED;
    case "RUNTIME_BROKEN":
      return AI_BUSINESS_ERROR_CODES.RUNTIME_BROKEN;
    case "REAUTH_REQUIRED":
      return AI_BUSINESS_ERROR_CODES.REAUTH_REQUIRED;
    case "CONNECTION_DISCONNECTED":
      return AI_BUSINESS_ERROR_CODES.CONNECTION_DISCONNECTED;
    case "CONNECTION_ERROR":
      return AI_BUSINESS_ERROR_CODES.CONNECTION_ERROR;
    case "CONNECTION_NOT_FOUND":
    case "CONNECTION_ARCHIVED":
      return AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE;
    case "MODEL_UNAVAILABLE":
      return AI_BUSINESS_ERROR_CODES.MODEL_UNAVAILABLE;
    case "PERMISSION_BOUNDARY_NOT_READY":
      return AI_BUSINESS_ERROR_CODES.PERMISSION_BOUNDARY_NOT_READY;
    case "AI_EXECUTION_TIMEOUT":
      return AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT;
    case "AI_REQUEST_TOO_LARGE":
      return AI_BUSINESS_ERROR_CODES.AI_REQUEST_TOO_LARGE;
    case "BACKEND_UNAVAILABLE":
      return AI_BUSINESS_ERROR_CODES.BACKEND_UNAVAILABLE;
    case "STRUCTURED_OUTPUT_NOT_VERIFIED":
      return AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_NOT_VERIFIED;
    case "STRUCTURED_OUTPUT_UNSUPPORTED":
      return AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_UNSUPPORTED;
    case "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION":
      return AI_BUSINESS_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION;
    // INVALID_TICKET / UNSUPPORTED_BACKEND / op-busy are internal
    // invariants of the transport, not business outcomes — collapse.
    default:
      return AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED;
  }
}

export async function executeAIConnectionText(
  input: ExecuteAIConnectionTextInput,
  deps: ExecuteAIConnectionTextDeps = {},
): Promise<AIConnectionTextResult> {
  const db = deps.dbClient ?? prisma;
  const { userId, connectionId, model, prompt, structuredOutput } = input;

  if (typeof prompt !== "string" || prompt.length === 0) {
    fail(AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED, "Prompt is required");
  }
  if (Buffer.byteLength(prompt, "utf8") > AI_EXECUTION_MAX_PROMPT_BYTES) {
    fail(AI_BUSINESS_ERROR_CODES.AI_REQUEST_TOO_LARGE, "Prompt is too large");
  }
  if (typeof model !== "string" || model.trim().length === 0) {
    fail(AI_BUSINESS_ERROR_CODES.MODEL_UNAVAILABLE, "Model is required");
  }
  let structuredPayload:
    | { schema: Record<string, unknown>; schemaName: string }
    | undefined;
  if (structuredOutput !== undefined) {
    const schema = structuredOutput.schema;
    const schemaName = structuredOutput.schemaName;
    const schemaOk =
      typeof schema === "object" &&
      schema !== null &&
      !Array.isArray(schema) &&
      typeof schemaName === "string" &&
      schemaName.length > 0 &&
      schemaName.length <= AI_EXECUTION_MAX_SCHEMA_NAME_CHARS;
    if (!schemaOk) {
      fail(
        AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
        "structuredOutput requires a schema object and a schemaName",
      );
    }
    if (
      Buffer.byteLength(JSON.stringify(schema), "utf8") >
      AI_EXECUTION_MAX_SCHEMA_BYTES
    ) {
      fail(
        AI_BUSINESS_ERROR_CODES.AI_REQUEST_TOO_LARGE,
        "structuredOutput schema is too large",
      );
    }
    structuredPayload = { schema, schemaName };
  }

  // Ownership is part of the lookup — a connectionId alone never resolves.
  const connection = await db.aIConnection.findFirst({
    where: { id: connectionId, userId },
    select: {
      id: true,
      status: true,
      archivedAt: true,
      backendKind: true,
      provider: true,
    },
  });
  if (!connection || connection.archivedAt !== null) {
    fail(
      AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE,
      "The assigned AI connection is not available",
    );
  }
  switch (connection.status) {
    case "CONNECTED":
      break;
    case "REAUTH_REQUIRED":
      fail(
        AI_BUSINESS_ERROR_CODES.REAUTH_REQUIRED,
        "The assigned AI connection needs re-authentication",
      );
    case "DISCONNECTED":
      fail(
        AI_BUSINESS_ERROR_CODES.CONNECTION_DISCONNECTED,
        "The assigned AI connection is disconnected",
      );
    default:
      fail(
        AI_BUSINESS_ERROR_CODES.CONNECTION_ERROR,
        "The assigned AI connection is in an error state",
      );
  }
  if (!isAIBackendKind(connection.backendKind)) {
    fail(
      AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      "The assigned AI connection has no recognized runtime",
    );
  }

  const execUrl = deps.execUrl ?? process.env[EXEC_URL_ENV];
  const internalToken = deps.internalToken ?? process.env[INTERNAL_TOKEN_ENV];
  if (!execUrl || !internalToken) {
    fail(
      AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      "The desktop runtime channel is not available",
    );
  }

  const ticket = mintConnectionTicket({
    userId,
    operation: "executeText",
    backendKind: connection.backendKind,
    connectionId,
  });

  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? AI_EXECUTION_DEFAULT_TIMEOUT_MS, 1_000),
    AI_EXECUTION_MAX_TIMEOUT_MS,
  );
  const signals = [AbortSignal.timeout(timeoutMs + 15_000)];
  if (input.signal) signals.push(input.signal);

  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${execUrl}${EXECUTE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${internalToken}`,
      },
      body: JSON.stringify({
        ticket: ticket.ticket,
        connectionId,
        model: model.trim(),
        prompt,
        permissionScope: "TEXT_ONLY",
        requestId: `req_${randomUUID()}`,
        timeoutMs,
        // Present only for structured-output probes — the desktop decides
        // whether a native schema mechanism applies it.
        ...(structuredPayload ? { structuredOutput: structuredPayload } : {}),
      }),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      fail(AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED, "Execution aborted");
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      fail(
        AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT,
        "AI execution timed out",
      );
    }
    fail(
      AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      "The desktop runtime channel is unreachable",
    );
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  if (!payload || payload.ok !== true) {
    fail(
      mapDesktopErrorCode(typeof payload?.code === "string" ? payload.code : undefined),
      "AI execution failed",
    );
  }

  return {
    text: typeof payload.text === "string" ? payload.text : "",
    provider: connection.provider,
    backendKind: connection.backendKind,
    model: model.trim(),
    connectionId,
    durationMs:
      typeof payload.durationMs === "number" ? payload.durationMs : undefined,
    structuredStrategy:
      typeof payload.structuredStrategy === "string"
        ? payload.structuredStrategy
        : null,
    stopReason:
      typeof payload.stopReason === "string" ? payload.stopReason : null,
  };
}
