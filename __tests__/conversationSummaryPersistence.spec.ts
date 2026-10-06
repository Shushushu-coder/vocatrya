// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import { admitConversationRequest, finishConversationRequest } from "@/lib/agent/conversationRequest";
import { hashSummaryCoverage, validateConversationSummaryCoverage } from "@/lib/agent/conversationSummaryCoverage";
import { condenseCareerDialogueSummary, conversationSummaryInFlight, scheduleCareerDialogueSummary, type SummarySchedulerDeps } from "@/lib/agent/conversationSummaryScheduler";
import { createPrismaSummaryRepository } from "@/lib/agent/conversationSummaryStore";
import { makeAbTestDbUrl, migrateDeploy, preparePrismaProject } from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

const ctx = makeAbTestDbUrl();
const db = new PrismaClient({ datasourceUrl: ctx.url });
let userId: string;
const dialogue = (turns: number): UIMessage[] => Array.from({ length: turns * 2 }, (_, i) => ({
  id: `m${i}`, role: i % 2 ? "assistant" : "user", parts: [{ type: "text", text: `Career goal ${i}` }],
}));
beforeAll(async () => {
  migrateDeploy(ctx.url, preparePrismaProject(ctx.dir));
  userId = await seedAccount(db, "summary-persistence@example.com");
}, 120000);
afterAll(async () => {
  await db.$disconnect();
  const target = path.resolve(ctx.dir);
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith("vocatrya-ab-schema-")) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

it("does not cover or mutate an unresolved approval before the recent window", async () => {
  const messages = dialogue(30);
  messages[1].parts.push({ type: "tool-add_job", toolCallId: "pending", state: "approval-requested", input: { company: "Acme" }, approval: { id: "pending-approval" } });
  const row = await db.chatConversation.create({ data: { userId, messages: JSON.stringify(messages), resolvedConnectionId: "locked", resolvedModel: "model" } });
  const repository = createPrismaSummaryRepository(db);
  const executeText = vi.fn(async () => ({ text: "Should not generate" }));
  expect(await condenseCareerDialogueSummary({ userId, conversationId: row.id }, { repository, executeText, now: Date.now })).toMatchObject({ status: "skipped", reason: "no_boundary" });
  expect(executeText).not.toHaveBeenCalled();
  expect((await repository.load(userId, row.id))?.messages).toEqual(messages);
  expect(await db.conversationSummary.findUnique({ where: { conversationId: row.id } })).toBeNull();
});

it.each([16, 52, 60, 120])("commits and refreshes absolute summary coverage for %i persisted messages", async size => {
  const messages = dialogue(size / 2);
  messages[0].parts = [{ type: "text", text: "UNIQUE_CONSTRAINT_ALPHA EARLY_FACT_001" }];
  messages[1].parts.push({ type: "tool-add_job", toolCallId: "receipt", state: "output-available", input: { company: "Acme" }, output: { created: true, jobId: "durable-receipt" }, approval: { id: "approved", approved: true } });
  const row = await db.chatConversation.create({ data: { userId, messages: JSON.stringify(messages), resolvedConnectionId: "locked", resolvedModel: "model" } });
  const repository = createPrismaSummaryRepository(db);
  const executeText = vi.fn<SummarySchedulerDeps["executeText"]>(async ({ prompt }) => {
    expect(prompt).toContain("EARLY_FACT_001");
    return { text: "UNIQUE_CONSTRAINT_ALPHA EARLY_FACT_001: Career goals and agreed constraints." };
  });
  const deps = { repository, executeText, now: () => Date.now() };
  const input = { userId, conversationId: row.id };
  const result = await condenseCareerDialogueSummary(input, deps);
  expect(result.status).toBe("committed");
  const firstCount = Math.min(size - 10, 50);
  const first = await repository.load(userId, row.id);
  expect(first?.messages).toEqual(messages);
  expect(first?.summary).toMatchObject({ throughMessageId: `m${firstCount - 1}`, coveredCount: firstCount, revision: 1, failureCount: 0 });
  expect(first?.summary?.coverageHash).toBe(hashSummaryCoverage(messages.slice(0, firstCount)));
  expect(validateConversationSummaryCoverage(first?.summary, messages).status).toBe("FRESH");
  const firstPrompt = executeText.mock.calls[0]?.[0].prompt;
  const firstDelta = JSON.parse(firstPrompt!.split("New dialogue (JSON data):\n\n")[1]).new_messages;
  expect(firstDelta).toContain("User: UNIQUE_CONSTRAINT_ALPHA EARLY_FACT_001");
  expect(firstDelta).toContain(`Assistant: Career goal ${firstCount - 1}`);
  expect(firstDelta).not.toContain(`User: Career goal ${firstCount}\n`);
  expect(firstPrompt).not.toContain('"previous_summary":');

  // Append through F07 admission/finish, preserving the durable tool receipt.
  for (let turn = 0; turn < 3; turn++) {
    const current = await db.chatConversation.findUniqueOrThrow({ where: { id: row.id } });
    const request = await admitConversationRequest({ ...input, expectedRevision: current.revision, requestId: `append-${turn}`, operation: "send", newMessage: { id: `new-u${turn}`, role: "user", parts: [{ type: "text", text: "Next goal" }] } }, db);
    await finishConversationRequest(request, [...request.messages, { id: `new-a${turn}`, role: "assistant", parts: [{ type: "text", text: "Next answer" }] }], db);
  }
  const appended = await repository.load(userId, row.id);
  expect(appended?.messages).toHaveLength(size + 6);
  expect(validateConversationSummaryCoverage(first?.summary, appended!.messages).status).toBe("FRESH");
  expect(scheduleCareerDialogueSummary({ ...input, resolvedConnectionId: "locked", resolvedModel: "model", messages: appended!.messages }, deps).opened).toBe(true);
  await conversationSummaryInFlight(row.id);
  let refreshed = await repository.load(userId, row.id);
  const secondCount = size === 120 ? 80 : size - 4;
  expect(refreshed?.summary).toMatchObject({ throughMessageId: `m${secondCount - 1}`, coveredCount: secondCount, revision: 2 });
  const refreshPrompt = executeText.mock.calls[1][0].prompt;
  expect(refreshPrompt).toContain('"previous_summary":"UNIQUE_CONSTRAINT_ALPHA EARLY_FACT_001');
  const refreshDelta = JSON.parse(refreshPrompt.split("New dialogue (JSON data):\n\n")[1]).new_messages;
  expect(refreshDelta).toContain(`User: Career goal ${firstCount}`);
  expect(refreshDelta).not.toContain("EARLY_FACT_001");
  if (size === 120) {
    expect(await condenseCareerDialogueSummary(input, deps)).toMatchObject({ status: "committed", coveredCount: 116 });
    refreshed = await repository.load(userId, row.id);
  }
  const finalRevision = size === 120 ? 3 : 2;
  expect(refreshed?.summary).toMatchObject({ throughMessageId: `m${size - 5}`, coveredCount: size - 4, revision: finalRevision, failureCount: 0 });
  expect(validateConversationSummaryCoverage(refreshed?.summary, refreshed!.messages).status).toBe("FRESH");
  expect(await condenseCareerDialogueSummary(input, deps)).toMatchObject({ status: "skipped", reason: "trigger" });
  expect(executeText).toHaveBeenCalledTimes(finalRevision);

  // Change a covered message outside the recent window while a refresh is in flight.
  const more = [...refreshed!.messages, ...dialogue(3).map(m => ({ ...m, id: `tail-${m.id}` }))];
  await db.chatConversation.update({ where: { id: row.id }, data: { messages: JSON.stringify(more) } });
  const stale = await condenseCareerDialogueSummary(input, { ...deps, executeText: async () => {
    more[0] = { ...more[0], parts: [{ type: "text", text: "Regenerated covered goal" }] };
    await db.chatConversation.update({ where: { id: row.id }, data: { messages: JSON.stringify(more), revision: { increment: 1 } } });
    return { text: "Stale generation" };
  } });
  expect(stale.status).toBe("discarded");
  const rejected = await repository.load(userId, row.id);
  expect(rejected?.summary?.revision).toBe(finalRevision);
  expect(validateConversationSummaryCoverage(rejected?.summary, rejected!.messages)).toMatchObject({ status: "STALE", reason: "hash" });
});
