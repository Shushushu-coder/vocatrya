// @vitest-environment node
import JSZip from "jszip";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/ai/chat/route";
import { PrismaClient } from "@prisma/client";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { encodeManagedAiProvenance, managedLockFromRow, rejectManagedHistoricalExecution } from "@/lib/ai/managed-provenance";
import { VocatryaInterviewModelAdapter } from "@/lib/interview/vocatryaHostPorts";
import { getAgentChatPreflight } from "@/actions/agentChat.actions";
import { listConnectionsForUser, listSelectableAccountConnectionsForUser, applyReconnectAuthenticated, applyVerifyResult, applyDisconnect, createVerifiedAccountConnection } from "@/lib/ai/connection-service";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { executeAIConnectionTextStream } from "@/lib/ai/streaming-execution";
import { mintAiConnectionTicket } from "@/actions/aiConnection.actions";
import { setBusinessAssignment } from "@/lib/ai/assignments";
import { checkStreamingTurnReadiness } from "@/lib/ai/streaming-execution";
import { condenseCareerDialogueSummary } from "@/lib/agent/conversationSummaryScheduler";
import { createPrismaSummaryRepository } from "@/lib/agent/conversationSummaryStore";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import { seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/abSchemaTestDb");
  const ctx = helpers.makeAbTestDbUrl();
  helpers.migrateDeploy(ctx.url, helpers.preparePrismaProject(ctx.dir));
  return { ...ctx, userId: "" };
});
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
});
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn(() => ({ user: { id: ctx.userId } })) }));
vi.mock("@/actions/shared", () => ({ requireUser: vi.fn(() => ({ id: ctx.userId })) }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const provenance = encodeManagedAiProvenance({ schemaVersion: 1, managedBindingId: "immutable-binding", requestedModelKey: "stable-model-key", upstreamModelId: "old-upstream", mappingRevision: "old-mapping", adapterContractRevision: "v1" });
async function assertBlockedChatTurn(conversation: { id: string; revision: number }, code: string) {
  const before = await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversation.id } });
  const response = await POST(new NextRequest("http://localhost/api/ai/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: conversation.id, expectedRevision: conversation.revision,
      requestId: `managed-${code}`, operation: "send", newMessage: { id: "hello", role: "user", parts: [{ type: "text", text: "hello" }] } }),
  }));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code });
  expect(await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ activeRequestId: null, revision: conversation.revision + 2, messages: JSON.stringify([...JSON.parse(before.messages), { id: "hello", role: "user", parts: [{ type: "text", text: "hello" }] }]), managedAiProvenance: before.managedAiProvenance, resolvedConnectionId: before.resolvedConnectionId, resolvedModel: before.resolvedModel });
}

