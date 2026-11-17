// @vitest-environment node
import { DEFAULT_AGENT_PREFERENCES, PERSONAL_INSTRUCTIONS_MAX, readAgentPreferences, validateAgentPreferences, permissionModeOfContext, personalInstructionsBlock } from "@/lib/agent/preferences";
import { agentToolApproval } from "@/lib/agent/toolPermissions";
import { parseConversationContext, serializeConversationContext } from "@/lib/agent/conversationContext";
import { prepareSettingsPatch } from "@/lib/userSettings/patch";

describe("Agent preferences and creation-time permission contract", () => {
  it("uses defaults only for new preferences, preserving historical conversation approvals", () => {
    expect(readAgentPreferences(null)).toEqual(DEFAULT_AGENT_PREFERENCES);
    expect(permissionModeOfContext(null)).toBe("ask");
    expect(permissionModeOfContext('{"permissionMode":"unlimited"}')).toBe("ask");
    expect(permissionModeOfContext('{"version":2,"items":[],"permissionMode":"full"}')).toBe("ask");
  });
  it("validates Unicode characters without silently truncating or accepting oversized prompts", () => {
    expect(validateAgentPreferences({ ...DEFAULT_AGENT_PREFERENCES, personalInstructions: "😀".repeat(PERSONAL_INSTRUCTIONS_MAX) })).toBe(true);
    expect(validateAgentPreferences({ ...DEFAULT_AGENT_PREFERENCES, personalInstructions: "中".repeat(PERSONAL_INSTRUCTIONS_MAX + 1) })).toBe(false);
    expect(validateAgentPreferences({ ...DEFAULT_AGENT_PREFERENCES, defaultPermission: "unlimited" })).toBe(false);
    expect(validateAgentPreferences({ ...DEFAULT_AGENT_PREFERENCES, autoArchiveDays: 1 })).toBe(false);
    expect(prepareSettingsPatch({ settings: { general: { agent: { ...DEFAULT_AGENT_PREFERENCES, defaultPermission: "bad" } } } }).ok).toBe(false);
  });
  it("persists the fixed permission next to independently replaceable context items", () => {
    const raw = serializeConversationContext({ version: 1, items: [], permissionMode: "full" });
    expect(parseConversationContext(raw).permissionMode).toBe("full");
    expect(permissionModeOfContext(raw)).toBe("full");
  });
  it("auto-approves only known local business writes in rules mode", () => {
    expect(agentToolApproval("add_job", true, "ask")).toBe("conditional");
    expect(agentToolApproval("add_job", true, "rules")).toBe("none");
    expect(agentToolApproval("match_job", true, "rules")).toBe("none");
    expect(agentToolApproval("notion_create_page", true, "rules")).toBe("always");
    expect(agentToolApproval("notion_create_page", true, "full")).toBe("none");
    expect(agentToolApproval("future_unknown_write", true, "rules")).toBe("none"); // Not registered; no capability is added.
  });
  it("empty personal instructions disable injection; nonempty ones are labelled as preferences", () => {
    expect(personalInstructionsBlock("  ")).toBe("");
    expect(personalInstructionsBlock("请简洁回答")).toContain("请简洁回答");
    expect(personalInstructionsBlock("请简洁回答")).toContain("within application permissions");
  });
});
