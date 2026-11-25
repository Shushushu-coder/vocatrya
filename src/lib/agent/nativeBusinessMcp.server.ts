/**
 * Slice-1 native business MCP bridge (server side).
 *
 * A native Codex turn may call a strictly read-only subset of the app's agent
 * tools through a loopback MCP endpoint. Each turn mints one short-lived
 * bearer ticket bound to {userId, conversationId, requestId, allowedTools};
 * the desktop injects it as `bearer_token_env_var` for the single configured
 * `vocatrya_business` MCP server. Tickets are revoked the moment the turn
 * finishes, errors or aborts, and every tools/call re-validates the ticket,
 * the tool allowlist and conversation ownership — so a leaked or replayed
 * token fails closed.
 *
 * Same globalThis-singleton technique as connection-tickets.ts: the Next
 * standalone server compiles route entries into separate webpack bundles, so
 * module-local state would not be shared between the chat route that mints
 * and this endpoint that resolves.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { asSchema } from "ai";
import { z, type ZodTypeAny } from "zod";
import prisma from "@/lib/db";
import {
  AgentGetJobSchema,
  AgentGetResumeSchema,
  AgentListJobsSchema,
  AgentTodayPlanReadSchema,
} from "@/models/agent.schema";
import { buildGetJobTool } from "@/lib/agent/tools/getJob";
import { buildGetResumeTool } from "@/lib/agent/tools/getResume";
import { buildListJobsTool } from "@/lib/agent/tools/listJobs";
import { buildTodayPlanReadTool } from "@/lib/agent/tools/todayPlan";
import { buildNotionAgentTools } from "@/lib/agent/tools/notion";
import { buildFeishuAgentTools } from "@/lib/agent/tools/feishu";
import { NOTION_READ_TOOL_NAMES } from "@/lib/extensions/notion/constants";
import { FEISHU_READ_TOOL_NAMES } from "@/lib/extensions/feishu/constants";
import { effectiveAgentToolNames } from "@/lib/agent/toolPermissions";
import type { ConversationRequest } from "./conversationRequest";
import { log } from "@/lib/telemetry";

export const NATIVE_BUSINESS_MCP_SERVER_KEY = "vocatrya_business";
export const NATIVE_BUSINESS_MCP_TOKEN_ENV = "VOCATRYA_NATIVE_BUSINESS_MCP_TOKEN";
/** Slightly longer than the native turn timeout so the token outlives the turn but nothing else. */
export const NATIVE_BUSINESS_TICKET_TTL_MS = 140 * 1000;
/** Bounded result text returned to the runtime — large bodies stay in the app. */
const RESULT_MAX_CHARS = 8000;

/** The four core business reads — everything else is denied by construction. */
export const NATIVE_BUSINESS_CORE_TOOLS = [
  "list_jobs",
  "get_job",
  "get_resume",
  "today_plan_read",
] as const;
const NATIVE_BUSINESS_READ_TOOLS = new Set<string>([
  ...NATIVE_BUSINESS_CORE_TOOLS,
  ...NOTION_READ_TOOL_NAMES,
  ...FEISHU_READ_TOOL_NAMES,
]);

/** Caps the allowlist a ticket may carry — must match the desktop-side bound. */
export const NATIVE_BUSINESS_READ_TOOLS_MAX = 16;

const CORE_SCHEMAS: Record<string, ZodTypeAny> = {
  list_jobs: AgentListJobsSchema,
  get_job: AgentGetJobSchema,
  get_resume: AgentGetResumeSchema,
  today_plan_read: AgentTodayPlanReadSchema,
};

/**
 * Per-turn allowlist: the role/integration-aware set the in-app path already
 * computes, intersected with the slice-1 read-only surface. Never widened
 * here — a tool absent from effectiveAgentToolNames stays absent.
 */
export function nativeBusinessAllowedTools(input: Parameters<typeof effectiveAgentToolNames>[0]): string[] {
  return effectiveAgentToolNames(input).filter(name => NATIVE_BUSINESS_READ_TOOLS.has(name));
}

export interface NativeBusinessTicketRecord {
  token: string;
  userId: string;
  conversationId: string;
  requestId: string;
  allowedTools: readonly string[];
  pageJobId: string | null;
  pageResumeId: string | null;
  expiresAt: number;
}

