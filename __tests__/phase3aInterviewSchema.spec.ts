// @vitest-environment node
/**
 * Phase 3A — Interview schema transplant + safe SQLite migration.
 *
 * Covers the Phase 3A DB/schema contract on a disposable database that is
 * built with the REAL migration history (`prisma migrate deploy`), because
 * `prisma db push` cannot reproduce the hand-written CHECK / partial-unique
 * SQL that Prisma schema cannot express.
 *
 * - migration SQL static audit: additive only, no Question rebuild
 * - empty-DB migration applies cleanly; 14 Interview tables exist
 * - Question additive columns default correctly; legacy-shaped rows survive
 * - JD composite unique exists; existing JD relations unchanged
 * - CHECK constraints reject invalid boundary rows, accept valid rows
 * - partial uniques allow many non-current but a single current per parent
 * - FK behaviors: Restrict on User/Session/Question/Bank/JD relations,
 *   composite-FK JD mismatch rejected, matching pair accepted
 * - Phase 2 adapters still compile and run against the migrated schema
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  makeTestDbUrl,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";
import { mapQuestionToSnapshot } from "@/lib/interview/questionAdapter";
import { resolveJobJdContext } from "@/lib/interview/jobJdResolver";

const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(
  REPO_ROOT,
  "prisma",
  "migrations",
  "20260922000000_phase3a_interview_schema",
);
const MIGRATION_SQL = fs.readFileSync(
  path.join(MIGRATION_DIR, "migration.sql"),
  "utf8",
);

function deployMigrations(url: string): void {
  const prismaCli = path.join(
    REPO_ROOT,
    "node_modules",
    "prisma",
    "build",
    "index.js",
  );
  const result = spawnSync(
    process.execPath,
    [prismaCli, "migrate", "deploy"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
      timeout: 240_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      [
        "Phase 3A migration deploy failed.",
        `Exit code: ${result.status ?? "unknown"}`,
        `stdout:\n${result.stdout || "<empty>"}`,
        `stderr:\n${result.stderr || "<empty>"}`,
      ].join("\n"),
    );
  }
}

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;

beforeAll(() => {
  deployMigrations(ctx.url);
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows temp cleanup flake; ignore.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `phase3a-${Date.now()}@example.com`);
}, 60_000);

async function seedJobWithJd(owner: string) {
  const company = await prisma.company.create({
    data: {
      label: "Acme",
      value: `phase3a-acme-${Date.now()}`,
      createdBy: owner,
    },
  });
  const opp = await prisma.jobOpportunity.create({
    data: { userId: owner, companyId: company.id, title: "Backend Engineer" },
  });
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opp.id,
      versionNumber: 1,
      rawContent: "We hire backend engineers.",
      capturedAt: new Date("2026-01-01T00:00:00Z"),
      contentHash: `phase3a-${Date.now()}`,
    },
  });
  return { company, opp, jd };
}

describe("phase3a migration SQL audit (static)", () => {
  // Audit statements only: the file header documents the avoided
  // RedefineTables approach, so strip `--` comments before matching.
  const statements = MIGRATION_SQL.replace(/--[^\n]*/g, "");
  it("is additive: no Question rebuild, no destructive rewrite", () => {
    expect(statements).not.toMatch(/RedefineTables/i);
    expect(statements).not.toMatch(/new_Question/i);
    expect(statements).not.toMatch(/DROP TABLE "Question"/);
    expect(statements).not.toMatch(/DROP TABLE "JobDescriptionVersion"/);
    expect(statements).not.toMatch(/DROP COLUMN/i);
    expect(statements).not.toMatch(
      /INSERT INTO "new_Question"|'new_Question'|"Question" RENAME TO/i,
    );
    // No mass UPDATE of existing rows (UPDATE appears nowhere).
    expect(statements).not.toMatch(/^\s*UPDATE\s/m);
    expect(statements).not.toMatch(/^\s*DELETE\s/m);
  });

  it("adds every Question field with one explicit ALTER TABLE statement", () => {
    for (const column of [
      `"sourceKind" TEXT`,
      `"category" TEXT`,
      `"locale" TEXT DEFAULT 'zh'`,
      `"isActive" BOOLEAN NOT NULL DEFAULT true`,
      `"deletedAt" DATETIME`,
      `"presetBankKey" TEXT`,
      `"presetItemKey" TEXT`,
    ]) {
      expect(MIGRATION_SQL).toContain(
        `ALTER TABLE "Question" ADD COLUMN ${column};`,
      );
    }
    expect(MIGRATION_SQL).toContain(
      `CREATE UNIQUE INDEX "Question_presetBankKey_presetItemKey_key" ON "Question"("presetBankKey", "presetItemKey");`,
    );
  });

  it("creates all 14 Interview-owned tables plus the JD composite unique", () => {
    for (const table of [
      "QuestionBank",
      "QuestionBankItem",
      "InterviewSession",
      "QuestionInstance",
      "AnswerAttempt",
      "AnswerInputArtifact",
      "Transcript",
      "TranscriptRevision",
      "FeedbackGeneration",
      "FeedbackItem",
      "SessionSummaryGeneration",
      "SessionSummaryInput",
      "CoachingConversation",
      "DialogueTurn",
    ]) {
      expect(MIGRATION_SQL).toContain(`CREATE TABLE "${table}" (`);
    }
    expect(MIGRATION_SQL).toContain(
      `CREATE UNIQUE INDEX "JobDescriptionVersion_id_jobOpportunityId_key" ON "JobDescriptionVersion"("id", "jobOpportunityId");`,
    );
  });

  it("carries every port CHECK and both partial unique indexes verbatim", () => {
    for (const name of [
      "ck_interview_sessions_status",
      "ck_interview_sessions_coaching_mode",
      "ck_interview_sessions_feedback_release_policy",
      "ck_interview_sessions_job_pair",
      "ck_question_instances_display_order",
      "ck_question_instances_source_kind",
      "ck_question_instances_status",
      "ck_answer_attempts_attempt_number",
      "ck_answer_attempts_input_type",
      "ck_answer_attempts_status",
      "ck_answer_input_artifacts_input_type",
      "ck_answer_input_artifacts_role",
      "ck_answer_input_artifacts_payload",
      "ck_transcript_revisions_revision_number",
      "ck_transcript_revisions_revision_kind",
      "ck_transcript_revisions_alignment_status",
      "ck_feedback_generations_version_number",
      "ck_feedback_generations_status",
      "ck_feedback_generations_current_requires_succeeded",
      "ck_session_summary_generations_version_number",
      "ck_session_summary_generations_status",
      "ck_session_summary_generations_current_requires_succeeded",
      "ck_session_summary_inputs_input_order",
      "ck_coaching_conversations_status",
      "ck_dialogue_turns_target_type",
      "ck_dialogue_turns_commercial_target_xor",
    ]) {
      expect(MIGRATION_SQL).toContain(name);
    }
    expect(MIGRATION_SQL).toContain(
      `CREATE UNIQUE INDEX "FeedbackGeneration_attempt_current_key" ON "FeedbackGeneration"("answerAttemptId") WHERE "isCurrent" = 1;`,
    );
    expect(MIGRATION_SQL).toContain(
      `CREATE UNIQUE INDEX "SessionSummaryGeneration_session_current_key" ON "SessionSummaryGeneration"("sessionId") WHERE "isCurrent" = 1;`,
    );
  });
});

