// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import { maintainChatHistory } from "@/lib/agent/historyMaintenance";
import { compressHistory, decodeHistory } from "@/lib/agent/historyCodec";
import { DEFAULT_AGENT_PREFERENCES } from "@/lib/agent/preferences";
import { admitConversationRequest, finishConversationRequest } from "@/lib/agent/conversationRequest";
import { collectBackupData } from "@/lib/backup/export";
import { listArchivedChatConversations, getOwnedChatConversation } from "@/lib/agent/chatConversationStore";
import { NOTION_REMOTE } from "@/lib/extensions/notion/constants";
import { makeTestDbUrl, pushSchema, seedAccount } from "./helpers/backupTestDb";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock("@/lib/db", () => ({ default: new Proxy({}, { get: (_t, key) => { const v = state.db[key as keyof PrismaClient]; return typeof v === "function" ? v.bind(state.db) : v; } }) }));
let ctx: { url: string; dir: string };
let db: PrismaClient;
let userId: string;
const now = new Date("2026-11-17T00:00:00Z");
const old = new Date("2026-08-01T00:00:00Z");
const raw = JSON.stringify([{ id: "u1", role: "user", parts: [{ type: "text", text: "保留全部内容与原始证据😀".repeat(2000) }] }]);
beforeAll(async () => {
  ctx = makeTestDbUrl(); pushSchema(ctx.url);
  db = new PrismaClient({ datasources: { db: { url: ctx.url } } }); state.db = db;
  userId = await seedAccount(db, `preferences-${randomUUID()}@example.com`);
  await db.userSettings.create({ data: { userId, settings: JSON.stringify({ settings: { general: { agent: { ...DEFAULT_AGENT_PREFERENCES, autoArchiveDays: 30, compressHistory: true } } } }) } });
}, 120_000);
afterAll(async () => { await db?.$disconnect(); /* Disposable DB retained for inspection under the test helper's temp path. */ });

it("archives and compresses cold history without changing activity, and exports original messages", async () => {
  const row = await db.chatConversation.create({ data: { userId, messages: raw, updatedAt: old } });
  const result = await maintainChatHistory(db, now, userId);
  expect(result.archived).toBeGreaterThan(0);
  const stored = await db.chatConversation.findUniqueOrThrow({ where: { id: row.id } });
  expect(stored.archivedAt).toEqual(now);
  expect(stored.updatedAt).toEqual(old);
  expect(stored.messages).not.toBe(raw);
  expect(decodeHistory(stored.messages)).toBe(raw);
  const backup = await collectBackupData(userId, { includeSensitiveData: true });
  const exported = (backup as unknown as { ChatConversation: { id: string; messages: string }[] }).ChatConversation.find(r => r.id === row.id);
  expect(exported?.messages).toBe(raw);
  expect((await getOwnedChatConversation(userId, row.id))?.messages).toBe(raw);
  expect((await listArchivedChatConversations(userId, "保留全部内容" )).some(r => r.id === row.id)).toBe(true);
  const reopened = new PrismaClient({ datasources: { db: { url: ctx.url } } });
  try { expect(decodeHistory((await reopened.chatConversation.findUniqueOrThrow({ where: { id: row.id } })).messages)).toBe(raw); }
  finally { await reopened.$disconnect(); }
});
it("excludes active requests, pending approvals, unrelated users and corrupted history", async () => {
  const active = await db.chatConversation.create({ data: { userId, messages: raw, updatedAt: old, activeRequestId: "running" } });
  const pending = await db.chatConversation.create({ data: { userId, messages: JSON.stringify([{ parts: [{ state: "approval-requested" }] }]), updatedAt: old } });
  const broken = await db.chatConversation.create({ data: { userId, messages: "vocatrya-chat-gzip-v1:corrupted", updatedAt: old } });
  const otherId = await seedAccount(db, `other-${randomUUID()}@example.com`);
  const other = await db.chatConversation.create({ data: { userId: otherId, messages: raw, updatedAt: old } });
  await maintainChatHistory(db, now, userId);
  for (const r of [active, pending, broken, other]) {
    const next = await db.chatConversation.findUniqueOrThrow({ where: { id: r.id } });
    expect(next.archivedAt).toBeNull(); expect(next.messages).toBe(r.messages);
  }
});
it("cold compression alone preserves revision; sending safely decodes the original history", async () => {
  await db.userSettings.update({ where: { userId }, data: { settings: JSON.stringify({ settings: { general: { agent: { ...DEFAULT_AGENT_PREFERENCES, compressHistory: true } } } }) } });
  const row = await db.chatConversation.create({ data: { userId, messages: raw, updatedAt: old } });
  await maintainChatHistory(db, now, userId);
  const stored = await db.chatConversation.findUniqueOrThrow({ where: { id: row.id } });
  expect(stored.revision).toBe(row.revision); expect(stored.messages).toBe(compressHistory(raw));
  const request = await admitConversationRequest({ userId, conversationId: row.id, requestId: randomUUID(), expectedRevision: 0, operation: "send", newMessage: { id: "next", role: "user", parts: [{ type: "text", text: "继续" }] } }, db);
  expect(request.messages[0]).toEqual(JSON.parse(raw)[0]);
});
it.each(["ask", "rules", "full"])("only persisted Full access auto-approves a durable external proposal (%s)", async mode => {
  await db.notionConnection.upsert({ where: { userId }, update: {}, create: { userId, status: "CONNECTED", workspaceId: "ws", availableTools: JSON.stringify([{ name: NOTION_REMOTE.createPages }]) } });
  const row = await db.chatConversation.create({ data: { userId, messages: "[]", context: JSON.stringify({ version: 1, items: [], permissionMode: mode }), agentRole: "pilot" } });
  const request = await admitConversationRequest({ userId, conversationId: row.id, requestId: randomUUID(), expectedRevision: 0, operation: "send", newMessage: { id: "u", role: "user", parts: [{ type: "text", text: "创建笔记" }] } }, db);
  request.responseMessageId = "a";
  const callId = randomUUID();
  const answer = { id: "a", role: "assistant", parts: [{ type: "tool-notion_create_page", state: "approval-requested", toolCallId: callId, input: { target: "p", targetType: "page", title: "求职笔记", content: "原始内容" }, approval: { id: randomUUID() } }] } as UIMessage;
  await finishConversationRequest(request, [...request.messages, answer], db);
  const proposal = await db.agentOperationProposal.findUniqueOrThrow({ where: { toolCallId: callId } });
  expect(proposal.status).toBe(mode === "full" ? "APPROVED" : "PROPOSED");
  expect(Boolean(proposal.harnessTaskId)).toBe(mode === "full");
  if (mode === "full") {
    expect(proposal.decisionReason).toBe("FULL_ACCESS_PREAUTHORIZED");
    expect(request.messages.at(-1)?.parts[0]).toMatchObject({ state: "output-available", output: { status: "queued", saved: false } });
    expect(proposal.dispatchedAt).toBeNull();
  }
});

