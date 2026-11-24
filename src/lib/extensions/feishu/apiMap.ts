import "server-only";

import {
  FEISHU_CAPABILITY,
  FEISHU_PAGE_SIZE,
  FEISHU_PROBE_DOCUMENT_ID,
} from "./constants";
import { FEISHU_ERROR, FeishuError } from "./errors";
import { expectFeishuOk, feishuApiError, feishuRequest } from "./api";

/**
 * Feishu OpenAPI surface used by the extension, plus the pure mappers that
 * turn targets/Markdown/remote payloads into honest local shapes. Every
 * function takes a `call` seam so tests can drive failure branches without a
 * network; production passes {@link feishuRequest}.
 */

export type FeishuCall = typeof feishuRequest;

// ─── Tenant token ──────────────────────────────────────────────────────────

export async function fetchTenantAccessToken(
  appId: string,
  appSecret: string,
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<{ token: string; expiresInSec: number }> {
  const res = await call({
    method: "POST",
    path: "/open-apis/auth/v3/tenant_access_token/internal",
    body: { app_id: appId, app_secret: appSecret },
    signal,
  });
  if (res.code !== 0 || res.status !== 200) {
    // Wrong App ID/Secret is the only expected failure here; anything else
    // maps through the standard status mapping.
    throw res.status === 200
      ? new FeishuError(FEISHU_ERROR.INVALID_CREDENTIALS)
      : feishuApiError(res);
  }
  const data = res.data as { tenant_access_token?: string; expire?: number };
  if (typeof data?.tenant_access_token !== "string" || !data.tenant_access_token) {
    throw new FeishuError(FEISHU_ERROR.INVALID_CREDENTIALS);
  }
  return {
    token: data.tenant_access_token,
    expiresInSec: typeof data.expire === "number" ? data.expire : 0,
  };
}

// ─── Target normalization ─────────────────────────────────────────────────

export type FeishuTargetKind =
  | "docx"
  | "wiki"
  | "doc"
  | "file"
  | "sheet"
  | "bitable"
  | "folder"
  | "unknown";

export type FeishuTarget = { kind: FeishuTargetKind; token: string };

const TOKEN_KIND_BY_PREFIX: Array<[RegExp, FeishuTargetKind]> = [
  [/^doxcn/i, "docx"],
  [/^doccn/i, "doc"],
  [/^wikcn/i, "wiki"],
  [/^fldcn/i, "folder"],
  [/^shtcn/i, "sheet"],
  [/^(bascn|app)/i, "bitable"],
  [/^(boxcn|file)/i, "file"],
];

const PATH_KIND_BY_SEGMENT: Record<string, FeishuTargetKind> = {
  docx: "docx",
  docs: "doc",
  wiki: "wiki",
  file: "file",
  sheets: "sheet",
  sheet: "sheet",
  base: "bitable",
  bitable: "bitable",
  minutes: "file",
};

/**
 * Accept a Feishu URL or a bare token. Feishu object tokens carry stable
 * prefixes (doxcn/wikcn/fldcn/…), so a bare token still resolves to a kind;
 * an unrecognized one stays "unknown" and fails honestly downstream.
 */
export function normalizeFeishuTarget(raw: string): FeishuTarget | null {
  const value = raw.trim();
  if (!value) return null;
  const byPrefix = (token: string): FeishuTarget => ({
    kind:
      TOKEN_KIND_BY_PREFIX.find(([pattern]) => pattern.test(token))?.[1] ??
      "docx",
    token,
  });
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password ||
          !(url.hostname === "feishu.cn" || url.hostname.endsWith(".feishu.cn"))) return null;
      const segments = url.pathname.split("/").filter(Boolean);
      for (let index = 0; index < segments.length; index += 1) {
        const kind = PATH_KIND_BY_SEGMENT[segments[index].toLowerCase()];
        if (!kind) continue;
        const next = segments[index + 1];
        if (next && /^[A-Za-z0-9_-]{8,}$/.test(next)) {
          return { kind, token: next };
        }
      }
      // drive/folder/<token>
      const folderIndex = segments.findIndex(
        (s) => s.toLowerCase() === "folder",
      );
      if (folderIndex >= 0 && segments[folderIndex + 1]) {
        return byPrefix(segments[folderIndex + 1]);
      }
      return null;
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z0-9_-]{8,}$/.test(value)) return byPrefix(value);
  return null;
}

