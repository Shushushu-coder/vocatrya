// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { buildManifest, readManifest } from "@/lib/backup/manifest";
import { normalizeManifest } from "@/lib/backup/compat";
import { buildCreateData, IdMap } from "@/lib/backup/idmap";
import {
  BackupDataSchema,
  BackupError,
  ManifestSchema,
} from "@/lib/backup/schema";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

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
const originalUploads = APP_CONSTANTS.UPLOADS_DIR;
const EMAIL = "datetime-v1@example.com";

let userId: string;

async function zipOf(manifest: unknown, data: unknown): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("data.json", JSON.stringify(data));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function readZip(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return {
    manifest: JSON.parse(await zip.file("manifest.json")!.async("string")),
    data: JSON.parse(await zip.file("data.json")!.async("string")),
  };
}

beforeAll(async () => {
  const uploadsDir = path.join(ctx.dir, "uploads");
  fs.mkdirSync(path.join(uploadsDir, "files", "resumes"), { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;
}, 120_000);

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp dirs is a known flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, EMAIL);
});

async function seedDateTimeGraph() {
  const company = await prisma.company.create({
    data: { label: "Acme", value: "acme-dtv1", createdBy: userId },
  });
  const opportunity = await prisma.jobOpportunity.create({
    data: {
      userId,
      companyId: company.id,
      title: "Platform Engineer",
      status: "OPEN",
      deadline: null,
      deadlineOn: "2026-12-31",
      deadlinePrecision: "dateOnly",
    },
  });
  const legacyOpportunity = await prisma.jobOpportunity.create({
    data: {
      userId,
      companyId: company.id,
      title: "Legacy Instant Role",
      status: "OPEN",
      deadline: new Date("2026-11-15T09:30:00.000Z"),
    },
  });
  const attempt = await prisma.applicationAttempt.create({
    data: {
      userId,
      jobOpportunityId: opportunity.id,
      channelLabel: "Referral",
    },
  });
  const step = await prisma.applicationProcessStep.create({
    data: {
      applicationAttemptId: attempt.id,
      category: "INTERVIEW",
      label: "Technical screen",
      status: "PENDING",
      sortOrder: 10,
      scheduledAt: new Date("2026-11-20T02:00:00.000Z"),
      scheduledAtPrecision: "minute",
      scheduledAtZone: "Asia/Shanghai",
      deadlineAt: null,
      deadlineOn: "2026-11-25",
      deadlinePrecision: "dateOnly",
      deadlineZone: null,
      completedAt: null,
      completedAtPrecision: null,
      source: "USER",
    },
  });
  const minuteDeadlineStep = await prisma.applicationProcessStep.create({
    data: {
      applicationAttemptId: attempt.id,
      category: "ASSESSMENT",
      label: "Take-home",
      status: "PENDING",
      sortOrder: 20,
      deadlineAt: new Date("2026-11-26T15:59:00.000Z"),
      deadlinePrecision: "minute",
      deadlineZone: "Asia/Shanghai",
      source: "USER",
    },
  });
  const completedStep = await prisma.applicationProcessStep.create({
    data: {
      applicationAttemptId: attempt.id,
      category: "INTERVIEW",
      label: "HR screen",
      status: "COMPLETED",
      sortOrder: 30,
      completedAt: new Date("2026-11-10T06:00:00.000Z"),
      completedAtPrecision: "fullInstant",
      source: "USER",
    },
  });
  const task = await prisma.task.create({
    data: {
      userId,
      title: "Send follow-up",
      dueDate: null,
      dueOn: "2026-11-30",
      duePrecision: "dateOnly",
    },
  });
  const legacyTask = await prisma.task.create({
    data: {
      userId,
      title: "Legacy instant task",
      dueDate: new Date("2026-10-01T16:00:00.000Z"),
    },
  });
  return {
    company,
    opportunity,
    legacyOpportunity,
    attempt,
    step,
    minuteDeadlineStep,
    completedStep,
    task,
    legacyTask,
  };
}

