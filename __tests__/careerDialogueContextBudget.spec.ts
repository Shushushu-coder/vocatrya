import type { UIMessage } from "ai";
import { APP_CONSTANTS } from "@/lib/constants";
import { windowMessages } from "@/lib/agent/paste";
import {
  CAREER_DIALOGUE_CONTEXT_BUDGETS,
  buildCareerDialogueContext,
  estimateContextTokens,
  projectToolOutput,
  type CareerDialogueContextBudgets,
} from "@/lib/agent/contextBudget";

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistant(id: string, text: string, extra: UIMessage["parts"] = []): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }, ...extra],
  } as UIMessage;
}

function pair(index: number, userText: string, assistantText: string): UIMessage[] {
  return [user(`u${index}`, userText), assistant(`a${index}`, assistantText)];
}

function longConversation(label: (index: number) => string): UIMessage[] {
  const messages: UIMessage[] = [];
  for (let i = 0; i < 20; i++) {
    const size = 20 + (i % 5) * 15;
    messages.push(
      ...pair(i, `${label(i)} ${"x".repeat(size)}`, `${label(i)} reply ${"y".repeat(size)}`),
    );
  }
  messages.push(user("current", `${label(20)} current request`));
  return messages;
}

function linesOf(transcript: string): string[] {
  return transcript.split("\n").filter(Boolean);
}

function assertNoOrphans(transcript: string) {
  let openUser = false;
  for (const line of linesOf(transcript)) {
    if (line.startsWith("User: ")) {
      openUser = true;
      continue;
    }
    if (line.startsWith("Assistant: ") || line.startsWith("Tool ") || line.startsWith("The user ")) {
      expect(openUser).toBe(true);
    }
    if (line.startsWith("<page-context>") || line.startsWith("Earlier conversation")) {
      openUser = false;
    }
  }
}

const wide: Partial<CareerDialogueContextBudgets> = {
  dynamicTokens: 100_000,
  assembledInputTokens: 100_000,
  explicitContextTokens: 2_000,
  historicalToolTokens: 2_000,
  summaryTokens: 1_000,
};

