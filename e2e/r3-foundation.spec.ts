import path from "node:path";
import { writeFile } from "node:fs/promises";
import { test, expect } from "./fixtures";

const evidence = process.env.R3_EVIDENCE_DIR!;

test("shared states: keyboard focus, invalid input, Select Escape and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dashboard/questions");
  await page.getByRole("button", { name: "New Question" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.locator("input").first();
  await input.focus();
  await expect(input).toBeFocused();
  const ring = await input.evaluate(el => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe("none");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await input.hover();
  const invalidColors = await input.evaluate(el => {
    const probe = document.createElement("span");
    probe.style.color = "hsl(var(--destructive-text))";
    el.parentElement!.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(el).borderColor, expected };
  });
  expect(invalidColors.actual).toBe(invalidColors.expected);
  expect(await dialog.evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  // Probe the closing-state CSS too: reduced motion unmounts Radix instantly,
  // so a closed real dialog cannot reliably be queried on the next frame.
  const motionStates = await dialog.evaluate(el => {
    const overlay = document.querySelector("div.fixed.inset-0")!;
    return [el, overlay].flatMap(source => ["open", "closed"].map(state => {
      const probe = document.createElement("div");
      probe.className = source.getAttribute("class") ?? "";
      probe.dataset.state = state;
      document.body.append(probe);
      const animation = getComputedStyle(probe).animationName;
      probe.remove();
      return animation;
    }));
  });
  expect(motionStates).toEqual(["none", "none", "none", "none"]);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  await page.goto("/dashboard/settings");
  await page.getByRole("button", { name: "General", exact: true }).click();
  const select = page.getByTestId("settings-language-select");
  await select.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await expect(select).toBeFocused();
  // Synthetic attribute probes exercise shared Select CSS without inventing
  // a language-preference validation failure in the product.
  await select.evaluate(el => el.setAttribute("aria-invalid", "true"));
  await select.hover();
  const selectColors = await select.evaluate(el => {
    const probe = document.createElement("span");
    probe.style.color = "hsl(var(--destructive-text))";
    el.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(el).borderColor, expected };
  });
  expect(selectColors.actual).toBe(selectColors.expected);
  await select.evaluate(el => el.removeAttribute("aria-invalid"));
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(page.getByRole("option", { name: "简体中文" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(select).toContainText("简体中文");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

test("representative pages: both themes at 1440, 1024, 768 and 390", async ({ page }) => {
  test.setTimeout(180_000);
  const metrics = [];
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ["dashboard", "dashboard/myjobs", "dashboard/questions", "dashboard/admin", "dashboard/settings"]) {
        await page.goto(`/${route}`);
        if (route.endsWith("settings")) {
          await page.getByRole("button", { name: "General", exact: true }).click();
        }
        await expect(page.getByTestId("loader")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await expect(page.locator("html")).toHaveClass(new RegExp(theme));
        const metric = await page.evaluate(() => {
          const overlay = document.createElement("div");
          overlay.style.backgroundColor = "var(--overlay-bg)";
          document.body.append(overlay);
          const overlayColor = getComputedStyle(overlay).backgroundColor;
          overlay.remove();
          return {
          viewport: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          background: getComputedStyle(document.body).backgroundColor,
          foreground: getComputedStyle(document.body).color,
          ring: getComputedStyle(document.body).getPropertyValue("--ring").trim(),
          overlay: overlayColor,
        };
        });
        expect(metric.background).not.toBe(metric.foreground);
        expect(metric.overlay).toBe(theme === "light" ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.5)");
        metrics.push({ theme, width, route, ...metric });
        await page.screenshot({ path: path.join(evidence, `${route.replaceAll("/", "-")}-${theme}-${width}.png`), fullPage: true });
      }
    }
  }
  await writeFile(path.join(evidence, "responsive-metrics.json"), JSON.stringify(metrics, null, 2));
});

test("semantic text and focus colors retain contrast in both themes", async ({ page }) => {
  const results = [];
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/dashboard/questions");
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    const ratios = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      function luminance(color: string) {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      }
      function token(name: string) {
        probe.style.color = `hsl(var(--${name}))`;
        return luminance(getComputedStyle(probe).color);
      }
      function ratio(a: number, b: number) {
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      }
      const background = token("background");
      const values = Object.fromEntries(["foreground", "muted-foreground", "destructive-text", "success", "warning", "ring"].map(name => [name, ratio(token(name), background)]));
      values["primary-action"] = ratio(token("primary"), token("primary-foreground"));
      values["destructive-action"] = ratio(token("destructive"), token("destructive-foreground"));
      probe.remove();
      return values;
    });
    for (const [name, ratio] of Object.entries(ratios)) {
      expect(ratio, `${theme} ${name}`).toBeGreaterThanOrEqual(name === "ring" ? 3 : 4.5);
    }
    results.push({ theme, ratios });
  }
  await writeFile(path.join(evidence, "contrast-metrics.json"), JSON.stringify(results, null, 2));
});
