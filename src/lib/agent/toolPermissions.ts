import { NOTION_ALL_TOOL_NAMES } from "@/lib/extensions/notion/constants";
import { AGENT_ROLE_TOOL_ALLOWLIST, normalizeAgentRole } from "./agentRoles";

const NOTION_CONFIRM_WRITES = ["notion_create_page", "notion_append_content", "notion_update_record", "notion_delete_pages"];

/**
 * `taskExtraTools` is the output of resolveTaskSessionTools (task/agentTaskTools.ts):
 * non-empty only for a Pilot conversation bound to an ACTIVE owned task. It can
 * only re-admit tools the runtime already registers (the base list below), and
 * only for Pilot; every other role/conversation is filtered exactly as before.
 */
export function effectiveAgentToolNames(input: { agentRole?: string | null; freshNativeFull?: boolean; notionTools?: readonly string[]; taskExtraTools?: readonly string[] | null }) {
  const role = normalizeAgentRole(input.agentRole);
  const notion = new Set<string>(NOTION_ALL_TOOL_NAMES);
  const names = ["add_job", "list_jobs", "get_job", "read_webpage", "get_resume", "review_resume", "match_job",
    "today_plan_read", "today_plan",
    ...(input.freshNativeFull ? [] : ["generate_cover_letter"]),
    ...(input.notionTools ?? []).filter(name => notion.has(name)),
    // A sibling handoff only exists where there are siblings to hand to —
    // the general assistant registers the full registry instead.
    ...(role ? ["suggest_role"] : []),
  ];
  const extra = role === "pilot" ? input.taskExtraTools ?? [] : [];
  return names.filter(name => !role || AGENT_ROLE_TOOL_ALLOWLIST[role].includes(name) || extra.includes(name));
}

export function agentToolApproval(name: string, freshNativeFull: boolean, mode: import("./preferences").PermissionMode = "ask"): "always" | "conditional" | "none" {
  // Body edits apply immediately. Page deletion keeps a card in every mode, including full.
  if (name === "notion_update_content") return "none";
  // Canonical match_job's gate is constant in every mode (contract D3): the
  // durable execution binds to the admitted approval turn — no mode lifts it.
  if (name === "match_job" && freshNativeFull) return "always";
  if (mode === "full" && ["add_job", "match_job", "notion_create_page", "notion_append_content", "notion_update_record"].includes(name)) return "none";
  if (mode === "rules" && ["add_job", "match_job"].includes(name)) return "none";
  if (NOTION_CONFIRM_WRITES.includes(name)) return "always";
  // today_plan is input-conditional like add_job: only the "suggest" action
  // raises the adopt-plan card, and it keeps that gate in every mode.
  return name === "add_job" || name === "today_plan" ? "conditional" : "none";
}
