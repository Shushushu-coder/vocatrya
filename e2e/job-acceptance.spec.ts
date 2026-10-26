// Task-owned acceptance spec for JOB-01~05 user-path verification.
// Runs against an externally started dev server bound to an isolated
// database (E2E_REUSE_EXISTING_SERVER=1). JOB_ACCEPTANCE_FAMILY selects
// which assertions apply: legacy | ab-full | ab-resume | ab-disabled.
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import Papa from "papaparse";
import {
  createNewJob,
  selectOrCreate,
  test,
  expect,
  uniqueName,
} from "./fixtures";
import { configureE2EDatabase } from "./support/database";
import { E2E_TEST_USER } from "./support/testUser";

const database = configureE2EDatabase();
const prisma = new PrismaClient({ datasourceUrl: database.url });
const FAMILY = process.env.JOB_ACCEPTANCE_FAMILY ?? "legacy";
const IS_LEGACY = FAMILY === "legacy";
const IS_AB_FULL = FAMILY === "ab-full";
const IS_AB_RESUME = FAMILY === "ab-resume";
const IS_AB_DISABLED = FAMILY === "ab-disabled";
const WRITES_ENABLED = IS_LEGACY || IS_AB_FULL;

const SALARY_TEXT = `15k-25k*14薪, "可谈" negotiable`;

async function e2eUserId() {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: E2E_TEST_USER.email },
  });
  return user.id;
}

async function findLegacyJob(userId: string, titleLabel: string) {
  return prisma.job.findFirst({
    where: { userId, JobTitle: { label: titleLabel } },
  });
}

async function findOpportunity(userId: string, titleText: string) {
  return prisma.jobOpportunity.findFirst({
    where: { userId, title: titleText },
    include: { applicationAttempts: true },
  });
}

// label -> parent FormItem -> trigger button; survives localization because
// callers pass the visible label text per locale.
function labeledButton(
  page: import("@playwright/test").Page,
  label: string,
) {
  return page
    .locator("label", { hasText: label })
    .locator("xpath=..")
    .getByRole("button")
    .first();
}

