// @vitest-environment node
//
// NEXT-ACTIONS deterministic rule matrix (frozen contract §4). Family gates
// are exercised both through the read model's pure input seam and through
// getNextActions for the real resolution wiring. R6 is intentionally absent
// — it waits for the INTERVIEW-DEBRIEF §7.3 listAwaitingReflectionInterviews
// read model and must not be simulated by a detail-presence substitute.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  AB_INSTANCE_SCOPE_KEY,
  AB_MIGRATION_KEY,
  AB_MIGRATION_STATUS,
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  activateFreshAbNative,
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  OPPORTUNITY_STATUS,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_STATUS,
  writeInstanceMigrationState,
} from "@/lib/career";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const ctx = helpers.makeTestDbUrl();
  helpers.pushSchema(ctx.url);
  return ctx;
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});
vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));

import { getCurrentUser } from "@/utils/user.utils";
import { getNextActions } from "@/actions/dashboard/nextActions";
import {
  listNextActionCandidates,
  NEXT_ACTION_RULE,
  selectNextActions,
  type NextActionItem,
  type NextActionsQueryInput,
} from "@/lib/career/nextActionsReadModel";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { resolveResumeReadFamily } from "@/lib/career/resumeReadDispatch";

const TZ = "Asia/Shanghai";
// 2026-11-10 20:00 in Asia/Shanghai → "today" = 2026-11-10; the +7d window
// closes at 2026-11-18 00:00 local = 2026-11-17T16:00:00.000Z exclusive.
const NOW = new Date("2026-11-10T12:00:00.000Z");

let prisma: PrismaClient;
let userId: string;
let companyId: string;