describe("DateTime V1 backup schema", () => {
  it("keeps all ten sidecar fields as strings or null, without date coercion", () => {
    const parsed = BackupDataSchema.parse({
      ApplicationProcessStep: [
        {
          id: "s1",
          applicationAttemptId: "a1",
          category: "INTERVIEW",
          label: "Screen",
          status: "PENDING",
          sortOrder: 10,
          scheduledAt: "2026-11-20T02:00:00.000Z",
          deadlineAt: null,
          completedAt: null,
          result: null,
          source: "USER",
          notes: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          scheduledAtPrecision: "minute",
          scheduledAtZone: "Asia/Shanghai",
          deadlineOn: "2026-11-25",
          deadlinePrecision: "dateOnly",
          deadlineZone: null,
          completedAtPrecision: null,
        },
      ],
      JobOpportunity: [
        {
          id: "o1",
          companyId: "c1",
          campaignId: null,
          title: "Role",
          normalizedTitle: null,
          locationText: null,
          employmentType: null,
          recruitmentType: null,
          workplaceType: null,
          sourceSystem: null,
          sourceLabel: null,
          sourceUrl: null,
          externalSourceKey: null,
          deadline: null,
          deadlineOn: "2026-12-31",
          deadlinePrecision: "dateOnly",
          salaryText: null,
          status: "OPEN",
          currentJdVersionId: null,
          sourceAutomationId: null,
          discoveredAt: null,
          closedAt: null,
          notes: null,
          archivedAt: null,
          createdVia: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      Task: [
        {
          id: "t1",
          title: "Follow up",
          description: null,
          status: "in-progress",
          priority: 5,
          percentComplete: 0,
          dueDate: null,
          dueOn: "2026-11-30",
          duePrecision: "dateOnly",
          activityTypeId: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    const step = parsed.ApplicationProcessStep[0];
    // A DateOnly string must come back byte-identical — never a Date, never
    // a UTC-midnight instant derived from the calendar day.
    expect(step.deadlineOn).toBe("2026-11-25");
    expect(step.scheduledAtPrecision).toBe("minute");
    expect(step.scheduledAtZone).toBe("Asia/Shanghai");
    expect(step.deadlineZone).toBeNull();
    expect(step.completedAtPrecision).toBeNull();
    expect(parsed.JobOpportunity[0].deadlineOn).toBe("2026-12-31");
    expect(parsed.JobOpportunity[0].deadlinePrecision).toBe("dateOnly");
    expect(parsed.Task[0].dueOn).toBe("2026-11-30");
    expect(parsed.Task[0].duePrecision).toBe("dateOnly");
    expect(step.scheduledAt).toBeInstanceOf(Date);
  });

  it("accepts pre-v4 rows that carry no sidecar keys and restores them as absent", () => {
    const parsed = BackupDataSchema.parse({
      Task: [
        {
          id: "t1",
          title: "Old task",
          description: null,
          status: "done",
          priority: 5,
          percentComplete: 100,
          dueDate: "2026-10-01T16:00:00.000Z",
          activityTypeId: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    const row = parsed.Task[0];
    expect(row.dueOn).toBeUndefined();
    expect(row.duePrecision).toBeUndefined();

    const idMap = new IdMap();
    idMap.mint(row.id);
    const payload = buildCreateData("Task", row, idMap, "user-1");
    // A missing key reaches Prisma as undefined: the restored column takes its
    // default (NULL), and the legacy instant is never copied into *On.
    expect(payload.dueDate).toBeInstanceOf(Date);
    expect(payload).not.toHaveProperty("dueOn");
    expect(payload).not.toHaveProperty("duePrecision");
  });

  it("preserves a contradictory dual-carrier row verbatim for audit", () => {
    const parsed = BackupDataSchema.parse({
      ApplicationProcessStep: [
        {
          id: "s1",
          applicationAttemptId: "a1",
          category: "INTERVIEW",
          label: "Conflicted",
          status: "PENDING",
          sortOrder: 10,
          scheduledAt: null,
          deadlineAt: "2026-11-26T15:59:00.000Z",
          completedAt: null,
          result: null,
          source: "USER",
          notes: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          deadlineOn: "2026-11-25",
          deadlinePrecision: "minute",
          deadlineZone: "Asia/Shanghai",
        },
      ],
    });
    const row = parsed.ApplicationProcessStep[0];
    const idMap = new IdMap();
    idMap.mint("a1");
    idMap.mint(row.id);
    const payload = buildCreateData("ApplicationProcessStep", row, idMap, "u");
    // Both carriers stay populated. Restore must not silently pick one.
    expect(payload.deadlineAt).toBeInstanceOf(Date);
    expect(payload.deadlineOn).toBe("2026-11-25");
    expect(payload.deadlinePrecision).toBe("minute");
    expect(payload.deadlineZone).toBe("Asia/Shanghai");
  });

  it("passes sidecar fields through buildCreateData untouched", () => {
    const idMap = new IdMap();
    idMap.mint("old-task");
    const payload = buildCreateData(
      "Task",
      {
        id: "old-task",
        title: "x",
        dueOn: "2027-01-01",
        duePrecision: "dateOnly",
      },
      idMap,
      "u",
    );
    expect(payload.dueOn).toBe("2027-01-01");
    expect(payload.duePrecision).toBe("dateOnly");
  });
});

describe("format 4 manifest compat", () => {
  const base = {
    appVersion: "1.9.9",
    exportedAt: "2026-10-26T00:00:00.000Z",
    sourceEmail: "a@b.com",
    counts: {},
  };

  it("preserves containsSensitiveData=true on a v4 manifest", () => {
    const normalized = normalizeManifest({
      ...base,
      formatVersion: 4,
      containsSensitiveData: true,
    });
    expect(normalized.containsSensitiveData).toBe(true);
  });

  it("preserves containsSensitiveData=false on a v4 manifest", () => {
    const normalized = normalizeManifest({
      ...base,
      formatVersion: 4,
      containsSensitiveData: false,
    });
    expect(normalized.containsSensitiveData).toBe(false);
  });

  it("requires containsSensitiveData on v4 manifests, same as v3", () => {
    expect(() =>
      normalizeManifest({ ...base, formatVersion: 4 } as never),
    ).toThrow(/containsSensitiveData/);
    expect(() =>
      normalizeManifest({ ...base, formatVersion: 3 } as never),
    ).toThrow(/containsSensitiveData/);
  });

  it("still forces containsSensitiveData to false for v1 and v2", () => {
    for (const formatVersion of [1, 2] as const) {
      const normalized = normalizeManifest({
        ...base,
        formatVersion,
        containsSensitiveData: true,
      });
      expect(normalized.containsSensitiveData).toBe(false);
    }
  });

  it("rejects unknown future formats before normalization", () => {
    for (const formatVersion of [6, 99]) {
      expect(
        ManifestSchema.safeParse({ ...base, formatVersion }).success,
      ).toBe(false);
    }
  });

  it("lets a legacy v3 consumer reject format 4 instead of misparsing it", () => {
    // The manifest union a format-3 build shipped. Format 4 must fail this
    // literal check outright — an old consumer may not fall through and drop
    // the DateTime V1 sidecar keys it does not know about.
    const legacyConsumerSchema = z.object({
      formatVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    });
    expect(
      legacyConsumerSchema.safeParse({ ...base, formatVersion: 4 }).success,
    ).toBe(false);
    expect(
      ManifestSchema.safeParse({ ...base, formatVersion: 4 }).success,
    ).toBe(true);
  });
});

describe("DateTime V1 backup round-trip", () => {
  it("exports the current format with sidecar columns and restores them verbatim", async () => {
    const seeded = await seedDateTimeGraph();
    const { buffer } = await buildBackupZip(userId, EMAIL);
    const { manifest, data } = await readZip(buffer);

    expect(manifest.formatVersion).toBe(5);
    expect(manifest.containsSensitiveData).toBe(false);

    const exportedStep = data.ApplicationProcessStep.find(
      (r: { id: string }) => r.id === seeded.step.id,
    );
    expect(exportedStep.deadlineOn).toBe("2026-11-25");
    expect(exportedStep.deadlinePrecision).toBe("dateOnly");
    expect(exportedStep.scheduledAtPrecision).toBe("minute");
    expect(exportedStep.scheduledAtZone).toBe("Asia/Shanghai");
    expect(exportedStep.deadlineZone).toBeNull();

    const exportedOpp = data.JobOpportunity.find(
      (r: { id: string }) => r.id === seeded.opportunity.id,
    );
    expect(exportedOpp.deadline).toBeNull();
    expect(exportedOpp.deadlineOn).toBe("2026-12-31");
    expect(exportedOpp.deadlinePrecision).toBe("dateOnly");

    const exportedTask = data.Task.find(
      (r: { id: string }) => r.id === seeded.task.id,
    );
    expect(exportedTask.dueOn).toBe("2026-11-30");
    expect(exportedTask.duePrecision).toBe("dateOnly");

    await importBackup(buffer, userId, EMAIL, true);

    const step = await prisma.applicationProcessStep.findFirstOrThrow({
      where: { label: "Technical screen" },
    });
    expect(step.deadlineOn).toBe("2026-11-25");
    expect(step.deadlinePrecision).toBe("dateOnly");
    expect(step.deadlineAt).toBeNull();
    expect(step.deadlineZone).toBeNull();
    expect(step.scheduledAtPrecision).toBe("minute");
    expect(step.scheduledAtZone).toBe("Asia/Shanghai");
    expect(step.scheduledAt?.toISOString()).toBe("2026-11-20T02:00:00.000Z");

    const minuteStep = await prisma.applicationProcessStep.findFirstOrThrow({
      where: { label: "Take-home" },
    });
    expect(minuteStep.deadlineAt?.toISOString()).toBe(
      "2026-11-26T15:59:00.000Z",
    );
    expect(minuteStep.deadlinePrecision).toBe("minute");
    expect(minuteStep.deadlineZone).toBe("Asia/Shanghai");
    expect(minuteStep.deadlineOn).toBeNull();

    const completed = await prisma.applicationProcessStep.findFirstOrThrow({
      where: { label: "HR screen" },
    });
    expect(completed.completedAtPrecision).toBe("fullInstant");
    expect(completed.completedAt?.toISOString()).toBe(
      "2026-11-10T06:00:00.000Z",
    );

    const opp = await prisma.jobOpportunity.findFirstOrThrow({
      where: { userId, title: "Platform Engineer" },
    });
    expect(opp.deadlineOn).toBe("2026-12-31");
    expect(opp.deadlinePrecision).toBe("dateOnly");
    expect(opp.deadline).toBeNull();

    const task = await prisma.task.findFirstOrThrow({
      where: { userId, title: "Send follow-up" },
    });
    expect(task.dueOn).toBe("2026-11-30");
    expect(task.duePrecision).toBe("dateOnly");
    expect(task.dueDate).toBeNull();

    // Legacy instant rows keep the instant and stay NULL on every sidecar.
    const legacyOpp = await prisma.jobOpportunity.findFirstOrThrow({
      where: { userId, title: "Legacy Instant Role" },
    });
    expect(legacyOpp.deadline?.toISOString()).toBe("2026-11-15T09:30:00.000Z");
    expect(legacyOpp.deadlineOn).toBeNull();
    expect(legacyOpp.deadlinePrecision).toBeNull();

    const legacyTask = await prisma.task.findFirstOrThrow({
      where: { userId, title: "Legacy instant task" },
    });
    expect(legacyTask.dueDate?.toISOString()).toBe("2026-10-01T16:00:00.000Z");
    expect(legacyTask.dueOn).toBeNull();
    expect(legacyTask.duePrecision).toBeNull();
  }, 120_000);

  it("restores a v3 backup leaving every sidecar column NULL", async () => {
    await seedDateTimeGraph();
    const { buffer } = await buildBackupZip(userId, EMAIL);
    const { manifest, data } = await readZip(buffer);

    // Simulate a genuine v3 archive: same rows, older manifest, and none of
    // the sidecar keys a v3 exporter could not have written.
    manifest.formatVersion = 3;
    for (const row of data.ApplicationProcessStep) {
      delete row.scheduledAtPrecision;
      delete row.scheduledAtZone;
      delete row.deadlineOn;
      delete row.deadlinePrecision;
      delete row.deadlineZone;
      delete row.completedAtPrecision;
    }
    for (const row of data.JobOpportunity) {
      delete row.deadlineOn;
      delete row.deadlinePrecision;
    }
    for (const row of data.Task) {
      delete row.dueOn;
      delete row.duePrecision;
    }
    const v3 = await zipOf(manifest, data);
    await importBackup(v3, userId, EMAIL, true);

    const task = await prisma.task.findFirstOrThrow({
      where: { userId, title: "Send follow-up" },
    });
    // The v3 row carried no DateOnly fact: nothing may be inferred into it.
    expect(task.dueOn).toBeNull();
    expect(task.duePrecision).toBeNull();
    expect(task.dueDate).toBeNull();

    const step = await prisma.applicationProcessStep.findFirstOrThrow({
      where: { label: "Technical screen" },
    });
    expect(step.deadlineOn).toBeNull();
    expect(step.deadlinePrecision).toBeNull();
    expect(step.scheduledAtPrecision).toBeNull();
    expect(step.scheduledAtZone).toBeNull();
    expect(step.scheduledAt?.toISOString()).toBe("2026-11-20T02:00:00.000Z");
  }, 120_000);

  it("restores a v4 sensitive backup through the authorized sensitive path", async () => {
    const info = await prisma.candidateSensitiveInfo.create({
      data: {
        userId,
        idNumber: "DT-V1-SENSITIVE-MARKER",
        emergencyContactName: "Marker Name",
      },
    });
    const { buffer } = await buildBackupZip(userId, EMAIL, {
      includeSensitiveData: true,
    });
    const { manifest } = await readZip(buffer);
    expect(manifest.formatVersion).toBe(5);
    expect(manifest.containsSensitiveData).toBe(true);

    await prisma.candidateSensitiveInfo.deleteMany();
    await importBackup(buffer, userId, EMAIL, true);

    const restored = await prisma.candidateSensitiveInfo.findMany();
    expect(restored).toHaveLength(1);
    expect(restored[0].idNumber).toBe("DT-V1-SENSITIVE-MARKER");
    expect(restored[0].id).not.toBe(info.id);
  }, 120_000);

  it("fails closed on a v4 standard manifest whose payload holds sensitive keys", async () => {
    const data = BackupDataSchema.parse({});
    const buffer = await zipOf(
      {
        formatVersion: 4,
        appVersion: "9.9.9",
        exportedAt: "2026-10-26T00:00:00.000Z",
        sourceEmail: EMAIL,
        counts: {},
        containsSensitiveData: false,
      },
      { ...data, CandidateSensitiveInfo: [] },
    );
    await expect(importBackup(buffer, userId, EMAIL, true)).rejects.toBeInstanceOf(
      BackupError,
    );
  }, 60_000);

  it("rejects a v4 manifest missing containsSensitiveData", async () => {
    const buffer = await zipOf(
      {
        formatVersion: 4,
        appVersion: "9.9.9",
        exportedAt: "2026-10-26T00:00:00.000Z",
        sourceEmail: EMAIL,
        counts: {},
      },
      BackupDataSchema.parse({}),
    );
    await expect(importBackup(buffer, userId, EMAIL, true)).rejects.toBeInstanceOf(
      BackupError,
    );
  }, 60_000);

  it("rejects an unknown format 6 manifest", async () => {
    const buffer = await zipOf(
      {
        ...buildManifest(BackupDataSchema.parse({}), EMAIL),
        formatVersion: 6,
      },
      BackupDataSchema.parse({}),
    );
    await expect(importBackup(buffer, userId, EMAIL, true)).rejects.toBeInstanceOf(
      BackupError,
    );
  }, 60_000);

  it("restores a contradictory dual-carrier row without picking a side", async () => {
    await seedDateTimeGraph();
    const { buffer } = await buildBackupZip(userId, EMAIL);
    const { manifest, data } = await readZip(buffer);

    const row = data.JobOpportunity.find(
      (r: { title: string }) => r.title === "Platform Engineer",
    );
    row.deadline = "2026-12-31T23:59:00.000Z";
    row.deadlineOn = "2026-12-31";
    row.deadlinePrecision = "dateOnly";
    const mutated = await zipOf(manifest, data);
    await importBackup(mutated, userId, EMAIL, true);

    const opp = await prisma.jobOpportunity.findFirstOrThrow({
      where: { userId, title: "Platform Engineer" },
    });
    expect(opp.deadline?.toISOString()).toBe("2026-12-31T23:59:00.000Z");
    expect(opp.deadlineOn).toBe("2026-12-31");
    expect(opp.deadlinePrecision).toBe("dateOnly");
  }, 120_000);

  it("reads back v4 manifests through readManifest with the flag intact", async () => {
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify({
        formatVersion: 4,
        appVersion: "9.9.9",
        exportedAt: "2026-10-26T00:00:00.000Z",
        sourceEmail: EMAIL,
        counts: {},
        containsSensitiveData: true,
      }),
    );
    const manifest = await readManifest(zip);
    expect(manifest.formatVersion).toBe(4);
    expect(manifest.containsSensitiveData).toBe(true);
  });
});
