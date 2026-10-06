import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { UIMessage } from "ai";
import {
  buildCareerDialogueContext,
  CAREER_DIALOGUE_CONTEXT_BUDGETS,
  estimateContextTokens,
} from "@/lib/agent/contextBudget";
import {
  canonicalizeSummaryCoverageMessage,
  hashSummaryCoverage,
  selectConversationSummaryCoverage,
  summaryBoundaryUnderStoragePressure,
  validateConversationSummaryCoverage,
} from "@/lib/agent/conversationSummaryCoverage";
import {
  buildCareerDialogueSummaryPrompt,
  CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
  projectConversationSummaryInput,
} from "@/lib/agent/conversationSummaryPrompt";

const SECRET = {
  resumeId: "resume-secret-value",
  jobId: "job-secret-value",
  toolCallId: "call-secret-value",
  approvalId: "approval-secret-value",
  signature: "sig-secret-value",
  provider: "provider-secret-value",
  reasoning: "reasoning-secret-value",
  raw: "raw-tool-json-secret",
};

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function dialogue(turns: number): UIMessage[] {
  const messages: UIMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(user(`u${i}`, `用户目标 ${i}：准备后端面试`));
    messages.push(assistant(`a${i}`, `记下目标 ${i}`));
  }
  return messages;
}

function resolvedToolMessage(): UIMessage {
  return {
    id: "tool-msg",
    role: "assistant",
    parts: [
      { type: "reasoning", text: SECRET.reasoning, providerMetadata: { secret: SECRET.provider } },
      {
        type: "tool-get_resume",
        toolCallId: SECRET.toolCallId,
        state: "output-available",
        input: { jobId: SECRET.jobId, resumeId: SECRET.resumeId, nested: { z: 1, a: 2 } },
        output: { status: "ok", resumeId: SECRET.resumeId, blob: { raw: SECRET.raw } },
        approval: { id: SECRET.approvalId, approved: true, signature: SECRET.signature },
        providerMetadata: { secret: SECRET.provider },
        callProviderMetadata: { secret: SECRET.provider },
        resultProviderMetadata: { secret: SECRET.provider },
      },
    ],
  } as unknown as UIMessage;
}

