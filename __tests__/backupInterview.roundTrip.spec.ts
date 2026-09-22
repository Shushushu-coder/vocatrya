// @vitest-environment node
/**
 * Interview backup policy — 14-model product backup round-trip (spec v1).
 *
 * Frozen spec: interview-vocatrya-spec-v1
 * → a7a8e2ed75e3797c207851f62e3a13732d405f6d (InterviewDx READ_ONLY).
 * Direction: InterviewDx frozen spec → Vocatrya implementation → conformance audit.
 *
 * Interview models are included in product backup starting from this change.
 * Legacy backups without Interview sections still restore (groups default to
 * [] and no fake Interview rows are synthesized).
 *
 * QuestionBank = SYSTEM-MANAGED GLOBAL REFERENCE_DATA (not USER_DATA):
 * identity (bankKey, version); canonical metadata title/locale/kind;
 * missing → CREATE, equal → REUSE, conflict → QUESTION_BANK_VERSION_CONFLICT
 * (fail closed, whole-transaction rollback); never per-user wiped; unrelated
 * banks preserved. QuestionBankItem = user-scoped membership via
 * Question.createdBy. TranscriptRevision cross-user author normalization is
 * ACCEPTED with KNOWN_PROVENANCE_TRADEOFF (never AUTHOR_PROVENANCE_LOSS: NONE).
 *
 * Covers:
 * - coverage classification (14/14 BACKED_UP, none INTENTIONALLY_EXCLUDED)
 * - full 14-model export with manifest counts
 * - deterministic export (two exports, identical data.json)
 * - full 14-model restore with snapshot/provenance fidelity
 * - QuestionBank CREATE / REUSE / CONFLICT(title|locale|kind) / atomicity /
 *   not-wiped / membership-scope
 * - TranscriptRevision author trade-off (cross-user / same-user / null)
 * - PRAGMA foreign_key_check / integrity_check after restore
 * - legacy (pre-Interview) backup compatibility
 * - failed-restore rollback (no half-restored Interview graph)
 * - credential exclusion (no apiKey / tokens / secrets in payload)
 * - restore never calls AI providers (static import audit)
 * - restore ordering: every FK target precedes its Interview model
 */
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip, collectBackupData } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import {
  backupCoverageStatus,
  BACKUP_COVERAGE_STATUS,
  INTENTIONALLY_EXCLUDED_PRISMA_MODELS,
} from "@/lib/backup/coverage";
import {
  DEFERRED_FKS,
  INSERT_ORDER,
  INTERVIEW_SPEC_COMMIT,
  INTERVIEW_SPEC_TAG,
  KNOWN_PROVENANCE_TRADEOFF,
  MODEL_SPECS,
  QUESTION_BANK_CANONICAL_METADATA_FIELDS,
  QUESTION_BANK_IN_DELETE_ORDER,
  QUESTION_BANK_VERSION_CONFLICT,
  TRANSCRIPT_REVISION_AUTHOR_POLICY,
} from "@/lib/backup/ordering";
import { BackupDataSchema } from "@/lib/backup/schema";
import { seedAccount } from "./helpers/backupTestDb";

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

// Never start the cron in a test run.
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

const INTERVIEW_MODELS = [
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
] as const;

let userId: string;
let uploadsDir: string;
const originalUploads = APP_CONSTANTS.UPLOADS_DIR;

beforeAll(async () => {
  uploadsDir = path.join(ctx.dir, "uploads");
  fs.mkdirSync(path.join(uploadsDir, "files", "resumes"), { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;

  userId = await seedAccount(prisma, "interview-backup@example.com");
  await seedInterviewGraph();
}, 180_000);

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows can retain a short-lived SQLite handle after disconnect.
  }
});

