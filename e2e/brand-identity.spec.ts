import { test, expect } from "./fixtures";
import fs from "node:fs";
import { masterPaths } from "../src/components/brand/geometry";

test("A1.5 static identity and contextual motion across repeated, failed and switched turns", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard/myjobs");
  const sidebar = page.locator("aside svg[data-vocatrya-mark]");
  await expect(sidebar).toHaveAttribute("data-animated", "false");
  await expect(sidebar).toHaveAttribute("width", "24");
  const existingToggle = page.locator("header").getByRole("button", { name: /sidebar/i });
  if (await existingToggle.getAttribute("aria-expanded") === "true") {
    await existingToggle.click();
    await expect(existingToggle).toHaveAttribute("aria-expanded", "false");
  }
  await existingToggle.click();
  await expect(existingToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("aside").first()).toHaveCSS("width", "224px");
  const logoToggle = page.locator("aside button[aria-controls]");
  await logoToggle.click();
  await expect(page.locator("aside").first()).toHaveCSS("width", "56px");
  await logoToggle.press("Enter");
  await expect(page.locator("aside").first()).toHaveCSS("width", "224px");
  await logoToggle.press("Space");
  await expect(page.locator("aside").first()).toHaveCSS("width", "56px");
  await logoToggle.click();
  await page.screenshot({ path: testInfo.outputPath("sidebar-light.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(sidebar).toHaveCSS("color", "rgb(248, 250, 252)");
  await page.screenshot({ path: testInfo.outputPath("sidebar-dark.png") });
  await expect(sidebar).toHaveCSS("fill", await sidebar.evaluate(el => getComputedStyle(el).color));
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await expect(sidebar).toHaveCSS("color", "rgb(2, 8, 23)");
  await page.route("**/api/ai/ollama/tags", route => route.fulfill({ contentType: "application/json", body: "{}" }));
  await page.getByRole("button", { name: "Open assistant" }).click();
  await page.getByTestId("agent-new-conversation").click();
  const header = page.getByRole("dialog").locator("svg[data-vocatrya-mark][width='26']");
  const welcome = page.getByTestId("agent-empty-state").locator("svg[data-vocatrya-mark]");
  await expect(header).toHaveAttribute("data-animated", "false");
  await expect(welcome).toHaveAttribute("data-state", "idle");
  await page.screenshot({ path: testInfo.outputPath("ai-empty.png") });
  const markBox = await welcome.boundingBox();
  const emptyBox = await page.getByTestId("agent-empty-state").boundingBox();
  expect(Math.abs(markBox!.x + markBox!.width / 2 - emptyBox!.x - emptyBox!.width / 2)).toBeLessThan(2);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(page.getByRole("dialog")).toHaveCSS("background-color", "rgb(2, 8, 23)");
  await expect(welcome).toHaveCSS("color", "rgb(248, 250, 252)");
  await page.screenshot({ path: testInfo.outputPath("ai-empty-dark.png") });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await expect(page.getByRole("dialog")).toHaveCSS("background-color", "rgb(255, 255, 255)");

  let release: (() => void) | undefined;
  let fail = false;
  await page.route("**/api/ai/chat", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    if (fail) { await route.fulfill({ status: 500, body: "Generation failed" }); return; }
    const chunks = [
      { type: "start" }, { type: "start-step" }, { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Brand acceptance response" },
      { type: "text-end", id: "t1" }, { type: "finish-step" }, { type: "finish" },
    ];
    await route.fulfill({ headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" }, body: chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
  });
  const box = page.getByRole("textbox", { name: /paste a job posting/i });
  for (let turn = 0; turn < 2; turn++) {
    await box.fill(`Brand acceptance ${turn}`);
    await expect(header).toHaveAttribute("data-state", "idle");
    if (turn === 0) {
      await expect(welcome).toHaveAttribute("data-state", "idle");
      await expect(header).toHaveAttribute("data-animated", "false");
    }
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(header).toHaveAttribute("data-state", "thinking");
    await expect(welcome).toHaveCount(0);
    await expect.poll(() => header.locator("path").evaluateAll(paths => paths.some(p => (p as SVGElement).style.fill.startsWith("url")))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`thinking-${turn}.png`) });
    await expect.poll(() => Boolean(release)).toBe(true);
    release!(); release = undefined;
    await expect(header).toHaveAttribute("data-state", "complete");
    await page.screenshot({ path: testInfo.outputPath(`complete-${turn}.png`) });
    await expect(header).toHaveAttribute("data-state", "idle");
  }
  fail = true;
  await box.fill("Failure acceptance");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(header).toHaveAttribute("data-state", "thinking");
  await expect.poll(() => Boolean(release)).toBe(true);
  release!(); release = undefined;
  await expect(header).toHaveAttribute("data-state", "idle");
  await page.getByTestId("agent-new-conversation").click();
  await expect(welcome).toBeVisible();
  await expect(header).toHaveAttribute("data-state", "idle");
  await page.getByTestId("agent-history").click();
  // Selecting existing history must not replay completion.
  const historyItem = page.getByRole("dialog").locator("li button").filter({ hasText: "Brand acceptance 0" }).first();
  await expect(historyItem).toBeVisible();
  await historyItem.click();
  await expect(header).toHaveAttribute("data-state", "idle");
});

test("reduced motion keeps AI marks static while requests are pending", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/ai/ollama/tags", route => route.fulfill({ contentType: "application/json", body: "{}" }));
  await page.goto("/dashboard/myjobs");
  await page.getByRole("button", { name: "Open assistant" }).click();
  await page.getByTestId("agent-new-conversation").click();
  const central = page.getByTestId("agent-empty-state").locator("svg");
  const fragments = central.locator("[data-fragment]");
  await expect(fragments).toHaveCount(3);
  await expect.poll(() => fragments.evaluateAll(paths => paths.every(p => new DOMMatrix(getComputedStyle(p).transform).isIdentity && !(p as SVGElement).style.fill))).toBe(true);
  await expect(central.locator("polygon")).toHaveCount(3);
  await expect.poll(() => central.locator("polygon").evaluateAll(bands => bands.map(band => getComputedStyle(band).opacity))).toEqual(["0", "0", "0"]);
  let release: (() => void) | undefined;
  await page.route("**/api/ai/chat", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 500, body: "Failed" });
  });
  await page.getByRole("textbox", { name: /paste a job posting/i }).fill("Reduced motion acceptance");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const header = page.getByRole("dialog").locator("svg[data-vocatrya-mark][width='26']");
  await expect(header).toHaveAttribute("data-state", "thinking");
  await expect.poll(() => header.locator("path").evaluateAll(paths => paths.every(p => getComputedStyle(p).transform === "none" && !(p as SVGElement).style.fill))).toBe(true);
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await expect(header).toHaveAttribute("data-state", "idle");
});

