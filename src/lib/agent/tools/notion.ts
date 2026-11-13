import "server-only";

import { isToolUIPart, tool, type ToolSet, type UIMessage } from "ai";
import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { hashCanonical } from "@/lib/career/hash";
import type { ConversationRequest } from "../conversationRequest";
import {
  checkpointConversationTool,
  ConversationRequestError,
} from "../conversationRequest";
import {
  acquireToolExecution,
  AGENT_TOOL_EXECUTION_STATUS,
  type AgentToolExecutionRow,
} from "../toolExecution";
import {
  AgentNotionAppendContentSchema,
  AgentNotionCreatePageSchema,
  AgentNotionReadSchema,
  AgentNotionSearchSchema,
  AgentNotionUpdateRecordSchema,
} from "@/models/agent.schema";
import type {
  AgentNotionReadResult,
  AgentNotionSearchItem,
  AgentNotionSearchResult,
  AgentNotionWriteResult,
  AgentNotionWriteVerify,
} from "@/models/agent.model";
import { AGENT_TOOL_DESCRIPTIONS } from "../prompt";
import {
  NOTION_ERROR,
  NotionError,
  isNotionError,
} from "@/lib/extensions/notion/errors";
import {
  NOTION_READ_CONTENT_LIMIT,
  NOTION_REMOTE_REQUIREMENTS,
  NOTION_SEARCH_RESULT_LIMIT,
  NOTION_TOOL,
} from "@/lib/extensions/notion/constants";
import { isNotionToolAllowed } from "@/lib/extensions/notion/capabilities";
import {
  callNotionRemoteTool,
  mapNotionRemoteError,
  remoteToolText,
} from "@/lib/extensions/notion/mcpClient";
import { resolveNotionAccessToken } from "@/lib/extensions/notion/service";
import {
  NOTION_STATUS,
  findRemoteToolSchema,
  getNotionConnection,
  parseAvailableTools,
} from "@/lib/extensions/notion/store";
import {
  appendContentCandidates,
  createPageCandidates,
  fetchArgs,
  normalizeNotionTarget,
  parentFor,
  pickRemoteArgs,
  searchArgs,
  updateRecordCandidates,
} from "@/lib/extensions/notion/remoteArgs";
import { tryParseJson } from "@/lib/extensions/notion/remote";

type Db = Pick<
  PrismaClient,
  "$transaction" | "notionConnection" | "agentToolExecution" | "chatConversation"
>;

type Ctx = {
  userId: string;
  request?: ConversationRequest;
  db?: Db;
};

const MESSAGE_MAX = 500;

function lastUserMessageId(request?: ConversationRequest): string | undefined {
  return request
    ? [...request.messages].reverse().find((m) => m.role === "user")?.id
    : undefined;
}

