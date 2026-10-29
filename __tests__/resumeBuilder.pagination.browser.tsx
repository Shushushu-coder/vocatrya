// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "@tailwindcss/node";
import { chromium, type Browser } from "@playwright/test";
import { extractText, getDocumentProxy } from "unpdf";
import { ResumePreview } from "@/components/career/resume-variant/ResumePreview";
import { measureResumeFragments } from "@/components/career/resume-variant/ResumePagedPreview";
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
let serial = 0;
const expr = (content: string, hiddenAt: string | null = null) => ({ id: `e-${serial++}`, content, kind: "BULLET", sortOrder: serial, hiddenAt });
const marker = (i: number) => `MKX${String(i).padStart(4, "0")}`;
const item = (expressions: ReturnType<typeof expr>[]) => ({ id: `i-${serial++}`, materialTitleSnapshot: `MKI${String(serial).padStart(4, "0")} 项目 Project`, expressions });
const section = (title: string, items: ReturnType<typeof item>[]) => ({ id: `s-${serial++}`, title: `MKS${String(serial).padStart(4, "0")} ${title}`, items });
const fixtures = [
  { name: "dense-bullets", sections: [section("密集要点", Array.from({ length: 22 }, (_, i) => item(Array.from({ length: 5 }, (_, j) => expr(`${marker(i * 5 + j)} 完成数据分析与开发 Delivered measurable results ${"stable output ".repeat(3)}`)))))] },
  { name: "long-item", sections: [section("超长条目", [item([expr(Array.from({ length: 150 }, (_, i) => `${marker(i)} ${"跨页内容 Chinese English content ".repeat(2)}`).join("\n"))])])] },
  { name: "boundary-title", sections: [section("前一章节", Array.from({ length: 13 }, (_, i) => item([expr(`${marker(i)} One line result`)]))), section("下一节标题", [item([expr(`${marker(100)} First item beneath heading`)])])] },
  { name: "hidden-content", sections: [section("可见", [item([expr(`${marker(0)} visible`), expr("FORBIDDENHIDDEN", new Date().toISOString())])]), { ...section("FORBIDDENSECTION", [item([expr("FORBIDDENCHILD")])]), hiddenAt: new Date().toISOString() }] },
  { name: "mixed-chinese-english", sections: [section("中英文混排 Education", Array.from({ length: 65 }, (_, i) => item([expr(`${marker(i)} 数据科学硕士，开发与优化系统。Research and engineering delivery, with 实际结果与来源追溯。`)])))] },
];
let browser: Browser;
let css: string;
beforeAll(async () => {
  const html = fixtures.map((fixture) => renderToStaticMarkup(<ResumePreview print headerSnapshot={JSON.stringify({ fullName: "张三 Resume Fixture", email: "fixture@example.com" })} sections={fixture.sections} />)).join("");
  const candidates = [...new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))];
  const globalCss = await fs.readFile(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const compiled = await compile(globalCss, { base: path.join(process.cwd(), "src/app"), onDependency: () => {} });
  const font = await fs.readFile(path.join(process.cwd(), "src/app/fonts/Inter-Variable.woff2"));
  css = compiled.build(candidates) + await fs.readFile(path.join(process.cwd(), "src/components/career/resume-variant/ResumePreview.css"), "utf8")
    + `@font-face{font-family:FixtureInter;src:url(data:font/woff2;base64,${font.toString("base64")}) format("woff2");font-weight:100 900;} :root{--font-inter:FixtureInter;} body{font-family:FixtureInter,ui-sans-serif,system-ui,sans-serif;}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); });
it.each(fixtures)("matches PDF pages and every marked text fragment: $name", async (fixture) => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  try {
    const html = renderToStaticMarkup(<ResumePreview print headerSnapshot={JSON.stringify({ fullName: "张三 Resume Fixture", email: "fixture@example.com" })} sections={fixture.sections} />);
    await page.setContent(`<html><head><style>${css}</style></head><body><div id="measure" class="resume-fragment-columns">${html}</div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const root = page.locator("#measure");
    const measurement = await root.evaluate(measureResumeFragments);
    const metrics = await root.evaluate((root) => { const p = root.querySelector("li")!, style = getComputedStyle(p); return { root: root.getBoundingClientRect().toJSON(), font: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, rects: Array.from(p.getClientRects()).map((r) => r.toJSON()) }; });
    const screenMarkers = await root.evaluate((root) => {
      const box = root.getBoundingClientRect(), markers: Record<string, number[]> = {}, blocks: Record<string, string[]> = {};
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) for (const match of walker.currentNode.textContent!.matchAll(/MK[XIS]\d{4}/g)) {
        const range = document.createRange(); range.setStart(walker.currentNode, match.index!); range.setEnd(walker.currentNode, match.index! + match[0].length);
        markers[match[0]] = [...new Set(Array.from(range.getClientRects()).map((r) => Math.max(0, Math.floor((r.left - box.left + .5) / box.width)) + 1))];
      }
      root.querySelectorAll<HTMLElement>("[data-resume-block]").forEach((block) => { blocks[block.dataset.resumeBlock!] = [...block.textContent!.matchAll(/MK[XIS]\d{4}/g)].map((m) => m[0]); });
      return { markers, blocks };
    });
    await page.setContent(`<html><head><style>${css} @page{size:A4 portrait;margin:15mm;}</style></head><body>${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const extracted = await extractText(new Uint8Array(pdf), { mergePages: false });
    const pdfMarkers: Record<string, number[]> = {};
    extracted.text.forEach((text, i) => { for (const m of text.matchAll(/MK[XIS]\d{4}/g)) (pdfMarkers[m[0]] ??= []).push(i + 1); });
    if (measurement.pageCount !== extracted.totalPages || JSON.stringify(screenMarkers.markers) !== JSON.stringify(pdfMarkers)) {
      const out = path.join(process.cwd(), ".tmp/resume-builder"); await fs.mkdir(out, { recursive: true });
      await fs.writeFile(path.join(out, `${fixture.name}-diagnostic.json`), JSON.stringify({ metrics, pdfText: extracted.text[0], pdfContent: (await (await (await getDocumentProxy(new Uint8Array(pdf))).getPage(1)).getTextContent()).items.slice(0,35), measurement, screenMarkers, pdfMarkers }, null, 2));
      await fs.writeFile(path.join(out, `${fixture.name}-actual.pdf`), pdf);
    }
    expect(measurement.pageCount).toBe(extracted.totalPages);
    expect(screenMarkers.markers).toEqual(pdfMarkers);
    for (const [block, markers] of Object.entries(screenMarkers.blocks)) {
      const pages = [...new Set(markers.flatMap((marker) => pdfMarkers[marker] ?? []))].sort((a, b) => a - b);
      if (pages.length) expect(measurement.blocks[block], block).toEqual(pages);
    }
    expect(extracted.text.join("")).not.toContain("FORBIDDEN");
  } finally { await page.close(); }
}, 30_000);
