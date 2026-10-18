import path from "node:path";
import { type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { test, expect, uniqueName } from "./fixtures";
import { E2E_TEST_USER } from "./support/testUser";
import {
  provisionR3FreshNativeData,
  provisionR3FreshNativeSchema,
  resolveR3FreshNativeDatabase,
} from "./support/r3Harness";

// These tests need a real fresh-native surface, and that surface is gated by
// the FRESH_READY row in abMigrationState. They run only under the
// chromium-fresh-native project in r3-foundation.config.ts, whose disposable
// database keeps the marker isolated from every other e2e database — the
// reason this file is separate from dialog-overlay.spec.ts and ignored by
// the main playwright.config.ts.
const database = resolveR3FreshNativeDatabase();
const prisma = new PrismaClient({ datasourceUrl: database.url });

const SHOTS = path.join("test-results", "dialog-overlay");

async function testUser() {
  return prisma.user.findUniqueOrThrow({
    where: { email: E2E_TEST_USER.email },
  });
}

async function scrollLocked(page: Page) {
  return page.evaluate(() => document.body.hasAttribute("data-scroll-locked"));
}

async function seedInterviewStep(userId: string, marker: string) {
  const company = await prisma.company.create({
    data: { label: `${marker} Co`, value: marker, createdBy: userId },
  });
  const opportunity = await prisma.jobOpportunity.create({
    data: {
      userId,
      companyId: company.id,
      title: `${marker} Engineer`,
      employmentType: "FULL_TIME",
      createdVia: "USER",
      status: "UNKNOWN",
    },
  });
  const version = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opportunity.id,
      versionNumber: 1,
      rawContent: `${marker} description`,
      rawContentFormat: "PLAIN_TEXT",
      capturedAt: new Date(),
      contentHash: `${marker}-hash`,
      createdVia: "USER",
    },
  });
  await prisma.jobOpportunity.update({
    where: { id: opportunity.id },
    data: { currentJdVersionId: version.id },
  });
  const attempt = await prisma.applicationAttempt.create({
    data: {
      userId,
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
      currentStageCategory: "INTERVIEW",
      outcome: "ACTIVE",
      createdVia: "USER",
    },
  });
  const step = await prisma.applicationProcessStep.create({
    data: {
      applicationAttemptId: attempt.id,
      category: "INTERVIEW",
      label: `${marker} Round 1`,
      status: "PENDING",
      sortOrder: 10,
      source: "USER",
    },
  });
  return { company, opportunity, version, attempt, step };
}

async function cleanupInterviewSeed(ids: {
  companyId: string;
  opportunityId: string;
  versionId: string;
}) {
  await prisma.applicationProcessStep.deleteMany({
    where: { applicationAttempt: { jobOpportunityId: ids.opportunityId } },
  });
  await prisma.applicationAttempt.deleteMany({
    where: { jobOpportunityId: ids.opportunityId },
  });
  await prisma.jobOpportunity.update({
    where: { id: ids.opportunityId },
    data: { currentJdVersionId: null },
  });
  await prisma.jobDescriptionVersion.delete({ where: { id: ids.versionId } });
  await prisma.jobOpportunity.delete({ where: { id: ids.opportunityId } });
  await prisma.company.delete({ where: { id: ids.companyId } });
}

