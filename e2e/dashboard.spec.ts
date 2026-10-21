import { type Page } from "@playwright/test";
import {
  test,
  expect,
  createNewJob,
  selectOrCreate,
  uniqueName,
  type CleanupRegistry,
} from "./fixtures";

async function navigateToDashboard(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByTestId("overview-metric-inProgress")).toBeVisible();
}

async function navigateToAnalytics(page: Page) {
  await page.goto("/dashboard/analytics");
  await expect(page.getByTestId("analytics-panel")).toBeVisible();
}

// The running activity is a per-user singleton and specs run in parallel
// against one shared user, so a concurrently running spec can interleave a
// switch-confirm around our stop click. Retry the whole click/confirm
// handshake until the Stop button actually disappears.
async function stopRunningActivity(page: Page) {
  const stopButton = page.getByRole("button", {
    name: "Stop Activity",
    exact: true,
  });
  const confirmSwitchBtn = page.getByRole("button", { name: "Stop & Start" });
  await expect(async () => {
    if (await stopButton.isVisible().catch(() => false)) {
      await stopButton.click({ force: true });
    }
    if (await confirmSwitchBtn.isVisible().catch(() => false)) {
      await confirmSwitchBtn.click({ force: true });
    }
    await expect(stopButton).not.toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 10000 });
}

async function navigateToTasks(page: Page) {
  await page.goto("/dashboard/tasks");
  await page.getByTestId("add-task-btn").waitFor({ state: "visible" });
}

async function createTaskWithActivityType(
  page: Page,
  title: string,
  activityType: string,
  cleanup: CleanupRegistry,
) {
  await page.getByTestId("add-task-btn").click({ force: true });
  await expect(page.getByTestId("task-form-dialog-title")).toBeVisible();
  const titleInput = page.getByPlaceholder("Enter task title");
  await titleInput.waitFor({ state: "visible" });
  await titleInput.fill(title);
  await titleInput.blur();

  await page.getByText("Select activityType").click({ force: true });
  await page
    .getByPlaceholder("Create or Search activityType")
    .fill(activityType);
  const createOption = page.getByText(`Create: ${activityType}`);
  const existingOption = page.getByRole("option", {
    name: activityType,
    exact: true,
  });
  await expect(createOption.or(existingOption).first()).toBeVisible();
  if (await existingOption.isVisible()) {
    await existingOption.click({ force: true });
  } else {
    await createOption.click({ force: true });
  }
  await expect(
    page.getByPlaceholder("Create or Search activityType"),
  ).not.toBeVisible({ timeout: 15000 });
  cleanup.activityType(activityType);

  const saveBtn = page.getByTestId("save-task-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  await expect(page.getByTestId("task-form-dialog-title")).not.toBeVisible({
    timeout: 10000,
  });
  cleanup.task(title);
}

// The New Activity dialog pre-fills valid start/end times (now .. now+5m),
// so this creates a completed activity that lands directly in the recent
// activities list without waiting on ACTIVITY_MIN_DURATION_MINUTES.
async function createCompletedActivity(
  page: Page,
  activityName: string,
  activityType: string,
  cleanup: CleanupRegistry,
) {
  await page.goto("/dashboard/activities");
  await page.getByTestId("add-activity-btn").waitFor({ state: "visible" });
  await page.getByTestId("add-activity-btn").click();
  await expect(page.getByText("Add New Activity")).toBeVisible();

  await page
    .getByPlaceholder("Ex: Job Search, Learning skill, etc")
    .fill(activityName);
  await selectOrCreate(
    page,
    "Activity Type",
    "Create or Search activityType",
    activityType,
  );
  cleanup.activityType(activityType);

  await page.getByTestId("save-activity-btn").click();
  await expect(page.getByText("Add New Activity")).not.toBeVisible({
    timeout: 10000,
  });
  cleanup.activity(activityName);
}

// The "New" dropdown in the header exposes the four create flows; picking
// one deep-links to the target page which auto-opens its dialog.
async function createViaMenu(page: Page, menuitemName: string) {
  await page.getByTestId("header-create-menu").click();
  await page
    .getByRole("menuitem", { name: menuitemName, exact: true })
    .click();
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
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await navigateToDashboard(page);

    for (const metric of [
      "overview-metric-inProgress",
      "overview-metric-applied7d",
      "overview-metric-openTasks",
      "overview-metric-upcomingActivities",
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

    await navigateToDashboard(page);
    await createViaMenu(page, "Activities");
    await expect(page).toHaveURL(/\/dashboard\/activities/, { timeout: 30000 });
    await expect(page.getByText("Add New Activity")).toBeVisible();
    await page.keyboard.press("Escape");
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
    await tabs.getByRole("tab", { name: "Activity breakdown" }).click();
    await expect(
      page.getByRole("tab", { name: "Activity breakdown" }),
    ).toHaveAttribute("data-state", "active");

    const windowToggle = page.getByTestId("analytics-window-toggle");
    await windowToggle.getByRole("button", { name: "30 days" }).click();
    await expect(
      windowToggle.getByRole("button", { name: "30 days" }),
    ).toHaveClass(/bg-primary/);

    await expect(
      page.getByRole("heading", { name: "Activity Calendar", exact: true }),
    ).toBeVisible();
    const currentYear = new Date().getFullYear().toString();
    await page.getByLabel("Select year").click();
    await expect(
      page.getByRole("option", { name: currentYear, exact: true }),
    ).toBeVisible();
  });
});

test.describe("Dashboard recent updates", () => {
  test("should not surface a very short discarded activity", async ({
    page,
    cleanup,
  }) => {
    // Activities below ACTIVITY_MIN_DURATION_MINUTES are discarded on stop
    // (src/context/ActivityContext.tsx), so a start immediately followed by
    // a stop is deleted server-side rather than saved.
    const taskTitle = uniqueName("E2E Dashboard Activity Task");
    const activityType = uniqueName("E2E Dashboard Activity Type");
    await navigateToTasks(page);
    await createTaskWithActivityType(page, taskTitle, activityType, cleanup);
    const taskRow = page
      .getByRole("row", { name: new RegExp(taskTitle, "i") })
      .first();
    await expect(taskRow).toBeVisible({ timeout: 10000 });

    await taskRow.hover();
    await taskRow.getByTestId("task-start-activity-btn").click({ force: true });
    // If another activity was already running (e.g. from a concurrently
    // running spec), confirm the switch instead of hanging on the dialog.
    const confirmSwitchBtn = page.getByRole("button", { name: "Stop & Start" });
    try {
      await confirmSwitchBtn.waitFor({ state: "visible", timeout: 3000 });
      await confirmSwitchBtn.click();
    } catch {
      // No conflicting activity, continue.
    }
    await expect(
      page.getByRole("button", { name: "Stop Activity", exact: true }),
    ).toBeVisible({ timeout: 10000 });

    await stopRunningActivity(page);

    await navigateToDashboard(page);
    await expect(
      page.getByTestId("recent-updates").getByText(taskTitle, { exact: true }),
    ).not.toBeVisible();
  });
});
