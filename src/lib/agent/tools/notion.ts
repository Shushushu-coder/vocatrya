import "server-only";

import { tool, type ToolSet } from "ai";
import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import type { ConversationRequest } from "../conversationRequest";
import {
  ConversationRequestError,
} from "../conversationRequest";
import {
  AgentNotionReadSchema,
  AgentNotionSearchSchema,
  AgentNotionUpdateContentSchema,
} from "@/models/agent.schema";
import type {
  AgentNotionReadResult,
  AgentNotionSearchItem,
  AgentNotionSearchResult,
  AgentNotionWriteResult,
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
  fetchArgs,
  normalizeNotionTarget,
  pickRemoteArgs,
  searchArgs,
  updateContentCandidates,
} from "@/lib/extensions/notion/remoteArgs";
import { tryParseJson } from "@/lib/extensions/notion/remote";
import {
  NOTION_WRITE_SPECS,
  notionContentUpdateReceipt,
  notionWriteInputHash,
} from "../notionWriteSpec";

type Db = Pick<
  PrismaClient,
  | "$transaction"
  | "notionConnection"
  | "agentToolExecution"
  | "chatConversation"
  | "agentOperationProposal"
  | "harnessTask"
>;

type Ctx = {
  userId: string;
  request?: ConversationRequest;
  db?: Db;
};

const MESSAGE_MAX = 500;