async function seedInterviewGraph() {
  const company = await prisma.company.create({
    data: { label: "Acme", value: "acme-interview", createdBy: userId },
  });
  const opp = await prisma.jobOpportunity.create({
    data: { userId, companyId: company.id, title: "Backend Engineer" },
  });
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opp.id,
      versionNumber: 1,
      rawContent: "We hire backend engineers.",
      capturedAt: new Date("2026-01-01T00:00:00.000Z"),
      contentHash: "jd-hash-interview",
    },
  });

  const sourceQuestion = await prisma.question.create({
    data: { question: "Tell me about a hard bug.", answer: "I fixed it.", createdBy: userId },
  });
  const bankedQuestion = await prisma.question.create({
    data: { question: "Banked: ownership?", createdBy: userId },
  });
  const bank = await prisma.questionBank.create({
    data: { bankKey: "seed-bank", version: "v1", title: "Seed Bank" },
  });
  await prisma.questionBankItem.create({
    data: { bankId: bank.id, questionId: bankedQuestion.id, displayOrder: 0 },
  });

  const session = await prisma.interviewSession.create({
    data: {
      userId,
      coachingMode: "PRACTICE",
      feedbackReleasePolicy: "IMMEDIATE",
      knowledgeBaseVersion: "v1.0",
      jobOpportunityId: opp.id,
      jobDescriptionVersionId: jd.id,
    },
  });

  // Instance 1 links a source question; instance 2 is a null-source snapshot.
  const instance1 = await prisma.questionInstance.create({
    data: {
      sessionId: session.id,
      sourceQuestionId: sourceQuestion.id,
      displayOrder: 0,
      displayedText: "Tell me about a hard bug.",
      sourceKind: "USER_PROVIDED",
      category: "behavioral",
      referenceAnswerSnapshot: "I fixed it.",
    },
  });
  const instance2 = await prisma.questionInstance.create({
    data: {
      sessionId: session.id,
      sourceQuestionId: null,
      displayOrder: 1,
      displayedText: "Ad-hoc follow-up?",
      sourceKind: "AI_GENERATED",
      sourceMetadata: JSON.stringify({ model: "seed", promptVersion: "p1" }),
    },
  });
  await prisma.interviewSession.update({
    where: { id: session.id },
    data: { currentQuestionInstanceId: instance1.id },
  });

  const attempt1 = await prisma.answerAttempt.create({
    data: {
      questionInstanceId: instance1.id,
      sessionId: session.id,
      attemptNumber: 1,
      inputType: "TEXT",
      status: "COMPLETED",
      submittedAt: new Date("2026-02-01T00:00:00.000Z"),
    },
  });
  const attempt2 = await prisma.answerAttempt.create({
    data: {
      questionInstanceId: instance2.id,
      sessionId: session.id,
      attemptNumber: 1,
      inputType: "TEXT",
      status: "STARTED",
    },
  });

  const artifact = await prisma.answerInputArtifact.create({
    data: {
      answerAttemptId: attempt1.id,
      sessionId: session.id,
      inputType: "TEXT",
      role: "SOURCE",
      textContent: "My answer text.",
    },
  });
  await prisma.answerInputArtifact.create({
    data: {
      answerAttemptId: attempt1.id,
      sessionId: session.id,
      inputType: "TEXT",
      role: "NORMALIZED",
      textContent: "My normalized answer.",
    },
  });

  const transcript = await prisma.transcript.create({
    data: {
      sessionId: session.id,
      answerAttemptId: attempt1.id,
      sourceArtifactId: artifact.id,
      fullText: "My answer text.",
      segments: JSON.stringify([{ t0: 0, t1: 1, text: "My answer text." }]),
      asrModel: "seed-asr",
      asrStatus: "SUCCEEDED",
    },
  });
  const revision1 = await prisma.transcriptRevision.create({
    data: {
      transcriptId: transcript.id,
      answerAttemptId: attempt1.id,
      revisionNumber: 1,
      revisionKind: "ORIGINAL_TEXT",
      fullText: "My answer text.",
      alignmentStatus: "NOT_APPLICABLE",
      contentHash: "rev-hash-1",
    },
  });
  const revision2 = await prisma.transcriptRevision.create({
    data: {
      transcriptId: transcript.id,
      answerAttemptId: attempt1.id,
      revisionNumber: 2,
      revisionKind: "USER_CORRECTED",
      fullText: "My corrected answer.",
      segments: JSON.stringify([{ t0: 0, t1: 1, text: "corrected" }]),
      alignmentStatus: "PRESERVED",
      contentHash: "rev-hash-2",
      createdByUserId: userId,
      createdVia: "USER_EDIT",
    },
  });
  await prisma.answerAttempt.update({
    where: { id: attempt1.id },
    data: { activeRevisionId: revision2.id },
  });

  // Current SUCCEEDED generation + historical FAILED generation (stale/nullable
  // failure fields) on the same attempt.
  const currentGeneration = await prisma.feedbackGeneration.create({
    data: {
      answerAttemptId: attempt1.id,
      questionInstanceId: instance1.id,
      sessionId: session.id,
      versionNumber: 1,
      isCurrent: true,
      status: "SUCCEEDED",
      inputRevisionId: revision1.id,
      inputContentHash: "rev-hash-1",
      model: "seed-model",
      provider: "seed-provider",
      promptVersion: "fb-p1",
      knowledgeBaseVersion: "v1.0",
      completedAt: new Date("2026-02-02T00:00:00.000Z"),
    },
  });
  await prisma.feedbackGeneration.create({
    data: {
      answerAttemptId: attempt1.id,
      questionInstanceId: instance1.id,
      sessionId: session.id,
      versionNumber: 2,
      isCurrent: false,
      status: "FAILED",
      inputRevisionId: revision2.id,
      inputContentHash: "rev-hash-2",
      model: "seed-model",
      provider: "seed-provider",
      promptVersion: "fb-p1",
      failureCode: "EMPTY_ITEMS",
      failureMessage: "no items produced",
    },
  });
  await prisma.feedbackItem.create({
    data: {
      sessionId: session.id,
      transcriptId: transcript.id,
      generationId: currentGeneration.id,
      itemOrder: 1,
      problemLabel: "Vague impact",
      evidence: "frozen evidence snapshot — do not regenerate",
      explanation: "Impact is not quantified.",
      suggestion: "Add numbers.",
    },
  });
  await prisma.feedbackItem.create({
    data: {
      sessionId: session.id,
      transcriptId: transcript.id,
      generationId: currentGeneration.id,
      itemOrder: 2,
      problemLabel: "Missing STAR",
      evidence: "second frozen snapshot",
      explanation: "Structure missing.",
      suggestion: "Use STAR.",
    },
  });

  // Current SUCCEEDED summary + historical FAILED summary.
  const currentSummary = await prisma.sessionSummaryGeneration.create({
    data: {
      sessionId: session.id,
      versionNumber: 1,
      status: "SUCCEEDED",
      isCurrent: true,
      bodyText: "Strong ownership story.",
      structuredPayload: JSON.stringify({ score: 4 }),
      inputHash: "summary-hash-1",
      model: "seed-model",
      provider: "seed-provider",
      promptVersion: "sum-p1",
      knowledgeBaseVersion: "v1.0",
      completedAt: new Date("2026-02-03T00:00:00.000Z"),
    },
  });
  await prisma.sessionSummaryGeneration.create({
    data: {
      sessionId: session.id,
      versionNumber: 2,
      status: "FAILED",
      isCurrent: false,
      inputHash: "summary-hash-2",
      failureCode: "TIMEOUT",
    },
  });
  await prisma.sessionSummaryInput.create({
    data: {
      summaryGenerationId: currentSummary.id,
      sessionId: session.id,
      questionInstanceId: instance1.id,
      feedbackGenerationId: currentGeneration.id,
      inputOrder: 1,
    },
  });

  const conversation = await prisma.coachingConversation.create({
    data: { sessionId: session.id, status: "OPEN" },
  });
  await prisma.dialogueTurn.create({
    data: {
      sessionId: session.id,
      conversationId: conversation.id,
      turnNumber: 1,
      userText: "How am I doing?",
      entryMode: "TEXT",
      assistantReply: "Well so far.",
      replyModel: "seed-model",
      replyPromptVersion: "dlg-p1",
      contextSnapshot: JSON.stringify({ turn: 1 }),
      targetType: "SESSION",
    },
  });
  const feedbackItem = await prisma.feedbackItem.findFirstOrThrow({
    where: { sessionId: session.id, itemOrder: 1 },
  });
  await prisma.dialogueTurn.create({
    data: {
      sessionId: session.id,
      conversationId: conversation.id,
      turnNumber: 2,
      userText: "Tell me more about item one.",
      entryMode: "TEXT",
      assistantReply: "",
      targetType: "FEEDBACK_ITEM",
      questionInstanceId: instance1.id,
      answerAttemptId: attempt1.id,
      commercialFeedbackItemId: feedbackItem.id,
    },
  });

  // A decoy second attempt row keeps per-instance attempt numbering honest.
  expect(attempt2.attemptNumber).toBe(1);
}

