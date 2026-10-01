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
});