function excerpt(text: string, max = MESSAGE_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Map a settled error to a model-facing write output — fixed codes only. */
function writeFailure(
  toolName: string,
  error: unknown,
  verify: AgentNotionWriteVerify,
): { result: AgentNotionWriteResult; failureCode: string } {
  const mapped = isNotionError(error) ? error : mapNotionRemoteError(error);
  if (mapped.code === NOTION_ERROR.REAUTH_REQUIRED) {
    return {
      result: {
        saved: false,
        tool: toolName,
        status: "reauth_required",
        code: mapped.code,
      },
      failureCode: mapped.code,
    };
  }
  if (
    mapped.code === NOTION_ERROR.OUTCOME_UNKNOWN ||
    mapped.code === NOTION_ERROR.NETWORK
  ) {
    return {
      result: {
        saved: false,
        tool: toolName,
        status: "unknown",
        code: mapped.code,
        verify,
        detail:
          "The request may or may not have reached Notion. Inspect with the named read tool and reconcile manually in Notion. Automatic retry is blocked.",
      },
      failureCode: NOTION_ERROR.OUTCOME_UNKNOWN,
    };
  }
  return {
    result: {
      saved: false,
      tool: toolName,
      status: "failed",
      code: mapped.code,
    },
    failureCode: mapped.code,
  };
}

async function resolveRemote(
  userId: string,
  agentToolName: string,
  db: Db,
): Promise<{
  accessToken: string;
  remoteName: string;
  inputSchema: unknown;
}> {
  const row = await getNotionConnection(userId, db);
  if (!isNotionToolAllowed(row, agentToolName)) {
    throw new NotionError(
      !row
        ? NOTION_ERROR.NOT_CONNECTED
        : row.status === NOTION_STATUS.REAUTH_REQUIRED
          ? NOTION_ERROR.REAUTH_REQUIRED
          : NOTION_ERROR.TOOL_UNAVAILABLE,
    );
  }
  const remoteName = NOTION_REMOTE_REQUIREMENTS[agentToolName]?.find((name) =>
    parseAvailableTools(row!.availableTools).includes(name),
  );
  if (!remoteName) throw new NotionError(NOTION_ERROR.TOOL_UNAVAILABLE);
  const accessToken = await resolveNotionAccessToken(userId, { db });
  return {
    accessToken,
    remoteName,
    inputSchema: findRemoteToolSchema(row!, remoteName),
  };
}

function extractSearchItems(resultText: string): AgentNotionSearchItem[] | null {
  const parsed = tryParseJson(resultText);
  const candidates = [
    parsed?.results,
    parsed?.pages,
    parsed?.items,
    (parsed?.data as Record<string, unknown> | undefined)?.results,
  ];
  const list = candidates.find(Array.isArray) as unknown[] | undefined;
  if (!list) return null;
  const items: AgentNotionSearchItem[] = [];
  for (const raw of list.slice(0, NOTION_SEARCH_RESULT_LIMIT)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id =
      typeof item.id === "string"
        ? item.id
        : typeof item.page_id === "string"
          ? item.page_id
          : null;
    if (!id) continue;
    items.push({
      id,
      title:
        typeof item.title === "string"
          ? item.title
          : typeof item.name === "string"
            ? item.name
            : id,
      objectType:
        typeof item.object === "string"
          ? item.object
          : typeof item.type === "string"
            ? item.type
            : undefined,
      url: typeof item.url === "string" ? item.url : undefined,
      lastEditedAt:
        typeof item.last_edited_time === "string"
          ? item.last_edited_time
          : undefined,
    });
  }
  return items;
}

function buildNotionSearchTool(ctx: Ctx) {
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.notion_search,
    inputSchema: AgentNotionSearchSchema,
    execute: async (raw): Promise<AgentNotionSearchResult> => {
      const parsed = AgentNotionSearchSchema.safeParse(raw);
      if (!parsed.success) return { found: false, code: "NOTION_VALIDATION_FAILED" };
      try {
        const { accessToken, remoteName } = await resolveRemote(
          ctx.userId,
          NOTION_TOOL.search,
          ctx.db ?? prisma,
        );
        const result = await callNotionRemoteTool(
          accessToken,
          remoteName,
          searchArgs(parsed.data),
        );
        if (result.isError) {
          return { found: false, code: "NOTION_REMOTE_FAILED" };
        }
        const text = remoteToolText(result);
        const items = extractSearchItems(text);
        if (items === null) {
          return {
            found: false,
            rawPreview: excerpt(text, 1500),
          };
        }
        return { found: items.length > 0, results: items };
      } catch (error) {
        const mapped = isNotionError(error) ? error : mapNotionRemoteError(error);
        return { found: false, code: mapped.code };
      }
    },
  });
}