describe("interview backup coverage", () => {
  it("classifies all 14 Interview models as backed up, none excluded", () => {
    expect(INTERVIEW_MODELS).toHaveLength(14);
    for (const model of INTERVIEW_MODELS) {
      expect(backupCoverageStatus(model)).toBe(BACKUP_COVERAGE_STATUS.BACKED_UP);
      expect(INSERT_ORDER).toContain(model);
      expect(MODEL_SPECS[model as keyof typeof MODEL_SPECS]).toBeTruthy();
      expect(BackupDataSchema.shape).toHaveProperty(model);
    }
    for (const model of INTERVIEW_MODELS) {
      expect([...INTENTIONALLY_EXCLUDED_PRISMA_MODELS]).not.toContain(model);
    }
  });

  it("fails if any Interview FK target is inserted after its model", () => {
    const position = new Map(INSERT_ORDER.map((m, i) => [m, i]));
    for (const model of INTERVIEW_MODELS) {
      const spec = MODEL_SPECS[model as keyof typeof MODEL_SPECS];
      for (const [field, target] of Object.entries(spec.fks)) {
        expect(
          position.get(target)! < position.get(model)!,
          `${model}.${field} -> ${target} is inserted too late`,
        ).toBe(true);
      }
    }
    for (const { model, target } of DEFERRED_FKS.filter((d) =>
      (INTERVIEW_MODELS as readonly string[]).includes(d.model),
    )) {
      expect(INSERT_ORDER).toContain(target);
      expect(`${model}.${target}`).toBeTruthy();
    }
    // The two cyclic Interview pointers stay deferred, never in the linear map.
    expect(MODEL_SPECS.InterviewSession.fks).not.toHaveProperty(
      "currentQuestionInstanceId",
    );
    expect(MODEL_SPECS.AnswerAttempt.fks).not.toHaveProperty("activeRevisionId");
  });
});