test("approved motion handles rapid interruption, replay, actual sizes and cleanup", async ({ page }) => {
  const source = fs.readFileSync("src/components/brand/motion.js", "utf8");
  const samples = await page.evaluate(async ({ source, paths }) => {
    const mount = new Function(source.replace("export function", "function") + ";return mountVocatryaMotion;")();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 144 144");
    svg.setAttribute("fill", "currentColor");
    svg.innerHTML = `<g transform="translate(-9 -16)">${paths.map(d => `<path d="${d}"/>`).join("")}</g>`;
    document.body.append(svg);
    const results = [];
    for (const size of [16,24,26,32,48,64]) {
      svg.style.width = `${size}px`; svg.style.height = `${size}px`;
      const motion = mount(svg, `size-${size}`, "thinking");
      await new Promise(resolve => setTimeout(resolve, 350));
      results.push({size, moving:[...svg.querySelectorAll("path")].some(p=>p.style.transform), light:[...svg.querySelectorAll("path")].some(p=>p.style.fill.startsWith("url"))});
      motion.setState("complete");
      await new Promise(resolve => setTimeout(resolve, 100));
      motion.setState("thinking");
      await new Promise(resolve => setTimeout(resolve, 100));
      motion.setState("complete");
      await new Promise(resolve => setTimeout(resolve, 750));
      results.push({size, settled:[...svg.querySelectorAll("path")].every(p=>!p.style.transform && !p.style.fill), state:svg.dataset.state});
      motion.dispose();
      if (svg.querySelector("defs")) throw new Error("Leaked motion gradients");
    }
    svg.remove();
    return results;
  }, {source, paths:masterPaths});
  expect(samples[0]).toMatchObject({size:16, moving:false, light:false});
  for (const size of [24,26,32,48,64]) {
    expect(samples.find(s=>s.size===size && "moving" in s)).toMatchObject({moving:true, light:true});
  }
  for (const sample of samples.filter(s=>"settled" in s)) expect(sample).toMatchObject({settled:true});
});
