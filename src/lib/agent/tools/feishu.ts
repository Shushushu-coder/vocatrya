import "server-only";

import { tool, type ToolSet } from "ai";
import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import type { ConversationRequest } from "../conversationRequest";
import { ConversationRequestError } from "../conversationRequest";
import {
  AgentFeishuReadDocSchema,
  AgentFeishuSearchDocsSchema,
} from "@/models/agent.schema";
import type {
  AgentFeishuReadDocResult,
  AgentFeishuDocItem,
  AgentFeishuSearchDocsResult,
  AgentFeishuWriteResult,
  AgentFeishuWriteVerify,
} from "@/models/agent.model";
import { AGENT_TOOL_DESCRIPTIONS } from "../prompt";
import {
  FEISHU_ERROR,
  FeishuError,
  isFeishuError,
} from "@/lib/extensions/feishu/errors";
import {
  FEISHU_CAPABILITY,
  FEISHU_BLOCK_LIST_LIMIT,
  FEISHU_READ_CONTENT_LIMIT,
  FEISHU_SEARCH_RESULT_LIMIT,
  FEISHU_TOOL,
} from "@/lib/extensions/feishu/constants";
import { isFeishuToolAllowed } from "@/lib/extensions/feishu/capabilities";
import {
  listDocxBlocks,
  listDriveFiles,
  listWikiNodes,
  listWikiSpaces,
  normalizeFeishuTarget,
  readDocxMeta,
  readDocxRawContent,
  resolveWikiNode,
  type FeishuCall,
} from "@/lib/extensions/feishu/apiMap";
import { feishuRequest, mapFeishuRemoteError } from "@/lib/extensions/feishu/api";
import {
  resolveFeishuAccessToken,
} from "@/lib/extensions/feishu/service";
import {
  getFeishuConnection,
  parseAvailableCapabilities,
} from "@/lib/extensions/feishu/store";
import {
  FEISHU_WRITE_SPECS,
} from "../feishuWriteSpec";
import { detachedWriteInputHash } from "../detachedWrite";

type Db = Pick<
  PrismaClient,
  | "feishuConnection"
  | "agentToolExecution"
  | "chatConversation"
  | "agentOperationProposal"
  | "harnessTask"
>;

type Ctx = {
  userId: string;
  request?: ConversationRequest;
  db?: Db;
  call?: FeishuCall;
};

/**
 * Shared remote resolution: the live row must still allow the tool, then a
 * tenant token is resolved (unsealed inside this call only).
 */
async function resolveRemote(
  userId: string,
  agentToolName: string,
  ctx: Ctx,
): Promise<{ token: string; call: FeishuCall; capabilities: Set<string> }> {
  const db = ctx.db ?? prisma;
  const call = ctx.call ?? feishuRequest;
  const row = await getFeishuConnection(userId, db);
  if (!isFeishuToolAllowed(row, agentToolName)) {
    throw new FeishuError(
      !row
        ? FEISHU_ERROR.NOT_CONNECTED
        : row.status === "REAUTH_REQUIRED"
          ? FEISHU_ERROR.REAUTH_REQUIRED
          : FEISHU_ERROR.TOOL_UNAVAILABLE,
    );
  }
  const token = await resolveFeishuAccessToken(userId, { db, call, expectedAppId: row!.appId });
  return { token, call, capabilities: new Set(parseAvailableCapabilities(row!.availableCapabilities)) };
}

function matchesQuery(title: string, query: string | undefined): boolean {
  if (!query) return true;
  return title.toLowerCase().includes(query.toLowerCase());
}

function buildFeishuSearchTool(ctx: Ctx) {
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.feishu_search_docs,
    inputSchema: AgentFeishuSearchDocsSchema,
    execute: async (raw): Promise<AgentFeishuSearchDocsResult> => {
      const parsed = AgentFeishuSearchDocsSchema.safeParse(raw);
      if (!parsed.success) {
        return { found: false, code: FEISHU_ERROR.VALIDATION_FAILED };
      }
      try {
        const { token, call, capabilities } = await resolveRemote(
          ctx.userId,
          FEISHU_TOOL.searchDocs,
          ctx,
        );
        const { query, folderToken, wikiSpaceId } = parsed.data;
        const items: AgentFeishuDocItem[] = [];
        let truncated = false;
        if (wikiSpaceId) {
          if (!capabilities.has(FEISHU_CAPABILITY.wikiRead)) throw new FeishuError(FEISHU_ERROR.TOOL_UNAVAILABLE);
          items.push(...(await listWikiNodes(token, wikiSpaceId, call)));
        } else if (folderToken) {
          if (!capabilities.has(FEISHU_CAPABILITY.driveList)) throw new FeishuError(FEISHU_ERROR.TOOL_UNAVAILABLE);
          const { items: files, hasMore } = await listDriveFiles(
            token,
            folderToken,
            call,
          );
          items.push(...files);
          truncated = hasMore;
        } else {
          // Default listing: app root space + wiki spaces the app can see,
          // plus each space's top-level nodes (bounded — the honest answer
          // to "what can this app reach", not a tenant-wide search).
          const { items: files, hasMore } = capabilities.has(FEISHU_CAPABILITY.driveList)
            ? await listDriveFiles(token, undefined, call) : { items: [], hasMore: false };
          items.push(...files);
          truncated = truncated || hasMore;
          const spaces = capabilities.has(FEISHU_CAPABILITY.wikiRead)
            ? await listWikiSpaces(token, call).catch(() => [] as AgentFeishuDocItem[]) : [];
          items.push(...spaces);
          for (const space of spaces.slice(0, 5)) {
            const nodes = await listWikiNodes(token, space.id, call).catch(
              () => [] as AgentFeishuDocItem[],
            );
            items.push(
              ...nodes.map((node) => ({
                ...node,
                container: space.title,
              })),
            );
          }
        }
        const filtered = items
          .filter((item) => matchesQuery(item.title, query))
          .slice(0, FEISHU_SEARCH_RESULT_LIMIT);
        if (items.filter((item) => matchesQuery(item.title, query)).length >
          filtered.length) {
          truncated = true;
        }
        return { found: filtered.length > 0, results: filtered, truncated };
      } catch (error) {
        const mapped = isFeishuError(error)
          ? error
          : mapFeishuRemoteError(error);
        return { found: false, code: mapped.code };
      }
    },
  });
}

