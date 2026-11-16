import { effectiveAgentToolNames, agentToolApproval } from "@/lib/agent/toolPermissions";
it("intersects role, runtime and extension availability", () => {
  expect(effectiveAgentToolNames({ agentRole: "reflect", freshNativeFull: true, notionTools: ["notion_read", "notion_create_page"] })).toEqual(["list_jobs", "get_job", "notion_read"]);
  expect(effectiveAgentToolNames({ agentRole: null, freshNativeFull: true })).not.toContain("generate_cover_letter");
  expect(effectiveAgentToolNames({ agentRole: "pilot", notionTools: [] })).not.toContain("notion_read");
});
it("describes conditional local and mandatory external approvals accurately", () => {
  expect(agentToolApproval("add_job", true)).toBe("conditional");
  expect(agentToolApproval("match_job", true)).toBe("always");
  expect(agentToolApproval("match_job", false)).toBe("none");
  expect(agentToolApproval("notion_create_page", false)).toBe("always");
});
