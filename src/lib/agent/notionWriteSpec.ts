import "server-only";

import {
  AgentNotionAppendContentSchema,
  AgentNotionCreatePageSchema,
  AgentNotionDeletePagesSchema,
  AgentNotionUpdateRecordSchema,
} from "@/models/agent.schema";
import type {
  AgentNotionWriteResult,
  AgentNotionWriteVerify,
} from "@/models/agent.model";
import { hashCanonical } from "@/lib/career/hash";
import { NOTION_TOOL } from "@/lib/extensions/notion/constants";
import {
  appendContentCandidates,
  createPageCandidates,
  deletePagesCandidates,
  normalizeNotionTarget,
  parentFor,
  updateRecordCandidates,
} from "@/lib/extensions/notion/remoteArgs";
import { tryParseJson } from "@/lib/extensions/notion/remote";
import { NOTION_ERROR } from "@/lib/extensions/notion/errors";

/**
 * The detached-write tool registry shared by the chat surface (input
 * validation + queued stub), the proposal ledger and the harness executor.
 * No request state lives here — the spec only knows how to validate an
 * input, translate it to remote args and read a remote receipt.
 */
export type NotionWriteSpec = {
  toolName: string;
  schema: {
    safeParse(raw: unknown):
      | { success: true; data: Record<string, unknown> }
      | { success: false; error: { issues: { message: string }[] } };
  };
  remoteRequirementsTool: string;
  candidates(input: Record<string, unknown>): Record<string, unknown>[];
  receipt(resultText: string, input: Record<string, unknown>): AgentNotionWriteResult;
  verifyOf(input: Record<string, unknown>): AgentNotionWriteVerify;
  /** Card-facing target/content summary derived from the validated input. */
  summaryOf(input: Record<string, unknown>): { target?: string; content?: string };
};

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

export const NOTION_WRITE_SPECS: Record<string, NotionWriteSpec> = {
  [NOTION_TOOL.createPage]: {
    toolName: NOTION_TOOL.createPage,
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
        properties: input.properties as Record<string, unknown> | undefined,
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
    summaryOf: (input) => ({
      target:
        typeof input.target === "string" && input.target
          ? input.target
          : undefined,
      content: typeof input.title === "string" ? input.title : undefined,
    }),
  },
  [NOTION_TOOL.appendContent]: {
    toolName: NOTION_TOOL.appendContent,
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
    summaryOf: (input) => ({
      target: input.target as string,
      content: input.content as string,
    }),
  },
  [NOTION_TOOL.updateRecord]: {
    toolName: NOTION_TOOL.updateRecord,
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
    summaryOf: (input) => ({
      target: input.target as string,
      content: Object.keys(
        (input.properties as Record<string, unknown> | undefined) ?? {},
      ).join(", "),
    }),
  },
  [NOTION_TOOL.deletePages]: {
    toolName: NOTION_TOOL.deletePages,
    schema: AgentNotionDeletePagesSchema,
    remoteRequirementsTool: NOTION_TOOL.deletePages,
    candidates: (input) =>
      deletePagesCandidates(
        Array.isArray(input.targets) ? (input.targets as string[]) : [],
      ),
    receipt: (text, input) => deletePagesReceipt(text, input),
    verifyOf: (input) => ({
      tool: "notion_read",
      target: Array.isArray(input.targets)
        ? (input.targets[0] as string)
        : undefined,
    }),
    summaryOf: (input) => {
      const targets = Array.isArray(input.targets)
        ? (input.targets as string[])
        : [];
      return {
        target: targets.length === 1 ? targets[0] : `${targets.length} pages`,
        content: targets.join("\n"),
      };
    },
  },
};

const ASYNC_STATUSES = ["pending", "queued", "running", "in_progress"];

function looksAsync(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return false;
  return Boolean(
    parsed.task_id ||
      parsed.task ||
      parsed.object === "task" ||
      ASYNC_STATUSES.includes(String(parsed.status)),
  );
}

/** Delete succeeds without a new page URL. An async handle stays unknown. */
function deletePagesReceipt(
  resultText: string,
  input: Record<string, unknown>,
): AgentNotionWriteResult {
  const parsed = tryParseJson(resultText);
  const targets = Array.isArray(input.targets)
    ? (input.targets as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  const pageIds = targets.map((target) => normalizeNotionTarget(target));
  if (looksAsync(parsed)) {
    return {
      saved: false,
      tool: NOTION_TOOL.deletePages,
      status: "unknown",
      code: NOTION_ERROR.OUTCOME_UNKNOWN,
      detail:
        "Notion returned no completed delete receipt. Check Trash before trying again; automatic retry is blocked.",
    };
  }
  const message =
    parsed && typeof parsed.message === "string"
      ? parsed.message
      : parsed && typeof parsed.error === "string"
        ? parsed.error
        : resultText;
  if (
    parsed?.error ||
    parsed?.name === "validation_error" ||
    parsed?.code === "validation_error" ||
    /user_confirmed/i.test(message)
  ) {
    return {
      saved: false,
      tool: NOTION_TOOL.deletePages,
      status: "failed",
      code: NOTION_ERROR.VALIDATION_FAILED,
      detail: message.slice(0, 500),
    };
  }
  return {
    saved: true,
    tool: NOTION_TOOL.deletePages,
    pageId: pageIds.length === 1 ? pageIds[0] : undefined,
    pageIds,
  };
}

export function isDetachedWriteTool(name: string): boolean {
  return name in NOTION_WRITE_SPECS;
}

/** The dedupe/write identity — verifiedNoDuplicate never changes it. */
export function notionWriteDedupeInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { verifiedNoDuplicate: _omit, ...dedupe } = input;
  return dedupe;
}

export function notionWriteInputHash(input: Record<string, unknown>): string {
  return hashCanonical(notionWriteDedupeInput(input));
}

/** Body edits return the same page receipt as other update-page writes. */
export function notionContentUpdateReceipt(
  resultText: string,
  pageId: string,
): AgentNotionWriteResult {
  return {
    pageId,
    ...receiptFromWrite(NOTION_TOOL.updateContent, resultText),
  };
}