interface NativeBusinessTicketStore {
  tickets: Map<string, NativeBusinessTicketRecord>;
}

const STORE_KEY = Symbol.for("vocatrya.nativeBusinessMcpTickets.v1");

function ticketStore(): NativeBusinessTicketStore {
  const scope = globalThis as unknown as Record<symbol, NativeBusinessTicketStore | undefined>;
  if (!scope[STORE_KEY]) scope[STORE_KEY] = { tickets: new Map() };
  return scope[STORE_KEY];
}

function sweep(store: NativeBusinessTicketStore, now: number) {
  for (const [token, record] of store.tickets) {
    if (record.expiresAt <= now) store.tickets.delete(token);
  }
}

export function mintNativeBusinessTicket(input: {
  userId: string;
  conversationId: string;
  requestId: string;
  allowedTools: readonly string[];
  pageJobId?: string | null;
  pageResumeId?: string | null;
  now?: number;
}): NativeBusinessTicketRecord {
  const now = input.now ?? Date.now();
  const store = ticketStore();
  sweep(store, now);
  const record: NativeBusinessTicketRecord = {
    token: `nbt_${randomBytes(24).toString("base64url")}`,
    userId: input.userId,
    conversationId: input.conversationId,
    requestId: input.requestId,
    allowedTools: [...input.allowedTools].filter(name => NATIVE_BUSINESS_READ_TOOLS.has(name)),
    pageJobId: typeof input.pageJobId === "string" ? input.pageJobId : null,
    pageResumeId: typeof input.pageResumeId === "string" ? input.pageResumeId : null,
    expiresAt: now + NATIVE_BUSINESS_TICKET_TTL_MS,
  };
  store.tickets.set(record.token, record);
  return record;
}

/** Validates a bearer token for the MCP endpoint. Never marks consumed — one turn may make many calls. */
export function resolveNativeBusinessTicket(
  token: string | null | undefined,
  { now }: { now?: number } = {},
): NativeBusinessTicketRecord | null {
  if (!token || token.length > 256) return null;
  const at = now ?? Date.now();
  const store = ticketStore();
  sweep(store, at);
  const record = store.tickets.get(token);
  if (!record || record.expiresAt <= at) return null;
  return record;
}

/** End-of-turn revocation: removes the token so expiry/cancellation/replay all fail closed. */
export function revokeNativeBusinessTicket(token: string | null | undefined): void {
  if (!token) return;
  ticketStore().tickets.delete(token);
}

/** Test hook — clears all outstanding business tickets. */
export function resetNativeBusinessTickets(): void {
  ticketStore().tickets.clear();
}

function toolContext(record: NativeBusinessTicketRecord) {
  // today_plan_read only dereferences request.conversationId; the ticket is
  // already bound to the live requestId, so no mutable request state leaks in.
  const request = {
    conversationId: record.conversationId,
    requestId: record.requestId,
    userId: record.userId,
  } as unknown as ConversationRequest;
  return { userId: record.userId, request };
}

type ExecutableTool = { inputSchema?: unknown; execute?: (input: unknown, options: unknown) => Promise<unknown> };

function findToolExecutor(record: NativeBusinessTicketRecord, name: string): ExecutableTool | null {
  switch (name) {
    case "list_jobs":
      return buildListJobsTool(record.userId) as unknown as ExecutableTool;
    case "get_job":
      return buildGetJobTool(record.userId, record.pageJobId ?? undefined) as unknown as ExecutableTool;
    case "get_resume":
      return buildGetResumeTool(record.userId, record.pageResumeId ?? undefined) as unknown as ExecutableTool;
    case "today_plan_read":
      return buildTodayPlanReadTool(record.userId, toolContext(record).request) as unknown as ExecutableTool;
    default: {
      const ctx = toolContext(record);
      if ((NOTION_READ_TOOL_NAMES as readonly string[]).includes(name)) {
        const tools = buildNotionAgentTools(ctx);
        return (tools[name] as unknown as ExecutableTool) ?? null;
      }
      if ((FEISHU_READ_TOOL_NAMES as readonly string[]).includes(name)) {
        const tools = buildFeishuAgentTools(ctx);
        return (tools[name] as unknown as ExecutableTool) ?? null;
      }
      return null;
    }
  }
}

