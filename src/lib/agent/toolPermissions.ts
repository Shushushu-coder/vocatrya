import { AGENT_ROLE_TOOL_ALLOWLIST, normalizeAgentRole } from "./agentRoles";

export function effectiveAgentToolNames(input: { agentRole?: string | null; freshNativeFull?: boolean; notionTools?: readonly string[] }) {
  const names = ["add_job", "list_jobs", "get_job", "get_resume", "review_resume", "match_job",
    ...(input.freshNativeFull ? [] : ["generate_cover_letter"]),
    ...(input.notionTools ?? []).filter(name => ["notion_search", "notion_read", "notion_create_page", "notion_append_content", "notion_update_record"].includes(name)),
  ];
  const role = normalizeAgentRole(input.agentRole);
  return names.filter(name => !role || AGENT_ROLE_TOOL_ALLOWLIST[role].includes(name));
}

export function agentToolApproval(name: string, freshNativeFull: boolean): "always" | "conditional" | "none" {
  if (["notion_create_page", "notion_append_content", "notion_update_record"].includes(name) || (name === "match_job" && freshNativeFull)) return "always";
  return name === "add_job" ? "conditional" : "none";
}
