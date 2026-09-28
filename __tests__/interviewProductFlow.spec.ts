// @vitest-environment node
/**
 * Interview product flow — the migrated end-to-end shape.
 *
 * Covers (service level, disposable DB):
 * - AI question planning: exactly 3 AI_GENERATED QuestionInstances, the
 *   planning call runs on the same resolved runtime the session lock
 *   persists (no second resolve, no mid-create failover)
 * - planning context assembly: real Job/JD content + bounded Career
 *   Material facts enter the planning prompt
 * - invalid/duplicate/short plans abort creation — no empty session
 * - one-question-at-a-time advance: answered + succeeded feedback is
 *   required, the last question never overshoots
 * - follow-up prompts carry real question/answer/feedback content and
 *   bounded history (never bare ids)
 * - summary assembles real content, publishes + completes in one
 *   transaction, and a failed summary leaves the session IN_PROGRESS
 * - session cards expose derived readable history metadata
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createInterviewRuntime } from "@/lib/interview/services/application";
import { VocatryaInterviewModelAdapter } from "@/lib/interview/vocatryaHostPorts";
import { StaticKnowledgeProvider } from "@/lib/interview/services/knowledge";
import type {
  InterviewModelPort,
  ResolvedInterviewModel,
} from "@/lib/interview/hostPorts";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const helpers = await import("./helpers/backupTestDb");

let userId: string;

const ANSWER_TEXT =
  "I led the launch of a billing rewrite under a two-week freeze.";

const FEEDBACK_PAYLOAD = {
  feedbackItems: [
    {
      problemLabel: "Missing Situation Context",
      suggestion: "Add the team and constraint first.",
      evidence: {
        transcriptExcerpt: "I led the launch",
        startOffset: 99,
        endOffset: 101,
        problemStatement: "Situation missing",
        groundingSources: [],
      },
      explanation: {
        underlyingCause: "Jumped to action",
        performanceImpact: "Hard to judge scope",
        interviewerPerspective: null,
      },
    },
  ],
};

const PLAN_PAYLOAD = {
  questions: [
    {
      text: "Tell me about a time you shipped under deadline pressure.",
      category: "behavioral",
      rationale: "Probes execution under constraints.",
    },
    {
      text: "Describe a disagreement with a teammate and how you resolved it.",
      category: "communication",
      rationale: "Probes collaboration.",
    },
    {
      text: "What project are you most proud of and why?",
      category: "motivation",
      rationale: "Probes impact ownership.",
    },
  ],
};

function feedbackItemPayload(excerpt = "I led the launch") {
  return {
    feedbackItems: [
      {
        ...FEEDBACK_PAYLOAD.feedbackItems[0],
        evidence: {
          ...FEEDBACK_PAYLOAD.feedbackItems[0].evidence,
          transcriptExcerpt: excerpt,
        },
      },
    ],
  };
}

/** Model port that records every prompt and routes by marker. */
function recordingModel(
  routes: {
    onPlan?: unknown | ((prompt: string) => unknown);
    onFeedback?: unknown;
    onCoaching?: unknown;
    onSummary?: unknown;
  } = {},
) {
  const prompts: string[] = [];
  const planCalls: Array<{ connectionId?: string; model?: string; kind?: string }> =
    [];
  const model: ResolvedInterviewModel = {
    provider: "mock",
    model: "mock-v1",
    async generateJson({ prompt }) {
      prompts.push(prompt);
      if (prompt.includes("TASK: generate exactly 3 interview questions")) {
        const route = routes.onPlan ?? PLAN_PAYLOAD;
        return typeof route === "function" ? route(prompt) : route;
      }
      if (prompt.includes("FEEDBACK_GENERATION")) {
        return routes.onFeedback ?? feedbackItemPayload();
      }
      if (prompt.includes("SESSION_SUMMARY")) {
        return (
          routes.onSummary ?? {
            bodyText: "You tend to skip situation setup.",
            structuredPayload: {
              keyPatterns: ["skip situation"],
              strengths: ["clear action"],
              developmentAreas: ["set context"],
            },
          }
        );
      }
      if (prompt.includes("COACHING_TURN")) {
        return routes.onCoaching ?? { reply: "Try opening with the constraint." };
      }
      throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
    },
  };
  const port: InterviewModelPort = {
    resolveInterviewModel: vi.fn(async () => model),
    resolveInterviewModelForPlan: vi.fn(async ({ plan }) => {
      planCalls.push({
        kind: plan.kind,
        connectionId: plan.connectionId,
        model: plan.model,
      });
      return model;
    }),
  };
  return { port, prompts, planCalls };
}