function buildNotionReadTool(ctx: Ctx) {
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.notion_read,
    inputSchema: AgentNotionReadSchema,
    execute: async (raw): Promise<AgentNotionReadResult> => {
      const parsed = AgentNotionReadSchema.safeParse(raw);
      if (!parsed.success) return { found: false, code: "NOTION_VALIDATION_FAILED" };
      try {
        const { accessToken, remoteName, inputSchema } = await resolveRemote(
          ctx.userId,
          NOTION_TOOL.read,
          ctx.db ?? prisma,
        );
        const args = pickRemoteArgs(inputSchema, fetchArgs(parsed.data.target));
        if (!args) return { found: false, code: "NOTION_TOOL_UNAVAILABLE" };
        const result = await callNotionRemoteTool(accessToken, remoteName, args);
        if (result.isError) {
          return { found: false, code: "NOTION_REMOTE_FAILED" };
        }
        const text = remoteToolText(result);
        const parsedJson = tryParseJson(text);
        const content =
          typeof parsedJson?.content === "string"
            ? parsedJson.content
            : typeof parsedJson?.markdown === "string"
              ? parsedJson.markdown
              : text;
        if (!content.trim()) return { found: false, code: "NOTION_REMOTE_FAILED" };
        const truncated = content.length > NOTION_READ_CONTENT_LIMIT;
        return {
          found: true,
          target: parsed.data.target,
          title:
            typeof parsedJson?.title === "string" ? parsedJson.title : undefined,
          url:
            typeof parsedJson?.url === "string" ? parsedJson.url : undefined,
          content: truncated
            ? `${content.slice(0, NOTION_READ_CONTENT_LIMIT)}…`
            : content,
          truncated,
        };
      } catch (error) {
        const mapped = isNotionError(error) ? error : mapNotionRemoteError(error);
        return { found: false, code: mapped.code };
      }
    },
  });
}

/** Parse the remote write result for a verifiable receipt. */
function receiptFromWrite(
  toolName: string,
  resultText: string,
  fallbackTitle?: string,
): AgentNotionWriteResult {
  const parsed = tryParseJson(resultText);
  const pages = parsed?.pages as Record<string, unknown>[] | undefined;
  const page = Array.isArray(pages) ? pages[0] : parsed;
  const warnings = parsed?.warnings as { message?: string }[] | undefined;
  const rawId = typeof page?.page_id === "string" ? page.page_id : page?.id;
  const pageId = typeof rawId === "string" && /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(rawId) ? rawId : undefined;
  let url: string | undefined;
  if (typeof page?.url === "string") {
    try {
      const candidate = new URL(page.url);
      if (candidate.protocol === "https:" &&
          (candidate.hostname === "notion.so" || candidate.hostname.endsWith(".notion.so") ||
           candidate.hostname === "notion.site" || candidate.hostname.endsWith(".notion.site")) &&
          /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(candidate.pathname)) url = candidate.toString();
    } catch { /* Untrusted remote URL is not a receipt. */ }
  }
  // An async task identifier is not a completed page write, even if it
  // happens to use UUIDs. Unknown response shapes require manual recovery.
  if ((!pageId && !url) || parsed?.task_id || parsed?.task ||
      parsed?.object === "task" || ["pending", "queued", "running", "in_progress"].includes(String(parsed?.status))) {
    return { saved: false, tool: toolName, status: "unknown", code: NOTION_ERROR.OUTCOME_UNKNOWN,
      detail: "Notion returned no verifiable completed page receipt. Inspect the destination and reconcile manually in Notion; automatic retry is blocked." };
  }
  return {
    saved: true,
    tool: toolName,
    pageId,
    url,
    title:
      typeof page?.title === "string"
        ? page.title
        : typeof (page?.properties as Record<string, unknown> | undefined)
              ?.title === "string"
          ? ((page!.properties as Record<string, unknown>).title as string)
          : fallbackTitle,
    warnings: Array.isArray(warnings)
      ? warnings
          .map((w) => (typeof w?.message === "string" ? w.message : ""))
          .filter(Boolean)
          .slice(0, 5)
      : undefined,
  };
}

type WriteSpec = {
  toolName: string;
  description: string;
  schema: {
    safeParse(raw: unknown):
      | { success: true; data: Record<string, unknown> }
      | { success: false; error: { issues: { message: string }[] } };
  };
  remoteRequirementsTool: string;
  candidates(input: Record<string, unknown>): Record<string, unknown>[];
  receipt(resultText: string, input: Record<string, unknown>): AgentNotionWriteResult;
  verifyOf(input: Record<string, unknown>): AgentNotionWriteVerify;
};