describe("conversation summary coverage", () => {
  it("keeps the summary prompt version in one module", () => {
    expect(CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION).toBe("career-dialogue-summary-v2");
    const root = path.resolve("src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (readFileSync(full, "utf8").includes("career-dialogue-summary-v2")) hits.push(full);
      }
    };
    walk(root);
    expect(hits.map((file) => path.basename(file))).toEqual(["conversationSummaryPrompt.ts"]);
  });

  it("hashes stable semantic fields and ignores provider, approval, and reasoning metadata", () => {
    const left = resolvedToolMessage();
    const right = resolvedToolMessage();
    const rightTool = right.parts[1] as unknown as {
      input: Record<string, unknown>;
      approval: { id: string; signature: string; approved: boolean };
      providerMetadata: { secret: string };
    };
    rightTool.input = { nested: { a: 2, z: 1 }, resumeId: SECRET.resumeId, jobId: SECRET.jobId };
    rightTool.approval = { id: "other-approval", signature: "other-sig", approved: true } as never;
    rightTool.providerMetadata = { secret: "other-provider" };
    expect(hashSummaryCoverage([left])).toBe(hashSummaryCoverage([right]));

    const canonical = JSON.stringify(canonicalizeSummaryCoverageMessage(left));
    expect(canonical).not.toContain(SECRET.toolCallId);
    expect(canonical).not.toContain(SECRET.approvalId);
    expect(canonical).not.toContain(SECRET.signature);
    expect(canonical).not.toContain(SECRET.provider);
    expect(canonical).not.toContain(SECRET.reasoning);
    expect(canonical).toContain("get_resume");
    expect(canonical).toContain("output-available");

    const changedText = user("u", "hello");
    const same = user("u", "hello");
    (same.parts[0] as { providerMetadata?: unknown }).providerMetadata = { secret: SECRET.provider };
    expect(hashSummaryCoverage([changedText])).toBe(hashSummaryCoverage([same]));
    expect(hashSummaryCoverage([user("u", "hello")])).not.toBe(hashSummaryCoverage([user("u", "hello!")]));

    const denied = resolvedToolMessage();
    (denied.parts[1] as { approval: { approved: boolean } }).approval.approved = false;
    expect(hashSummaryCoverage([left])).not.toBe(hashSummaryCoverage([denied]));
  });

  it("treats a summary as fresh only when coverage, version, and size all match", () => {
    const messages = dialogue(2);
    const hash = hashSummaryCoverage(messages);
    const text = "用户在准备后端面试。";
    const fresh = {
      text,
      throughMessageId: "a1",
      coverageHash: hash,
      coveredCount: messages.length,
      promptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
      units: estimateContextTokens(text),
    };
    expect(validateConversationSummaryCoverage(fresh, messages).status).toBe("FRESH");
    expect(validateConversationSummaryCoverage(null, messages).status).toBe("MISSING");
    expect(validateConversationSummaryCoverage({ ...fresh, text: "  " }, messages)).toMatchObject({
      status: "STALE",
      reason: "empty_text",
    });
    expect(
      validateConversationSummaryCoverage(
        { ...fresh, promptVersion: "career-dialogue-summary-v0" },
        messages,
      ),
    ).toMatchObject({ status: "STALE", reason: "prompt_version" });
    expect(
      validateConversationSummaryCoverage({ ...fresh, throughMessageId: "missing" }, messages),
    ).toMatchObject({ status: "STALE", reason: "through_message" });
    expect(validateConversationSummaryCoverage({ ...fresh, coveredCount: 1 }, messages)).toMatchObject({
      status: "STALE",
      reason: "covered_count",
    });
    expect(validateConversationSummaryCoverage({ ...fresh, coverageHash: "nope" }, messages)).toMatchObject({
      status: "STALE",
      reason: "hash",
    });
    expect(
      validateConversationSummaryCoverage(
        { ...fresh, units: CAREER_DIALOGUE_CONTEXT_BUDGETS.summaryTokens + 1 },
        messages,
      ),
    ).toMatchObject({ status: "STALE", reason: "units" });
    expect(validateConversationSummaryCoverage({ ...fresh, units: null }, messages)).toMatchObject({
      status: "STALE",
      reason: "units",
    });
    const huge = "中".repeat(CAREER_DIALOGUE_CONTEXT_BUDGETS.summaryTokens + 1);
    expect(
      validateConversationSummaryCoverage(
        { ...fresh, text: huge, units: estimateContextTokens(huge) },
        messages,
      ).status,
    ).not.toBe("FRESH");
  });

  it("covers dropped turns plus the oldest retained turn and stops before a pending tool", () => {
    const messages = dialogue(8);
    const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages });
    if (!budget.ok) throw new Error(budget.code);
    const target = selectConversationSummaryCoverage(messages);
    expect(budget.historyBoundary.droppedTurns.length).toBeGreaterThan(0);
    expect(target?.throughMessageId).toBe(budget.historyBoundary.retainedHistoryTurns[0]?.at(-1));
    const ids = target?.prefix.map((message) => message.id) ?? [];
    expect(ids).toContain(budget.historyBoundary.droppedTurns[0]?.[0]);
    expect(ids).not.toContain(budget.historyBoundary.retainedHistoryTurns[1]?.[0]);

    const pending = dialogue(8);
    pending[3] = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-add_job",
          toolCallId: SECRET.toolCallId,
          state: "approval-requested",
          input: { resumeId: SECRET.resumeId, jobId: SECRET.jobId },
          approval: { id: SECRET.approvalId, signature: SECRET.signature },
        },
      ],
    } as UIMessage;
    const blocked = selectConversationSummaryCoverage(pending);
    expect(blocked?.prefix.map((message) => message.id) ?? []).not.toContain("a1");
    const projected = projectConversationSummaryInput(pending);
    for (const secret of Object.values(SECRET)) expect(projected).not.toContain(secret);
  });

  it("projects resolved tool outcomes without ids, raw JSON, or reasoning", () => {
    const messages = [user("u", "请总结我的简历方向"), resolvedToolMessage()];
    const projected = projectConversationSummaryInput(messages);
    const prompt = buildCareerDialogueSummaryPrompt(projected);
    expect(projected).toContain("User: 请总结我的简历方向");
    expect(projected).toContain("Tool get_resume finished (ok).");
    expect(projected).not.toContain("{");
    for (const secret of Object.values(SECRET)) {
      expect(projected).not.toContain(secret);
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).toContain(CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION);
  });

  it("does not inject a summary whose prompt version is not the current contract", () => {
    const messages = dialogue(2);
    const text = "旧合同摘要";
    const verdict = validateConversationSummaryCoverage(
      {
        text,
        throughMessageId: "a1",
        coverageHash: hashSummaryCoverage(messages),
        coveredCount: messages.length,
        promptVersion: "career-dialogue-summary-v0",
        units: estimateContextTokens(text),
      },
      messages,
    );
    expect(verdict.status).toBe("STALE");
    const summary = verdict.status === "FRESH" ? verdict.text : undefined;
    const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages, summary });
    if (!budget.ok) throw new Error(budget.code);
    expect(budget.summary).toBeUndefined();
    expect(budget.transcript).not.toContain(text);
  });

  it("flags storage pressure before a fat append evicts an early boundary", () => {
    const messages: UIMessage[] = [];
    const addTurn = (index: number, assistants: number, text: string) => {
      messages.push(user(`u${index}`, text));
      for (let i = 0; i < assistants; i++) {
        messages.push(assistant(`a${index}-${i}`, `${text} ${i}`));
      }
    };
    addTurn(0, 1, "early goal one");
    addTurn(1, 1, "early goal two");
    addTurn(2, 10, "recent fat two");
    addTurn(3, 10, "recent fat three");
    addTurn(4, 10, "recent fat four");
    addTurn(5, 11, "current fat");
    expect(messages).toHaveLength(49);
    expect(summaryBoundaryUnderStoragePressure(messages, "a1-0")).toBe(true);
    const prefix = messages.slice(0, 4);
    const text = "OLD_BOUNDARY_SUMMARY";
    const old = {
      text,
      throughMessageId: "a1-0",
      coverageHash: hashSummaryCoverage(prefix),
      coveredCount: 4,
      promptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
      units: estimateContextTokens(text),
    };
    expect(validateConversationSummaryCoverage(old, messages).status).toBe("FRESH");
    const evicted = messages.slice(4);
    expect(validateConversationSummaryCoverage(old, evicted).status).toBe("STALE");
    const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages: evicted });
    if (!budget.ok) throw new Error(budget.code);
    expect(budget.transcript).not.toContain(text);
  });
});