function runtime(modelPort: InterviewModelPort) {
  return createInterviewRuntime({
    db: prisma,
    modelPort,
    knowledge: new StaticKnowledgeProvider("v1.0", "KB excerpt", "hash-v1"),
  });
}

async function makeConnection(overrides: Record<string, unknown> = {}) {
  return prisma.aIConnection.create({
    data: {
      userId,
      provider: "OPENAI",
      backendKind: "CODEX_RUNTIME",
      displayName: "ChatGPT via Codex",
      status: "CONNECTED",
      runtimeProfileRef: `rp_${randomUUID()}`,
      ...overrides,
    },
  });
}

async function assignInterview(connectionId: string, model: string) {
  return prisma.aIBusinessAssignment.upsert({
    where: { userId_purpose: { userId, purpose: "INTERVIEW" } },
    create: { userId, purpose: "INTERVIEW", connectionId, model },
    update: { connectionId, model },
  });
}

async function makeJobWithJd(rawContent = "Own billing reliability end to end.") {
  const job = await prisma.jobOpportunity.create({
    data: {
      userId,
      title: "Backend Engineer",
      companyId: (
        await prisma.company.create({
          data: {
            label: "Acme",
            value: `acme-${randomUUID()}`,
            createdBy: userId,
          },
        })
      ).id,
    },
  });
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: job.id,
      versionNumber: 1,
      rawContent,
      capturedAt: new Date("2026-01-01T00:00:00Z"),
      contentHash: `hash-${randomUUID()}`,
    },
  });
  return { job, jd };
}

async function seedCareerMaterial() {
  await prisma.careerMaterialItem.create({
    data: {
      userId,
      type: "PROJECT",
      title: "Billing rewrite launch",
      notes: "Led a two-week freeze migration",
      evidence: {
        create: [
          {
            kind: "OUTCOME",
            content: "Reduced failed payments by 38%",
            metricText: "38%",
          },
        ],
      },
    },
  });
}

beforeEach(async () => {
  await helpers.resetDisposableDb(prisma);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  userId = await helpers.seedAccount(prisma, `pf-${stamp}@example.com`);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    const fs = await import("node:fs");
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows can retain a short-lived SQLite handle after disconnect.
  }
});

