// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { createInterviewRuntime } from "@/lib/interview/services/application";
import { StaticKnowledgeProvider } from "@/lib/interview/services/knowledge";
import { DomainError } from "@/lib/interview/persistence/interviewErrors";
import { APP_CONSTANTS } from "@/lib/constants";
import type { InterviewModelPort } from "@/lib/interview/hostPorts";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient: Client } = await import("@prisma/client");
  return { default: new Client({ datasources: { db: { url: ctx.url } } }) };
});
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const originalUploads = APP_CONSTANTS.UPLOADS_DIR;

const modelPort: InterviewModelPort = {
  async resolveInterviewModel() {
    return {
      provider: "mock",
      model: "mock-v1",
      async generateJson({ prompt }) {
        if (prompt.includes("FEEDBACK_GENERATION")) {
          return {
            feedbackItems: [
              {
                problemLabel: "Missing Situation Context",
                suggestion: "Add context.",
                evidence: {
                  transcriptExcerpt: "I led the launch",
                  startOffset: 0,
                  endOffset: 16,
                  problemStatement: "x",
                  groundingSources: [],
                },
                explanation: {
                  underlyingCause: "skipped situation",
                  performanceImpact: "unclear",
                },
              },
            ],
          };
        }
        if (prompt.includes("SESSION_SUMMARY")) {
          return {
            bodyText: "Summary body",
            structuredPayload: {
              keyPatterns: ["p"],
              strengths: ["s"],
              developmentAreas: ["d"],
            },
          };
        }
        return { reply: "Follow-up reply" };
      },
    };
  },
};

describe("Phase 3C interview backup round-trip", () => {
  let userId: string;
  let email: string;

  beforeAll(async () => {
    const helpers = await import("./helpers/backupTestDb");
    const uploadsDir = path.join(ctx.dir, "uploads");
    fs.mkdirSync(path.join(uploadsDir, "files", "resumes"), { recursive: true });
    (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;
    email = `p3c-backup-${Date.now()}@example.com`;
    userId = await helpers.seedAccount(prisma, email);
    const app = createInterviewRuntime({
      db: prisma,
      modelPort,
      knowledge: new StaticKnowledgeProvider("v1.0", "kb", "hash"),
    });
    const { session, instances } = await app.createInterviewSession({
      userId,
      coachingMode: "PRACTICE",
      questions: [{ displayedText: "Tell me about a launch." }],
    });
    const submitted = await app.submitInterviewAnswer({
      userId,
      questionInstanceId: instances[0].id,
      textContent: "I led the launch of a billing rewrite.",
    });
    const feedback = await app.generateInterviewFeedback({
      userId,
      answerAttemptId: submitted.attempt.id,
    });
    if (feedback.generation.status !== "SUCCEEDED") {
      throw new DomainError("GENERATION_FAILED", "seed feedback failed");
    }
    await app.sendInterviewFollowUp({
      userId,
      sessionId: session.id,
      userText: "How should I open?",
    });
    const summary = await app.generateInterviewSummary({ userId, sessionId: session.id });
    if (summary.generation.status !== "SUCCEEDED") {
      throw new DomainError("GENERATION_FAILED", "seed summary failed");
    }
  }, 180_000);

  afterAll(async () => {
    (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
    await prisma.$disconnect();
    try {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("round-trips a Phase 3C-created interview graph", async () => {
    const { buffer } = await buildBackupZip(userId, email);
    const result = await importBackup(buffer, userId, email, true);
    expect(result.counts.InterviewSession).toBe(1);
    expect(result.counts.FeedbackItem).toBeGreaterThan(0);
    expect(result.counts.DialogueTurn).toBeGreaterThan(0);
    expect(result.counts.SessionSummaryGeneration).toBeGreaterThan(0);
    const session = await prisma.interviewSession.findFirstOrThrow({ where: { userId } });
    const turns = await prisma.dialogueTurn.findMany({ where: { sessionId: session.id } });
    expect(turns[0]?.assistantReply).toBe("Follow-up reply");
    const summary = await prisma.sessionSummaryGeneration.findFirstOrThrow({
      where: { sessionId: session.id, isCurrent: true },
    });
    expect(summary.bodyText).toBe("Summary body");
  });
});
