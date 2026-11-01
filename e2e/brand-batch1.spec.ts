import { test as base } from "@playwright/test";
import {
  test,
  expect,
  createNewJob,
  uniqueName,
  useEnglishLocale,
} from "./fixtures";

// Signed-out checks use the base Playwright test (no auto-login), like
// signin.spec.ts; authenticated checks use the ./fixtures test.
base("auth pages render the static 40px Master mark", async ({
  page,
  baseURL,
}, testInfo) => {
  await useEnglishLocale(page.context(), baseURL);
  for (const route of ["/signin", "/signup"]) {
    await page.goto(route);
    const mark = page.locator("svg[data-vocatrya-mark]");
    await expect(mark).toHaveAttribute("width", "40");
    await expect(mark).toHaveAttribute("height", "40");
    await expect(mark).toHaveAttribute("data-animated", "false");
    await expect(
      page.getByRole("heading", { name: "Vocatrya" }),
    ).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("signup-desktop.png") });
});

// 390px wide and a deliberately short viewport: the extra 40px mark must not
// push the form, its errors or the bottom actions out of reach. The auth
// layout centers a growing card, so accessibility means the bottom action
// scrolls into view — assert that, not an above-the-fold position the taller
// signup card never had.
base("signin card stays usable on short mobile viewports", async ({
  page,
  baseURL,
}, testInfo) => {
  await useEnglishLocale(page.context(), baseURL);
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto("/signin");
  await expect(page.locator("svg[data-vocatrya-mark]")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Login", exact: true }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(/\/signup/);
  const submit = page.getByRole("button", { name: "Create an account" });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  await expect(submit).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("signup-390x500.png"),
    fullPage: true,
  });
});

// zh-CN is the product default: the mark and localized chrome must coexist.
base("signin mark renders under the zh-CN locale", async ({
  page,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/signin");
  await expect(page.locator("svg[data-vocatrya-mark]")).toHaveAttribute(
    "width",
    "40",
  );
  await expect(page.getByRole("button", { name: "登录" }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("signin-zh-390.png") });
});

test("mobile navigation sheet uses the static 20px Optical mark", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dashboard/myjobs");
  await page.getByRole("button", { name: "Toggle Menu" }).click();

  const brandLink = page.getByRole("link", { name: "Vocatrya" });
  await expect(brandLink).toBeVisible();
  const mark = brandLink.locator("svg[data-vocatrya-mark]");
  await expect(mark).toHaveAttribute("width", "20");
  await expect(mark).toHaveAttribute("data-animated", "false");
  // Original navigation entries survive the icon swap.
  await expect(
    page.getByRole("link", { name: "Jobs", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-sheet-390.png") });
});

test("company logos use letter avatars, including real image failures", async ({
  page,
  cleanup,
}, testInfo) => {
  const zhCompany = uniqueName("字节跳动");
  const failCompany = uniqueName("Logo Fail");

  // A job card for a CJK-named company without a logo URL: the letter avatar
  // carries the first Han character and the company name as accessible name.
  // JobCard only renders in card view; the default landing view is the table.
  await createNewJob(page, uniqueName("brand job"), cleanup, {
    company: zhCompany,
  });
  await page.getByRole("button", { name: "Card view" }).click();
  const jobLogo = page.getByRole("img", { name: zhCompany });
  await expect(jobLogo).toHaveText("字");
  await page.screenshot({ path: testInfo.outputPath("jobcard-zh-light.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: testInfo.outputPath("jobcard-zh-dark.png") });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  // A company whose logo URL really 404s: Radix Avatar must drop the <img>
  // and keep the letter avatar — exercised end to end in the browser.
  await page.goto("/dashboard/admin");
  await page.getByTestId("add-company-btn").click();
  await page.getByLabel("Company Name").fill(failCompany);
  await page.getByLabel("Company Logo URL").fill("/missing-logo-e2e.png");
  await page.getByRole("button", { name: /save/i }).click();
  cleanup.company(failCompany);
  await expect(page.getByText("Add Company")).not.toBeVisible();

  await page.getByPlaceholder("Search companies...").fill(failCompany);
  const row = page.getByRole("row").filter({ hasText: failCompany });
  const cellLogo = row.getByRole("img", { name: failCompany });
  await expect(cellLogo).toHaveText("LF");
  await expect(cellLogo.locator("img")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("company-404.png") });

  // The company details header reuses the same unified component.
  await row.getByRole("link", { name: failCompany, exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/admin\/companies\//);
  await expect(
    page.getByRole("img", { name: failCompany }).first(),
  ).toHaveText("LF");
});