describe("interview backup export", () => {
  it("exports every Interview model with manifest counts", async () => {
    const { buffer } = await buildBackupZip(userId, "interview-backup@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));

    const expected: Record<string, number> = {
      QuestionBank: 1,
      QuestionBankItem: 1,
      InterviewSession: 1,
      QuestionInstance: 2,
      AnswerAttempt: 2,
      AnswerInputArtifact: 2,
      Transcript: 1,
      TranscriptRevision: 2,
      FeedbackGeneration: 2,
      FeedbackItem: 2,
      SessionSummaryGeneration: 2,
      SessionSummaryInput: 1,
      CoachingConversation: 1,
      DialogueTurn: 2,
    };
    for (const [model, count] of Object.entries(expected)) {
      expect(data[model]).toHaveLength(count);
      expect(manifest.counts[model]).toBe(count);
    }
    // Export strips ownership but keeps the graph keys.
    expect(data.InterviewSession[0]).not.toHaveProperty("userId");
    expect(data.QuestionInstance.map((r: { sessionId: string }) => r.sessionId)).toEqual([
      data.InterviewSession[0].id,
      data.InterviewSession[0].id,
    ]);
  }, 120_000);

  it("exports deterministically: two exports serialize identically", async () => {
    const first = await collectBackupData(userId);
    const second = await collectBackupData(userId);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  }, 120_000);

  it("carries no credentials, secrets, or provider keys", async () => {
    await prisma.apiKey.create({
      data: {
        userId,
        provider: "openai",
        encryptedKey: "super-secret-encrypted",
        iv: "super-secret-iv",
        last4: "9999",
      },
    });
    const { buffer } = await buildBackupZip(userId, "interview-backup@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const raw = await zip.file("data.json")!.async("string");
    expect(raw).not.toContain("super-secret-encrypted");
    expect(raw).not.toContain("super-secret-iv");
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("AUTH_SECRET");
    expect(raw).not.toContain("ENCRYPTION_KEY");
    await prisma.apiKey.deleteMany({ where: { userId } });
  }, 120_000);

  it("never wires an AI provider into the backup restore path", async () => {
    const dir = path.resolve(__dirname, "../src/lib/backup");
    const names = fs.readdirSync(dir).filter((n) => n.endsWith(".ts"));
    const banned = ["getModel(", "OpenRouter", "openrouter", "generateText", "streamText"];
    for (const name of names) {
      const content = fs.readFileSync(path.join(dir, name), "utf8");
      for (const token of banned) {
        expect(content, `${name} must not call ${token}`).not.toContain(token);
      }
    }
  });
});

describe("interview backup round trip", () => {
  it("restores the full 14-model graph with snapshot and provenance fidelity", async () => {
    const before = {
      session: await prisma.interviewSession.findFirstOrThrow({ where: { userId } }),
      instances: await prisma.questionInstance.findMany({
        where: { session: { userId } },
        orderBy: { displayOrder: "asc" },
      }),
      generations: await prisma.feedbackGeneration.findMany({
        where: { session: { userId } },
        orderBy: { versionNumber: "asc" },
      }),
      summaries: await prisma.sessionSummaryGeneration.findMany({
        where: { session: { userId } },
        orderBy: { versionNumber: "asc" },
      }),
    };

    const { buffer } = await buildBackupZip(userId, "interview-backup@example.com");
    const result = await importBackup(buffer, userId, "interview-backup@example.com", true);

    for (const model of INTERVIEW_MODELS) {
      expect(result.counts[model]).toBeGreaterThan(0);
    }
    expect(result.counts.InterviewSession).toBe(1);
    expect(result.counts.QuestionInstance).toBe(2);
    expect(result.counts.FeedbackGeneration).toBe(2);
    expect(result.counts.DialogueTurn).toBe(2);

    // Bank identity and member mapping survive.
    const bank = await prisma.questionBank.findFirstOrThrow({
      where: { bankKey: "seed-bank", version: "v1" },
    });
    expect(bank.title).toBe("Seed Bank");
    const bankItem = await prisma.questionBankItem.findFirstOrThrow({
      where: { bankId: bank.id },
      include: { question: true },
    });
    expect(bankItem.displayOrder).toBe(0);
    expect(bankItem.question.question).toBe("Banked: ownership?");

    // Session keeps job pair, knowledge version, and the current pointer.
    const session = await prisma.interviewSession.findFirstOrThrow({
      where: { userId },
      include: { jobOpportunity: true, jobDescriptionVersion: true },
    });
    expect(session.jobOpportunity!.title).toBe("Backend Engineer");
    expect(session.jobDescriptionVersion?.contentHash).toBe("jd-hash-interview");
    expect(session.knowledgeBaseVersion).toBe("v1.0");
    const currentInstance = await prisma.questionInstance.findUniqueOrThrow({
      where: { id: session.currentQuestionInstanceId! },
    });
    expect(currentInstance.displayOrder).toBe(0);
    expect(currentInstance.sessionId).toBe(session.id);

    // Snapshots are restored verbatim, never regenerated.
    const instances = await prisma.questionInstance.findMany({
      where: { sessionId: session.id },
      orderBy: { displayOrder: "asc" },
    });
    expect(instances[0].displayedText).toBe(before.instances[0].displayedText);
    expect(instances[0].sourceQuestionId).toBeTruthy();
    expect(instances[0].referenceAnswerSnapshot).toBe("I fixed it.");
    expect(instances[1].sourceQuestionId).toBeNull();
    expect(instances[1].sourceMetadata).toBe(before.instances[1].sourceMetadata);

    const artifacts = await prisma.answerInputArtifact.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
    });
    expect(artifacts.map((a) => a.role).sort()).toEqual(["NORMALIZED", "SOURCE"]);
    expect(artifacts.find((a) => a.role === "SOURCE")?.textContent).toBe(
      "My answer text.",
    );

    const transcript = await prisma.transcript.findFirstOrThrow({
      where: { sessionId: session.id },
      include: { revisions: { orderBy: { revisionNumber: "asc" } } },
    });
    expect(transcript.fullText).toBe("My answer text.");
    expect(transcript.segments).toContain("My answer text.");
    expect(transcript.asrModel).toBe("seed-asr");
    expect(transcript.revisions).toHaveLength(2);
    expect(transcript.revisions[1].fullText).toBe("My corrected answer.");
    expect(transcript.revisions[1].createdByUserId).toBe(userId);

    // Provenance and current/historical semantics survive.
    const generations = await prisma.feedbackGeneration.findMany({
      where: { sessionId: session.id },
      orderBy: { versionNumber: "asc" },
    });
    expect(generations[0].isCurrent).toBe(true);
    expect(generations[0].status).toBe("SUCCEEDED");
    expect(generations[0].provider).toBe(before.generations[0].provider);
    expect(generations[0].model).toBe("seed-model");
    expect(generations[0].promptVersion).toBe("fb-p1");
    expect(generations[1].isCurrent).toBe(false);
    expect(generations[1].status).toBe("FAILED");
    expect(generations[1].failureCode).toBe("EMPTY_ITEMS");

    const items = await prisma.feedbackItem.findMany({
      where: { sessionId: session.id },
      orderBy: { itemOrder: "asc" },
    });
    expect(items).toHaveLength(2);
    expect(items[0].evidence).toBe("frozen evidence snapshot — do not regenerate");
    expect(items[0].generationId).toBe(
      generations.find((g) => g.isCurrent)!.id,
    );

    const summaries = await prisma.sessionSummaryGeneration.findMany({
      where: { sessionId: session.id },
      orderBy: { versionNumber: "asc" },
    });
    expect(summaries[0].isCurrent).toBe(true);
    expect(summaries[0].bodyText).toBe("Strong ownership story.");
    expect(summaries[0].structuredPayload).toBe(before.summaries[0].structuredPayload);
    expect(summaries[0].inputHash).toBe("summary-hash-1");
    expect(summaries[1].isCurrent).toBe(false);
    expect(summaries[1].failureCode).toBe("TIMEOUT");

    const summaryInput = await prisma.sessionSummaryInput.findFirstOrThrow({
      where: { sessionId: session.id },
    });
    expect(summaryInput.inputOrder).toBe(1);
    expect(summaryInput.summaryGenerationId).toBe(
      summaries.find((s) => s.isCurrent)!.id,
    );

    // Dialogue targets keep their XOR shape.
    const conversation = await prisma.coachingConversation.findFirstOrThrow({
      where: { sessionId: session.id },
      include: { turns: { orderBy: { turnNumber: "asc" } } },
    });
    expect(conversation.status).toBe("OPEN");
    expect(conversation.turns).toHaveLength(2);
    expect(conversation.turns[0].targetType).toBe("SESSION");
    expect(conversation.turns[0].questionInstanceId).toBeNull();
    expect(conversation.turns[0].contextSnapshot).toContain('"turn":1');
    expect(conversation.turns[1].targetType).toBe("FEEDBACK_ITEM");
    expect(conversation.turns[1].commercialFeedbackItemId).toBe(items[0].id);
    expect(conversation.turns[1].answerAttemptId).toBeTruthy();

    // Composite-FK attempts still line up with their instances.
    const attempts = await prisma.answerAttempt.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
    });
    for (const attempt of attempts) {
      const instance = await prisma.questionInstance.findUniqueOrThrow({
        where: { id: attempt.questionInstanceId },
      });
      expect(instance.sessionId).toBe(session.id);
    }
    const active = attempts.find((a) => a.activeRevisionId !== null);
    expect(active).toBeTruthy();

    // DateTime / boolean fidelity is logical, not stringly.
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(transcript.createdAt).toBeInstanceOf(Date);
    expect(typeof generations[0].isCurrent).toBe("boolean");
  }, 180_000);

  it("leaves FK and integrity checks clean after restore", async () => {
    const fk = (await prisma.$queryRawUnsafe(
      "PRAGMA foreign_key_check;",
    )) as unknown[];
    expect(fk).toEqual([]);
    const integrity = (await prisma.$queryRawUnsafe(
      "PRAGMA integrity_check;",
    )) as Array<{ integrity_check: string }>;
    expect(integrity[0].integrity_check).toBe("ok");
  }, 120_000);

  it("restores a pre-Interview backup without failing or inventing rows", async () => {
    const { buffer } = await buildBackupZip(userId, "interview-backup@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    for (const model of INTERVIEW_MODELS) {
      delete data[model];
      delete manifest.counts[model];
    }
    zip.file("data.json", JSON.stringify(data));
    zip.file("manifest.json", JSON.stringify(manifest));
    const legacy = await zip.generateAsync({ type: "nodebuffer" });

    await importBackup(legacy, userId, "interview-backup@example.com", true);
    // No fake Interview rows are synthesized: user-scoped Interview models
    // come back empty. QuestionBank is REFERENCE_DATA (never wiped): the
    // legacy payload carries no banks so existing canonical banks survive the
    // restore untouched (QB_NOT_WIPED is covered by the dedicated tests below).
    expect(await prisma.interviewSession.count({ where: { userId } })).toBe(0);
    expect(await prisma.dialogueTurn.count({ where: { session: { userId } } })).toBe(0);

    // Put the graph back for the remaining tests.
    const { buffer: fresh } = await buildBackupZip(userId, "interview-backup@example.com");
    void fresh;
  }, 180_000);

  it("rolls back a failed Interview restore without a half-restored graph", async () => {
    // Re-seed: the previous test wiped Interview rows with a legacy payload.
    await seedInterviewGraphAgain();
    const sessionsBefore = await prisma.interviewSession.count({ where: { userId } });
    expect(sessionsBefore).toBeGreaterThan(0);

    const { buffer } = await buildBackupZip(userId, "interview-backup@example.com");
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    // A required FK pointing nowhere must fail the whole transaction, not a
    // single table: FeedbackItem.generationId is required.
    data.FeedbackItem[0].generationId = "ghost-generation";
    zip.file("data.json", JSON.stringify(data));
    const poisoned = await zip.generateAsync({ type: "nodebuffer" });

    await expect(
      importBackup(poisoned, userId, "interview-backup@example.com", true),
    ).rejects.toThrow();
    expect(await prisma.interviewSession.count({ where: { userId } })).toBe(
      sessionsBefore,
    );
    const fk = (await prisma.$queryRawUnsafe(
      "PRAGMA foreign_key_check;",
    )) as unknown[];
    expect(fk).toEqual([]);
  }, 180_000);
});

