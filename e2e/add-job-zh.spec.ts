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

  test("placeholders follow locale for the fields the runtime actually renders", async ({
    page,
    baseURL,
  }) => {
    // jobs.abUnsupportedFieldsHint. Present only when AddJob sets
    // hideUnsupportedAbFields (AB_ENABLED + full). Legacy and narrower
    // scopes render resume, cover letter, and skill tags instead.
    const zhNotice =
      "A+B 模式下暂不支持选择简历、求职信和技能标签。请先不填写这些字段后保存。";
    const enNotice =
      "Resume, cover letter, and tags are not available in A+B mode yet. Submit this job without those fields.";

    await page.context().addCookies([
      { name: "vocatrya_locale", value: "zh-CN", url: baseURL! },
    ]);
    await page.goto("/dashboard/myjobs?add-job=true");
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();

    const backdrop = page.locator("div.fixed.inset-0");
    await expect(backdrop).toHaveCount(1);
    await expect(backdrop).toHaveClass(/bg-black\/30/);
    await expect(backdrop).not.toHaveClass(/bg-black\/80/);

    const dialog = page.getByRole("dialog").filter({
      has: page.getByTestId("add-job-dialog-title"),
    });
    await expect(dialog.getByLabel("职位名称")).toContainText("选择职位名称");
    await expect(dialog.getByLabel("公司")).toContainText("选择公司");
    await expect(dialog.getByLabel("工作地点")).toContainText("选择工作地点");
    await expect(dialog.getByLabel("求职渠道")).toContainText("选择求职渠道");
    await expect(dialog.getByLabel("薪资范围")).toContainText("选择薪资范围");
    await expect(dialog.getByText("Select title", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Select source", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Select location", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("创建或搜索title", { exact: true })).toHaveCount(0);

    // Decide before opening a combobox. Its modal popover is a second dialog
    // and hides the form from later text queries.
    const zhNoticeText = dialog.getByText(zhNotice, { exact: true });
    const zhResume = dialog.getByLabel("简历");
    await expect(zhNoticeText.or(zhResume)).toBeVisible();
    const hidesUnsupported = await zhNoticeText.isVisible();
    if (hidesUnsupported) {
      await expect(dialog.getByLabel("简历")).toHaveCount(0);
      await expect(dialog.getByLabel("求职信")).toHaveCount(0);
      await expect(dialog.getByText("添加技能", { exact: true })).toHaveCount(0);
      await expect(
        dialog.getByRole("combobox", { name: "搜索或添加技能...", exact: true }),
      ).toHaveCount(0);
    } else {
      await expect(zhNoticeText).toHaveCount(0);
      await expect(zhResume).toContainText("选择简历");
      await expect(dialog.getByLabel("求职信")).toContainText("选择求职信");
      await expect(dialog.getByText("添加技能", { exact: true })).toBeVisible();
      await expect(
        dialog.getByRole("combobox", { name: "搜索或添加技能...", exact: true }),
      ).toBeVisible();
    }

    await dialog.getByLabel("职位名称").click();
    await expect(page.getByPlaceholder("创建或搜索职位名称")).toBeVisible();

    await page.context().addCookies([
      { name: "vocatrya_locale", value: "en", url: baseURL! },
    ]);
    await page.goto("/dashboard/myjobs?add-job=true");
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();
    await expect(dialog.getByLabel("Job Title")).toContainText("Select Job Title");
    await expect(dialog.getByLabel("Company")).toContainText("Select Company");
    await expect(dialog.getByLabel("Job Location")).toContainText("Select Job Location");
    await expect(dialog.getByLabel("Job Source")).toContainText("Select Job Source");
    await expect(dialog.getByLabel("Salary Range")).toContainText("Select Salary Range");

    const enNoticeText = dialog.getByText(enNotice, { exact: true });
    const enResume = dialog.getByLabel("Resume");
    await expect(enNoticeText.or(enResume)).toBeVisible();
    const enHides = await enNoticeText.isVisible();
    expect(enHides).toBe(hidesUnsupported);
    if (enHides) {
      await expect(dialog.getByText(enNotice, { exact: true })).toBeVisible();
      await expect(dialog.getByLabel("Resume")).toHaveCount(0);
      await expect(dialog.getByLabel("Cover Letter")).toHaveCount(0);
      await expect(dialog.getByText("Add Skill", { exact: true })).toHaveCount(0);
      await expect(
        dialog.getByRole("combobox", { name: "Search or add a skill...", exact: true }),
      ).toHaveCount(0);
    } else {
      await expect(dialog.getByText(enNotice, { exact: true })).toHaveCount(0);
      await expect(dialog.getByLabel("Resume")).toContainText("Select Resume");
      await expect(dialog.getByLabel("Cover Letter")).toContainText("Select Cover Letter");
      await expect(dialog.getByText("Add Skill", { exact: true })).toBeVisible();
      await expect(
        dialog.getByRole("combobox", { name: "Search or add a skill...", exact: true }),
      ).toBeVisible();
    }

    await dialog.getByLabel("Job Title").click();
    await expect(page.getByPlaceholder("Create or Search Job Title")).toBeVisible();
  });
});
