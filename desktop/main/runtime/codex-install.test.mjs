import path from "node:path";
import { describe, expect, it } from "vitest";
import codexInstall from "./codex-install.js";
import detector from "./detector.js";
import connectionService from "./connection-service.js";
import registry from "./registry.js";
import updateApply from "./update-apply.js";

const { createConnectionService } = connectionService;
const { discoverCodexInstalls, selectCodexInstall, resolveCodexInstalls } = codexInstall;
const definition = registry.getRuntimeDefinition("CODEX_RUNTIME");

const LOCAL = "C:\\Users\\u\\AppData\\Local";
const ROAMING = "C:\\Users\\u\\AppData\\Roaming";
const STANDALONE = `${LOCAL}\\Programs\\OpenAI\\Codex\\bin\\codex.exe`;
const VENDOR_REL = "node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
const NPM_ROOT = `${ROAMING}\\npm`;
const NPM_VENDOR = `${NPM_ROOT}\\node_modules\\@openai\\codex\\${VENDOR_REL}`;
const STAGING = `${NPM_ROOT}\\node_modules\\@openai\\.codex-AbCd\\${VENDOR_REL}`;

// A tiny fake filesystem + probe: `files` is the set of existing file paths,
// `versions` maps an executable to its `--version` output (absent = probe fails).
function machine({ files, versions, pathHits = {} }) {
  const all = new Set(files.map((f) => f.toLowerCase()));
  const dirs = (dir) => {
    const prefix = dir.toLowerCase().replace(/[\\/]+$/, "") + "\\";
    const names = new Map();
    for (const file of files) {
      if (!file.toLowerCase().startsWith(prefix)) continue;
      const rest = file.slice(prefix.length).split("\\");
      names.set(rest[0], rest.length > 1);
    }
    return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
  };
  const probed = [];
  return {
    probed,
    deps: {
      platform: "win32",
      env: { LOCALAPPDATA: LOCAL, APPDATA: ROAMING },
      existsSyncImpl: (p) => all.has(path.resolve(p).toLowerCase()),
      readdirSyncImpl: (dir) => { const r = dirs(dir); if (!r.length) throw new Error("ENOENT"); return r; },
      spawnSyncImpl: (command, args) => {
        if (command === "where.exe") return pathHits[args[0]] ? { status: 0, stdout: pathHits[args[0]].join("\r\n") } : { status: 1, stdout: "" };
        probed.push(command);
        const version = versions[command];
        return version ? { status: 0, stdout: `codex-cli ${version}`, stderr: "" } : { status: 1, stdout: "", stderr: "" };
      },
    },
  };
}

// This machine's shape: stale standalone 0.165.0, npm 0.170.0, leftover npm staging dir.
const thisMachine = () => machine({
  files: [STANDALONE, NPM_VENDOR, STAGING, `${NPM_ROOT}\\codex.cmd`, `${NPM_ROOT}\\codex`],
  versions: { [STANDALONE]: "0.165.0", [NPM_VENDOR]: "0.170.0", [STAGING]: "0.170.0" },
  pathHits: { codex: [`${NPM_ROOT}\\codex`], "codex.cmd": [`${NPM_ROOT}\\codex.cmd`] },
});

