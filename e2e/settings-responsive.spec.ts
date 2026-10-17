import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const evidence = process.env.R3_EVIDENCE_DIR!;

type Measure = {
  viewport: number;
  scrollWidth: number;
  overflow: number;
  sideBySide: boolean;
  navWidth: number;
  selectWidth: number;
  selectRight: number;
  selectInside: boolean;
  valueTruncated: boolean;
  clipped: boolean;
  htmlOverflowX: string;
  bodyOverflowX: string;
  lang: string;
  offenders: string[];
};

async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    const select = document.querySelector<HTMLElement>("[data-testid='settings-language-select']");
    const nav = document.querySelector<HTMLElement>("main nav");
    const panel = nav?.nextElementSibling instanceof HTMLElement ? nav.nextElementSibling : null;
    const selectRect = select?.getBoundingClientRect();
    const navRect = nav?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    const value = select?.querySelector("span");
    let clipped = false;
    if (select && selectRect) {
      let node = select.parentElement;
      while (node) {
        const overflow = getComputedStyle(node).overflowX;
        if ((overflow === "hidden" || overflow === "clip") && selectRect.right > node.getBoundingClientRect().right + 1) {
          clipped = true;
          break;
        }
        node = node.parentElement;
      }
    }
    const offenders: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.right > viewport + 1 || rect.left < -1) {
        const id = el.getAttribute("data-testid");
        offenders.push(id ? `${el.tagName}#${id}` : el.tagName);
        if (offenders.length >= 8) break;
      }
    }
    return {
      viewport,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: document.documentElement.scrollWidth - viewport,
      sideBySide: Boolean(
        navRect && panelRect && navRect.right <= panelRect.left + 1 && Math.abs(navRect.top - panelRect.top) < 12,
      ),
      navWidth: navRect ? Math.round(navRect.width) : 0,
      selectWidth: selectRect ? Math.round(selectRect.width) : 0,
      selectRight: selectRect ? Math.round(selectRect.right) : 0,
      selectInside: Boolean(selectRect && selectRect.left >= -1 && selectRect.right <= viewport + 1 && selectRect.width > 0),
      valueTruncated: Boolean(value && value.scrollWidth > value.clientWidth + 1),
      clipped,
      htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
      lang: document.documentElement.lang,
      offenders,
    };
  });
}

async function openGeneral(page: Page) {
  await page.goto("/dashboard/settings");
  const general = page.locator("main nav").getByRole("button", { name: /^(General|常规偏好)$/ });
  await general.click();
  await expect(page.getByTestId("settings-language-select")).toBeVisible();
}

function expectContained(metric: Measure) {
  expect(metric.scrollWidth, `scrollWidth ${metric.scrollWidth} at ${metric.viewport}`).toBeLessThanOrEqual(metric.viewport);
  expect(metric.offenders, metric.offenders.join(",")).toEqual([]);
  expect(metric.selectInside).toBe(true);
  expect(metric.valueTruncated).toBe(false);
  expect(metric.clipped).toBe(false);
  expect(metric.htmlOverflowX).not.toBe("hidden");
  expect(metric.bodyOverflowX).not.toBe("hidden");
  expect(metric.selectWidth).toBeLessThanOrEqual(224);
  expect(metric.selectRight).toBeLessThanOrEqual(metric.viewport);
}

test("settings general has no page overflow and keeps the desktop nav", async ({ page }) => {
  test.setTimeout(180_000);
  const rows: Array<Record<string, unknown>> = [];
  const widths = [360, 390, 430, 640, 720, 768, 1024, 1440];
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await openGeneral(page);
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      const metric = await measure(page);
      expectContained(metric);
      if (width <= 640) {
        expect(metric.sideBySide, `${width} should stack`).toBe(false);
        expect(metric.navWidth).toBeGreaterThan(280);
      }
      if (width >= 768) {
        expect(metric.sideBySide, `${width} should keep the side nav`).toBe(true);
        expect(metric.navWidth).toBeGreaterThanOrEqual(190);
        expect(metric.navWidth).toBeLessThanOrEqual(196);
        expect(metric.selectWidth).toBeGreaterThanOrEqual(220);
      }
      rows.push({ theme, locale: "en", width, ...metric });
    }
  }

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await openGeneral(page);
      await page.getByTestId("settings-language-select").click();
      await page.getByRole("option", { name: "简体中文" }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
      await expect(page.locator("main nav").getByRole("button", { name: "常规偏好" })).toBeVisible();
      await expect(page.getByText("选择界面的默认显示语言")).toBeVisible();
      const metric = await measure(page);
      expectContained(metric);
      if (width === 390) expect(metric.sideBySide).toBe(false);
      if (width >= 768) expect(metric.sideBySide).toBe(true);
      rows.push({ theme, locale: "zh-CN", width, ...metric });
      await page.getByTestId("settings-language-select").click();
      await page.getByRole("option", { name: "English" }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
    }
  }

  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, "settings-responsive-metrics.json"), JSON.stringify(rows, null, 2));
});

test("settings sections share the narrow layout without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/dashboard/settings");
  const sections = [
    { name: "General", heading: "General" },
    { name: "AI Provider", heading: "Vocatrya Managed AI" },
    { name: "Appearance", heading: "Appearance" },
    { name: "MCP Access", heading: "MCP Endpoint" },
    { name: "Data", heading: "Export your data" },
  ];
  for (const section of sections) {
    await page.locator("main nav").getByRole("button", { name: section.name, exact: true }).click();
    await expect(page.getByRole("heading", { name: section.heading, exact: true }).last()).toBeVisible();
    const metric = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(metric.scrollWidth, section.name).toBeLessThanOrEqual(metric.viewport);
  }
});

test("settings nav and language select stay keyboard accessible", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await openGeneral(page);
    const nav = page.locator("main nav");
    const names = ["General", "AI Provider", "Appearance", "MCP Access", "Data"];
    await nav.getByRole("button", { name: "General", exact: true }).focus();
    for (const name of names) {
      await expect(nav.getByRole("button", { name, exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
    }
    const select = page.getByTestId("settings-language-select");
    await expect(select).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const box = await listbox.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await page.keyboard.press("Escape");
    await expect(listbox).toBeHidden();
    await expect(select).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    await expect(page.getByRole("option", { name: "简体中文" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(select).toContainText("简体中文");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await nav.getByRole("button", { name: "常规偏好", exact: true }).click();
    await expect(page.getByTestId("settings-language-select")).toContainText("简体中文");
    await page.getByTestId("settings-language-select").click();
    await page.getByRole("option", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.reload();
    await nav.getByRole("button", { name: "General", exact: true }).click();
    await expect(page.getByTestId("settings-language-select")).toContainText("English");
  }
});
