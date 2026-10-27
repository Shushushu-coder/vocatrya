// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  activateFreshAbNative,
  OpportunityService,
  listUpcomingApplicationEvents,
  isUpcomingOverdue,
} from "@/lib/career";
import {
  createOpportunityFromJobForm,
  getOpportunityAsJob,
  listOpportunitiesAsJobs,
  updateOpportunityFromJobForm,
} from "@/lib/career/jobOpportunityAdapter";
import {
  formatJobDeadline,
  jobDeadlineBusinessValue,
  jobDeadlineCsvCell,
  jobDeadlinePickerDate,
  jobDeadlinePrecision,
} from "@/lib/jobs/deadlineTime";
import { isDeadlineOverdue } from "@/lib/datetime";
import { AgentAddJobParseSchema } from "@/models/agent.schema";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};
const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const ZONE = "Asia/Shanghai";

let userId: string;
let companyId: string;
let titleId: string;
let sourceId: string;
let draftStatusId: string;

beforeAll(() => {
  pushSchema(ctx.url);
}, 120_000);

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
  userId = await seedAccount(prisma, `pjo-dl-${Date.now()}@example.com`);
  await activateFreshAbNative(prisma);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-dl-${Date.now()}`, createdBy: userId },
    })
  ).id;
  titleId = (
    await prisma.jobTitle.create({
      data: { label: "Engineer", value: `eng-dl-${Date.now()}`, createdBy: userId },
    })
  ).id;
  sourceId = (await prisma.jobSource.findFirstOrThrow({ where: { createdBy: userId } }))
    .id;
  draftStatusId = (await prisma.jobStatus.findFirstOrThrow({ where: { value: "draft" } }))
    .id;
});

describe("P-JO deadline contract — write path", () => {
  it("OpportunityService.create writes the dateOnly triple, never a fake instant", async () => {
    const svc = new OpportunityService(prisma, userId, FEATURE_ON);
    const created = await svc.create({
      companyId,
      title: "Deadline Job",
      deadlineOn: "2026-11-30",
    });
    const row = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.deadlineOn).toBe("2026-11-30");
    expect(row.deadlinePrecision).toBe("dateOnly");
    expect(row.deadline).toBeNull();
  });

  it.each(["2026-11-30T15:30:42.123Z", "2026-11-30T15:30:00.000Z"])("create with an explicit instant %s preserves full precision", async (iso) => {
    const svc = new OpportunityService(prisma, userId, FEATURE_ON);
    const instant = new Date(iso);
    const created = await svc.create({
      companyId,
      title: "Instant Job",
      deadline: instant,
    });
    const row = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.deadline?.toISOString()).toBe(instant.toISOString());
    expect(row.deadlineOn).toBeNull();
    expect(row.deadlinePrecision).toBe("fullInstant");
  });

  it("updateSafe preserves the stored triple when deadlineOn is undefined", async () => {
    const svc = new OpportunityService(prisma, userId, FEATURE_ON);
    const created = await svc.create({
      companyId,
      title: "Keep Me",
      deadlineOn: "2026-12-01",
    });
    await svc.updateSafe(created.id, { title: "Renamed" });
    const row = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.deadlineOn).toBe("2026-12-01");
    expect(row.deadlinePrecision).toBe("dateOnly");
  });

  it("updateSafe with deadlineOn:null clears the whole triple", async () => {
    const svc = new OpportunityService(prisma, userId, FEATURE_ON);
    const created = await svc.create({
      companyId,
      title: "Clear Me",
      deadlineOn: "2026-12-01",
    });
    await svc.updateSafe(created.id, { deadlineOn: null });
    const row = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.deadlineOn).toBeNull();
    expect(row.deadline).toBeNull();
    expect(row.deadlinePrecision).toBeNull();
  });

  it("a bare instant write on update clears deadlineOn and declares precision", async () => {
    const svc = new OpportunityService(prisma, userId, FEATURE_ON);
    const created = await svc.create({
      companyId,
      title: "Swap Carrier",
      deadlineOn: "2026-12-01",
    });
    const instant = new Date("2026-12-02T09:00:00.000Z");
    await svc.updateSafe(created.id, { deadline: instant });
    const row = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.deadlineOn).toBeNull();
    expect(row.deadline?.toISOString()).toBe(instant.toISOString());
    expect(row.deadlinePrecision).toBe("fullInstant");
  });

  it("rejects a corrupt deadlineOn instead of writing it", async () => {
    const svc = new OpportunityService(prisma, userId, FEATURE_ON);
    await expect(
      svc.create({ companyId, title: "Bad", deadlineOn: "15.03.2026" }),
    ).rejects.toThrow();
    expect(await prisma.jobOpportunity.count()).toBe(0);
  });
});

describe("P-JO deadline contract — form adapter + DTO", () => {
  const formBase = () => ({
    title: titleId,
    company: companyId,
    location: undefined as string | undefined,
    type: "full-time",
    source: sourceId,
    status: draftStatusId,
    jobDescription: "N/A",
    applied: false,
  });

  it("createOpportunityFromJobForm writes deadlineOn/dateOnly, no instant", async () => {
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      { ...formBase(), deadlineOn: "2027-01-15" },
      FEATURE_ON,
    );
    const row = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.deadlineOn).toBe("2027-01-15");
    expect(row.deadlinePrecision).toBe("dateOnly");
    expect(row.deadline).toBeNull();
  });

  it.each([null, "unknown"])("untouched edit preserves historical precision %s", async (historicalPrecision) => {
    // Simulate pre-contract data: instant + precision "unknown".
    const svc = new OpportunityService(prisma, userId, FEATURE_ON);
    const created = await svc.create({ companyId, title: "Hist" });
    const histInstant = new Date("2026-06-15T20:00:00.000Z");
    await prisma.jobOpportunity.update({
      where: { id: created.id },
      data: {
        deadline: histInstant,
        deadlineOn: null,
        deadlinePrecision: historicalPrecision,
      },
    });

    // Edit WITHOUT a deadline write — what an untouched picker sends.
    await updateOpportunityFromJobForm(
      prisma,
      userId,
      { ...formBase(), id: created.id },
      FEATURE_ON,
    );
    const row = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.deadline?.toISOString()).toBe(histInstant.toISOString());
    expect(row.deadlinePrecision).toBe(historicalPrecision);
  });

  it("projection exposes deadlineOn + normalized precision, dueDate=null on dateOnly", async () => {
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      { ...formBase(), deadlineOn: "2027-02-20" },
      FEATURE_ON,
    );
    const detail = await getOpportunityAsJob(prisma, userId, created.id);
    expect(detail?.deadlineOn).toBe("2027-02-20");
    expect(detail?.deadlinePrecision).toBe("dateOnly");
    expect(detail?.dueDate).toBeNull();

    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    expect(listed.data[0].deadlineOn).toBe("2027-02-20");
    expect(listed.data[0].deadlinePrecision).toBe("dateOnly");
  });

  it("feeds a form-written DateOnly into Upcoming with account-zone attention and overdue", async () => {
    const created = await createOpportunityFromJobForm(
      prisma, userId, { ...formBase(), deadlineOn: "2026-11-30" }, FEATURE_ON,
    );
    const envelope = await listUpcomingApplicationEvents(prisma, userId, ZONE);
    const event = envelope.events.find(row => row.jobOpportunityId === created.id)!;
    expect(envelope.timeZone).toBe(ZONE);
    expect(event).toMatchObject({
      deadlineOn: "2026-11-30",
      deadlineAt: null,
      deadlinePrecision: "dateOnly",
      attentionAt: "2026-11-29T16:00:00.000Z",
    });
    expect(isUpcomingOverdue(event, new Date("2026-11-30T15:59:59.999Z"), ZONE)).toBe(false);
    expect(isUpcomingOverdue(event, new Date("2026-11-30T16:00:00.000Z"), ZONE)).toBe(true);
    const changed = await listUpcomingApplicationEvents(prisma, userId, "Etc/GMT+12");
    expect(changed.events.find(row => row.jobOpportunityId === created.id)).toMatchObject({
      deadlineOn: "2026-11-30",
      deadlineAt: null,
      attentionAt: "2026-11-30T12:00:00.000Z",
    });
    const stored = await prisma.jobOpportunity.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.deadlineOn).toBe("2026-11-30");
    expect(stored.deadline).toBeNull();
  });
});

describe("P-JO deadline contract — pure readers", () => {
  it("lone deadlineOn without the dateOnly declaration is not a date", () => {
    const instant = "2026-03-15T20:00:00.000Z";
    const v = jobDeadlineBusinessValue({
      deadlineOn: "2026-03-14",
      dueDate: instant,
      deadlinePrecision: "unknown",
    });
    expect(v).toEqual({ kind: "instant", iso: instant, precision: "unknown" });
  });

  it("normalized precision: dateOnly / declared / unknown / absent", () => {
    expect(
      jobDeadlinePrecision({ deadlineOn: "2026-01-01", deadlinePrecision: "dateOnly" }),
    ).toBe("dateOnly");
    expect(
      jobDeadlinePrecision({
        dueDate: "2026-01-01T10:00:00.000Z",
        deadlinePrecision: "minute",
      }),
    ).toBe("minute");
    expect(
      jobDeadlinePrecision({ dueDate: "2026-01-01T10:00:00.000Z" }),
    ).toBe("unknown");
    expect(jobDeadlinePrecision({})).toBeNull();
  });

  it("dateOnly turns overdue only after the account-zone day ends", () => {
    const row = { deadlineOn: "2026-03-15", deadlinePrecision: "dateOnly" };
    // 2026-03-15 23:30 Shanghai — still inside the day.
    const inside = new Date("2026-03-15T15:30:00.000Z");
    expect(
      isDeadlineOverdue(jobDeadlineBusinessValue(row), inside, ZONE),
    ).toBe(false);
    // 2026-03-16 00:30 Shanghai — the day ended.
    const after = new Date("2026-03-15T16:30:00.000Z");
    expect(
      isDeadlineOverdue(jobDeadlineBusinessValue(row), after, ZONE),
    ).toBe(true);
    // In a zone where 15th hasn't ended yet (UTC-12) it's still not overdue.
    expect(
      isDeadlineOverdue(jobDeadlineBusinessValue(row), after, "Etc/GMT+12"),
    ).toBe(false);
  });

  it("picker backfill lands on the wall day in the account zone", () => {
    // Instant 2026-03-15T20:00Z = 2026-03-16 04:00 Shanghai — the picker must
    // show the 16th, not the 15th.
    const picked = jobDeadlinePickerDate(
      { dueDate: "2026-03-15T20:00:00.000Z", deadlinePrecision: "unknown" },
      ZONE,
    );
    expect(picked?.getFullYear()).toBe(2026);
    expect(picked?.getMonth()).toBe(2);
    expect(picked?.getDate()).toBe(16);

    const pickedOn = jobDeadlinePickerDate(
      { deadlineOn: "2027-05-04", deadlinePrecision: "dateOnly" },
      ZONE,
    );
    expect(pickedOn?.getDate()).toBe(4);
  });

  it("formatJobDeadline: dateOnly verbatim, unknown instant → wall date only", () => {
    expect(
      formatJobDeadline(
        { deadlineOn: "2027-01-15", deadlinePrecision: "dateOnly" },
        "en",
        ZONE,
      ),
    ).toContain("15");
    const unknownFmt = formatJobDeadline(
      { dueDate: "2026-03-15T20:00:00.000Z", deadlinePrecision: "unknown" },
      "en",
      ZONE,
    );
    // The wall date in Shanghai is the 16th; no fake "00:00" time part.
    expect(unknownFmt).toContain("16");
    expect(unknownFmt).not.toContain(":");
  });

  it("jobDeadlineCsvCell: verbatim dateOnly / ISO instant / empty", () => {
    expect(
      jobDeadlineCsvCell({ deadlineOn: "2027-01-15", deadlinePrecision: "dateOnly" }),
    ).toBe("2027-01-15");
    const iso = "2026-03-15T20:00:00.000Z";
    expect(jobDeadlineCsvCell({ dueDate: iso })).toBe(iso);
    expect(jobDeadlineCsvCell({})).toBe("");
  });
});

describe("P-JO deadline contract — agent input", () => {
  it("accepts deadlineOn, rejects deadlineOn+dueDate together", () => {
    const ok = AgentAddJobParseSchema.safeParse({
      company: "Acme",
      jobTitle: "Engineer",
      deadlineOn: "2026-11-30",
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.deadlineOn).toBe("2026-11-30");

    const both = AgentAddJobParseSchema.safeParse({
      company: "Acme",
      jobTitle: "Engineer",
      deadlineOn: "2026-11-30",
      dueDate: "2026-11-30T18:00:00+03:00",
    });
    expect(both.success).toBe(false);

    const malformed = AgentAddJobParseSchema.safeParse({
      company: "Acme",
      jobTitle: "Engineer",
      deadlineOn: "30.11.2026",
    });
    expect(malformed.success).toBe(false);
  });
});
