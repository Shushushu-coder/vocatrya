export const AGENT_TOOL_LABEL_KEYS = {
  add_job: "agent.tools.addJob",
  list_jobs: "agent.tools.listJobs",
  get_job: "agent.tools.getJob",
  get_resume: "agent.tools.getResume",
  review_resume: "agent.tools.reviewResume",
  match_job: "agent.tools.matchJob",
  generate_cover_letter: "agent.tools.coverLetter",
} as const;

export type AgentToolLabelKey =
  (typeof AGENT_TOOL_LABEL_KEYS)[keyof typeof AGENT_TOOL_LABEL_KEYS];

export function agentToolLabelKey(toolName: string): AgentToolLabelKey | null {
  return (
    AGENT_TOOL_LABEL_KEYS[toolName as keyof typeof AGENT_TOOL_LABEL_KEYS] ??
    null
  );
}