describe("AI question planning", () => {
  it("creates exactly 3 AI_GENERATED QuestionInstances from the plan", async () => {
    const { port, prompts, planCalls } = recordingModel();
    const app = runtime(port);
    const { session, instances } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
    });
    expect(instances).toHaveLength(3);
    for (const [index, instance] of instances.entries()) {
      expect(instance.sourceKind).toBe("AI_GENERATED");
      expect(instance.sourceQuestionId).toBeNull();
      expect(instance.displayedText).toBe(PLAN_PAYLOAD.questions[index].text);
      expect(instance.category).toBe(PLAN_PAYLOAD.questions[index].category);
    }
    expect(session.currentQuestionInstanceId).toBe(instances[0].id);
    // The planner ran on the creation-time plan — exactly once.
    expect(planCalls).toHaveLength(1);
    const planPrompt = prompts.find((prompt) =>
      prompt.includes("TASK: generate exactly 3 interview questions"),
    );
    expect(planPrompt).toBeTruthy();
    expect(planPrompt).toContain("general job interview");
  });

  it("locks the session to the same connection the planner ran on", async () => {
    const connection = await makeConnection();
    await assignInterview(connection.id, "gpt-5.5");
    const execPrompts: string[] = [];
    const adapter = new VocatryaInterviewModelAdapter(
      prisma as never,
      undefined,
      vi.fn(async ({ prompt }) => {
        execPrompts.push(prompt);
        return { text: JSON.stringify(PLAN_PAYLOAD) };
      }),
    );
    const app = createInterviewRuntime({
      db: prisma,
      modelPort: adapter,
      knowledge: new StaticKnowledgeProvider("v1.0", "KB excerpt", "hash-v1"),
    });
    const { session, instances } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
    });
    expect(instances).toHaveLength(3);
    // One resolution produced both the planning model and the persisted lock.
    const row = await prisma.interviewSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.resolvedConnectionId).toBe(connection.id);
    expect(row.resolvedModel).toBe("gpt-5.5");
    expect(execPrompts).toHaveLength(1);
    expect(execPrompts[0]).toContain(
      "TASK: generate exactly 3 interview questions",
    );
  });

  it("feeds real JD content and bounded career facts into the planning prompt", async () => {
    const { job, jd } = await makeJobWithJd("Own billing reliability end to end.");
    await seedCareerMaterial();
    const { port, prompts } = recordingModel();
    const app = runtime(port);
    const { session, instances } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
      jobOpportunityId: job.id,
      jobDescriptionVersionId: jd.id,
    });
    expect(instances).toHaveLength(3);
    expect(session.jobOpportunityId).toBe(job.id);
    expect(session.jobDescriptionVersionId).toBe(jd.id);
    const planPrompt = prompts.find((prompt) =>
      prompt.includes("TASK: generate exactly 3 interview questions"),
    )!;
    expect(planPrompt).toContain("Backend Engineer");
    expect(planPrompt).toContain("Acme");
    expect(planPrompt).toContain("Own billing reliability end to end.");
    expect(planPrompt).toContain("Billing rewrite launch");
    expect(planPrompt).toContain("Reduced failed payments by 38%");
  });

  it("works with no job and no career material", async () => {
    const { port } = recordingModel();
    const app = runtime(port);
    const { instances } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
    });
    expect(instances).toHaveLength(3);
  });

  it("rejects a malformed plan and leaves no session behind", async () => {
    const { port } = recordingModel({
      onPlan: { questions: [{ text: "Only one." }] },
    });
    const app = runtime(port);
    await expect(
      app.createInterviewSession({ userId, coachingMode: "PRACTICE" }),
    ).rejects.toMatchObject({ code: "INVALID_QUESTION_PLAN" });
    expect(await prisma.interviewSession.count()).toBe(0);
    expect(await prisma.questionInstance.count()).toBe(0);
  });

  it("rejects duplicate generated questions", async () => {
    const { port } = recordingModel({
      onPlan: {
        questions: [
          { text: "Same question?", category: "a", rationale: "r" },
          { text: "  Same   question? ", category: "b", rationale: "r" },
          { text: "A different one?", category: "c", rationale: "r" },
        ],
      },
    });
    const app = runtime(port);
    await expect(
      app.createInterviewSession({ userId, coachingMode: "PRACTICE" }),
    ).rejects.toMatchObject({ code: "INVALID_QUESTION_PLAN" });
    expect(await prisma.interviewSession.count()).toBe(0);
  });
});

describe("one-question-at-a-time session flow", () => {
  async function threeQuestionSession(modelPort: InterviewModelPort) {
    const app = runtime(modelPort);
    return app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
    });
  }

  it("refuses to advance before answer and before succeeded feedback", async () => {
    // Feedback route returns an invalid item so generation fails.
    const failing = recordingModel({
      onFeedback: { feedbackItems: [{ nope: true }] },
    });
    const app = runtime(failing.port);
    const { session, instances } = await threeQuestionSession(failing.port);
    const early = await app
      .advanceToNextQuestion({ userId, sessionId: session.id })
      .catch((error) => error);
    expect(early.code).toBe("QUESTION_NOT_READY");

    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    const failed = await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    expect(failed.generation.status).toBe("FAILED");
    const blocked = await app
      .advanceToNextQuestion({ userId, sessionId: session.id })
      .catch((error) => error);
    expect(blocked.code).toBe("QUESTION_NOT_READY");
    const row = await prisma.interviewSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.currentQuestionInstanceId).toBe(instances[0].id);
  });

  it("advances through questions after succeeded feedback and stops at the end", async () => {
    const { port } = recordingModel();
    const app = runtime(port);
    const { session, instances } = await threeQuestionSession(port);

    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    const moved = await app.advanceToNextQuestion({
      userId,
      sessionId: session.id,
    });
    expect(moved.advanced).toBe(true);
    if (moved.advanced) {
      expect(moved.nextInstanceId).toBe(instances[1].id);
      expect(moved.session.currentQuestionInstanceId).toBe(instances[1].id);
      expect(moved.session.status).toBe("IN_PROGRESS");
    }

    for (const instance of instances.slice(1)) {
      const answer = await app.submitInterviewAnswer({
        userId,
        questionInstanceId: instance.id,
        textContent: ANSWER_TEXT,
      });
      await app.generateInterviewFeedback({
        userId,
        answerAttemptId: answer.attempt.id,
      });
      const step = await app.advanceToNextQuestion({
        userId,
        sessionId: session.id,
      });
      if (instance.id === instances[instances.length - 1].id) {
        expect(step.advanced).toBe(false);
      }
    }
  });
});

