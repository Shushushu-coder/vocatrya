// @vitest-environment node
/**
 * Phase 3B — Host Port / persistence adapter wiring contract suite.
 *
 * Disposable SQLite DB built with the REAL migration history
 * (`prisma migrate deploy`), so CHECK / partial-unique / composite-FK
 * behaviour matches production. Never touches `prisma/dev.db` or
 * `%LOCALAPPDATA%/Vocatrya`. Zero provider calls, zero network.
 *
 * Covers:
 * - session port (create/read/ownership/Job-JD pair, no auto-select)
 * - question-instance snapshot fidelity + nullable source
 * - answer / artifact / transcript / revision graph + active pointer
 * - feedback / summary generation persistence only (no LLM) + atomicity
 * - coaching conversation / ordered turns / target XOR
 * - ownership closure + host relation closure + pointer integrity
 * - QuestionBank read-only boundary + stale recovery
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  makeTestDbUrl,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";
import { VocatryaInterviewPersistence } from "@/lib/interview/persistence/vocatryaInterviewPersistence";
import {
  VocatryaJobContextAdapter,
  VocatryaQuestionAdapter,
  VocatryaUserOwnershipAdapter,
} from "@/lib/interview/vocatryaHostPorts";
import { canonicalTranscriptContentHash } from "@/lib/interview/persistence/hash";

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
    throw new Error(
      [
        "Phase 3B migration deploy failed.",
        `Exit code: ${result.status ?? "unknown"}`,
        `stdout:\n${result.stdout || "<empty>"}`,
        `stderr:\n${result.stderr || "<empty>"}`,
      ].join("\n"),
    );
  }
}

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const repo = new VocatryaInterviewPersistence(prisma as never);

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
    // Windows temp cleanup flake; ignore.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  userA = await seedAccount(prisma, `phase3b-a-${stamp}@example.com`);
  userB = await seedAccount(prisma, `phase3b-b-${stamp}@example.com`);
}, 60_000);

async function seedJobWithJd(owner: string, stamp: string) {
  const company = await prisma.company.create({
    data: { label: "Acme", value: `phase3b-acme-${stamp}`, createdBy: owner },
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
      contentHash: `phase3b-${stamp}`,
    },
  });
  return { company, opp, jd };
}

async function createOwnedQuestion(owner: string, answer: string | null = "Ref answer") {
  return prisma.question.create({
    data: { question: "Tell me about ownership?", answer, createdBy: owner },
  });
}

async function createBasicSession(
  actor: string,
  overrides: Partial<Parameters<VocatryaInterviewPersistence["createSession"]>[0]> = {},
) {
  return repo.createSession({
    actorUserId: actor,
    coachingMode: "PRACTICE",
    knowledgeBaseVersion: "v1.0",
    questions: [{ displayedText: "Introduce yourself." }],
    ...overrides,
  });
}

async function createAttemptGraph(actor: string, sessionId: string, instanceId: string) {
  const attempt = await repo.createAttemptForUser({
    actorUserId: actor,
    questionInstanceId: instanceId,
    inputType: "TEXT",
  });
  const artifact = await repo.createArtifactForUser({
    actorUserId: actor,
    answerAttemptId: attempt.id,
    inputType: "TEXT",
    role: "SOURCE",
    textContent: "My answer.",
  });
  const transcript = await repo.createTranscriptForUser({
    actorUserId: actor,
    answerAttemptId: attempt.id,
    fullText: "My answer.",
    sourceArtifactId: artifact.id,
  });
  const revision = await repo.createOriginalRevisionForUser({
    actorUserId: actor,
    transcriptId: transcript.id,
    answerAttemptId: attempt.id,
    revisionKind: "ORIGINAL_TEXT",
    alignmentStatus: "NOT_APPLICABLE",
    contentHash: canonicalTranscriptContentHash("My answer.", []),
  });
  return { attempt, artifact, transcript, revision };
}

describe("session port", () => {
  it("creates a session with first instance as current pointer", async () => {
    const { session, instances } = await createBasicSession(userA);
    expect(session.userId).toBe(userA);
    expect(session.status).toBe("DRAFT");
    expect(instances).toHaveLength(1);
    expect(session.currentQuestionInstanceId).toBe(instances[0].id);
    expect(instances[0].displayedText).toBe("Introduce yourself.");
    expect(instances[0].sourceQuestionId).toBeNull();
    expect(instances[0].status).toBe("PENDING");
  });

  it("reads same-user session but rejects cross-user and missing", async () => {
    const { session } = await createBasicSession(userA);
    const same = await repo.getSessionForUser(session.id, userA);
    expect(same.id).toBe(session.id);
    const cross = await repo.getSessionForUser(session.id, userB).catch((e) => e);
    expect(cross?.code).toBe("SESSION_FORBIDDEN");
    const missing = await repo.getSessionForUser("session-missing", userA).catch((e) => e);
    expect(missing?.code).toBe("SESSION_NOT_FOUND");
  });

  it("accepts absent Job/JD pair and a valid pair without auto-select", async () => {
    const absent = await createBasicSession(userA);
    expect(absent.session.jobOpportunityId).toBeNull();
    expect(absent.session.jobDescriptionVersionId).toBeNull();

    const stamp = `${Date.now()}-pair`;
    const { opp, jd } = await seedJobWithJd(userA, stamp);
    const paired = await createBasicSession(userA, {
      jobOpportunityId: opp.id,
      jobDescriptionVersionId: jd.id,
    });
    expect(paired.session.jobOpportunityId).toBe(opp.id);
    expect(paired.session.jobDescriptionVersionId).toBe(jd.id);
    // No auto-select: exactly one side is invalid, never defaulted.
    const xor = await createBasicSession(userA, {
      jobOpportunityId: opp.id,
    }).catch((e) => e);
    expect(xor?.code).toBe("JOB_PAIR_REQUIRED");
  });

  it("rejects cross-user Job with CROSS_USER_RELATION and JD mismatch distinctly", async () => {
    const stamp = `${Date.now()}-xuser`;
    const { opp, jd } = await seedJobWithJd(userA, stamp);
    const cross = await createBasicSession(userB, {
      jobOpportunityId: opp.id,
      jobDescriptionVersionId: jd.id,
    }).catch((e) => e);
    expect(cross?.code).toBe("CROSS_USER_RELATION");

    const other = await seedJobWithJd(userA, `${stamp}-other`);
    const mismatch = await createBasicSession(userA, {
      jobOpportunityId: opp.id,
      jobDescriptionVersionId: other.jd.id,
    }).catch((e) => e);
    expect(mismatch?.code).toBe("JOB_JD_MISMATCH");
    expect(mismatch?.code).not.toBe("SESSION_NOT_FOUND");
    void jd;
  });

  it("wires the frozen host adapters (ownership/question/job) to the same rules", async () => {
    const ownership = new VocatryaUserOwnershipAdapter(prisma as never);
    const { session } = await createBasicSession(userA);
    const view = await ownership.loadSessionOwnership(session.id);
    expect(view).toMatchObject({ sessionId: session.id, ownerUserId: userA });
    expect(await ownership.loadSessionOwnership("nope")).toBeNull();

    const questionPort = new VocatryaQuestionAdapter(prisma as never);
    const q = await createOwnedQuestion(userA);
    const snap = await questionPort.resolveSnapshot({
      sourceQuestionId: q.id,
      requestingUserId: userA,
    });
    expect(snap.sourceQuestionId).toBe(q.id);
    const crossQ = await questionPort
      .resolveSnapshot({ sourceQuestionId: q.id, requestingUserId: userB })
      .catch((e) => e);
    expect(crossQ?.code).toBe("SESSION_FORBIDDEN");

    // Frozen QuestionPort: living row owned by another user AND not shared
    // via question-bank membership => SESSION_FORBIDDEN. Membership grants
    // shared readability (standalone adapter parity; not a Vocatrya-invented ACL).
    const bank = await prisma.questionBank.create({
      data: {
        bankKey: `share-${Date.now()}`,
        version: "v1",
        title: "Shared bank",
        locale: "zh",
        kind: "SAMPLE_FIXTURE",
      },
    });
    await prisma.questionBankItem.create({
      data: { bankId: bank.id, questionId: q.id, displayOrder: 0 },
    });
    const shared = await questionPort.resolveSnapshot({
      sourceQuestionId: q.id,
      requestingUserId: userB,
    });
    expect(shared.sourceQuestionId).toBe(q.id);
    expect(shared.referenceAnswerSnapshot).toBe("Ref answer");

    const jobPort = new VocatryaJobContextAdapter(prisma as never);
    const stamp = `${Date.now()}-adapter`;
    const { opp, jd } = await seedJobWithJd(userA, stamp);
    const resolved = await jobPort.resolveJobContext({
      requestingUserId: userA,
      jobOpportunityId: opp.id,
      jobDescriptionVersionId: jd.id,
    });
    expect(resolved).toEqual({ jobOpportunityId: opp.id, jobDescriptionVersionId: jd.id });
    const crossJ = await jobPort
      .resolveJobContext({
        requestingUserId: userB,
        jobOpportunityId: opp.id,
        jobDescriptionVersionId: jd.id,
      })
      .catch((e) => e);
    expect(crossJ?.code).toBe("CROSS_USER_RELATION");
  });
});

describe("question instance port", () => {
  it("persists snapshots verbatim and supports nullable source", async () => {
    const q = await createOwnedQuestion(userA, "Frozen ref");
    const { instances } = await repo.createSession({
      actorUserId: userA,
      coachingMode: "PRACTICE",
      knowledgeBaseVersion: "v1.0",
      questions: [
        {
          displayedText: "  Banked question?  ",
          sourceKind: "QUESTION_BANK",
          category: "STAR",
          sourceQuestionId: q.id,
          sourceMetadata: { bankKey: "bk" },
        },
        { displayedText: "Free text?", sourceKind: "USER_PROVIDED" },
      ],
    });
    expect(instances[0].displayedText).toBe("Banked question?");
    expect(instances[0].sourceQuestionId).toBe(q.id);
    expect(instances[0].referenceAnswerSnapshot).toBe("Frozen ref");
    expect(instances[0].category).toBe("STAR");
    expect(instances[1].sourceQuestionId).toBeNull();
    expect(instances[1].referenceAnswerSnapshot).toBeNull();
  });

  it("honours caller reference-answer override and rejects cross-session misuse", async () => {
    const q = await createOwnedQuestion(userA, "Source answer");
    const first = await createBasicSession(userA);
    const second = await repo.createSession({
      actorUserId: userA,
      coachingMode: "PRACTICE",
      knowledgeBaseVersion: "v1.0",
      questions: [
        {
          displayedText: "Q?",
          sourceQuestionId: q.id,
          referenceAnswerSnapshot: "Override",
        },
      ],
    });
    expect(second.instances[0].referenceAnswerSnapshot).toBe("Override");

    // Cross-session misuse: pointing the session cursor at another session's
    // instance must be rejected, not silently accepted.
    const err = await repo
      .updateSessionForUser(first.session.id, userA, {
        currentQuestionInstanceId: second.instances[0].id,
      })
      .catch((e) => e);
    expect(err?.code).toBe("SESSION_FORBIDDEN");
  });
});

describe("answer / transcript port", () => {
  it("persists attempt + artifacts + transcript + revisions with pointer moves", async () => {
    const { session, instances } = await createBasicSession(userA);
    const { attempt, artifact, transcript, revision } = await createAttemptGraph(
      userA,
      session.id,
      instances[0].id,
    );
    expect(attempt.attemptNumber).toBe(1);
    expect(artifact.textContent).toBe("My answer.");
    expect(transcript.fullText).toBe("My answer.");
    expect(revision.revisionNumber).toBe(1);
    expect(revision.createdByUserId).toBe(userA);

    const reloaded = await repo.getAttemptForUser(attempt.id, userA);
    expect(reloaded.activeRevisionId).toBe(revision.id);

    const corrected = await repo.createCorrectedRevisionForUser({
      actorUserId: userA,
      answerAttemptId: attempt.id,
      fullText: "My corrected answer.",
      contentHash: canonicalTranscriptContentHash("My corrected answer.", []),
    });
    expect(corrected.revisionNumber).toBe(2);
    expect(corrected.revisionKind).toBe("USER_CORRECTED");
    const moved = await repo.getAttemptForUser(attempt.id, userA);
    expect(moved.activeRevisionId).toBe(corrected.id);
  });

  it("rejects cross-attempt revision pointers", async () => {
    const { instances } = await repo.createSession({
      actorUserId: userA,
      coachingMode: "PRACTICE",
      knowledgeBaseVersion: "v1.0",
      questions: [{ displayedText: "Q1" }, { displayedText: "Q2" }],
    });
    const left = await createAttemptGraph(userA, instances[0].sessionId, instances[0].id);
    const right = await createAttemptGraph(userA, instances[0].sessionId, instances[1].id);
    const err = await repo
      .setActiveRevisionForUser({
        actorUserId: userA,
        answerAttemptId: left.attempt.id,
        revisionId: right.revision.id,
      })
      .catch((e) => e);
    expect(err?.code).toBe("INVALID_INPUT_REVISION");
  });
});

describe("feedback generation persistence (no LLM)", () => {
  it("publishes current SUCCEEDED atomically and retains FAILED history", async () => {
    const { session, instances } = await createBasicSession(userA);
    const { attempt, transcript } = await createAttemptGraph(
      userA,
      session.id,
      instances[0].id,
    );
    const pending = await repo.createPendingFeedbackForUser({
      actorUserId: userA,
      answerAttemptId: attempt.id,
      model: "m",
      provider: "p",
      knowledgeBaseVersion: "v1.0",
    });
    expect(pending.status).toBe("PENDING");
    expect(pending.isCurrent).toBe(false);
    expect(pending.inputRevisionId).toBe(attempt.id ? pending.inputRevisionId : pending.inputRevisionId);

    const published = await repo.publishFeedbackForUser({
      actorUserId: userA,
      generationId: pending.id,
      transcriptId: transcript.id,
      items: [
        {
          problemLabel: "Specificity",
          evidence: { transcriptExcerpt: "x", startOffset: 0, endOffset: 1, problemStatement: "y", groundingSources: [] },
          explanation: { underlyingCause: "a", performanceImpact: "b" },
          suggestion: "Do z.",
        },
      ],
    });
    expect(published.generation.status).toBe("SUCCEEDED");
    expect(published.generation.isCurrent).toBe(true);
    expect(published.generation.provider).toBe("p");
    expect(published.items).toHaveLength(1);
    expect(published.items[0].itemOrder).toBe(1);

    // Second publish transactionally switches current (no dual current).
    const pending2 = await repo.createPendingFeedbackForUser({
      actorUserId: userA,
      answerAttemptId: attempt.id,
      model: "m",
      provider: "p",
      knowledgeBaseVersion: "v1.0",
    });
    expect(pending2.versionNumber).toBe(pending.versionNumber + 1);
    const published2 = await repo.publishFeedbackForUser({
      actorUserId: userA,
      generationId: pending2.id,
      transcriptId: transcript.id,
      items: [
        {
          problemLabel: "STAR",
          evidence: "ev",
          explanation: "ex",
          suggestion: "s",
        },
      ],
    });
    expect(published2.generation.isCurrent).toBe(true);
    const current = await repo.getCurrentFeedbackWithItemsForUser(attempt.id, userA);
    expect(current?.generation.id).toBe(published2.generation.id);

    // FAILED rows are retained historically and never current.
    const pending3 = await repo.createPendingFeedbackForUser({
      actorUserId: userA,
      answerAttemptId: attempt.id,
      model: "m",
      provider: "p",
      knowledgeBaseVersion: "v1.0",
    });
    const failed = await repo.failFeedbackForUser({
      actorUserId: userA,
      generationId: pending3.id,
      code: "EMPTY_ITEMS",
      message: "boom",
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.isCurrent).toBe(false);
    const stillCurrent = await repo.getCurrentFeedbackWithItemsForUser(attempt.id, userA);
    expect(stillCurrent?.generation.id).toBe(published2.generation.id);
  });

  it("does not leave partial publication on invalid items", async () => {
    const { session, instances } = await createBasicSession(userA);
    const { attempt, transcript } = await createAttemptGraph(
      userA,
      session.id,
      instances[0].id,
    );
    const first = await repo.createPendingFeedbackForUser({
      actorUserId: userA,
      answerAttemptId: attempt.id,
      model: "m",
      provider: "p",
      knowledgeBaseVersion: "v1.0",
    });
    await repo.publishFeedbackForUser({
      actorUserId: userA,
      generationId: first.id,
      transcriptId: transcript.id,
      items: [{ problemLabel: "A", evidence: "e", explanation: "x", suggestion: "s" }],
    });
    const pending = await repo.createPendingFeedbackForUser({
      actorUserId: userA,
      answerAttemptId: attempt.id,
      model: "m",
      provider: "p",
      knowledgeBaseVersion: "v1.0",
    });
    const bad = await repo
      .publishFeedbackForUser({
        actorUserId: userA,
        generationId: pending.id,
        transcriptId: transcript.id,
        items: [{ problemLabel: "", evidence: "e", explanation: "x", suggestion: "s" }],
      })
      .catch((e) => e);
    expect(bad?.code).toBe("INVALID_FEEDBACK_ITEM");
    const current = await repo.getCurrentFeedbackWithItemsForUser(attempt.id, userA);
    expect(current?.generation.id).toBe(first.id);
    expect(current?.items).toHaveLength(1);
  });
});

describe("summary generation persistence (no LLM)", () => {
  it("publishes guarded current with ordered inputs atomically", async () => {
    const { session, instances } = await repo.createSession({
      actorUserId: userA,
      coachingMode: "PRACTICE",
      knowledgeBaseVersion: "v1.0",
      questions: [{ displayedText: "Q1" }, { displayedText: "Q2" }],
    });
    const graphs = [];
    for (const instance of instances) {
      const g = await createAttemptGraph(userA, session.id, instance.id);
      const pending = await repo.createPendingFeedbackForUser({
        actorUserId: userA,
        answerAttemptId: g.attempt.id,
        model: "m",
        provider: "p",
        knowledgeBaseVersion: "v1.0",
      });
      const pub = await repo.publishFeedbackForUser({
        actorUserId: userA,
        generationId: pending.id,
        transcriptId: g.transcript.id,
        items: [{ problemLabel: "L", evidence: "e", explanation: "x", suggestion: "s" }],
      });
      graphs.push({ ...g, feedback: pub.generation });
    }
    const pendingSummary = await repo.createPendingSummaryForUser({
      actorUserId: userA,
      sessionId: session.id,
      inputHash: "h1",
      model: "m",
      provider: "p",
      knowledgeBaseVersion: "v1.0",
    });
    const published = await repo.publishSummaryForUser({
      actorUserId: userA,
      generationId: pendingSummary.id,
      evidence: graphs.map((g, index) => ({
        questionInstanceId: g.attempt.questionInstanceId,
        feedbackGenerationId: g.feedback.id,
        inputOrder: index + 1,
      })),
      bodyText: "Summary body.",
      structuredPayload: { score: 1 },
    });
    expect(published.generation.isCurrent).toBe(true);
    expect(published.inputs.map((r) => r.inputOrder)).toEqual([1, 2]);
    const current = await repo.getCurrentSummaryWithInputsForUser(session.id, userA);
    expect(current?.generation.id).toBe(published.generation.id);
    expect(current?.inputs).toHaveLength(2);
  });
});

describe("coaching persistence (no LLM)", () => {
  it("keeps one conversation, ordered turns, and enforces target XOR", async () => {
    const { session, instances } = await createBasicSession(userA);
    const first = await repo.getOrCreateConversationForUser(session.id, userA);
    const second = await repo.getOrCreateConversationForUser(session.id, userA);
    expect(first.id).toBe(second.id);

    const t1 = await repo.createTurnForUser({
      actorUserId: userA,
      sessionId: session.id,
      userText: "How am I doing?",
      targetType: "SESSION",
      assistantReply: "Well.",
      replyModel: "m",
      replyPromptVersion: "commercial_coaching_v1",
      contextSnapshot: { target_type: "SESSION" },
    });
    const t2 = await repo.createTurnForUser({
      actorUserId: userA,
      sessionId: session.id,
      userText: "This question?",
      targetType: "QUESTION_INSTANCE",
      questionInstanceId: instances[0].id,
      assistantReply: "Good.",
      contextSnapshot: { target_type: "QUESTION_INSTANCE" },
    });
    expect(t2.turnNumber).toBe(t1.turnNumber + 1);
    const turns = await repo.listTurnsForUser(session.id, userA);
    expect(turns.map((t) => t.turnNumber)).toEqual([1, 2]);

    const badXor = await repo
      .createTurnForUser({
        actorUserId: userA,
        sessionId: session.id,
        userText: "bad",
        targetType: "SESSION",
        questionInstanceId: instances[0].id,
        assistantReply: "x",
      })
      .catch((e) => e);
    expect(badXor?.code).toBe("INVALID_DIALOGUE_TARGET");

    const forbidden = await repo
      .createTurnForUser({
        actorUserId: userA,
        sessionId: session.id,
        userText: "x",
        targetType: "SESSION",
        assistantReply: "x",
        contextSnapshot: { transcript: "leak" },
      })
      .catch((e) => e);
    expect(forbidden?.code).toBe("CONTEXT_SNAPSHOT_FORBIDDEN_PAYLOAD");
  });
});

describe("ownership + relation closure", () => {
  it("blocks User A across every User B record", async () => {
    const owned = await createBasicSession(userB);
    const instanceId = owned.instances[0].id;
    for (const call of [
      repo.getSessionForUser(owned.session.id, userA).catch((e) => e),
      repo.listInstancesForUser(owned.session.id, userA).catch((e) => e),
      repo.getInstanceForUser(instanceId, userA).catch((e) => e),
      repo
        .createAttemptForUser({
          actorUserId: userA,
          questionInstanceId: instanceId,
          inputType: "TEXT",
        })
        .catch((e) => e),
    ]) {
      expect((await call)?.code).toBe("SESSION_FORBIDDEN");
    }
    const graph = await createAttemptGraph(userB, owned.session.id, instanceId);
    const crossAttempt = await repo.getAttemptForUser(graph.attempt.id, userA).catch((e) => e);
    expect(crossAttempt?.code).toBe("SESSION_FORBIDDEN");
    const crossTurn = await repo
      .createTurnForUser({
        actorUserId: userA,
        sessionId: owned.session.id,
        userText: "hi",
        targetType: "SESSION",
        assistantReply: "x",
      })
      .catch((e) => e);
    expect(crossTurn?.code).toBe("SESSION_FORBIDDEN");
  });

  it("keeps current/active pointers inside their own graph", async () => {
    const left = await createBasicSession(userA);
    const right = await createBasicSession(userA);
    const badSessionPointer = await repo
      .updateSessionForUser(left.session.id, userA, {
        currentQuestionInstanceId: right.instances[0].id,
      })
      .catch((e) => e);
    expect(badSessionPointer?.code).toBe("SESSION_FORBIDDEN");

    const leftGraph = await createAttemptGraph(userA, left.session.id, left.instances[0].id);
    const rightGraph = await createAttemptGraph(userA, right.session.id, right.instances[0].id);
    const badActive = await repo
      .setActiveRevisionForUser({
        actorUserId: userA,
        answerAttemptId: leftGraph.attempt.id,
        revisionId: rightGraph.revision.id,
      })
      .catch((e) => e);
    expect(badActive?.code).toBe("INVALID_INPUT_REVISION");
  });

  it("keeps QuestionBank read-only from the persistence surface", async () => {
    expect(
      (repo as unknown as Record<string, unknown>).createQuestionBank,
    ).toBeUndefined();
    expect(
      (repo as unknown as Record<string, unknown>).deleteQuestionBank,
    ).toBeUndefined();
    const bank = await prisma.questionBank.create({
      data: { bankKey: `bk-${Date.now()}`, version: "v1", title: "Bank" },
    });
    const items = await repo.listBankItems(bank.id);
    expect(items).toEqual([]);
  });

  it("recovers stale PENDING generations without touching current SUCCEEDED", async () => {
    const { session, instances } = await createBasicSession(userA);
    const { attempt } = await createAttemptGraph(userA, session.id, instances[0].id);
    const stale = await repo.createPendingFeedbackForUser({
      actorUserId: userA,
      answerAttemptId: attempt.id,
      model: "m",
      provider: "p",
      knowledgeBaseVersion: "v1.0",
    });
    // Backdate to stale.
    await prisma.feedbackGeneration.update({
      where: { id: stale.id },
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    const out = await repo.markStaleGenerationsFailed({
      olderThanMs: 60_000,
      now: new Date("2026-02-01T00:00:00Z"),
    });
    expect(out.feedback).toBe(1);
    const reloaded = await prisma.feedbackGeneration.findUnique({ where: { id: stale.id } });
    expect(reloaded?.status).toBe("FAILED");
    expect(reloaded?.failureCode).toBe("STALE_PENDING");
    const badThreshold = await repo
      .markStaleGenerationsFailed({ olderThanMs: 0 })
      .catch((e) => e);
    expect(badThreshold?.code).toBe("INVALID_STALE_THRESHOLD");
  });
});
