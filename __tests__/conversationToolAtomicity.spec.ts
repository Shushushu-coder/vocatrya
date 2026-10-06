// @vitest-environment node
import fs from "node:fs";
import { PrismaClient, type Prisma } from "@prisma/client";
import { admitConversationRequest, checkpointConversationTool, cancelConversationRequest, type ConversationRequest } from "@/lib/agent/conversationRequest";
import { createJobFromNames, renderJobDescription } from "@/lib/jobs/createJobFromNames";
import { saveMatchInTransaction, saveCoverLetterInTransaction, renderCoverLetterContent } from "@/lib/jobs/generatedResults";
import { makeAbTestDbUrl, preparePrismaProject, migrateDeploy } from "./helpers/abSchemaTestDb";
import { seedAccount, resetDisposableDb } from "./helpers/backupTestDb";

const ctx = makeAbTestDbUrl();
const a = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const b = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;
let request: ConversationRequest;
const input = { company: "Legacy Company", jobTitle: "Engineer", jobDescription: "A full job description for the legacy career write path", tags: ["TypeScript"] };
beforeAll(() => migrateDeploy(ctx.url, preparePrismaProject(ctx.dir)), 120000);
beforeEach(async () => {
  await resetDisposableDb(a);
  userId = await seedAccount(a, "legacy-atomic@example.com");
  await a.profile.create({ data: { userId } });
  const row = await a.chatConversation.create({ data: { userId, messages: "[]" } });
  request = await admitConversationRequest({ userId, conversationId: row.id, requestId: "request", expectedRevision: 0, operation: "send", newMessage: { id: "user", role: "user", parts: [{ type: "text", text: "write" }] } }, a);
  request.responseMessageId = "assistant";
});
afterAll(async () => {
  await Promise.all([a.$disconnect(), b.$disconnect()]);
  if (ctx.dir.includes("vocatrya-ab-schema-")) fs.rmSync(ctx.dir, { recursive: true, force: true });
});

async function write(toolName: string, mutate: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  return checkpointConversationTool(request, { toolName, toolCallId: "call", input }, mutate, a);
}
async function failReceipt() {
  await a.$executeRawUnsafe(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF messages ON ChatConversation WHEN NEW.id = '${request.conversationId}' BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END`);
}
const load = () => b.chatConversation.findUniqueOrThrow({ where: { id: request.conversationId } });

it("legacy add_job commits company, tags, job and terminal receipt together", async () => {
  const rendered = renderJobDescription(input.jobDescription);
  const output = await write("add_job", tx => createJobFromNames(input, userId, tx, rendered)) as { jobId: string };
  await cancelConversationRequest(userId, request.conversationId, request.requestId, b);
  expect(await b.job.count({ where: { id: output.jobId } })).toBe(1);
  expect((await load()).messages).toContain(output.jobId);
  expect((await load()).messages).toContain('"state":"output-available"');
});
it("legacy add_job rolls back company, tags and job when conversation receipt fails", async () => {
  await failReceipt();
  try {
    const rendered = renderJobDescription(input.jobDescription);
    await expect(write("add_job", tx => createJobFromNames(input, userId, tx, rendered))).rejects.toMatchObject({ code: "CONVERSATION_PERSISTENCE_FAILED" });
    expect(await b.job.count()).toBe(0);
    expect(await b.company.count()).toBe(0);
    expect(await b.tag.count()).toBe(0);
    expect((await load()).revision).toBe(1);
  } finally { await a.$executeRawUnsafe("DROP TRIGGER fail_receipt"); }
});
it.each([false, true])("match result atomic persistence (injected receipt failure=%s)", async fail => {
  const job = await createJobFromNames(input, userId, a);
  if (fail) await failReceipt();
  try {
    const operation = write("match_job", async tx => {
      await saveMatchInTransaction(tx, userId, job.jobId!, 87, '{"score":87}');
      return { status: "ok", jobId: job.jobId, saved: true, scores: { matchScore: 87 } };
    });
    if (fail) await expect(operation).rejects.toMatchObject({ code: "CONVERSATION_PERSISTENCE_FAILED" }); else await operation;
    const saved = await b.job.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(saved.matchScore).toBe(fail ? null : 87);
    expect((await load()).messages.includes("match_job")).toBe(!fail);
  } finally { if (fail) await a.$executeRawUnsafe("DROP TRIGGER fail_receipt"); }
});
it.each([false, true])("cover letter and job linkage atomic persistence (injected receipt failure=%s)", async fail => {
  const job = await createJobFromNames(input, userId, a);
  const markdown = "Dear hiring team, I would like to apply for this engineering position.";
  const content = renderCoverLetterContent(markdown);
  if (fail) await failReceipt();
  try {
    const operation = write("generate_cover_letter", async tx => {
      const letter = await saveCoverLetterInTransaction(tx, userId, job.jobId!, content, markdown);
      return { status: "ok", saved: true, jobId: job.jobId, coverLetterId: letter.id, body: markdown };
    });
    if (fail) await expect(operation).rejects.toMatchObject({ code: "CONVERSATION_PERSISTENCE_FAILED" }); else await operation;
    expect(await b.coverLetter.count()).toBe(fail ? 0 : 1);
    const saved = await b.job.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(Boolean(saved.coverLetterId)).toBe(!fail);
    expect((await load()).messages.includes("generate_cover_letter")).toBe(!fail);
  } finally { if (fail) await a.$executeRawUnsafe("DROP TRIGGER fail_receipt"); }
});