beforeAll(async () => {
  const dbMod = await import("@/lib/db");
  prisma = dbMod.default;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  delete process.env[AB_RUNTIME_FEATURE_ENV];
  delete process.env[AB_ROLLOUT_SCOPE_ENV];
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `next-actions-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `co-${randomUUID()}`,
        createdBy: userId,
      },
    })
  ).id;
  (getCurrentUser as any).mockResolvedValue({ id: userId });
});

// --- pure-input seam ------------------------------------------------------

function baseInput(
  overrides: Partial<NextActionsQueryInput> = {},
): NextActionsQueryInput {
  // RESOLVED keeps AI rules out of the family matrix; AI tests override it.
  return {
    jobsFamily: "ab",
    resumeFamily: "ab",
    jobMutationsEnabled: true,
    aiConfigStatus: "RESOLVED",
    timeZone: TZ,
    now: NOW,
    ...overrides,
  };
}

function candidates(overrides: Partial<NextActionsQueryInput> = {}) {
  return listNextActionCandidates(prisma, userId, baseInput(overrides));
}

function rules(items: NextActionItem[]) {
  return items.map((item) => item.ruleId);
}
function ofRule(items: NextActionItem[], ruleId: string) {
  return items.filter((item) => item.ruleId === ruleId);
}

// --- seeds ----------------------------------------------------------------

async function seedOpportunity(
  options: {
    title?: string;
    status?: string;
    archivedAt?: Date | null;
  } = {},
) {
  return prisma.jobOpportunity.create({
    data: {
      userId,
      companyId,
      title: options.title ?? "Engineer",
      status: options.status ?? OPPORTUNITY_STATUS.ACTIVE,
      archivedAt: options.archivedAt ?? null,
    },
  });
}

async function seedAttempt(
  jobOpportunityId: string,
  options: {
    stage?: string;
    outcome?: string;
    submittedAt?: Date | null;
    archivedAt?: Date | null;
  } = {},
) {
  return prisma.applicationAttempt.create({
    data: {
      userId,
      jobOpportunityId,
      channelLabel: "careers page",
      currentStageCategory: options.stage ?? ATTEMPT_STAGE.DRAFT,
      outcome: options.outcome ?? ATTEMPT_OUTCOME.ACTIVE,
      submittedAt: options.submittedAt ?? null,
      archivedAt: options.archivedAt ?? null,
    },
  });
}

async function seedStep(
  applicationAttemptId: string,
  options: {
    category?: string;
    label?: string;
    status?: string;
    scheduledAt?: Date | null;
    deadlineAt?: Date | null;
    deadlineOn?: string | null;
    completedAt?: Date | null;
  } = {},
) {
  return prisma.applicationProcessStep.create({
    data: {
      applicationAttemptId,
      category: options.category ?? PROCESS_STEP_CATEGORY.INTERVIEW,
      label: options.label ?? "Interview",
      sortOrder: 0,
      status: options.status ?? PROCESS_STEP_STATUS.PENDING,
      scheduledAt: options.scheduledAt ?? null,
      deadlineAt: options.deadlineAt ?? null,
      deadlineOn: options.deadlineOn ?? null,
      deadlinePrecision: options.deadlineOn
        ? "dateOnly"
        : options.deadlineAt
          ? "fullInstant"
          : null,
      deadlineZone: options.deadlineOn ? TZ : null,
      completedAt: options.completedAt ?? null,
    },
  });
}

async function seedVariant(
  options: { targetJobOpportunityId?: string | null; archivedAt?: Date | null } = {},
) {
  return prisma.resumeVariant.create({
    data: {
      userId,
      name: `variant-${randomUUID()}`,
      targetJobOpportunityId: options.targetJobOpportunityId ?? null,
      archivedAt: options.archivedAt ?? null,
    },
  });
}

async function seedMaterial(archived = false) {
  return prisma.careerMaterialItem.create({
    data: {
      userId,
      type: "EMPLOYMENT",
      title: `material-${randomUUID()}`,
      archivedAt: archived ? new Date() : null,
    },
  });
}

async function seedLegacyResume() {
  const profile = await prisma.profile.create({ data: { userId } });
  return prisma.resume.create({
    data: { profileId: profile.id, title: `resume-${randomUUID()}` },
  });
}

async function statusIdOf(value: string): Promise<string> {
  const status = await prisma.jobStatus.findFirstOrThrow({ where: { value } });
  return status.id;
}

async function seedLegacyJob(
  options: { status?: string; applied?: boolean; discoveryStatus?: string } = {},
) {
  const title = await prisma.jobTitle.create({
    data: {
      label: "Engineer",
      value: `jt-${randomUUID()}`,
      createdBy: userId,
    },
  });
  return prisma.job.create({
    data: {
      userId,
      description: "legacy job",
      jobType: "FT",
      createdAt: new Date(),
      statusId: await statusIdOf(options.status ?? "new"),
      jobTitleId: title.id,
      companyId,
      applied: options.applied ?? false,
      discoveryStatus: options.discoveryStatus ?? null,
    },
  });
}

async function seedAiConnection(status: string) {
  return prisma.aIConnection.create({
    data: {
      userId,
      provider: "OPENAI",
      backendKind: "CODEX_RUNTIME",
      displayName: "Test connection",
      status,
      runtimeProfileRef: `rp_${randomUUID()}`,
    },
  });
}

async function seedAssignment(
  connectionId: string,
  purpose = "CAREER_DIALOGUE",
  model = "gpt-5.5",
) {
  return prisma.aIBusinessAssignment.create({
    data: { userId, purpose, connectionId, model },
  });
}

async function setTimeZone(zone: string) {
  await prisma.userSettings.create({
    data: {
      userId,
      settings: JSON.stringify({
        settings: { general: { timeZone: zone } },
      }),
    },
  });
}

async function blockCareerRuntime() {
  await prisma.abMigrationState.create({
    data: {
      scopeKey: AB_INSTANCE_SCOPE_KEY,
      migrationKey: AB_MIGRATION_KEY,
      status: AB_MIGRATION_STATUS.IN_PROGRESS,
    },
  });
}

async function activateFreshFull() {
  vi.stubEnv(AB_RUNTIME_FEATURE_ENV, "true");
  vi.stubEnv(AB_ROLLOUT_SCOPE_ENV, "full");
  await activateFreshAbNative(prisma);
  expect((await resolveJobsReadFamily(prisma)).family).toBe("ab");
  expect((await resolveResumeReadFamily(prisma)).family).toBe("ab");
}

async function migrateCompleted() {
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
}

// --- R1 resume materials ---------------------------------------------------

describe("R1 resume materials", () => {
  it("fires under the ab family with no materials or variants", async () => {
    const items = await candidates();
    const r1 = ofRule(items, NEXT_ACTION_RULE.R1);
    expect(r1).toHaveLength(1);
    expect(r1[0].href).toBe("/dashboard/profile");
    expect(r1[0].entityKey).toBe("account");
  });

  it("stays silent under ab once an unarchived material exists", async () => {
    await seedMaterial();
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R1)).toEqual([]);
  });

  it("stays silent under ab once an unarchived variant exists", async () => {
    await seedVariant();
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R1)).toEqual([]);
  });

  it("still fires under ab when the only material is archived", async () => {
    await seedMaterial(true);
    await seedVariant({ archivedAt: new Date() });
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R1)).toHaveLength(1);
  });

  it("fires under the legacy family only when no Resume row exists", async () => {
    expect(
      ofRule(
        await candidates({ resumeFamily: "legacy" }),
        NEXT_ACTION_RULE.R1,
      ),
    ).toHaveLength(1);
    await seedLegacyResume();
    expect(
      ofRule(
        await candidates({ resumeFamily: "legacy" }),
        NEXT_ACTION_RULE.R1,
      ),
    ).toEqual([]);
  });

  it("stays silent under a blocked resume family", async () => {
    expect(
      ofRule(
        await candidates({ resumeFamily: "blocked" }),
        NEXT_ACTION_RULE.R1,
      ),
    ).toEqual([]);
  });
});

// --- R2/R7 AI configuration -------------------------------------------------

describe("R2/R7 AI configuration", () => {
  it("emits R2 — never R7 — on NOT_CONFIGURED", async () => {
    const items = await candidates({ aiConfigStatus: "NOT_CONFIGURED" });
    const r2 = ofRule(items, NEXT_ACTION_RULE.R2);
    expect(r2).toHaveLength(1);
    expect(r2[0].href).toBe("/dashboard/settings?section=ai-services");
    expect(ofRule(items, NEXT_ACTION_RULE.R7)).toEqual([]);
  });

  it("emits R7 — never R2 — on INVALID_ASSIGNMENT", async () => {
    const items = await candidates({ aiConfigStatus: "INVALID_ASSIGNMENT" });
    const r7 = ofRule(items, NEXT_ACTION_RULE.R7);
    expect(r7).toHaveLength(1);
    expect(r7[0].href).toBe("/dashboard/settings?section=ai-services");
    expect(ofRule(items, NEXT_ACTION_RULE.R2)).toEqual([]);
  });

  it("stays silent on RESOLVED and on the INTERVIEW legacy fallback", async () => {
    for (const status of ["RESOLVED", "LEGACY_INTERVIEW_CONFIG"] as const) {
      const items = await candidates({ aiConfigStatus: status });
      expect(ofRule(items, NEXT_ACTION_RULE.R2)).toEqual([]);
      expect(ofRule(items, NEXT_ACTION_RULE.R7)).toEqual([]);
    }
  });
});

// --- R3 positions -----------------------------------------------------------

describe("R3 under the ab jobs family", () => {
  it("suggests the add-job deep link when no positions exist", async () => {
    const r3 = ofRule(await candidates(), NEXT_ACTION_RULE.R3);
    expect(r3).toHaveLength(1);
    expect(r3[0].variant).toBe("noJobs");
    expect(r3[0].href).toBe("/dashboard/myjobs?add-job=true");
  });

  it("falls back to the plain list when job mutations are gated off", async () => {
    const r3 = ofRule(
      await candidates({ jobMutationsEnabled: false }),
      NEXT_ACTION_RULE.R3,
    );
    expect(r3[0].variant).toBe("noJobs");
    expect(r3[0].href).toBe("/dashboard/myjobs");
  });

  it("treats an archived-only account as having no positions", async () => {
    await seedOpportunity({ archivedAt: new Date() });
    const r3 = ofRule(await candidates(), NEXT_ACTION_RULE.R3);
    expect(r3[0].variant).toBe("noJobs");
  });

  it("suggests recording the first application when none is applied", async () => {
    await seedOpportunity();
    const r3 = ofRule(await candidates(), NEXT_ACTION_RULE.R3);
    expect(r3).toHaveLength(1);
    expect(r3[0].variant).toBe("unapplied");
    expect(r3[0].href).toBe("/dashboard/myjobs");
  });

  it("still counts a live draft attempt as unapplied", async () => {
    const opp = await seedOpportunity();
    await seedAttempt(opp.id);
    const r3 = ofRule(await candidates(), NEXT_ACTION_RULE.R3);
    expect(r3[0].variant).toBe("unapplied");
  });

  it("stays silent after a submitted attempt", async () => {
    const opp = await seedOpportunity();
    await seedAttempt(opp.id, { submittedAt: new Date("2026-11-01T00:00:00Z") });
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R3)).toEqual([]);
  });

  it("stays silent on a stage-only applied attempt", async () => {
    const opp = await seedOpportunity();
    await seedAttempt(opp.id, { stage: ATTEMPT_STAGE.SCREENING });
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R3)).toEqual([]);
  });

  it("treats an applied attempt on an archived position as a real submission", async () => {
    // Frozen §4.2: APPLIED_ATTEMPT_WHERE is global — an archived
    // opportunity's submission still happened.
    const archived = await seedOpportunity({ archivedAt: new Date() });
    await seedAttempt(archived.id, {
      submittedAt: new Date("2026-11-01T00:00:00Z"),
    });
    await seedOpportunity();
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R3)).toEqual([]);
  });
});

describe("R3 under the legacy jobs family", () => {
  const legacy = { jobsFamily: "legacy" as const };

  it("suggests the add-job deep link when no visible jobs exist", async () => {
    const r3 = ofRule(await candidates(legacy), NEXT_ACTION_RULE.R3);
    expect(r3[0].variant).toBe("noJobs");
    expect(r3[0].href).toBe("/dashboard/myjobs?add-job=true");
  });

  it("treats archived-only and dismissed-only accounts as having no jobs", async () => {
    await seedLegacyJob({ status: "archived" });
    await seedLegacyJob({ discoveryStatus: "dismissed" });
    const r3 = ofRule(await candidates(legacy), NEXT_ACTION_RULE.R3);
    expect(r3[0].variant).toBe("noJobs");
  });

  it("uses the legacy variant when jobs exist but none is applied", async () => {
    await seedLegacyJob();
    const r3 = ofRule(await candidates(legacy), NEXT_ACTION_RULE.R3);
    expect(r3).toHaveLength(1);
    expect(r3[0].variant).toBe("unappliedLegacy");
    expect(r3[0].href).toBe("/dashboard/myjobs");
  });

  it("stays silent once a job is marked applied", async () => {
    await seedLegacyJob({ applied: true });
    expect(ofRule(await candidates(legacy), NEXT_ACTION_RULE.R3)).toEqual([]);
  });

  it("counts applied=true on archived rows as a recorded submission", async () => {
    await seedLegacyJob({ status: "archived", applied: true });
    await seedLegacyJob();
    expect(ofRule(await candidates(legacy), NEXT_ACTION_RULE.R3)).toEqual([]);
  });
});

// --- R4 unbound positions -----------------------------------------------------

describe("R4 resume-variant binding", () => {
  it("suggests a variant for an active unapplied position with none bound", async () => {
    const opp = await seedOpportunity();
    const r4 = ofRule(await candidates(), NEXT_ACTION_RULE.R4);
    expect(r4).toHaveLength(1);
    expect(r4[0].entityKey).toBe(opp.id);
    expect(r4[0].href).toBe("/dashboard/profile/resumes");
    expect(r4[0].jobTitle).toBe("Engineer");
    expect(r4[0].companyName).toBe("Acme");
  });

  it("stays silent once an unarchived variant targets the position", async () => {
    const opp = await seedOpportunity();
    await seedVariant({ targetJobOpportunityId: opp.id });
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R4)).toEqual([]);
  });

  it("fires again when the only bound variant is archived", async () => {
    const opp = await seedOpportunity();
    await seedVariant({
      targetJobOpportunityId: opp.id,
      archivedAt: new Date(),
    });
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R4)).toHaveLength(1);
  });

  it("skips applied, archived, and terminal positions", async () => {
    const applied = await seedOpportunity({ title: "Applied" });
    await seedAttempt(applied.id, {
      submittedAt: new Date("2026-11-01T00:00:00Z"),
    });
    await seedOpportunity({ title: "Archived", archivedAt: new Date() });
    await seedOpportunity({ title: "Expired", status: OPPORTUNITY_STATUS.EXPIRED });
    const rejected = await seedOpportunity({ title: "Rejected" });
    await seedAttempt(rejected.id, { outcome: ATTEMPT_OUTCOME.REJECTED });
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R4)).toEqual([]);
  });

  it("requires both ab families — silent under legacy resume or jobs", async () => {
    await seedOpportunity();
    expect(
      ofRule(
        await candidates({ resumeFamily: "legacy" }),
        NEXT_ACTION_RULE.R4,
      ),
    ).toEqual([]);
    expect(
      ofRule(
        await candidates({ jobsFamily: "legacy" }),
        NEXT_ACTION_RULE.R4,
      ),
    ).toEqual([]);
  });

  it("emits one item per unbound position ordered by stable entity id", async () => {
    const a = await seedOpportunity({ title: "A" });
    const b = await seedOpportunity({ title: "B" });
    const r4 = ofRule(await candidates(), NEXT_ACTION_RULE.R4);
    expect(r4.map((item) => item.entityKey)).toEqual(
      [a.id, b.id].sort((x, y) => x.localeCompare(y)),
    );
  });
});

// --- R5 upcoming interviews ------------------------------------------------

describe("R5 upcoming interviews", () => {
  async function seedInterview(
    stepOptions: Parameters<typeof seedStep>[1],
    options: { attempt?: Parameters<typeof seedAttempt>[1]; opportunity?: Parameters<typeof seedOpportunity>[0] } = {},
  ) {
    const opp = await seedOpportunity(options.opportunity ?? {});
    const attempt = await seedAttempt(opp.id, options.attempt ?? {});
    const step = await seedStep(attempt.id, stepOptions);
    return { opp, attempt, step };
  }

  it("prepares an interview scheduled inside the 7-day account-zone window", async () => {
    const { opp, step } = await seedInterview({
      scheduledAt: new Date("2026-11-15T01:00:00.000Z"),
      label: "第一轮面试",
    });
    const r5 = ofRule(await candidates(), NEXT_ACTION_RULE.R5);
    expect(r5).toHaveLength(1);
    expect(r5[0]).toMatchObject({
      entityKey: step.id,
      variant: "prepare",
      href: `/dashboard/myjobs/${opp.id}?tab=timeline`,
      jobTitle: "Engineer",
      companyName: "Acme",
      stepLabel: "第一轮面试",
      overdue: false,
      dateOn: null,
    });
  });

  it("only asks to confirm status for an interview scheduled in the past", async () => {
    await seedInterview({
      scheduledAt: new Date("2026-11-09T01:00:00.000Z"),
    });
    const r5 = ofRule(await candidates(), NEXT_ACTION_RULE.R5);
    expect(r5).toHaveLength(1);
    expect(r5[0].variant).toBe("confirmStatus");
    expect(r5[0].overdue).toBe(true);
  });

  it("carries the calendar-day fact for a DateOnly deadline", async () => {
    await seedInterview({ deadlineOn: "2026-11-16" });
    const r5 = ofRule(await candidates(), NEXT_ACTION_RULE.R5);
    expect(r5).toHaveLength(1);
    expect(r5[0].variant).toBe("prepare");
    expect(r5[0].dateOn).toBe("2026-11-16");
  });

  it("asks to confirm status for a DateOnly deadline whose day has passed", async () => {
    await seedInterview({ deadlineOn: "2026-11-09" });
    const r5 = ofRule(await candidates(), NEXT_ACTION_RULE.R5);
    expect(r5[0].variant).toBe("confirmStatus");
    expect(r5[0].overdue).toBe(true);
  });

  it("buckets the window edge by the account zone, not the host zone", async () => {
    // deadlineOn 2026-11-17 → attention 2026-11-16T16:00Z < +7d end; the same
    // fact on 2026-11-18 lands exactly on the exclusive end and is excluded.
    await seedInterview({ deadlineOn: "2026-11-17", label: "Inside" });
    await seedInterview({ deadlineOn: "2026-11-18", label: "Outside" });
    const r5 = ofRule(await candidates(), NEXT_ACTION_RULE.R5);
    expect(r5).toHaveLength(1);
    expect(r5[0].stepLabel).toBe("Inside");
  });

  it("lets the account zone decide which side of the edge a date falls on", async () => {
    await seedInterview({ deadlineOn: "2026-11-18" });
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R5)).toEqual([]);
    // Auckland is UTC+13 in November: the same DateOnly lands inside its
    // +7d window.
    const r5 = ofRule(
      await candidates({ timeZone: "Pacific/Auckland" }),
      NEXT_ACTION_RULE.R5,
    );
    expect(r5).toHaveLength(1);
  });

  it("ignores non-interview, far-future, completed, and unreachable steps", async () => {
    await seedInterview({
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      scheduledAt: new Date("2026-11-12T01:00:00.000Z"),
      label: "Assessment",
    });
    await seedInterview({
      scheduledAt: new Date("2026-12-01T01:00:00.000Z"),
      label: "Far future",
    });
    await seedInterview({
      scheduledAt: new Date("2026-11-12T01:00:00.000Z"),
      status: PROCESS_STEP_STATUS.COMPLETED,
      completedAt: new Date("2026-11-05T00:00:00.000Z"),
      label: "Done",
    });
    await seedInterview(
      { scheduledAt: new Date("2026-11-12T01:00:00.000Z"), label: "Rejected" },
      { attempt: { outcome: ATTEMPT_OUTCOME.REJECTED } },
    );
    await seedInterview(
      { scheduledAt: new Date("2026-11-12T01:00:00.000Z"), label: "Archived" },
      { opportunity: { archivedAt: new Date() } },
    );
    expect(ofRule(await candidates(), NEXT_ACTION_RULE.R5)).toEqual([]);
  });

  it("orders multiple interviews by event time ascending", async () => {
    await seedInterview({
      scheduledAt: new Date("2026-11-15T01:00:00.000Z"),
      label: "Later",
    });
    await seedInterview({
      scheduledAt: new Date("2026-11-12T01:00:00.000Z"),
      label: "Earlier",
    });
    const r5 = ofRule(await candidates(), NEXT_ACTION_RULE.R5);
    expect(r5.map((item) => item.stepLabel)).toEqual(["Earlier", "Later"]);
  });

  it("stays silent under the legacy jobs family", async () => {
    await seedInterview({
      scheduledAt: new Date("2026-11-12T01:00:00.000Z"),
    });
    expect(
      ofRule(
        await candidates({ jobsFamily: "legacy" }),
        NEXT_ACTION_RULE.R5,
      ),
    ).toEqual([]);
  });
});

// --- ordering, dedup, cap, overflow -----------------------------------------

describe("priority, dedup, and the 3-item cap", () => {
  it("orders hits as R5 > R4 > R3 > R1 > R2 and reports the +N overflow", async () => {
    // One unbound unapplied position → R4 and R3(unapplied); one upcoming
    // interview → R5; no materials → R1; NOT_CONFIGURED → R2.
    const opp = await seedOpportunity();
    await seedAttempt(opp.id).then((attempt) =>
      seedStep(attempt.id, {
        scheduledAt: new Date("2026-11-12T01:00:00.000Z"),
      }),
    );
    const all = await candidates({ aiConfigStatus: "NOT_CONFIGURED" });
    expect(rules(all)).toEqual([
      NEXT_ACTION_RULE.R5,
      NEXT_ACTION_RULE.R4,
      NEXT_ACTION_RULE.R3,
      NEXT_ACTION_RULE.R1,
      NEXT_ACTION_RULE.R2,
    ]);
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);

    const { items, overflowCount } = selectNextActions(all);
    expect(rules(items)).toEqual([
      NEXT_ACTION_RULE.R5,
      NEXT_ACTION_RULE.R4,
      NEXT_ACTION_RULE.R3,
    ]);
    expect(items).toHaveLength(3);
    expect(overflowCount).toBe(2);
  });

  it("selectNextActions reports no overflow at or under the limit", () => {
    const make = (ruleId: NextActionItem["ruleId"], key: string): NextActionItem => ({
      id: `${ruleId}:${key}`,
      ruleId,
      entityKey: key,
      variant: "default",
      href: "/dashboard",
    });
    const two = [make(NEXT_ACTION_RULE.R1, "account"), make(NEXT_ACTION_RULE.R2, "account")];
    expect(selectNextActions(two)).toEqual({ items: two, overflowCount: 0 });
    const five = [...two, make(NEXT_ACTION_RULE.R3, "a"), make(NEXT_ACTION_RULE.R4, "b"), make(NEXT_ACTION_RULE.R7, "c")];
    const capped = selectNextActions(five, 4);
    expect(capped.items).toHaveLength(4);
    expect(capped.overflowCount).toBe(1);
  });
});

// --- blocked family silence ---------------------------------------------------

describe("blocked family silence", () => {
  it("emits only AI rules when both families are blocked", async () => {
    await seedOpportunity();
    await seedMaterial();
    const items = await candidates({
      jobsFamily: "blocked",
      resumeFamily: "blocked",
      aiConfigStatus: "NOT_CONFIGURED",
    });
    expect(rules(items)).toEqual([NEXT_ACTION_RULE.R2]);
  });
});

// --- getNextActions action wiring ---------------------------------------------

describe("getNextActions wiring", () => {
  it("resolves fresh-native full to ab/ab with the add-job deep link", async () => {
    await setTimeZone(TZ);
    await activateFreshFull();
    const data = await getNextActions();
    expect(data.jobsReadFamily).toBe("ab");
    expect(data.resumeReadFamily).toBe("ab");
    expect(data.timeZone).toBe(TZ);
    // Empty account: R3(noJobs) > R1 > R2 — capped before overflow.
    expect(rules(data.items)).toEqual([
      NEXT_ACTION_RULE.R3,
      NEXT_ACTION_RULE.R1,
      NEXT_ACTION_RULE.R2,
    ]);
    expect(data.items[0].href).toBe("/dashboard/myjobs?add-job=true");
    expect(data.overflowCount).toBe(0);
  });

  it("resolves the default legacy instance to legacy/legacy", async () => {
    await setTimeZone(TZ);
    expect((await resolveJobsReadFamily(prisma)).family).toBe("legacy");
    const data = await getNextActions();
    expect(data.jobsReadFamily).toBe("legacy");
    expect(data.resumeReadFamily).toBe("legacy");
    expect(rules(data.items)).toEqual([
      NEXT_ACTION_RULE.R3,
      NEXT_ACTION_RULE.R1,
      NEXT_ACTION_RULE.R2,
    ]);
    // LEGACY_ONLY can mutate jobs → deep link stays available.
    expect(data.items[0].href).toBe("/dashboard/myjobs?add-job=true");
  });

  it("gates R4 and add-job under migrated READY_DISABLED (ab jobs + legacy resume)", async () => {
    await setTimeZone(TZ);
    await migrateCompleted();
    expect((await resolveJobsReadFamily(prisma)).family).toBe("ab");
    expect((await resolveResumeReadFamily(prisma)).family).toBe("legacy");
    await seedOpportunity();
    const data = await getNextActions();
    expect(rules(data.items)).toEqual([
      NEXT_ACTION_RULE.R3,
      NEXT_ACTION_RULE.R1,
      NEXT_ACTION_RULE.R2,
    ]);
    // R3 unapplied (position exists, no submission) — the plain list href
    // because READY_DISABLED cannot mutate jobs.
    expect(data.items[0].variant).toBe("unapplied");
    expect(data.items[0].href).toBe("/dashboard/myjobs");
    expect(ofRule(data.items, NEXT_ACTION_RULE.R4)).toEqual([]);
  });

  it("keeps blocked families silent — an unconfigured AI still suggests R2", async () => {
    await setTimeZone(TZ);
    await blockCareerRuntime();
    const data = await getNextActions();
    expect(data.jobsReadFamily).toBe("blocked");
    expect(data.resumeReadFamily).toBe("blocked");
    expect(rules(data.items)).toEqual([NEXT_ACTION_RULE.R2]);
  });

  it("routes an interview step through to R5 and a broken assignment to R7", async () => {
    await setTimeZone(TZ);
    await activateFreshFull();
    const connection = await seedAiConnection("DISCONNECTED");
    await seedAssignment(connection.id);
    const opp = await seedOpportunity();
    await seedAttempt(opp.id, {
      stage: ATTEMPT_STAGE.SUBMITTED,
      submittedAt: new Date("2026-11-01T00:00:00Z"),
    });
    const attempt = await seedAttempt(opp.id, {
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    await seedStep(attempt.id, { deadlineOn: "2026-01-01" });
    const data = await getNextActions();
    // The overdue DateOnly interview is always past → confirmStatus, and the
    // invalid CAREER_DIALOGUE assignment resolves to INVALID_ASSIGNMENT.
    expect(data.items[0].ruleId).toBe(NEXT_ACTION_RULE.R5);
    expect(data.items[0].variant).toBe("confirmStatus");
    expect(ofRule(data.items, NEXT_ACTION_RULE.R7)).toHaveLength(1);
    expect(ofRule(data.items, NEXT_ACTION_RULE.R2)).toEqual([]);
  });
});
