import "server-only";

import prisma from "@/lib/db";
import { generateText, streamText } from "ai";
import { executeManagedStream, managedBusinessError, type ManagedDispatchInput } from "./managed-dispatch";
import { executeByokConnectionTextStream } from "./byok-execution";
import type { HostedManagedClient } from "./managed-client";
import { mintConnectionTicket } from "@/lib/ai/connection-tickets";
import {
  AI_BUSINESS_ERROR_CODES,
  AIBusinessError,
  isAIBackendKind,
  assertAccountExecutionIdentity,
  classifyAIConnection,
  type AIBusinessErrorCode,
} from "@/lib/ai/connections";
import {
  AI_EXECUTION_DEFAULT_TIMEOUT_MS,
  AI_EXECUTION_MAX_PROMPT_BYTES,
  AI_EXECUTION_MAX_TIMEOUT_MS,
} from "@/lib/ai/execution";
import type { PrismaClient } from "@prisma/client";

/**
 * Backend client for the desktop's streaming execution seam
 * (executeTextStream → /internal/ai-connections/execute-stream) and the
 * capability descriptor endpoint (/internal/ai-connections/runtime-state).
 *
 * Same gates as executeAIConnectionText — ownership-scoped lookup, status
 * gate, TEXT_ONLY ticket — plus the desktop's own streamingVerification
 * gate inside the service.
 */

const EXEC_URL_ENV = "VOCATRYA_DESKTOP_EXEC_URL";
const INTERNAL_TOKEN_ENV = "VOCATRYA_DESKTOP_INTERNAL_TOKEN";
const STREAM_PATH = "/internal/ai-connections/execute-stream";
const RUNTIME_STATE_PATH = "/internal/ai-connections/runtime-state";

export type AIStreamEvent =
  | { type: "text-delta"; delta: string }
  | {
      type: "completed";
      text?: string;
      model?: string;
      durationMs?: number;
      runtime?: {
        runtimeReuseHit?: boolean;
        runtimeProcessAgeMs?: number | null;
        runtimeProcessId?: number | null;
        runtimeIdleMs?: number | null;
        runtimeSpawnMs?: number | null;
        runtimeInitMs?: number | null;
        runtimeRestartReason?: string | null;
        threadReuseHit?: boolean;
      };
    }
  | { type: "error"; code: string };

