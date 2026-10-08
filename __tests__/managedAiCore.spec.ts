// @vitest-environment node
import { classifyAIConnection, supportedAccountProvidersForBackend, assertAccountExecutionIdentity } from "@/lib/ai/connections";
import { decodeManagedAiProvenance, encodeManagedAiProvenance, managedLockFromRow, rejectManagedHistoricalExecution } from "@/lib/ai/managed-provenance";
import { sessionAiLockFromRow, encodeLegacyInterviewLock } from "@/lib/interview/sessionAiLock";
import { chatLockFromRow } from "@/lib/agent/chatConversationLock";
import { managedAutomationLockFromRow } from "@/lib/scraper/automation-run/matchRuntime";
import { normalizeAIConnection } from "@/lib/backup/normalize";
import { BackupDataSchema, BACKUP_FORMAT_VERSION } from "@/lib/backup/schema";
import { buildCreateData, IdMap } from "@/lib/backup/idmap";
import { resolveRuntimeProfile } from "@/lib/ai/runtime/contract";

const provenance = {
  schemaVersion: 1 as const, managedBindingId: "binding-1", requestedModelKey: "vocatrya-fast",
  upstreamModelId: "upstream-v1", mappingRevision: "catalog-1", adapterContractRevision: "adapter-1",
};
const managed = { provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED",
  credentialRef: null, runtimeProfileRef: null, accountIdentity: null };
const raw = encodeManagedAiProvenance(provenance);
const lockRow = { managedAiProvenance: raw, resolvedConnectionId: "conn-1", resolvedModel: provenance.requestedModelKey };

describe("Managed identity contract", () => {
  it("recognizes only the complete Managed tuple, outside the account matrix", () => {
    expect(classifyAIConnection(managed)).toBe("MANAGED");
    expect(supportedAccountProvidersForBackend("MANAGED_GATEWAY")).toEqual([]);
    expect(classifyAIConnection({ ...managed, provider: "OPENAI", backendKind: "CODEX_RUNTIME", authType: "ACCOUNT_LOGIN", runtimeProfileRef: "rp_account" })).toBe("ACCOUNT_LOGIN");
  });
  it.each([
    { credentialRef: "secret-ref" }, { runtimeProfileRef: "rp_forged" }, { accountIdentity: "someone" },
    { authType: "ACCOUNT_LOGIN" }, { backendKind: "CODEX_RUNTIME" }, { provider: "OPENAI" },
    { authType: "API_KEY" }, { provider: "UNKNOWN" },
  ])("fails closed on an invalid tuple %j", (change) => {
    expect(classifyAIConnection({ ...managed, ...change })).toBe("INVALID");
    expect(() => assertAccountExecutionIdentity({ ...managed, ...change })).toThrow();
  });
  it("does not expose Managed execution or a forged runtime profile", () => {
    expect(() => assertAccountExecutionIdentity(managed)).toThrow(expect.objectContaining({ code: "MANAGED_EXECUTION_NOT_IMPLEMENTED" }));
    expect(() => resolveRuntimeProfile({ id: "c", backendKind: "MANAGED_GATEWAY", runtimeProfileRef: "rp_forged" })).toThrow();
  });
});

