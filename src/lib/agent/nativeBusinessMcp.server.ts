/**
 * Native business MCP bridge (server side) — Slice 1 (reads) + Slice 2 (writes
 * with non-blocking durable approval proposals).
 *
 * A native Codex turn calls business tools through a loopback MCP endpoint.
 * Each turn mints one short-lived bearer ticket bound to:
 *   {userId, conversationId, requestId, allowedTools, permissionMode, agentRole, turnKey, ...}
 *
 * Security & approval invariants:
 * - Tool eligibility and approval gates NEVER hardcode static role rules; they
 *   dynamically reuse `effectiveAgentToolNames(...)` and `agentToolApproval(...)`
 *   from `toolPermissions.ts`.
 * - Every tools/call re-validates ticket, allowlist, conversation ownership +
 *   active request lease, and live integration capabilities.
 * - Operations requiring user approval NEVER block inside MCP `tools/call`:
 *   they synchronously persist a frozen `AgentOperationProposal` row and
 *   immediately return an honest `approval_required` receipt (never `saved:true`).
 * - Full-access detached external writes atomically create + pre-authorize an
 *   `AgentOperationProposal` + `HarnessTask` and return an honest `queued`
 *   receipt (never `saved:true`).
 *
 * Same globalThis-singleton technique as connection-tickets.ts: the Next
 * standalone server compiles route entries into separate webpack bundles, so
 * module-local state would not be shared between the chat route that mints
 * and this endpoint that resolves.
 */
import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { asSchema, type LanguageModel } from "ai";
import type { PrismaClient } from "@prisma/client";
import { z, type ZodTypeAny } from "zod";
import prisma from "@/lib/db";
import {
  AgentAddJobSchema,
  AgentCanonicalMatchJobSchema,
  AgentGetJobSchema,
  AgentGetResumeSchema,
  AgentListJobsSchema,
  AgentMatchJobSchema,
  AgentNotionUpdateContentSchema,
  AgentReviewResumeSchema,
  AgentTodayPlanReadSchema,
  AgentTodayPlanSchema,
} from "@/models/agent.schema";
import { AGENT_TOOL_DESCRIPTIONS } from "@/lib/agent/prompt";
import { buildGetJobTool } from "@/lib/agent/tools/getJob";
import { buildGetResumeTool } from "@/lib/agent/tools/getResume";
import { buildListJobsTool } from "@/lib/agent/tools/listJobs";
import { buildTodayPlanReadTool } from "@/lib/agent/tools/todayPlan";
import { buildNotionAgentTools } from "@/lib/agent/tools/notion";
import { buildFeishuAgentTools } from "@/lib/agent/tools/feishu";
import {
  NOTION_ALL_TOOL_NAMES,
  NOTION_READ_TOOL_NAMES,
  NOTION_TOOL,
  NOTION_WRITE_TOOL_NAMES,
} from "@/lib/extensions/notion/constants";
import {
  FEISHU_ALL_TOOL_NAMES,
  FEISHU_READ_TOOL_NAMES,
  FEISHU_WRITE_TOOL_NAMES,
} from "@/lib/extensions/feishu/constants";
import { agentToolApproval, effectiveAgentToolNames } from "@/lib/agent/toolPermissions";
import { normalizeAgentRole } from "@/lib/agent/agentRoles";
import { isPermissionMode, type PermissionMode } from "@/lib/agent/preferences";
import {
  DETACHED_WRITE_SPECS,
  detachedConnectionMaterial,
  detachedWriteInputHash,
  isDetachedToolAllowed,
  isDetachedWriteTool,
} from "@/lib/agent/detachedWrite";
import {
  createAndApproveFullAccessProposal,
  createNativeOperationProposal,
} from "@/lib/agent/operationProposal";
import {
  executeAddJobWrite,
  executeLegacyMatchJobWrite,
  executeReviewResumeWrite,
  executeTodayPlanWrite,
  localProposalInputHash,
  localProposalSummaryOf,
  validateLocalProposalInput,
} from "@/lib/agent/localProposalWrite";
import type { ConversationRequest } from "./conversationRequest";
import { log } from "@/lib/telemetry";

