// Static security invariants for the runtime layer — targeted source
// assertions, not a repo-wide regex sweep. If a future change introduces
// a shell, a credential-file read, an ambient-env passthrough, or runtime
// logging of captured output, these tests fail loudly at review time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));

const RUNTIME_SOURCES = fs
  .readdirSync(RUNTIME_DIR)
  .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
  .map((f) => ({
    file: f,
    source: fs.readFileSync(path.join(RUNTIME_DIR, f), "utf8"),
  }));

describe("runtime layer security invariants", () => {
  it("no runtime source ever spawns through a shell", () => {
    for (const { file, source } of RUNTIME_SOURCES) {
      expect(
        /shell\s*:\s*true/.test(source),
        `${file} contains shell:true`,
      ).toBe(false);
      expect(
        /exec(?:File)?(?:Sync)?\s*\([^`'"]*`/.test(source),
        `${file} builds a command string for exec`,
      ).toBe(false);
    }
  });

  it("no runtime source reads credential files", () => {
    for (const { file, source } of RUNTIME_SOURCES) {
      expect(
        /readFile(?:Sync)?\s*\([^)]*(?:auth\.json|credentials\.toml)/.test(
          source,
        ),
        `${file} reads a credential file`,
      ).toBe(false);
      // No open/createReadStream on credential stores either.
      expect(
        /(?:open|createReadStream)\s*\([^)]*(?:auth\.json|credentials\.toml)/.test(
          source,
        ),
        `${file} opens a credential file`,
      ).toBe(false);
    }
  });

  it("no runtime source passes the ambient process env wholesale", () => {
    for (const { file, source } of RUNTIME_SOURCES) {
      expect(
        /\.\.\.\s*process\.env/.test(source),
        `${file} spreads process.env`,
      ).toBe(false);
      expect(
        /env\s*:\s*process\.env\b/.test(source),
        `${file} passes process.env as spawn env`,
      ).toBe(false);
    }
  });

  it("no runtime source logs captured process output or URLs", () => {
    // Diagnostics go through the injected `diag` callback with structured
    // codes only — a console.* call here could leak OAuth URLs, device
    // codes, or stderr containing tokens.
    for (const { file, source } of RUNTIME_SOURCES) {
      expect(
        /console\.(?:log|error|warn|info|debug)\s*\(/.test(source),
        `${file} contains a console call`,
      ).toBe(false);
    }
  });

  it("runtime sources never persist absolute profile paths", () => {
    // The filesystem path of a managed profile is an implementation
    // detail — only the opaque rp_<uuid> ref may travel to the backend.
    // Scan each completeOperation payload region for a path-shaped field.
    for (const { file, source } of RUNTIME_SOURCES) {
      for (const match of source.matchAll(/completeOperation\s*\(/g)) {
        const region = source.slice(match.index, match.index + 1200);
        const braceEnd = region.indexOf("})");
        const payload = braceEnd === -1 ? region : region.slice(0, braceEnd);
        expect(
          /(?:profileDir|profilePath|profileRoot|profilesRoot|env)\s*:/.test(
            payload,
          ),
          `${file} sends a path/env field in a completion payload`,
        ).toBe(false);
      }
    }
  });
});