function buildNotionWriteTool(ctx: Ctx, spec: WriteSpec) {
  const db = ctx.db ?? prisma;
  return tool({
    description: spec.description,
    inputSchema: spec.schema as never,
    needsApproval: true,
    execute: async (raw, { toolCallId }): Promise<AgentNotionWriteResult> => {
      const request = ctx.request;
      const turnKey = lastUserMessageId(request);
      // A durable-execution write must run only inside an admitted approval
      // turn bound to this toolCall — never on the proposal pass.
      if (
        !request ||
        request.operation !== "approval" ||
        request.approvalToolCallId !== toolCallId ||
        !turnKey
      ) {
        const error = new ConversationRequestError("CONVERSATION_TURN_CONFLICT");
        if (request) {
          request.failure = error;
          request.abort?.();
        }
        throw error;
      }
      const parsed = spec.schema.safeParse(raw);
      if (!parsed.success) {
        return {
          saved: false,
          tool: spec.toolName,
          status: "failed",
          code: NOTION_ERROR.VALIDATION_FAILED,
          detail: parsed.error.issues
            .map((issue) => issue.message)
            .join("; "),
        };
      }
      const input = parsed.data;
      // The legacy flag never authorizes retry and must not change the
      // write identity used to detect unresolved earlier attempts.
      const { verifiedNoDuplicate: _omitFlag, ...dedupeInput } =
        input as Record<string, unknown>;
      const inputHash = hashCanonical(dedupeInput);
      const verify = spec.verifyOf(input);

      const reservation = await acquireToolExecution(db, {
        userId: ctx.userId,
        conversationId: request.conversationId,
        toolName: spec.toolName,
        turnKey,
        inputHash,
        operationPrefix: `notion-${spec.toolName}`,
      }).catch((error) => {
        if (error instanceof ConversationRequestError) {
          request.failure = error;
          request.abort?.();
        }
        throw error;
      });

      const verificationRequired = (): AgentNotionWriteResult => ({
        saved: false, tool: spec.toolName, status: "verification_required",
        code: NOTION_ERROR.VERIFICATION_REQUIRED, verify,
        detail: "An earlier write may already have reached Notion. Automatic retry remains blocked, including verifiedNoDuplicate=true. Inspect using the named read tool and reconcile manually in Notion; this app has no automatic recovery/reset flow.",
      });
      if (reservation.state !== "fresh") {
        const execution = reservation.execution;
        if (reservation.state === "resume" || execution.status === AGENT_TOOL_EXECUTION_STATUS.ABORTED ||
            execution.failureCode === NOTION_ERROR.OUTCOME_UNKNOWN || execution.failureCode === NOTION_ERROR.VERIFICATION_REQUIRED) return verificationRequired();
        return execution.resultJson ? JSON.parse(execution.resultJson) as AgentNotionWriteResult : verificationRequired();
      }
      // Shared-ledger sweeps turn interrupted PENDING rows into ABORTED;
      // neither is proof that the remote write did not happen.
      const priorUnresolved = await db.agentToolExecution.findFirst({ where: {
        userId: ctx.userId, conversationId: request.conversationId, toolName: spec.toolName, inputHash,
        operationKey: { not: reservation.execution.operationKey },
        OR: [
          { status: { in: [AGENT_TOOL_EXECUTION_STATUS.PENDING, AGENT_TOOL_EXECUTION_STATUS.ABORTED] } },
          { failureCode: { in: [NOTION_ERROR.OUTCOME_UNKNOWN, NOTION_ERROR.VERIFICATION_REQUIRED] } },
        ],
      } });
      if (priorUnresolved) {
        const result = verificationRequired();
        await settleExecution(reservation.execution, NOTION_ERROR.VERIFICATION_REQUIRED, result, db);
        return result;
      }

      const remote = await resolveRemote(
        ctx.userId,
        spec.remoteRequirementsTool,
        db,
      ).catch((error) => ({ error }));
      if ("error" in remote) {
        const { result, failureCode } = writeFailure(
          spec.toolName,
          remote.error,
          verify,
        );
        await settleExecution(reservation.execution, failureCode, result, db);
        return await checkpointResult(request, spec.toolName, toolCallId, input, result, db);
      }

      const args = pickRemoteArgs(
        remote.inputSchema,
        spec.candidates(input),
      );
      if (!args) {
        const result: AgentNotionWriteResult = {
          saved: false,
          tool: spec.toolName,
          status: "failed",
          code: NOTION_ERROR.TOOL_UNAVAILABLE,
        };
        await settleExecution(
          reservation.execution,
          NOTION_ERROR.TOOL_UNAVAILABLE,
          result,
          db,
        );
        return await checkpointResult(request, spec.toolName, toolCallId, input, result, db);
      }

      // Claim dispatch under SQLite's write lock; never hold it over network
      // I/O. Cancellation after this boundary cannot undo a dispatched write.
      await db.$transaction(async (tx) => {
        if (request.released || request.failure || request.userId !== ctx.userId) throw new ConversationRequestError("CONVERSATION_STALE_WRITE");
        const owned = await tx.chatConversation.updateMany({
          where: { id: request.conversationId, userId: ctx.userId, revision: request.revision,
            activeRequestId: request.requestId, activeRequestExpiresAt: { gt: new Date() }, archivedAt: null },
          data: { revision: { increment: 0 } },
        });
        if (owned.count !== 1) throw new ConversationRequestError("CONVERSATION_STALE_WRITE");
        const row = await tx.chatConversation.findFirst({ where: { id: request.conversationId, userId: ctx.userId } });
        const messages = JSON.parse(row!.messages) as UIMessage[];
        const tail = messages.at(-1);
        const proposal = tail?.role === "assistant" ? tail.parts.find((part) => isToolUIPart(part) && part.toolCallId === toolCallId) : undefined;
        const approvedInput = proposal && isToolUIPart(proposal) ? spec.schema.safeParse(proposal.input) : null;
        if (!proposal || !isToolUIPart(proposal) || proposal.type !== `tool-${spec.toolName}` ||
            proposal.state !== "approval-responded" || proposal.approval?.approved !== true ||
            !approvedInput?.success || hashCanonical(approvedInput.data) !== hashCanonical(input) ||
            lastUserMessageId({ ...request, messages }) !== turnKey) throw new ConversationRequestError("CONVERSATION_TURN_CONFLICT");
        const claimed = await tx.agentToolExecution.updateMany({
          where: { operationKey: reservation.execution.operationKey, status: AGENT_TOOL_EXECUTION_STATUS.PENDING, failureCode: null },
          data: { failureCode: "NOTION_DISPATCHED" },
        });
        if (claimed.count !== 1) throw new ConversationRequestError("CONVERSATION_TURN_CONFLICT");
      }).catch((error) => {
        if (error instanceof ConversationRequestError) { request.failure = error; request.abort?.(); }
        throw error;
      });
      // Only remote errors are mapped here. Local persistence failures must
      // propagate without relabeling a remote success as a remote failure.
      let callResult;
      try {
        callResult = await callNotionRemoteTool(remote.accessToken, remote.remoteName, args);
      } catch (error) {
        const { result, failureCode } = writeFailure(spec.toolName, error, verify);
        await settleExecution(reservation.execution, failureCode, result, db);
        return checkpointResult(request, spec.toolName, toolCallId, input, result, db);
      }
      const result: AgentNotionWriteResult = callResult.isError
        ? { saved: false, tool: spec.toolName, status: "failed", code: NOTION_ERROR.VALIDATION_FAILED, detail: excerpt(remoteToolText(callResult)) }
        : spec.receipt(remoteToolText(callResult), input);
      if (!result.saved && result.status === "unknown") result.verify = verify;
      await settleExecution(reservation.execution, result.saved ? null : result.code, result, db);
      return checkpointResult(request, spec.toolName, toolCallId, input, result, db);
    },
  });
}

