// zh-CN coverage for the Add Job form. The shared fixture pins
// vocatrya_locale=en so the rest of the suite keeps English locators; this
// spec overrides the cookie to assert the localized user-facing text.
import { test, expect } from "./fixtures";

test.describe("zh-CN locale", () => {
  test("required-field validation is localized, not raw English", async ({
    page,
    baseURL,
  }) => {
    await page.context().addCookies([
      { name: "vocatrya_locale", value: "zh-CN", url: baseURL! },
    ]);
    // Nothing is submitted — validation fails before create, no cleanup needed.
    await page.goto("/dashboard/myjobs?add-job=true");

    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();
    await page.getByTestId("save-job-btn").click();

    await expect(page.getByText("职位名称为必填项。")).toBeVisible();
    await expect(page.getByText("公司名称为必填项。")).toBeVisible();
    await expect(page.getByText("工作地点为必填项。")).toBeVisible();
    await expect(page.getByText("职位来源为必填项。")).toBeVisible();
    await expect(page.getByText("Job title is required.")).not.toBeVisible();
    await expect(page.getByText("Company name is required.")).not.toBeVisible();
  });

  test("job type and China default sources are localized", async ({
    page,
    baseURL,
  }) => {
    await page.context().addCookies([
      { name: "vocatrya_locale", value: "zh-CN", url: baseURL! },
    ]);
    await page.goto("/dashboard/myjobs?add-job=true");
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();
    await expect(page.getByRole("radio", { name: "实习" })).toBeVisible();
    await page.getByLabel("求职渠道").click();
    await expect(page.getByRole("option", { name: "官网" })).toBeVisible();
    await expect(page.getByRole("option", { name: "实习僧" })).toBeVisible();
    await expect(page.getByRole("option", { name: "BOSS直聘" })).toBeVisible();
    await expect(page.getByRole("option", { name: "内推群" })).toBeVisible();
    await expect(page.getByRole("option", { name: "小红书" })).toBeVisible();
  });

  test("placeholders follow zh-CN and the dialog has one restrained backdrop", async ({
    page,
    baseURL,
  }) => {
    await page.context().addCookies([
      { name: "vocatrya_locale", value: "zh-CN", url: baseURL! },
    ]);
    await page.goto("/dashboard/myjobs?add-job=true");
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();

    const backdrop = page.locator("div.fixed.inset-0");
    await expect(backdrop).toHaveCount(1);
    await expect(backdrop).toHaveClass(/bg-black\/30/);
    await expect(backdrop).not.toHaveClass(/bg-black\/80/);

    await expect(page.getByLabel("职位名称")).toContainText("选择职位名称");
    await expect(page.getByLabel("公司")).toContainText("选择公司");
    await expect(page.getByLabel("工作地点")).toContainText("选择工作地点");
    await expect(page.getByLabel("求职渠道")).toContainText("选择求职渠道");
    await expect(page.getByLabel("薪资范围")).toContainText("选择薪资范围");
    await expect(page.getByLabel("简历")).toContainText("选择简历");
    await expect(page.getByLabel("求职信")).toContainText("选择求职信");
    await expect(page.getByText("Select title", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Select source", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Select location", { exact: true })).toHaveCount(0);
    await expect(page.getByText("创建或搜索title", { exact: true })).toHaveCount(0);

    await page.getByLabel("职位名称").click();
    await expect(page.getByPlaceholder("创建或搜索职位名称")).toBeVisible();

    await page.context().addCookies([
      { name: "vocatrya_locale", value: "en", url: baseURL! },
    ]);
    await page.goto("/dashboard/myjobs?add-job=true");
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();
    await expect(page.getByLabel("Job Title")).toContainText("Select Job Title");
    await expect(page.getByLabel("Company")).toContainText("Select Company");
    await expect(page.getByLabel("Job Location")).toContainText("Select Job Location");
    await expect(page.getByLabel("Job Source")).toContainText("Select Job Source");
    await expect(page.getByLabel("Salary Range")).toContainText("Select Salary Range");
    await expect(page.getByLabel("Resume")).toContainText("Select Resume");
    await expect(page.getByLabel("Cover Letter")).toContainText("Select Cover Letter");
    await page.getByLabel("Job Title").click();
    await expect(page.getByPlaceholder("Create or Search Job Title")).toBeVisible();
  });
});
