import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { masterPaths } from "../src/components/brand/geometry";

test.use({ video: { mode: "on", size: { width: 960, height: 640 } } });

test("central controller keeps phases through thinking, completion and interruption", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.setContent(`<style>
    :root { --foreground: 222.2 84% 4.9%; --muted-foreground: 215.4 16.3% 46.9%; }
    body { margin:0; display:grid; place-items:center; height:100vh; background:white; font:14px sans-serif; color:#64748b; }
    main { display:flex; align-items:center; flex-direction:column; gap:24px; }
    svg { width:72px; height:72px; fill:hsl(var(--foreground)); cursor:default; }
    path,g,polygon { transform-box:view-box; transform-origin:0 0; }
  </style><main><svg viewBox="0 0 144 144"><g transform="translate(-9 -16)">${masterPaths.map(d => `<path data-fragment="" d="${d}"/>`).join("")}</g></svg>
  <p>Central A1.5 · controller transition review</p></main>`);
  const source = readFileSync("src/components/agent/empty-state-motion.ts", "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 } }).outputText;
  await page.addScriptTag({ content: `(() => { const exports = {}; ${compiled}
    window.presence = exports.mountEmptyStateMotion(document.querySelector("svg"), "review");
  })();` });
  const mark = page.locator("svg");
  const positions = () => mark.locator("[data-fragment]").evaluateAll(els => els.map(el => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return [m.e, m.f];
  }));
  await page.mouse.move(0, 0);
  const before = await positions();
  await page.waitForTimeout(1200);
  const after = await positions();
  expect(after.every((p, i) => Math.hypot(p[0] - before[i][0], p[1] - before[i][1]) > .3)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("idle.png") });
  await page.evaluate(() => (window as unknown as { presence: { setState(s: string): void } }).presence.setState("thinking"));
  await page.waitForTimeout(1800);
  await page.screenshot({ path: testInfo.outputPath("thinking.png") });
  await page.waitForTimeout(3200);
  const completion = await mark.evaluate(async svg => {
    (window as unknown as { presence: { setState(s: string): void } }).presence.setState("complete");
    const start = performance.now();
    const samples: { t: number; distances: number[] }[] = [];
    while (performance.now() - start < 900) {
      await new Promise(requestAnimationFrame);
      samples.push({ t: performance.now() - start, distances: [...svg.querySelectorAll("[data-fragment]")].map(el => {
        const m = new DOMMatrix(getComputedStyle(el).transform);
        return Math.hypot(m.e, m.f);
      }) });
    }
    return samples;
  });
  expect(completion.some(s => s.t >= 330 && s.t <= 470 && s.distances.every(d => d > 6.5))).toBe(true);
  expect(completion.filter(s => s.t >= 720).every(s => s.distances.every(d => d < 4.7))).toBe(true);
  await testInfo.attach("completion-frames", { body: JSON.stringify(completion), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("complete-return.png") });
  const idle = await positions();
  idle.forEach(p => expect(Math.hypot(...p)).toBeLessThan(4.7));
  await page.waitForTimeout(1500);
  expect(await positions()).not.toEqual(idle);
  await page.evaluate(() => (window as unknown as { presence: { setState(s: string): void } }).presence.setState("thinking"));
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { presence: { setState(s: string): void } }).presence.setState("complete"));
  await page.waitForTimeout(350);
  const interrupted = await positions();
  await page.evaluate(() => (window as unknown as { presence: { setState(s: string): void } }).presence.setState("thinking"));
  const next = await positions();
  next.forEach((p, i) => expect(Math.hypot(p[0] - interrupted[i][0], p[1] - interrupted[i][1])).toBeLessThan(.5));
  await page.waitForTimeout(2000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(positions).toEqual([[0, 0], [0, 0], [0, 0]]);
  await expect.poll(() => mark.locator("polygon").evaluateAll(els => els.map(el => getComputedStyle(el).opacity))).toEqual(["0", "0", "0"]);
  await page.screenshot({ path: testInfo.outputPath("reduced-motion.png") });
  await page.waitForTimeout(1000);
});