async function settleExecution(
  execution: AgentToolExecutionRow,
  failureCode: string | null,
  result: AgentNotionWriteResult,
  db: Db,
): Promise<void> {
  const settled = await db.agentToolExecution.updateMany({
    where: {
      operationKey: execution.operationKey,
      status: AGENT_TOOL_EXECUTION_STATUS.PENDING,
    },
    data: {
      status: failureCode
        ? AGENT_TOOL_EXECUTION_STATUS.FAILED
        : AGENT_TOOL_EXECUTION_STATUS.COMPLETED,
      failureCode: failureCode ?? null,
      resultJson: JSON.stringify(result),
      completedAt: new Date(),
    },
  });
  if (settled.count !== 1) throw new ConversationRequestError("CONVERSATION_STALE_WRITE");
}

/**
 * Persist the durable receipt beside the settled execution: identical
 * toolCallId+input replays return the saved output, a conflicting input is a
 * turn conflict, and an approval operation is bound to its admitted call.
 */
async function checkpointResult(
  request: ConversationRequest,
  toolName: string,
  toolCallId: string,
  input: unknown,
  result: AgentNotionWriteResult,
  db: Db,
): Promise<AgentNotionWriteResult> {
  return checkpointConversationTool(
    request,
    { toolName, toolCallId, input },
    async () => result,
    db as unknown as PrismaClient,
  );
}