// ─── Markdown → docx blocks ────────────────────────────────────────────────

type TextElement = {
  text_run: {
    content: string;
    text_element_style?: {
      bold?: boolean;
      italic?: boolean;
      inline_code?: boolean;
      link?: { url: string };
    };
  };
};

export type FeishuBlockInput = Record<string, unknown>;

// Inline tokens: **bold**, *italic*, `code`, [label](url). Unmatched markers
// stay literal — the text the user approved is the text sent.
const INLINE_RE =
  /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g;

function inlineElements(text: string): TextElement[] {
  const elements: TextElement[] = [];
  let cursor = 0;
  const push = (content: string, style?: TextElement["text_run"]["text_element_style"]) => {
    if (content) elements.push({ text_run: { content, ...(style ? { text_element_style: style } : {}) } });
  };
  for (const match of text.matchAll(INLINE_RE)) {
    const token = match[0];
    const at = match.index ?? 0;
    push(text.slice(cursor, at));
    if (token.startsWith("**") && token.endsWith("**")) {
      push(token.slice(2, -2), { bold: true });
    } else if (token.startsWith("`") && token.endsWith("`")) {
      push(token.slice(1, -1), { inline_code: true });
    } else if (token.startsWith("*") && token.endsWith("*")) {
      push(token.slice(1, -1), { italic: true });
    } else {
      const labelEnd = token.indexOf("](");
      const label = token.slice(1, labelEnd);
      const url = token.slice(labelEnd + 2, -1);
      push(label || url, { link: { url: encodeURI(url) } });
    }
    cursor = at + token.length;
  }
  push(text.slice(cursor));
  return elements.length ? elements : [{ text_run: { content: "" } }];
}

function textBlock(
  blockType: number,
  key: string,
  elements: TextElement[],
  extra?: Record<string, unknown>,
): FeishuBlockInput {
  return {
    block_type: blockType,
    [key]: { elements, ...(extra ? { style: extra } : {}) },
  };
}