test.describe("Interview Reflection layout (R1A-01)", () => {
  test.beforeAll(async () => {
    // Config load already migrated the file for the server's instrumentation;
    // repeat it so this spec stays self-contained under ad-hoc runners, then
    // seed the fixture identity and activate FRESH_READY through the product's
    // own bootstrap. Provisioning failures throw with the blocker list.
    provisionR3FreshNativeSchema(database, path.resolve(__dirname, ".."));
    await provisionR3FreshNativeData(prisma, database.path);
  });

  test("header pinned, body scrolls, footer reachable at 960x700 — incl. zh-CN", async ({
    page,
    baseURL,
  }) => {
    const marker = uniqueName("overlay-reflection");
    const user = await testUser();
    const seed = await seedInterviewStep(user.id, marker);
    try {
      await page.setViewportSize({ width: 960, height: 700 });
      await page.goto(`/dashboard/myjobs/${seed.opportunity.id}`);
      await page.getByRole("tab", { name: "Timeline" }).click();
      const entry = page.getByTestId("interview-reflection-entry");
      await expect(entry).toBeVisible();
      await entry.click();

      const dialog = page.getByTestId("interview-reflection-dialog");
      await expect(dialog).toBeVisible();
      const body = page.getByTestId("interview-reflection-body");
      const save = page.getByTestId("interview-reflection-save");
      const cancel = dialog.getByRole("button", { name: "Cancel" });

      // Overflow: add enough rows that the body must scroll.
      for (let i = 0; i < 8; i += 1) {
        await page.getByTestId("interview-reflection-add-question").click();
      }
      const scrollable = await body.evaluate(
        (el) => el.scrollHeight > el.clientHeight,
      );
      expect(scrollable).toBe(true);

      // Header and footer stay put while the body scrolls.
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(
        dialog.getByText("Interview reflection", { exact: true }),
      ).toBeInViewport();
      await expect(save).toBeInViewport();
      await expect(cancel).toBeInViewport();
      await page.screenshot({
        path: path.join(SHOTS, "reflection-960x700-scrolled.png"),
      });

      // Save path intact: content persists and the dialog closes.
      await page
        .getByTestId("interview-reflection-question")
        .first()
        .fill(`${marker} q1`);
      await page
        .getByTestId("interview-reflection-overall")
        .fill(`${marker} overall`);
      await save.click();
      await expect(dialog).not.toBeVisible();

      // Reopen: saved draft loads back through the same body. Wait for the
      // ready state before asserting values — dev-mode server actions can be
      // slow right after a save+revalidate.
      await entry.click();
      await expect(
        page.getByTestId("interview-reflection-add-question"),
      ).toBeVisible({ timeout: 20000 });
      await expect(
        page.getByTestId("interview-reflection-question").first(),
      ).toHaveValue(`${marker} q1`);
      await expect(
        page.getByTestId("interview-reflection-overall"),
      ).toHaveValue(`${marker} overall`);
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      expect(await scrollLocked(page)).toBe(false);

      // zh-CN chrome check on the same seeded data.
      await page
        .context()
        .addCookies([
          { name: "vocatrya_locale", value: "zh-CN", url: baseURL! },
        ]);
      await page.goto(`/dashboard/myjobs/${seed.opportunity.id}`);
      await page.getByRole("tab", { name: "申请流程" }).click();
      await page.getByTestId("interview-reflection-entry").click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText("面试复盘", { exact: true }),
      ).toBeInViewport();
      await expect(
        dialog.getByRole("button", { name: "取消" }),
      ).toBeInViewport();
      await page.screenshot({
        path: path.join(SHOTS, "reflection-zh-960x700.png"),
      });
      await dialog.getByRole("button", { name: "取消" }).click();
      await expect(dialog).not.toBeVisible();
    } finally {
      await cleanupInterviewSeed({
        companyId: seed.company.id,
        opportunityId: seed.opportunity.id,
        versionId: seed.version.id,
      });
    }
  });

  test("close paths at 1440x900: X, Escape, Cancel all work with tall content", async ({
    page,
  }) => {
    const marker = uniqueName("overlay-reflection-xl");
    const user = await testUser();
    const seed = await seedInterviewStep(user.id, marker);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/dashboard/myjobs/${seed.opportunity.id}`);
      await page.getByRole("tab", { name: "Timeline" }).click();
      const entry = page.getByTestId("interview-reflection-entry");
      const dialog = page.getByTestId("interview-reflection-dialog");

      await entry.click();
      await expect(dialog).toBeVisible();
      for (let i = 0; i < 6; i += 1) {
        await page.getByTestId("interview-reflection-add-question").click();
      }
      // X close button inside the shared DialogContent chrome.
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).not.toBeVisible();

      await entry.click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();

      await entry.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).not.toBeVisible();
    } finally {
      await cleanupInterviewSeed({
        companyId: seed.company.id,
        opportunityId: seed.opportunity.id,
        versionId: seed.version.id,
      });
    }
  });
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
