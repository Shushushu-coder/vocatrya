import { describe, expect, it } from "vitest";
import applyModule from "./update-apply.js";

const {
  APPLY_TARGETS,
  applySupportFor,
  createRuntimeUpdateApplier,
  isNpmGlobalPath,
  requiredVersionFor,
} = applyModule;

// No test spawns a real process — detect + runCommand are fully faked.
const NPM_CODEX = "C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd";
const STANDALONE_CODEX =
  "C:\\Users\\x\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";

// spawnSync fake: `where.exe <bin>` answers detection, `--version` answers
// the version probe. `versionRef` lets a test flip the probed version to
// simulate a completed install.
function detectDeps({ executable, versionRef }) {
  return {
    platform: "win32",
    env: {},
    existsSyncImpl: () => false,
    spawnSyncImpl: (command, args = []) => {
      if (command === "where.exe" && args[0] === executable.split("\\").pop()) {
        return { status: 0, stdout: `${executable}\r\n` };
      }
      if (command === "where.exe") return { status: 1, stdout: "" };
      if (args[0] === "--version") {
        return { status: 0, stdout: `codex ${versionRef.value}`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    },
  };
}

const okRun = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };

describe("update-apply flavor detection", () => {
  it("marks npm-prefixed binaries as npm-global", () => {
    expect(isNpmGlobalPath(NPM_CODEX)).toBe(true);
    expect(isNpmGlobalPath("C:\\tools\\npm\\node_modules\\x\\bin\\x.exe")).toBe(true);
    expect(isNpmGlobalPath(STANDALONE_CODEX)).toBe(false);
    expect(isNpmGlobalPath(null)).toBe(false);
  });

  it("reports capability per flavor without executing", () => {
    const def = { update: { recovery: { kind: "npm-pin", package: "@openai/codex" }, methods: [{ kind: "self-update" }] } };
    const npm = applySupportFor(def, { executablePath: NPM_CODEX });
    expect(npm).toEqual({ flavor: "npm-global", canLatest: true, canRequired: true });
    const standalone = applySupportFor(def, { executablePath: STANDALONE_CODEX });
    expect(standalone).toEqual({ flavor: "self-update", canLatest: true, canRequired: false });
    const missing = applySupportFor(def, {});
    expect(missing.canLatest).toBe(false);
    expect(missing.canRequired).toBe(false);
  });
});

describe("requiredVersionFor", () => {
  it("pins codex's strict native-session version", () => {
    expect(requiredVersionFor("CODEX_RUNTIME")).toBe("0.169.0");
  });
});

describe("applyRuntimeUpdate", () => {
  it("npm-global + required runs the pinned npm install and re-probes", async () => {
    const versionRef = { value: "0.165.0" };
    const calls = [];
    const applier = createRuntimeUpdateApplier({
      ...detectDeps({ executable: NPM_CODEX, versionRef }),
      runCommand: async (input) => {
        calls.push(input);
        versionRef.value = "0.169.0";
        return okRun;
      },
    });
    const result = await applier.applyRuntimeUpdate("CODEX_RUNTIME", {
      target: "required",
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe("0.169.0");
    expect(calls).toHaveLength(1);
    expect(calls[0].executable).toBe("cmd.exe");
    expect(calls[0].args).toEqual([
      "/d",
      "/s",
      "/c",
      "npm",
      "install",
      "-g",
      "@openai/codex@0.169.0",
    ]);
  });

  it("npm-global + latest tracks the dist-tag", async () => {
    const versionRef = { value: "0.165.0" };
    const calls = [];
    const applier = createRuntimeUpdateApplier({
      ...detectDeps({ executable: NPM_CODEX, versionRef }),
      runCommand: async (input) => {
        calls.push(input);
        return okRun;
      },
    });
    await applier.applyRuntimeUpdate("CODEX_RUNTIME", { target: "latest" });
    expect(calls[0].args.at(-1)).toBe("@openai/codex@latest");
  });

  it("standalone install can self-update latest but cannot pin required", async () => {
    const versionRef = { value: "0.165.0" };
    const calls = [];
    const applier = createRuntimeUpdateApplier({
      ...detectDeps({ executable: STANDALONE_CODEX, versionRef }),
      runCommand: async (input) => {
        calls.push(input);
        return okRun;
      },
    });
    const required = await applier.applyRuntimeUpdate("CODEX_RUNTIME", {
      target: "required",
    });
    expect(required).toEqual({ ok: false, code: "MANUAL_REQUIRED" });
    const latest = await applier.applyRuntimeUpdate("CODEX_RUNTIME", {
      target: "latest",
    });
    expect(latest.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].executable).toBe(STANDALONE_CODEX);
    expect(calls[0].args).toEqual(["update"]);
  });

  it("refuses updates when nothing is installed", async () => {
    const applier = createRuntimeUpdateApplier(detectDeps({ executable: null, versionRef: { value: null } }));
    const result = await applier.applyRuntimeUpdate("CODEX_RUNTIME", {
      target: "latest",
    });
    expect(result).toEqual({ ok: false, code: "MANUAL_REQUIRED" });
  });

  it("reports a failing command with its stderr tail", async () => {
    const applier = createRuntimeUpdateApplier({
      ...detectDeps({ executable: NPM_CODEX, versionRef: { value: "0.165.0" } }),
      runCommand: async () => ({
        ...okRun,
        exitCode: 1,
        stderr: "npm error code EPERM\noperation not permitted",
      }),
    });
    const result = await applier.applyRuntimeUpdate("CODEX_RUNTIME", {
      target: "required",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UPDATE_FAILED");
    expect(result.exitCode).toBe(1);
    expect(result.stderrTail).toContain("operation not permitted");
  });

  it("rejects a second apply while one is in flight", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const applier = createRuntimeUpdateApplier({
      ...detectDeps({ executable: NPM_CODEX, versionRef: { value: "0.165.0" } }),
      runCommand: () => gate.then(() => okRun),
    });
    const first = applier.applyRuntimeUpdate("CODEX_RUNTIME", { target: "latest" });
    const second = await applier.applyRuntimeUpdate("CODEX_RUNTIME", {
      target: "latest",
    });
    expect(second).toEqual({ ok: false, code: "IN_PROGRESS" });
    release();
    await first;
  });

  it("validates the target enum", async () => {
    const applier = createRuntimeUpdateApplier(
      detectDeps({ executable: NPM_CODEX, versionRef: { value: "0.165.0" } }),
    );
    await expect(
      applier.applyRuntimeUpdate("CODEX_RUNTIME", { target: "0.169.0" }),
    ).rejects.toThrow(/target/i);
  });

  it("APPLY_TARGETS is the exact renderer enum", () => {
    expect(APPLY_TARGETS).toEqual(["latest", "required"]);
  });
});