describe("codex install discovery and selection", () => {
  it("lists every install once with source, version, verified and stale", () => {
    const { deps } = thisMachine();
    const installs = discoverCodexInstalls(definition, deps);
    expect(installs.map((i) => [i.path, i.source, i.version, i.verified, i.stale])).toEqual([
      [STANDALONE, "standalone", "0.165.0", false, false],
      [NPM_VENDOR, "npm", "0.170.0", true, false],
      [STAGING, "npm-staging", "0.170.0", true, true],
    ]);
  });

  it("per purpose: native -> verified npm 0.170.0, streaming/exec -> 0.165.0, default keeps precedence; never the stale dir", () => {
    const { deps } = thisMachine();
    const result = resolveCodexInstalls(definition, deps);
    expect(result.selections.native.path).toBe(NPM_VENDOR);
    expect(result.selections.exec.path).toBe(STANDALONE);
    expect(result.selected.path).toBe(STANDALONE);
    expect(result.installs.map((i) => i.selectedFor)).toEqual([["default", "exec"], ["native"], []]);
    expect(result.verifiedVersions).toEqual(["0.169.0", "0.170.0"]);
    // detectRuntime (IPC, login, update flows) keeps the pre-change precedence.
    const detected = detector.detectRuntime("CODEX_RUNTIME", deps);
    expect(detected).toMatchObject({ state: "READY", executablePath: STANDALONE, version: "0.165.0" });
    expect(detected.installs).toHaveLength(3);
  });

  it("exec falls back to precedence when no install has the streaming-verified version", () => {
    const { deps } = machine({ files: [STANDALONE, NPM_VENDOR], versions: { [STANDALONE]: "0.168.0", [NPM_VENDOR]: "0.170.0" } });
    const result = resolveCodexInstalls(definition, deps);
    expect(result.selections.exec.path).toBe(STANDALONE);
    expect(result.selections.native.path).toBe(NPM_VENDOR);
  });

  it("prefers the newest verified version and uses precedence only as a tiebreaker", () => {
    const mk = (p, version, order, extra = {}) => ({ path: p, version, ok: true, verified: true, stale: false, order, ...extra });
    const a = mk("a", "0.169.0", 0);
    const b = mk("b", "0.170.0", 1);
    const c = mk("c", "0.170.0", 2);
    expect(selectCodexInstall([a, b, c], undefined, "native")).toBe(b);
    expect(selectCodexInstall([a, mk("s", "0.170.0", 3, { stale: true })], undefined, "native")).toBe(a);
  });

  it("selects the newest supported binary when nothing is in verifiedVersions, and rejects below-baseline", () => {
    const { deps } = machine({
      files: [STANDALONE, NPM_VENDOR],
      versions: { [STANDALONE]: "0.165.0", [NPM_VENDOR]: "0.171.0" },
    });
    const result = resolveCodexInstalls(definition, deps);
    expect(result.selected.path).toBe(STANDALONE);
    expect(result.selections.native.path).toBe(NPM_VENDOR);
    expect(result.selections.native.verified).toBe(false);
    expect(result.installs.map((i) => i.selectedFor)).toEqual([["default", "exec"], ["native"]]);

    const old = resolveCodexInstalls(definition, machine({ files: [STANDALONE], versions: { [STANDALONE]: "0.164.0" } }).deps);
    expect(old.selections.native.path).toBe(STANDALONE);
    expect(old.installs[0].selectedFor).toEqual(["default"]);
  });

  it("ignores stale-only and reports NOT_INSTALLED when nothing live exists", () => {
    expect(selectCodexInstall([{ path: "s", version: "0.170.0", ok: true, verified: true, stale: true, order: 0 }], undefined, "native")).toBeNull();
  });

  it("probes a binary once per path+mtime+size when stat is available", () => {
    const m = machine({ files: [STANDALONE], versions: { [STANDALONE]: "0.170.0" } });
    const deps = { ...m.deps, statSyncImpl: () => ({ mtimeMs: 1, size: 2 }) };
    resolveCodexInstalls(definition, deps);
    resolveCodexInstalls(definition, deps);
    expect(m.probed.filter((c) => c === STANDALONE)).toHaveLength(1);
  });

  it("managed install coherence: an npm install pins the verified binary that selection then picks", () => {
    const state = { files: [STANDALONE, `${NPM_ROOT}\\codex.cmd`], versions: { [STANDALONE]: "0.165.0" }, pathHits: { "codex.cmd": [`${NPM_ROOT}\\codex.cmd`] } };
    const before = machine(state);
    const detected = detector.detectRuntime("CODEX_RUNTIME", before.deps);
    expect(detected.executablePath).toBe(STANDALONE);
    // npm channel exists (a broken shim) -> pinned "required" is offered
    const applier = updateApply.createRuntimeUpdateApplier({ ...before.deps, runCommand: async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }) });
    expect(updateApply.applySupportFor(definition, detected).canRequired).toBe(true);
    // simulate npm having landed the vendor binary
    state.files.push(NPM_VENDOR); state.versions[NPM_VENDOR] = "0.170.0";
    const after = machine(state);
    const applier2 = updateApply.createRuntimeUpdateApplier({ ...after.deps, runCommand: async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }) });
    return applier2.applyRuntimeUpdate("CODEX_RUNTIME", { target: "required" }).then((result) => {
      expect(result).toMatchObject({ ok: true, version: "0.170.0", state: "READY" });
      expect(applier).toBeTruthy();
    });
  });
});

describe("runtimeState", () => {
  it("exposes the discovered list, selected path and verifiedVersions", () => {
    const { deps } = thisMachine();
    const service = createConnectionService({ profilesRoot: "E:\\tmp\\nope", deps, backend: { resolveTicket() {} } });
    const state = service.runtimeState({ backendKind: "CODEX_RUNTIME", accountProvider: "OPENAI" });
    expect(state).toMatchObject({ ok: true, runtimeReady: true, runtimeVersion: "0.165.0", runtimePath: STANDALONE, verifiedVersions: ["0.169.0", "0.170.0"] });
    expect(state.installs).toEqual([
      { path: STANDALONE, source: "standalone", version: "0.165.0", verified: false, stale: false, selected: true, selectedFor: ["default", "exec"] },
      { path: NPM_VENDOR, source: "npm", version: "0.170.0", verified: true, stale: false, selected: false, selectedFor: ["native"] },
      { path: STAGING, source: "npm-staging", version: "0.170.0", verified: true, stale: true, selected: false, selectedFor: [] },
    ]);
    expect(state.nativeSession).toMatchObject({ ready: true, runtimeVersion: "0.170.0", runtimePath: NPM_VENDOR });
  });
});
