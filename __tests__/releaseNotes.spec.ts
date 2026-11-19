// Release notes are one curated bilingual file per version: `## zh-CN` and
// `## en` sections. The extractor picks the section matching the UI locale
// and never lets trailing sections (e.g. "## Links" appended to the GitHub
// body) bleed into rendered notes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractReleaseNotesSection,
  loadReleaseNotesSource,
} from "@/lib/releaseNotes";

const SAMPLE = `<!-- vocatrya-release-notes -->
## zh-CN

- 新增甲
- 修复乙

## en

- Added A
- Fixed B

## Links

**Full Changelog**: https://example.com/compare
`;

describe("extractReleaseNotesSection", () => {
  it("returns the zh-CN section for zh-CN", () => {
    expect(extractReleaseNotesSection(SAMPLE, "zh-CN")).toBe("- 新增甲\n- 修复乙");
  });

  it("returns the en section for en", () => {
    expect(extractReleaseNotesSection(SAMPLE, "en")).toBe("- Added A\n- Fixed B");
  });

  it("bounds a locale section at the next ## heading", () => {
    const text = extractReleaseNotesSection(SAMPLE, "en")!;
    expect(text).not.toContain("Links");
    expect(text).not.toContain("Full Changelog");
  });

  it("falls back to zh-CN, then en, when the requested locale is missing", () => {
    const zhOnly = `## zh-CN\n\n- 只有中文\n`;
    expect(extractReleaseNotesSection(zhOnly, "en")).toBe("- 只有中文");
    const enOnly = `## en\n\n- English only\n`;
    expect(extractReleaseNotesSection(enOnly, "zh-CN")).toBe("- English only");
  });

  it("returns null for content with no locale sections", () => {
    // Old GitHub release bodies are auto-generated commit lists — they must
    // never render as curated notes.
    const generated = "### Features\n\n* some commit subject\n";
    expect(extractReleaseNotesSection(generated, "zh-CN")).toBeNull();
    expect(extractReleaseNotesSection("", "en")).toBeNull();
    expect(extractReleaseNotesSection(null as never, "en")).toBeNull();
  });

  it("tolerates \\r\\n line endings and non-locale ## headings inside prose", () => {
    const source = "## zh-CN\r\n\r\n- 甲\r\n## 链接\r\n见别处\r\n## en\r\n\r\n- A\r\n";
    expect(extractReleaseNotesSection(source, "zh-CN")).toBe("- 甲");
    expect(extractReleaseNotesSection(source, "en")).toBe("- A");
  });
});

describe("loadReleaseNotesSource", () => {
  let dir: string;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function useTempDir() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-notes-"));
    vi.stubEnv("VOCATRYA_RELEASE_NOTES_DIR", dir);
    return dir;
  }

  it("reads release-notes/<version>.md from the notes directory", async () => {
    const root = useTempDir();
    fs.writeFileSync(path.join(root, "9.9.9.md"), SAMPLE, "utf8");
    expect(await loadReleaseNotesSource("9.9.9")).toBe(SAMPLE);
  });

  it("strips a leading v from the version", async () => {
    const root = useTempDir();
    fs.writeFileSync(path.join(root, "9.9.9.md"), SAMPLE, "utf8");
    expect(await loadReleaseNotesSource("v9.9.9")).toBe(SAMPLE);
  });

  it("returns null when the file is absent", async () => {
    useTempDir();
    expect(await loadReleaseNotesSource("0.0.0")).toBeNull();
  });

  it("refuses version strings that could escape the notes directory", async () => {
    const root = useTempDir();
    fs.writeFileSync(path.join(root, "..", "escape.md"), "x", "utf8");
    for (const version of ["../escape", "..\\escape", "", "a/b", "a\\b"]) {
      expect(await loadReleaseNotesSource(version)).toBeNull();
    }
  });
});