export const NATIVE_BUSINESS_MCP_SERVER_KEY = "vocatrya_business";
export const NATIVE_BUSINESS_MCP_TOKEN_ENV = "VOCATRYA_NATIVE_BUSINESS_MCP_TOKEN";
/** Slightly longer than the native turn timeout so the token outlives the turn but nothing else. */
export const NATIVE_BUSINESS_TICKET_TTL_MS = 140 * 1000;
/** Bounded result text returned to the runtime — large bodies stay in the app. */
const RESULT_MAX_CHARS = 8000;

/** Core business read tools (Slice 1). */
export const NATIVE_BUSINESS_CORE_TOOLS = [
  "list_jobs",
  "get_job",
  "get_resume",
  "today_plan_read",
] as const;

/** Core business write tools (Slice 2). */
export const NATIVE_BUSINESS_CORE_WRITE_TOOLS = [
  "add_job",
  "today_plan",
  "review_resume",
  "match_job",
] as const;

const NATIVE_BUSINESS_READ_TOOLS = new Set<string>([
  ...NATIVE_BUSINESS_CORE_TOOLS,
  ...NOTION_READ_TOOL_NAMES,
  ...FEISHU_READ_TOOL_NAMES,
]);

const NATIVE_BUSINESS_WRITE_TOOLS = new Set<string>([
  ...NATIVE_BUSINESS_CORE_WRITE_TOOLS,
  ...NOTION_WRITE_TOOL_NAMES,
  ...FEISHU_WRITE_TOOL_NAMES,
]);

const NATIVE_BUSINESS_TOOLS = new Set<string>([
  ...NATIVE_BUSINESS_READ_TOOLS,
  ...NATIVE_BUSINESS_WRITE_TOOLS,
]);

/** Caps the allowlist a ticket may carry — must match the desktop-side bound. */
export const NATIVE_BUSINESS_TOOLS_MAX = 24;
/** Backward-compatible alias for Slice 1 callers. */
export const NATIVE_BUSINESS_READ_TOOLS_MAX = NATIVE_BUSINESS_TOOLS_MAX;

export function isNativeBusinessWriteTool(name: string): boolean {
  return NATIVE_BUSINESS_WRITE_TOOLS.has(name);
}

const CORE_READ_SCHEMAS: Record<string, ZodTypeAny> = {
  list_jobs: AgentListJobsSchema,
  get_job: AgentGetJobSchema,
  get_resume: AgentGetResumeSchema,
  today_plan_read: AgentTodayPlanReadSchema,
};

/**
 * Per-turn allowlist: the role/integration-aware set the in-app path already
 * computes via `effectiveAgentToolNames`, intersected with the native bridge
 * surface. Never widened and never hardcoded per role.
 */
export function nativeBusinessAllowedTools(
  input: Parameters<typeof effectiveAgentToolNames>[0],
): string[] {
  return effectiveAgentToolNames(input)
    .filter((name) => NATIVE_BUSINESS_TOOLS.has(name))
    .slice(0, NATIVE_BUSINESS_TOOLS_MAX);
}

