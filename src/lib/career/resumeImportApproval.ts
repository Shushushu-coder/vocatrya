import "server-only";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ParsedResumeImport } from "./resumeImportContract";

// Short-lived, signed client draft: no persistent staging, no facts before confirm.
// A server restart invalidates outstanding previews; user uploads again.
const key = randomBytes(32);
type Approval = {
  userId: string; requestId: string; expiresAt: number; name: string;
  rawText: string; parsed: ParsedResumeImport; resolvedConnectionId: string; resolvedModel: string;
};
function signature(payload: string) { return createHmac("sha256", key).update(payload).digest(); }
export function issueImportApproval(input: Omit<Approval, "requestId" | "expiresAt">) {
  const approval = { ...input, requestId: randomUUID(), expiresAt: Date.now() + 30 * 60 * 1000 };
  const payload = Buffer.from(JSON.stringify(approval)).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}
export function readImportApproval(token: string, userId: string): Approval {
  if (typeof token !== "string" || token.length > 2000000) throw new Error("IMPORT_APPROVAL_INVALID");
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra) throw new Error("IMPORT_APPROVAL_INVALID");
  const actual = Buffer.from(mac, "base64url");
  const expected = signature(payload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("IMPORT_APPROVAL_INVALID");
  const approval = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Approval;
  if (approval.userId !== userId || approval.expiresAt < Date.now()) throw new Error("IMPORT_APPROVAL_EXPIRED");
  return approval;
}