const HEADING_RE = /^(#{1,9})\s+(.*)$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const TODO_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
const DIVIDER_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Map a Markdown-ish body onto docx block JSON. Supported: headings, plain
 * paragraphs, bullet/ordered lists, quotes, dividers, todos; inline bold,
 * italic, inline code and links. Anything else stays a paragraph verbatim —
 * the approved text is never dropped or reinterpreted.
 */
export function markdownToFeishuBlocks(markdown: string): FeishuBlockInput[] {
  const blocks: FeishuBlockInput[] = [];
  const paragraphLines: string[] = [];
  const flush = () => {
    if (!paragraphLines.length) return;
    const content = paragraphLines.join("\n");
    paragraphLines.length = 0;
    blocks.push(textBlock(2, "text", inlineElements(content)));
  };
  for (const line of markdown.split(/\r?\n/)) {
    const todo = line.match(TODO_RE);
    const heading = line.match(HEADING_RE);
    const divider = line.match(DIVIDER_RE);
    const quote = line.match(QUOTE_RE);
    const bullet = line.match(BULLET_RE);
    const ordered = line.match(ORDERED_RE);
    if (todo) {
      flush();
      blocks.push(
        textBlock(17, "todo", inlineElements(todo[2]), {
          done: todo[1].toLowerCase() === "x",
        }),
      );
    } else if (divider) {
      flush();
      blocks.push({ block_type: 22, divider: {} });
    } else if (heading) {
      flush();
      const level = Math.min(heading[1].length, 9);
      // block_type: heading1=3 … heading9=11; the body key is headingN.
      blocks.push(
        textBlock(
          2 + level,
          `heading${level}`,
          inlineElements(heading[2] || " "),
        ),
      );
    } else if (quote) {
      flush();
      blocks.push(textBlock(15, "quote", inlineElements(quote[1])));
    } else if (bullet) {
      flush();
      blocks.push(textBlock(12, "bullet", inlineElements(bullet[1])));
    } else if (ordered) {
      flush();
      blocks.push(textBlock(13, "ordered", inlineElements(ordered[1])));
    } else if (line.trim() === "") {
      flush();
    } else {
      paragraphLines.push(line);
    }
  }
  flush();
  return blocks;
}

// ─── Wiki resolution ───────────────────────────────────────────────────────

export type FeishuWikiNode = {
  nodeToken: string;
  objToken: string;
  objType: string;
  title: string;
  spaceId: string;
  hasChild?: boolean;
};

export async function resolveWikiNode(
  token: string,
  nodeToken: string,
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<FeishuWikiNode> {
  const data = expectFeishuOk<{ node?: Record<string, unknown> }>(
    await call({
      method: "GET",
      path: "/open-apis/wiki/v2/spaces/get_node",
      token,
      query: { token: nodeToken, obj_type: "wiki" },
      signal,
    }),
  );
  const node = data?.node;
  if (!node || typeof node.obj_token !== "string") {
    throw new FeishuError(FEISHU_ERROR.OBJECT_NOT_FOUND);
  }
  return {
    nodeToken: String(node.node_token ?? nodeToken),
    objToken: node.obj_token,
    objType: String(node.obj_type ?? "unknown"),
    title: String(node.title ?? ""),
    spaceId: String(node.space_id ?? ""),
    hasChild: node.has_child === true,
  };
}

// ─── Drive / wiki listing (search) ────────────────────────────────────────

export type FeishuListItem = {
  id: string;
  title: string;
  objectType: string;
  url?: string;
  container: string;
  editedAt?: string;
};

export async function listDriveFiles(
  token: string,
  folderToken: string | undefined,
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<{ items: FeishuListItem[]; hasMore: boolean }> {
  const data = expectFeishuOk<{
    files?: Array<Record<string, unknown>>;
    has_more?: boolean;
  }>(
    await call({
      method: "GET",
      path: "/open-apis/drive/v1/files",
      token,
      query: {
        folder_token: folderToken,
        page_size: FEISHU_PAGE_SIZE,
        order_by: "EditedTime",
        direction: "DESC",
      },
      signal,
    }),
  );
  const files = Array.isArray(data?.files) ? data!.files! : [];
  return {
    hasMore: data?.has_more === true,
    items: files
      .filter((f) => typeof f?.token === "string")
      .map((f) => ({
        id: f.token as string,
        title: typeof f.name === "string" && f.name ? f.name : (f.token as string),
        objectType: typeof f.type === "string" ? f.type : "file",
        url: typeof f.url === "string" ? f.url : undefined,
        container: folderToken ? `folder:${folderToken}` : "app-space",
        editedAt:
          typeof f.modified_time === "string"
            ? new Date(Number(f.modified_time) * 1000).toISOString()
            : undefined,
      })),
  };
}

export async function listWikiSpaces(
  token: string,
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<FeishuListItem[]> {
  const data = expectFeishuOk<{ items?: Array<Record<string, unknown>> }>(
    await call({
      method: "GET",
      path: "/open-apis/wiki/v2/spaces",
      token,
      query: { page_size: FEISHU_PAGE_SIZE },
      signal,
    }),
  );
  const spaces = Array.isArray(data?.items) ? data!.items! : [];
  return spaces
    .filter((s) => typeof s?.space_id === "string")
    .map((s) => ({
      id: s.space_id as string,
      title: typeof s.name === "string" && s.name ? s.name : (s.space_id as string),
      objectType: "wiki_space",
      container: "wiki",
    }));
}

export async function listWikiNodes(
  token: string,
  spaceId: string,
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<FeishuListItem[]> {
  const data = expectFeishuOk<{ items?: Array<Record<string, unknown>> }>(
    await call({
      method: "GET",
      path: `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
      token,
      query: { page_size: FEISHU_PAGE_SIZE },
      signal,
    }),
  );
  const nodes = Array.isArray(data?.items) ? data!.items! : [];
  return nodes
    .filter((n) => typeof n?.node_token === "string")
    .map((n) => ({
      id: n.node_token as string,
      title: typeof n.title === "string" && n.title ? n.title : (n.node_token as string),
      objectType: typeof n.obj_type === "string" ? `wiki:${n.obj_type}` : "wiki",
      container: `wiki:${spaceId}`,
    }));
}

// ─── Docx read ─────────────────────────────────────────────────────────────

export async function readDocxMeta(
  token: string,
  documentId: string,
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<{ documentId: string; title: string; revisionId: number | null }> {
  const data = expectFeishuOk<{ document?: Record<string, unknown> }>(
    await call({
      method: "GET",
      path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
      token,
      signal,
    }),
  );
  const doc = data?.document;
  if (!doc || typeof doc.document_id !== "string") {
    throw new FeishuError(FEISHU_ERROR.OBJECT_NOT_FOUND);
  }
  return {
    documentId: doc.document_id,
    title: typeof doc.title === "string" ? doc.title : "",
    revisionId: typeof doc.revision_id === "number" ? doc.revision_id : null,
  };
}

export async function readDocxRawContent(
  token: string,
  documentId: string,
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<string> {
  const data = expectFeishuOk<{ content?: string }>(
    await call({
      method: "GET",
      path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
      token,
      signal,
    }),
  );
  return typeof data?.content === "string" ? data.content : "";
}

export type FeishuBlockSummary = {
  blockId: string;
  type: string;
  text: string;
};

const BLOCK_TEXT_KEYS: Record<number, string> = {
  2: "text",
  3: "heading1",
  4: "heading2",
  5: "heading3",
  6: "heading4",
  7: "heading5",
  8: "heading6",
  9: "heading7",
  10: "heading8",
  11: "heading9",
  12: "bullet",
  13: "ordered",
  15: "quote",
  17: "todo",
};

export async function listDocxBlocks(
  token: string,
  documentId: string,
  limit: number,
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<{ blocks: FeishuBlockSummary[]; truncated: boolean }> {
  const blocks: FeishuBlockSummary[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const data = expectFeishuOk<{
      items?: Array<Record<string, unknown>>;
      has_more?: boolean;
      page_token?: string;
    }>(
      await call({
        method: "GET",
        path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks`,
        token,
        query: { page_size: 200, page_token: pageToken },
        signal,
      }),
    );
    for (const block of data?.items ?? []) {
      if (blocks.length >= limit) return { blocks, truncated: true };
      const blockId = block.block_id;
      const blockType = block.block_type;
      if (typeof blockId !== "string" || typeof blockType !== "number") continue;
      const key = BLOCK_TEXT_KEYS[blockType];
      const body = key ? (block[key] as { elements?: Array<{ text_run?: { content?: string } }> } | undefined) : undefined;
      const text = Array.isArray(body?.elements)
        ? body!.elements!
            .map((el) => el?.text_run?.content ?? "")
            .join("")
        : "";
      blocks.push({
        blockId,
        type: key ?? `type_${blockType}`,
        text: text.length > 160 ? `${text.slice(0, 160)}…` : text,
      });
    }
    if (data?.has_more === true && typeof data.page_token === "string") {
      pageToken = data.page_token;
      continue;
    }
    return { blocks, truncated: false };
  }
}

// ─── Docx writes ───────────────────────────────────────────────────────────

export async function createDocxDocument(
  token: string,
  input: { title: string; folderToken?: string },
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<{ documentId: string; revisionId: number | null; title: string }> {
  const data = expectFeishuOk<{ document?: Record<string, unknown> }>(
    await call({
      method: "POST",
      path: "/open-apis/docx/v1/documents",
      token,
      body: {
        title: input.title,
        ...(input.folderToken ? { folder_token: input.folderToken } : {}),
      },
      signal,
    }),
  );
  const doc = data?.document;
  if (!doc || typeof doc.document_id !== "string") {
    throw new FeishuError(FEISHU_ERROR.REMOTE_FAILED);
  }
  return {
    documentId: doc.document_id,
    revisionId: typeof doc.revision_id === "number" ? doc.revision_id : null,
    title: typeof doc.title === "string" ? doc.title : input.title,
  };
}

export async function appendDocxChildren(
  token: string,
  documentId: string,
  parentBlockId: string,
  blocks: FeishuBlockInput[],
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<{ appended: number }> {
  let appended = 0;
  // The API accepts one children batch per request; 50 keeps well under the
  // documented payload ceiling and bounds one call's blast radius.
  for (let start = 0; start < blocks.length; start += FEISHU_PAGE_SIZE) {
    const slice = blocks.slice(start, start + FEISHU_PAGE_SIZE);
    let data: { children?: unknown[] };
    try {
      data = expectFeishuOk<{ children?: unknown[] }>(await call({
        method: "POST",
        path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentBlockId)}/children`,
        token,
        body: { children: slice }, signal,
      }));
    } catch (error) {
      if (appended > 0) throw new FeishuError(FEISHU_ERROR.OUTCOME_UNKNOWN);
      throw error;
    }
    const children = Array.isArray(data?.children) ? data!.children! : [];
    if (children.length !== slice.length) {
      // A short count means part of the batch may not have landed — the
      // caller reports partial truth instead of guessing.
      throw new FeishuError(FEISHU_ERROR.OUTCOME_UNKNOWN);
    }
    appended += children.length;
  }
  return { appended };
}

export async function batchUpdateDocxBlocks(
  token: string,
  documentId: string,
  requests: Array<Record<string, unknown>>,
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<{ updated: number }> {
  const data = expectFeishuOk<{ blocks?: unknown[] }>(
    await call({
      method: "PATCH",
      path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/batch_update`,
      token,
      body: { requests },
      signal,
    }),
  );
  if (!Array.isArray(data?.blocks) || data.blocks.length !== requests.length) throw new FeishuError(FEISHU_ERROR.OUTCOME_UNKNOWN);
  return { updated: data.blocks.length };
}

// ─── Capability probes ─────────────────────────────────────────────────────

export type FeishuCapabilityProbeResult = {
  capabilities: string[];
  /** First probe failure worth showing the user, if any. */
  error?: string;
};

function isTransportError(error: unknown): boolean {
  return (
    error instanceof FeishuError &&
    (error.code === FEISHU_ERROR.NETWORK ||
      error.code === FEISHU_ERROR.OUTCOME_UNKNOWN)
  );
}

/**
 * Probe what the app's scopes actually allow. Each probe distinguishes
 * "scope not granted" (403) from the documented absent-document response
 * and from transport failures; a probe that cannot decide reports nothing
 * for that capability rather than guessing. Probes never write real data —
 * they touch a syntactically valid but nonexistent document id.
 */
export async function probeFeishuCapabilities(
  token: string,
  call: FeishuCall = feishuRequest,
  signal?: AbortSignal,
): Promise<FeishuCapabilityProbeResult> {
  const capabilities = new Set<string>();
  let firstError: string | undefined;
  const note = (error: unknown) => {
    if (!firstError && error instanceof FeishuError) firstError = error.code;
  };

  // drive.list — app-space file listing.
  try {
    await listDriveFiles(token, undefined, call, signal);
    capabilities.add(FEISHU_CAPABILITY.driveList);
  } catch (error) {
    if (isTransportError(error)) note(error);
    // 403 → scope absent → capability stays off; 404 still proves reach.
    if (error instanceof FeishuError && error.code === FEISHU_ERROR.OBJECT_NOT_FOUND) {
      capabilities.add(FEISHU_CAPABILITY.driveList);
    } else if (!(error instanceof FeishuError) || error.code !== FEISHU_ERROR.PERMISSION_DENIED) {
      note(error);
    }
  }

  // wiki.read — knowledge-base space listing.
  try {
    await listWikiSpaces(token, call, signal);
    capabilities.add(FEISHU_CAPABILITY.wikiRead);
  } catch (error) {
    if (error instanceof FeishuError && error.code === FEISHU_ERROR.OBJECT_NOT_FOUND) {
      capabilities.add(FEISHU_CAPABILITY.wikiRead);
    } else if (!(error instanceof FeishuError) || error.code !== FEISHU_ERROR.PERMISSION_DENIED) {
      note(error);
    }
  }

  // Only the documented missing-document business code is positive evidence.
  // Generic 400/404, auth errors and rate limits do not establish a scope.
  const probeDocx = async (write: boolean) => {
    try {
      const res = await call({
        method: write ? "PATCH" : "GET",
        path: `/open-apis/docx/v1/documents/${FEISHU_PROBE_DOCUMENT_ID}/${write ? "blocks/batch_update" : "raw_content"}`,
        token, signal,
        ...(write ? { body: { requests: [{ block_id: FEISHU_PROBE_DOCUMENT_ID,
          update_text_elements: { elements: [{ text_run: { content: "probe" } }] } }] } } : {}),
      });
      if ((res.status === 200 && res.code === 0) || (res.status === 404 && res.code === 1770002)) {
        capabilities.add(write ? FEISHU_CAPABILITY.docxWrite : FEISHU_CAPABILITY.docxRead);
      } else {
        const error = feishuApiError(res);
        if (error.code !== FEISHU_ERROR.PERMISSION_DENIED) note(error);
      }
    } catch (error) {
      note(error);
    }
  };
  await probeDocx(false);
  await probeDocx(true);

  return { capabilities: [...capabilities], error: firstError };
}