export interface StreamExecutionInput extends Pick<ManagedDispatchInput, "managedAiProvenance" | "managedResource" | "operationId" | "invocationKey" | "attemptIndex"> {
  userId: string;
  connectionId: string;
  model: string;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type DbClient = Pick<PrismaClient, "aIConnection" | "apiKey">;

export interface StreamExecutionDeps {
  managedClient?: HostedManagedClient;
  dbClient?: DbClient;
  execUrl?: string;
  internalToken?: string;
  fetchImpl?: typeof fetch;
  /** Test seam for the BYOK AI SDK call. */
  generateTextImpl?: typeof generateText;
  streamTextImpl?: typeof streamText;
}

function fail(code: AIBusinessErrorCode, message: string): never {
  throw new AIBusinessError(code, message);
}

// Same mapping table as execution.ts — keep one place for it.
const DESKTOP_CODE_MAP: Record<string, AIBusinessErrorCode> = {
  RUNTIME_NOT_INSTALLED: AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_INSTALLED,
  RUNTIME_BROKEN: AI_BUSINESS_ERROR_CODES.RUNTIME_BROKEN,
  REAUTH_REQUIRED: AI_BUSINESS_ERROR_CODES.REAUTH_REQUIRED,
  CONNECTION_DISCONNECTED: AI_BUSINESS_ERROR_CODES.CONNECTION_DISCONNECTED,
  CONNECTION_ERROR: AI_BUSINESS_ERROR_CODES.CONNECTION_ERROR,
  CONNECTION_NOT_FOUND: AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE,
  CONNECTION_ARCHIVED: AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE,
  MODEL_UNAVAILABLE: AI_BUSINESS_ERROR_CODES.MODEL_UNAVAILABLE,
  PERMISSION_BOUNDARY_NOT_READY:
    AI_BUSINESS_ERROR_CODES.PERMISSION_BOUNDARY_NOT_READY,
  AI_EXECUTION_TIMEOUT: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT,
  AI_REQUEST_TOO_LARGE: AI_BUSINESS_ERROR_CODES.AI_REQUEST_TOO_LARGE,
  BACKEND_UNAVAILABLE: AI_BUSINESS_ERROR_CODES.BACKEND_UNAVAILABLE,
  STREAMING_NOT_SUPPORTED: AI_BUSINESS_ERROR_CODES.STREAMING_NOT_SUPPORTED,
  STREAMING_NOT_VERIFIED: AI_BUSINESS_ERROR_CODES.STREAMING_NOT_VERIFIED,
  STREAM_RUNTIME_VERSION_MISMATCH:
    AI_BUSINESS_ERROR_CODES.STREAMING_NOT_VERIFIED,
  NO_REAL_TEXT_DELTA: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
  STREAM_PROTOCOL_UNSUPPORTED: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
  STREAM_PROTOCOL_PARSE_FAILED: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
  STREAM_COMPLETION_INCONSISTENT:
    AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
  STREAM_VENDOR_ERROR: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
  UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION:
    AI_BUSINESS_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION,
};

function mapStreamErrorCode(code: string | undefined): AIBusinessErrorCode {
  return (
    (code ? DESKTOP_CODE_MAP[code] : undefined) ??
    AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED
  );
}

type ConnectionRow = {
  id: string;
  status: string;
  archivedAt: Date | null;
  backendKind: string;
  provider: string;
  authType: string;
  credentialRef: string | null;
  runtimeProfileRef: string | null;
  accountIdentity: string | null;
};

// Shared lookup + status gate — identical semantics to
// executeAIConnectionText so both seams can never disagree about whether a
// connection is usable.
async function loadUsableConnection(
  db: DbClient,
  userId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  const connection = await db.aIConnection.findFirst({
    where: { id: connectionId, userId },
    select: {
      id: true,
      status: true,
      archivedAt: true,
      backendKind: true,
      provider: true,
      authType: true,
      credentialRef: true,
      runtimeProfileRef: true,
      accountIdentity: true,
    },
  });
  if (!connection || connection.archivedAt !== null) {
    fail(
      AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE,
      "The assigned AI connection is not available",
    );
  }
  const classification = classifyAIConnection(connection);
  if (classification === "INVALID") fail(AI_BUSINESS_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION, "Invalid AI connection identity");
  const managed = classification === "MANAGED";
  const byok = classification === "BYOK";
  if (!managed && !byok) assertAccountExecutionIdentity(connection);
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
  if (!managed && !isAIBackendKind(connection.backendKind)) {
    fail(
      AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      "The assigned AI connection has no recognized runtime",
    );
  }
  return connection;
}

function channelConfig(deps: StreamExecutionDeps): {
  base: string;
  token: string;
  fetchImpl: typeof fetch;
} {
  const base = deps.execUrl ?? process.env[EXEC_URL_ENV];
  const token = deps.internalToken ?? process.env[INTERNAL_TOKEN_ENV];
  if (!base || !token) {
    fail(
      AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      "The desktop runtime channel is not available",
    );
  }
  return { base, token, fetchImpl: deps.fetchImpl ?? fetch };
}

/**
 * Stream a plain-text completion through the locked connection. Yields the
 * desktop's normalized events verbatim — the caller decides what to do
 * with deltas (UI text parts) and terminal events.
 *
 * Every desktop error event is surfaced as an AIBusinessError immediately;
 * a stream that ends without a terminal event is AI_EXECUTION_FAILED.
 */
export async function* executeAIConnectionTextStream(
  input: StreamExecutionInput,
  deps: StreamExecutionDeps = {},
): AsyncGenerator<AIStreamEvent> {
  const db = deps.dbClient ?? prisma;
  const { userId, connectionId, model, prompt } = input;

  if (typeof prompt !== "string" || prompt.length === 0) {
    fail(AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED, "Prompt is required");
  }
  if (Buffer.byteLength(prompt, "utf8") > AI_EXECUTION_MAX_PROMPT_BYTES) {
    fail(AI_BUSINESS_ERROR_CODES.AI_REQUEST_TOO_LARGE, "Prompt is too large");
  }
  if (typeof model !== "string" || model.trim().length === 0) {
    fail(AI_BUSINESS_ERROR_CODES.MODEL_UNAVAILABLE, "Model is required");
  }

  const connection = await loadUsableConnection(db, userId, connectionId);
  const streamClassification = classifyAIConnection(connection);
  if (streamClassification === "MANAGED") {
    yield* executeManagedStream(input, deps.managedClient);
    return;
  }
  if (streamClassification === "BYOK") {
    // BYOK streams in-process through the AI SDK — the same text-delta/
    // completed event shape, no desktop channel, no ticket.
    yield* executeByokConnectionTextStream(
      { userId, connection, model, prompt: input.prompt, timeoutMs: input.timeoutMs, signal: input.signal },
      deps,
    );
    return;
  }
  const { base, token, fetchImpl } = channelConfig(deps);

  const ticketRecord = mintConnectionTicket({
    userId,
    operation: "executeText",
    backendKind: connection.backendKind,
    connectionId,
  });

  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? AI_EXECUTION_DEFAULT_TIMEOUT_MS, 1_000),
    AI_EXECUTION_MAX_TIMEOUT_MS,
  );

  // The caller's abort races the HTTP request itself; the desktop aborts
  // the runtime child when its response socket closes.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`${base}${STREAM_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ticket: ticketRecord.ticket,
        connectionId,
        model,
        prompt,
        permissionScope: "TEXT_ONLY",
        timeoutMs,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (input.signal?.aborted) {
      throw Object.assign(new Error("Execution aborted"), {
        name: "AbortError",
      });
    }
    if (controller.signal.aborted) {
      fail(
        AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT,
        "Streaming execution timed out",
      );
    }
    fail(
      AI_BUSINESS_ERROR_CODES.BACKEND_UNAVAILABLE,
      `Desktop streaming channel failed: ${error instanceof Error ? error.message : "unreachable"}`,
    );
  }
  if (!response.ok || !response.body) {
    clearTimeout(timeout);
    // The endpoint answers JSON for validation/gate denials; anything else
    // is a transport failure.
    let code: string | undefined;
    try {
      code = ((await response.json()) as { code?: string }).code;
    } catch {
      /* not JSON */
    }
    fail(
      mapStreamErrorCode(code ?? (response.status === 403 ? "PERMISSION_BOUNDARY_NOT_READY" : undefined)),
      `Streaming request denied (${response.status})`,
    );
  }

  // NDJSON line protocol — one JSON object per line, terminal event last.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let sawTerminal = false;
  try {
    for (;;) {
      if (input.signal?.aborted) {
        throw Object.assign(new Error("Execution aborted"), {
          name: "AbortError",
        });
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        let event: AIStreamEvent;
        try {
          event = JSON.parse(line) as AIStreamEvent;
        } catch {
          fail(
            AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
            "Malformed stream event from desktop",
          );
        }
        if (event.type === "error") {
          fail(
            mapStreamErrorCode(event.code),
            `Streaming execution failed (${event.code})`,
          );
        }
        if (event.type === "completed") sawTerminal = true;
        yield event;
        if (event.type === "completed") return;
      }
    }
    if (!sawTerminal) {
      fail(
        AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
        "Streaming execution ended without a terminal event",
      );
    }
  } finally {
    clearTimeout(timeout);
    reader.cancel().catch(() => undefined);
    if (input.signal) input.signal.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Runtime capability descriptor — what checkStreamingExecutionReadiness
// (capabilities.ts) needs from the desktop: the probed capabilities object
// plus the adapter's current runtime version.
// ---------------------------------------------------------------------------

export interface AccountRuntimeState {
  capabilities: Record<string, unknown> | null;
  runtimeVersion: string | null;
  runtimeReady: boolean;
  nativeSession?: { version: string; models: string[]; configHash: string; ready: boolean } | null;
}

export async function fetchAccountRuntimeState(
  input: { backendKind: string; accountProvider: string },
  deps: Pick<StreamExecutionDeps, "execUrl" | "internalToken" | "fetchImpl"> = {},
): Promise<AccountRuntimeState> {
  const { base, token, fetchImpl } = channelConfig(deps);
  const params = new URLSearchParams({
    backendKind: input.backendKind,
    provider: input.accountProvider,
  });
  let response: Response;
  try {
    response = await fetchImpl(`${base}${RUNTIME_STATE_PATH}?${params}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    fail(
      AI_BUSINESS_ERROR_CODES.BACKEND_UNAVAILABLE,
      `Desktop runtime-state channel failed: ${error instanceof Error ? error.message : "unreachable"}`,
    );
  }
  if (!response.ok) {
    fail(
      AI_BUSINESS_ERROR_CODES.BACKEND_UNAVAILABLE,
      `Runtime state request denied (${response.status})`,
    );
  }
  const body = (await response.json()) as {
    ok?: boolean;
    capabilities?: Record<string, unknown> | null;
    runtimeVersion?: string | null;
    runtimeReady?: boolean;
    nativeSession?: AccountRuntimeState["nativeSession"];
    code?: string;
  };
  if (body.ok !== true) {
    fail(
      mapStreamErrorCode(body.code),
      `Runtime state unavailable (${body.code ?? response.status})`,
    );
  }
  return {
    capabilities: body.capabilities ?? null,
    runtimeVersion: body.runtimeVersion ?? null,
    runtimeReady: body.runtimeReady === true,
    nativeSession: body.nativeSession,
  };
}

/**
 * Per-turn readiness for the ACCOUNT lock path: the connection must still be
 * usable AND its runtime must be verified for streaming at the currently
 * installed version. Distinct from executeTextStream's internal gate, which
 * rejects INSIDE the desktop — this check runs before a turn starts so the
 * route can answer 503 with a stable code instead of opening a stream that
 * dies on the first event.
 */
export async function checkStreamingTurnReadiness(input: {
  userId?: string;
  connection: Omit<ConnectionRow, "id">;
  model: string | null;
  dbClient?: DbClient;
  deps?: StreamExecutionDeps;
}): Promise<void> {
  const { connection, model } = input;
  if (connection.archivedAt !== null) {
    fail(
      AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE,
      "The locked AI connection is archived",
    );
  }
  if (!model) {
    fail(
      AI_BUSINESS_ERROR_CODES.MODEL_UNAVAILABLE,
      "The locked conversation has no model",
    );
  }
  if (connection.status === "REAUTH_REQUIRED") {
    fail(
      AI_BUSINESS_ERROR_CODES.REAUTH_REQUIRED,
      "The locked AI connection needs re-authentication",
    );
  }
  if (connection.status === "DISCONNECTED") {
    fail(
      AI_BUSINESS_ERROR_CODES.CONNECTION_DISCONNECTED,
      "The locked AI connection is disconnected",
    );
  }
  if (connection.status !== "CONNECTED") {
    fail(
      AI_BUSINESS_ERROR_CODES.CONNECTION_ERROR,
      "The locked AI connection is in an error state",
    );
  }
  const classification = classifyAIConnection(connection);
  if (classification === "INVALID") fail(AI_BUSINESS_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION, "Invalid AI connection identity");
  if (classification === "MANAGED") {
    if (!input.userId) fail(AI_BUSINESS_ERROR_CODES.MANAGED_AUTH_REQUIRED, "Hosted identity required");
    const client = input.deps?.managedClient ?? new (await import("./managed-client")).HostedManagedClient();
    let catalog;
    try { catalog = await client.catalog(input.userId); } catch (error) { throw managedBusinessError(error); }
    const entry = catalog.models.find(entry => entry.modelKey === model);
    if (!entry?.available) fail(AI_BUSINESS_ERROR_CODES.MODEL_DISABLED, "Managed model unavailable");
    if (!entry.capabilities.streaming) fail(AI_BUSINESS_ERROR_CODES.CAPABILITY_UNSUPPORTED, "Managed streaming unavailable");
    // Parity with the assignment write gate: a streaming turn also runs the
    // structured decision step — refuse before opening the stream, not
    // mid-turn at the /v1/structured admission.
    if (!entry.capabilities.structuredOutput) fail(AI_BUSINESS_ERROR_CODES.CAPABILITY_UNSUPPORTED, "Managed structured decisions unavailable");
    return;
  }
  if (classification === "BYOK") {
    // BYOK streams natively through the AI SDK — there is no desktop
    // runtime descriptor to probe. Connection status already gated above;
    // credential usability is enforced by the strict binding at execution.
    return;
  }
  assertAccountExecutionIdentity(connection);
  if (!isAIBackendKind(connection.backendKind)) {
    fail(
      AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      "The locked connection has no recognized runtime",
    );
  }

  const state = await fetchAccountRuntimeState(
    { backendKind: connection.backendKind, accountProvider: connection.provider },
    input.deps ?? {},
  );
  // Gate parity with the desktop's executeTextStream block
  // (connection-service.js): localOneShot boundary, streaming mechanism +
  // verification state, and version pinned to the verified build.
  const capabilities = state.capabilities as
    | {
        implemented?: boolean;
        execution?: {
          localOneShot?: boolean;
          streaming?: boolean;
          streamingVerification?: string;
          streamingVerifiedRuntimeVersion?: string | null;
        };
      }
    | null;
  if (!capabilities?.implemented || !capabilities.execution?.localOneShot) {
    fail(
      AI_BUSINESS_ERROR_CODES.PERMISSION_BOUNDARY_NOT_READY,
      "The runtime does not expose the TEXT_ONLY execution boundary",
    );
  }
  if (capabilities.execution.streaming !== true) {
    fail(
      AI_BUSINESS_ERROR_CODES.STREAMING_NOT_SUPPORTED,
      "The runtime does not support streaming execution",
    );
  }
  if (capabilities.execution.streamingVerification !== "PASS") {
    fail(
      AI_BUSINESS_ERROR_CODES.STREAMING_NOT_VERIFIED,
      "The runtime's streaming has not been verified",
    );
  }
  const verifiedVersion = capabilities.execution.streamingVerifiedRuntimeVersion;
  // A PASS without a bound version is as unverifiable as a drift — the
  // helper (checkStreamingExecutionReadiness) enforces the same: !bound
  // || mismatch → NOT_VERIFIED. Keep the two paths identical.
  if (!verifiedVersion || state.runtimeVersion !== verifiedVersion) {
    fail(
      AI_BUSINESS_ERROR_CODES.STREAMING_NOT_VERIFIED,
      verifiedVersion
        ? `Runtime version changed since verification (${state.runtimeVersion} != ${verifiedVersion})`
        : "The runtime's streaming PASS is not bound to a version",
    );
  }
}