export interface NativeBusinessTicketRecord {
  token: string;
  userId: string;
  conversationId: string;
  requestId: string;
  allowedTools: readonly string[];
  permissionMode: PermissionMode;
  agentRole: string | null;
  turnKey: string;
  freshNativeFull: boolean;
  canonicalJobs: boolean;
  connectionId: string | null;
  model: string | null;
  provider: string | null;
  pageJobId: string | null;
  pageResumeId: string | null;
  /** D08: active ChatTurnStep id on unified turns for live step-role verification. */
  stepId: string | null;
  unified: boolean;
  /** D06: compound Step 2 code guard forcing today_plan add -> suggest draft card. */
  forceTodayPlanSuggestOnly: boolean;
  /** Proposal IDs genuinely created by THIS turn's MCP calls — prevents spoofed approval cards. */
  mintedProposalIds: Set<string>;
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
  permissionMode?: PermissionMode;
  agentRole?: string | null;
  turnKey?: string;
  freshNativeFull?: boolean;
  canonicalJobs?: boolean;
  connectionId?: string | null;
  model?: string | null;
  provider?: string | null;
  pageJobId?: string | null;
  pageResumeId?: string | null;
  taskExtraTools?: readonly string[] | null;
  stepId?: string | null;
  unified?: boolean;
  forceTodayPlanSuggestOnly?: boolean;
  now?: number;
}): NativeBusinessTicketRecord {
  const now = input.now ?? Date.now();
  const store = ticketStore();
  sweep(store, now);
  const agentRole = normalizeAgentRole(input.agentRole);
  const freshNativeFull = input.freshNativeFull === true;
  const canonicalJobs = input.canonicalJobs === true || freshNativeFull;
  const permissionMode: PermissionMode = isPermissionMode(input.permissionMode)
    ? input.permissionMode
    : "ask";

  // Defense-in-depth: re-intersect with the role surface when a named role is bound.
  const roleCeiling = agentRole
    ? new Set(
        effectiveAgentToolNames({
          agentRole,
          freshNativeFull,
          notionTools: NOTION_ALL_TOOL_NAMES,
          feishuTools: FEISHU_ALL_TOOL_NAMES,
          taskExtraTools: input.taskExtraTools,
        }),
      )
    : null;

  const deduped: string[] = [];
  for (const name of input.allowedTools) {
    if (!NATIVE_BUSINESS_TOOLS.has(name)) continue;
    if (roleCeiling && !roleCeiling.has(name)) continue;
    if (deduped.includes(name)) continue;
    deduped.push(name);
    if (deduped.length >= NATIVE_BUSINESS_TOOLS_MAX) break;
  }

  const record: NativeBusinessTicketRecord = {
    token: `nbt_${randomBytes(24).toString("base64url")}`,
    userId: input.userId,
    conversationId: input.conversationId,
    requestId: input.requestId,
    allowedTools: deduped,
    permissionMode,
    agentRole,
    turnKey: input.turnKey ?? input.requestId,
    freshNativeFull,
    canonicalJobs,
    connectionId: typeof input.connectionId === "string" ? input.connectionId : null,
    model: typeof input.model === "string" ? input.model : null,
    provider: typeof input.provider === "string" ? input.provider : null,
    pageJobId: typeof input.pageJobId === "string" ? input.pageJobId : null,
    pageResumeId: typeof input.pageResumeId === "string" ? input.pageResumeId : null,
    stepId: typeof input.stepId === "string" ? input.stepId : null,
    unified: input.unified === true,
    forceTodayPlanSuggestOnly: input.forceTodayPlanSuggestOnly === true,
    mintedProposalIds: new Set<string>(),
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

function toolContext(record: NativeBusinessTicketRecord, db?: PrismaClient) {
  const request = {
    conversationId: record.conversationId,
    requestId: record.requestId,
    userId: record.userId,
  } as unknown as ConversationRequest;
  return { userId: record.userId, request, ...(db ? { db } : {}) };
}

type ExecutableTool = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options: unknown) => Promise<unknown>;
};

