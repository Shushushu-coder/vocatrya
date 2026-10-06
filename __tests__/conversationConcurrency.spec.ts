// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import { admitConversationRequest, cancelConversationRequest, checkpointConversationTool, finishConversationRequest, type ConversationRequest } from "@/lib/agent/conversationRequest";
import { makeAbTestDbUrl, preparePrismaProject, migrateDeploy } from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

const ctx = makeAbTestDbUrl();
const a = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const b = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;
let conversationId: string;
const user = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });
const assistant = (id = "answer"): UIMessage => ({ id, role: "assistant", parts: [{ type: "text", text: "done" }] });
const proposal = (): UIMessage => ({ id: "proposal", role: "assistant", parts: [{ type: "tool-add_job", toolCallId: "call", input: { company: "Acme", jobTitle: "Engineer" }, state: "approval-requested", approval: { id: "approval" } }] });
const load = () => b.chatConversation.findUniqueOrThrow({ where: { id: conversationId } });
const send = (requestId: string, expectedRevision = 0, db = a) => admitConversationRequest({ userId, conversationId, requestId, expectedRevision, operation: "send", newMessage: user(requestId) }, db);
const approve = (requestId: string, db = a) => admitConversationRequest({ userId, conversationId, requestId, expectedRevision: 0, operation: "approval", approvalId: "approval", decision: true }, db);
const regen = (requestId: string, db = a) => admitConversationRequest({ userId, conversationId, requestId, expectedRevision: 0, operation: "regenerate", targetMessageId: "answer" }, db);
async function checkpoint(request: ConversationRequest, db = a) {
  request.responseMessageId = "answer";
  return checkpointConversationTool(request, { toolName: "add_job", toolCallId: "call", input: { company: "Acme" } }, async tx => {
    const company = await tx.company.create({ data: { label: "Acme", value: `acme-${conversationId}`, createdBy: userId } });
    return { created: true, jobId: company.id };
  }, db);
}
beforeAll(async () => {
  fs.writeFileSync(ctx.url.slice(5), "");
  migrateDeploy(ctx.url, preparePrismaProject(ctx.dir));
  userId = await seedAccount(a, "concurrency@example.com");
}, 120000);
beforeEach(async () => {
  const row = await a.chatConversation.create({ data: { userId, messages: "[]" } });
  conversationId = row.id;
});
afterAll(async () => {
  await Promise.all([a.$disconnect(), b.$disconnect()]);
  // Only remove this verified disposable directory.
  if (ctx.dir.includes("vocatrya-ab-schema-")) fs.rmSync(ctx.dir, { recursive: true, force: true });
});