describe("feedback guards and regeneration repair", () => {
  it("rejects stable-trait output, regenerates once, and publishes the retry", async () => {
    let calls = 0;
    const { port } = recordingModel({
      onFeedback: undefined,
    });
    const model: ResolvedInterviewModel = {
      provider: "mock",
      model: "mock-v1",
      async generateJson() {
        calls += 1;
        if (calls === 1) {
          return {
            feedbackItems: [
              {
                problemLabel: "性格缺陷",
                suggestion: "你缺乏沟通能力，多练习。",
                evidence: {
                  transcriptExcerpt: "I led the launch",
                  problemStatement: "你的性格太内向",
                  groundingSources: [],
                },
                explanation: {
                  underlyingCause: "你缺乏自信",
                  performanceImpact: "不会被录用",
                },
              },
            ],
          };
        }
        return feedbackItemPayload();
      },
    };
    const app = runtime({
      resolveInterviewModel: async () => model,
    });
    const { instances } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
      questions: [{ displayedText: "Tell me about a launch." }],
    });
    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    const result = await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    expect(calls).toBe(2);
    expect(result.generation.status).toBe("SUCCEEDED");
    expect(result.items[0].problemLabel).toBe("Missing Situation Context");
    // The rejected payload was never persisted.
    const stored = await prisma.feedbackItem.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0].problemLabel).not.toContain("性格");
  });

  it("fails closed when both cycles produce unsafe output", async () => {
    let calls = 0;
    const model: ResolvedInterviewModel = {
      provider: "mock",
      model: "mock-v1",
      async generateJson() {
        calls += 1;
        return {
          feedbackItems: [
            {
              problemLabel: "Outcome",
              suggestion: "You will fail the interview.",
              evidence: {
                transcriptExcerpt: "I led the launch",
                problemStatement: "You lacks the ability to structure.",
                groundingSources: [],
              },
              explanation: {
                underlyingCause: "lacks ability",
                performanceImpact: "won't be hired",
              },
            },
          ],
        };
      },
    };
    const app = runtime({ resolveInterviewModel: async () => model });
    const { instances } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
      questions: [{ displayedText: "Q" }],
    });
    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    const result = await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    expect(calls).toBe(2);
    expect(result.generation.status).toBe("FAILED");
    expect(result.generation.failureCode).toBe("INVALID_FEEDBACK_ITEM");
    expect(await prisma.feedbackItem.count()).toBe(0);
  });
});

describe("follow-up dialogue context", () => {
  it("FEEDBACK_ITEM prompts carry item content + question + answer + history", async () => {
    const { port, prompts } = recordingModel();
    const app = runtime(port);
    const { session, instances } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
    });
    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: ANSWER_TEXT,
    });
    const feedback = await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    const item = feedback.items[0];

    await app.sendInterviewFollowUp({
      userId,
      sessionId: session.id,
      userText: "Why is this a problem?",
      targetType: "FEEDBACK_ITEM",
      commercialFeedbackItemId: item.id,
    });
    await app.sendInterviewFollowUp({
      userId,
      sessionId: session.id,
      userText: "How do I fix the opening?",
      targetType: "FEEDBACK_ITEM",
      commercialFeedbackItemId: item.id,
    });

    const coaching = prompts.filter((prompt) =>
      prompt.includes("COACHING_TURN"),
    );
    expect(coaching).toHaveLength(2);
    const first = coaching[0];
    expect(first).toContain("Missing Situation Context");
    expect(first).toContain("Add the team and constraint first.");
    expect(first).toContain("I led the launch");
    expect(first).toContain(PLAN_PAYLOAD.questions[0].text);
    expect(first).toContain(ANSWER_TEXT);
    expect(first).toContain("Why is this a problem?");
    // Second turn sees the persisted history of the first.
    expect(coaching[1]).toContain("Why is this a problem?");
    expect(coaching[1]).toContain("Try opening with the constraint.");
  });

  it("persists turns that survive reload", async () => {
    const { port } = recordingModel();
    const app = runtime(port);
    const { session } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
    });
    await app.sendInterviewFollowUp({
      userId,
      sessionId: session.id,
      userText: "Opening advice?",
      targetType: "SESSION",
    });
    const turns = await app.listDialogue(userId, session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantReply).toContain("constraint");
    expect(turns[0].replyPromptVersion).toBe("commercial_coaching_v2");
  });
});

