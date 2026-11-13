import {
  NOTION_REMOTE_REQUIREMENTS,
  NOTION_TOOL,
  type NOTION_ALL_TOOL_NAMES,
} from "./constants";
import { NOTION_STATUS, parseAvailableTools, type NotionConnectionRow } from "./store";

export type NotionCapabilityFlags = {
  search: boolean;
  read: boolean;
  createPage: boolean;
  appendContent: boolean;
  updateRecord: boolean;
};

const CAPABILITY_OF_TOOL: Record<string, keyof NotionCapabilityFlags> = {
  [NOTION_TOOL.search]: "search",
  [NOTION_TOOL.read]: "read",
  [NOTION_TOOL.createPage]: "createPage",
  [NOTION_TOOL.appendContent]: "appendContent",
  [NOTION_TOOL.updateRecord]: "updateRecord",
};

/**
 * The agent-tool subset a connected session can actually serve: remote
 * tools/list ∩ the app's fixed allowlist. `remoteTools` is the last
 * verified tool name set; an empty/unknown set yields no capabilities —
 * never optimistic.
 */
export function computeNotionAgentTools(
  remoteTools: readonly string[] | null | undefined,
): Set<string> {
  const available = new Set(remoteTools ?? []);
  const effective = new Set<string>();
  for (const [toolName, alternatives] of Object.entries(
    NOTION_REMOTE_REQUIREMENTS,
  )) {
    if (alternatives.some((remote) => available.has(remote))) {
      effective.add(toolName);
    }
  }
  return effective;
}

export function notionCapabilityFlags(
  remoteTools: readonly string[] | null | undefined,
): NotionCapabilityFlags {
  const tools = computeNotionAgentTools(remoteTools);
  const flags: NotionCapabilityFlags = {
    search: false,
    read: false,
    createPage: false,
    appendContent: false,
    updateRecord: false,
  };
  for (const name of tools) {
    const cap = CAPABILITY_OF_TOOL[name];
    if (cap) flags[cap] = true;
  }
  return flags;
}

/**
 * Server-side gate consulted on every tool call — the live connection row
 * plus the registered remote tools, intersected with the tool being called.
 * Role filtering happens earlier at registry build time (allowlists can
 * only shrink); this check re-asserts connection state at execution time
 * because a disconnect between registration and execution must not run.
 */
export function isNotionToolAllowed(
  row: NotionConnectionRow | null,
  toolName: string,
): boolean {
  if (!row || row.status !== NOTION_STATUS.CONNECTED) return false;
  return computeNotionAgentTools(parseAvailableTools(row.availableTools)).has(
    toolName,
  );
}

export type NotionAgentToolName = (typeof NOTION_ALL_TOOL_NAMES)[number];