function findReadToolExecutor(
  record: NativeBusinessTicketRecord,
  name: string,
  db?: PrismaClient,
): ExecutableTool | null {
  switch (name) {
    case "list_jobs":
      return buildListJobsTool(record.userId) as unknown as ExecutableTool;
    case "get_job":
      return buildGetJobTool(record.userId, record.pageJobId ?? undefined) as unknown as ExecutableTool;
    case "get_resume":
      return buildGetResumeTool(record.userId, record.pageResumeId ?? undefined) as unknown as ExecutableTool;
    case "today_plan_read":
      return buildTodayPlanReadTool(record.userId, toolContext(record, db).request) as unknown as ExecutableTool;
    default: {
      const ctx = toolContext(record, db);
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

function boundedSummary(summary: { target?: string; content?: string }): {
  target?: string;
  content?: string;
} {
  return {
    ...(summary.target ? { target: summary.target.slice(0, 160) } : {}),
    ...(summary.content ? { content: summary.content.slice(0, 200) } : {}),
  };
}

export type NativeBusinessToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export function annotationsForNativeBusinessTool(name: string): NativeBusinessToolAnnotations {
  if (NATIVE_BUSINESS_READ_TOOLS.has(name)) {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }
  if (name === NOTION_TOOL.deletePages) {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
  }
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
}

/** tools/list projection — description, Zod input schema, and MCP annotations for one allowlisted tool. */
export function findNativeBusinessTool(
  record: NativeBusinessTicketRecord,
  name: string,
): {
  description: string;
  inputSchema: ZodTypeAny | undefined;
  annotations: NativeBusinessToolAnnotations;
} | null {
  if (!record.allowedTools.includes(name) || !NATIVE_BUSINESS_TOOLS.has(name)) return null;
  const annotations = annotationsForNativeBusinessTool(name);

  if (NATIVE_BUSINESS_READ_TOOLS.has(name)) {
    const executor = findReadToolExecutor(record, name);
    if (!executor?.execute) return null;
    return {
      description: executor.description ?? `${name} (read-only)`,
      inputSchema: asMcpInputSchema(CORE_READ_SCHEMAS[name] ?? executor.inputSchema),
      annotations,
    };
  }

  switch (name) {
    case "add_job":
      return {
        description: record.canonicalJobs
          ? AGENT_TOOL_DESCRIPTIONS.add_job_canonical
          : AGENT_TOOL_DESCRIPTIONS.add_job,
        inputSchema: record.canonicalJobs
          ? AgentAddJobSchema
          : AgentAddJobSchema.omit({ deadlineOn: true }),
        annotations,
      };
    case "today_plan":
      return {
        description: AGENT_TOOL_DESCRIPTIONS.today_plan,
        inputSchema: AgentTodayPlanSchema,
        annotations,
      };
    case "review_resume":
      return {
        description: AGENT_TOOL_DESCRIPTIONS.review_resume,
        inputSchema: AgentReviewResumeSchema,
        annotations,
      };
    case "match_job":
      return {
        description: record.freshNativeFull
          ? AGENT_TOOL_DESCRIPTIONS.match_job_canonical
          : AGENT_TOOL_DESCRIPTIONS.match_job,
        inputSchema: record.freshNativeFull
          ? AgentCanonicalMatchJobSchema
          : AgentMatchJobSchema,
        annotations,
      };
    case NOTION_TOOL.updateContent:
      return {
        description: AGENT_TOOL_DESCRIPTIONS.notion_update_content,
        inputSchema: AgentNotionUpdateContentSchema,
        annotations,
      };
    default: {
      const detached = DETACHED_WRITE_SPECS[name];
      if (!detached) return null;
      return {
        description:
          AGENT_TOOL_DESCRIPTIONS[name as keyof typeof AGENT_TOOL_DESCRIPTIONS] ??
          `${name} (approval-gated)`,
        inputSchema: asMcpInputSchema(detached.schema),
        annotations,
      };
    }
  }
}

export type NativeBusinessCallResult =
  | { ok: true; content: { type: "text"; text: string }[] }
  | { ok: false; error: string };

function okJson(payload: unknown): NativeBusinessCallResult {
  const { text } = boundedResultText(payload);
  return { ok: true, content: [{ type: "text", text }] };
}

function approvalRequiredPayload(input: {
  tool: string;
  proposalId: string;
  approvalId: string;
  expiresAt: Date;
  summary: { target?: string; content?: string };
}): Record<string, unknown> {
  return {
    saved: false,
    ...(input.tool === "add_job" ? { created: false } : {}),
    status: "approval_required",
    code: "APPROVAL_REQUIRED",
    tool: input.tool,
    proposalId: input.proposalId,
    approvalId: input.approvalId,
    expiresAt: input.expiresAt.toISOString(),
    summary: boundedSummary(input.summary),
    message:
      "Approval required before executing this action. A durable approval card has been created; do not claim it has been saved or completed.",
  };
}

/**
 * Executes one tools/call after validating ticket → allowlist → ownership →
 * live role/capability → dynamic approval gate.
 *
 * Approval-gated writes NEVER block: they synchronously create a frozen
 * `AgentOperationProposal` and immediately return `approval_required`.
 */
export async function executeNativeBusinessToolCall(input: {
  record: NativeBusinessTicketRecord;
  name: string;
  args: unknown;
  db?: PrismaClient;
  /** Test seam for nested generation tools (`review_resume`, legacy `match_job`). */
  model?: LanguageModel;
  /** Test seam to observe or suppress background runner kick in full mode. */
  kickRunner?: (db: PrismaClient) => void;
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
    select: { id: true, agentRole: true },
  });
  if (!owned) return { ok: false, error: "ticket context revoked" };
  if (!record.allowedTools.includes(name) || !NATIVE_BUSINESS_TOOLS.has(name)) {
    return { ok: false, error: "tool not allowed for this turn" };
  }

  // Re-check persisted role surface: on unified turns verify against the active
  // ChatTurnStep's locked role (D08); on legacy rows verify against owned.agentRole.
  let liveRole: string | null = record.agentRole;
  if (record.stepId) {
    const liveStep = await db.chatTurnStep.findFirst({
      where: {
        id: record.stepId,
        userId: record.userId,
        conversationId: record.conversationId,
      },
      select: { role: true },
    });
    if (!liveStep) return { ok: false, error: "step context revoked" };
    liveRole = normalizeAgentRole(liveStep.role);
  } else if (!record.unified && owned.agentRole !== undefined) {
    liveRole = normalizeAgentRole(owned.agentRole);
  }
  if (liveRole) {
    const roleAllowed = effectiveAgentToolNames({
      agentRole: liveRole,
      freshNativeFull: record.freshNativeFull,
      notionTools: NOTION_ALL_TOOL_NAMES,
      feishuTools: FEISHU_ALL_TOOL_NAMES,
      unified: record.unified,
    });
    if (!roleAllowed.includes(name)) {
      return { ok: false, error: "tool forbidden for conversation role" };
    }
  }

  // ------------------------------------------------------------ READ TOOLS
  if (NATIVE_BUSINESS_READ_TOOLS.has(name)) {
    const executor = findReadToolExecutor(record, name, db);
    if (!executor?.execute) return { ok: false, error: "tool unavailable" };
    const core = CORE_READ_SCHEMAS[name];
    if (core) {
      const parsed = core.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          ok: false,
          error: `invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        };
      }
      try {
        const result = await executor.execute(parsed.data, {
          toolCallId: "mcp",
          messages: [],
          abortSignal: undefined,
        });
        return okJson(result);
      } catch (error) {
        log.error("[native-mcp] core read tool failed", { tool: name, error: String(error) });
        return { ok: false, error: "tool execution failed" };
      }
    }
    let callArgs: unknown = args ?? {};
    const schema =
      asMcpInputSchema(executor.inputSchema) ??
      (executor.inputSchema ? asSchema(executor.inputSchema as never) : undefined);
    const validate = (
      schema as {
        validate?: (
          value: unknown,
        ) => Promise<
          | { success: boolean; value?: unknown; error?: { message?: string } }
        > | { success: boolean; value?: unknown; error?: { message?: string } };
      }
    )?.validate;
    if (typeof validate === "function") {
      const validated = await validate.call(schema, callArgs);
      if (!validated.success) {
        return {
          ok: false,
          error: `invalid input: ${validated.error?.message ?? "schema mismatch"}`,
        };
      }
      callArgs = validated.value;
    }
    try {
      const result = await executor.execute(callArgs, {
        toolCallId: "mcp",
        messages: [],
        abortSignal: undefined,
      });
      return okJson(result);
    } catch (error) {
      log.error("[native-mcp] extension read tool failed", { tool: name, error: String(error) });
      return { ok: false, error: "tool execution failed" };
    }
  }

  // ----------------------------------------------------------- WRITE TOOLS
  // Dynamic approval policy from toolPermissions.ts — never hardcoded here.
  const approvalPolicy = agentToolApproval(name, record.freshNativeFull, record.permissionMode);

  // 1. review_resume (direct execute — writes only user's own reviewData)
  if (name === "review_resume") {
    const parsed = AgentReviewResumeSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    try {
      const result = await executeReviewResumeWrite({
        userId: record.userId,
        pageResumeId: record.pageResumeId,
        rawInput: parsed.data,
        connectionId: record.connectionId,
        modelName: record.model,
        provider: record.provider,
        model: input.model,
        toolCallId: `native-mcp-${randomUUID()}`,
        db,
      });
      return okJson(result);
    } catch (error) {
      log.error("[native-mcp] review_resume failed", { error: String(error) });
      return { ok: false, error: "tool execution failed" };
    }
  }

  // 2. today_plan (`suggest` always approval-gated; direct actions write immediately;
  // compound Step 2 forces `add` -> `suggest` draft card per D06).
  if (name === "today_plan") {
    const coercedArgs =
      record.forceTodayPlanSuggestOnly &&
      args &&
      typeof args === "object" &&
      (args as { action?: unknown }).action === "add"
        ? { ...(args as Record<string, unknown>), action: "suggest" }
        : (args ?? {});
    const validated = validateLocalProposalInput("today_plan", coercedArgs);
    if (!validated.ok) {
      return { ok: false, error: `invalid input: ${validated.error}` };
    }
    const needsApproval =
      approvalPolicy === "always" ||
      (approvalPolicy === "conditional" && validated.data.action === "suggest");
    if (needsApproval) {
      try {
        const proposal = await createNativeOperationProposal(db, {
          userId: record.userId,
          conversationId: record.conversationId,
          turnKey: record.turnKey,
          toolName: "today_plan",
          validatedInput: validated.data,
          inputHash: localProposalInputHash(validated.data),
          material: { conversationId: record.conversationId },
        });
        record.mintedProposalIds.add(proposal.id);
        return okJson(
          approvalRequiredPayload({
            tool: "today_plan",
            proposalId: proposal.id,
            approvalId: proposal.approvalId,
            expiresAt: proposal.expiresAt,
            summary: localProposalSummaryOf("today_plan", validated.data),
          }),
        );
      } catch (error) {
        log.error("[native-mcp] today_plan proposal failed", { error: String(error) });
        return { ok: false, error: "failed to create approval proposal" };
      }
    }
    try {
      const result = await executeTodayPlanWrite({
        userId: record.userId,
        conversationId: record.conversationId,
        rawInput: validated.data,
        operationKey: `native-mcp:${record.requestId}:${randomUUID()}`,
        db,
      });
      return okJson(result);
    } catch (error) {
      log.error("[native-mcp] today_plan direct write failed", { error: String(error) });
      return { ok: false, error: "tool execution failed" };
    }
  }

  // 3. add_job (`ask` -> non-blocking proposal; `rules` / `full` -> direct execute)
  if (name === "add_job") {
    const validated = validateLocalProposalInput("add_job", args ?? {}, {
      canonicalJobs: record.canonicalJobs,
    });
    if (!validated.ok) {
      return { ok: false, error: `invalid input: ${validated.error}` };
    }
    const needsApproval = approvalPolicy === "always" || approvalPolicy === "conditional";
    if (needsApproval) {
      try {
        const proposal = await createNativeOperationProposal(db, {
          userId: record.userId,
          conversationId: record.conversationId,
          turnKey: record.turnKey,
          toolName: "add_job",
          validatedInput: validated.data,
          inputHash: localProposalInputHash(validated.data),
          material: { canonicalJobs: record.canonicalJobs },
        });
        record.mintedProposalIds.add(proposal.id);
        return okJson(
          approvalRequiredPayload({
            tool: "add_job",
            proposalId: proposal.id,
            approvalId: proposal.approvalId,
            expiresAt: proposal.expiresAt,
            summary: localProposalSummaryOf("add_job", validated.data),
          }),
        );
      } catch (error) {
        log.error("[native-mcp] add_job proposal failed", { error: String(error) });
        return { ok: false, error: "failed to create approval proposal" };
      }
    }
    try {
      const result = await executeAddJobWrite({
        userId: record.userId,
        rawInput: validated.data,
        canonicalJobs: record.canonicalJobs,
        toolCallId: `native-mcp:${record.requestId}:${randomUUID()}`,
        db,
      });
      return okJson(result);
    } catch (error) {
      log.error("[native-mcp] add_job direct write failed", { error: String(error) });
      return { ok: false, error: "tool execution failed" };
    }
  }

  // 4. match_job (canonical freshNativeFull -> always approval-gated; legacy -> direct execute)
  if (name === "match_job") {
    const validated = validateLocalProposalInput("match_job", args ?? {}, {
      freshNativeFull: record.freshNativeFull,
    });
    if (!validated.ok) {
      return { ok: false, error: `invalid input: ${validated.error}` };
    }
    const needsApproval = approvalPolicy === "always" || approvalPolicy === "conditional";
    if (needsApproval) {
      try {
        const proposal = await createNativeOperationProposal(db, {
          userId: record.userId,
          conversationId: record.conversationId,
          turnKey: record.turnKey,
          toolName: "match_job",
          validatedInput: validated.data,
          inputHash: localProposalInputHash(validated.data),
          material: {
            freshNativeFull: record.freshNativeFull,
            pageJobId: record.pageJobId,
            connectionId: record.connectionId,
            model: record.model,
            provider: record.provider,
          },
        });
        record.mintedProposalIds.add(proposal.id);
        return okJson(
          approvalRequiredPayload({
            tool: "match_job",
            proposalId: proposal.id,
            approvalId: proposal.approvalId,
            expiresAt: proposal.expiresAt,
            summary: localProposalSummaryOf("match_job", validated.data),
          }),
        );
      } catch (error) {
        log.error("[native-mcp] match_job proposal failed", { error: String(error) });
        return { ok: false, error: "failed to create approval proposal" };
      }
    }
    try {
      const result = await executeLegacyMatchJobWrite({
        userId: record.userId,
        pageJobId: record.pageJobId,
        rawInput: validated.data,
        connectionId: record.connectionId,
        modelName: record.model,
        provider: record.provider,
        model: input.model,
        toolCallId: `native-mcp:${record.requestId}:${randomUUID()}`,
        db,
      });
      return okJson(result);
    } catch (error) {
      log.error("[native-mcp] match_job direct write failed", { error: String(error) });
      return { ok: false, error: "tool execution failed" };
    }
  }

  // 5. notion_update_content (in-place body edit — immediate, no proposal card)
  if (name === NOTION_TOOL.updateContent) {
    const parsed = AgentNotionUpdateContentSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const tools = buildNotionAgentTools(toolContext(record, db));
    const executor = tools[NOTION_TOOL.updateContent] as unknown as ExecutableTool | undefined;
    if (!executor?.execute) return { ok: false, error: "tool unavailable" };
    try {
      const result = await executor.execute(parsed.data, {
        toolCallId: "mcp",
        messages: [],
        abortSignal: undefined,
      });
      return okJson(result);
    } catch (error) {
      log.error("[native-mcp] notion_update_content failed", { error: String(error) });
      return { ok: false, error: "tool execution failed" };
    }
  }

  // 6. Detached external writes (Notion create/append/update_record/delete, Feishu writes)
  if (isDetachedWriteTool(name)) {
    const spec = DETACHED_WRITE_SPECS[name];
    const parsed = spec.schema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    // Live connection + capability check before persisting any proposal.
    const allowed = await isDetachedToolAllowed(record.userId, name, db);
    if (!allowed) {
      return { ok: false, error: "integration connection or capability unavailable" };
    }
    const inputHash = detachedWriteInputHash(parsed.data);
    const material = await detachedConnectionMaterial(record.userId, name, db);

    // Full-access pre-authorized Notion writes still flow through the durable
    // proposal + harness queue (never blocking remote HTTP in MCP and never
    // claiming saved:true before a verified receipt lands).
    if (approvalPolicy === "none") {
      try {
        const queued = await createAndApproveFullAccessProposal(db, {
          userId: record.userId,
          conversationId: record.conversationId,
          turnKey: record.turnKey,
          toolName: name,
          validatedInput: parsed.data,
          inputHash,
          material,
        });
        record.mintedProposalIds.add(queued.proposalId);
        if (input.kickRunner) {
          input.kickRunner(db);
        } else {
          void import("@/lib/harness/runner")
            .then((m) => m.kickHarnessRunner(db))
            .catch(() => undefined);
        }
        return okJson({
          saved: false,
          status: "queued",
          code: "QUEUED",
          tool: name,
          proposalId: queued.proposalId,
          approvalId: queued.approvalId,
          taskId: queued.taskId,
          taskStatus: "QUEUED",
          summary: boundedSummary(spec.summaryOf(parsed.data)),
        });
      } catch (error) {
        log.error("[native-mcp] full-access detached proposal failed", {
          tool: name,
          error: String(error),
        });
        return { ok: false, error: "failed to queue external write" };
      }
    }

    // Standard approval-gated detached external write: freeze proposal, zero remote call.
    try {
      const proposal = await createNativeOperationProposal(db, {
        userId: record.userId,
        conversationId: record.conversationId,
        turnKey: record.turnKey,
        toolName: name,
        validatedInput: parsed.data,
        inputHash,
        material,
      });
      record.mintedProposalIds.add(proposal.id);
      return okJson(
        approvalRequiredPayload({
          tool: name,
          proposalId: proposal.id,
          approvalId: proposal.approvalId,
          expiresAt: proposal.expiresAt,
          summary: spec.summaryOf(parsed.data),
        }),
      );
    } catch (error) {
      log.error("[native-mcp] detached proposal creation failed", {
        tool: name,
        error: String(error),
      });
      return { ok: false, error: "failed to create approval proposal" };
    }
  }

  return { ok: false, error: "tool unavailable" };
}
