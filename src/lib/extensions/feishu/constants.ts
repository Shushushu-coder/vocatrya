// EXT-FEISHU: fixed Feishu OpenAPI base. The extension is application-identity
// only (tenant_access_token for a self-built app the user configures) and
// never accepts a user-supplied endpoint, so credentials can never be aimed
// at an arbitrary server.
export const FEISHU_API_BASE = "https://open.feishu.cn";

export const FEISHU_REQUEST_TIMEOUT_MS = 30 * 1000;
export const FEISHU_TOKEN_REFRESH_LEEWAY_MS = 60 * 1000;

// Agent-facing tool names registered in the chat runtime.
export const FEISHU_TOOL = {
  searchDocs: "feishu_search_docs",
  readDoc: "feishu_read_doc",
  createDoc: "feishu_create_doc",
  appendContent: "feishu_append_content",
  updateContent: "feishu_update_content",
} as const;

export const FEISHU_READ_TOOL_NAMES = [
  FEISHU_TOOL.searchDocs,
  FEISHU_TOOL.readDoc,
] as const;
export const FEISHU_WRITE_TOOL_NAMES = [
  FEISHU_TOOL.createDoc,
  FEISHU_TOOL.appendContent,
  FEISHU_TOOL.updateContent,
] as const;
export const FEISHU_ALL_TOOL_NAMES = [
  ...FEISHU_READ_TOOL_NAMES,
  ...FEISHU_WRITE_TOOL_NAMES,
] as const;

export function isFeishuAgentToolName(name: string): boolean {
  return (FEISHU_ALL_TOOL_NAMES as readonly string[]).includes(name);
}

// Capability keys probed against the live API at connect/verify time and
// persisted on the connection row. These record which API scopes the app
// appears to have been granted — never "all documents accessible".
export const FEISHU_CAPABILITY = {
  driveList: "drive.list",
  wikiRead: "wiki.read",
  docxRead: "docx.read",
  docxWrite: "docx.write",
} as const;

// Which probed capabilities each agent tool needs (ANY alternative suffices).
export const FEISHU_CAPABILITY_REQUIREMENTS: Record<
  string,
  readonly string[]
> = {
  [FEISHU_TOOL.searchDocs]: [FEISHU_CAPABILITY.driveList, FEISHU_CAPABILITY.wikiRead],
  [FEISHU_TOOL.readDoc]: [FEISHU_CAPABILITY.docxRead],
  [FEISHU_TOOL.createDoc]: [FEISHU_CAPABILITY.docxWrite],
  [FEISHU_TOOL.appendContent]: [FEISHU_CAPABILITY.docxWrite],
  [FEISHU_TOOL.updateContent]: [FEISHU_CAPABILITY.docxWrite],
};

// Operation labels recorded in write checkpoints (analogous to Notion's
// remote tool names — a stable audit string, not a URL).
export const FEISHU_OPERATION = {
  createDoc: "docx.v1.documents.create",
  appendBlocks: "docx.v1.documentBlockChildren.create",
  batchUpdateBlocks: "docx.v1.documentBlock.batchUpdate",
} as const;

// Bounded result sizes — remote content must not swamp the model context or
// the persisted transcript.
export const FEISHU_SEARCH_RESULT_LIMIT = 25;
export const FEISHU_READ_CONTENT_LIMIT = 12_000;
export const FEISHU_WRITE_CONTENT_LIMIT = 8_000;
export const FEISHU_BLOCK_LIST_LIMIT = 200;
export const FEISHU_PAGE_SIZE = 50;
// Probes use a syntactically valid but nonexistent document id; a scope the
// app lacks answers 403, a granted scope answers 400/404 — honest either way.
export const FEISHU_PROBE_DOCUMENT_ID = "vocatryaprobe00000000000000";