describe("session summary", () => {
  async function answeredSession(modelPort: InterviewModelPort) {
    const app = runtime(modelPort);
    const { session, instances } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
    });
    for (const instance of instances) {
      const submitted = await app.submitInterviewAnswer({
        userId,
        questionInstanceId: instance.id,
        textContent: `Answer for ${instance.displayOrder}: ${ANSWER_TEXT}`,
      });
      await app.generateInterviewFeedback({
        userId,
        answerAttemptId: submitted.attempt.id,
      });
    }
    return { app, session, instances };
  }

  it("assembles real question/transcript/feedback content and completes on success", async () => {
    const { port, prompts } = recordingModel();
    const { app, session, instances } = await answeredSession(port);
    const summary = await app.generateInterviewSummary({
      userId,
      sessionId: session.id,
    });
    expect(summary.generation.status).toBe("SUCCEEDED");
    expect(summary.inputs).toHaveLength(3);
    const summaryPrompt = prompts.find((prompt) =>
      prompt.includes("SESSION_SUMMARY"),
    )!;
    expect(summaryPrompt).toContain(PLAN_PAYLOAD.questions[0].text);
    expect(summaryPrompt).toContain(ANSWER_TEXT);
    expect(summaryPrompt).toContain("Missing Situation Context");
    // Publication and completion share one transaction.
    const row = await prisma.interviewSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.status).toBe("COMPLETED");
    expect(row.completedAt).not.toBeNull();
    // Historical marker: all 3 instances were used.
    void instances;
  });

  it("summary failure leaves the session IN_PROGRESS and supports retry", async () => {
    const { port } = recordingModel({
      onSummary: { bodyText: "", structuredPayload: {} },
    });
    const { app, session } = await answeredSession(port);
    const failed = await app.generateInterviewSummary({
      userId,
      sessionId: session.id,
    });
    expect(failed.generation.status).toBe("FAILED");
    expect(failed.generation.failureCode).toBe("INVALID_SUMMARY_OUTPUT");
    const row = await prisma.interviewSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.status).toBe("IN_PROGRESS");

    const retry = await app.generateInterviewSummary({
      userId,
      sessionId: session.id,
    });
    expect(retry.generation.status).toBe("FAILED");
    // A working model now succeeds and completes the session.
    const ok = recordingModel();
    const app2 = runtime(ok.port);
    const succeeded = await app2.generateInterviewSummary({
      userId,
      sessionId: session.id,
    });
    expect(succeeded.generation.status).toBe("SUCCEEDED");
    expect(
      (
        await prisma.interviewSession.findUniqueOrThrow({
          where: { id: session.id },
        })
      ).status,
    ).toBe("COMPLETED");
  });
});

describe("history presentation", () => {
  it("returns derived readable session cards", async () => {
    const { job, jd } = await makeJobWithJd();
    const { port } = recordingModel();
    const app = runtime(port);
    const { session } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
      jobOpportunityId: job.id,
      jobDescriptionVersionId: jd.id,
    });
    await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
    });
    const cards = await app.listInterviewSessionCards(userId);
    expect(cards).toHaveLength(2);
    const bound = cards.find((card) => card.session.id === session.id)!;
    expect(bound.jobTitle).toBe("Backend Engineer");
    expect(bound.companyName).toBe("Acme");
    expect(bound.jdVersionNumber).toBe(1);
    expect(bound.totalQuestions).toBe(3);
    expect(bound.answeredQuestions).toBe(0);
    const generic = cards.find((card) => card.session.id !== session.id)!;
    expect(generic.jobTitle).toBeNull();
    expect(generic.companyName).toBeNull();
  });
});
