// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { makeTestDbUrl, resetDisposableDb, seedAccount } from "./helpers/backupTestDb";
import { createInterviewRuntime } from "@/lib/interview/services/application";
import { DomainError } from "@/lib/interview/persistence/interviewErrors";
import { StaticKnowledgeProvider } from "@/lib/interview/services/knowledge";
import { SAMPLE_PRESET } from "@/lib/interview/presets/sample";
import type { InterviewModelPort } from "@/lib/interview/hostPorts";

const REPO_ROOT = path.resolve(__dirname, "..");

function deployMigrations(url: string): void {
  const prismaCli = path.join(REPO_ROOT, "node_modules", "prisma", "build", "index.js");
  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    timeout: 240_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "migrate failed");
  }
}

function mockModel(mode: "ok" | "invalid" | "bad-evidence" | "empty" | "missing"): InterviewModelPort {
  return {
    async resolveInterviewModel() {
      if (mode === "missing") {
        throw new DomainError(
          "INTERVIEW_MODEL_NOT_CONFIGURED",
          "Interview model is not configured",
        );
      }
      return {
        provider: "mock",
        model: "mock-v1",
        async generateJson({ prompt }: { system: string; prompt: string }) {
          if (prompt.includes("FEEDBACK_GENERATION")) {
            if (mode === "empty") return { feedbackItems: [] };
            if (mode === "invalid") return { feedbackItems: [{ nope: true }] };
            const excerpt =
              mode === "bad-evidence" ? "this excerpt is not in the transcript" : "I led the launch";
            return {
              feedbackItems: [
                {
                  problemLabel: "Missing Situation Context",
                  suggestion: "Add the team and constraint first.",
                  evidence: {
                    transcriptExcerpt: excerpt,
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
          }
          if (prompt.includes("SESSION_SUMMARY")) {
            return {
              bodyText: "You tend to skip situation setup.",
              structuredPayload: {
                keyPatterns: ["skip situation"],
                strengths: ["clear action"],
                developmentAreas: ["set context"],
              },
            };
          }
          if (prompt.includes("COACHING_TURN")) {
            return { reply: "Try opening with the constraint." };
          }
          throw new Error("unexpected prompt");
        },
      };
    },
  };
}

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userA: string;
let userB: string;

beforeAll(() => {
  deployMigrations(ctx.url);
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  userA = await seedAccount(prisma, `p3c-a-${stamp}@example.com`);
  userB = await seedAccount(prisma, `p3c-b-${stamp}@example.com`);
}, 60_000);

function runtime(mode: "ok" | "invalid" | "bad-evidence" | "empty" | "missing" = "ok") {
  return createInterviewRuntime({
    db: prisma,
    modelPort: mockModel(mode),
    knowledge: new StaticKnowledgeProvider("v1.0", "KB excerpt", "hash-v1"),
  });
}

describe("Phase 3C interview services", () => {
  it("runs the product main flow with grounded evidence and persistence", async () => {
    const app = runtime();
    const preset = await app.ensurePreset(userA);
    expect(preset.created).toBe(true);
    const reuse = await app.ensurePreset(userA);
    expect(reuse.created).toBe(false);
    expect(reuse.bankId).toBe(preset.bankId);

    const { session, instances } = await app.createInterviewSession({
      userId: userA,
      coachingMode: "PRACTICE",
      questions: [
        {
          displayedText: SAMPLE_PRESET.items[0].promptText,
          sourceKind: "QUESTION_BANK",
          sourceQuestionId: preset.questionIds[0],
        },
      ],
    });
    expect(session.knowledgeBaseVersion).toBe("v1.0");
    const submitted = await app.submitInterviewAnswer({
      userId: userA,
      questionInstanceId: instances[0].id,
      textContent: "I led the launch of a billing rewrite under a two-week freeze.",
    });
    expect(submitted.attempt.status).toBe("COMPLETED");

    const feedback = await app.generateInterviewFeedback({
      userId: userA,
      answerAttemptId: submitted.attempt.id,
    });
    expect(feedback.generation.status).toBe("SUCCEEDED");
    expect(feedback.generation.isCurrent).toBe(true);
    const evidence = JSON.parse(feedback.items[0].evidence) as {
      transcriptExcerpt: string;
      startOffset: number;
      endOffset: number;
    };
    expect(evidence.transcriptExcerpt).toBe("I led the launch");
    expect(evidence.startOffset).toBe(0);
    expect(evidence.endOffset).toBe("I led the launch".length);

    const turn = await app.sendInterviewFollowUp({
      userId: userA,
      sessionId: session.id,
      userText: "How should I open?",
      targetType: "SESSION",
    });
    expect(turn.assistantReply).toContain("constraint");

    const summary = await app.generateInterviewSummary({
      userId: userA,
      sessionId: session.id,
    });
    expect(summary.generation.status).toBe("SUCCEEDED");
    expect(summary.generation.bodyText).toContain("situation");

    const reloaded = await app.loadSessionHistory(userA, session.id);
    expect(reloaded.attempts[0].feedback?.items).toHaveLength(1);
    expect(reloaded.turns).toHaveLength(1);
    expect(reloaded.summary?.generation.id).toBe(summary.generation.id);
    expect(reloaded.attempts[0].transcriptText).toContain("billing rewrite");
  });

  it("serves a repeated feedback request from the succeeded generation without a second model run", async () => {
    // Regression: the UI used to reach this service twice per answer (submit
    // path + auto-effect; client server-action queueing serializes them).
    // A repeated call after success must not create another generation row
    // or pay another model round-trip.
    let modelCalls = 0;
    const inner = mockModel("ok");
    const counting: InterviewModelPort = {
      async resolveInterviewModel(input) {
        const resolved = await inner.resolveInterviewModel(input);
        return {
          ...resolved,
          generateJson: (prompt, opts) => {
            modelCalls += 1;
            return resolved.generateJson(prompt, opts);
          },
        };
      },
    };
    const app = createInterviewRuntime({
      db: prisma,
      modelPort: counting,
      knowledge: new StaticKnowledgeProvider("v1.0", "KB excerpt", "hash-v1"),
    });
    const { instances } = await app.createInterviewSession({
      userId: userA,
      coachingMode: "PRACTICE",
      questions: [{ displayedText: "Tell me about a launch." }],
    });
    const submitted = await app.submitInterviewAnswer({
      userId: userA,
      questionInstanceId: instances[0].id,
      textContent: "I led the launch of a billing rewrite under a two-week freeze.",
    });

    const first = await app.generateInterviewFeedback({
      userId: userA,
      answerAttemptId: submitted.attempt.id,
    });
    expect(first.generation.status).toBe("SUCCEEDED");
    const afterFirst = modelCalls;

    const second = await app.generateInterviewFeedback({
      userId: userA,
      answerAttemptId: submitted.attempt.id,
    });
    expect(second.generation.id).toBe(first.generation.id);
    expect(second.items.map((item) => item.id)).toEqual(
      first.items.map((item) => item.id),
    );
    expect(modelCalls).toBe(afterFirst);
    const rows = await prisma.feedbackGeneration.count({
      where: { answerAttemptId: submitted.attempt.id },
    });
    expect(rows).toBe(1);

    // An explicit revision request is a deliberate regeneration and still
    // produces a new versioned generation.
    const third = await app.generateInterviewFeedback({
      userId: userA,
      answerAttemptId: submitted.attempt.id,
      inputRevisionId: first.generation.inputRevisionId,
    });
    expect(third.generation.status).toBe("SUCCEEDED");
    expect(third.generation.id).not.toBe(first.generation.id);
    expect(third.generation.versionNumber).toBeGreaterThan(
      first.generation.versionNumber,
    );
  });

  it("fails closed on missing model, invalid question, cross-user, evidence mismatch, and retry history", async () => {
    const app = runtime();
    const missing = runtime("missing");
    await expect(
      missing.generateInterviewFeedback({ userId: userA, answerAttemptId: "nope" }),
    ).rejects.toMatchObject({ code: "ATTEMPT_NOT_FOUND" });

    const { session, instances } = await app.createInterviewSession({
      userId: userA,
      coachingMode: "PRACTICE",
      questions: [{ displayedText: "Tell me about a launch." }],
    });
    const submitted = await app.submitInterviewAnswer({
      userId: userA,
      questionInstanceId: instances[0].id,
      textContent: "I led the launch of a billing rewrite under a two-week freeze.",
    });

    const unconfigured = await runtime("missing")
      .generateInterviewFeedback({
        userId: userA,
        answerAttemptId: submitted.attempt.id,
      })
      .catch((error) => error);
    expect(unconfigured.code).toBe("INTERVIEW_MODEL_NOT_CONFIGURED");
    const pending = await prisma.feedbackGeneration.count({
      where: { answerAttemptId: submitted.attempt.id },
    });
    expect(pending).toBe(0);

    const invalid = await runtime("invalid").generateInterviewFeedback({
      userId: userA,
      answerAttemptId: submitted.attempt.id,
    });
    expect(invalid.generation.status).toBe("FAILED");
    expect(invalid.generation.isCurrent).toBe(false);

    const mismatch = await runtime("bad-evidence").generateInterviewFeedback({
      userId: userA,
      answerAttemptId: submitted.attempt.id,
    });
    expect(mismatch.generation.status).toBe("FAILED");
    expect(mismatch.generation.failureCode).toBe("INVALID_TRANSCRIPT_EVIDENCE");

    const retry = await app.generateInterviewFeedback({
      userId: userA,
      answerAttemptId: submitted.attempt.id,
    });
    expect(retry.generation.status).toBe("SUCCEEDED");
    expect(retry.generation.versionNumber).toBeGreaterThan(invalid.generation.versionNumber);
    const history = await prisma.feedbackGeneration.count({
      where: { answerAttemptId: submitted.attempt.id },
    });
    expect(history).toBeGreaterThanOrEqual(3);

    const cross = await app
      .getInterviewSession(userB, session.id)
      .catch((error) => error);
    expect(cross.code).toBe("SESSION_FORBIDDEN");

    const job = await prisma.jobOpportunity.create({
      data: {
        userId: userA,
        companyId: (
          await prisma.company.create({
            data: { label: "Acme", value: `acme-${Date.now()}`, createdBy: userA },
          })
        ).id,
        title: "Backend",
      },
    });
    const jd = await prisma.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: job.id,
        versionNumber: 1,
        rawContent: "JD",
        capturedAt: new Date("2026-01-01T00:00:00Z"),
        contentHash: `hash-${Date.now()}`,
      },
    });
    const mismatchJob = await app
      .createInterviewSession({
        userId: userB,
        coachingMode: "PRACTICE",
        questions: [{ displayedText: "Q" }],
        jobOpportunityId: job.id,
        jobDescriptionVersionId: jd.id,
      })
      .catch((error) => error);
    expect(mismatchJob.code).toBe("CROSS_USER_RELATION");
  });
});