test.describe("JOB-01~04 user-path acceptance (write-capable families)", () => {
  test.skip(!WRITES_ENABLED, `family ${FAMILY} does not cover job write flows`);

  test("JOB-01 draft applied switch undoes only its own generated values; saved applied fact is locked", async ({
    page,
    cleanup,
  }) => {
    const userId = await e2eUserId();
    const jobText = uniqueName("acc-toggle");

    // --- New draft: toggle ON then OFF reverts only generated values ---
    await createNewJob(page, jobText, cleanup, {
      beforeSave: async (p) => {
        const dialog = p.getByRole("dialog");
        const statusSelect = dialog.getByLabel("Select Job Status");
        const dateBtn = labeledButton(p, "Date Applied");
        const appliedSwitch = dialog.locator("#applied-switch");

        await expect(statusSelect).toContainText("New");
        await expect(appliedSwitch).not.toBeChecked();

        await appliedSwitch.click(); // ON
        await expect(appliedSwitch).toBeChecked();
        await expect(statusSelect).toContainText("Applied");
        await expect(dateBtn).toBeEnabled();
        await expect(dateBtn).not.toContainText("Pick a date");

        await appliedSwitch.click(); // OFF — restores "New" + clears the date
        await expect(appliedSwitch).not.toBeChecked();
        await expect(statusSelect).toContainText("New");
        await expect(dateBtn).toBeDisabled();
        await expect(dateBtn).toContainText("Pick a date");
      },
    });

    if (IS_LEGACY) {
      const job = await findLegacyJob(userId, jobText);
      expect(job).toBeTruthy();
      expect(job!.applied).toBe(false);
      expect(job!.appliedDate).toBeNull();
    } else {
      const opp = await findOpportunity(userId, jobText);
      expect(opp).toBeTruthy();
      expect(opp!.applicationAttempts).toHaveLength(0);
    }

    // --- Saved applied fact cannot be reverted by editing ---
    const appliedText = uniqueName("acc-applied");
    await createNewJob(page, appliedText, cleanup, {
      beforeSave: async (p) => {
        await p.getByRole("dialog").locator("#applied-switch").click();
        await expect(
          p.getByRole("dialog").getByLabel("Select Job Status"),
        ).toContainText("Applied");
      },
    });

    let legacyAppliedAt: Date | null = null;
    let attemptId: string | null = null;
    let attemptSubmittedAt: Date | null = null;
    if (IS_LEGACY) {
      const job = await findLegacyJob(userId, appliedText);
      expect(job!.applied).toBe(true);
      expect(job!.appliedDate).not.toBeNull();
      legacyAppliedAt = job!.appliedDate;
    } else {
      const opp = await findOpportunity(userId, appliedText);
      const submitted = opp!.applicationAttempts.filter(
        (a) => a.submittedAt !== null,
      );
      expect(submitted).toHaveLength(1);
      attemptId = submitted[0].id;
      attemptSubmittedAt = submitted[0].submittedAt;
    }

    // Reopen via the row action menu: the switch must be locked.
    const row = page.getByRole("row", { name: appliedText }).first();
    await row.getByTestId("job-actions-menu-btn").click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("save-job-btn")).toBeVisible();
    await expect(dialog.locator("#applied-switch")).toBeChecked();
    await expect(dialog.locator("#applied-switch")).toBeDisabled();
    await dialog
      .getByLabel("Job Description")
      .locator("div")
      .fill(`${appliedText} edited`);
    await dialog.getByTestId("save-job-btn").click();
    await expect(dialog).not.toBeVisible();

    if (IS_LEGACY) {
      const job = await findLegacyJob(userId, appliedText);
      expect(job!.applied).toBe(true);
      expect(job!.appliedDate?.getTime()).toBe(legacyAppliedAt!.getTime());
    } else {
      const attempt = await prisma.applicationAttempt.findUniqueOrThrow({
        where: { id: attemptId! },
      });
      expect(attempt.submittedAt?.getTime()).toBe(
        attemptSubmittedAt!.getTime(),
      );
    }
  });

  test("JOB-02 free-text salary survives save, reopen, and CSV export", async ({
    page,
    cleanup,
  }) => {
    const userId = await e2eUserId();
    const jobText = uniqueName("acc-salary");

    await createNewJob(page, jobText, cleanup, {
      beforeSave: async (p) => {
        await p.getByLabel("Salary (optional)").fill(SALARY_TEXT);
      },
    });

    if (IS_LEGACY) {
      const job = await findLegacyJob(userId, jobText);
      expect(job!.salaryRange).toBe(SALARY_TEXT);
    } else {
      const opp = await findOpportunity(userId, jobText);
      expect(opp!.salaryText).toBe(SALARY_TEXT);
    }

    // Refresh + reopen the edit dialog: the input keeps the raw text.
    await page.reload();
    const row = page.getByRole("row", { name: jobText }).first();
    await row.getByTestId("job-actions-menu-btn").click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Salary (optional)")).toHaveValue(
      SALARY_TEXT,
    );
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    // Detail page shows the raw salary text.
    await row.getByRole("link", { name: jobText }).click();
    await expect(
      page.getByText(SALARY_TEXT, { exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard\/myjobs/);

    // CSV export keeps the raw cell (comma + quotes intact after parsing).
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const download = await downloadPromise;
    const bytes = readFileSync((await download.path())!);
    const rows = Papa.parse<string[]>(
      bytes.toString("utf8").replace(/^﻿/, ""),
    ).data;
    const header = rows[0];
    const salaryIdx = header.indexOf("Salary");
    expect(salaryIdx).toBeGreaterThanOrEqual(0);
    const titleIdx = header.indexOf("Job Title");
    const csvRow = rows.slice(1).find((r) => r[titleIdx] === jobText);
    expect(csvRow).toBeTruthy();
    expect(csvRow![salaryIdx]).toBe(SALARY_TEXT);
  });

  test("JOB-03/04 detail and list show real salary/source, missing values stay neutral, source is plain text", async ({
    page,
    cleanup,
  }) => {
    const userId = await e2eUserId();
    const withSalary = uniqueName("acc-src-salary");
    const bare = uniqueName("acc-src-bare");

    await createNewJob(page, withSalary, cleanup, {
      beforeSave: async (p) => {
        await p.getByLabel("Salary (optional)").fill("月薪 20k");
      },
    });

    // A job with NO salary and NO source cannot be produced by the form
    // (source is required), so seed one directly — automation/imported rows
    // legitimately arrive without either field.
    if (IS_LEGACY) {
      const ref = await findLegacyJob(userId, withSalary);
      const newStatus = await prisma.jobStatus.findFirstOrThrow({
        where: { value: "new" },
      });
      const bareTitle = await prisma.jobTitle.create({
        data: { label: bare, value: bare.toLowerCase(), createdBy: userId },
      });
      cleanup.title(bare);
      const bareJob = await prisma.job.create({
        data: {
          userId,
          jobTitleId: bareTitle.id,
          companyId: ref!.companyId,
          locationId: ref!.locationId,
          statusId: newStatus.id,
          description: "bare description",
          jobType: ref!.jobType,
          applied: false,
          createdAt: new Date(),
        },
      });
      cleanup.job(bareJob.id);
    } else {
      const ref = await findOpportunity(userId, withSalary);
      const bareOpp = await prisma.jobOpportunity.create({
        data: {
          userId,
          companyId: ref!.companyId,
          title: bare,
          locationText: ref!.locationText,
          employmentType: ref!.employmentType,
          status: "UNKNOWN",
          createdVia: "AUTOMATION",
        },
      });
      cleanup.job(bareOpp.id);
    }
    await page.reload();

    // --- list (table) view: source column is plain text (second-to-last td) ---
    const srcRow = page.getByRole("row", { name: withSalary }).first();
    const sourceCell = srcRow.locator("td").nth(-2);
    await expect(sourceCell).toContainText("Indeed");
    expect(await sourceCell.locator("a,button").count()).toBe(0);

    // --- detail: salary + source truthful; source is not a control ---
    await srcRow.getByRole("link", { name: withSalary }).click();
    await expect(
      page.getByText("月薪 20k", { exact: true }),
    ).toBeVisible();
    const sourceValue = page
      .getByText("Source", { exact: true })
      .locator("xpath=..")
      .locator("p")
      .nth(1);
    await expect(sourceValue.first()).toHaveText("Indeed");
    expect(await sourceValue.first().locator("a,button").count()).toBe(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard\/myjobs/);

    // --- missing values: no fabrication ---
    const bareRow = page.getByRole("row", { name: bare }).first();
    const bareSourceCell = bareRow.locator("td").nth(-2);
    await expect(bareSourceCell).toHaveText("");
    expect(await bareSourceCell.locator("a,button").count()).toBe(0);
    await bareRow.getByRole("link", { name: bare }).click();
    const salaryValue = page
      .getByText("Salary Range", { exact: true })
      .locator("xpath=..")
      .locator("p")
      .nth(1);
    await expect(salaryValue.first()).toHaveText("-");
    const bareSourceValue = page
      .getByText("Source", { exact: true })
      .locator("xpath=..")
      .locator("p")
      .nth(1);
    await expect(bareSourceValue.first()).toHaveText("-");

    // Cross-read consistency: the same row exposes identical truth.
    if (IS_LEGACY) {
      const job = await findLegacyJob(userId, withSalary);
      expect(job!.salaryRange).toBe("月薪 20k");
      const bareJob = await findLegacyJob(userId, bare);
      expect(bareJob!.salaryRange).toBeNull();
      expect(bareJob!.jobSourceId).toBeNull();
    } else {
      const opp = await findOpportunity(userId, withSalary);
      expect(opp!.salaryText).toBe("月薪 20k");
      expect(opp!.sourceLabel).toBe("Indeed");
      const bareOpp = await findOpportunity(userId, bare);
      expect(bareOpp!.salaryText).toBeNull();
      expect(bareOpp!.sourceLabel).toBeNull();
    }
  });
});

