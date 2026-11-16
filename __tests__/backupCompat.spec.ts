import JSZip from "jszip";
import { z } from "zod";
import {
  emptyStandardBackupData,
  normalizeBackupData,
  normalizeManifest,
} from "@/lib/backup/compat";
import { BackupError } from "@/lib/backup/schema";
import { buildManifest, readManifest } from "@/lib/backup/manifest";
import { BackupDataSchema } from "@/lib/backup/schema";
import { LEGACY, TARGET } from "@/lib/legacy-migration/identities";

describe("backup v3 compatibility", () => {
  it("normalizes v1/v2 ResumeContactProfile data to CandidateProfile", () => {
    const normalized = normalizeBackupData(
      {
        ResumeContactProfile: [
          {
            id: "p1",
            fullName: "Fixture Name",
            headline: null,
            email: "fixture@example.com",
            phone: null,
            address: null,
            linksData: null,
            extraData: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      false,
    );
    const parsed = BackupDataSchema.parse(normalized);
    expect(parsed.CandidateProfile).toHaveLength(1);
    expect(parsed.CandidateProfile[0].id).toBe("p1");
    expect(parsed).not.toHaveProperty("ResumeContactProfile");
  });

  it("rejects mixed ResumeContactProfile and CandidateProfile groups", () => {
    expect(() =>
      normalizeBackupData(
        { ResumeContactProfile: [], CandidateProfile: [] },
        false,
      ),
    ).toThrow(BackupError);
  });

  it("rejects sensitive groups on a standard backup", () => {
    expect(() =>
      normalizeBackupData({ CandidateSensitiveInfo: [] }, false),
    ).toThrow(/no sensitive data/i);
  });

  it("rewrites legacy mapping targets to CandidateProfile", () => {
    const normalized = normalizeBackupData(
      {
        LegacyMigrationMap: [
          {
            id: "m1",
            legacyEntityType: LEGACY.USER_CONTACT_INFO,
            legacyEntityId: "user-old",
            targetEntityType: "ResumeContactProfile",
            targetEntityId: "p1",
            migrationVersion: "vocatrya-ab-phase3-legacy-backfill-v1",
            mappingReason: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      false,
    ) as { LegacyMigrationMap: Array<{ targetEntityType: string }> };
    expect(normalized.LegacyMigrationMap[0].targetEntityType).toBe(
      TARGET.CANDIDATE_PROFILE,
    );
  });

  it("forces v1/v2 containsSensitiveData to false", () => {
    const manifest = normalizeManifest({
      formatVersion: 2,
      appVersion: "1.1.20",
      exportedAt: "2026-01-01T00:00:00.000Z",
      sourceEmail: "a@b.com",
      counts: { ResumeContactProfile: 2 },
      containsSensitiveData: true,
    });
    expect(manifest.containsSensitiveData).toBe(false);
    expect(manifest.counts.CandidateProfile).toBe(2);
    expect(manifest.counts).not.toHaveProperty("ResumeContactProfile");
  });

  it("requires containsSensitiveData on v3 manifests", async () => {
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify({
        formatVersion: 3,
        appVersion: "1.1.20",
        exportedAt: "2026-01-01T00:00:00.000Z",
        sourceEmail: "a@b.com",
        counts: {},
      }),
    );
    await expect(readManifest(zip)).rejects.toBeInstanceOf(BackupError);
  });

  it("writes v9 standard backups without sensitive groups or flag true", () => {
    const data = emptyStandardBackupData();
    const manifest = buildManifest(data, "a@b.com");
    expect(manifest.formatVersion).toBe(9);
    expect(manifest.containsSensitiveData).toBe(false);
    expect(manifest.counts).not.toHaveProperty("CandidateSensitiveInfo");
    expect(JSON.stringify(data)).not.toContain("CandidateSensitiveInfo");
  });

  it("rejects a legacy backup that still carries Activity rows", () => {
    expect(() =>
      normalizeBackupData(
        { Activity: [{ id: "a1", title: "Job Search" }], Task: [] },
        false,
      ),
    ).toThrow(BackupError);
    expect(() =>
      normalizeBackupData(
        { Activity: [{ id: "a1", title: "Job Search" }] },
        false,
      ),
    ).toThrow(/retired job-activity/);
  });

  it("strips an empty Activity group and tolerates a legacy Activity:0 count", () => {
    const normalized = normalizeBackupData(
      { Activity: [], Task: [] },
      false,
    ) as Record<string, unknown>;
    expect(normalized).not.toHaveProperty("Activity");
    expect(normalized).toHaveProperty("Task");

    const manifest = normalizeManifest({
      formatVersion: 5,
      appVersion: "1.2.0",
      exportedAt: "2026-01-01T00:00:00.000Z",
      sourceEmail: "a@b.com",
      counts: { Activity: 0, Task: 0 },
      containsSensitiveData: false,
    });
    expect(manifest.counts.Activity).toBe(0);
    expect(manifest.counts.Task).toBe(0);
  });

  it("a v5-era reader rejects the v9 wire format instead of degrading", async () => {
    // The shipped v5 ManifestSchema is the literal union 1-5. If a v6 backup
    // parsed there, the tagId keys it cannot restore would be silently
    // dropped — fail-closed is the contract (BD-LINKS §6).
    const v5EraManifestSchema = z.object({
      formatVersion: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
      ]),
    });
    const manifest = { ...buildManifest(emptyStandardBackupData(), "a@b.com") };
    expect(manifest.formatVersion).toBe(9);
    expect(v5EraManifestSchema.safeParse(manifest).success).toBe(false);

    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(manifest));
    // ...and this build reads the same file fine.
    await expect(readManifest(zip)).resolves.toMatchObject({
      formatVersion: 9,
    });
  });
});
