// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import Papa from "papaparse";
import { translate } from "@/i18n/translate";
import {
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  activateFreshAbNative,
} from "@/lib/career";
import {
  iterateJobs,
  resolveJobsReadFamily,
} from "@/lib/career/jobsReadDispatch";
import {
  transformJobForCsv,
  unparseJobsCsv,
} from "@/lib/jobs/exportJobsCsv";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

const SALARY_SAMPLES = [
  "200–250元/天",
  "250元/天起",
  "30元/小时",
  "8k–12k/月",
  "15k–20k·15薪",
  "年薪30万起",
  "最高300元/天",
  "面议",
  // Historical suggestion value (SALARY_RANGES): preserved verbatim, never
  // rewritten or cleared.
  "Under 50,000",
];

const SALARY_COLUMN = 11;

function envWithoutAbFlags(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[AB_RUNTIME_FEATURE_ENV];
  delete env[AB_ROLLOUT_SCOPE_ENV];
  return env;
}

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
});

// Same pipeline as POST /api/jobs/export: iterateJobs -> transform -> unparse.
async function exportSalaryCells(userId: string) {
  const t = (key: string) => translate("zh-CN", key);
  const rows: Record<string, string>[] = [];
  for await (const chunk of iterateJobs(
    prisma,
    userId,
    undefined,
    200,
    envWithoutAbFlags(),
  )) {
    for (const job of chunk) {
      rows.push(transformJobForCsv(job, rows.length, t));
    }
  }
  const parsed = Papa.parse<string[]>(
    unparseJobsCsv(rows, t, { header: true }),
  ).data;
  return {
    header: parsed[0][SALARY_COLUMN],
    cells: parsed.slice(1).map((row) => row[SALARY_COLUMN]),
  };
}

describe("salary raw text survives save -> read -> CSV export", () => {
  it("legacy family: every stored salaryRange exports verbatim, null as an empty cell", async () => {
    const userId = await seedAccount(prisma, "salary-legacy@example.com");
    const status = await prisma.jobStatus.findUniqueOrThrow({
      where: { value: "new" },
    });
    const company = await prisma.company.create({
      data: { label: "薪资公司", value: "salary-co", createdBy: userId },
    });
    const title = await prisma.jobTitle.create({
      data: { label: "实习岗", value: "salary-role", createdBy: userId },
    });
    const samples: (string | null)[] = [...SALARY_SAMPLES, null];
    for (const [i, salaryRange] of samples.entries()) {
      await prisma.job.create({
        data: {
          userId,
          companyId: company.id,
          jobTitleId: title.id,
          statusId: status.id,
          jobType: "FT",
          description: `desc-${i}`,
          createdAt: new Date(2026, 0, 1, 0, 0, i),
          salaryRange,
        },
      });
    }

    const stored = await prisma.job.findMany({
      where: { userId },
      select: { salaryRange: true },
    });
    expect(stored.map((row) => row.salaryRange).sort()).toEqual(
      [...samples].sort(),
    );

    const family = await resolveJobsReadFamily(prisma, envWithoutAbFlags());
    expect(family.family).toBe("legacy");

    const exported = await exportSalaryCells(userId);
    expect(exported.header).toBe("薪资待遇");
    expect(exported.cells.sort()).toEqual(
      samples.map((value) => value ?? "").sort(),
    );
  });

  it("legacy family: updating salaryRange keeps the new raw text verbatim", async () => {
    const userId = await seedAccount(prisma, "salary-legacy-upd@example.com");
    const status = await prisma.jobStatus.findUniqueOrThrow({
      where: { value: "new" },
    });
    const company = await prisma.company.create({
      data: { label: "更新公司", value: "salary-upd-co", createdBy: userId },
    });
    const title = await prisma.jobTitle.create({
      data: { label: "更新岗", value: "salary-upd-role", createdBy: userId },
    });
    const job = await prisma.job.create({
      data: {
        userId,
        companyId: company.id,
        jobTitleId: title.id,
        statusId: status.id,
        jobType: "FT",
        description: "desc",
        createdAt: new Date(),
        salaryRange: "250元/天起",
      },
    });

    await prisma.job.update({
      where: { id: job.id },
      data: { salaryRange: "最高300元/天" },
    });
    const reread = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(reread.salaryRange).toBe("最高300元/天");

    const exported = await exportSalaryCells(userId);
    expect(exported.cells).toEqual(["最高300元/天"]);
  });

  it("canonical family: salaryText projects verbatim through the adapter into the same column", async () => {
    const userId = await seedAccount(prisma, "salary-ab@example.com");
    await activateFreshAbNative(prisma);
    const company = await prisma.company.create({
      data: { label: "A+B 公司", value: "salary-ab-co", createdBy: userId },
    });
    const samples: (string | null)[] = [...SALARY_SAMPLES, null];
    for (const [i, salaryText] of samples.entries()) {
      await prisma.jobOpportunity.create({
        data: {
          userId,
          companyId: company.id,
          title: `岗位-${i}`,
          salaryText,
        },
      });
    }

    const stored = await prisma.jobOpportunity.findMany({
      where: { userId },
      select: { salaryText: true },
    });
    expect(stored.map((row) => row.salaryText).sort()).toEqual(
      [...samples].sort(),
    );

    const family = await resolveJobsReadFamily(prisma, envWithoutAbFlags());
    expect(family.family).toBe("ab");

    const exported = await exportSalaryCells(userId);
    expect(exported.header).toBe("薪资待遇");
    expect(exported.cells.sort()).toEqual(
      samples.map((value) => value ?? "").sort(),
    );
  });
});