test.describe("JOB-05 restricted capability prompts", () => {
  test.skip(
    !(IS_AB_FULL || IS_AB_RESUME || IS_AB_DISABLED),
    `family ${FAMILY} has no restricted surfaces`,
  );

  test("ab-full: Add Job shows the unsupported-fields hint in en and zh-CN, no internal terms", async ({
    page,
    baseURL,
  }) => {
    test.skip(!IS_AB_FULL, "requires ab-full family");
    await page.goto("/dashboard/myjobs?add-job=true");
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText(
        "Resume, cover letter, and tags aren't available here yet. You can still save this job.",
        { exact: true },
      ),
    ).toBeVisible();
    // No internal rollout vocabulary anywhere on the page.
    expect(await page.locator("body").innerText()).not.toMatch(
      /A\+B|VOCATRYA_AB|rollout|experiment/i,
    );
    await page.keyboard.press("Escape");

    await page.context().addCookies([
      { name: "vocatrya_locale", value: "zh-CN", url: baseURL! },
    ]);
    await page.goto("/dashboard/myjobs?add-job=true");
    await expect(
      page
        .getByRole("dialog")
        .getByText("暂不支持关联简历、求职信和技能标签，可先保存职位。", {
          exact: true,
        }),
    ).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(
      /A\+B|VOCATRYA_AB|rollout|experiment/i,
    );
  });

  test("ab-resume: blocked job list/save and profile read-only notice in en and zh-CN", async ({
    page,
    baseURL,
    cleanup,
  }) => {
    test.skip(!IS_AB_RESUME, "requires ab-resume family");
    const userId = await e2eUserId();

    // On a fresh resume_v1 instance the jobs read family is "blocked": the
    // list must surface the localized unavailable notice, not an empty table.
    await page.goto("/dashboard/myjobs");
    const loadError = page.getByTestId("jobs-load-error");
    await expect(loadError).toBeVisible();
    await expect(loadError).toContainText(
      "Job application data cannot be read in the current instance state.",
    );
    expect(await page.locator("body").innerText()).not.toMatch(
      /A\+B|VOCATRYA_AB|rollout|experiment/i,
    );

    // --- EN: profile read-only notice ---
    await page.goto("/dashboard/profile");
    await expect(
      page.getByText("Existing resumes are read-only"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Resume and career-material editing is currently unavailable in this editor. You can still view existing resumes.",
      ),
    ).toBeVisible();

    // --- EN: saving a job is rejected with a capability notice toast ---
    const blockedText = uniqueName("acc-rv-blocked");
    await page.goto("/dashboard/myjobs?add-job=true");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("add-job-dialog-title")).toBeVisible();
    const blockedCompany = `company ${blockedText}`;
    const blockedLocation = `location ${blockedText}`;
    await selectOrCreate(
      page,
      "Job Title",
      "Create or Search Job Title",
      blockedText,
    );
    cleanup.title(blockedText);
    await selectOrCreate(
      page,
      "Company",
      "Create or Search Company",
      blockedCompany,
    );
    cleanup.company(blockedCompany);
    await selectOrCreate(
      page,
      "Job Location",
      "Create or Search Job Location",
      blockedLocation,
    );
    cleanup.location(blockedLocation);
    await page.getByText("Part-time").click();
    await page.getByLabel("Job Source").click();
    await page.getByRole("option", { name: "Indeed" }).click();
    await page.getByLabel("Job Description").locator("div").click();
    await page
      .getByLabel("Job Description")
      .locator("div")
      .fill("restricted save");
    await page.getByTestId("save-job-btn").click();
    await expect(
      page.locator("[data-sonner-toast]").filter({
        hasText:
          "This editor cannot change jobs or resumes in the current app state.",
      }),
    ).toBeVisible();
    // The dialog stays open and no data is written to either family.
    await expect(dialog.getByTestId("add-job-dialog-title")).toBeVisible();
    expect(await findOpportunity(userId, blockedText)).toBeNull();
    expect(await findLegacyJob(userId, blockedText)).toBeNull();
    expect(await page.locator("body").innerText()).not.toMatch(
      /A\+B|VOCATRYA_AB|rollout|experiment/i,
    );

    // --- zh-CN: same blocked save returns a localized notice ---
    await page.context().addCookies([
      { name: "vocatrya_locale", value: "zh-CN", url: baseURL! },
    ]);
    await page.getByTestId("save-job-btn").click();
    await expect(
      page.locator("[data-sonner-toast]").filter({
        hasText: "当前应用状态下，此编辑器无法修改职位或简历。",
      }),
    ).toBeVisible();

    // --- zh-CN: profile notice and the blocked list are localized too ---
    await page.goto("/dashboard/profile");
    await expect(page.getByText("现有简历仅供查看")).toBeVisible();
    await page.goto("/dashboard/myjobs");
    const zhLoadError = page.getByTestId("jobs-load-error");
    await expect(zhLoadError).toBeVisible();
    await expect(zhLoadError).toContainText(
      "当前实例状态下无法读取职位申请数据。",
    );
    expect(await page.locator("body").innerText()).not.toMatch(
      /A\+B|VOCATRYA_AB|rollout|experiment/i,
    );
  });

  test("ab-disabled: runtime notice on jobs/profile, Add Job hidden, en and zh-CN", async ({
    page,
    baseURL,
  }) => {
    test.skip(!IS_AB_DISABLED, "requires ab-disabled family");
    await page.goto("/dashboard/myjobs");
    await expect(page.getByText("Editing is not enabled yet")).toBeVisible();
    await expect(
      page.getByText(/editing is not enabled for this app yet/i),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New Job", exact: true }),
    ).toHaveCount(0);
    await page.goto("/dashboard/profile");
    await expect(page.getByText("Editing is not enabled yet")).toBeVisible();

    await page.context().addCookies([
      { name: "vocatrya_locale", value: "zh-CN", url: baseURL! },
    ]);
    await page.goto("/dashboard/myjobs");
    await expect(page.getByText("编辑功能尚未启用")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(
      /A\+B|VOCATRYA_AB|rollout|experiment/i,
    );
  });
});
