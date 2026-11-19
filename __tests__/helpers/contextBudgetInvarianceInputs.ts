import type { UIMessage } from "ai";
import type { CareerDialogueContextInput } from "@/lib/agent/contextBudget";

/**
 * Representative non-task inputs for the handoff regression proof. The golden
 * file (fixtures/contextBudgetNonTaskGolden.json) was produced by the
 * pre-handoff contextBudget.ts from exactly these inputs.
 */
function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistant(id: string, text: string, extra: UIMessage["parts"] = []): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }, ...extra] } as UIMessage;
}

function pairs(count: number, pad: number): UIMessage[] {
  const out: UIMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      user(`u${i}`, `goal ${i} ${"x".repeat(pad)}`),
      assistant(`a${i}`, `answer ${i} ${"y".repeat(pad)}`),
    );
  }
  return out;
}

const toolTurn: UIMessage[] = [
  user("tu0", "list my jobs"),
  assistant("ta0", "Here they are", [
    {
      type: "tool-list_jobs",
      toolCallId: "c1",
      state: "output-available",
      input: {},
      output: { jobs: [{ id: "job-1", title: "Engineer", company: "Acme", createdAt: "x" }] },
    } as never,
  ]),
];

export const NON_TASK_INVARIANCE_CASES: Record<string, CareerDialogueContextInput> = {
  plainFastChat: {
    profile: "FAST_CHAT",
    messages: [...pairs(4, 30), user("cur", "what next?")],
    fixedOverheadText: "FIXED INSTRUCTIONS",
    systemText: "SYSTEM",
  },
  decisionWithTools: {
    profile: "AGENT_DECISION",
    messages: [...toolTurn, user("cur", "open the first one")],
    pageContext: { route: "/dashboard/myjobs" },
    agentRole: "pilot",
  },
  summaryAndPaste: {
    profile: "AGENT_RESPONSE",
    messages: [...pairs(8, 40), user("cur", "summarize")],
    summary: { text: "EARLY_FACT_001", throughMessageId: "a1" },
    pasteBlock: "Senior Engineer at Acme. Remote.",
    fileBlocks: [{ name: "cv.pdf", block: "FILE BODY" }],
  },
  pressuredDrops: {
    profile: "AGENT_RESPONSE",
    messages: [...pairs(10, 100), user("cur", "continue")],
    summary: "plain summary text",
    budgets: { dynamicTokens: 250 },
    sessionFacts: [{ name: "match_job", output: { score: 88, id: "m1" } }],
  },
  cjkHistory: {
    profile: "FAST_CHAT",
    messages: [
      user("u0", "我想准备字节跳动的前端面试"),
      assistant("a0", "好的，先从项目经历开始。"),
      user("cur", "继续"),
    ],
  },
};
