import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const evidence = process.env.R3_EVIDENCE_DIR!;

// Settings V1 layout contract, measured in Chromium against this build
// (probe: .wave1-runtime/evidence/int01-measure/int01-measure.json):
//   - `<main>` is the query container (@container/main); its content box is
//     32px narrower than the element because of p-4.
//   - `@md/main` = 28rem = 448px of *container* width. At/above it the
//     settings nav is a fixed w-56 (224px) side rail; below it the four
//     groups wrap into full-width rows.
//   - The app sidebar (224px + 16px margin) is hidden below the sm viewport
//     breakpoint, so container width is non-monotonic in viewport width:
//     measured side-by-side at 480-639px and >=720px, stacked elsewhere.
const NAV = '[data-testid="settings-nav"]';
const MD_MAIN_CONTAINER = 448;
const SIDE_NAV_WIDTH = 224;

const SECTION_GROUPS: { label: string; entries: string[] }[] = [
  { label: "Preferences", entries: ["General", "Notifications", "Appearance"] },
  { label: "AI Configuration", entries: ["AI Services", "AI Assignments"] },
  { label: "Devices & Input", entries: ["Shortcuts", "Audio"] },
  { label: "Data & Support", entries: ["Data & Privacy", "About"] },
];
const SECTION_NAMES = SECTION_GROUPS.flatMap((group) => group.entries);

type Measure = {
  viewport: number;
  containerWidth: number;
  sidebarVisible: boolean;
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
    const main = document.querySelector<HTMLElement>("main");
    const nav = document.querySelector<HTMLElement>("[data-testid='settings-nav']");
    const aside = document.getElementById("app-sidebar");
    const panel = nav?.nextElementSibling instanceof HTMLElement ? nav.nextElementSibling : null;
    const selectRect = select?.getBoundingClientRect();
    const navRect = nav?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    const mainStyle = main ? getComputedStyle(main) : null;
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
      containerWidth: main && mainStyle
        ? Math.round(main.clientWidth - parseFloat(mainStyle.paddingLeft) - parseFloat(mainStyle.paddingRight))
        : 0,
      sidebarVisible: aside ? getComputedStyle(aside).display !== "none" : false,
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
  const general = page.locator(NAV).getByRole("button", { name: /^(General|常规偏好)$/ });
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
  // The select is intrinsically w-56; its measured shrink-wrap floor is
  // 200px at the tightest side-by-side container (448px).
  expect(metric.selectWidth).toBeGreaterThanOrEqual(200);
  expect(metric.selectWidth).toBeLessThanOrEqual(224);
  expect(metric.selectRight).toBeLessThanOrEqual(metric.viewport);
}

// The layout contract is keyed on the measured container content box, never
// the viewport: side-by-side iff container >= @md/main (448px); the side nav
// is then exactly w-56; stacked it spans the full container (w-full).
function expectLayoutContract(metric: Measure) {
  const expectSideBySide = metric.containerWidth >= MD_MAIN_CONTAINER;
  expect(
    metric.sideBySide,
    `viewport ${metric.viewport} container ${metric.containerWidth}`,
  ).toBe(expectSideBySide);
  if (expectSideBySide) {
    expect(metric.navWidth).toBeGreaterThanOrEqual(SIDE_NAV_WIDTH - 1);
    expect(metric.navWidth).toBeLessThanOrEqual(SIDE_NAV_WIDTH + 1);
  } else {
    expect(metric.navWidth).toBeGreaterThanOrEqual(metric.containerWidth - 1);
    expect(metric.navWidth).toBeLessThanOrEqual(metric.containerWidth);
  }
}

