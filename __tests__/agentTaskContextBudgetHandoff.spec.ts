import type { UIMessage } from "ai";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  CAREER_DIALOGUE_CONTEXT_BUDGETS,
  buildCareerDialogueContext,
  careerDialogueContextLogFields,
  estimateContextTokens,
  type CareerDialogueContextInput,
} from "@/lib/agent/contextBudget";
import golden from "./fixtures/contextBudgetNonTaskGolden.json";
import { NON_TASK_INVARIANCE_CASES } from "./helpers/contextBudgetInvarianceInputs";

const HANDOFF = "Active task state (system-maintained):\nTask: 面试冲刺 · milestone=PRACTICING";

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}
function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] } as UIMessage;
}
function history(count: number, pad = 60): UIMessage[] {
  const out: UIMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push(user(`u${i}`, `goal ${i} ${"x".repeat(pad)}`), assistant(`a${i}`, `reply ${i} ${"y".repeat(pad)}`));
  }
  return out;
}

function ok(input: CareerDialogueContextInput) {
  const result = buildCareerDialogueContext(input);
  if (!result.ok) throw new Error(result.code);
  return result;
}

describe("non-task conversations are byte-for-byte unchanged", () => {
  const NEW_SIZE_KEYS = ["handoffChars", "handoffTokens", "handoffDropped"] as const;

  function withoutHandoffSize(result: ReturnType<typeof ok>) {
    const size: Record<string, unknown> = { ...result.size };
    for (const key of NEW_SIZE_KEYS) delete size[key];
    return { ...result, size };
  }

  for (const [name, input] of Object.entries(NON_TASK_INVARIANCE_CASES)) {
    const expected = (golden as Record<string, unknown>)[name];

    it(`${name}: matches the output of the pre-handoff implementation`, () => {
      const actual = ok(input);
      expect(withoutHandoffSize(actual)).toEqual(expected);
      expect(actual.size.handoffChars).toBe(0);
      expect(actual.size.handoffTokens).toBe(0);
      expect(actual.size.handoffDropped).toBe(false);
    });

    it(`${name}: a handoff line without agentTaskId is ignored entirely`, () => {
      for (const agentTaskId of [undefined, null, ""]) {
        const actual = ok({ ...input, agentTaskId, handoffLine: HANDOFF });
        expect(withoutHandoffSize(actual)).toEqual(expected);
        expect(actual.transcript).not.toContain("Active task state");
        expect(actual.size.handoffDropped).toBe(false);
      }
    });

    it(`${name}: a task id with no handoff line changes nothing`, () => {
      for (const handoffLine of [undefined, "", "   \n"]) {
        const actual = ok({ ...input, agentTaskId: "task-1", handoffLine });
        expect(withoutHandoffSize(actual)).toEqual(expected);
      }
    });

    it(`${name}: log fields keep their pre-handoff shape`, () => {
      const fields = careerDialogueContextLogFields(ok(input).size);
      expect(Object.keys(fields)).not.toContain("handoffUnits");
      expect(Object.keys(fields)).not.toContain("handoffDropped");
    });
  }
});

describe("task session handoff line", () => {
  it("is included after the summary and before history", () => {
    const result = ok({
      profile: "FAST_CHAT",
      messages: [...history(2), user("cur", "go on")],
      summary: "EARLY_SUMMARY",
      agentTaskId: "task-1",
      handoffLine: HANDOFF,
    });
    const t = result.transcript;
    expect(t).toContain(HANDOFF);
    expect(t.indexOf("Earlier conversation summary")).toBeLessThan(t.indexOf(HANDOFF));
    expect(t.indexOf(HANDOFF)).toBeLessThan(t.indexOf("User: goal 0"));
    expect(result.size.handoffChars).toBe(HANDOFF.length);
    expect(result.size.handoffTokens).toBe(estimateContextTokens(HANDOFF));
    expect(result.size.handoffDropped).toBe(false);
  });

  it("is visible in all three profiles", () => {
    for (const profile of ["FAST_CHAT", "AGENT_DECISION", "AGENT_RESPONSE"] as const) {
      const result = ok({
        profile,
        messages: [user("cur", "go on")],
        agentTaskId: "task-1",
        handoffLine: HANDOFF,
      });
      expect(result.transcript).toContain(HANDOFF);
    }
  });

  it("survives drops that remove the summary, tools and history", () => {
    const messages = [...history(10, 120), user("cur", "continue")];
    const pressured = ok({
      profile: "AGENT_RESPONSE",
      messages,
      summary: "SUMMARY_TEXT",
      budgets: { dynamicTokens: 35 },
      agentTaskId: "task-1",
      handoffLine: HANDOFF,
    });
    expect(pressured.transcript).toContain(HANDOFF);
    expect(pressured.summary).toBeUndefined();
    expect(pressured.size.droppedTurnCount).toBeGreaterThan(0);
  });

  it("is kept even when the budget cannot be met without it", () => {
    const result = ok({
      profile: "AGENT_RESPONSE",
      messages: [...history(6, 80), user("cur", "continue")],
      budgets: { dynamicTokens: 1 },
      agentTaskId: "task-1",
      handoffLine: HANDOFF,
    });
    expect(result.transcript).toContain(HANDOFF);
    expect(result.retainedMessages.at(-1)?.id).toBe("cur");
  });

  it("counts toward the assembled budget (other content yields to it)", () => {
    const base = {
      profile: "AGENT_RESPONSE" as const,
      messages: [...history(6, 80), user("cur", "continue")],
      budgets: { dynamicTokens: 400 },
    };
    const without = ok(base);
    const withHandoff = ok({ ...base, agentTaskId: "task-1", handoffLine: HANDOFF.repeat(8) });
    expect(withHandoff.size.dynamicTokens).toBeGreaterThanOrEqual(withHandoff.size.handoffTokens);
    expect(withHandoff.size.recentTurnCount).toBeLessThanOrEqual(without.size.recentTurnCount);
  });

  it("drops an over-budget line whole and reports it", () => {
    const huge = "z".repeat(
      CAREER_DIALOGUE_CONTEXT_BUDGETS.handoffTokens * APP_CONSTANTS.AGENT_CHAT_CHARS_PER_TOKEN + 40,
    );
    const result = ok({
      profile: "FAST_CHAT",
      messages: [user("cur", "go on")],
      agentTaskId: "task-1",
      handoffLine: huge,
    });
    expect(result.transcript).not.toContain("zzzz");
    expect(result.size.handoffDropped).toBe(true);
    expect(result.size.handoffTokens).toBe(0);
    expect(careerDialogueContextLogFields(result.size)).toMatchObject({
      handoffUnits: 0,
      handoffDropped: 1,
    });
  });

  it("reports handoff units in the log fields", () => {
    const result = ok({
      profile: "FAST_CHAT",
      messages: [user("cur", "go on")],
      agentTaskId: "task-1",
      handoffLine: HANDOFF,
    });
    expect(careerDialogueContextLogFields(result.size)).toMatchObject({
      handoffUnits: estimateContextTokens(HANDOFF),
      handoffDropped: 0,
    });
  });

  it("budget constant is wired to the shared constant", () => {
    expect(CAREER_DIALOGUE_CONTEXT_BUDGETS.handoffTokens).toBe(
      APP_CONSTANTS.AGENT_TASK_HANDOFF_TOKENS,
    );
  });
});
