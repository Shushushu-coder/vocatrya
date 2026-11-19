import { NOTION_ALL_TOOL_NAMES } from "@/lib/extensions/notion/constants";
import { AGENT_ROLE_TOOL_ALLOWLIST, normalizeAgentRole } from "./agentRoles";

const NOTION_CONFIRM_WRITES = ["notion_create_page", "notion_append_content", "notion_update_record", "notion_delete_pages"];

export function effectiveAgentToolNames(input: { agentRole?: string | null; freshNativeFull?: boolean; notionTools?: readonly string[] }) {
  const role = normalizeAgentRole(input.agentRole);
  const notion = new Set<string>(NOTION_ALL_TOOL_NAMES);
  const names = ["add_job", "list_jobs", "get_job", "read_webpage", "get_resume", "review_resume", "match_job",
    ...(input.freshNativeFull ? [] : ["generate_cover_letter"]),
    ...(input.notionTools ?? []).filter(name => notion.has(name)),
    // A sibling handoff only exists where there are siblings to hand to —
    // the general assistant registers the full registry instead.
    ...(role ? ["suggest_role"] : []),
  ];
  return names.filter(name => !role || AGENT_ROLE_TOOL_ALLOWLIST[role].includes(name));
}

export function agentToolApproval(name: string, freshNativeFull: boolean, mode: import("./preferences").PermissionMode = "ask"): "always" | "conditional" | "none" {
  // Body edits apply immediately. Page deletion keeps a card in every mode, including full.
  if (name === "notion_update_content") return "none";
  if (mode === "full" && ["add_job", "match_job", "notion_create_page", "notion_append_content", "notion_update_record"].includes(name)) return "none";
  if (mode === "rules" && ["add_job", "match_job"].includes(name)) return "none";
  if (NOTION_CONFIRM_WRITES.includes(name) || (name === "match_job" && freshNativeFull)) return "always";
  return name === "add_job" ? "conditional" : "none";
}
