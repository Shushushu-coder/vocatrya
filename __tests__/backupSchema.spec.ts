import {
  BACKUP_FORMAT_VERSION,
  ManifestSchema,
  BackupDataSchema,
} from "@/lib/backup/schema";
import { INSERT_ORDER } from "@/lib/backup/ordering";

const validManifest = {
  formatVersion: 3,
  containsSensitiveData: false,
  appVersion: "1.1.16",
  exportedAt: "2026-08-14T10:00:00.000Z",
  sourceEmail: "a@b.com",
  counts: { Job: 3, Resume: 1 },
};

describe("manifest schema", () => {
  it("pins new backups at format version 14", () => {
    expect(BACKUP_FORMAT_VERSION).toBe(14);
  });

  it("accepts a well-formed v3 manifest", () => {
    expect(ManifestSchema.parse(validManifest).appVersion).toBe("1.1.16");
  });

  it("still accepts well-formed v1 and v2 manifests", () => {
    expect(
      ManifestSchema.parse({ ...validManifest, formatVersion: 1 }).formatVersion,
    ).toBe(1);
    expect(
      ManifestSchema.parse({
        formatVersion: 2,
        appVersion: "1.1.16",
        exportedAt: "2026-08-14T10:00:00.000Z",
        sourceEmail: "a@b.com",
        counts: { Job: 3 },
      }).formatVersion,
    ).toBe(2);
  });

  it("rejects an unsupported future formatVersion", () => {
    const res = ManifestSchema.safeParse({ ...validManifest, formatVersion: 99 });
    expect(res.success).toBe(false);
  });

  it("rejects a manifest missing required fields", () => {
    const { sourceEmail, ...rest } = validManifest;
    expect(ManifestSchema.safeParse(rest).success).toBe(false);
  });
});

describe("data schema", () => {
  it("defaults every model group to an empty array", () => {
    const parsed = BackupDataSchema.parse({});
    for (const model of INSERT_ORDER) {
      expect(parsed[model]).toEqual([]);
    }
    expect(parsed._JobToTag).toEqual([]);
    expect(parsed._QuestionToTag).toEqual([]);
    expect(parsed.jobStatuses).toEqual([]);
    expect(parsed.user).toEqual({ defaultResumeId: null });
  });

  it("coerces ISO date strings back to Date objects", () => {
    const parsed = BackupDataSchema.parse({
      Job: [
        {
          id: "j1",
          jobUrl: null,
          description: "d",
          jobType: "full-time",
          workplaceType: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          applied: false,
          appliedDate: null,
          dueDate: null,
          statusValue: "new",
          jobTitleId: "t1",
          companyId: "c1",
          jobSourceId: null,
          salaryRange: null,
          locationId: null,
          resumeId: null,
          coverLetterId: null,
          automationId: null,
          matchScore: null,
          matchData: null,
          discoveryStatus: null,
          discoveredAt: null,
          createdVia: null,
          descriptionCompleteness: null,
        },
      ],
    });
    expect(parsed.Job[0].createdAt).toBeInstanceOf(Date);
  });

  it("rejects a Job carrying statusId instead of statusValue", () => {
    const res = BackupDataSchema.safeParse({
      Job: [{ id: "j1", statusId: "s1", description: "d" }],
    });
    expect(res.success).toBe(false);
  });

  it("parses the join-table groups as id pairs", () => {
    const parsed = BackupDataSchema.parse({
      _JobToTag: [{ jobId: "j1", tagId: "t1" }],
      _QuestionToTag: [{ questionId: "q1", tagId: "t1" }],
    });
    expect(parsed._JobToTag).toEqual([{ jobId: "j1", tagId: "t1" }]);
    expect(parsed._QuestionToTag[0].questionId).toBe("q1");
  });

  it("carries jobStatuses as label/value pairs", () => {
    const parsed = BackupDataSchema.parse({
      jobStatuses: [{ label: "New", value: "new" }],
    });
    expect(parsed.jobStatuses[0].value).toBe("new");
  });

  it("keeps CareerSkillDetail.tagId optional and nullable for pre-v6 rows", () => {
    const row = {
      id: "d1",
      materialItemId: "m1",
      skillName: "TS",
      proficiency: null,
      structuredData: "{}",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    // A v1-v5 row has no tagId key at all; a v6 row may carry null or an id.
    expect(BackupDataSchema.parse({ CareerSkillDetail: [row] })
      .CareerSkillDetail[0].tagId).toBeUndefined();
    const parsed = BackupDataSchema.parse({
      CareerSkillDetail: [{ ...row, tagId: null }, { ...row, id: "d2", tagId: "t9" }],
    });
    expect(parsed.CareerSkillDetail[0].tagId).toBeNull();
    expect(parsed.CareerSkillDetail[1].tagId).toBe("t9");
  });
});