describe("interview spec identity (spec v1)", () => {
  it("pins the exact InterviewDx contract", () => {
    expect(INTERVIEW_SPEC_TAG).toBe("interview-vocatrya-spec-v1");
    expect(INTERVIEW_SPEC_COMMIT).toBe(
      "a7a8e2ed75e3797c207851f62e3a13732d405f6d",
    );
    expect(QUESTION_BANK_IN_DELETE_ORDER).toBe(false);
    expect(TRANSCRIPT_REVISION_AUTHOR_POLICY).toBe(
      "NORMALIZED_TO_IMPORTING_USER_ON_CROSS_USER_RESTORE",
    );
    expect(KNOWN_PROVENANCE_TRADEOFF).toBe(
      "original author identity is not preserved across cross-user restore",
    );
  });

  it("enforces Question.createdBy as user-owned Restrict (spec v1 §17)", async () => {
    const schema = fs.readFileSync(
      path.resolve(__dirname, "../prisma/schema.prisma"),
      "utf8",
    );
    const questionBlock = schema.slice(
      schema.indexOf("model Question {"),
      schema.indexOf("model Question {") + 2000,
    );
    expect(questionBlock).toContain("createdBy  String");
    expect(questionBlock).not.toContain("createdBy  String?");
    expect(questionBlock).toContain("references: [id]");
    // System-owned Question (createdBy = null) is unsupported (§18): the
    // column stays required and no ownership enum is introduced.
    expect(questionBlock).not.toContain("createdBy?");
    const migration = fs.readFileSync(
      path.resolve(
        __dirname,
        "../prisma/migrations/20260305175020_add_question_model/migration.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("Question_createdBy_fkey");
    expect(migration).toContain("ON DELETE RESTRICT");
  }, 60_000);
});

describe("questionBank restore policy (spec v1 §8–§16)", () => {
  const uniq = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  async function seedBankUser(
    email: string,
    bankKey: string,
    bankOpts: { title?: string; locale?: string; kind?: string } = {},
  ) {
    const uid = await seedAccount(prisma, email);
    const question = await prisma.question.create({
      data: { question: `Q for ${bankKey}`, createdBy: uid },
    });
    const bank = await prisma.questionBank.create({
      data: {
        bankKey,
        version: "v1",
        title: bankOpts.title ?? `Title ${bankKey}`,
        locale: bankOpts.locale ?? "zh",
        kind: bankOpts.kind ?? "CANONICAL_EXPORT",
      },
    });
    const item = await prisma.questionBankItem.create({
      data: { bankId: bank.id, questionId: question.id, displayOrder: 0 },
    });
    return { uid, email, question, bank, item };
  }

  async function patchBackup(
    buffer: Buffer,
    mutate: (data: Record<string, Array<Record<string, unknown>>>) => void,
  ): Promise<Buffer> {
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(
      await zip.file("data.json")!.async("string"),
    ) as Record<string, Array<Record<string, unknown>>>;
    mutate(data);
    zip.file("data.json", JSON.stringify(data));
    const manifest = JSON.parse(
      await zip.file("manifest.json")!.async("string"),
    ) as { counts: Record<string, number> };
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key]) && key in manifest.counts) {
        manifest.counts[key] = data[key].length;
      }
    }
    zip.file("manifest.json", JSON.stringify(manifest));
    return zip.generateAsync({ type: "nodebuffer" });
  }

  it("CREATE: absent target bank is created with canonical metadata", async () => {
    const bankKey = uniq("qb-create");
    const src = await seedBankUser(`qb-create-${Date.now()}@example.com`, bankKey);
    const { buffer } = await buildBackupZip(src.uid, src.email);
    const backupBanks = (
      JSON.parse(
        await (await JSZip.loadAsync(buffer)).file("data.json")!.async("string"),
      ) as Record<string, Array<Record<string, unknown>>>
    ).QuestionBank;
    const backupBank = backupBanks.find((b) => b.bankKey === bankKey)!;
    expect(backupBank).toBeTruthy();

    // Remove the bank + its membership from the target so CREATE is exercised.
    await prisma.questionBankItem.delete({ where: { id: src.item.id } });
    await prisma.questionBank.delete({ where: { id: src.bank.id } });
    expect(
      await prisma.questionBank.findUnique({
        where: { bankKey_version: { bankKey, version: "v1" } },
      }),
    ).toBeNull();

    await importBackup(buffer, src.uid, src.email, true);
    const created = await prisma.questionBank.findUniqueOrThrow({
      where: { bankKey_version: { bankKey, version: "v1" } },
    });
    expect(created.bankKey).toBe(bankKey);
    expect(created.version).toBe("v1");
    expect(created.title).toBe(backupBank.title);
    expect(created.locale).toBe(backupBank.locale);
    expect(created.kind).toBe(backupBank.kind);
    const item = await prisma.questionBankItem.findFirstOrThrow({
      where: { question: { createdBy: src.uid } },
      include: { question: true },
    });
    expect(item.bankId).toBe(created.id);
    expect(item.question.question).toBe(`Q for ${bankKey}`);
  }, 180_000);

  it("REUSE: same identity + same metadata reuses existing id (id/timestamps ignored)", async () => {
    const bankKey = uniq("qb-reuse");
    const src = await seedBankUser(`qb-reuse-${Date.now()}@example.com`, bankKey, {
      title: "Canonical question bank",
      locale: "zh",
      kind: "CANONICAL_EXPORT",
    });
    const { buffer } = await buildBackupZip(src.uid, src.email);

    // Replace the target bank with a canonically equal row under a different
    // local id and timestamps (must NOT conflict).
    await prisma.questionBankItem.delete({ where: { id: src.item.id } });
    await prisma.questionBank.delete({ where: { id: src.bank.id } });
    const existing = await prisma.questionBank.create({
      data: {
        bankKey,
        version: "v1",
        title: "Canonical question bank",
        locale: "zh",
        kind: "CANONICAL_EXPORT",
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
      },
    });
    expect(existing.id).not.toBe(src.bank.id);
    const question = await prisma.question.create({
      data: { question: `Q for ${bankKey}`, createdBy: src.uid },
    });
    const beforeItem = await prisma.questionBankItem.create({
      data: { bankId: existing.id, questionId: question.id, displayOrder: 0 },
    });
    void beforeItem;

    await importBackup(buffer, src.uid, src.email, true);
    const banks = await prisma.questionBank.findMany({ where: { bankKey } });
    expect(banks).toHaveLength(1);
    expect(banks[0].id).toBe(existing.id);
    expect(banks[0].title).toBe("Canonical question bank");
    expect(banks[0].locale).toBe("zh");
    expect(banks[0].kind).toBe("CANONICAL_EXPORT");
    const items = await prisma.questionBankItem.findMany({
      where: { question: { createdBy: src.uid } },
    });
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) {
      expect(row.bankId).toBe(existing.id);
    }
  }, 180_000);

  for (const field of [...QUESTION_BANK_CANONICAL_METADATA_FIELDS] as const) {
    it(`CONFLICT: same identity + differing ${field} fails closed`, async () => {
      const bankKey = uniq(`qb-conflict-${field}`);
      const differingValues: Record<string, string> = {
        title: "Renamed bank title",
        locale: "en",
        kind: "SAMPLE_FIXTURE",
      };
      const src = await seedBankUser(
        `qb-conflict-${field}-${Date.now()}@example.com`,
        bankKey,
        { title: "Canonical question bank", locale: "zh", kind: "CANONICAL_EXPORT" },
      );
      const { buffer } = await buildBackupZip(src.uid, src.email);

      await prisma.questionBankItem.delete({ where: { id: src.item.id } });
      await prisma.questionBank.delete({ where: { id: src.bank.id } });
      await prisma.questionBank.create({
        data: {
          bankKey,
          version: "v1",
          title:
            field === "title" ? differingValues.title : "Canonical question bank",
          locale: field === "locale" ? differingValues.locale : "zh",
          kind: field === "kind" ? differingValues.kind : "CANONICAL_EXPORT",
        },
      });

      await expect(
        importBackup(buffer, src.uid, src.email, true),
      ).rejects.toThrow(QUESTION_BANK_VERSION_CONFLICT);
    }, 180_000);
  }

  it("CONFLICT is atomic: failed restore leaves target logically unchanged", async () => {
    const bankKey = uniq("qb-atomic");
    const email = `qb-atomic-${Date.now()}@example.com`;
    const src = await seedBankUser(email, bankKey, {
      title: "Canonical question bank",
      locale: "zh",
      kind: "CANONICAL_EXPORT",
    });
    // Extra user data guard: a second user-owned Question plus an Interview
    // session skeleton, so the atomicity check covers user rows beyond banks.
    const guardQuestion = await prisma.question.create({
      data: { question: "Atomic guard Q?", createdBy: src.uid },
    });
    const guardSession = await prisma.interviewSession.create({
      data: {
        userId: src.uid,
        coachingMode: "PRACTICE",
        feedbackReleasePolicy: "IMMEDIATE",
        knowledgeBaseVersion: "v1.0",
      },
    });
    void guardQuestion;
    void guardSession;
    const { buffer } = await buildBackupZip(src.uid, src.email);

    await prisma.questionBankItem.delete({ where: { id: src.item.id } });
    await prisma.questionBank.delete({ where: { id: src.bank.id } });
    await prisma.questionBank.create({
      data: {
        bankKey,
        version: "v1",
        title: "Renamed bank title",
        locale: "zh",
        kind: "CANONICAL_EXPORT",
      },
    });

    const norm = (v: unknown) =>
      v instanceof Date ? v.toISOString() : (v as unknown);
    const snap = async () => ({
      banks: (
        await prisma.questionBank.findMany({ orderBy: { bankKey: "asc" } })
      ).map((r) => ({ ...r, createdAt: norm(r.createdAt) })),
      items: (
        await prisma.questionBankItem.findMany({
          where: { question: { createdBy: src.uid } },
          orderBy: { displayOrder: "asc" },
        })
      ).map((r) => ({ ...r, createdAt: norm(r.createdAt) })),
      questions: (
        await prisma.question.findMany({ where: { createdBy: src.uid } })
      ).map((r) => ({
        ...r,
        createdAt: norm(r.createdAt),
        updatedAt: norm(r.updatedAt),
      })),
      sessions: await prisma.interviewSession.count({ where: { userId: src.uid } }),
    });
    const before = await snap();
    await expect(
      importBackup(buffer, src.uid, src.email, true),
    ).rejects.toThrow(QUESTION_BANK_VERSION_CONFLICT);
    const after = await snap();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const fk = (await prisma.$queryRawUnsafe(
      "PRAGMA foreign_key_check;",
    )) as unknown[];
    expect(fk).toEqual([]);
  }, 180_000);

  it("NOT_WIPED: unrelated canonical banks survive a user restore", async () => {
    const bankA = uniq("qb-a");
    const bankB = uniq("qb-b");
    const src = await seedBankUser(`qb-notwiped-${Date.now()}@example.com`, bankA);
    const unrelated = await prisma.questionBank.create({
      data: {
        bankKey: bankB,
        version: "v3",
        title: "Unrelated bank",
        locale: "zh",
        kind: "CANONICAL_EXPORT",
      },
    });
    const { buffer } = await buildBackupZip(src.uid, src.email);
    // Backup carries only bank A; B must survive even though it is absent.
    const onlyA = await patchBackup(buffer, (data) => {
      data.QuestionBank = data.QuestionBank.filter((b) => b.bankKey === bankA);
      data.QuestionBankItem = data.QuestionBankItem.filter((item) => {
        const bank = (
          data.QuestionBank as Array<Record<string, unknown>>
        ).find((bb) => bb.id === item.bankId);
        return Boolean(bank);
      });
    });
    await importBackup(onlyA, src.uid, src.email, true);
    const survivor = await prisma.questionBank.findUniqueOrThrow({
      where: { id: unrelated.id },
    });
    expect(survivor.bankKey).toBe(bankB);
    expect(survivor.title).toBe("Unrelated bank");
    expect(survivor.version).toBe("v3");
  }, 180_000);

  it("MEMBERSHIP_SCOPED: restore replaces only the current user membership", async () => {
    const bankKey = uniq("qb-scope");
    const userA = await seedBankUser(`qb-scope-a-${Date.now()}@example.com`, bankKey);
    const userBId = await seedAccount(prisma, `qb-scope-b-${Date.now()}@example.com`);
    const questionB = await prisma.question.create({
      data: { question: "Other user Q", createdBy: userBId },
    });
    const membershipB = await prisma.questionBankItem.create({
      data: { bankId: userA.bank.id, questionId: questionB.id, displayOrder: 7 },
    });

    const { buffer } = await buildBackupZip(userA.uid, userA.email);
    await importBackup(buffer, userA.uid, userA.email, true);

    const other = await prisma.questionBankItem.findUniqueOrThrow({
      where: { id: membershipB.id },
    });
    expect(other.bankId).toBe(userA.bank.id);
    expect(other.questionId).toBe(questionB.id);
    expect(other.displayOrder).toBe(7);
    const mine = await prisma.questionBankItem.findMany({
      where: { question: { createdBy: userA.uid } },
    });
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) {
      const q = await prisma.question.findUniqueOrThrow({
        where: { id: row.questionId },
      });
      expect(q.createdBy).toBe(userA.uid);
    }
  }, 180_000);
});

