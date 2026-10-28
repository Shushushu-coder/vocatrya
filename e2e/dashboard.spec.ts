import { type Page } from "@playwright/test";
import { test, expect, createNewJob, uniqueName } from "./fixtures";

async function navigateToDashboard(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByTestId("overview-metric-inProgress")).toBeVisible();
}

async function navigateToAnalytics(page: Page) {
  await page.goto("/dashboard/analytics");
  await expect(page.getByTestId("analytics-panel")).toBeVisible();
}

// The "New" dropdown in the header exposes the create flows; picking
// one deep-links to the target page which auto-opens its dialog.
async function createViaMenu(page: Page, menuitemName: string) {
  await page.getByTestId("header-create-menu").click();
  await page.getByRole("menuitem", { name: menuitemName, exact: true }).click();
}

test.describe("Dashboard overview page", () => {
  test("should display overview metrics and reflect a newly applied job", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("dashboard applied job");
    await createNewJob(page, jobText, cleanup, {
      beforeSave: async (page) => {
        await page.getByRole("switch").click();
      },
    });
    await expect(
      page.getByRole("row", { name: jobText }).first(),
    ).toBeVisible();

    await navigateToDashboard(page);

    for (const metric of [
      "overview-metric-inProgress",
      "overview-metric-applied7d",
      "overview-metric-openTasks",
    ]) {
      await expect(page.getByTestId(metric)).toBeVisible();
    }
    // Specs share a user, so don't assert an exact count — the job above was
    // applied today, so the 7d figure is at least one.
    await expect(
      page.getByTestId("overview-metric-applied7d").getByText(/^[1-9]\d*$/),
    ).toBeVisible();

    await expect(
      page.getByRole("heading", { name: "Recent updates", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("recent-updates").getByRole("link", { name: jobText }),
    ).toBeVisible();
  });

  test("should navigate via the header create menu to each create flow", async ({
    page,
  }) => {
    await createViaMenu(page, "Job");
    await expect(page).toHaveURL(/\/dashboard\/myjobs/, { timeout: 30000 });
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("add-job-dialog-title")).not.toBeVisible();

    await navigateToDashboard(page);
    await createViaMenu(page, "Tasks");
    await expect(page).toHaveURL(/\/dashboard\/tasks/, { timeout: 30000 });
    await expect(page.getByTestId("task-form-dialog-title")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("task-form-dialog-title")).not.toBeVisible();

    await navigateToDashboard(page);
    await createViaMenu(page, "Question");
    await expect(page).toHaveURL(/\/dashboard\/questions/, { timeout: 30000 });
    await expect(page.getByTestId("question-form-dialog-title")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByTestId("question-form-dialog-title"),
    ).not.toBeVisible();
  });

  test("upload entry lands on the career profile surface", async ({ page }) => {
    await page.getByTestId("header-upload").click();
    await expect(page).toHaveURL(/\/dashboard\/profile/, { timeout: 30000 });
  });

  // Web shell regression: the desktop titlebar's slots exist in the DOM on
  // every build, so a portal that ignores the Electron gate duplicates every
  // shared testid. The browser must expose exactly one set of global actions.
  test("exposes exactly one set of global actions in the web shell", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("header-create-menu")).toHaveCount(1);
    await expect(page.getByTestId("header-upload")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Open assistant" }),
    ).toHaveCount(1);
  });
});

test.describe("Analytics board", () => {
  test("shows totals, tabbed analysis and the activity calendar", async ({
    page,
  }) => {
    await navigateToAnalytics(page);

    for (const total of [
      "board-total-total",
      "board-total-applied",
      "board-total-interviews",
      "board-total-offers",
    ]) {
      await expect(page.getByTestId(total)).toBeVisible();
    }

    const tabs = page.getByTestId("analytics-tabs");
    await expect(
      tabs.getByRole("tab", { name: "Application trend" }),
    ).toBeVisible();
    await tabs.getByRole("tab", { name: "Status breakdown" }).click();
    await expect(
      page.getByRole("tab", { name: "Status breakdown" }),
    ).toHaveAttribute("data-state", "active");

    const windowToggle = page.getByTestId("analytics-window-toggle");
    await windowToggle.getByRole("button", { name: "30 days" }).click();
    await expect(
      windowToggle.getByRole("button", { name: "30 days" }),
    ).toHaveClass(/bg-primary/);

    await expect(
      page.getByRole("heading", {
        name: "Job Application Calendar",
        exact: true,
      }),
    ).toBeVisible();
    const currentYear = new Date().getFullYear().toString();
    await page.getByLabel("Select year").click();
    await expect(
      page.getByRole("option", { name: currentYear, exact: true }),
    ).toBeVisible();
  });
});

test.describe("Dashboard recent updates", () => {
  test("recent updates surface a newly created job", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("dashboard recent job");
    await createNewJob(page, jobText, cleanup, {});
    await expect(
      page.getByRole("row", { name: jobText }).first(),
    ).toBeVisible();

    await navigateToDashboard(page);
    await expect(
      page.getByTestId("recent-updates").getByRole("link", { name: jobText }),
    ).toBeVisible();
  });
});