export function buildNotionAgentTools(ctx: Ctx): ToolSet {
  return {
    [NOTION_TOOL.search]: buildNotionSearchTool(ctx),
    [NOTION_TOOL.read]: buildNotionReadTool(ctx),
    [NOTION_TOOL.createPage]: buildNotionWriteTool(ctx, {
      toolName: NOTION_TOOL.createPage,
      description: AGENT_TOOL_DESCRIPTIONS.notion_create_page,
      schema: AgentNotionCreatePageSchema,
      remoteRequirementsTool: NOTION_TOOL.createPage,
      candidates: (input) =>
        createPageCandidates({
          title: input.title as string,
          content: input.content as string,
          parent: parentFor(
            input.target as string | undefined,
            input.targetType as "page" | "database" | "data_source" | undefined,
          ),
          properties: input.properties as
            | Record<string, unknown>
            | undefined,
        }),
      receipt: (text, input) =>
        ({
          ...receiptFromWrite(
            NOTION_TOOL.createPage,
            text,
            input.title as string,
          ),
        }) as AgentNotionWriteResult,
      verifyOf: (input) => ({
        tool: "notion_search",
        query: input.title as string,
      }),
    }),
    [NOTION_TOOL.appendContent]: buildNotionWriteTool(ctx, {
      toolName: NOTION_TOOL.appendContent,
      description: AGENT_TOOL_DESCRIPTIONS.notion_append_content,
      schema: AgentNotionAppendContentSchema,
      remoteRequirementsTool: NOTION_TOOL.appendContent,
      candidates: (input) =>
        appendContentCandidates({
          pageId: normalizeNotionTarget(input.target as string),
          content: input.content as string,
        }),
      receipt: (text, input) => ({
        pageId: normalizeNotionTarget(input.target as string),
        ...receiptFromWrite(NOTION_TOOL.appendContent, text),
      }),
      verifyOf: (input) => ({
        tool: "notion_read",
        target: input.target as string,
      }),
    }),
    [NOTION_TOOL.updateRecord]: buildNotionWriteTool(ctx, {
      toolName: NOTION_TOOL.updateRecord,
      description: AGENT_TOOL_DESCRIPTIONS.notion_update_record,
      schema: AgentNotionUpdateRecordSchema,
      remoteRequirementsTool: NOTION_TOOL.updateRecord,
      candidates: (input) =>
        updateRecordCandidates({
          pageId: normalizeNotionTarget(input.target as string),
          properties: input.properties as Record<string, unknown>,
        }),
      receipt: (text, input) => ({
        pageId: normalizeNotionTarget(input.target as string),
        ...receiptFromWrite(NOTION_TOOL.updateRecord, text),
      }),
      verifyOf: (input) => ({
        tool: "notion_read",
        target: input.target as string,
      }),
    }),
  };
}

