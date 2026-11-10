// @vitest-environment node
// BD-ARCHIVE acceptance: portable backup round-trip must preserve archivedAt
// on JobOpportunity and ChatConversation (plus messages/context/summary and
// the retained application facts), and an older backup whose
// ChatConversation rows lack archivedAt must import without error, restoring
// those conversations as unarchived.
import fs from "fs";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { hasArchivedJobReference } from "@/lib/agent/archiveVisibility";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { makeTestDbUrl, pushSchema, seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

const EMAIL = "archive-roundtrip@example.com";
const ARCHIVED_AT = new Date("2026-10-01T08:00:00.000Z");
const STEP_SCHEDULED = new Date("2026-10-05T02:00:00.000Z");
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const TOOL_CALL_ID = "call-keep-1";
const APPROVAL_ID = "approval-keep-1";
const DANGLING_JOB_ID = "00000000-0000-4000-8000-000000000099";

function proseWithJobId(job: string): string {
  return `正文 ${job}\n\`\`\`js\nconst id = "${job}";\n\`\`\``;
}

function conversationContext(job: string, resume: string): string {
  return JSON.stringify({
    version: 1,
    items: [
      {
        kind: "job",
        entityId: job,
        labelSnapshot: `快照 ${job}`,
        source: "MANUAL",
      },
      {
        kind: "resume",
        entityId: resume,
        labelSnapshot: `简历快照 ${resume}`,
        source: "AUTO",
      },
      {
        kind: "job",
        entityId: DANGLING_JOB_ID,
        labelSnapshot: "悬空职位",
        source: "MANUAL",
      },
      {
        kind: "note",
        entityId: job,
        labelSnapshot: "不是结构化引用",
      },
      {
        kind: "job",
        entityId: resume,
        labelSnapshot: "类型不匹配",
        source: "MANUAL",
      },
    ],
  });
}

function conversationMessages(job: string, resume: string, letter: string): string {
  const prose = proseWithJobId(job);
  return JSON.stringify([
    {
      id: MESSAGE_ID,
      role: "user",
      parts: [{ type: "text", text: prose }],
    },
    {
      id: job,
      role: "assistant",
      parts: [
        { type: "text", text: prose },
        { type: "reasoning", text: `思考 ${job}`, providerMetadata: { x: job } },
        {
          type: "tool-get_job",
          toolCallId: TOOL_CALL_ID,
          state: "output-available",
          input: { jobId: job, note: `输入说明 ${job}` },
          output: {
            status: "ok",
            job: { id: job, title: `标题 ${job}`, jobDescription: `描述 ${job}` },
          },
          approval: { id: APPROVAL_ID, approved: true },
        },
        {
          type: "tool-list_jobs",
          toolCallId: "list-call",
          state: "output-available",
          input: {},
          output: {
            status: "ok",
            jobs: [{ id: job, title: `列表 ${job}` }],
            total: 1,
            truncated: false,
          },
        },
        {
          type: "tool-add_job",
          toolCallId: "add-call",
          state: "output-available",
          input: { company: "归档公司", jobTitle: `职位 ${job}` },
          output: {
            created: false,
            jobId: job,
            jobOpportunityId: job,
            duplicateOf: { id: job, title: `重复 ${job}`, company: "归档公司" },
            resolutions: [],
          },
        },
        {
          type: "tool-get_resume",
          toolCallId: "resume-call",
          state: "output-available",
          input: { resumeTitle: "简历甲" },
          output: {
            status: "ok",
            resumeId: resume,
            title: "简历甲",
            resumeText: `简历正文 ${resume}`,
            chars: 1,
            truncated: false,
            source: "named",
          },
        },
        {
          type: "tool-review_resume",
          toolCallId: "review-call",
          state: "output-available",
          input: {},
          output: {
            status: "needs_selection",
            resumes: [{ id: resume, title: `候选 ${resume}` }],
          },
        },
        {
          type: "tool-match_job",
          toolCallId: "match-call",
          state: "output-available",
          input: { resumeTitle: `标题 ${job}` },
          output: {
            status: "ok",
            jobId: job,
            resumeId: resume,
            body: `匹配正文 ${job} ${resume}`,
            saved: true,
          },
        },
        {
          type: "tool-generate_cover_letter",
          toolCallId: "letter-call",
          state: "output-available",
          input: {},
          output: {
            status: "ok",
            jobId: job,
            resumeId: resume,
            body: `求职信正文 ${letter}`,
            coverLetterId: letter,
            saved: true,
          },
        },
        {
          type: "dynamic-tool",
          toolName: "get_job",
          toolCallId: "dynamic-call",
          state: "output-available",
          input: { jobId: job },
          output: { status: "ok", job: { id: job, jobDescription: `动态描述 ${job}` } },
        },
        {
          type: "tool-unknown_tool",
          toolCallId: "unknown-call",
          state: "output-available",
          input: { jobId: job },
          output: { jobId: job, id: job, text: job },
        },
        ...["match_job", "generate_cover_letter"].map((name) => ({
          type: `tool-${name}`,
          toolCallId: `${name}-selection`,
          state: "output-available",
          output: { status: "needs_selection", resumes: [{ id: resume, title: `候选 ${resume}` }] },
        })),
      ],
    },
  ]);
}

let userId: string;
let jobId: string;
let resumeId: string;
let coverLetterId: string;
let attemptId: string;
let stepId: string;
let noteId: string;
let archivedConvId: string;
let activeConvId: string;

beforeAll(async () => {
  userId = await seedAccount(prisma, EMAIL);
  const company = await prisma.company.create({
    data: { label: "归档公司", value: "archive-co", createdBy: userId },
  });
  const job = await prisma.jobOpportunity.create({
    data: {
      userId,
      companyId: company.id,
      title: "已归档职位",
      normalizedTitle: "已归档职位",
      status: "ACTIVE",
      archivedAt: ARCHIVED_AT,
      notes: "job notes",
    },
  });
  jobId = job.id;
  const attempt = await prisma.applicationAttempt.create({
    data: {
      userId,
      jobOpportunityId: job.id,
      channelLabel: "官网投递",
      currentStageCategory: "APPLIED",
      outcome: "ACTIVE",
      submittedAt: new Date("2026-09-20T00:00:00.000Z"),
      archivedAt: ARCHIVED_AT,
    },
  });
  attemptId = attempt.id;
  const step = await prisma.applicationProcessStep.create({
    data: {
      applicationAttemptId: attempt.id,
      category: "INTERVIEW",
      label: "一面",
      status: "PENDING",
      sortOrder: 1,
      scheduledAt: STEP_SCHEDULED,
      source: "USER",
    },
  });
  stepId = step.id;
  const note = await prisma.jobOpportunityNote.create({
    data: { userId, jobOpportunityId: job.id, content: "归档笔记内容" },
  });
  noteId = note.id;
  const profile = await prisma.profile.create({ data: { userId } });
  const resume = await prisma.resume.create({
    data: { profileId: profile.id, title: "简历甲" },
  });
  resumeId = resume.id;
  const letter = await prisma.coverLetter.create({
    data: { profileId: profile.id, title: "求职信", content: "信件正文" },
  });
  coverLetterId = letter.id;

  const archivedConv = await prisma.chatConversation.create({
    data: {
      userId,
      title: "已归档对话",
      context: conversationContext(job.id, resume.id),
      messages: conversationMessages(job.id, resume.id, letter.id),
      archivedAt: ARCHIVED_AT,
      agentRole: "insight",
    },
  });
  archivedConvId = archivedConv.id;
  await prisma.conversationSummary.create({
    data: {
      conversationId: archivedConv.id,
      userId,
      text: "归档前生成的摘要",
      throughMessageId: "m2",
    },
  });
  const activeConv = await prisma.chatConversation.create({
    data: {
      userId,
      title: "未归档对话",
      messages: JSON.stringify([
        { id: "m1", role: "user", parts: [{ type: "text", text: "未归档正文" }] },
      ]),
    },
  });
  activeConvId = activeConv.id;
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

describe("archive backup round-trip", () => {
  it("exports archivedAt for JobOpportunity and ChatConversation", async () => {
    const { buffer } = await buildBackupZip(userId, EMAIL);
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    const job = data.JobOpportunity.find((r: { id: string }) => r.id === jobId);
    expect(job).toBeTruthy();
    expect(new Date(job.archivedAt).getTime()).toBe(ARCHIVED_AT.getTime());
    const conv = data.ChatConversation.find(
      (r: { id: string }) => r.id === archivedConvId,
    );
    expect(new Date(conv.archivedAt).getTime()).toBe(ARCHIVED_AT.getTime());
    expect(conv.agentRole).toBe("insight");
    const active = data.ChatConversation.find(
      (r: { id: string }) => r.id === activeConvId,
    );
    expect(active.archivedAt ?? null).toBeNull();
    expect(active.agentRole ?? null).toBeNull();
    // ConversationSummary is a disposable derived cache and is deliberately
    // not part of the portable backup.
    expect(data.ConversationSummary).toBeUndefined();
  }, 120_000);

  it("restores archived state, transcript, summary and retained facts", async () => {
    const { buffer } = await buildBackupZip(userId, EMAIL);
    await importBackup(buffer, userId, EMAIL, true);

    const job = await prisma.jobOpportunity.findFirstOrThrow({
      where: { userId, title: "已归档职位" },
    });
    expect(job.archivedAt?.getTime()).toBe(ARCHIVED_AT.getTime());
    expect(job.notes).toBe("job notes");

    const attempt = await prisma.applicationAttempt.findFirstOrThrow({
      where: { userId, jobOpportunityId: job.id },
      include: { processSteps: true },
    });
    expect(attempt.channelLabel).toBe("官网投递");
    expect(attempt.archivedAt?.getTime()).toBe(ARCHIVED_AT.getTime());
    expect(attempt.processSteps).toHaveLength(1);
    expect(attempt.processSteps[0].label).toBe("一面");
    expect(attempt.processSteps[0].scheduledAt?.getTime()).toBe(
      STEP_SCHEDULED.getTime(),
    );

    const note = await prisma.jobOpportunityNote.findFirstOrThrow({
      where: { userId, jobOpportunityId: job.id },
    });
    expect(note.content).toBe("归档笔记内容");

    const conv = await prisma.chatConversation.findFirstOrThrow({
      where: { userId, title: "已归档对话" },
      include: { conversationSummary: true },
    });
    expect(conv.archivedAt?.getTime()).toBe(ARCHIVED_AT.getTime());
    // Multi-agent role survives export → wipe → restore without downgrade.
    expect(conv.agentRole).toBe("insight");
    const activeRestored = await prisma.chatConversation.findFirstOrThrow({
      where: { userId, title: "未归档对话" },
    });
    expect(activeRestored.agentRole).toBeNull();
    const resume = await prisma.resume.findFirstOrThrow({
      where: { title: "简历甲", profile: { userId } },
    });
    const letter = await prisma.coverLetter.findFirstOrThrow({
      where: { title: "求职信", profile: { userId } },
    });
    const context = JSON.parse(conv.context ?? "{}") as {
      items: Array<{ kind: string; entityId: string; labelSnapshot: string }>;
    };
    expect(context.items[0]).toMatchObject({
      kind: "job",
      entityId: job.id,
      labelSnapshot: `快照 ${jobId}`,
    });
    expect(context.items[1]).toMatchObject({
      kind: "resume",
      entityId: resume.id,
      labelSnapshot: `简历快照 ${resumeId}`,
    });
    expect(context.items[2]).toMatchObject({
      kind: "job",
      entityId: DANGLING_JOB_ID,
      labelSnapshot: "悬空职位",
    });
    expect(context.items[3]).toMatchObject({
      kind: "note",
      entityId: jobId,
      labelSnapshot: "不是结构化引用",
    });
    expect(context.items[4]).toMatchObject({
      kind: "job",
      entityId: resumeId,
      labelSnapshot: "类型不匹配",
    });

    const prose = proseWithJobId(jobId);
    const messages = JSON.parse(conv.messages) as Array<{
      id: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(messages[0]?.id).toBe(MESSAGE_ID);
    expect(messages[0]?.parts[0]).toMatchObject({ type: "text", text: prose });
    expect(messages[1]?.id).toBe(jobId);
    expect(messages[1]?.parts[0]).toMatchObject({ type: "text", text: prose });
    expect(messages[1]?.parts[1]).toMatchObject({
      type: "reasoning",
      text: `思考 ${jobId}`,
      providerMetadata: { x: jobId },
    });
    expect(prose).not.toContain(job.id);

    const getJob = messages[1]?.parts[2];
    expect(getJob).toMatchObject({
      type: "tool-get_job",
      toolCallId: TOOL_CALL_ID,
      input: { jobId: job.id, note: `输入说明 ${jobId}` },
      output: {
        job: { id: job.id, title: `标题 ${jobId}`, jobDescription: `描述 ${jobId}` },
      },
      approval: { id: APPROVAL_ID, approved: true },
    });
    expect(messages[1]?.parts[3]).toMatchObject({
      output: { jobs: [{ id: job.id, title: `列表 ${jobId}` }] },
    });
    expect(messages[1]?.parts[4]).toMatchObject({
      input: { jobTitle: `职位 ${jobId}` },
      output: {
        jobId: job.id,
        jobOpportunityId: job.id,
        duplicateOf: { id: job.id, title: `重复 ${jobId}`, company: "归档公司" },
      },
    });
    expect(messages[1]?.parts[5]).toMatchObject({
      output: { resumeId: resume.id, resumeText: `简历正文 ${resumeId}` },
    });
    expect(messages[1]?.parts[6]).toMatchObject({
      output: { resumes: [{ id: resume.id, title: `候选 ${resumeId}` }] },
    });
    expect(messages[1]?.parts[7]).toMatchObject({
      input: { resumeTitle: `标题 ${jobId}` },
      output: {
        jobId: job.id,
        resumeId: resume.id,
        body: `匹配正文 ${jobId} ${resumeId}`,
      },
    });
    expect(messages[1]?.parts[8]).toMatchObject({
      output: {
        jobId: job.id,
        resumeId: resume.id,
        coverLetterId: letter.id,
        body: `求职信正文 ${coverLetterId}`,
      },
    });
    expect(messages[1]?.parts[9]).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "dynamic-call",
      input: { jobId: job.id },
      output: { job: { id: job.id, jobDescription: `动态描述 ${jobId}` } },
    });
    expect(messages[1]?.parts[10]).toMatchObject({
      type: "tool-unknown_tool",
      toolCallId: "unknown-call",
      input: { jobId },
      output: { jobId, id: jobId, text: jobId },
    });
    for (const index of [11, 12]) {
      expect(messages[1]?.parts[index]).toMatchObject({
        output: { status: "needs_selection", resumes: [{ id: resume.id, title: `候选 ${resumeId}` }] },
      });
    }
    expect(await hasArchivedJobReference(
      prisma,
      userId,
      conv.messages,
      conv.context,
    )).toBe(true);
    // The summary cache is not exported; it is rebuilt on eligible turns.
    expect(conv.conversationSummary).toBeNull();

    const active = await prisma.chatConversation.findFirstOrThrow({
      where: { userId, title: "未归档对话" },
    });
    expect(active.archivedAt).toBeNull();
  }, 120_000);

  it("imports an old-format backup missing ChatConversation.archivedAt", async () => {
    const { buffer } = await buildBackupZip(userId, EMAIL);
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    for (const row of data.ChatConversation ?? []) {
      delete row.archivedAt;
    }
    zip.file("data.json", JSON.stringify(data));
    await importBackup(
      await zip.generateAsync({ type: "nodebuffer" }),
      userId,
      EMAIL,
      true,
    );
    const convs = await prisma.chatConversation.findMany({
      where: { userId },
    });
    expect(convs.length).toBeGreaterThanOrEqual(2);
    expect(convs.every((c) => c.archivedAt === null)).toBe(true);
  }, 120_000);

  // D2/V12: backups taken before multi-agent roles carry no agentRole key;
  // they must import cleanly and restore every conversation as NULL
  // (the general assistant, slotted under Pilot — never back-filled).
  it("imports an old-format backup missing ChatConversation.agentRole", async () => {
    const { buffer } = await buildBackupZip(userId, EMAIL);
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    for (const row of data.ChatConversation ?? []) {
      delete row.agentRole;
    }
    zip.file("data.json", JSON.stringify(data));
    await importBackup(
      await zip.generateAsync({ type: "nodebuffer" }),
      userId,
      EMAIL,
      true,
    );
    const convs = await prisma.chatConversation.findMany({
      where: { userId },
    });
    expect(convs.length).toBeGreaterThanOrEqual(2);
    expect(convs.every((c) => c.agentRole === null)).toBe(true);
  }, 120_000);

  it.each(["prose", "unknown-tool"])("retains %s references across edits and repeated restores", async (source) => {
    const job = await prisma.jobOpportunity.findFirstOrThrow({ where: { userId } });
    const messages = JSON.stringify(source === "prose" ? [
      { id: "prose", role: "user", parts: [{ type: "text", text: `正文\n\`\`\`\n${job.id}\n\`\`\`` }] },
    ] : [
      { id: "unknown", role: "assistant", parts: [{ type: "tool-unknown", output: { jobId: job.id } }] },
    ]);
    await prisma.chatConversation.update({
      where: { id: (await prisma.chatConversation.findFirstOrThrow({ where: { userId, title: "未归档对话" } })).id },
      data: { messages, context: null },
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      const { buffer } = await buildBackupZip(userId, EMAIL);
      await importBackup(buffer, userId, EMAIL, true);
      const restoredJob = await prisma.jobOpportunity.findFirstOrThrow({ where: { userId } });
      const conv = await prisma.chatConversation.findFirstOrThrow({ where: { userId, title: "未归档对话" } });
      expect(conv.messages).toBe(messages);
      expect(conv.messages).not.toContain(restoredJob.id);
      await prisma.jobOpportunity.update({ where: { id: restoredJob.id }, data: { archivedAt: null } });
      expect(await hasArchivedJobReference(prisma, userId, conv.messages, conv.context)).toBe(false);
      // Context replacement must not erase server-side restore provenance.
      const { updateOwnedChatConversationContext } = await import("@/lib/agent/chatConversationStore");
      const edited = await updateOwnedChatConversationContext(userId, conv.id, { version: 1, items: [] });
      await prisma.jobOpportunity.update({ where: { id: restoredJob.id }, data: { archivedAt: ARCHIVED_AT } });
      expect(await hasArchivedJobReference(prisma, userId, edited.messages, edited.context)).toBe(true);
    }
  }, 120_000);

  it("rejects unsafe contexts before modifying the target database", async () => {
    const before = await prisma.chatConversation.findMany({ where: { userId }, orderBy: { id: "asc" } });
    const { buffer } = await buildBackupZip(userId, EMAIL);
    for (const invalid of ["{invalid", "[1,2]", "null"]) {
      const zip = await JSZip.loadAsync(buffer);
      const data = JSON.parse(await zip.file("data.json")!.async("string"));
      data.ChatConversation[0].context = invalid;
      data.ChatConversation[0].messages = data.JobOpportunity[0].id;
      zip.file("data.json", JSON.stringify(data));
      await expect(importBackup(await zip.generateAsync({ type: "nodebuffer" }), userId, EMAIL, true))
        .rejects.toThrow("Cannot safely restore conversation job references");
      expect(await prisma.chatConversation.findMany({ where: { userId }, orderBy: { id: "asc" } })).toEqual(before);
    }
  }, 120_000);

  it("preserves unknown, malformed and non-array conversation payloads", async () => {
    const { buffer } = await buildBackupZip(userId, EMAIL);
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    const archived = data.ChatConversation.find(
      (row: { title: string }) => row.title === "已归档对话",
    );
    const jobOld = data.JobOpportunity.find(
      (row: { title: string }) => row.title === "已归档职位",
    ).id as string;
    const unknownContext = JSON.stringify({
      version: 2,
      items: [{
        kind: "job",
        entityId: jobOld,
        labelSnapshot: `旧版 ${jobOld}`,
        source: "MANUAL",
      }],
    });
    archived.context = unknownContext;
    archived.messages = "{not-json";
    const active = data.ChatConversation.find(
      (row: { title: string }) => row.title === "未归档对话",
    );
    active.context = "[1,2,3]";
    const legacyMessages = JSON.stringify({ role: "user", content: "no job reference" });
    active.messages = legacyMessages;
    zip.file("data.json", JSON.stringify(data));
    await importBackup(
      await zip.generateAsync({ type: "nodebuffer" }),
      userId,
      EMAIL,
      true,
    );

    const restored = await prisma.chatConversation.findFirstOrThrow({
      where: { userId, title: "已归档对话" },
    });
    expect(JSON.parse(restored.context!)).toMatchObject(JSON.parse(unknownContext));
    expect(restored.messages).toBe("{not-json");
    const untouched = await prisma.chatConversation.findFirstOrThrow({
      where: { userId, title: "未归档对话" },
    });
    expect(untouched.context).toBe("[1,2,3]");
    expect(untouched.messages).toBe(legacyMessages);
  }, 120_000);
});
