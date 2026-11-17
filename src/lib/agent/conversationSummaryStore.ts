import { decodeHistory } from "./historyCodec";
import "server-only";
import { hasArchivedJobReference } from "./archiveVisibility";
import {
  assertManagedHistoricalExecution,
  managedLockFromRow,
  type ManagedAiProvenanceV1,
} from "@/lib/ai/managed-provenance";
import { classifyAIConnection } from "@/lib/ai/connections";

import { Prisma, type PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import prisma from "@/lib/db";
import { log } from "@/lib/telemetry";
import {
  persistSummaryAttempt,
  type ConversationSummaryRecord,
  type SummaryAttempt,
} from "./conversationSummaryCommit";
import { validateConversationSummaryCoverage } from "./conversationSummaryCoverage";

type SummaryDb = PrismaClient | Prisma.TransactionClient;

export type SummaryRepository = {
  load: (
    userId: string,
    conversationId: string,
  ) => Promise<{
    messages: UIMessage[];
    resolvedConnectionId: string | null;
    resolvedModel: string | null;
    managedAiProvenance?: string | null;
    /**
     * Decoded Managed binding for a Managed-locked conversation —
     * validated against the live connection during load. Undefined for
     * account/legacy conversations.
     */
    managed?: { connectionId: string; model: string; provenance: ManagedAiProvenanceV1 };
    /** Fail-closed marker for an inconsistent lock row (M4 §114). */
    lockInvalid?: string;
    /** Archived conversations are AI-invisible: the scheduler must not
     *  read their messages or generate summaries for them (D6). */
    archived?: boolean;
    summary: ConversationSummaryRecord | null;
  } | null>;
  commit: (
    userId: string,
    conversationId: string,
    attempt: SummaryAttempt,
  ) => Promise<"committed" | "discarded">;
  recordFailure: (userId: string, conversationId: string, at: Date) => Promise<number>;
};

export function createPrismaSummaryRepository(client: SummaryDb = prisma): SummaryRepository {
  return {
    load: (userId, conversationId) => loadSummarySnapshot(client, userId, conversationId),
    commit: (userId, conversationId, attempt) =>
      commitSummarySnapshot(client, userId, conversationId, attempt),
    recordFailure: (userId, conversationId, at) =>
      recordSummaryFailure(client, userId, conversationId, at),
  };
}

export async function loadFreshConversationSummary(input: {
  userId: string;
  conversationId: string;
  messages: UIMessage[];
}): Promise<{ text: string; throughMessageId: string } | undefined> {
  try {
    const row = await prisma.conversationSummary.findFirst({
      where: {
        conversationId: input.conversationId,
        userId: input.userId,
        // Never feed an archived conversation's summary into a live turn.
        conversation: { archivedAt: null },
      },
    });
    if (!row) return undefined;
    const conversation = await prisma.chatConversation.findFirst({
      where: { id: input.conversationId, userId: input.userId },
      select: { messages: true, context: true },
    });
    if (!conversation || await hasArchivedJobReference(
      prisma, input.userId, conversation.messages, conversation.context, input.messages, row,
    )) return undefined;
    const verdict = validateConversationSummaryCoverage(toRecord(row), input.messages);
    if (verdict.status !== "FRESH") return undefined;
    return { text: verdict.text, throughMessageId: input.messages[verdict.throughIndex].id };
  } catch {
    log.info("[agent-chat] summary", { summaryStatus: "read_failed" });
    return undefined;
  }
}

async function loadSummarySnapshot(
  client: SummaryDb,
  userId: string,
  conversationId: string,
) {
  const conversation = await client.chatConversation.findFirst({
    where: { id: conversationId, userId },
    select: { messages: true, context: true, resolvedConnectionId: true, resolvedModel: true, managedAiProvenance: true, archivedAt: true },
  });
  if (!conversation) return null;
  if (conversation.archivedAt || await hasArchivedJobReference(client, userId, conversation.messages, conversation.context)) {
    // Archived: no messages, no lock, no summary — the scheduler skips.
    return {
      messages: [],
      resolvedConnectionId: null,
      resolvedModel: null,
      archived: true,
      summary: null,
    };
  }
  const managed = managedLockFromRow(conversation);
  let managedLock: { connectionId: string; model: string; provenance: ManagedAiProvenanceV1 } | undefined;
  let lockInvalid: string | undefined;
  if (managed) {
    // M4: summaries for Managed conversations are executable — validate
    // the binding is intact here so the scheduler fails explicitly rather
    // than re-resolving or silently degrading.
    const connection = managed.connectionId ? await client.aIConnection.findFirst({
      where: { id: managed.connectionId, userId },
    }) : null;
    try {
      assertManagedHistoricalExecution(managed, connection, userId);
      managedLock = {
        connectionId: managed.connectionId!,
        model: managed.model,
        provenance: managed.provenance,
      };
    } catch (error) {
      lockInvalid = error instanceof Error && "code" in error
        ? String((error as { code?: unknown }).code)
        : "MANAGED_BINDING_UNAVAILABLE";
    }
  } else if (conversation.resolvedConnectionId) {
    // Half-state (M4 §114): an account-shaped lock pointing at a Managed
    // connection has no usable provenance — mark it invalid instead of
    // letting the summary auto-bind at run time.
    const connection = await client.aIConnection.findFirst({
      where: { id: conversation.resolvedConnectionId, userId },
    });
    if (connection && classifyAIConnection(connection) === "MANAGED") {
      lockInvalid = "MANAGED_PROVENANCE_INVALID";
    }
  }
  const summary = await client.conversationSummary.findFirst({
    where: { conversationId, userId },
  });
  return {
    messages: parseMessages(conversation.messages),
    resolvedConnectionId: conversation.resolvedConnectionId,
    resolvedModel: conversation.resolvedModel,
    managedAiProvenance: conversation.managedAiProvenance,
    managed: managedLock,
    lockInvalid,
    summary: summary ? toRecord(summary) : null,
  };
}

async function commitSummarySnapshot(
  client: SummaryDb,
  userId: string,
  conversationId: string,
  attempt: SummaryAttempt,
): Promise<"committed" | "discarded"> {
  if ("$transaction" in client && typeof client.$transaction === "function") {
    return client.$transaction((tx) => commitOnClient(tx, userId, conversationId, attempt));
  }
  return commitOnClient(client, userId, conversationId, attempt);
}

async function commitOnClient(
  client: SummaryDb,
  userId: string,
  conversationId: string,
  attempt: SummaryAttempt,
): Promise<"committed" | "discarded"> {
  return persistSummaryAttempt({
    reload: async () => {
      const conversation = await client.chatConversation.findFirst({
        where: { id: conversationId, userId },
        select: { messages: true, archivedAt: true },
      });
      if (!conversation || conversation.archivedAt) return null;
      const summary = await client.conversationSummary.findUnique({
        where: { conversationId },
      });
      if (summary && summary.userId !== userId) return null;
      return {
        messages: parseMessages(conversation.messages),
        summary: summary ? toRecord(summary) : null,
      };
    },
    create: async (record) => {
      try {
        await client.conversationSummary.create({ data: record });
        return "created";
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          return "conflict";
        }
        throw error;
      }
    },
    update: async (expectedRevision, record) => {
      const updated = await client.conversationSummary.updateMany({
        where: { conversationId, userId, revision: expectedRevision },
        data: {
          text: record.text,
          throughMessageId: record.throughMessageId,
          coverageHash: record.coverageHash,
          coveredCount: record.coveredCount,
          promptVersion: record.promptVersion,
          revision: record.revision,
          units: record.units,
          generationMs: record.generationMs,
          generatedAt: record.generatedAt,
          failureCount: 0,
          lastFailureAt: null,
        },
      });
      return updated.count;
    },
    attempt,
  });
}