let buffer: Buffer;
let connectionId: string;
beforeAll(async () => {
  ctx.userId = await seedAccount(prisma, "managed-backup@example.com");
  const connection = await prisma.aIConnection.create({ data: { userId: ctx.userId, provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED", displayName: "Vocatrya", status: "CONNECTED", providerMetadata: '{"catalogRevision":"v1"}' } });
  connectionId = connection.id;
  await prisma.aIBusinessAssignment.create({ data: { userId: ctx.userId, purpose: "GLOBAL_DEFAULT", connectionId, model: "stable-model-key" } });
  const lock = { resolvedConnectionId: connectionId, resolvedModel: "stable-model-key", managedAiProvenance: provenance };
  await prisma.chatConversation.create({ data: { userId: ctx.userId, messages: "[]", ...lock } });
  await prisma.interviewSession.create({ data: { userId: ctx.userId, coachingMode: "PRACTICE", feedbackReleasePolicy: "IMMEDIATE", knowledgeBaseVersion: "old-kb", ...lock } });
  const profile = await prisma.profile.create({ data: { userId: ctx.userId } });
  const resume = await prisma.resume.create({ data: { profileId: profile.id, title: "legacy resume" } });
  const automation = await prisma.automation.create({ data: { userId: ctx.userId, name: "history", jobBoard: "indeed", keywords: "engineer", location: "Shanghai", resumeId: resume.id, scheduleHour: 8, status: "paused" } });
  await prisma.automationRun.create({ data: { automationId: automation.id, status: "completed", ...lock } });
  const variant = await prisma.resumeVariant.create({ data: { userId: ctx.userId, name: "historical variant" } });
  await prisma.resumeVariantVersion.create({ data: { resumeVariantId: variant.id, versionNumber: 1, ...lock } });
  const company = await prisma.company.create({ data: { createdBy: ctx.userId, label: "Acme", value: "acme" } });
  const opportunity = await prisma.jobOpportunity.create({ data: { userId: ctx.userId, companyId: company.id, title: "engineer" } });
  const jd = await prisma.jobDescriptionVersion.create({ data: { jobOpportunityId: opportunity.id, versionNumber: 1, rawContent: "historical jd", capturedAt: new Date(), contentHash: "old-hash" } });
  const modelLock = { resolvedConnectionId: connectionId, model: "stable-model-key", managedAiProvenance: provenance };
  const parse = await prisma.jobDescriptionParse.create({ data: { jobDescriptionVersionId: jd.id, schemaVersion: "1", parserVersion: "1", structuredData: "{}", parseStatus: "COMPLETE", inputHash: "input", ...modelLock } });
  await prisma.matchAnalysis.create({ data: { userId: ctx.userId, jobOpportunityId: opportunity.id, jobDescriptionParseId: parse.id, analysisType: "QUICK_MATCH", inputHash: "input", analysisSchemaVersion: "1", status: "COMPLETE", ...modelLock } });
  ({ buffer } = await buildBackupZip(ctx.userId, "managed-backup@example.com"));
}, 120_000);
afterAll(async () => { await prisma.$disconnect(); });

describe("Managed local backup and execution boundaries", () => {
  it("exports only identity metadata, assignment and immutable provenance; restores no authentication authority", async () => {
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    expect(data.AIConnection[0]).toMatchObject({ provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED", credentialRef: null, runtimeProfileRef: null, accountIdentity: null });
    expect(data.ChatConversation[0].managedAiProvenance).toBe(provenance);
    for (const owner of ["InterviewSession", "AutomationRun", "ResumeVariantVersion", "MatchAnalysis", "JobDescriptionParse"]) {
      expect(data[owner][0].managedAiProvenance).toBe(provenance);
    }
    for (const name of ["Subscription", "ManagedAiBinding", "ManagedAiQuotaPeriod", "ManagedAiUsage", "Plan", "Entitlement", "GatewaySecret"]) expect(data).not.toHaveProperty(name);
    await importBackup(buffer, ctx.userId, "managed-backup@example.com", true);
    const connection = await prisma.aIConnection.findFirstOrThrow({ where: { userId: ctx.userId } });
    expect(connection.id).not.toBe(connectionId);
    expect(connection.status).toBe("REAUTH_REQUIRED");
    const owners = await Promise.all([prisma.interviewSession.findFirstOrThrow(), prisma.chatConversation.findFirstOrThrow(), prisma.automationRun.findFirstOrThrow(), prisma.resumeVariantVersion.findFirstOrThrow(), prisma.matchAnalysis.findFirstOrThrow(), prisma.jobDescriptionParse.findFirstOrThrow()]);
    for (const owner of owners) {
      expect(owner.managedAiProvenance).toBe(provenance);
      expect(owner.resolvedConnectionId).toBe(connection.id);
      const historical = managedLockFromRow(owner)!;
      expect(historical.model).toBe("stable-model-key");
      expect(() => rejectManagedHistoricalExecution(historical, connection, ctx.userId)).toThrow(expect.objectContaining({ code: "MANAGED_EXECUTION_NOT_IMPLEMENTED" }));
    }
    const assignment = await prisma.aIBusinessAssignment.findFirstOrThrow({ where: { userId: ctx.userId } });
    expect(assignment.connectionId).toBe(connection.id);
    const account = await prisma.aIConnection.create({ data: { userId: ctx.userId, provider: "OPENAI", backendKind: "CODEX_RUNTIME", displayName: "Own account", status: "REAUTH_REQUIRED" } });
    await prisma.aIConnection.create({ data: { userId: ctx.userId, provider: "OPENAI", backendKind: "CODEX_RUNTIME", displayName: "Archived account", archivedAt: new Date() } });
    await prisma.aIConnection.create({ data: { userId: ctx.userId, provider: "UNKNOWN", backendKind: "CODEX_RUNTIME", displayName: "Invalid identity" } });
    expect(await listConnectionsForUser(ctx.userId, prisma)).toEqual(expect.arrayContaining([expect.objectContaining({ id: connection.id })]));
    expect(await listSelectableAccountConnectionsForUser(ctx.userId, prisma)).toEqual([expect.objectContaining({ id: account.id })]);
    await expect(setBusinessAssignment({ userId: ctx.userId, purpose: "INTERVIEW", connectionId: connection.id, model: "stable-model-key" }, prisma)).rejects.toMatchObject({ code: "MANAGED_EXECUTION_NOT_IMPLEMENTED" });
    expect(await prisma.aIBusinessAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ connectionId: connection.id });

    const conversation = await prisma.chatConversation.findFirstOrThrow({ where: { userId: ctx.userId } });
    expect(conversation).toMatchObject({ resolvedConnectionId: connection.id, resolvedModel: "stable-model-key", managedAiProvenance: provenance });
    await assertBlockedChatTurn(conversation, "MANAGED_EXECUTION_NOT_IMPLEMENTED");
    const result = await getAgentChatPreflight({ conversationId: conversation.id });
    expect(result).toMatchObject({ success: false, code: "MANAGED_EXECUTION_NOT_IMPLEMENTED" });
    await expect(createPrismaSummaryRepository(prisma).load(ctx.userId, conversation.id)).rejects.toMatchObject({ code: "MANAGED_EXECUTION_NOT_IMPLEMENTED" });
    expect(await condenseCareerDialogueSummary({ userId: ctx.userId, conversationId: conversation.id })).toMatchObject({ status: "failed", reason: "MANAGED_EXECUTION_NOT_IMPLEMENTED" });
    const model = new VocatryaInterviewModelAdapter(prisma);
    const session = await prisma.interviewSession.findFirstOrThrow({ where: { userId: ctx.userId } });
    await expect(model.resolveInterviewModel({ requestingUserId: ctx.userId, sessionId: session.id })).rejects.toMatchObject({ code: "MANAGED_EXECUTION_NOT_IMPLEMENTED" });
  }, 120_000);

  it("restores pruned connection references and provenance with explicit failure, even with legacy settings configured", async () => {
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    data.AIConnection = []; data.AIBusinessAssignment = [];
    zip.file("data.json", JSON.stringify(data));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    manifest.counts.AIConnection = 0; manifest.counts.AIBusinessAssignment = 0;
    zip.file("manifest.json", JSON.stringify(manifest));
    await importBackup(await zip.generateAsync({ type: "nodebuffer" }), ctx.userId, "managed-backup@example.com", true);
    await prisma.userSettings.upsert({ where: { userId: ctx.userId }, create: { userId: ctx.userId, settings: '{"ai":{"provider":"ollama","model":"llama","interview":{"provider":"openrouter","model":"current"}}}' }, update: { settings: '{"ai":{"provider":"ollama","model":"llama","interview":{"provider":"openrouter","model":"current"}}}' } });
    const conversation = await prisma.chatConversation.findFirstOrThrow({ where: { userId: ctx.userId } });
    expect(conversation.managedAiProvenance).toBe(provenance);
    await assertBlockedChatTurn(conversation, "MANAGED_BINDING_UNAVAILABLE");
    await expect(createPrismaSummaryRepository(prisma).load(ctx.userId, conversation.id)).rejects.toMatchObject({ code: "MANAGED_BINDING_UNAVAILABLE" });
    expect(await condenseCareerDialogueSummary({ userId: ctx.userId, conversationId: conversation.id })).toMatchObject({ status: "failed", reason: "MANAGED_BINDING_UNAVAILABLE" });
    const owners = await Promise.all([prisma.automationRun.findFirstOrThrow(), prisma.resumeVariantVersion.findFirstOrThrow(), prisma.matchAnalysis.findFirstOrThrow(), prisma.jobDescriptionParse.findFirstOrThrow()]);
    for (const owner of owners) {
      expect(owner.managedAiProvenance).toBe(provenance);
      expect(() => rejectManagedHistoricalExecution(managedLockFromRow(owner)!, null, ctx.userId)).toThrow(expect.objectContaining({ code: "MANAGED_BINDING_UNAVAILABLE" }));
    }
    expect(await getAgentChatPreflight({ conversationId: conversation.id })).toMatchObject({ success: false, code: "MANAGED_BINDING_UNAVAILABLE" });
    const session = await prisma.interviewSession.findFirstOrThrow({ where: { userId: ctx.userId } });
    expect(session.managedAiProvenance).toBe(provenance);
    expect(session.resolvedConnectionId).toBeNull();
    const legacyResolver = { resolve: vi.fn(), resolveForConfig: vi.fn() };
    const execute = vi.fn();
    const model = new VocatryaInterviewModelAdapter(prisma, legacyResolver, execute);
    await expect(model.resolveInterviewModel({ requestingUserId: ctx.userId, sessionId: session.id })).rejects.toMatchObject({ code: "MANAGED_BINDING_UNAVAILABLE" });
    expect(legacyResolver.resolve).not.toHaveBeenCalled();
    expect(legacyResolver.resolveForConfig).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  }, 120_000);

  it("ordinary account CRUD cannot mutate Managed identity; shared Managed execution requires hosted auth", async () => {
    const connection = await prisma.aIConnection.create({ data: { userId: ctx.userId, provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED", displayName: "Vocatrya", status: "CONNECTED" } });
    const op = { userId: ctx.userId, connectionId: connection.id };
    for (const operation of [() => applyDisconnect(op, prisma), () => applyVerifyResult({ ...op, authState: "AUTHENTICATED" }, prisma), () => applyReconnectAuthenticated({ ...op, accountIdentity: "forged" }, prisma)]) {
      await expect(operation()).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION" });
    }
    await expect(createVerifiedAccountConnection({ userId: ctx.userId, backendKind: "MANAGED_GATEWAY", verifiedProvider: "VOCATRYA", runtimeProfileRef: "rp_forged", accountIdentity: null }, prisma)).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION" });
    const fetchImpl = vi.fn();
    const input = { ...op, model: "stable-model-key", prompt: "hello" };
    await expect(executeAIConnectionText(input, { dbClient: prisma, fetchImpl })).rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" });
    await expect(executeAIConnectionTextStream(input, { dbClient: prisma, fetchImpl }).next()).rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await prisma.aIBusinessAssignment.create({ data: { userId: ctx.userId, purpose: "MATCH_ANALYSIS", connectionId: connection.id, model: "stable-model-key" } });
    expect(await resolveBusinessAIConfig({ userId: ctx.userId, purpose: "MATCH_ANALYSIS" }, prisma)).toMatchObject({ status: "RESOLVED", model: input.model, backendKind: "MANAGED_GATEWAY" });
    expect(await prisma.aIConnection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({ accountIdentity: null, runtimeProfileRef: null, credentialRef: null, status: "CONNECTED" });
  });
  it("rejects an authType-only Managed marker before client ticket, assignment write or streaming probe", async () => {
    const connection = await prisma.aIConnection.create({ data: { userId: ctx.userId, provider: "OPENAI", backendKind: "CODEX_RUNTIME", authType: "MANAGED", displayName: "forged", status: "CONNECTED", runtimeProfileRef: "rp_forged" } });
    const fetchImpl = vi.fn();
    expect(await mintAiConnectionTicket({ operation: "verify", connectionId: connection.id, backendKind: "CODEX_RUNTIME" })).toMatchObject({ success: false, code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION" });
    const count = await prisma.aIBusinessAssignment.count();
    await expect(setBusinessAssignment({ userId: ctx.userId, purpose: "CAREER_DIALOGUE", connectionId: connection.id, model: "own-model" }, prisma, { fetchImpl })).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION" });
    expect(await prisma.aIBusinessAssignment.count()).toBe(count);
    await expect(checkStreamingTurnReadiness({ connection, model: "own-model", deps: { fetchImpl } })).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

});