function buildFeishuReadTool(ctx: Ctx) {
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.feishu_read_doc,
    inputSchema: AgentFeishuReadDocSchema,
    execute: async (raw): Promise<AgentFeishuReadDocResult> => {
      const parsed = AgentFeishuReadDocSchema.safeParse(raw);
      if (!parsed.success) {
        return { found: false, code: FEISHU_ERROR.VALIDATION_FAILED };
      }
      try {
        const { token, call } = await resolveRemote(
          ctx.userId,
          FEISHU_TOOL.readDoc,
          ctx,
        );
        const target = normalizeFeishuTarget(parsed.data.target);
        if (!target) return { found: false, code: FEISHU_ERROR.VALIDATION_FAILED };
        let documentId: string;
        let url: string | undefined;
        if (target.kind === "docx") {
          documentId = target.token;
        } else if (target.kind === "wiki") {
          const node = await resolveWikiNode(token, target.token, call);
          if (node.objType !== "docx") {
            return { found: false, code: FEISHU_ERROR.UNSUPPORTED_TARGET };
          }
          documentId = node.objToken;
          url = `https://feishu.cn/wiki/${node.nodeToken}`;
        } else {
          return { found: false, code: FEISHU_ERROR.UNSUPPORTED_TARGET };
        }
        const [meta, content] = await Promise.all([
          readDocxMeta(token, documentId, call).catch(() => null),
          readDocxRawContent(token, documentId, call),
        ]);
        const truncated = content.length > FEISHU_READ_CONTENT_LIMIT;
        const blocks = parsed.data.withBlocks
          ? await listDocxBlocks(token, documentId, FEISHU_BLOCK_LIST_LIMIT, call)
          : null;
        return {
          found: true,
          target: parsed.data.target,
          documentId,
          title: meta?.title || undefined,
          url,
          content: truncated
            ? `${content.slice(0, FEISHU_READ_CONTENT_LIMIT)}…`
            : content,
          truncated,
          blocks: blocks?.blocks,
          blocksTruncated: blocks?.truncated,
        };
      } catch (error) {
        const mapped = isFeishuError(error)
          ? error
          : mapFeishuRemoteError(error);
        return { found: false, code: mapped.code };
      }
    },
  });
}

/**
 * EXT-FEISHU writes are detached — identical contract to the Notion write
 * tools: the durable proposal/task carry the lifecycle, so execute inside
 * the admitted approval turn only reads persisted state. It never performs
 * the remote call itself and never emits saved:true except from a real
 * persisted receipt.
 */
function buildFeishuWriteTool(ctx: Ctx, toolName: string) {
  const spec = FEISHU_WRITE_SPECS[toolName];
  const db = ctx.db ?? prisma;
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS[
      toolName as keyof typeof AGENT_TOOL_DESCRIPTIONS
    ],
    inputSchema: spec.schema as never,
    needsApproval: true,
    execute: async (raw, { toolCallId }): Promise<AgentFeishuWriteResult> => {
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
          code: FEISHU_ERROR.VALIDATION_FAILED,
          detail: parsed.error.issues.map((issue) => issue.message).join("; "),
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
      if (proposal.inputHash !== detachedWriteInputHash(parsed.data)) {
        return {
          saved: false,
          tool: spec.toolName,
          status: "failed",
          code: "PROPOSAL_INPUT_CONFLICT",
          detail:
            "The call input no longer matches the approved proposal; a new proposal is required.",
        };
      }
      if (proposal.outcomeJson) {
        try {
          return JSON.parse(proposal.outcomeJson) as AgentFeishuWriteResult;
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
        return {
          saved: false,
          tool: spec.toolName,
          status: "unknown",
          code: "TASK_MISSING",
          verify: spec.verifyOf(parsed.data) as AgentFeishuWriteVerify,
          detail:
            "The approved operation has no recoverable task; reconcile in Feishu before re-proposing.",
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

export function buildFeishuAgentTools(ctx: Ctx): ToolSet {
  return {
    [FEISHU_TOOL.searchDocs]: buildFeishuSearchTool(ctx),
    [FEISHU_TOOL.readDoc]: buildFeishuReadTool(ctx),
    [FEISHU_TOOL.createDoc]: buildFeishuWriteTool(ctx, FEISHU_TOOL.createDoc),
    [FEISHU_TOOL.appendContent]: buildFeishuWriteTool(
      ctx,
      FEISHU_TOOL.appendContent,
    ),
    [FEISHU_TOOL.updateContent]: buildFeishuWriteTool(
      ctx,
      FEISHU_TOOL.updateContent,
    ),
  };
}
