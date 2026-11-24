// The three professional agent roles, in the fixed journey order the header
// switcher presents them: Insight → Pilot → Reflect. Shared by server
// (prompt/tool selection) and client (slot model) — keep it dependency-free.
export const AGENT_ROLES = ["insight", "pilot", "reflect"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

// A NULL agentRole — every pre-multi-agent row — keeps the historical
// general-assistant surface at run time (full runtime registry, general
// prompt). It is not a role and is never written by new code: new
// conversations always stamp one of AGENT_ROLES.
export type PersistedAgentRole = AgentRole | null;

// The slot a NULL conversation occupies in the client. "通用" rows are
// attributed to the Pilot slot, which is also the slot a fresh client opens
// when nothing else is known.
export const GENERAL_AGENT_SLOT: AgentRole = "pilot";

export function isAgentRole(value: unknown): value is AgentRole {
  return (
    typeof value === "string" &&
    (AGENT_ROLES as readonly string[]).includes(value)
  );
}

/**
 * Normalize a stored agentRole. An unknown value degrades to null rather
 * than aborting the request — a future role written by a newer build reads
 * as the general assistant instead of breaking the conversation.
 */
export function normalizeAgentRole(value: unknown): AgentRole | null {
  return isAgentRole(value) ? value : null;
}

/** Which client slot a persisted role lives in. NULL → the Pilot slot. */
export function slotRoleFor(
  agentRole: string | null | undefined,
): AgentRole {
  return normalizeAgentRole(agentRole) ?? GENERAL_AGENT_SLOT;
}

/**
 * Server-side per-role tool allowlists. The effective registry is
 * allowlist ∩ runtime-registered tools: fresh-native/full removes
 * generate_cover_letter and rebinds match_job to its canonical variant
 * BEFORE this filter runs, so an allowlisted name can only shrink, never
 * grow, what the runtime offers. A NULL role skips the filter entirely —
 * legacy rows keep the general registry.
 */
export const AGENT_ROLE_TOOL_ALLOWLIST: Record<
  AgentRole,
  readonly string[]
> = {
  insight: [
    "list_jobs",
    "get_job",
    "read_webpage",
    "get_resume",
    "review_resume",
    "match_job",
    "notion_search",
    "notion_read",
    "feishu_search_docs",
    "feishu_read_doc",
    "today_plan_read",
    "today_plan",
    "suggest_role",
  ],
  pilot: [
    "list_jobs",
    "get_job",
    "read_webpage",
    "add_job",
    "notion_search",
    "notion_read",
    "notion_create_page",
    "notion_append_content",
    "notion_update_record",
    "notion_update_content",
    "notion_delete_pages",
    "feishu_search_docs",
    "feishu_read_doc",
    "feishu_create_doc",
    "feishu_append_content",
    "feishu_update_content",
    "today_plan_read",
    "today_plan",
    "suggest_role",
  ],
  reflect: [
    "list_jobs",
    "get_job",
    "read_webpage",
    "notion_search",
    "notion_read",
    "feishu_search_docs",
    "feishu_read_doc",
    "today_plan_read",
    "today_plan",
    "suggest_role",
  ],
};