/** Zod schema usable directly as the MCP `inputSchema` (SDK compiles to JSON). */
function asMcpInputSchema(schema: unknown): ZodTypeAny | undefined {
  return schema instanceof z.ZodType ? (schema as ZodTypeAny) : undefined;
}

/** Bounded text serialization of a tool result for the MCP wire. */
function boundedResultText(result: unknown): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    text = String(result);
  }
  if (text.length <= RESULT_MAX_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, RESULT_MAX_CHARS)}…[truncated]`, truncated: true };
}

/** tools/list projection — description + Zod input schema for one allowlisted tool. */
export function findNativeBusinessTool(
  record: NativeBusinessTicketRecord,
  name: string,
): { description: string; inputSchema: ZodTypeAny | undefined } | null {
  if (!record.allowedTools.includes(name) || !NATIVE_BUSINESS_READ_TOOLS.has(name)) return null;
  const executor = findToolExecutor(record, name);
  if (!executor?.execute) return null;
  return {
    description: (executor as { description?: string }).description ?? `${name} (read-only)`,
    inputSchema: asMcpInputSchema(CORE_SCHEMAS[name] ?? executor.inputSchema),
  };
}

export type NativeBusinessCallResult =
  | { ok: true; content: { type: "text"; text: string }[] }
  | { ok: false; error: string };

/**
 * Executes one tools/call after validating ticket → allowlist → ownership.
 * Returns a plain result so the MCP route can map failures to isError
 * responses; nothing here throws for expected denials.
 */
export async function executeNativeBusinessToolCall(input: {
  record: NativeBusinessTicketRecord;
  name: string;
  args: unknown;
  db?: typeof prisma;
}): Promise<NativeBusinessCallResult> {
  const { record, name, args } = input;
  const db = input.db ?? prisma;
  // Ownership + live lease re-checked on every call — the tool executes only
  // while the bound turn still owns the conversation.
  const owned = await db.chatConversation.findFirst({
    where: {
      id: record.conversationId,
      userId: record.userId,
      archivedAt: null,
      activeRequestId: record.requestId,
      activeRequestExpiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "ticket context revoked" };
  if (!record.allowedTools.includes(name)) return { ok: false, error: "tool not allowed for this turn" };
  const executor = findToolExecutor(record, name);
  if (!executor?.execute) return { ok: false, error: "tool unavailable" };

  const core = CORE_SCHEMAS[name];
  if (core) {
    const parsed = core.safeParse(args ?? {});
    if (!parsed.success) {
      return { ok: false, error: `invalid input: ${parsed.error.issues.map(i => i.message).join("; ")}` };
    }
    try {
      const result = await executor.execute(parsed.data, { toolCallId: "mcp", messages: [], abortSignal: undefined });
      const { text } = boundedResultText(result);
      return { ok: true, content: [{ type: "text", text }] };
    } catch (error) {
      log.error("[native-mcp] core tool failed", { tool: name, error: String(error) });
      return { ok: false, error: "tool execution failed" };
    }
  }
  let callArgs: unknown = args ?? {};
  const schema = asMcpInputSchema(executor.inputSchema) ?? (executor.inputSchema ? asSchema(executor.inputSchema as never) : undefined);
  const validate = (schema as { validate?: (value: unknown) => Promise<{ success: boolean; value?: unknown; error?: { message?: string } } | { success: boolean; value?: unknown; error?: { message?: string } }> })?.validate;
  if (typeof validate === "function") {
    const validated = await validate.call(schema, callArgs);
    if (!validated.success) {
      return { ok: false, error: `invalid input: ${validated.error?.message ?? "schema mismatch"}` };
    }
    callArgs = validated.value;
  }
  try {
    const result = await executor.execute(callArgs, { toolCallId: "mcp", messages: [], abortSignal: undefined });
    const { text } = boundedResultText(result);
    return { ok: true, content: [{ type: "text", text }] };
  } catch (error) {
    log.error("[native-mcp] extension tool failed", { tool: name, error: String(error) });
    return { ok: false, error: "tool execution failed" };
  }
}
