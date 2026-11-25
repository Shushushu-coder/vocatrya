import type { UIMessage } from "ai";
import {
  buildCareerDialogueContext,
  estimateContextTokens,
} from "@/lib/agent/contextBudget";
import {
  microCompactToolOutputLine,
  summarizeToolOutputHeadline,
} from "@/lib/agent/toolMicroCompact";

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistantWithTool(
  id: string,
  toolName: string,
  toolCallId: string,
  output: unknown,
  reply = "收到，已处理。",
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: `tool-${toolName}`,
        toolCallId,
        state: "output-available",
        input: {},
        output,
      } as never,
      { type: "text", text: reply },
    ],
  } as UIMessage;
}

describe("L1 tool micro-compaction & L2 drop order", () => {
  it("keeps the 2 newest historical tool outputs verbatim and folds older large outputs without mutating source messages", () => {
    const oldResumeBody = "OLD_RESUME_SECRET_BODY_" + "经历".repeat(300);
    const oldJobDesc = "OLD_JD_SECRET_BODY_" + "职责".repeat(300);
    const recentWebBody = "RECENT_WEBPAGE_BODY_" + "内容".repeat(250);
    const newestResumeBody = "NEWEST_RESUME_BODY_" + "项目".repeat(250);

    const messages: UIMessage[] = [
      user("u0", "看下旧简历"),
      assistantWithTool("a0", "get_resume", "tc-0", {
        status: "ok",
        resumeId: "secret-resume-id-0",
        title: "Backend V1",
        resumeText: oldResumeBody,
        chars: oldResumeBody.length,
      }),
      user("u1", "看下旧职位"),
      assistantWithTool("a1", "get_job", "tc-1", {
        status: "ok",
        job: {
          id: "secret-job-id-1",
          title: "Senior Backend",
          company: "Acme Corp",
          status: "new",
          jobDescription: oldJobDesc,
          descriptionChars: oldJobDesc.length,
        },
      }),
      user("u2", "读取招聘页面"),
      assistantWithTool("a2", "read_webpage", "tc-2", {
        ok: true,
        url: "https://example.com/jobs/1",
        finalUrl: "https://example.com/jobs/1",
        title: "Acme Careers",
        content: recentWebBody,
      }),
      user("u3", "再看最新简历"),
      assistantWithTool("a3", "get_resume", "tc-3", {
        status: "ok",
        resumeId: "secret-resume-id-3",
        title: "Backend V2",
        resumeText: newestResumeBody,
        chars: newestResumeBody.length,
      }),
      user("cur", "对比一下我哪里最匹配"),
    ];

    const originalSnapshot = JSON.stringify(messages);

    const result = buildCareerDialogueContext({
      profile: "AGENT_RESPONSE",
      messages,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.size.microCompactedToolCount).toBe(2);
    expect(result.transcript).not.toContain("OLD_RESUME_SECRET_BODY_");
    expect(result.transcript).not.toContain("OLD_JD_SECRET_BODY_");
    expect(result.transcript).not.toContain("secret-resume-id-0");
    expect(result.transcript).not.toContain("secret-job-id-1");

    expect(result.transcript).toContain("[compacted earlier output]");
    expect(result.transcript).toContain('Resume "Backend V1"');
    expect(result.transcript).toContain('Job "Senior Backend" at "Acme Corp"');
    expect(result.transcript).toContain("Re-call get_resume if full details are needed.");
    expect(result.transcript).toContain("Re-call get_job if full details are needed.");

    // Two newest tool calls remain verbatim.
    expect(result.transcript).toContain("RECENT_WEBPAGE_BODY_");
    expect(result.transcript).toContain("NEWEST_RESUME_BODY_");

    // Stored source messages were not mutated, while retainedMessages carries compacted clone.
    expect(JSON.stringify(messages)).toBe(originalSnapshot);
    const retainedA0 = result.retainedMessages.find((m) => m.id === "a0");
    const retainedToolPart = retainedA0?.parts[0] as { output?: Record<string, unknown> };
    expect(retainedToolPart.output?._compacted).toBe(true);
  });

  it("keeps 1 historical tool verbatim when current turn already has a sessionFact", () => {
    const bodyA = "BODY_A_" + "a".repeat(900);
    const bodyB = "BODY_B_" + "b".repeat(900);
    const messages: UIMessage[] = [
      user("u0", "看简历A"),
      assistantWithTool("a0", "get_resume", "tc-0", {
        status: "ok",
        title: "Resume A",
        resumeText: bodyA,
        chars: bodyA.length,
      }),
      user("u1", "看简历B"),
      assistantWithTool("a1", "get_resume", "tc-1", {
        status: "ok",
        title: "Resume B",
        resumeText: bodyB,
        chars: bodyB.length,
      }),
      user("cur", "继续"),
    ];

    const result = buildCareerDialogueContext({
      profile: "AGENT_RESPONSE",
      messages,
      sessionFacts: [
        {
          name: "get_job",
          output: { status: "ok", job: { title: "Staff Eng", jobDescription: "LIVE_JD" } },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.size.microCompactedToolCount).toBe(1);
    expect(result.transcript).not.toContain("BODY_A_");
    expect(result.transcript).toContain("BODY_B_");
    expect(result.transcript).toContain("LIVE_JD");
  });

  it("does not drop valid summary first when context overflows; drops tools and turns first", () => {
    const messages: UIMessage[] = [
      user("u0", "第一轮目标：冲刺上海后端岗位 " + "x".repeat(200)),
      assistantWithTool("a0", "get_resume", "tc-0", {
        status: "ok",
        title: "Main Resume",
        resumeText: "TOOL_BODY_0_" + "t".repeat(1200),
      }),
      user("u1", "第二轮问题：" + "y".repeat(200)),
      assistantWithTool("a1", "get_job", "tc-1", {
        status: "ok",
        job: { title: "Backend", company: "Beta", jobDescription: "TOOL_BODY_1_" + "j".repeat(1200) },
      }),
      user("cur", "给我下一步建议"),
    ];

    const summaryText = "1. 当前目标：上海后端岗位\n2. 约束：不考虑外包";
    // Compute a budget where summary + current fit, while old tools/turns overflow.
    const tightDynamicBudget = estimateContextTokens(summaryText) + 120;

    const result = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages,
      summary: summaryText,
      budgets: {
        dynamicTokens: tightDynamicBudget,
        assembledInputTokens: tightDynamicBudget + 200,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.summary).toBe(summaryText);
    expect(result.transcript).toContain("Earlier conversation summary:");
    expect(result.transcript).toContain(summaryText);
    expect(result.size.summaryDroppedForOverflow).toBe(false);
    expect(result.size.droppedTurnCount).toBeGreaterThan(0);
  });

  it("strips IDs from list_jobs micro-compact summaries in AGENT_DECISION profile", () => {
    const jobs = Array.from({ length: 8 }, (_, i) => ({
      id: `secret-job-uuid-${i}`,
      title: `Role ${i}`,
      company: `Company ${i}`,
    }));
    const line = microCompactToolOutputLine("list_jobs", { jobs, total: 8 });
    expect(line).toContain("8 of 8 jobs");
    expect(line).toContain("Role 0 @ Company 0");
    expect(line).not.toContain("secret-job-uuid");
    expect(summarizeToolOutputHeadline("today_plan_read", {
      buckets: { today: [1, 2], tomorrow: [3], overdue: [4] },
    })).toBe("Checklist (today: 2, tomorrow: 1, overdue: 1)");
  });
});