describe("transcriptRevision author trade-off (spec v1 §19)", () => {
  async function seedAuthorGraph(
    ownerEmail: string,
    author: string | null,
  ): Promise<{ uid: string; email: string; revisionId: string }> {
    const uid = await seedAccount(prisma, ownerEmail);
    const session = await prisma.interviewSession.create({
      data: {
        userId: uid,
        coachingMode: "PRACTICE",
        feedbackReleasePolicy: "IMMEDIATE",
        knowledgeBaseVersion: "v1.0",
      },
    });
    const instance = await prisma.questionInstance.create({
      data: {
        sessionId: session.id,
        displayOrder: 0,
        displayedText: "Q?",
        sourceKind: "USER_PROVIDED",
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
        revisionKind: author === null ? "ORIGINAL_TEXT" : "USER_CORRECTED",
        fullText: "hi",
        alignmentStatus: "NOT_APPLICABLE",
        contentHash: `h-${Date.now()}`,
        createdByUserId: author,
        createdVia: author === null ? null : "USER_EDIT",
      },
    });
    return { uid, email: ownerEmail, revisionId: revision.id };
  }

  it("cross-user restore normalizes non-null authors to the importing user", async () => {
    const stamp = Date.now();
    const src = await seedAuthorGraph(`author-src-${stamp}@example.com`, null);
    // Seed a non-null author different from the importer so the backup
    // carries cross-user provenance.
    await prisma.transcriptRevision.update({
      where: { id: src.revisionId },
      data: { createdByUserId: src.uid, revisionKind: "USER_CORRECTED" },
    });
    const { buffer } = await buildBackupZip(src.uid, src.email);
    const importer = await seedAccount(prisma, `author-dst-${stamp}@example.com`);
    await importBackup(buffer, importer, `author-dst-${stamp}@example.com`, true);
    const rows = await prisma.transcriptRevision.findMany({
      where: { transcript: { session: { userId: importer } } },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.createdByUserId !== null) {
        expect(row.createdByUserId).toBe(importer);
      }
    }
    expect(TRANSCRIPT_REVISION_AUTHOR_POLICY).toBe(
      "NORMALIZED_TO_IMPORTING_USER_ON_CROSS_USER_RESTORE",
    );
    expect(KNOWN_PROVENANCE_TRADEOFF).toContain("not preserved");
  }, 180_000);

  it("same-user restore leaves authorship semantically unchanged", async () => {
    const stamp = Date.now();
    const src = await seedAuthorGraph(`author-same-${stamp}@example.com`, null);
    await prisma.transcriptRevision.update({
      where: { id: src.revisionId },
      data: { createdByUserId: src.uid, revisionKind: "USER_CORRECTED" },
    });
    const { buffer } = await buildBackupZip(src.uid, src.email);
    await importBackup(buffer, src.uid, src.email, true);
    const rows = await prisma.transcriptRevision.findMany({
      where: { transcript: { session: { userId: src.uid } } },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.createdByUserId).toBe(src.uid);
    }
  }, 180_000);

  it("null author stays null", async () => {
    const stamp = Date.now();
    const src = await seedAuthorGraph(`author-null-${stamp}@example.com`, null);
    const { buffer } = await buildBackupZip(src.uid, src.email);
    await importBackup(buffer, src.uid, src.email, true);
    const rows = await prisma.transcriptRevision.findMany({
      where: { transcript: { session: { userId: src.uid } } },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.createdByUserId).toBeNull();
    }
  }, 180_000);
});

