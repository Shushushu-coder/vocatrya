import {
  careerDialogueObservabilityFields,
  routeCareerDialogueTurn,
  type CareerDialogueRouteMessage,
} from "@/lib/agent/careerDialogueRoute";

const user = (text: string): CareerDialogueRouteMessage => ({
  role: "user",
  parts: [{ type: "text", text }],
});

function routeText(text: string, pageContext?: unknown) {
  return routeCareerDialogueTurn({
    messages: [user(text)],
    pageContext,
  });
}

describe("routeCareerDialogueTurn", () => {
  it.each([
    ["hi", "GREETING"],
    ["hello", "GREETING"],
    ["你好", "GREETING"],
    ["谢谢", "GREETING"],
    ["你是什么模型", "GREETING"],
    ["什么是 STAR", "GENERAL_EXPLANATION"],
    ["解释一下这个建议", "GENERAL_EXPLANATION"],
    ["what does STAR mean?", "GENERAL_EXPLANATION"],
    ["为什么", "FOLLOWUP_CLARIFICATION"],
    ["举个例子", "FOLLOWUP_CLARIFICATION"],
    ["我没明白", "FOLLOWUP_CLARIFICATION"],
    ["can you explain that again?", "FOLLOWUP_CLARIFICATION"],
    ["怎么准备行为面试", "REFLECTION"],
    ["how should I prepare for a behavioral interview?", "REFLECTION"],
  ] as const)("routes %j to FAST_CHAT (%s)", (text, reason) => {
    expect(routeText(text)).toEqual({ route: "FAST_CHAT", reason });
  });

  it.each([
    ["今天做什么？", "EXPLICIT_TOOL_INTENT"],
    ["how should I plan today", "EXPLICIT_TOOL_INTENT"],
    ["把准备面试移到明天", "EXPLICIT_TOOL_INTENT"],
    ["帮我添加这个职位", "WRITE_ACTION_INTENT"],
    ["保存这个岗位", "WRITE_ACTION_INTENT"],
    ["add this job", "WRITE_ACTION_INTENT"],
    ["save this job", "WRITE_ACTION_INTENT"],
    ["把这个岗位加入我的职位列表", "WRITE_ACTION_INTENT"],
    ["修改我的简历", "WRITE_ACTION_INTENT"],
    ["查看我的简历", "RESUME_DATA_INTENT"],
    ["show me my resume", "RESUME_DATA_INTENT"],
    ["review my resume", "RESUME_DATA_INTENT"],
    ["分析我的当前简历", "RESUME_DATA_INTENT"],
    ["基于我的简历改一版开头", "RESUME_DATA_INTENT"],
    ["分析我和这个岗位的匹配度", "EXPLICIT_TOOL_INTENT"],
    ["match me to this job", "EXPLICIT_TOOL_INTENT"],
    ["根据这个职位写求职信", "EXPLICIT_TOOL_INTENT"],
    ["generate a cover letter for this saved job", "EXPLICIT_TOOL_INTENT"],
    ["查看我保存的职位", "JOB_DATA_INTENT"],
  ] as const)("routes %j to AGENT (%s)", (text, reason) => {
    expect(routeText(text)).toEqual({ route: "AGENT", reason });
  });

  it.each([
    "不要真的保存，我只是想知道保存职位是什么意思",
    "如果我要保存职位，该怎么操作？",
    "What does resume mean in English?",
    "how should a student write a resume?",
  ])("does not treat %j as a product action", (text) => {
    expect(routeText(text).route).toBe("FAST_CHAT");
  });

  it.each(["嗯", "resume", "可以吗", "帮我看看"])(
    "routes ambiguous %j to AGENT",
    (text) => {
      expect(routeText(text)).toEqual({ route: "AGENT", reason: "AMBIGUOUS" });
    },
  );

  it("keeps a definition question on FAST_CHAT when a job context chip is present", () => {
    const text = "这个岗位里 stakeholder management 是什么意思？";
    const plain = routeText(text);
    const withChip = routeText(text, { jobId: "job-1", route: "/dashboard/myjobs/job-1" });
    expect(plain).toEqual(withChip);
    expect(plain).toEqual({
      route: "FAST_CHAT",
      reason: "GENERAL_EXPLANATION",
    });
  });

  it("still routes an explicit save to AGENT when a job context chip is present", () => {
    expect(
      routeText("把这个岗位加入我的职位列表", { jobId: "job-1" }).route,
    ).toBe("AGENT");
  });

  it("routes a follow-up from persisted evidence to FAST_CHAT", () => {
    const decision = routeCareerDialogueTurn({
      messages: [
        user("查看我的简历"),
        {
          role: "assistant",
          parts: [
            {
              type: "tool-get_resume",
              state: "output-available",
              text: "",
            },
            { type: "text", text: "你的简历强调了协作。" },
          ],
        },
        user("为什么"),
      ],
    });
    expect(decision).toEqual({
      route: "FAST_CHAT",
      reason: "FOLLOWUP_CLARIFICATION",
    });
  });

  it("routes an approval continuation to AGENT", () => {
    expect(
      routeCareerDialogueTurn({
        messages: [
          user("保存这个岗位"),
          {
            role: "assistant",
            parts: [
              {
                type: "tool-add_job",
                state: "approval-responded",
              },
            ],
          },
        ],
      }),
    ).toEqual({ route: "AGENT", reason: "APPROVAL_CONTINUATION" });
  });

  it("routes a paste with no typed request to AGENT", () => {
    expect(
      routeCareerDialogueTurn({
        messages: [
          {
            role: "user",
            parts: [{ type: "data-paste" }],
          },
        ],
      }),
    ).toEqual({ route: "AGENT", reason: "AMBIGUOUS" });
  });

  it("is deterministic across a regenerate of the same request", () => {
    const input = {
      messages: [user("how should I prepare for a behavioral interview?")],
      pageContext: { jobId: "job-1" },
    };
    expect(routeCareerDialogueTurn(input)).toEqual(routeCareerDialogueTurn(input));
  });

  it("classifies a short batch in well under a millisecond each", () => {
    const started = performance.now();
    for (let i = 0; i < 200; i++) routeText("什么是 STAR");
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("logs route codes without the user text", () => {
    const text = "review my resume and the secret posting";
    const fields = careerDialogueObservabilityFields({
      decision: routeText(text),
      routerDurationMs: 0.1234,
      conversationId: "conv-1",
      connectionId: "conn-1",
      model: "gpt-5.6-sol",
    });
    expect(fields).toEqual({
      route: "AGENT",
      reasonCode: "RESUME_DATA_INTENT",
      routerDurationMs: 0.123,
      conversationId: "conv-1",
      connectionId: "conn-1",
      model: "gpt-5.6-sol",
    });
    expect(JSON.stringify(fields)).not.toContain(text);
    expect(JSON.stringify(fields)).not.toContain("secret");
  });
});
