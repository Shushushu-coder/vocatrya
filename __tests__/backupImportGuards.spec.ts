import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { APP_CONSTANTS } from "@/lib/constants";
import db from "@/lib/db";
import { importBackup } from "@/lib/backup/import";
import { BackupError, buildManifest } from "@/lib/backup/manifest";
import { emptyStandardBackupData } from "@/lib/backup/compat";
import { syncSchedulerState } from "@/lib/scheduler";
import { writeSnapshot } from "@/lib/backup/snapshot";

vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

// Mocked so the guards spec never touches the filesystem; Task 4.1 covers the
// real thing and Task 7.2 exercises it end to end.
vi.mock("@/lib/backup/snapshot", () => ({
  writeSnapshot: vi
    .fn()
    .mockResolvedValue("data/backups/user-1/pre-import-x.zip"),
}));

vi.mock("@/lib/db", async () => {
  const { INSERT_ORDER, MODEL_SPECS } = await import("@/lib/backup/ordering");
  const counted = () => ({
    count: vi.fn().mockResolvedValue(0),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    findFirst: vi.fn().mockResolvedValue(null),
  });
  const mock: Record<string, unknown> = {
    automationRun: { ...counted(), findFirst: vi.fn().mockResolvedValue(null) },
    jobStatus: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    user: {
      update: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ defaultResumeId: null }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mock),
    ),
  };
  for (const model of INSERT_ORDER) {
    mock[MODEL_SPECS[model].delegate] = counted();
  }
  mock.chatConversation = counted();
  mock.dataMigrationRun = counted();
  return { default: mock };
});

const mockDb = db as unknown as Record<
  string,
  Record<string, ReturnType<typeof vi.fn>>
>;

async function emptyBackup(): Promise<Buffer> {
  const data = emptyStandardBackupData();
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify(buildManifest(data, "owner@example.com")),
  );
  zip.file("data.json", JSON.stringify(data));
  return zip.generateAsync({ type: "nodebuffer" });
}

const EMAIL = "owner@example.com";

