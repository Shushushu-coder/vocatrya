// Base test deliberately starts signed out. Only the first page logs in.
import { test, expect } from "@playwright/test";
import { login, useEnglishLocale } from "./fixtures";

test("valid login survives reload, navigation, and reopening saved browser storage", async ({ page, browser, baseURL }) => {
  await useEnglishLocale(page.context(), baseURL);
  await page.goto("/signin");
  await login(page);
  await expect(page).toHaveURL(`${baseURL}/dashboard`);

  await page.reload();
  await expect(page).toHaveURL(`${baseURL}/dashboard`);
  await expect(page.getByRole("button", { name: "User menu" })).toBeVisible();
  await page.goto("/dashboard/myjobs");
  await expect(page).toHaveURL(`${baseURL}/dashboard/myjobs`);
  await expect(page.getByRole("button", { name: "User menu" })).toBeVisible();

  const storageState = await page.context().storageState();
  await page.context().close();
  const reopened = await browser.newContext({ storageState, baseURL });
  try {
    const nextPage = await reopened.newPage();
    await nextPage.goto("/dashboard");
    await expect(nextPage).toHaveURL(`${baseURL}/dashboard`);
    await expect(nextPage.getByRole("button", { name: "User menu" })).toBeVisible();
  } finally {
    await reopened.close();
  }
});
