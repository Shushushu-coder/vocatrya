import path from "node:path";
import { type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { test, expect, uniqueName } from "./fixtures";
import { E2E_TEST_USER } from "./support/testUser";
import { configureE2EDatabase } from "./support/database";

// Runs against the same isolated SQLite file as every e2e spec here; nothing
// in this file touches a developer or install-time database.
const database = configureE2EDatabase();
const prisma = new PrismaClient({ datasourceUrl: database.url });

const SCRIM = "div.fixed.inset-0";
const SHOTS = path.join("test-results", "dialog-overlay");
const FRESH_NATIVE_KEY = "vocatrya-ab-fresh-native-v1";

// The reflection surface only exists in the full A+B family, so the synthetic
// database is activated exactly the way `ab:init-fresh --confirm` would mark it.
// Boundary: this upsert is only valid against the isolated fresh-native
// synthetic DB provisioned by the e2e harness — never point it at a real user
// database or a composite test database that may still hold legacy rows.
async function ensureFreshNative() {
  await prisma.abMigrationState.upsert({
    where: { scopeKey: "instance" },
    update: {
      migrationKey: FRESH_NATIVE_KEY,
      status: "FRESH_READY",
      verifiedAt: new Date(),
    },
    create: {
      migrationKey: FRESH_NATIVE_KEY,
      status: "FRESH_READY",
      verifiedAt: new Date(),
    },
  });
}

async function testUser() {
  return prisma.user.findUniqueOrThrow({
    where: { email: E2E_TEST_USER.email },
  });
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

const scrims = (page: Page) => page.locator(SCRIM);

async function scrimBackground(page: Page) {
  return scrims(page)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function scrollLocked(page: Page) {
  return page.evaluate(() => document.body.hasAttribute("data-scroll-locked"));
}

// The background is isolated from assistive tech by aria-hidden on every
// sibling subtree, not by pointer tricks — assert the sentinel sits inside a
// hidden ancestor while the dialog is open.
async function backgroundAriaHidden(page: Page, testid: string) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    return el?.closest("[aria-hidden='true']") != null;
  }, testid);
}

async function openTaskDialog(page: Page) {
  await page.getByTestId("add-task-btn").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(scrims(page)).toHaveCount(1);
  return dialog;
}

test.describe("Dialog overlay regression (R1A-01)", () => {
  test("Add Task: one ~30% scrim, four close paths, lock + isolation released", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard/tasks");
    await page.getByTestId("add-task-btn").waitFor({ state: "visible" });

    let dialog = await openTaskDialog(page);
    expect(await scrimBackground(page)).toBe("rgba(0, 0, 0, 0.3)");
    expect(await scrollLocked(page)).toBe(true);
    expect(await backgroundAriaHidden(page, "add-task-btn")).toBe(true);
    await page.screenshot({
      path: path.join(SHOTS, "add-task-light-1440.png"),
    });

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    dialog = await openTaskDialog(page);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();

    dialog = await openTaskDialog(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();

    dialog = await openTaskDialog(page);
    // Radix arms its outside-pointerdown listener in a passive effect, so a
    // click in the same frame as `toBeVisible` can race the mount. Give the
    // layer a beat before simulating a real outside click.
    await page.waitForTimeout(300);
    // Overlay spans the viewport; a top-left click can only land on it.
    await page.mouse.click(8, 8);
    await expect(dialog).not.toBeVisible();
    await expect(scrims(page)).toHaveCount(0);
    expect(await scrollLocked(page)).toBe(false);
    // Controlled dialog without DialogTrigger: focus returns to <body>, same
    // contract as before this change.
    expect(
      await page.evaluate(
        () =>
          document.activeElement === document.body ||
          !(document.activeElement as HTMLElement | null)?.closest(
            "[role='dialog']",
          ),
      ),
    ).toBe(true);
  });

  test("Add Question: single scrim and all close paths", async ({ page }) => {
    await page.goto("/dashboard/questions");
    await page
      .getByRole("button", { name: "New Question" })
      .waitFor({ state: "visible" });

    const open = async () => {
      await page.getByRole("button", { name: "New Question" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(scrims(page)).toHaveCount(1);
      return dialog;
    };

    let dialog = await open();
    expect(await scrimBackground(page)).toBe("rgba(0, 0, 0, 0.3)");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    dialog = await open();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();

    dialog = await open();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();

    dialog = await open();
    await page.waitForTimeout(300);
    await page.mouse.click(8, 8);
    await expect(dialog).not.toBeVisible();
  });

  test("Add Job: shared scrim unchanged, Escape still closes", async ({
    page,
  }) => {
    await page.goto("/dashboard/myjobs");
    await page.getByTestId("add-job-btn").waitFor({ state: "visible" });
    await page.getByTestId("add-job-btn").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(scrims(page)).toHaveCount(1);
    expect(await scrimBackground(page)).toBe("rgba(0, 0, 0, 0.3)");

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("zh-CN: question dialog renders a single scrim with zh chrome", async ({
    page,
    baseURL,
  }) => {
    await page
      .context()
      .addCookies([
        { name: "vocatrya_locale", value: "zh-CN", url: baseURL! },
      ]);
    await page.goto("/dashboard/questions");
    await page.getByRole("button", { name: "新题目" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(scrims(page)).toHaveCount(1);
    await expect(page.getByTestId("question-form-dialog-title")).toHaveText(
      "添加面试题",
    );
    await page.screenshot({
      path: path.join(SHOTS, "add-question-zh.png"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("dark theme: scrim follows the dark token mapping", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/dashboard/tasks");
    await page.getByTestId("add-task-btn").waitFor({ state: "visible" });
    const dialog = await openTaskDialog(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await scrimBackground(page)).toBe("rgba(0, 0, 0, 0.5)");
    await page.screenshot({
      path: path.join(SHOTS, "add-task-dark-1440.png"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("AlertDialog: destructive confirm ignores background click", async ({
    page,
  }) => {
    const marker = uniqueName("overlay-question");
    const user = await testUser();
    const question = await prisma.question.create({
      data: { question: marker, answer: "x", createdBy: user.id },
    });
    try {
      await page.goto("/dashboard/questions");
      await page
        .getByTestId("question-card")
        .filter({ hasText: marker })
        .getByTestId("question-delete-btn")
        .click();
      const alert = page.getByRole("alertdialog");
      await expect(alert).toBeVisible();
      await expect(scrims(page)).toHaveCount(1);

      // Wait for DismissableLayer's listener to arm before clicking — without
      // an armed listener the click is ignored and "did not close" proves
      // nothing about AlertDialog's outside-click guard.
      await page.waitForTimeout(300);
      await page.mouse.click(8, 8);
      await expect(alert).toBeVisible();

      await alert.getByRole("button", { name: "Cancel" }).click();
      await expect(alert).not.toBeVisible();
    } finally {
      await prisma.question.deleteMany({ where: { id: question.id } });
    }
  });
});

test.describe("Interview Reflection layout (R1A-01)", () => {
  test("header pinned, body scrolls, footer reachable at 960x700 — incl. zh-CN", async ({
    page,
    baseURL,
  }) => {
    const marker = uniqueName("overlay-reflection");
    await ensureFreshNative();
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
    await ensureFreshNative();
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
