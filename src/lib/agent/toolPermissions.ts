import { AGENT_ROLE_TOOL_ALLOWLIST, normalizeAgentRole } from "./agentRoles";

export function effectiveAgentToolNames(input: { agentRole?: string | null; freshNativeFull?: boolean; notionTools?: readonly string[] }) {
  const role = normalizeAgentRole(input.agentRole);
  const names = ["add_job", "list_jobs", "get_job", "get_resume", "review_resume", "match_job",
    ...(input.freshNativeFull ? [] : ["generate_cover_letter"]),
    ...(input.notionTools ?? []).filter(name => ["notion_search", "notion_read", "notion_create_page", "notion_append_content", "notion_update_record"].includes(name)),
    // A sibling handoff only exists where there are siblings to hand to —
    // the general assistant registers the full registry instead.
    ...(role ? ["suggest_role"] : []),
  ];
  return names.filter(name => !role || AGENT_ROLE_TOOL_ALLOWLIST[role].includes(name));
}

export function agentToolApproval(name: string, freshNativeFull: boolean, mode: import("./preferences").PermissionMode = "ask"): "always" | "conditional" | "none" {
  if (mode === "full" && ["add_job", "match_job", "notion_create_page", "notion_append_content", "notion_update_record"].includes(name)) return "none";
  if (mode === "rules" && ["add_job", "match_job"].includes(name)) return "none";
  if (["notion_create_page", "notion_append_content", "notion_update_record"].includes(name) || (name === "match_job" && freshNativeFull)) return "always";
  return name === "add_job" ? "conditional" : "none";
}
