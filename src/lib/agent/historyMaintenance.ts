import "server-only";
import type { PrismaClient, Prisma } from "@prisma/client";
import prisma from "@/lib/db";
import { readAgentPreferences } from "./preferences";
import { compressHistory, decodeHistory } from "./historyCodec";
import { parseConversationContext } from "./conversationContext";
import { restoredJobReferences } from "./restoredJobReferences";

const LIVE_TASKS = ["QUEUED", "RUNNING", "RETRY_WAIT", "CANCELLING"];
const DAY = 86_400_000;
const continuation = new Map<string, string>();
export function referencedHistoryJobs(context: string | null, messages: string): string[] {
  const ids = new Set([...restoredJobReferences(context), ...parseConversationContext(context).items.filter(i => i.kind === "job").map(i => i.entityId)]);
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "jobId" || key === "jobOpportunityId") && typeof child === "string") ids.add(child);
      if (key === "jobs" && Array.isArray(child)) for (const job of child) if (job && typeof job.id === "string") ids.add(job.id);
      visit(child);
    }
  };
  visit(JSON.parse(decodeHistory(messages)));
  return [...ids];
}
export function hasUnfinishedApproval(messages: string): boolean {
  const list: unknown = JSON.parse(decodeHistory(messages));
  if (!Array.isArray(list)) throw new Error("Invalid conversation messages");
  return list.some(m => Array.isArray(m?.parts) && m.parts.some((p: { state?: string }) => p.state === "approval-requested" || p.state === "approval-responded" || p.state === "input-streaming" || p.state === "input-available"));
}

/** Storage-only maintenance never changes conversation activity timestamps. */
export async function maintainChatHistory(db: PrismaClient = prisma, now = new Date(), onlyUserId?: string) {
  let archived = 0, compressed = 0;
  const users = await db.userSettings.findMany({ where: onlyUserId ? { userId: onlyUserId } : {}, select: { userId: true, settings: true } });
  for (const user of users) {
    let document: unknown;
    try { document = JSON.parse(user.settings); } catch { continue; }
    const prefs = readAgentPreferences(document);
    if (!prefs.autoArchiveDays && !prefs.compressHistory) continue;
    const ageDays = prefs.autoArchiveDays && prefs.compressHistory ? Math.min(7, prefs.autoArchiveDays) : prefs.compressHistory ? 7 : prefs.autoArchiveDays;
    let cursor: string | undefined = continuation.get(user.userId);
    // Bounded pages, so protected rows do not starve the next page.
    for (let page = 0; page < 10; page++) {
      const rows = await db.chatConversation.findMany({
        where: { userId: user.userId, updatedAt: { lt: new Date(now.getTime() - ageDays * DAY) }, activeRequestId: null },
        select: { id: true, userId: true, messages: true, context: true, revision: true, updatedAt: true, archivedAt: true },
        orderBy: { id: "asc" }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) { continuation.delete(user.userId); break; }
      cursor = rows[rows.length - 1].id;
      continuation.set(user.userId, cursor);
      for (const row of rows) {
        try {
          if (hasUnfinishedApproval(row.messages)) continue;
          const result = await db.$transaction(async tx => {
            // Recheck everything inside the write transaction, including a
            // settings change that disables maintenance after discovery.
            const settings = await tx.userSettings.findUnique({ where: { userId: row.userId }, select: { settings: true } });
            const currentPrefs = readAgentPreferences(settings ? JSON.parse(settings.settings) : null);
            const jobIds = referencedHistoryJobs(row.context, row.messages);
            const proposal = await tx.agentOperationProposal.findFirst({ where: { userId: row.userId, conversationId: row.id, OR: [
              { status: "PROPOSED" },
              { status: "APPROVED", OR: [{ outcomeStatus: null }, { outcomeStatus: "UNCERTAIN" }] },
            ] }, select: { id: true } });
            if (proposal) return { archived: 0, compressed: 0 };
            if (jobIds.length) {
              const goal = await tx.interviewPrepGoal.findFirst({ where: { userId: row.userId, jobOpportunityId: { in: jobIds }, status: { in: ["ACTIVE", "PAUSED"] } }, select: { id: true } });
              const task = await tx.harnessTask.findFirst({ where: { userId: row.userId, jobOpportunityId: { in: jobIds }, status: { in: LIVE_TASKS } }, select: { id: true } });
              if (goal || task) return { archived: 0, compressed: 0 };
            }
            const archive = currentPrefs.autoArchiveDays > 0 && !row.archivedAt && row.updatedAt.getTime() < now.getTime() - currentPrefs.autoArchiveDays * DAY;
            const nextMessages = currentPrefs.compressHistory && row.updatedAt.getTime() < now.getTime() - 7 * DAY ? compressHistory(row.messages) : row.messages;
            if (!archive && nextMessages === row.messages) return { archived: 0, compressed: 0 };
            const data: Prisma.ChatConversationUpdateManyMutationInput = { messages: nextMessages, updatedAt: row.updatedAt, ...(archive ? { archivedAt: now, revision: { increment: 1 } } : {}) };
            const saved = await tx.chatConversation.updateMany({ where: { id: row.id, userId: row.userId, revision: row.revision, updatedAt: row.updatedAt, activeRequestId: null, messages: row.messages, context: row.context, archivedAt: row.archivedAt }, data });
            return { archived: saved.count && archive ? 1 : 0, compressed: saved.count && nextMessages !== row.messages ? 1 : 0 };
          });
          archived += result.archived; compressed += result.compressed;
        } catch { console.warn("Chat history maintenance skipped an unreadable or concurrently changed record."); }
      }
      if (rows.length < 100) { continuation.delete(user.userId); break; }
    }
  }
  return { archived, compressed };
}

const globals = globalThis as typeof globalThis & { chatMaintenanceTimer?: ReturnType<typeof setInterval>; chatMaintenanceBusy?: boolean };
export function startChatHistoryMaintenance() {
  if (globals.chatMaintenanceTimer || process.env.NEXT_PHASE === "phase-production-build") return;
  const tick = async () => {
    if (globals.chatMaintenanceBusy) return;
    globals.chatMaintenanceBusy = true;
    try { await maintainChatHistory(); } catch { console.warn("Chat history maintenance unavailable; will retry."); }
    finally { globals.chatMaintenanceBusy = false; }
  };
  globals.chatMaintenanceTimer = setInterval(() => void tick(), 5 * 60_000);
  globals.chatMaintenanceTimer.unref?.();
  void tick();
}
