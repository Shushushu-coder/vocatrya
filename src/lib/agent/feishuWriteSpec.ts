import "server-only";

import {
  AgentFeishuAppendContentSchema,
  AgentFeishuCreateDocSchema,
  AgentFeishuUpdateContentSchema,
} from "@/models/agent.schema";
import type {
  AgentFeishuWriteResult,
  AgentFeishuWriteVerify,
} from "@/models/agent.model";
import { FEISHU_TOOL } from "@/lib/extensions/feishu/constants";
import { FEISHU_ERROR } from "@/lib/extensions/feishu/errors";
import { tryParseJson } from "@/lib/extensions/notion/remote";
import type { DetachedWriteSpec } from "./detachedWrite";

/**
 * EXT-FEISHU detached-write registry entries — same contract shape as the
 * Notion specs. `candidates` is unused for Feishu (the executor builds API
 * call descriptors itself rather than matching a remote tool schema); it
 * echoes the validated input so the spec contract stays uniform.
 */

function feishuReceiptFromWrite(
  toolName: string,
  resultText: string,
  fallbackTitle?: string,
): AgentFeishuWriteResult {
  const parsed = tryParseJson(resultText);
  const documentId =
    typeof parsed?.document_id === "string" && parsed.document_id
      ? parsed.document_id
      : undefined;
  const url =
    typeof parsed?.url === "string" && /^https:\/\//.test(parsed.url)
      ? parsed.url
      : undefined;
  const warnings = Array.isArray(parsed?.warnings)
    ? (parsed!.warnings as unknown[])
        .filter((w): w is string => typeof w === "string" && w.length > 0)
        .slice(0, 5)
    : undefined;
  // Anything that cannot name the document it wrote is not a receipt —
  // async/pending/task-shaped payloads stay unknown and block auto-retry.
  if (!documentId) {
    return {
      saved: false,
      tool: toolName,
      status: "unknown",
      code: FEISHU_ERROR.OUTCOME_UNKNOWN,
      detail:
        "Feishu returned no verifiable completed document receipt. Inspect the destination and reconcile manually in Feishu; automatic retry is blocked.",
    };
  }
  return {
    saved: true,
    tool: toolName,
    documentId,
    url,
    title:
      typeof parsed?.title === "string" && parsed.title
        ? parsed.title
        : fallbackTitle,
    warnings,
  };
}

export const FEISHU_WRITE_SPECS: Record<string, DetachedWriteSpec> = {
  [FEISHU_TOOL.createDoc]: {
    toolName: FEISHU_TOOL.createDoc,
    provider: "feishu",
    schema: AgentFeishuCreateDocSchema,
    remoteRequirementsTool: FEISHU_TOOL.createDoc,
    candidates: (input) => [input],
    receipt: (text, input) =>
      feishuReceiptFromWrite(
        FEISHU_TOOL.createDoc,
        text,
        input.title as string,
      ),
    verifyOf: (input): AgentFeishuWriteVerify => ({
      tool: "feishu_search_docs",
      query: input.title as string,
    }),
    summaryOf: (input) => ({
      target:
        typeof input.folderToken === "string" && input.folderToken
          ? `folder:${input.folderToken}`
          : undefined,
      content: typeof input.title === "string" ? input.title : undefined,
    }),
  },
  [FEISHU_TOOL.appendContent]: {
    toolName: FEISHU_TOOL.appendContent,
    provider: "feishu",
    schema: AgentFeishuAppendContentSchema,
    remoteRequirementsTool: FEISHU_TOOL.appendContent,
    candidates: (input) => [input],
    receipt: (text, input) => ({
      documentId: undefined,
      ...feishuReceiptFromWrite(FEISHU_TOOL.appendContent, text),
    }),
    verifyOf: (input): AgentFeishuWriteVerify => ({
      tool: "feishu_read_doc",
      target: input.target as string,
    }),
    summaryOf: (input) => ({
      target: input.target as string,
      content: input.content as string,
    }),
  },
  [FEISHU_TOOL.updateContent]: {
    toolName: FEISHU_TOOL.updateContent,
    provider: "feishu",
    schema: AgentFeishuUpdateContentSchema,
    remoteRequirementsTool: FEISHU_TOOL.updateContent,
    candidates: (input) => [input],
    receipt: (text, input) => ({
      documentId: undefined,
      ...feishuReceiptFromWrite(FEISHU_TOOL.updateContent, text),
    }),
    verifyOf: (input): AgentFeishuWriteVerify => ({
      tool: "feishu_read_doc",
      target: input.target as string,
    }),
    summaryOf: (input) => {
      const edits = Array.isArray(input.edits) ? input.edits.length : 0;
      return {
        target: input.target as string,
        content: `${edits} block edit${edits === 1 ? "" : "s"}`,
      };
    },
  },
};
