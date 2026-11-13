// EXT-NOTION: fixed official Notion remote MCP surface. The endpoint is a
// compile-time constant on purpose — the extension never accepts a
// user-supplied MCP URL, so an arbitrary server can never be pointed at the
// user's token or their data.
export const NOTION_MCP_URL = "https://mcp.notion.com/mcp";
export const NOTION_MCP_ORIGIN = "https://mcp.notion.com";

// The OAuth client name Notion shows on its consent screen.
export const NOTION_OAUTH_CLIENT_NAME = "Vocatrya";

// Loopback callback for the system-browser OAuth flow. Electron's backend
// binds an OS-assigned port, so a fixed registered redirect URI cannot be
// used there; we register the whole pool once via dynamic client
// registration and pick a free port per flow.
export const NOTION_CALLBACK_PORTS = [
  43880, 43881, 43882, 43883, 43884, 43885, 43886, 43887, 43888, 43889,
] as const;
export const NOTION_CALLBACK_PATH = "/extensions/notion/oauth/callback";
export const NOTION_CALLBACK_HOST = "127.0.0.1";

export const NOTION_OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;
export const NOTION_TOKEN_REFRESH_LEEWAY_MS = 2 * 60 * 1000;
export const NOTION_REMOTE_CALL_TIMEOUT_MS = 45 * 1000;
export const NOTION_ASYNC_TASK_MAX_POLLS = 4;
export const NOTION_ASYNC_TASK_BASE_DELAY_MS = 1200;

// Remote tool names as advertised by tools/list on the connected server.
export const NOTION_REMOTE = {
  search: "notion-search",
  aiSearch: "notion-ai-search",
  fetch: "notion-fetch",
  createPages: "notion-create-pages",
  updatePage: "notion-update-page",
  asyncTask: "notion-get-async-task",
} as const;

// Agent-facing tool names registered in the chat runtime.
export const NOTION_TOOL = {
  search: "notion_search",
  read: "notion_read",
  createPage: "notion_create_page",
  appendContent: "notion_append_content",
  updateRecord: "notion_update_record",
} as const;

export const NOTION_READ_TOOL_NAMES = [
  NOTION_TOOL.search,
  NOTION_TOOL.read,
] as const;
export const NOTION_WRITE_TOOL_NAMES = [
  NOTION_TOOL.createPage,
  NOTION_TOOL.appendContent,
  NOTION_TOOL.updateRecord,
] as const;
export const NOTION_ALL_TOOL_NAMES = [
  ...NOTION_READ_TOOL_NAMES,
  ...NOTION_WRITE_TOOL_NAMES,
] as const;

export function isNotionAgentToolName(name: string): boolean {
  return (NOTION_ALL_TOOL_NAMES as readonly string[]).includes(name);
}

// Which remote tools each agent tool needs. An entry is satisfied when ANY
// alternative is present in the session's tools/list.
export const NOTION_REMOTE_REQUIREMENTS: Record<string, readonly string[]> = {
  [NOTION_TOOL.search]: [NOTION_REMOTE.search, NOTION_REMOTE.aiSearch],
  [NOTION_TOOL.read]: [NOTION_REMOTE.fetch],
  [NOTION_TOOL.createPage]: [NOTION_REMOTE.createPages],
  [NOTION_TOOL.appendContent]: [NOTION_REMOTE.updatePage],
  [NOTION_TOOL.updateRecord]: [NOTION_REMOTE.updatePage],
};

// Bounded result sizes — Notion content must not swamp the model context or
// the persisted transcript.
export const NOTION_SEARCH_RESULT_LIMIT = 25;
export const NOTION_READ_CONTENT_LIMIT = 12_000;
export const NOTION_WRITE_CONTENT_LIMIT = 8_000;
