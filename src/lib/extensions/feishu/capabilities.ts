import {
  FEISHU_CAPABILITY_REQUIREMENTS,
  FEISHU_TOOL,
  type FEISHU_ALL_TOOL_NAMES,
} from "./constants";
import {
  FEISHU_STATUS,
  parseAvailableCapabilities,
  type FeishuConnectionRow,
} from "./store";

export type FeishuCapabilityFlags = {
  searchDocs: boolean;
  readDoc: boolean;
  createDoc: boolean;
  appendContent: boolean;
  updateContent: boolean;
};

const CAPABILITY_OF_TOOL: Record<string, keyof FeishuCapabilityFlags> = {
  [FEISHU_TOOL.searchDocs]: "searchDocs",
  [FEISHU_TOOL.readDoc]: "readDoc",
  [FEISHU_TOOL.createDoc]: "createDoc",
  [FEISHU_TOOL.appendContent]: "appendContent",
  [FEISHU_TOOL.updateContent]: "updateContent",
};

/**
 * The agent-tool subset a connected app can actually serve: probed API
 * capabilities ∩ the app's fixed allowlist. `capabilities` is the last
 * verified probe set; an empty/unknown set yields no tools — never
 * optimistic. Scope presence is not document access: per-resource
 * permission failures still surface honestly at call time.
 */
export function computeFeishuAgentTools(
  capabilities: readonly string[] | null | undefined,
): Set<string> {
  const available = new Set(capabilities ?? []);
  const effective = new Set<string>();
  for (const [toolName, alternatives] of Object.entries(
    FEISHU_CAPABILITY_REQUIREMENTS,
  )) {
    if (alternatives.some((capability) => available.has(capability))) {
      effective.add(toolName);
    }
  }
  return effective;
}

export function feishuCapabilityFlags(
  capabilities: readonly string[] | null | undefined,
): FeishuCapabilityFlags {
  const tools = computeFeishuAgentTools(capabilities);
  const flags: FeishuCapabilityFlags = {
    searchDocs: false,
    readDoc: false,
    createDoc: false,
    appendContent: false,
    updateContent: false,
  };
  for (const name of tools) {
    const cap = CAPABILITY_OF_TOOL[name];
    if (cap) flags[cap] = true;
  }
  return flags;
}

/**
 * Server-side gate consulted on every tool call — the live connection row
 * plus the probed capability set, intersected with the tool being called.
 * Role filtering happens earlier at registry build time (allowlists can
 * only shrink); this check re-asserts connection state at execution time
 * because a disconnect between registration and execution must not run.
 */
export function isFeishuToolAllowed(
  row: FeishuConnectionRow | null,
  toolName: string,
): boolean {
  if (!row || row.status !== FEISHU_STATUS.CONNECTED) return false;
  return computeFeishuAgentTools(
    parseAvailableCapabilities(row.availableCapabilities),
  ).has(toolName);
}

export type FeishuAgentToolName = (typeof FEISHU_ALL_TOOL_NAMES)[number];