describe("Strict versioned historical provenance", () => {
  it("round trips V1 without reinterpreting catalog/model identity", () => {
    expect(decodeManagedAiProvenance(raw)).toEqual(provenance);
    expect(decodeManagedAiProvenance(null)).toBeNull();
  });
  it.each(["{", "null", "[]", "{}", JSON.stringify({ ...provenance, requestedModelKey: " " }),
    JSON.stringify({ ...provenance, schemaVersion: 2 }), JSON.stringify({ ...provenance, upstreamModelId: undefined }),
    JSON.stringify({ ...provenance, gatewayToken: "secret" })])("rejects malformed or unsupported provenance %s", (value) => {
    expect(() => decodeManagedAiProvenance(value)).toThrow(expect.objectContaining({ code: "MANAGED_PROVENANCE_INVALID" }));
  });
  it.each([sessionAiLockFromRow, chatLockFromRow, managedAutomationLockFromRow, managedLockFromRow])("recognizes Managed before any account/legacy fallback", (decode) => {
    expect(decode(lockRow)).toMatchObject({ kind: "managed", model: provenance.requestedModelKey, provenance });
    for (const id of [null, "ghost"]) {
      const lock = managedLockFromRow({ ...lockRow, resolvedConnectionId: id })!;
      expect(decode({ ...lockRow, resolvedConnectionId: id })).toMatchObject({ kind: "managed" });
      expect(() => rejectManagedHistoricalExecution(lock, null, "u")).toThrow(expect.objectContaining({ code: "MANAGED_BINDING_UNAVAILABLE" }));
    }
  });
  it("rejects foreign, archived and account connections; valid metadata still cannot execute", () => {
    const lock = managedLockFromRow(lockRow)!;
    const connection = { ...managed, id: "conn-1", userId: "u", archivedAt: null };
    expect(() => rejectManagedHistoricalExecution(lock, connection, "u")).toThrow(expect.objectContaining({ code: "MANAGED_EXECUTION_NOT_IMPLEMENTED" }));
    for (const change of [{ userId: "other" }, { archivedAt: new Date() }, { provider: "OPENAI" }]) {
      expect(() => rejectManagedHistoricalExecution(lock, { ...connection, ...change }, "u")).toThrow(expect.objectContaining({ code: "MANAGED_BINDING_UNAVAILABLE" }));
    }
  });
  it("rejects model reinterpretation and malformed provenance before legacy decoding", () => {
    expect(() => sessionAiLockFromRow({ ...lockRow, resolvedModel: "current-catalog-model" })).toThrow();
    expect(() => chatLockFromRow({ ...lockRow, managedAiProvenance: "{" })).toThrow();
  });
  it("preserves account, legacy envelope and null historical behavior", () => {
    const row = { managedAiProvenance: null, resolvedConnectionId: "own", resolvedModel: "own-model" };
    expect(sessionAiLockFromRow(row)).toEqual({ kind: "account", connectionId: "own", model: "own-model" });
    expect(chatLockFromRow(row)).toEqual({ kind: "account", connectionId: "own", model: "own-model" });
    expect(sessionAiLockFromRow({ ...row, resolvedConnectionId: null, resolvedModel: encodeLegacyInterviewLock("openrouter", "old-model") })).toEqual({ kind: "legacy", provider: "openrouter", model: "old-model" });
    expect(sessionAiLockFromRow({ ...row, resolvedConnectionId: null, resolvedModel: null })).toEqual({ kind: "unlocked" });
    expect(chatLockFromRow({ ...row, resolvedConnectionId: null, resolvedModel: null })).toEqual({ kind: "legacy" });
    expect(managedAutomationLockFromRow(row)).toBeNull();
  });
});

describe("Additive backup contract", () => {
  it("keeps the existing backup version and old payloads", () => {
    expect(BACKUP_FORMAT_VERSION).toBe(3);
    expect(BackupDataSchema.parse({}).AIConnection).toEqual([]);
  });
  it("preserves provenance for all six owners when a restore nulls or preserves dangling ids", () => {
    for (const owner of ["InterviewSession", "ChatConversation", "AutomationRun", "ResumeVariantVersion", "MatchAnalysis", "JobDescriptionParse"] as const) {
      const ids = new IdMap(); ids.set("old", "new");
      const model = owner === "MatchAnalysis" || owner === "JobDescriptionParse"
        ? { model: provenance.requestedModelKey } : { resolvedModel: provenance.requestedModelKey };
      const data = buildCreateData(owner, { id: "old", managedAiProvenance: raw, ...model, resolvedConnectionId: "ghost" }, ids, "u");
      expect(data.managedAiProvenance).toBe(raw);
      const decoded = managedLockFromRow({ managedAiProvenance: String(data.managedAiProvenance), resolvedModel: String(data.resolvedModel ?? data.model), resolvedConnectionId: data.resolvedConnectionId as string | null });
      expect(() => rejectManagedHistoricalExecution(decoded!, null, "u")).toThrow(expect.objectContaining({ code: "MANAGED_BINDING_UNAVAILABLE" }));
    }
  });
  it("restored CONNECTED metadata proves neither account login nor hosted authentication", () => {
    expect(normalizeAIConnection({ ...managed, status: "CONNECTED" }).status).toBe("REAUTH_REQUIRED");
    expect(normalizeAIConnection({ authType: "ACCOUNT_LOGIN", status: "CONNECTED" }).status).toBe("REAUTH_REQUIRED");
    expect(normalizeAIConnection({ authType: "API_KEY", status: "CONNECTED" }).status).toBe("CONNECTED");
  });
  it("rejects secret-bearing or forged Managed metadata in a backup", () => {
    const connection = { ...managed, id: "c", displayName: "Managed", status: "CONNECTED", providerMetadata: null,
      lastVerifiedAt: null, archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    expect(BackupDataSchema.safeParse({ AIConnection: [connection] }).success).toBe(true);
    for (const change of [{ credentialRef: "secret" }, { providerMetadata: '{"nested":{"gatewaySecret":"secret"}}' }, { runtimeProfileRef: "rp_forged" }]) {
      expect(BackupDataSchema.safeParse({ AIConnection: [{ ...connection, ...change }] }).success).toBe(false);
    }
  });
});
