// @vitest-environment node
import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";
import {
  loadQuestionSnapshot,
  mapQuestionToSnapshot,
} from "@/lib/interview/questionAdapter";
import { resolveJobJdContext } from "@/lib/interview/jobJdResolver";
import { INTERVIEW_ADAPTER_ERROR_CODES } from "@/lib/interview/errors";

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;

beforeAll(() => {
  pushSchema(ctx.url);
}, 180000);

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
  const stamp = Date.now();
  userId = await seedAccount(prisma, `interview-q-${stamp}@example.com`);
  otherUserId = await seedAccount(prisma, `interview-q-other-${stamp}@example.com`);
});

async function createQuestion(owner: string, extra: Record<string, unknown> = {}) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tagA = await prisma.tag.create({
    data: { label: "STAR", value: `star-${stamp}`, createdBy: owner },
  });
  const tagB = await prisma.tag.create({
    data: { label: "Behavioral", value: `behavioral-${stamp}`, createdBy: owner },
  });
  return prisma.question.create({
    data: {
      question: "Tell me about a time you resolved a conflict.",
      answer: "Situation, Task, Action, Result with numbers.",
      createdBy: owner,
      createdVia: "USER",
      tags: { connect: [{ id: tagA.id }, { id: tagB.id }] },
      ...extra,
    } as never,
    include: { tags: true },
  });
}

describe("question adapter", () => {
  it("accepts the correct owner and snapshots deterministically", async () => {
    const row = await createQuestion(userId);
    const first = await loadQuestionSnapshot(prisma, userId, row.id);
    const second = await loadQuestionSnapshot(prisma, userId, row.id);
    expect(first).toEqual(second);
    expect(first.questionId).toBe(row.id);
    expect(first.sourceQuestionId).toBe(row.id);
    expect(first.displayedText).toBe("Tell me about a time you resolved a conflict.");
    expect(first.referenceAnswerSnapshot).toBe(
      "Situation, Task, Action, Result with numbers.",
    );
    expect(first.createdVia).toBe("USER");
    // Sorted tag snapshot; category is the first sorted value.
    expect([...first.tags].sort()).toEqual(first.tags);
    expect(first.tags).toHaveLength(2);
    expect(first.category).toBe(first.tags[0]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("rejects cross-user question access", async () => {
    const row = await createQuestion(userId);
    const err = await loadQuestionSnapshot(prisma, otherUserId, row.id).catch(
      (e) => e,
    );
    expect(err?.code).toBe(INTERVIEW_ADAPTER_ERROR_CODES.SESSION_FORBIDDEN);
  });

  it("missing question maps to QUESTION_NOT_FOUND", async () => {
    const err = await loadQuestionSnapshot(prisma, userId, "q-missing").catch(
      (e) => e,
    );
    expect(err?.code).toBe(INTERVIEW_ADAPTER_ERROR_CODES.QUESTION_NOT_FOUND);
  });

  it("pure mapper rejects empty text and cross-user binds", () => {
    expect(() =>
      mapQuestionToSnapshot(
        { id: "q1", question: "   ", answer: null, createdBy: userId, tags: [] },
        userId,
      ),
    ).toThrowError();
    try {
      mapQuestionToSnapshot(
        { id: "q1", question: "hi", answer: null, createdBy: userId, tags: [] },
        otherUserId,
      );
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe(
        INTERVIEW_ADAPTER_ERROR_CODES.SESSION_FORBIDDEN,
      );
    }
  });

  it("null answer snapshots as null and untagged category is null", () => {
    const snap = mapQuestionToSnapshot(
      { id: "q1", question: "Q?", answer: null, createdBy: userId, tags: [] },
      userId,
    );
    expect(snap.referenceAnswerSnapshot).toBeNull();
    expect(snap.category).toBeNull();
    expect(snap.tags).toEqual([]);
  });
});

describe("job/JD resolver", () => {
  async function createJobWithJds(owner: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const company = await prisma.company.create({
      data: { label: "Acme", value: `acme-${stamp}`, createdBy: owner },
    });
    const job = await prisma.jobOpportunity.create({
      data: {
        userId: owner,
        companyId: company.id,
        title: "Frontend Engineer",
        status: "ACTIVE",
      },
    });
    const jd1 = await prisma.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: job.id,
        versionNumber: 1,
        rawContent: "Build things.",
        contentHash: `hash-1-${stamp}`,
        capturedAt: new Date(),
      },
    });
    const jd2 = await prisma.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: job.id,
        versionNumber: 2,
        rawContent: "Build things well.",
        contentHash: `hash-2-${stamp}`,
        capturedAt: new Date(),
      },
    });
    return { job, jd1, jd2 };
  }

  it("both absent is accepted (no job context)", async () => {
    const out = await resolveJobJdContext(prisma, { userId });
    expect(out).toEqual({
      jobOpportunityId: null,
      jobDescriptionVersionId: null,
      jobTitle: null,
      jdVersionNumber: null,
      jdContentHash: null,
    });
  });

  it("only one id is rejected", async () => {
    const { job } = await createJobWithJds(userId);
    const onlyJob = await resolveJobJdContext(prisma, {
      userId,
      jobOpportunityId: job.id,
    }).catch((e) => e);
    expect(onlyJob?.code).toBe(INTERVIEW_ADAPTER_ERROR_CODES.JOB_PAIR_REQUIRED);
    const onlyJd = await resolveJobJdContext(prisma, {
      userId,
      jobDescriptionVersionId: "jd-x",
    }).catch((e) => e);
    expect(onlyJd?.code).toBe(INTERVIEW_ADAPTER_ERROR_CODES.JOB_PAIR_REQUIRED);
  });

  it("cross-user job is rejected", async () => {
    const { job, jd1 } = await createJobWithJds(userId);
    const err = await resolveJobJdContext(prisma, {
      userId: otherUserId,
      jobOpportunityId: job.id,
      jobDescriptionVersionId: jd1.id,
    }).catch((e) => e);
    expect(err?.code).toBe(INTERVIEW_ADAPTER_ERROR_CODES.SESSION_FORBIDDEN);
  });

  it("foreign JD is rejected", async () => {
    const first = await createJobWithJds(userId);
    const second = await createJobWithJds(userId);
    const err = await resolveJobJdContext(prisma, {
      userId,
      jobOpportunityId: first.job.id,
      jobDescriptionVersionId: second.jd1.id,
    }).catch((e) => e);
    expect(err?.code).toBe(INTERVIEW_ADAPTER_ERROR_CODES.JOB_JD_MISMATCH);
  });

  it("valid pair returns frozen references and writes nothing", async () => {
    const { job, jd2 } = await createJobWithJds(userId);
    const jobsBefore = await prisma.jobOpportunity.count();
    const jdsBefore = await prisma.jobDescriptionVersion.count();
    const out = await resolveJobJdContext(prisma, {
      userId,
      jobOpportunityId: job.id,
      jobDescriptionVersionId: jd2.id,
    });
    expect(out.jobOpportunityId).toBe(job.id);
    expect(out.jobDescriptionVersionId).toBe(jd2.id);
    expect(out.jobTitle).toBe("Frontend Engineer");
    expect(out.jdVersionNumber).toBe(2);
    expect(out.jdContentHash).toBe(jd2.contentHash);
    // Read-only: the resolver must not create or mutate Job/JD rows.
    expect(await prisma.jobOpportunity.count()).toBe(jobsBefore);
    expect(await prisma.jobDescriptionVersion.count()).toBe(jdsBefore);
  });
});
