import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import Papa from "papaparse";
import { test, expect, uniqueName } from "./fixtures";
import { E2E_TEST_USER } from "./support/testUser";
import { configureE2EDatabase } from "./support/database";
import {
  cleanupMyJobsAcceptanceFixture,
  seedMyJobsAcceptanceFixture,
  type SeededAcceptanceJobs,
} from "./support/myJobsAcceptanceFixture";

const database = configureE2EDatabase();
const prisma = new PrismaClient({ datasourceUrl: database.url });

test("My Jobs zh-CN search/filter/pagination and locale-sensitive downloads", async ({ page, baseURL }) => {
  // Seed enough owned records to exercise real server pagination without
  // coupling My Jobs acceptance to the unrelated Add Job dialog controls.
  const user = await prisma.user.findUniqueOrThrow({ where: { email: E2E_TEST_USER.email } });
  const marker = uniqueName("验收岗位");
  let seeded: SeededAcceptanceJobs | undefined;
  try {
    seeded = await seedMyJobsAcceptanceFixture(prisma, { userId: user.id, marker });
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
      expect(rows[0]).toHaveLength(11);
      expect(rows[0][0]).toBe(locale === "en" ? "#" : "序号");
      expect(rows[0][4]).toBe(locale === "en" ? "Company" : "公司");
      const ownedRows = rows.slice(1).filter((row) => row[4] === company.label);
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
      }
    }
  } finally {
    try {
      if (seeded) await cleanupMyJobsAcceptanceFixture(prisma, seeded);
    } finally {
      await prisma.$disconnect();
    }
  }
});