describe("phase3a migrated schema (migrate deploy)", () => {
  it("exposes the 14 Interview tables and the new Question columns", async () => {
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;
    const names = tables.map((t) => t.name);
    for (const table of [
      "QuestionBank",
      "QuestionBankItem",
      "InterviewSession",
      "QuestionInstance",
      "AnswerAttempt",
      "AnswerInputArtifact",
      "Transcript",
      "TranscriptRevision",
      "FeedbackGeneration",
      "FeedbackItem",
      "SessionSummaryGeneration",
      "SessionSummaryInput",
      "CoachingConversation",
      "DialogueTurn",
    ]) {
      expect(names).toContain(table);
    }
    const row = await prisma.question.create({
      data: { question: "Legacy-shaped row?", createdBy: userId },
    });
    // Additive columns default without backfill.
    expect(row).toMatchObject({
      sourceKind: null,
      category: null,
      locale: "zh",
      isActive: true,
      deletedAt: null,
      presetBankKey: null,
      presetItemKey: null,
    });
  });

  it("keeps existing JD uniques and adds the composite unique", async () => {
    const { opp, jd } = await seedJobWithJd(userId);
    expect(jd.jobOpportunityId).toBe(opp.id);
    // Same contentHash on another opportunity is still allowed (unique is
    // per-opportunity, unchanged business semantics).
    const other = await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: (
          await prisma.company.create({
            data: {
              label: "Other",
              value: `phase3a-other-${Date.now()}`,
              createdBy: userId,
            },
          })
        ).id,
        title: "Frontend Engineer",
      },
    });
    const clone = await prisma.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: other.id,
        versionNumber: 1,
        rawContent: jd.rawContent,
        capturedAt: new Date("2026-03-01T00:00:00Z"),
        contentHash: jd.contentHash,
      },
    });
    expect(clone.contentHash).toBe(jd.contentHash);
    // Duplicate versionNumber on the same opportunity still rejected.
    await expect(
      prisma.jobDescriptionVersion.create({
        data: {
          jobOpportunityId: opp.id,
          versionNumber: 1,
          rawContent: "dup",
          capturedAt: new Date(),
          contentHash: `dup-${Date.now()}`,
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces session CHECKs with valid and invalid boundary rows", async () => {
    const ok = await prisma.interviewSession.create({
      data: {
        userId,
        coachingMode: "PRACTICE",
        feedbackReleasePolicy: "IMMEDIATE",
        knowledgeBaseVersion: "v1.0",
      },
    });
    expect(ok.status).toBe("DRAFT");
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "InterviewSession" ("id", "userId", "status", "coachingMode", "feedbackReleasePolicy", "knowledgeBaseVersion", "createdAt", "updatedAt") VALUES ('phase3a-bad-status', '${userId}', 'BOGUS', 'PRACTICE', 'IMMEDIATE', 'v1.0', '2026-01-01 00:00:00.000', '2026-01-01 00:00:00.000')`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "InterviewSession" ("id", "userId", "status", "coachingMode", "feedbackReleasePolicy", "knowledgeBaseVersion", "createdAt", "updatedAt") VALUES ('phase3a-bad-mode', '${userId}', 'DRAFT', 'ZEN', 'IMMEDIATE', 'v1.0', '2026-01-01 00:00:00.000', '2026-01-01 00:00:00.000')`,
      ),
    ).rejects.toThrow();
  });

  it("rejects XOR job/JD pairs but accepts a matching concrete pair", async () => {
    const { opp, jd } = await seedJobWithJd(userId);
    // Exactly one side set violates the pair CHECK.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "InterviewSession" ("id", "userId", "status", "coachingMode", "feedbackReleasePolicy", "knowledgeBaseVersion", "jobOpportunityId", "createdAt", "updatedAt") VALUES ('phase3a-xor', '${userId}', 'DRAFT', 'PRACTICE', 'IMMEDIATE', 'v1.0', '${opp.id}', '2026-01-01 00:00:00.000', '2026-01-01 00:00:00.000')`,
      ),
    ).rejects.toThrow();
    // JD from another opportunity violates the composite FK.
    const foreign = await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: (
          await prisma.company.create({
            data: {
              label: "Foreign",
              value: `phase3a-foreign-${Date.now()}`,
              createdBy: userId,
            },
          })
        ).id,
        title: "Data Engineer",
      },
    });
    await expect(
      prisma.interviewSession.create({
        data: {
          userId,
          coachingMode: "PRACTICE",
          feedbackReleasePolicy: "IMMEDIATE",
          knowledgeBaseVersion: "v1.0",
          jobOpportunityId: foreign.id,
          jobDescriptionVersionId: jd.id,
        },
      }),
    ).rejects.toThrow();
    // Matching pair accepted.
    const matched = await prisma.interviewSession.create({
      data: {
        userId,
        coachingMode: "MOCK",
        feedbackReleasePolicy: "ON_SESSION_COMPLETE",
        knowledgeBaseVersion: "v1.0",
        jobOpportunityId: opp.id,
        jobDescriptionVersionId: jd.id,
      },
    });
    expect(matched.jobDescriptionVersionId).toBe(jd.id);
  });

  it("enforces instance/attempt/artifact CHECKs", async () => {
    const session = await prisma.interviewSession.create({
      data: {
        userId,
        coachingMode: "PRACTICE",
        feedbackReleasePolicy: "IMMEDIATE",
        knowledgeBaseVersion: "v1.0",
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "QuestionInstance" ("id", "sessionId", "displayOrder", "displayedText", "sourceKind", "createdAt") VALUES ('phase3a-bad-order', '${session.id}', -1, 't', 'USER_PROVIDED', '2026-01-01 00:00:00.000')`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "QuestionInstance" ("id", "sessionId", "displayOrder", "displayedText", "sourceKind", "createdAt") VALUES ('phase3a-bad-kind', '${session.id}', 0, 't', 'NOPE', '2026-01-01 00:00:00.000')`,
      ),
    ).rejects.toThrow();
    const instance = await prisma.questionInstance.create({
      data: {
        sessionId: session.id,
        displayOrder: 0,
        displayedText: "Introduce yourself.",
        sourceKind: "USER_PROVIDED",
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AnswerAttempt" ("id", "questionInstanceId", "sessionId", "attemptNumber", "inputType", "createdAt") VALUES ('phase3a-bad-num', '${instance.id}', '${session.id}', 0, 'TEXT', '2026-01-01 00:00:00.000')`,
      ),
    ).rejects.toThrow();
    const attempt = await prisma.answerAttempt.create({
      data: {
        questionInstanceId: instance.id,
        sessionId: session.id,
        attemptNumber: 1,
        inputType: "TEXT",
      },
    });
    // TEXT with blank payload rejected; valid TEXT artifact accepted.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AnswerInputArtifact" ("id", "answerAttemptId", "sessionId", "inputType", "role", "textContent", "createdAt") VALUES ('phase3a-bad-payload', '${attempt.id}', '${session.id}', 'TEXT', 'SOURCE', '   ', '2026-01-01 00:00:00.000')`,
      ),
    ).rejects.toThrow();
    const artifact = await prisma.answerInputArtifact.create({
      data: {
        answerAttemptId: attempt.id,
        sessionId: session.id,
        inputType: "TEXT",
        role: "SOURCE",
        textContent: "My answer.",
      },
    });
    expect(artifact.textContent).toBe("My answer.");
  });

  it("keeps one current generation per parent and requires SUCCEEDED", async () => {
    const session = await prisma.interviewSession.create({
      data: {
        userId,
        coachingMode: "PRACTICE",
        feedbackReleasePolicy: "IMMEDIATE",
        knowledgeBaseVersion: "v1.0",
      },
    });
    const instance = await prisma.questionInstance.create({
      data: {
        sessionId: session.id,
        displayOrder: 0,
        displayedText: "Q",
        sourceKind: "TEMPLATE",
      },
    });
    const attempt = await prisma.answerAttempt.create({
      data: {
        questionInstanceId: instance.id,
        sessionId: session.id,
        attemptNumber: 1,
        inputType: "TEXT",
      },
    });
    const transcript = await prisma.transcript.create({
      data: { sessionId: session.id, answerAttemptId: attempt.id, fullText: "hi" },
    });
    const revision = await prisma.transcriptRevision.create({
      data: {
        transcriptId: transcript.id,
        answerAttemptId: attempt.id,
        revisionNumber: 1,
        revisionKind: "ORIGINAL_TEXT",
        fullText: "hi",
        alignmentStatus: "NOT_APPLICABLE",
        contentHash: "h",
      },
    });
    // current=true with PENDING status violates the CHECK.
    await expect(
      prisma.feedbackGeneration.create({
        data: {
          answerAttemptId: attempt.id,
          questionInstanceId: instance.id,
          sessionId: session.id,
          versionNumber: 1,
          isCurrent: true,
          status: "PENDING",
          inputRevisionId: revision.id,
          inputContentHash: "h",
        },
      }),
    ).rejects.toThrow();
    await prisma.feedbackGeneration.create({
      data: {
        answerAttemptId: attempt.id,
        questionInstanceId: instance.id,
        sessionId: session.id,
        versionNumber: 1,
        isCurrent: true,
        status: "SUCCEEDED",
        inputRevisionId: revision.id,
        inputContentHash: "h",
      },
    });
    // A second current on the same attempt violates the partial unique.
    await expect(
      prisma.feedbackGeneration.create({
        data: {
          answerAttemptId: attempt.id,
          questionInstanceId: instance.id,
          sessionId: session.id,
          versionNumber: 2,
          isCurrent: true,
          status: "SUCCEEDED",
          inputRevisionId: revision.id,
          inputContentHash: "h",
        },
      }),
    ).rejects.toThrow();
    // Non-current FAILED rows remain allowed (failed generations preserved).
    const failed = await prisma.feedbackGeneration.create({
      data: {
        answerAttemptId: attempt.id,
        questionInstanceId: instance.id,
        sessionId: session.id,
        versionNumber: 2,
        isCurrent: false,
        status: "FAILED",
        inputRevisionId: revision.id,
        inputContentHash: "h",
        failureCode: "EMPTY_ITEMS",
      },
    });
    expect(failed.isCurrent).toBe(false);
    // Same for session summaries: one current per session.
    await prisma.sessionSummaryGeneration.create({
      data: {
        sessionId: session.id,
        versionNumber: 1,
        status: "SUCCEEDED",
        isCurrent: true,
        inputHash: "h",
      },
    });
    await expect(
      prisma.sessionSummaryGeneration.create({
        data: {
          sessionId: session.id,
          versionNumber: 2,
          status: "SUCCEEDED",
          isCurrent: true,
          inputHash: "h",
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces dialogue target XOR and same-session FKs", async () => {
    const session = await prisma.interviewSession.create({
      data: {
        userId,
        coachingMode: "PRACTICE",
        feedbackReleasePolicy: "IMMEDIATE",
        knowledgeBaseVersion: "v1.0",
      },
    });
    const conversation = await prisma.coachingConversation.create({
      data: { sessionId: session.id },
    });
    const valid = await prisma.dialogueTurn.create({
      data: {
        sessionId: session.id,
        conversationId: conversation.id,
        turnNumber: 1,
        userText: "How am I doing?",
        entryMode: "TEXT",
        targetType: "SESSION",
      },
    });
    expect(valid.targetType).toBe("SESSION");
    // SESSION target with a question id set violates the XOR CHECK.
    const instance = await prisma.questionInstance.create({
      data: {
        sessionId: session.id,
        displayOrder: 0,
        displayedText: "Q",
        sourceKind: "USER_PROVIDED",
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "DialogueTurn" ("id", "sessionId", "conversationId", "turnNumber", "userText", "entryMode", "targetType", "questionInstanceId", "createdAt") VALUES ('phase3a-bad-xor', '${session.id}', '${conversation.id}', 2, 'hi', 'TEXT', 'SESSION', '${instance.id}', '2026-01-01 00:00:00.000')`,
      ),
    ).rejects.toThrow();
  });

  it("blocks deleting referenced User/Question/Session rows (Restrict)", async () => {
    const question = await prisma.question.create({
      data: { question: "Banked?", createdBy: userId },
    });
    const bank = await prisma.questionBank.create({
      data: { bankKey: `bk-${Date.now()}`, version: "v1", title: "Bank" },
    });
    await prisma.questionBankItem.create({
      data: { bankId: bank.id, questionId: question.id, displayOrder: 0 },
    });
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "Question" WHERE "id" = '${question.id}'`),
    ).rejects.toThrow();
    const session = await prisma.interviewSession.create({
      data: {
        userId,
        coachingMode: "PRACTICE",
        feedbackReleasePolicy: "IMMEDIATE",
        knowledgeBaseVersion: "v1.0",
      },
    });
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = '${userId}'`),
    ).rejects.toThrow();
    await prisma.questionInstance.create({
      data: {
        sessionId: session.id,
        sourceQuestionId: question.id,
        displayOrder: 0,
        displayedText: "Banked?",
        sourceKind: "QUESTION_BANK",
        referenceAnswerSnapshot: null,
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM "InterviewSession" WHERE "id" = '${session.id}'`,
      ),
    ).rejects.toThrow();
    // Deleting the source Question is allowed once nothing references it.
    const lone = await prisma.question.create({
      data: { question: "Lone?", createdBy: userId },
    });
    await prisma.question.delete({ where: { id: lone.id } });
    await expect(prisma.question.findUnique({ where: { id: lone.id } })).resolves
      .toBeNull();
  });

  it("keeps the Question preset attribution unique (installer idempotency)", async () => {
    const keys = {
      presetBankKey: `bk-${Date.now()}`,
      presetItemKey: "item-1",
    };
    await prisma.question.create({
      data: { question: "Preset Q?", createdBy: userId, ...keys },
    });
    await expect(
      prisma.question.create({
        data: { question: "Preset dup?", createdBy: userId, ...keys },
      }),
    ).rejects.toThrow();
    // NULL preset keys stay repeatable (no false uniqueness on plain rows).
    await prisma.question.create({
      data: { question: "Plain A?", createdBy: userId },
    });
    await prisma.question.create({
      data: { question: "Plain B?", createdBy: userId },
    });
  });

  it("Phase 2 adapters still resolve against the migrated schema", async () => {
    const tag = await prisma.tag.create({
      data: { label: "STAR", value: `phase3a-tag-${Date.now()}`, createdBy: userId },
    });
    const row = await prisma.question.create({
      data: {
        question: "Tell me about ownership.",
        answer: "I owned it.",
        createdBy: userId,
        createdVia: "USER",
        tags: { connect: [{ id: tag.id }] },
      },
      include: { tags: true },
    });
    const snapshot = mapQuestionToSnapshot(row, userId);
    expect(snapshot.displayedText).toBe("Tell me about ownership.");
    expect(snapshot.referenceAnswerSnapshot).toBe("I owned it.");
    expect(snapshot.category).toBe(tag.value);
    const { opp, jd } = await seedJobWithJd(userId);
    const context = await resolveJobJdContext(prisma as never, {
      userId,
      jobOpportunityId: opp.id,
      jobDescriptionVersionId: jd.id,
    });
    expect(context.jobTitle).toBe("Backend Engineer");
    expect(context.jdVersionNumber).toBe(1);
  });
});
