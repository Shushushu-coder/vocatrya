// @vitest-environment node
import { compressHistory, decodeHistory } from "@/lib/agent/historyCodec";
import { hasUnfinishedApproval, referencedHistoryJobs } from "@/lib/agent/historyMaintenance";
import { hasArchivedJobReference } from "@/lib/agent/archiveVisibility";
import type { PrismaClient } from "@prisma/client";
vi.mock("@/lib/db", () => ({ default: {} }));

describe("lossless history storage", () => {
  const raw = JSON.stringify([{ id: "m", role: "user", parts: [{ type: "text", text: "完整保留个人资料和原始工具记录😀\n".repeat(1000) }] }]);
  it("round-trips the exact JSON bytes including Unicode, and is idempotent", () => {
    const encoded = compressHistory(raw);
    expect(Buffer.byteLength(encoded)).toBeLessThan(Buffer.byteLength(raw));
    expect(decodeHistory(encoded)).toBe(raw);
    expect(compressHistory(encoded)).toBe(encoded);
    expect(decodeHistory(raw)).toBe(raw);
  });
  it("keeps tiny histories plain and rejects corrupt compression", () => {
    expect(compressHistory("[]")).toBe("[]");
    expect(() => decodeHistory("vocatrya-chat-gzip-v1:broken")).toThrow();
  });
  it("finds pending approval states in compressed as well as plain history", () => {
    const pending = JSON.stringify([{ parts: [{ state: "approval-requested", input: raw }] }]);
    expect(hasUnfinishedApproval(compressHistory(pending))).toBe(true);
    expect(hasUnfinishedApproval(raw)).toBe(false);
    expect(() => hasUnfinishedApproval("broken")).toThrow();
  });
  it("retains historical and restored job references after context removal", () => {
    const context = JSON.stringify({ version: 1, items: [], restoredJobReferences: ["restored"] });
    const history = JSON.stringify([{ parts: [{ output: { jobOpportunityId: "past", jobs: [{ id: "listed" }] } }] }]);
    expect(referencedHistoryJobs(context, compressHistory(history))).toEqual(["restored", "past", "listed"]);
  });
  it("still excludes archived job content from AI reads when the source history is compressed", async () => {
    const db = { jobOpportunity: { findMany: async () => [{ id: "archived-job" }] } } as unknown as PrismaClient;
    const history = JSON.stringify([{ parts: [{ output: { jobOpportunityId: "archived-job", content: "private".repeat(1000) } }] }]);
    expect(await hasArchivedJobReference(db, "owner", compressHistory(history))).toBe(true);
  });
});
