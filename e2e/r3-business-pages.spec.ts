import path from "node:path";
import { writeFile } from "node:fs/promises";
import { test, expect } from "./fixtures";

const evidence = process.env.R3_EVIDENCE_DIR!;
const routes = ["dashboard", "dashboard/myjobs", "dashboard/admin"] as const;
const widths = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
] as const;

test("business pages keep the page from scrolling sideways", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const metrics = [];
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const viewport of widths) {
      await page.setViewportSize(viewport);
      for (const route of routes) {
        await page.goto(`/${route}`);
        await expect(page.getByTestId("loader")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const metric = await page.evaluate(() => {
          const main = document.querySelector("main");
          return {
            viewport: innerWidth,
            clientWidth: main?.clientWidth ?? 0,
            scrollWidth: main?.scrollWidth ?? 0,
            documentClientWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
          };
        });
        expect(metric.scrollWidth).toBeLessThanOrEqual(metric.clientWidth + 1);
        metrics.push({ theme, route, ...viewport, ...metric });
        await page.screenshot({
          path: path.join(
            evidence,
            `${route.replaceAll("/", "-")}-${theme}-${viewport.width}.png`,
          ),
          fullPage: true,
        });
      }
    }
  }

  await page.context().addCookies([
    { name: "vocatrya_locale", value: "zh-CN", url: baseURL },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "近 7 天" })).toBeVisible();
  await page.goto("/dashboard/myjobs");
  await expect(page.getByRole("button", { name: "新建职位" })).toBeVisible();
  await page.goto("/dashboard/admin");
  await expect(page.getByRole("tab", { name: "公司" })).toBeVisible();
  await page.screenshot({
    path: path.join(evidence, "admin-zh-CN-390.png"),
    fullPage: true,
  });

  await page.goto("/dashboard/myjobs");
  const newJob = page.getByRole("button", { name: "新建职位" });
  await newJob.focus();
  await expect(newJob).toBeFocused();

  await writeFile(
    path.join(evidence, "business-page-metrics.json"),
    JSON.stringify(metrics, null, 2),
  );
});
