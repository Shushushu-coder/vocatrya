import "server-only";
import { managedLockFromRow, rejectManagedHistoricalExecution } from "@/lib/ai/managed-provenance";

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
      where: { conversationId: input.conversationId, userId: input.userId },
    });
    if (!row) return undefined;
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
    select: { messages: true, resolvedConnectionId: true, resolvedModel: true, managedAiProvenance: true },
  });
  if (!conversation) return null;
  const managed = managedLockFromRow(conversation);
  if (managed) {
    const connection = managed.connectionId ? await client.aIConnection.findFirst({
      where: { id: managed.connectionId, userId },
    }) : null;
    rejectManagedHistoricalExecution(managed, connection, userId);
  }
  const summary = await client.conversationSummary.findFirst({
    where: { conversationId, userId },
  });
  return {
    messages: parseMessages(conversation.messages),
    resolvedConnectionId: conversation.resolvedConnectionId,
    resolvedModel: conversation.resolvedModel,
    managedAiProvenance: conversation.managedAiProvenance,
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
        select: { messages: true },
      });
      if (!conversation) return null;
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
    const value = JSON.parse(raw) as unknown;
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
