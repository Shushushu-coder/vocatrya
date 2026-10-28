import { test, expect } from "@playwright/test";
import { useEnglishLocale, uniqueName } from "./fixtures";

// Adaptive overview (Dashboard V2.1): a brand-new signup has provably zero
// business records, so the overview replaces the empty feed with the
// getting-started region. Each entry must land on the real
// existing create flow / surface — no placeholder targets.
// Uses the base playwright test (not the auto-login fixture) so the account
// under test stays genuinely empty.
test.describe("Adaptive overview — fresh account", () => {
  test("shows the four-entry getting-started region and each entry navigates to the real flow", async ({
    page,
    baseURL,
  }) => {
    await useEnglishLocale(page.context(), baseURL);
    await page.goto("/signup");

    const email = `${uniqueName("adaptive-overview").replace(/\s+/g, "")}@example.com`;
    await page.getByLabel("Full Name").fill("Adaptive Overview");
    await page.getByPlaceholder("id@example.com").fill(email);
    await page.getByRole("textbox", { name: "Password" }).fill("Passw0rd!2026");
    await page.getByRole("button", { name: "Create an account" }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30000 });

    // Metrics row still heads the page; the empty feed is replaced by the
    // getting-started region with all four entries.
    for (const metric of [
      "overview-metric-inProgress",
      "overview-metric-applied7d",
      "overview-metric-openTasks",
    ]) {
      await expect(page.getByTestId(metric)).toBeVisible();
    }
    const guide = page.getByTestId("overview-getting-started");
    await expect(guide).toBeVisible();
    await expect(page.getByTestId("recent-updates")).not.toBeVisible();

    // Add a position -> existing job create flow.
    await guide.getByTestId("getting-started-job").click();
    await expect(page).toHaveURL(/\/dashboard\/myjobs/, { timeout: 30000 });
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("add-job-dialog-title")).not.toBeVisible();

    // Add a to-do -> existing task create flow.
    await page.goto("/dashboard");
    await guide.getByTestId("getting-started-task").click();
    await expect(page).toHaveURL(/\/dashboard\/tasks/, { timeout: 30000 });
    await expect(page.getByTestId("task-form-dialog-title")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("task-form-dialog-title")).not.toBeVisible();

    // Question bank -> the existing bank surface.
    await page.goto("/dashboard");
    await guide.getByTestId("getting-started-question").click();
    await expect(page).toHaveURL(/\/dashboard\/questions/, {
      timeout: 30000,
    });
    await expect(
      page.getByRole("button", { name: "New Question" }),
    ).toBeVisible({ timeout: 30000 });
  });
});
