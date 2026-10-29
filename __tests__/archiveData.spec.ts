// @vitest-environment node
// BD-ARCHIVE db-backed coverage: reversible archive for canonical jobs and
// AI conversations — CAS round trip, user isolation, write guards, reminder
// suppression/revival and the active-request lock release.
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  process.env.DATABASE_URL = url;
  return { url, dir };
});

import { seedAccount, resetDisposableDb } from "./helpers/backupTestDb";
import {
  archiveOwnedChatConversation,
  ChatConversationArchivedError,
  ChatConversationNotFoundError,
  listArchivedChatConversations,
  listOwnedChatConversations,
  unarchiveOwnedChatConversation,
  updateOwnedChatConversationContext,
} from "@/lib/agent/chatConversationStore";
import { admitConversationRequest } from "@/lib/agent/conversationRequest";
import { hasArchivedJobReference } from "@/lib/agent/archiveVisibility";
import { createPrismaSummaryRepository } from "@/lib/agent/conversationSummaryStore";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  activateFreshAbNative,
  OpportunityService,
} from "@/lib/career";
import {
  archiveOpportunity,
  listArchivedOpportunities,
  unarchiveOpportunity,
} from "@/lib/career/jobOpportunityAdapter";
import { REMINDER_SOURCE_TYPE, REMINDER_STATUS } from "@/lib/reminders/shared";
import { claimDueReminders, syncProcessStepReminder } from "@/lib/reminders/reminderService";

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};

