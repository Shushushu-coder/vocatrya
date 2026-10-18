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

async function testUser() {
  return prisma.user.findUniqueOrThrow({
    where: { email: E2E_TEST_USER.email },
  });
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

test.afterAll(async () => {
  await prisma.$disconnect();
});
