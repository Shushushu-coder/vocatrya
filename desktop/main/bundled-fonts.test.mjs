import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateNotices } from "../scripts/generate-notices.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-notices-"));
  const write = (rel, content) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  };
  write("LICENSE", "fixture license");
  write(path.join("node_modules", "electron", "LICENSE"), "electron license");
  write(path.join("node_modules", "prisma", "LICENSE"), "prisma license");
  write(path.join("node_modules", "sharp", "LICENSE"), "sharp license");
  write(path.join("public", "fonts", "OFL.txt"), "SIL OPEN FONT LICENSE fixture");
  return root;
}

describe("generateNotices bundled font licenses", () => {
  it("copies the font OFL and lists Inter and Noto Sans SC copyrights", () => {
    const root = makeFixtureRoot();
    const outputDir = path.join(root, "out", "licenses");
    const nodeLicensePath = path.join(root, "node-license.txt");
    fs.writeFileSync(nodeLicensePath, "node license", "utf8");
    const backendNodeModules = path.join(root, "empty-backend-modules");
    fs.mkdirSync(backendNodeModules, { recursive: true });

    generateNotices({ root, outputDir, nodeLicensePath, backendNodeModules });

    expect(fs.readFileSync(path.join(outputDir, "FONT-OFL.txt"), "utf8")).toBe(
      "SIL OPEN FONT LICENSE fixture",
    );
    const notices = fs.readFileSync(path.join(outputDir, "THIRD_PARTY_NOTICES.txt"), "utf8");
    expect(notices).toContain("Inter Project Authors");
    expect(notices).toContain("Noto Sans SC");
    expect(notices).toContain("Vocatrya Han");
    expect(notices).toContain("FONT-OFL.txt");
  });

  it("fails when the bundled font license file is missing", () => {
    const root = makeFixtureRoot();
    fs.rmSync(path.join(root, "public", "fonts", "OFL.txt"));
    const outputDir = path.join(root, "out", "licenses");
    const nodeLicensePath = path.join(root, "node-license.txt");
    fs.writeFileSync(nodeLicensePath, "node license", "utf8");

    expect(() =>
      generateNotices({ root, outputDir, nodeLicensePath, backendNodeModules: root }),
    ).toThrow(/font OFL/);
  });
});

describe("globals.css bundled CJK fallback", () => {
  const css = fs.readFileSync(path.join(repoRoot, "src", "app", "globals.css"), "utf8");

  it("declares the Vocatrya Han font face against the packaged woff2", () => {
    expect(css).toMatch(
      /@font-face\s*{[^}]*font-family:\s*"Vocatrya Han"[^}]*url\("\/fonts\/NotoSansSC-VF\.woff2"\)[^}]*font-weight:\s*100 900[^}]*font-display:\s*swap[^}]*}/,
    );
  });

  it("ranks bundled CJK fallback after system Chinese fonts in --font-sans", () => {
    const sans = css.match(/--font-sans:([^;]+);/);
    expect(sans).not.toBeNull();
    const families = sans[1].split(",").map((entry) => entry.trim());
    expect(families.slice(0, 8)).toEqual([
      "var(--font-inter)",
      '"Microsoft YaHei UI"',
      '"Microsoft YaHei"',
      '"PingFang SC"',
      '"Vocatrya Han"',
      "ui-sans-serif",
      "system-ui",
      "sans-serif",
    ]);
  });

  it("keeps the Western mono stack and inserts CJK fallback before monospace", () => {
    const mono = css.match(/--font-mono:([^;]+);/);
    expect(mono).not.toBeNull();
    const families = mono[1].split(",").map((entry) => entry.trim());
    expect(families).toEqual([
      "ui-monospace",
      "SFMono-Regular",
      "Menlo",
      "Monaco",
      "Consolas",
      '"Liberation Mono"',
      '"Courier New"',
      '"Microsoft YaHei UI"',
      '"Microsoft YaHei"',
      '"Vocatrya Han"',
      "monospace",
    ]);
  });

  it("ships the packaged woff2 and OFL text under public/fonts", () => {
    const fontsDir = path.join(repoRoot, "public", "fonts");
    expect(fs.existsSync(path.join(fontsDir, "NotoSansSC-VF.woff2"))).toBe(true);
    const ofl = fs.readFileSync(path.join(fontsDir, "OFL.txt"), "utf8");
    expect(ofl).toContain("SIL OPEN FONT LICENSE");
    expect(ofl).toContain("Adobe");
  });
});