async function recordSummaryFailure(
  client: SummaryDb,
  userId: string,
  conversationId: string,
  at: Date,
): Promise<number> {
  const write = async (db: SummaryDb) => {
    const conversation = await db.chatConversation.findFirst({
      where: { id: conversationId, userId },
      select: { archivedAt: true },
    });
    if (!conversation || conversation.archivedAt) return 0;
    const existing = await db.conversationSummary.findUnique({
      where: { conversationId },
    });
    if (existing && existing.userId !== userId) return existing.failureCount;
    if (!existing) {
      const created = await db.conversationSummary.create({
        data: {
          conversationId,
          userId,
          revision: 0,
          failureCount: 1,
          lastFailureAt: at,
        },
      });
      return created.failureCount;
    }
    const updated = await db.conversationSummary.update({
      where: { conversationId },
      data: {
        failureCount: existing.failureCount + 1,
        lastFailureAt: at,
      },
    });
    return updated.failureCount;
  };
  if ("$transaction" in client) {
    return (client as PrismaClient).$transaction((tx) => write(tx));
  }
  return write(client);
}

function parseMessages(raw: string): UIMessage[] {
  try {
    const value = JSON.parse(decodeHistory(raw)) as unknown;
    return Array.isArray(value) ? (value as UIMessage[]) : [];
  } catch {
    return [];
  }
}

function toRecord(row: {
  conversationId: string;
  userId: string;
  text: string | null;
  throughMessageId: string | null;
  coverageHash: string | null;
  coveredCount: number | null;
  promptVersion: string | null;
  revision: number;
  units: number | null;
  generationMs: number | null;
  generatedAt: Date | null;
  failureCount: number;
  lastFailureAt: Date | null;
}): ConversationSummaryRecord {
  return { ...row };
}