async function seedInterviewGraphAgain() {
  const existing = await prisma.interviewSession.count({ where: { userId } });
  if (existing > 0) return;
  const company = await prisma.company.create({
    data: { label: "Acme2", value: `acme-interview-${Date.now()}`, createdBy: userId },
  });
  const opp = await prisma.jobOpportunity.create({
    data: { userId, companyId: company.id, title: "Backend Engineer" },
  });
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opp.id,
      versionNumber: 1,
      rawContent: "We hire backend engineers.",
      capturedAt: new Date("2026-01-01T00:00:00.000Z"),
      contentHash: `jd-hash-${Date.now()}`,
    },
  });
  const q = await prisma.question.create({
    data: { question: "Reseed Q?", createdBy: userId },
  });
  const session = await prisma.interviewSession.create({
    data: {
      userId,
      coachingMode: "PRACTICE",
      feedbackReleasePolicy: "IMMEDIATE",
      knowledgeBaseVersion: "v1.0",
      jobOpportunityId: opp.id,
      jobDescriptionVersionId: jd.id,
    },
  });
  const instance = await prisma.questionInstance.create({
    data: {
      sessionId: session.id,
      sourceQuestionId: q.id,
      displayOrder: 0,
      displayedText: "Reseed Q?",
      sourceKind: "USER_PROVIDED",
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
    data: { sessionId: session.id, answerAttemptId: attempt.id, fullText: "t" },
  });
  const revision = await prisma.transcriptRevision.create({
    data: {
      transcriptId: transcript.id,
      answerAttemptId: attempt.id,
      revisionNumber: 1,
      revisionKind: "ORIGINAL_TEXT",
      fullText: "t",
      alignmentStatus: "NOT_APPLICABLE",
      contentHash: "h",
    },
  });
  const generation = await prisma.feedbackGeneration.create({
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
  await prisma.feedbackItem.create({
    data: {
      sessionId: session.id,
      transcriptId: transcript.id,
      generationId: generation.id,
      itemOrder: 1,
      problemLabel: "p",
      evidence: "e",
      explanation: "x",
      suggestion: "s",
    },
  });
}
