import { tool } from "ai";
import { AGENT_TOOL_DESCRIPTIONS } from "@/lib/agent/prompt";
import { AgentSuggestRoleSchema } from "@/models/agent.schema";
import type { AgentSuggestRoleResult } from "@/models/agent.model";

// A UI-only handoff signal: execute just echoes the call so the part lands
// as output-available, and the result card renders the one-tap transfer.
// It touches no data — it is not a write, needs no approval, and is never
// registered for the general (NULL-role) assistant.
export function buildSuggestRoleTool() {
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.suggest_role,
    inputSchema: AgentSuggestRoleSchema,
    execute: async (input): Promise<AgentSuggestRoleResult> => ({
      role: input.role,
      question: input.question,
    }),
  });
}