describe("career dialogue context budget", () => {
  it("keeps the current request and the newest complete turns for zh-CN and English", () => {
    for (const label of [
      (i: number) => `第${i}轮中文`,
      (i: number) => `turn ${i} english`,
    ]) {
      const messages = longConversation(label);
      const first = buildCareerDialogueContext({
        profile: "FAST_CHAT",
        messages,
        pageContext: { route: "/dashboard" },
      });
      const second = buildCareerDialogueContext({
        profile: "FAST_CHAT",
        messages,
        pageContext: { route: "/dashboard" },
      });
      expect(first).toEqual(second);
      if (!first.ok) throw new Error(first.code);
      expect(first.transcript).toContain(`${label(20)} current request`);
      expect(first.transcript).toContain(label(19));
      expect(first.transcript).not.toContain(label(0));
      expect(first.size.recentTurnCount).toBeLessThanOrEqual(
        CAREER_DIALOGUE_CONTEXT_BUDGETS.maxRecentTurns,
      );
      expect(first.size.recentTurnCount).toBe(6);
      expect(first.size.droppedTurnCount).toBe(14);
      expect(first.size.dynamicTokens).toBeLessThanOrEqual(
        CAREER_DIALOGUE_CONTEXT_BUDGETS.dynamicTokens,
      );
      expect(first.transcript).not.toContain("arguments JSON schema");
      expect(first.transcript).not.toContain("Your ONLY output is one JSON object");
      assertNoOrphans(first.transcript);
    }
  });

  it("drops the oldest complete turn at the history boundary", () => {
    const small = "ok";
    const old = `OLD_TURN ${"q".repeat(400)}`;
    const messages = [
      ...pair(0, old, old),
      ...pair(1, small, small),
      ...pair(2, small, small),
      user("current", "CURRENT_REQUEST"),
    ];
    const newestTwo = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages: [...pair(1, small, small), ...pair(2, small, small), user("current", "CURRENT_REQUEST")],
      budgets: { ...wide, historyTokens: 10_000 },
    });
    if (!newestTwo.ok) throw new Error("probe failed");
    const exactBudget = newestTwo.size.historyTokens;
    const exact = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages,
      budgets: { ...wide, historyTokens: exactBudget },
    });
    const over = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages,
      budgets: { ...wide, historyTokens: exactBudget - 1 },
    });
    const under = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages,
      budgets: { ...wide, historyTokens: exactBudget + 5_000 },
    });
    if (!exact.ok || !over.ok || !under.ok) throw new Error("boundary failed");
    expect(exact.transcript).toContain("CURRENT_REQUEST");
    expect(exact.transcript).toContain(small);
    expect(exact.transcript).not.toContain("OLD_TURN");
    expect(exact.size.historyTokens).toBe(exactBudget);
    expect(over.transcript).not.toContain("OLD_TURN");
    expect(over.size.historyTokens).toBeLessThan(exactBudget);
    expect(under.transcript).toContain("OLD_TURN");
    expect(under.transcript).toContain("CURRENT_REQUEST");
  });

  it("keeps explicit job context and drops stale turns under budget pressure", () => {
    const stale = "STALE_TRANSCRIPT_ALPHA " + "旧".repeat(200);
    const messages = [
      ...pair(0, stale, stale),
      ...pair(1, "STALE_TRANSCRIPT_BETA " + "旧".repeat(200), "stale reply"),
      user("current", "这个岗位要求什么"),
    ];
    const result = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages,
      pageContext: { jobId: "job-1", route: "/dashboard/myjobs/job-1" },
      budgets: {
        ...wide,
        dynamicTokens: 180,
        historyTokens: 3_000,
      },
    });
    if (!result.ok) throw new Error(result.code);
    expect(result.transcript).toContain("viewing a specific job's page");
    expect(result.transcript).toContain("这个岗位要求什么");
    expect(result.transcript).not.toContain("STALE_TRANSCRIPT_ALPHA");
    expect(result.transcript).not.toContain("job-1");
    expect(result.size.explicitContextTokens).toBeGreaterThan(0);
    expect(result.size.droppedTurnCount).toBe(2);
  });

  it("keeps the current tool result and drops older history under budget pressure", () => {
    const messages = [
      ...pair(0, "OLD_HISTORY_MARKER " + "旧".repeat(400), "old reply"),
      user("current", "请根据结果回答"),
    ];
    const result = buildCareerDialogueContext({
      profile: "AGENT_RESPONSE",
      messages,
      sessionFacts: [
        {
          name: "get_resume",
          output: { status: "ok", resumeId: "secret-resume", title: "Main", resumeText: "CURRENT_TOOL_MARKER" },
        },
      ],
      budgets: { ...wide, dynamicTokens: 80, historyTokens: 3_000 },
    });
    if (!result.ok) throw new Error(result.code);
    expect(result.transcript).toContain("CURRENT_TOOL_MARKER");
    expect(result.transcript).toContain("请根据结果回答");
    expect(result.transcript).not.toContain("OLD_HISTORY_MARKER");
    expect(result.transcript).not.toContain("secret-resume");
    expect(result.size.toolResultTokens).toBeGreaterThan(0);
  });

  it("does not slice an oversized current user message", () => {
    const huge = "Z".repeat(
      (CAREER_DIALOGUE_CONTEXT_BUDGETS.currentUserTokens + 10) *
        APP_CONSTANTS.AGENT_CHAT_CHARS_PER_TOKEN,
    );
    const result = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages: [user("current", huge)],
    });
    expect(result).toEqual({ ok: false, code: "INPUT_TOO_LARGE" });
  });

  it("uses an existing summary and drops one that exceeds its budget", () => {
    const messages = [user("current", "hi")];
    const kept = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages,
      summary: "已有摘要",
    });
    const dropped = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages,
      summary: "摘".repeat(CAREER_DIALOGUE_CONTEXT_BUDGETS.summaryTokens + 5),
    });
    if (!kept.ok || !dropped.ok) throw new Error("summary budget failed");
    expect(kept.summary).toBe("已有摘要");
    expect(kept.transcript).toContain("已有摘要");
    expect(kept.size.summaryTokens).toBeGreaterThan(0);
    expect(dropped.summary).toBeUndefined();
    expect(dropped.transcript).not.toContain("Earlier conversation summary");
    expect(dropped.size.summaryTokens).toBe(0);
  });

  it("preserves approval arguments when older turns are over budget", () => {
    const messages: UIMessage[] = [
      ...pair(0, "STALE_BEFORE_APPROVAL " + "旧".repeat(400), "stale"),
      user("origin", "保存这个岗位"),
      {
        id: "approval",
        role: "assistant",
        parts: [
          {
            type: "tool-add_job",
            toolCallId: "call-1",
            state: "approval-responded",
            input: { company: "Acme", jobTitle: "Engineer" },
            approval: { id: "a1", approved: true },
          },
        ],
      } as UIMessage,
    ];
    const result = buildCareerDialogueContext({
      profile: "AGENT_DECISION",
      messages,
      budgets: { ...wide, dynamicTokens: 80, historyTokens: 3_000 },
    });
    if (!result.ok) throw new Error(result.code);
    expect(result.transcript).toContain("保存这个岗位");
    expect(result.transcript).toContain("Acme");
    expect(result.transcript).toContain("Engineer");
    expect(result.transcript).toContain("approved");
    expect(result.transcript).not.toContain("STALE_BEFORE_APPROVAL");
    expect(result.size.recentTurnCount).toBeLessThanOrEqual(
      CAREER_DIALOGUE_CONTEXT_BUDGETS.maxRecentTurns,
    );
  });

  it("keeps tool bodies for the answer and compacts them for the decision", () => {
    const output = {
      status: "ok",
      resumeId: "r-1",
      title: "Main",
      resumeText: "FULL_RESUME_BODY",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(projectToolOutput(output, "AGENT_DECISION")).toEqual({
      contentChars: "FULL_RESUME_BODY".length,
      status: "ok",
      title: "Main",
    });
    expect(projectToolOutput(output, "AGENT_RESPONSE")).toEqual({
      resumeText: "FULL_RESUME_BODY",
      status: "ok",
      title: "Main",
    });
  });

  it("estimates CJK denser than the same number of latin characters", () => {
    const latin = estimateContextTokens("a".repeat(40));
    const cjk = estimateContextTokens("中".repeat(40));
    expect(latin).toBe(10);
    expect(cjk).toBe(40);
  });

  it("measures a 20-turn fast-chat payload against the previous window", () => {
    const messages = longConversation((i) => `probe ${i}`);
    const windowed = windowMessages(messages);
    const beforeLines: string[] = [];
    for (const message of windowed) {
      const text = (message.parts ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text) {
        beforeLines.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
      }
    }
    const beforeKept: string[] = [];
    let beforeChars = 0;
    for (let i = beforeLines.length - 1; i >= 0; i--) {
      const line = beforeLines[i] ?? "";
      beforeChars += line.length + 1;
      if (beforeChars > 20_000 && beforeKept.length) break;
      beforeKept.unshift(line);
    }
    const beforeTranscript = beforeKept.join("\n");
    const after = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages,
    });
    if (!after.ok) throw new Error(after.code);
    const decision = buildCareerDialogueContext({
      profile: "AGENT_DECISION",
      messages,
      sessionFacts: [{ name: "get_resume", output: { status: "ok", title: "Main", resumeText: "BODY" } }],
    });
    if (!decision.ok) throw new Error(decision.code);
    const report = {
      beforeChars: beforeTranscript.length,
      beforeMessages: windowed.length,
      beforeTokens: estimateContextTokens(beforeTranscript),
      afterChars: after.transcript.length,
      afterTurns: after.size.recentTurnCount,
      afterTokens: after.size.dynamicTokens,
      decisionChars: decision.transcript.length,
      decisionTokens: decision.size.dynamicTokens,
    };
    expect(report.afterTurns).toBeLessThanOrEqual(6);
    expect(report.afterChars).toBeLessThan(report.beforeChars);
    expect(report.decisionTokens).toBeLessThanOrEqual(
      CAREER_DIALOGUE_CONTEXT_BUDGETS.dynamicTokens,
    );
    const fat: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      fat.push(user(`fu${i}`, `fat user ${i}`));
      fat.push({
        id: `fa${i}`,
        role: "assistant",
        parts: [
          {
            type: "tool-get_resume",
            toolCallId: `c${i}`,
            state: "output-available",
            input: {},
            output: { status: "ok", resumeId: `id-${i}`, resumeText: "R".repeat(2000) },
          },
        ],
      } as UIMessage);
    }
    fat.push(user("current", "current fat request"));
    const fatWindow = windowMessages(fat);
    const fatBeforeLines: string[] = [];
    for (const message of fatWindow) {
      for (const part of message.parts ?? []) {
        if (part.type === "text" && part.text) {
          fatBeforeLines.push(`${message.role === "user" ? "User" : "Assistant"}: ${part.text}`);
        }
        if (part.type === "tool-get_resume" && "output" in part) {
          fatBeforeLines.push(`Tool get_resume returned: ${JSON.stringify(part.output)}`);
        }
      }
    }
    const fatBeforeKept: string[] = [];
    let fatChars = 0;
    for (let i = fatBeforeLines.length - 1; i >= 0; i--) {
      const line = fatBeforeLines[i] ?? "";
      fatChars += line.length + 1;
      if (fatChars > 20_000 && fatBeforeKept.length) break;
      fatBeforeKept.unshift(line);
    }
    const fatAfter = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages: fat,
    });
    if (!fatAfter.ok) throw new Error(fatAfter.code);
    const fatReport = {
      beforeChars: fatBeforeKept.join("\n").length,
      beforeMessages: fatWindow.length,
      beforeToolDumps: fatBeforeKept.filter((line) => line.startsWith("Tool ")).length,
      afterChars: fatAfter.transcript.length,
      afterTurns: fatAfter.size.recentTurnCount,
      afterToolUnits: fatAfter.size.toolResultTokens,
    };
    expect(fatReport.afterChars).toBeLessThan(fatReport.beforeChars);
    expect(fatReport.beforeToolDumps).toBeGreaterThan(fatReport.afterTurns);
  });
});