let userId: string;
let otherUserId: string;
let companyId: string;

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  const stamp = `${Date.now()}-${Math.random()}`;
  userId = await seedAccount(prisma, `arch-${stamp}@example.com`);
  otherUserId = await seedAccount(prisma, `arch-other-${stamp}@example.com`);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-${stamp}`, createdBy: userId },
    })
  ).id;
  await activateFreshAbNative(prisma);
});

const userMsg = (text: string): UIMessage => ({
  id: `m-${text}`,
  role: "user",
  parts: [{ type: "text", text }],
});

async function createConversation(ownerId = userId) {
  return prisma.chatConversation.create({
    data: { userId: ownerId, messages: JSON.stringify([userMsg("hello")]) },
  });
}

async function createOpportunityWithStep() {
  const opportunities = new OpportunityService(prisma, userId, FEATURE_ON);
  const opportunity = await opportunities.create({
    companyId,
    title: "Staff Engineer",
  });
  const attempt = await prisma.applicationAttempt.create({
    data: {
      userId,
      jobOpportunityId: opportunity.id,
      channelLabel: "Portal",
    },
  });
  const step = await prisma.applicationProcessStep.create({
    data: {
      applicationAttemptId: attempt.id,
      category: "INTERVIEW",
      label: "Round 1",
      sortOrder: 0,
      scheduledAt: new Date("2026-11-01T06:00:00.000Z"),
    },
  });
  return { opportunity, attempt, step };
}

describe("archive migration", () => {
  it("appends archivedAt and per-user indexes without touching executed migrations", () => {
    const root = path.resolve(__dirname, "..");
    const dir = fs
      .readdirSync(path.join(root, "prisma", "migrations"))
      .find((name) => name.endsWith("archive_data"));
    expect(dir).toBeTruthy();
    const sql = fs.readFileSync(
      path.join(root, "prisma", "migrations", dir!, "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(
      /ALTER TABLE "ChatConversation" ADD COLUMN "archivedAt" DATETIME/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "ChatConversation_userId_archivedAt_idx"/,
    );
    expect(sql).toMatch(/CREATE INDEX "JobOpportunity_userId_archivedAt_idx"/);
    // Reversible archive never deletes rows.
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
    expect(sql).not.toMatch(/^\s*DROP\b/im);
  });
});

describe("conversation archive closed loop", () => {
  it("archives, hides from active reads, lists in the Archive Center and restores", async () => {
    const conversation = await createConversation();
    const archived = await archiveOwnedChatConversation(
      userId,
      conversation.id,
    );
    expect(archived.archivedAt).toBeInstanceOf(Date);

    expect(await listOwnedChatConversations(userId)).toHaveLength(0);
    const archivedRows = await listArchivedChatConversations(userId);
    expect(archivedRows.map((row) => row.id)).toEqual([conversation.id]);
    expect(archivedRows[0]!.archivedAt).toBeInstanceOf(Date);

    const restored = await unarchiveOwnedChatConversation(
      userId,
      conversation.id,
    );
    expect(restored.archivedAt).toBeNull();
    expect(await listOwnedChatConversations(userId)).toHaveLength(1);
    expect(await listArchivedChatConversations(userId)).toHaveLength(0);
  });

  it("is user-isolated and idempotent", async () => {
    const conversation = await createConversation();
    await archiveOwnedChatConversation(userId, conversation.id);
    await expect(
      archiveOwnedChatConversation(otherUserId, conversation.id),
    ).rejects.toBeInstanceOf(ChatConversationNotFoundError);
    await expect(
      unarchiveOwnedChatConversation(otherUserId, conversation.id),
    ).rejects.toBeInstanceOf(ChatConversationNotFoundError);
    // Already-archived is a success no-op for the owner.
    const again = await archiveOwnedChatConversation(
      userId,
      conversation.id,
    );
    expect(again.archivedAt).not.toBeNull();
  });

  it("releases the active-request lock and rejects any new admission", async () => {
    const conversation = await createConversation();
    await admitConversationRequest({
      userId,
      conversationId: conversation.id,
      requestId: "req-1",
      expectedRevision: 0,
      operation: "send",
      newMessage: userMsg("second"),
    });
    await archiveOwnedChatConversation(userId, conversation.id);
    const row = await prisma.chatConversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    expect(row.activeRequestId).toBeNull();
    await expect(
      admitConversationRequest({
        userId,
        conversationId: conversation.id,
        requestId: "req-2",
        expectedRevision: row.revision,
        operation: "send",
        newMessage: userMsg("third"),
      }),
    ).rejects.toMatchObject({ code: "CONVERSATION_ARCHIVED" });
  });

  it("rejects context writes on an archived conversation", async () => {
    const conversation = await createConversation();
    await archiveOwnedChatConversation(userId, conversation.id);
    await expect(
      updateOwnedChatConversationContext(userId, conversation.id, {
        version: 1,
        items: [],
      }),
    ).rejects.toBeInstanceOf(ChatConversationArchivedError);
  });
});

describe("canonical job archive closed loop", () => {
  it("blocks historical tool output, context snapshots and supplied messages until restore", async () => {
    const { opportunity } = await createOpportunityWithStep();
    const transcript = [{ role: "assistant", parts: [{ type: "tool-get_job", output: { job: { id: opportunity.id, description: "private posting" } } }] }];
    const conversation = await prisma.chatConversation.create({ data: { userId, messages: JSON.stringify(transcript) } });
    expect(await hasArchivedJobReference(prisma, userId, transcript)).toBe(false);
    await archiveOpportunity(prisma, userId, opportunity.id);
    const summarySnapshot = await createPrismaSummaryRepository(prisma).load(userId, conversation.id);
    expect(summarySnapshot).toMatchObject({ archived: true, messages: [], summary: null });
    expect(await hasArchivedJobReference(prisma, userId, JSON.stringify(transcript))).toBe(true);
    expect(await hasArchivedJobReference(prisma, userId, { items: [{ entityId: opportunity.id, labelSnapshot: "private title" }] })).toBe(true);
    expect(await hasArchivedJobReference(prisma, userId, [{ role: "user", parts: [{ type: "text", text: opportunity.id }] }])).toBe(true);
    expect(await hasArchivedJobReference(prisma, otherUserId, transcript)).toBe(false);
    expect(await hasArchivedJobReference(prisma, userId, [{ text: "unrelated conversation" }])).toBe(false);
    await unarchiveOpportunity(prisma, userId, opportunity.id);
    expect(await hasArchivedJobReference(prisma, userId, transcript)).toBe(false);
  });

  it("does not deliver a reminder revived by a stale reconcile after archive", async () => {
    const { opportunity, step } = await createOpportunityWithStep();
    await syncProcessStepReminder(prisma, userId, step.id);
    await archiveOpportunity(prisma, userId, opportunity.id);
    // Reproduce the final write of a reconcile holding a pre-archive snapshot.
    await prisma.reminder.updateMany({ where: { userId, targetId: step.id }, data: { status: REMINDER_STATUS.PENDING } });
    expect(await claimDueReminders(prisma, userId, new Date("2026-11-01T06:00:00.000Z"))).toEqual([]);
    expect((await prisma.reminder.findFirstOrThrow({ where: { userId, targetId: step.id } })).status).toBe(REMINDER_STATUS.EXPIRED);
  });

  it("archives and restores with reminder suppression and revival", async () => {
    const { opportunity, step } = await createOpportunityWithStep();
    await syncProcessStepReminder(prisma, userId, step.id);
    expect(
      (await prisma.reminder.findFirst({ where: { userId } }))?.status,
    ).toBe(REMINDER_STATUS.PENDING);

    await archiveOpportunity(prisma, userId, opportunity.id);
    const parked = await prisma.reminder.findUniqueOrThrow({
      where: {
        userId_sourceType_targetId: {
          userId,
          sourceType: REMINDER_SOURCE_TYPE.PROCESS_STEP,
          targetId: step.id,
        },
      },
    });
    // Suppression parks PENDING as EXPIRED so a restore can revive it.
    expect(parked.status).toBe(REMINDER_STATUS.EXPIRED);

    const archived = await listArchivedOpportunities(prisma, userId);
    expect(archived.map((row) => row.id)).toEqual([opportunity.id]);

    await unarchiveOpportunity(prisma, userId, opportunity.id);
    const revived = await prisma.reminder.findUniqueOrThrow({
      where: {
        userId_sourceType_targetId: {
          userId,
          sourceType: REMINDER_SOURCE_TYPE.PROCESS_STEP,
          targetId: step.id,
        },
      },
    });
    expect(revived.status).toBe(REMINDER_STATUS.PENDING);
    expect(
      await prisma.jobOpportunity.findUniqueOrThrow({
        where: { id: opportunity.id },
      }),
    ).toMatchObject({ archivedAt: null });
  });

  it("never rewrites a FIRED reminder across archive and restore", async () => {
    const { opportunity, step } = await createOpportunityWithStep();
    await syncProcessStepReminder(prisma, userId, step.id);
    await prisma.reminder.updateMany({
      where: { userId, targetId: step.id },
      data: { status: REMINDER_STATUS.FIRED, firedAt: new Date() },
    });
    await archiveOpportunity(prisma, userId, opportunity.id);
    await unarchiveOpportunity(prisma, userId, opportunity.id);
    expect(
      (
        await prisma.reminder.findUniqueOrThrow({
          where: {
            userId_sourceType_targetId: {
              userId,
              sourceType: REMINDER_SOURCE_TYPE.PROCESS_STEP,
              targetId: step.id,
            },
          },
        })
      ).status,
    ).toBe(REMINDER_STATUS.FIRED);
  });

  it("rejects writes on an archived opportunity and is user-isolated", async () => {
    const { opportunity } = await createOpportunityWithStep();
    const opportunities = new OpportunityService(prisma, userId, FEATURE_ON);
    const foreign = new OpportunityService(prisma, otherUserId, FEATURE_ON);
    await archiveOpportunity(prisma, userId, opportunity.id);

    await expect(
      opportunities.updateSafe(opportunity.id, { title: "Renamed" }),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_ARCHIVED" });
    // The active list no longer contains the row; archived listing does.
    expect(
      (await opportunities.list()).map((row) => row.id),
    ).not.toContain(opportunity.id);
    expect(
      (await opportunities.list({ includeArchived: true })).map(
        (row) => row.id,
      ),
    ).toContain(opportunity.id);

    // A foreign user can neither see nor mutate the archived row.
    await expect(
      foreign.archive(opportunity.id),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
    await expect(
      foreign.unarchive(opportunity.id),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
    expect(await listArchivedOpportunities(prisma, otherUserId)).toHaveLength(0);
  });
});