describe("real SQLite request authority with two independent clients", () => {
  it("admits exactly one concurrent sender and excludes the losing message", async () => {
    const result = await Promise.allSettled([send("a", 0, a), send("b", 0, b)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const loser = result.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason.code).toMatch(/CONVERSATION_(TURN_CONFLICT|STALE_WRITE)/);
    const row = await load();
    expect(row.revision).toBe(1);
    expect(JSON.parse(row.messages).map((m: UIMessage) => m.id)).toEqual([row.activeRequestId]);
  });
  it("rejects stale admission before mutation", async () => {
    await a.chatConversation.update({ where: { id: conversationId }, data: { revision: 5 } });
    await expect(send("stale", 4)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
    expect((await load()).messages).toBe("[]");
  });
  it("rejects a repeated active request identity", async () => {
    await send("a");
    await expect(send("a", 1, b)).rejects.toMatchObject({ code: "CONVERSATION_TURN_CONFLICT" });
  });
  it("cancel retains the admitted user, and late finish cannot overwrite a later turn", async () => {
    const first = await send("a");
    expect(await cancelConversationRequest(userId, conversationId, "a", b)).toBe(true);
    const second = await send("b", 2, b);
    await finishConversationRequest(second, [...second.messages, assistant()], b);
    await expect(finishConversationRequest(first, [user("a"), assistant("old")], a)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
    expect(JSON.parse((await load()).messages).map((m: UIMessage) => m.id)).toEqual(["a", "b", "answer"]);
  });
  it("a wrong cancellation identity cannot release the owner", async () => {
    await send("a");
    expect(await cancelConversationRequest(userId, conversationId, "wrong", b)).toBe(false);
    expect((await load()).activeRequestId).toBe("a");
  });
  it("abort before a tool rolls back all business mutation", async () => {
    const request = await send("a");
    await cancelConversationRequest(userId, conversationId, "a", b);
    await expect(checkpoint(request)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
    expect(await a.company.count({ where: { value: `acme-${conversationId}` } })).toBe(0);
  });
  it("tool before abort retains its atomic receipt", async () => {
    const request = await send("a");
    const output = await checkpoint(request);
    expect(request.revision).toBe(2);
    await cancelConversationRequest(userId, conversationId, "a", b);
    expect((await load()).revision).toBe(3);
    expect((await load()).messages).toContain(output.jobId);
    expect(await a.company.count({ where: { id: output.jobId } })).toBe(1);
    await expect(finishConversationRequest(request, request.messages, a)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
  });
  it("checkpoint failure rolls back mutation and revision together", async () => {
    const request = await send("a");
    await a.$executeRawUnsafe(`CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF messages ON ChatConversation WHEN NEW.id = '${conversationId}' BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END`);
    try {
      await expect(checkpoint(request)).rejects.toBeDefined();
      expect(await a.company.count({ where: { value: `acme-${conversationId}` } })).toBe(0);
      expect((await load()).revision).toBe(1);
      expect((await load()).messages).not.toContain("tool-add_job");
    } finally { await a.$executeRawUnsafe("DROP TRIGGER fail_checkpoint"); }
  });
  it("a final captured snapshot cannot remove a terminal checkpoint", async () => {
    const request = await send("a");
    const old = structuredClone(request.messages);
    const output = await checkpoint(request);
    await finishConversationRequest(request, [...old, assistant()], b);
    expect((await load()).messages).toContain(output.jobId);
    expect((await load()).revision).toBe(3);
    expect((await load()).activeRequestId).toBeNull();
  });
  it("expired cleanup commits its revision even when admission is stale", async () => {
    const request = await send("a");
    await a.chatConversation.update({ where: { id: conversationId }, data: { activeRequestExpiresAt: new Date(0) } });
    await expect(send("b", 1, b)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
    expect((await load()).revision).toBe(2);
    expect((await load()).activeRequestId).toBeNull();
    await send("b", 2, b);
    await expect(finishConversationRequest(request, [assistant("old")], a)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
  });
  it("an expired lease rejects tool execution and finish without cleanup", async () => {
    const request = await send("a");
    await a.chatConversation.update({ where: { id: conversationId }, data: { activeRequestExpiresAt: new Date(0) } });
    await expect(checkpoint(request)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
    await expect(finishConversationRequest(request, [assistant()], a)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
  });
  it("deleted rows never reappear on finish", async () => {
    const request = await send("a");
    await b.chatConversation.delete({ where: { id: conversationId } });
    await expect(finishConversationRequest(request, [assistant()], a)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
    expect(await a.chatConversation.findUnique({ where: { id: conversationId } })).toBeNull();
  });
  it("ownership checks reject another user on admission, cancel and finish", async () => {
    await expect(admitConversationRequest({ userId: "foreign", conversationId, requestId: "a", expectedRevision: 0, operation: "send", newMessage: user("a") }, b)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    const request = await send("a");
    expect(await cancelConversationRequest("foreign", conversationId, "a", b)).toBe(false);
    await expect(finishConversationRequest({ ...request, userId: "foreign" }, [assistant()], b)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
  });
  it("concurrent send/regenerate has one winner", async () => {
    await a.chatConversation.update({ where: { id: conversationId }, data: { messages: JSON.stringify([user("u"), assistant()]) } });
    const result = await Promise.allSettled([regen("r", a), send("s", 0, b)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("concurrent regenerate has one winner", async () => {
    await a.chatConversation.update({ where: { id: conversationId }, data: { messages: JSON.stringify([user("u"), assistant()]) } });
    const result = await Promise.allSettled([regen("r1", a), regen("r2", b)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("regenerate cannot destroy a successful write receipt", async () => {
    const message = proposal();
    message.id = "answer";
    Object.assign(message.parts[0], { state: "output-available", output: { created: true, jobId: "saved" } });
    await a.chatConversation.update({ where: { id: conversationId }, data: { messages: JSON.stringify([user("u"), message]) } });
    await expect(regen("r")).rejects.toMatchObject({ code: "CONVERSATION_TURN_CONFLICT" });
    expect((await load()).messages).toContain("saved");
  });
  it("rejects send while an unresolved proposal exists", async () => {
    await a.chatConversation.update({ where: { id: conversationId }, data: { messages: JSON.stringify([proposal()]) } });
    await expect(send("a")).rejects.toMatchObject({ code: "CONVERSATION_TURN_CONFLICT" });
  });
  it("only one concurrent approval admits and DB supplies the approved arguments", async () => {
    await a.chatConversation.update({ where: { id: conversationId }, data: { messages: JSON.stringify([proposal()]) } });
    const result = await Promise.allSettled([approve("a", a), approve("b", b)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = (result.find(r => r.status === "fulfilled") as PromiseFulfilledResult<ConversationRequest>).value;
    expect(winner.messages[0].parts[0]).toMatchObject({ input: { company: "Acme", jobTitle: "Engineer" }, approval: { approved: true }, state: "approval-responded" });
  });
  it("a wrong approval identity has no mutation", async () => {
    await a.chatConversation.update({ where: { id: conversationId }, data: { messages: JSON.stringify([proposal()]) } });
    await expect(admitConversationRequest({ userId, conversationId, requestId: "a", expectedRevision: 0, operation: "approval", approvalId: "tampered", decision: true }, a)).rejects.toMatchObject({ code: "CONVERSATION_TURN_CONFLICT" });
    expect((await load()).revision).toBe(0);
  });
  it("approval decision is durable at admission and survives abort", async () => {
    await a.chatConversation.update({ where: { id: conversationId }, data: { messages: JSON.stringify([proposal()]) } });
    await approve("a");
    await cancelConversationRequest(userId, conversationId, "a", b);
    expect((await load()).messages).toContain('"approved":true');
    await expect(approve("again", b)).rejects.toMatchObject({ code: "CONVERSATION_STALE_WRITE" });
  });
  it("admits a selected proposal without resolving another pending proposal", async () => {
    const message = proposal();
    message.parts.push({ ...message.parts[0], toolCallId: "second-call", approval: { id: "second-approval" } } as UIMessage["parts"][number]);
    await a.chatConversation.update({ where: { id: conversationId }, data: { messages: JSON.stringify([message]) } });
    const admitted = await approve("a");
    expect(admitted.approvalToolCallId).toBe("call");
    expect(admitted.messages[0].parts[1]).toMatchObject({ state: "approval-requested", approval: { id: "second-approval" } });
  });
  it("a repeated terminal tool call reuses its durable receipt without another mutation", async () => {
    const request = await send("a");
    const output = await checkpoint(request);
    const replay = await checkpoint(request, b);
    expect(replay).toEqual(output);
    expect(await a.company.count({ where: { value: `acme-${conversationId}` } })).toBe(1);
  });
  it("rolls back the canonical opportunity, JD, execution key and company when receipt persistence fails", async () => {
    const { activateFreshAbNative, AB_ROLLOUT_SCOPE_ENV, AB_RUNTIME_FEATURE_ENV } = await import("@/lib/career");
    const { createAgentOpportunityInTransaction } = await import("@/lib/career/createAgentOpportunity");
    vi.stubEnv(AB_RUNTIME_FEATURE_ENV, "true");
    vi.stubEnv(AB_ROLLOUT_SCOPE_ENV, "full");
    await activateFreshAbNative(a);
    const request = await send("canonical");
    request.responseMessageId = "answer";
    const input = { company: "Rollback Company", jobTitle: "Engineer", jobDescription: "An unabridged job description for transactional rollback", toolCallId: "canonical-call" };
    await a.$executeRawUnsafe(`CREATE TRIGGER fail_canonical BEFORE UPDATE OF messages ON ChatConversation WHEN NEW.id = '${conversationId}' BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END`);
    try {
      await expect(checkpointConversationTool(request, { toolName: "add_job", toolCallId: "canonical-call", input }, tx => createAgentOpportunityInTransaction(tx, input, userId), a)).rejects.toMatchObject({ code: "CONVERSATION_PERSISTENCE_FAILED" });
      expect(await b.jobOpportunity.count()).toBe(0);
      expect(await b.jobDescriptionVersion.count()).toBe(0);
      expect(await b.company.count({ where: { label: input.company } })).toBe(0);
      expect((await load()).revision).toBe(1);
    } finally {
      await a.$executeRawUnsafe("DROP TRIGGER fail_canonical");
      vi.unstubAllEnvs();
    }
  });
  it("canonical tool success survives continuation failure and its execution key prevents duplicate creation", async () => {
    const { AB_ROLLOUT_SCOPE_ENV, AB_RUNTIME_FEATURE_ENV } = await import("@/lib/career");
    const { createAgentOpportunityInTransaction } = await import("@/lib/career/createAgentOpportunity");
    vi.stubEnv(AB_RUNTIME_FEATURE_ENV, "true");
    vi.stubEnv(AB_ROLLOUT_SCOPE_ENV, "full");
    try {
      const request = await send("canonical");
      request.responseMessageId = "answer";
      const input = { company: "Saved Company", jobTitle: "Engineer", jobDescription: "A durable and complete job description", toolCallId: "saved-call" };
      const output = await checkpointConversationTool(request, { toolName: "add_job", toolCallId: "saved-call", input }, tx => createAgentOpportunityInTransaction(tx, input, userId), a);
      await cancelConversationRequest(userId, conversationId, request.requestId, b);
      expect((await load()).messages).toContain(output.jobOpportunityId);
      expect(await b.jobDescriptionVersion.count()).toBe(1);
      const replay = await b.$transaction(tx => createAgentOpportunityInTransaction(tx, input, userId));
      expect(replay).toMatchObject({ jobOpportunityId: output.jobOpportunityId, replayed: true });
      expect(await b.jobOpportunity.count()).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  });
});
