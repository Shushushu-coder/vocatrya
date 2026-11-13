import { expect } from "@playwright/test";

export async function assertDesktopSurface(page) {
  await expect(page.locator('html[data-desktop="true"]')).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      Boolean(window.vocatryaWindow && window.vocatryaDesktop?.quit),
    ),
  ).toBe(true);
  await expect(page.getByTestId("desktop-titlebar")).toBeVisible();
}

export async function register(page, origin, identity) {
  await page
    .context()
    .addCookies([{ name: "vocatrya_locale", value: "zh-CN", url: origin }]);
  await page.goto(`${origin}/signup`);
  await assertDesktopSurface(page);
  await page
    .getByRole("textbox", { name: "姓名", exact: true })
    .fill(identity.name);
  await page
    .getByRole("textbox", { name: "电子邮箱", exact: true })
    .fill(identity.email);
  await page
    .getByRole("textbox", { name: "密码", exact: true })
    .fill(identity.password);
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/dashboard`);
  await expect(
    page
      .getByRole("complementary")
      .getByRole("button", { name: "用户菜单", exact: true }),
  ).toContainText(identity.email);
  console.log("PASS Chinese signup and automatic login");
}

export async function checkNavigation(page, origin) {
  await assertDesktopSurface(page);
  const titlebar = page.getByTestId("desktop-titlebar");
  await expect(titlebar.getByTestId("header-create-menu")).toBeVisible();
  await expect(page.getByTestId("header-upload")).toHaveCount(0);
  await expect(page.locator(".header-global-actions")).toBeHidden();
  await titlebar.getByTestId("header-create-menu").click();
  await expect(page.getByRole("menuitem").first()).toBeVisible();
  await page.keyboard.press("Escape");
  console.log(
    "PASS desktop titlebar owns create actions and has no upload entry",
  );

  const sidebar = page.getByRole("complementary");
  const expectedRoutes = [
    "/dashboard",
    "/dashboard/analytics",
    "/dashboard/myjobs",
    "/dashboard/tasks",
    "/dashboard/questions",
    "/dashboard/extensions",
    "/dashboard/profile",
    "/dashboard/admin",
    "/dashboard/settings",
  ];
  await expect(sidebar.getByRole("link")).toHaveCount(expectedRoutes.length);
  const links = await sidebar.getByRole("link").evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.textContent.trim(),
      href: node.getAttribute("href"),
    })),
  );
  expect(links.map((item) => item.href).sort()).toEqual(
    [...expectedRoutes].sort(),
  );
  const errors = [];
  const onError = (error) => errors.push(error.message);
  const onResponse = (response) => {
    if (response.url().startsWith(`${origin}/`) && response.status() >= 400)
      errors.push(
        `HTTP ${response.status()} ${new URL(response.url()).pathname}`,
      );
  };
  page.on("pageerror", onError);
  page.on("response", onResponse);
  try {
    for (const { name, href } of links) {
      await sidebar.getByRole("link", { name, exact: true }).click();
      await expect
        .poll(() => {
          const pathname = new URL(page.url()).pathname;
          return (
            pathname === href ||
            (href !== "/dashboard" && pathname.startsWith(`${href}/`))
          );
        })
        .toBe(true);
      const main = page.getByRole("main");
      await expect(main).toBeVisible();
      await expect(main).not.toHaveText(/^\s*$/);
      await expect(
        main.getByText(/^(正在加载.*|加载中.*|Loading.*)$/),
      ).toHaveCount(0);
      await expect(main).not.toContainText(
        /Application error|Internal Server Error|This page could not be found/,
      );
      await expect(page).toHaveTitle(/Vocatrya/);
      console.log(`PASS sidebar ${name} (${new URL(page.url()).pathname})`);
    }
    expect(errors, "page exceptions and local HTTP errors").toEqual([]);
  } finally {
    page.off("pageerror", onError);
    page.off("response", onResponse);
  }
  await sidebar
    .getByRole("button", { name: "收起侧边栏", exact: true })
    .click();
  await sidebar
    .getByRole("button", { name: "展开侧边栏", exact: true })
    .click();
  await expect(
    sidebar.getByRole("button", { name: "收起侧边栏", exact: true }),
  ).toBeVisible();
  console.log("PASS sidebar collapse/expand");
}

export async function checkReopen(page, origin, identity) {
  await page.goto(`${origin}/dashboard/settings`);
  await assertDesktopSurface(page);
  await expect(page).toHaveURL(`${origin}/dashboard/settings`);
  await expect(
    page
      .getByRole("complementary")
      .getByRole("button", { name: "用户菜单", exact: true }),
  ).toContainText(identity.email);
  await expect(page.getByRole("main")).toContainText("显示语言");
  console.log(
    "PASS authenticated account/settings after real application restart",
  );
}
