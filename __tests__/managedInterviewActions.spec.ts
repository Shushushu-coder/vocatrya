// @vitest-environment node
import { PrismaClient } from "@prisma/client";
import { sendInterviewFollowUpAction } from "@/actions/interview.actions";
import { encodeManagedAiProvenance } from "@/lib/ai/managed-provenance";
import { translate } from "@/i18n/translate";
import type { Locale } from "@/i18n/config";
import { seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/abSchemaTestDb");
  const ctx = helpers.makeAbTestDbUrl();
  helpers.migrateDeploy(ctx.url, helpers.preparePrismaProject(ctx.dir));
  return { ...ctx, userId: "", locale: "zh-CN" as "zh-CN" | "en" };
});
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
});
vi.mock("@/actions/shared", () => ({ requireUser: () => ({ id: ctx.userId }) }));
vi.mock("@/i18n/server", () => ({ getServerLocale: () => ctx.locale }));
const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const provenance = encodeManagedAiProvenance({ schemaVersion: 1, managedBindingId: "private-binding", requestedModelKey: "stable-model", upstreamModelId: "private-upstream", mappingRevision: "private-revision", adapterContractRevision: "v1" });
let connectionId: string;
beforeAll(async () => {
  ctx.userId = await seedAccount(db, "managed-action@example.com");
  const connection = await db.aIConnection.create({ data: { userId: ctx.userId, provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED", displayName: "Managed", status: "REAUTH_REQUIRED" } });
  connectionId = connection.id;
});
afterAll(async () => { await db.$disconnect(); });

describe("Managed errors cross the real Interview action/service/host boundary", () => {
  it.each([
    "MANAGED_BINDING_UNAVAILABLE",
    "MANAGED_PROVENANCE_INVALID",
    "MANAGED_EXECUTION_NOT_IMPLEMENTED",
  ])("preserves %s with participant-safe messages in both locales", async (code) => {
    const session = await db.interviewSession.create({ data: {
      userId: ctx.userId, coachingMode: "PRACTICE", feedbackReleasePolicy: "IMMEDIATE", knowledgeBaseVersion: "old-kb",
      resolvedConnectionId: code === "MANAGED_BINDING_UNAVAILABLE" ? null : connectionId,
      resolvedModel: "stable-model", managedAiProvenance: code === "MANAGED_PROVENANCE_INVALID" ? "{private-json" : provenance,
    } });
    for (const locale of ["zh-CN", "en"] as Locale[]) {
      ctx.locale = locale;
      const result = await sendInterviewFollowUpAction({ sessionId: session.id, userText: "Help me improve." });
      expect(result).toEqual({ success: false, code, message: translate(locale, `interview.errors.${code}`) });
      if (!result.success) expect(result.message).not.toMatch(/private-|stable-model|mappingRevision|\{/);
    }
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      managedAiProvenance: session.managedAiProvenance, resolvedConnectionId: session.resolvedConnectionId,
    });
    expect(await db.dialogueTurn.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it("keeps existing ordinary error mapping", async () => {
    expect(await sendInterviewFollowUpAction({ sessionId: "missing", userText: "Hello" })).toMatchObject({ success: false, code: "SESSION_NOT_FOUND", message: "面试会话不存在。" });
  });
});