test("settings general has no page overflow and follows the container nav contract", async ({ page }) => {
  test.setTimeout(240_000);
  const rows: Array<Record<string, unknown>> = [];
  // Widths bracket both structural breakpoints: the container threshold
  // crossings at ~480 (sidebar hidden) and ~720 (sidebar docked), and the
  // sidebar's own sm=640px appearance.
  const widths = [360, 390, 430, 479, 480, 639, 640, 719, 720, 768, 1024, 1440];
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await openGeneral(page);
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      const metric = await measure(page);
      expectContained(metric);
      expectLayoutContract(metric);
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
      await expect(page.locator(NAV).getByRole("button", { name: "常规偏好" })).toBeVisible();
      await expect(page.getByText("选择界面的默认显示语言")).toBeVisible();
      const metric = await measure(page);
      expectContained(metric);
      expectLayoutContract(metric);
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
  const nav = page.locator(NAV);

  // Four frozen groups in order, each holding its declared entries.
  const groups = nav.getByRole("group");
  await expect(groups).toHaveCount(SECTION_GROUPS.length);
  for (const [index, group] of SECTION_GROUPS.entries()) {
    const el = groups.nth(index);
    await expect(el).toHaveAttribute("aria-label", group.label);
    for (const entry of group.entries) {
      await expect(el.getByRole("button", { name: entry, exact: true })).toBeVisible();
    }
  }

  // Every entry navigates to its own page; absent owners render the honest
  // unavailable placeholder, and the MCP compat sub-area lives inside
  // Data & Privacy (legacy family on this harness).
  const sections = [
    { name: "General", heading: "General", unavailable: false },
    { name: "Notifications", heading: "Notifications", unavailable: false },
    { name: "Appearance", heading: "Appearance", unavailable: false },
    { name: "AI Services", heading: "AI Services", unavailable: false },
    { name: "AI Assignments", heading: "AI Assignments", unavailable: false },
    { name: "Shortcuts", heading: "Shortcuts", unavailable: false },
    { name: "Audio", heading: "Audio", unavailable: false },
    { name: "Data & Privacy", heading: "Data & Privacy", unavailable: false },
    { name: "About", heading: "About", unavailable: true },
  ];
  for (const section of sections) {
    await nav.getByRole("button", { name: section.name, exact: true }).click();
    await expect(page.getByRole("heading", { name: section.heading, exact: true }).last()).toBeVisible();
    if (section.unavailable) {
      await expect(page.getByTestId("settings-section-unavailable")).toBeVisible();
    }
    const metric = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(metric.scrollWidth, section.name).toBeLessThanOrEqual(metric.viewport);
  }

  // The legacy MCP surface is a compat sub-area inside Data & Privacy, not a
  // nav entry — assert its real headings where the contract mounts it.
  await nav.getByRole("button", { name: "Data & Privacy", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Export your data", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "MCP Endpoint", exact: true })).toBeVisible();
});

test("settings hash deep links and section switching work", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const nav = page.locator(NAV);

  // Plain load lands on General and marks it current.
  await page.goto("/dashboard/settings");
  await expect(page.getByTestId("settings-language-select")).toBeVisible();
  await expect(nav.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-current", "true");

  // #<id> deep links mount their section directly.
  await page.goto("/dashboard/settings#audio");
  await expect(page.getByTestId("settings-section-audio")).toBeVisible();
  await expect(nav.getByRole("button", { name: "Audio", exact: true })).toHaveAttribute("aria-current", "true");

  // User switching writes the hash post-commit so reloads land on the page.
  await nav.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByTestId("settings-section-appearance")).toBeVisible();
  await expect(page).toHaveURL(/#appearance$/);
  await page.reload();
  await expect(page.getByTestId("settings-section-appearance")).toBeVisible();

  // ?section=<id> deep links resolve the same way (and take precedence over
  // a stale hash per readSectionFromLocation — query first, then hash).
  await page.goto("/dashboard/settings?section=ai-services");
  await expect(page.getByTestId("settings-section-ai-services")).toBeVisible();
  await expect(nav.getByRole("button", { name: "AI Services", exact: true })).toHaveAttribute("aria-current", "true");
});

test("settings nav and language select stay keyboard accessible", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await openGeneral(page);
    const nav = page.locator(NAV);
    await nav.getByRole("button", { name: "General", exact: true }).focus();
    for (const name of SECTION_NAMES) {
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