describe("importBackup guards", () => {
  it("refuses a non-empty target without confirmWipe", async () => {
    mockDb.job.count.mockResolvedValueOnce(4);
    await expect(
      importBackup(await emptyBackup(), "user-1", EMAIL, false),
    ).rejects.toThrow(/confirm/i);
    expect(mockDb.job.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses before any write when the target has a run in flight", async () => {
    mockDb.automationRun.findFirst.mockResolvedValueOnce({ id: "run-1" });
    await expect(
      importBackup(await emptyBackup(), "user-1", EMAIL, true),
    ).rejects.toThrow(/automation.*running|wait/i);
    expect(mockDb.job.deleteMany).not.toHaveBeenCalled();
  });

  it("queries only running and cancelling runs for that guard", async () => {
    await importBackup(await emptyBackup(), "user-1", EMAIL, true);
    const where = mockDb.automationRun.findFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["running", "cancelling"] });
    expect(JSON.stringify(where)).toContain("user-1");
  });

  // A JWT outlives the database it was minted against: a fresh container with
  // a new dev.db still accepts the old cookie, and every scoped read comes
  // back empty rather than failing.
  it("refuses a session whose user row no longer exists", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null);
    await expect(
      importBackup(await emptyBackup(), "user-1", EMAIL, true),
    ).rejects.toThrow(/sign in again/i);
    expect(mockDb.job.deleteMany).not.toHaveBeenCalled();
    expect(writeSnapshot).not.toHaveBeenCalled();
  });

  it("refuses a payload whose data.json fails validation", async () => {
    const zip = new JSZip();
    const data = emptyStandardBackupData();
    zip.file("manifest.json", JSON.stringify(buildManifest(data, "a@b.com")));
    zip.file("data.json", JSON.stringify({ Job: [{ id: "j1" }] }));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await expect(
      importBackup(bytes, "user-1", EMAIL, true),
    ).rejects.toBeInstanceOf(BackupError);
    expect(mockDb.job.deleteMany).not.toHaveBeenCalled();
  });

  // ACTIVITY-RETIRE: a legacy backup that still carries Activity rows is
  // rejected by normalizeBackupData inside readData — before the wipe, the
  // snapshot, and the pre-transaction JobStatus write.
  it("refuses a legacy backup with retired Activity rows before any write", async () => {
    const manifest = buildManifest(emptyStandardBackupData(), EMAIL);
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify({
        ...manifest,
        counts: { ...manifest.counts, Activity: 1 },
      }),
    );
    zip.file(
      "data.json",
      JSON.stringify({
        ...emptyStandardBackupData(),
        Activity: [{ id: "a1", title: "Job Search" }],
      }),
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await expect(
      importBackup(bytes, "user-1", EMAIL, true),
    ).rejects.toBeInstanceOf(BackupError);
    expect(mockDb.jobStatus.create).not.toHaveBeenCalled();
    expect(writeSnapshot).not.toHaveBeenCalled();
    expect(mockDb.job.deleteMany).not.toHaveBeenCalled();
  });

  // Same era, but the group is empty — the row set is stripped and the
  // import proceeds; a legacy manifest may still count "Activity": 0.
  it("imports a legacy backup whose only Activity trace is an empty group", async () => {
    const manifest = buildManifest(emptyStandardBackupData(), EMAIL);
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify({
        ...manifest,
        counts: { ...manifest.counts, Activity: 0 },
      }),
    );
    zip.file(
      "data.json",
      JSON.stringify({ ...emptyStandardBackupData(), Activity: [] }),
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await importBackup(bytes, "user-1", EMAIL, true);
    expect(syncSchedulerState).toHaveBeenCalled();
  });

  it("syncs the scheduler after a successful import", async () => {
    await importBackup(await emptyBackup(), "user-1", EMAIL, true);
    expect(syncSchedulerState).toHaveBeenCalled();
  });

  it("wipes ChatConversation but never ApiKey or McpAccessToken", async () => {
    await importBackup(await emptyBackup(), "user-1", EMAIL, true);
    expect(mockDb.chatConversation.deleteMany).toHaveBeenCalled();
    expect(mockDb.dataMigrationRun.deleteMany).toHaveBeenCalled();
    expect(mockDb.apiKey).toBeUndefined();
    expect(mockDb.mcpAccessToken).toBeUndefined();
  });

  // The ordering that makes the safety net real: a snapshot that is written
  // after the wipe is a snapshot of nothing.
  it("snapshots a non-empty target before deleting anything", async () => {
    mockDb.job.count.mockResolvedValueOnce(4);
    const result = await importBackup(
      await emptyBackup(),
      "user-1",
      EMAIL,
      true,
    );

    expect(writeSnapshot).toHaveBeenCalledWith("user-1", EMAIL);
    expect(result.snapshotPath).toBeTruthy();
    expect(
      (writeSnapshot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeLessThan(mockDb.job.deleteMany.mock.invocationCallOrder[0]);
  });

  it("skips the snapshot on an empty target", async () => {
    const result = await importBackup(
      await emptyBackup(),
      "user-1",
      EMAIL,
      true,
    );
    expect(writeSnapshot).not.toHaveBeenCalled();
    expect(result.snapshotPath).toBeNull();
  });

  it("never unlinks a replaced file outside the resumes directory", async () => {
    const originalUploads = APP_CONSTANTS.UPLOADS_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jobsync-cleanup-"));
    (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = tmp;
    try {
      const inside = path.join(tmp, "files", "resumes", "old.pdf");
      const outside = path.join(tmp, "dev.db");
      fs.mkdirSync(path.dirname(inside), { recursive: true });
      fs.writeFileSync(inside, "%PDF-1.4 old");
      fs.writeFileSync(outside, "db");
      mockDb.file.findMany.mockResolvedValueOnce([
        { filePath: inside },
        { filePath: outside },
      ]);

      await importBackup(await emptyBackup(), "user-1", EMAIL, true);

      expect(fs.existsSync(inside)).toBe(false);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