function excerpt(text: string, max = MESSAGE_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Shared remote resolution for the Notion tools — VERIFY in the harness
 * executor uses the same connection/capability/remoteName checks without
 * unsealing the token (token resolution stays at dispatch time).
 */
export async function resolveNotionRemoteMeta(
  userId: string,
  agentToolName: string,
  db: Pick<PrismaClient, "notionConnection">,
): Promise<{
  remoteName: string;
  inputSchema: unknown;
  workspaceId: string | null;
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
  return {
    remoteName,
    inputSchema: findRemoteToolSchema(row!, remoteName),
    workspaceId:
      typeof row!.workspaceId === "string" ? row!.workspaceId : null,
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
  const meta = await resolveNotionRemoteMeta(userId, agentToolName, db);
  const accessToken = await resolveNotionAccessToken(userId, { db });
  return {
    accessToken,
    remoteName: meta.remoteName,
    inputSchema: meta.inputSchema,
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

/**
 * EXT-NOTION writes are detached: the proposal row + harness task carry the
 * real lifecycle, so execute inside the admitted approval turn only reads
 * persisted state and returns it — a queued stub for a queued write, the
 * stored terminal receipt for a settled one. It NEVER performs the remote
 * call itself and never emits saved:true/created:true from anything but a
 * real persisted receipt.
 */
function buildNotionWriteTool(ctx: Ctx, toolName: string) {
  const spec = NOTION_WRITE_SPECS[toolName];
  const db = ctx.db ?? prisma;
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS[
      toolName as keyof typeof AGENT_TOOL_DESCRIPTIONS
    ],
    inputSchema: spec.schema as never,
    needsApproval: true,
    execute: async (raw, { toolCallId }): Promise<AgentNotionWriteResult> => {
      const request = ctx.request;
      if (
        !request ||
        request.operation !== "approval" ||
        request.approvalToolCallId !== toolCallId
      ) {
        const error = new ConversationRequestError(
          "CONVERSATION_TURN_CONFLICT",
        );
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
      const proposal = await db.agentOperationProposal.findUnique({
        where: { toolCallId },
      });
      if (!proposal || proposal.userId !== ctx.userId) {
        return {
          saved: false,
          tool: spec.toolName,
          status: "failed",
          code: "PROPOSAL_MISSING",
          detail:
            "The durable proposal for this approval is missing; nothing was queued.",
        };
      }
      // The decision bound this exact validated input version — a replayed
      // turn carrying a different input must fail closed, not inherit it.
      if (proposal.inputHash !== notionWriteInputHash(parsed.data)) {
        return {
          saved: false,
          tool: spec.toolName,
          status: "failed",
          code: "PROPOSAL_INPUT_CONFLICT",
          detail:
            "The call input no longer matches the approved proposal; a new proposal is required.",
        };
      }
      // A settled proposal replays its stored receipt — saved:true here is
      // a real persisted write receipt, not a stub claim.
      if (proposal.outcomeJson) {
        try {
          return JSON.parse(proposal.outcomeJson) as AgentNotionWriteResult;
        } catch {
          // Fall through to the state report on a corrupt receipt.
        }
      }
      const task = proposal.harnessTaskId
        ? await db.harnessTask.findUnique({
            where: { id: proposal.harnessTaskId },
            select: { status: true },
          })
        : null;
      if (proposal.status === "APPROVED" && task) {
        return {
          saved: false,
          tool: spec.toolName,
          status: "queued",
          code: "QUEUED",
          proposalId: proposal.id,
          taskId: proposal.harnessTaskId!,
          taskStatus: task.status,
        };
      }
      if (proposal.status === "APPROVED") {
        // Approved but no task can be found — dispatch never provably ran
        // and cannot be claimed queued; verification is the honest state.
        return {
          saved: false,
          tool: spec.toolName,
          status: "unknown",
          code: "TASK_MISSING",
          verify: spec.verifyOf(parsed.data),
          detail:
            "The approved operation has no recoverable task; reconcile in Notion before re-proposing.",
        };
      }
      return {
        saved: false,
        tool: spec.toolName,
        status: "denied",
        code: `PROPOSAL_${proposal.status}`,
      };
    },
  });
}

/**
 * Body edits run in the turn. They do not open a confirmation card and they
 * do not enter the detached-write ledger. A missed span comes back as a
 * remote validation error; an unknown transport result must be re-read.
 */
function buildNotionUpdateContentTool(ctx: Ctx) {
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.notion_update_content,
    inputSchema: AgentNotionUpdateContentSchema,
    execute: async (raw): Promise<AgentNotionWriteResult> => {
      const parsed = AgentNotionUpdateContentSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          saved: false,
          tool: NOTION_TOOL.updateContent,
          status: "failed",
          code: NOTION_ERROR.VALIDATION_FAILED,
          detail: parsed.error.issues.map((issue) => issue.message).join("; "),
        };
      }
      const pageId = normalizeNotionTarget(parsed.data.target);
      try {
        const { accessToken, remoteName, inputSchema } = await resolveRemote(
          ctx.userId,
          NOTION_TOOL.updateContent,
          ctx.db ?? prisma,
        );
        const args = pickRemoteArgs(
          inputSchema,
          updateContentCandidates({ pageId, edits: parsed.data.edits }),
        );
        if (!args) {
          return {
            saved: false,
            tool: NOTION_TOOL.updateContent,
            status: "failed",
            code: NOTION_ERROR.TOOL_UNAVAILABLE,
          };
        }
        const result = await callNotionRemoteTool(accessToken, remoteName, args);
        if (result.isError) {
          return {
            saved: false,
            tool: NOTION_TOOL.updateContent,
            status: "failed",
            code: NOTION_ERROR.VALIDATION_FAILED,
            detail: excerpt(remoteToolText(result)),
          };
        }
        return notionContentUpdateReceipt(remoteToolText(result), pageId);
      } catch (error) {
        const mapped = isNotionError(error) ? error : mapNotionRemoteError(error);
        const unknown =
          mapped.code === NOTION_ERROR.OUTCOME_UNKNOWN ||
          mapped.code === NOTION_ERROR.NETWORK ||
          mapped.code === NOTION_ERROR.VERIFICATION_REQUIRED;
        return {
          saved: false,
          tool: NOTION_TOOL.updateContent,
          status:
            mapped.code === NOTION_ERROR.REAUTH_REQUIRED
              ? "reauth_required"
              : unknown
                ? "unknown"
                : "failed",
          code: mapped.code,
          detail: unknown
            ? "The edit may have reached Notion. Read the page before trying the same span again."
            : undefined,
        };
      }
    },
  });
}

export function buildNotionAgentTools(ctx: Ctx): ToolSet {
  return {
    [NOTION_TOOL.search]: buildNotionSearchTool(ctx),
    [NOTION_TOOL.read]: buildNotionReadTool(ctx),
    [NOTION_TOOL.createPage]: buildNotionWriteTool(ctx, NOTION_TOOL.createPage),
    [NOTION_TOOL.appendContent]: buildNotionWriteTool(
      ctx,
      NOTION_TOOL.appendContent,
    ),
    [NOTION_TOOL.updateRecord]: buildNotionWriteTool(
      ctx,
      NOTION_TOOL.updateRecord,
    ),
    [NOTION_TOOL.updateContent]: buildNotionUpdateContentTool(ctx),
    [NOTION_TOOL.deletePages]: buildNotionWriteTool(ctx, NOTION_TOOL.deletePages),
  };
}
