import { tool } from "ai";
import { AGENT_TOOL_DESCRIPTIONS } from "@/lib/agent/prompt";
import { getJobForAgent } from "@/lib/agent/canonicalJobRead";
import { AgentGetJobSchema } from "@/models/agent.schema";
import { log } from "@/lib/telemetry";
import type { AgentGetJobResult } from "@/models/agent.model";

export function buildGetJobTool(userId: string, pageJobId?: string) {
  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.get_job,
    inputSchema: AgentGetJobSchema,
    execute: async (raw): Promise<AgentGetJobResult> => {
      try {
        const requested = raw?.jobId?.trim() || pageJobId;
        return await getJobForAgent(userId, requested);
      } catch (error) {
        log.error("[agent-chat] get_job failed", { error: String(error) });
        return {
          status: "unavailable",
          reason: "Reading that job failed. Try again, or open it from My Jobs.",
        };
      }
    },
  });
}
