import { test, expect } from "./fixtures";

test.use({ video: { mode: "on", size: { width: 1440, height: 1000 } } });

test("empty state presence, entry actions, keyboard and container layouts", async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/ai/ollama/tags", route => route.fulfill({ contentType: "application/json", body: "{}" }));
  await page.goto("/dashboard/myjobs");
  await page.getByRole("button", { name: "Open assistant" }).click();
  await page.getByTestId("agent-new-conversation").click();
  const empty = page.getByTestId("agent-empty-state");
  const mark = empty.locator("svg[data-vocatrya-mark]");
  const first = empty.getByRole("button", { name: "Choose a job", exact: true });
  await expect(first).toBeEnabled();
  const dialog = page.getByRole("dialog");
  // Resize the actual panel container while leaving the viewport unchanged.
  await dialog.evaluate(el => { (el as HTMLElement).style.width = "640px"; });
  await expect(mark).toHaveCSS("width", "72px");
  await expect(mark).toHaveCSS("cursor", "default");
  await expect(mark).toHaveAttribute("aria-hidden", "true");
  await expect(first).toHaveCSS("cursor", "pointer");
  for (const dark of [false, true]) {
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
    await expect(dialog).toHaveCSS("background-color", dark ? "rgb(2, 8, 23)" : "rgb(255, 255, 255)");
    await page.mouse.move(10, 10);
    const baseline = await first.evaluate(el => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, border: style.borderColor, color: style.color };
    });
    await first.hover();
    await expect.poll(() => first.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(baseline.background);
    await expect.poll(() => first.evaluate(el => getComputedStyle(el).borderColor)).not.toBe(baseline.border);
    const box = (await first.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(() => first.evaluate(el => getComputedStyle(el).transform)).not.toBe("none");
    await page.mouse.move(10, 10); await page.mouse.up();
    // Focus via a real Tab traversal into the actions, with the decorative logo skipped.
    await page.getByTestId("agent-new-conversation").focus();
    for (let step = 0; step < 12 && !(await first.evaluate(el => el === document.activeElement)); step++) await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await expect(first).toHaveCSS("outline-style", "solid");
    await expect(first).toHaveCSS("outline-width", "2px");
    await page.screenshot({ path: testInfo.outputPath(`empty-${dark ? "dark" : "light"}-wide.png`) });
    await dialog.evaluate(el => { (el as HTMLElement).style.width = "360px"; });
    await expect(mark).toHaveCSS("width", "64px");
    const buttons = await empty.getByRole("button").evaluateAll(els => els.map(el => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, overflow: el.scrollWidth > el.clientWidth };
    }));
    expect(buttons[0].y).toBe(buttons[1].y);
    expect(buttons[2].y).toBe(buttons[3].y);
    expect(buttons[2].y).toBeGreaterThan(buttons[0].y);
    expect(buttons.every(button => !button.overflow)).toBe(true);
    expect(await empty.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`empty-${dark ? "dark" : "light"}-narrow.png`) });
    await dialog.evaluate(el => { (el as HTMLElement).style.width = "640px"; });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  // Twenty seconds of real central Idle with the pointer parked away.
  await page.mouse.move(10, 10);
  const samples = await mark.evaluate(async svg => {
    const samples: { time: number; transforms: string[]; lights: number[] }[] = [];
    const start = performance.now();
    while (performance.now() - start < 20500) {
      samples.push({
        time: performance.now() - start,
        transforms: [...svg.querySelectorAll("[data-fragment]")].map(el => getComputedStyle(el).transform),
        lights: [...svg.querySelectorAll("polygon")].map(el => Number(getComputedStyle(el).opacity)),
      });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return samples;
  });
  for (let second = 0; second < 20; second++) {
    const window = samples.filter(s => s.time >= second * 1000 && s.time < (second + 1) * 1000);
    for (let i = 0; i < 3; i++) {
      expect(new Set(window.map(s => s.transforms[i])).size).toBeGreaterThan(5);
      expect(new Set(window.map(s => s.lights[i])).size).toBeGreaterThan(5);
    }
  }
  await testInfo.attach("continuous-idle-20s", { body: JSON.stringify(samples), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("continuous-idle-light.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const staticState = await mark.evaluate(el => ({
    transforms: [...el.querySelectorAll("[data-fragment]")].map(path => getComputedStyle(path).transform),
    lights: [...el.querySelectorAll("polygon")].map(band => getComputedStyle(band).opacity),
  }));
  expect(staticState.lights).toEqual(["0", "0", "0"]);
  await mark.hover();
  await page.waitForTimeout(500);
  expect(await mark.evaluate(el => ({
    transforms: [...el.querySelectorAll("[data-fragment]")].map(path => getComputedStyle(path).transform),
    lights: [...el.querySelectorAll("polygon")].map(band => getComputedStyle(band).opacity),
  }))).toEqual(staticState);
  // The same three real handlers open the existing context picker.
  for (const name of ["Choose a job", "Choose a resume", "Add context"]) {
    await empty.getByRole("button", { name, exact: true }).click();
    await expect(page.getByText("Jobs", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("Resumes", { exact: true }).last()).toBeVisible();
    await page.keyboard.press("Escape");
  }
  let runtimeCalls = 0;
  await page.route("**/api/ai/chat", async route => {
    runtimeCalls++;
    await route.fulfill({ status: 500, body: "smoke" });
  });
  await empty.getByRole("button", { name: "Add a job posting", exact: true }).click();
  await expect(empty).toHaveCount(0);
  await expect(page.getByText("Happy to add it.", { exact: false })).toBeVisible();
  expect(runtimeCalls).toBe(0);
  await expect(dialog.locator("svg[data-vocatrya-mark][width='26']")).toHaveAttribute("data-state", "idle");
  expect(errors).toEqual([]);
});
