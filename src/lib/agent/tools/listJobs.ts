import { tool } from "ai";
import { AGENT_TOOL_DESCRIPTIONS } from "@/lib/agent/prompt";
import { listJobsForAgent } from "@/lib/agent/canonicalJobRead";
import { AgentListJobsSchema } from "@/models/agent.schema";
import { log } from "@/lib/telemetry";
import type { AgentListJobsResult } from "@/models/agent.model";

export function buildListJobsTool(userId: string) {
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.list_jobs,
    inputSchema: AgentListJobsSchema,
    execute: async (): Promise<AgentListJobsResult> => {
      try {
        return await listJobsForAgent(userId);
      } catch (error) {
        log.error("[agent-chat] list_jobs failed", { error: String(error) });
        return {
          status: "unavailable",
          reason: "Listing jobs failed. Try again, or open My Jobs.",
        };
      }
    },
  });
}