it("does not archive historical job tasks, but allows settled external writes to age out", async () => {
  await db.userSettings.update({ where: { userId }, data: { settings: JSON.stringify({ settings: { general: { agent: { ...DEFAULT_AGENT_PREFERENCES, autoArchiveDays: 30 } } } }) } });
  const historical = await db.chatConversation.create({ data: { userId, context: '{"version":1,"items":[]}', messages: JSON.stringify([{ parts: [{ output: { jobOpportunityId: "historic-job" } }] }]), updatedAt: old } });
  await db.harnessTask.create({ data: { userId, kind: "DEEP_MATCH", requestKey: randomUUID(), inputHash: "hash", inputJson: "{}", jobOpportunityId: "historic-job", status: "RUNNING" } });
  const full = await db.agentOperationProposal.findFirstOrThrow({ where: { userId, decisionReason: "FULL_ACCESS_PREAUTHORIZED" } });
  await db.agentOperationProposal.update({ where: { id: full.id }, data: { outcomeStatus: "SUCCEEDED", outcomeJson: '{"saved":true}' } });
  await db.harnessTask.update({ where: { id: full.harnessTaskId! }, data: { status: "SUCCEEDED" } });
  await db.chatConversation.update({ where: { id: full.conversationId! }, data: { updatedAt: old } });
  await maintainChatHistory(db, now, userId);
  expect((await db.chatConversation.findUniqueOrThrow({ where: { id: historical.id } })).archivedAt).toBeNull();
  expect((await db.chatConversation.findUniqueOrThrow({ where: { id: full.conversationId! } })).archivedAt).toEqual(now);
});

it("continues beyond 1,000 protected records on the next maintenance tick", async () => {
  const owner = await seedAccount(db, `pagination-${randomUUID()}@example.com`);
  await db.userSettings.create({ data: { userId: owner, settings: JSON.stringify({ settings: { general: { agent: { ...DEFAULT_AGENT_PREFERENCES, autoArchiveDays: 30 } } } }) } });
  const prefix = randomUUID();
  await db.chatConversation.createMany({ data: Array.from({ length: 1000 }, (_, index) => ({ id: `${prefix}-a-${String(index).padStart(4, "0")}`, userId: owner, messages: '[{"parts":[{"state":"approval-requested"}]}]', updatedAt: old })) });
  const tail = await db.chatConversation.create({ data: { id: `${prefix}-z`, userId: owner, messages: "[]", updatedAt: old } });
  await maintainChatHistory(db, now, owner);
  expect((await db.chatConversation.findUniqueOrThrow({ where: { id: tail.id } })).archivedAt).toBeNull();
  await maintainChatHistory(db, now, owner);
  expect((await db.chatConversation.findUniqueOrThrow({ where: { id: tail.id } })).archivedAt).toEqual(now);
});
