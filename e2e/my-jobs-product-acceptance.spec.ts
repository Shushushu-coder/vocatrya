import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { test as base, expect } from "@playwright/test";
import bcrypt from "bcryptjs";
import Papa from "papaparse";
import { uniqueName, useEnglishLocale } from "./fixtures";
import { configureE2EDatabase } from "./support/database";
import {
  ACCEPTANCE_SALARY,
  cleanupMyJobsAcceptanceFixture,
  seedMyJobsAcceptanceFixture,
  type SeededAcceptanceJobs,
} from "./support/myJobsAcceptanceFixture";

const database = configureE2EDatabase();
const prisma = new PrismaClient({ datasourceUrl: database.url });

// A test-scoped identity keeps the unfiltered list and exports exclusive to
// these 28 records, even while other workers create jobs for E2E_TEST_USER.
const test = base.extend<{ acceptanceUser: { id: string; email: string; password: string } }>({
  acceptanceUser: async ({}, use) => {
    const password = randomUUID();
    const user = await prisma.user.create({
      data: {
        name: "My Jobs acceptance",
        email: `my-jobs-${randomUUID()}@example.com`,
        password: await bcrypt.hash(password, 10),
      },
    });
    try {
      await use({ id: user.id, email: user.email, password });
    } finally {
      try {
        await prisma.userSettings.deleteMany({ where: { userId: user.id } });
        // Visiting My Jobs also provisions this user's default sources.
        await prisma.jobSource.deleteMany({ where: { createdBy: user.id } });
        await prisma.user.delete({ where: { id: user.id } });
      } finally {
        await prisma.$disconnect();
      }
    }
  },
  page: async ({ page, baseURL, acceptanceUser }, use) => {
    await useEnglishLocale(page.context(), baseURL);
    await page.goto("/");
    await page.getByPlaceholder("id@example.com").fill(acceptanceUser.email);
    await page.getByRole("textbox", { name: "Password" }).fill(acceptanceUser.password);
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await expect(page).toHaveURL(baseURL + "/dashboard");
    await use(page);
  },
});

test("My Jobs zh-CN search/filter/pagination and locale-sensitive downloads", async ({ page, baseURL, acceptanceUser }) => {
  // Seed enough owned records to exercise real server pagination without
  // coupling My Jobs acceptance to the unrelated Add Job dialog controls.
  const marker = uniqueName("验收岗位");
  let seeded: SeededAcceptanceJobs | undefined;
  try {
    seeded = await seedMyJobsAcceptanceFixture(prisma, { userId: acceptanceUser.id, marker });
    console.log(`[my-jobs-acceptance] read family=${seeded.family}`);
    const { company, title, location, source } = seeded.catalog;
    await page.context().addCookies([{ name: "vocatrya_locale", value: "zh-CN", url: baseURL! }]);
    await page.goto("/dashboard/myjobs");
    const numbers = page.getByTestId("job-row-number");
    await expect(numbers.first()).toHaveText("1");
    await expect(numbers.nth(1)).toHaveText("2");
    await expect(numbers.nth(2)).toHaveText("3");
    await numbers.last().scrollIntoViewIfNeeded();
    await expect(numbers.nth(25)).toHaveText("26");
    await expect.poll(async () => numbers.allTextContents()).toEqual(Array.from({ length: 28 }, (_, i) => String(i + 1)));

    const search = page.getByPlaceholder("搜索职位...");
    await search.fill(marker);
    await expect(page).toHaveURL(/search=/);
    await expect(numbers.first()).toHaveText("1");
    await page.getByTestId("job-filter-select").click();
    await page.getByRole("option", { name: seeded.singletonFilterLabel, exact: true }).click();
    await expect(numbers).toHaveCount(1);
    await expect(numbers).toHaveText("1");
    await page.getByTestId("job-filter-select").click();
    await page.getByRole("option", { name: seeded.resetFilterLabel, exact: true }).click();
    await expect(numbers.nth(2)).toHaveText("3");
    await search.clear();
    await expect(page).not.toHaveURL(/search=/);
    await expect(numbers.first()).toHaveText("1");
    await numbers.last().scrollIntoViewIfNeeded();
    await expect(numbers.nth(25)).toHaveText("26");

    for (const locale of ["zh-CN", "en"] as const) {
      if (locale === "en") {
        await page.goto("/dashboard/settings");
        await page
          .locator("main nav")
          .getByRole("button", { name: /^(General|常规偏好)$/ })
          .click();
        await page.getByTestId("settings-language-select").click();
        await page.getByRole("option", { name: "English" }).click();
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        await page.goto("/dashboard/myjobs");
        await page.waitForLoadState("networkidle");
      }
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: locale === "en" ? "Export" : "导出", exact: true }).click();
      const download = await downloadPromise;
      const bytes = readFileSync((await download.path())!);
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const rows = Papa.parse<string[]>(bytes.toString("utf8").slice(1)).data;
      expect(rows[0]).toHaveLength(12);
      expect(rows[0][0]).toBe(locale === "en" ? "#" : "序号");
      expect(rows[0][4]).toBe(locale === "en" ? "Company" : "公司");
      expect(rows[0][11]).toBe(locale === "en" ? "Salary" : "薪资待遇");
      const ownedRows = rows.slice(1).filter((row) => row[4] === company.label);
      expect(rows.slice(1).filter((row) => row.length > 1)).toHaveLength(28);
      expect(ownedRows).toHaveLength(28);
      expect(ownedRows.some((row) => row[2] === (locale === "en" ? "Yes" : "是"))).toBe(true);
      expect(ownedRows.some((row) => row[2] === (locale === "en" ? "No" : "否"))).toBe(true);
      expect(ownedRows.some((row) => row[10] === (locale === "en" ? "Interview" : "面试中"))).toBe(true);
      for (const row of ownedRows) {
        expect(row[5]).toBe(title.label);
        expect(row[6]).toBe(locale === "en" ? "Internship" : "实习");
        expect(row[7]).toBe(locale === "en" ? "Remote" : "远程");
        expect(row[8]).toBe(location.label);
        expect(row[9]).toBe(source.label);
        expect(row[11]).toBe(ACCEPTANCE_SALARY);
      }
    }
  } finally {
    if (seeded) await cleanupMyJobsAcceptanceFixture(prisma, seeded);
  }
});
