import "server-only";

import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { FEISHU_TOOL } from "./constants";
import { FEISHU_ERROR, FeishuError } from "./errors";
import {
  appendDocxChildren,
  batchUpdateDocxBlocks,
  createDocxDocument,
  markdownToFeishuBlocks,
  normalizeFeishuTarget,
  readDocxMeta,
  resolveWikiNode,
  type FeishuCall,
} from "./apiMap";
import { expectFeishuOk, feishuRequest } from "./api";
import { resolveFeishuAccessToken } from "./service";
import { getFeishuConnection } from "./store";
import { isFeishuToolAllowed } from "./capabilities";

type Db = Pick<PrismaClient, "feishuConnection">;

/**
 * The provider write dispatch used by the harness executor. Returns the
 * same content-text envelope the Notion MCP call returns so the shared
 * SETTLE step can parse one JSON receipt shape.
 */
export type FeishuWriteCallResult = {
  isError?: boolean;
  content: { type: "text"; text: string }[];
};

type Deps = {
  db?: Db;
  call?: FeishuCall;
  signal?: AbortSignal;
  expectedAppId?: string | null;
};

function envelope(data: Record<string, unknown>): FeishuWriteCallResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** Resolve a user-supplied target to a docx document id, honestly. */
async function resolveDocxId(
  rawTarget: string,
  token: string,
  call: FeishuCall,
  signal?: AbortSignal,
): Promise<string> {
  const target = normalizeFeishuTarget(rawTarget);
  if (!target) throw new FeishuError(FEISHU_ERROR.VALIDATION_FAILED);
  if (target.kind === "docx") return target.token;
  if (target.kind === "wiki") {
    const node = await resolveWikiNode(token, target.token, call, signal);
    if (node.objType !== "docx") {
      throw new FeishuError(FEISHU_ERROR.UNSUPPORTED_TARGET);
    }
    return node.objToken;
  }
  throw new FeishuError(FEISHU_ERROR.UNSUPPORTED_TARGET);
}

/** Best-effort document URL via the drive meta batch query. */
async function documentUrl(
  token: string,
  documentId: string,
  call: FeishuCall,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const data = expectFeishuOk<{ metas?: Array<Record<string, unknown>> }>(
      await call({
        method: "POST",
        path: "/open-apis/drive/v1/metas/batch_query",
        token,
        body: {
          request_docs: [{ doc_token: documentId, doc_type: "docx" }],
          with_url: true,
        },
        signal,
      }),
    );
    const meta = Array.isArray(data?.metas) ? data!.metas![0] : undefined;
    return typeof meta?.url === "string" ? meta.url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Execute one approved Feishu write. The returned text is a JSON receipt
 * the spec's `receipt` parses — `document_id` present means the document
 * verifiably exists; partial application lands as warnings, never as a
 * silent success or a guessed failure.
 */
export async function executeFeishuWrite(
  userId: string,
  toolName: string,
  input: Record<string, unknown>,
  deps: Deps = {},
): Promise<FeishuWriteCallResult> {
  const db = deps.db ?? prisma;
  const row = await getFeishuConnection(userId, db);
  if (!isFeishuToolAllowed(row, toolName) || (deps.expectedAppId && row?.appId !== deps.expectedAppId)) {
    throw new FeishuError(!row || row.status === "DISCONNECTED" ? FEISHU_ERROR.NOT_CONNECTED
      : row.status === "REAUTH_REQUIRED" ? FEISHU_ERROR.REAUTH_REQUIRED : FEISHU_ERROR.TOOL_UNAVAILABLE);
  }
  const remote = deps.call ?? feishuRequest;
  const call: FeishuCall = async (request) => {
    const live = await getFeishuConnection(userId, db);
    if (!isFeishuToolAllowed(live, toolName) || live?.revision !== row!.revision) throw new FeishuError(FEISHU_ERROR.NOT_CONNECTED);
    return remote(request);
  };
  const token = await resolveFeishuAccessToken(userId, { db, call, expectedAppId: row!.appId });
  const signal = deps.signal;
  const warnings: string[] = [];

  if (toolName === FEISHU_TOOL.createDoc) {
    const title = input.title as string;
    const folderToken =
      typeof input.folderToken === "string" && input.folderToken
        ? input.folderToken
        : undefined;
    const created = await createDocxDocument(
      token,
      { title, folderToken },
      call,
      signal,
    );
    const content =
      typeof input.content === "string" && input.content.trim()
        ? input.content
        : undefined;
    let contentAppended: boolean | undefined;
    if (content) {
      try {
        const blocks = markdownToFeishuBlocks(content);
        const { appended } = await appendDocxChildren(
          token,
          created.documentId,
          created.documentId,
          blocks,
          call,
          signal,
        );
        contentAppended = appended === blocks.length;
        if (!contentAppended) {
          warnings.push("partial content append: count mismatch");
        }
      } catch (error) {
        // The document exists; the body may be missing or partial. Say so —
        // re-creating would duplicate, so the receipt stays a saved doc
        // with an honest warning, not a retryable failure.
        contentAppended = false;
        warnings.push(
          `content append failed after document was created: ${
            error instanceof FeishuError ? error.code : "FEISHU_OUTCOME_UNKNOWN"
          }`,
        );
      }
    }
    const url = await documentUrl(token, created.documentId, call, signal);
    if (!url) warnings.push("document URL could not be verified");
    return envelope({
      document_id: created.documentId,
      title: created.title,
      url,
      content_appended: contentAppended,
      warnings: warnings.length ? warnings : undefined,
    });
  }

  if (toolName === FEISHU_TOOL.appendContent) {
    const documentId = await resolveDocxId(
      input.target as string,
      token,
      call,
      signal,
    );
    const blocks = markdownToFeishuBlocks(input.content as string);
    const { appended } = await appendDocxChildren(
      token,
      documentId,
      documentId,
      blocks,
      call,
      signal,
    );
    const url = await documentUrl(token, documentId, call, signal);
    let title: string | undefined;
    try {
      title = (await readDocxMeta(token, documentId, call, signal)).title;
    } catch {
      warnings.push("document title could not be re-read");
    }
    if (appended !== blocks.length) {
      warnings.push(`requested ${blocks.length} blocks, server confirmed ${appended}`);
    }
    if (!url) warnings.push("document URL could not be verified");
    return envelope({
      document_id: documentId,
      title,
      url,
      blocks_appended: appended,
      warnings: warnings.length ? warnings : undefined,
    });
  }

  if (toolName === FEISHU_TOOL.updateContent) {
    const documentId = await resolveDocxId(
      input.target as string,
      token,
      call,
      signal,
    );
    const edits = Array.isArray(input.edits)
      ? (input.edits as { blockId: string; newText: string }[])
      : [];
    const requests = edits.map((edit) => ({
      block_id: edit.blockId,
      update_text_elements: {
        elements: [{ text_run: { content: edit.newText } }],
      },
    }));
    const { updated } = await batchUpdateDocxBlocks(
      token,
      documentId,
      requests,
      call,
      signal,
    );
    const url = await documentUrl(token, documentId, call, signal);
    if (updated !== requests.length) {
      warnings.push(`requested ${requests.length} block edits, server confirmed ${updated}`);
    }
    if (!url) warnings.push("document URL could not be verified");
    return envelope({
      document_id: documentId,
      url,
      blocks_updated: updated,
      warnings: warnings.length ? warnings : undefined,
    });
  }

  throw new FeishuError(FEISHU_ERROR.TOOL_UNAVAILABLE);
}
