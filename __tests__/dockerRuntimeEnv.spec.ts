// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolveEffectiveCareerRuntimeConfig } from "@/lib/career";

const REPO = path.resolve(__dirname, "..");
const KEYS = ["VOCATRYA_AB_RUNTIME_ENABLED", "VOCATRYA_AB_ROLLOUT_SCOPE"] as const;
const CASES = KEYS.flatMap((key) =>
  [undefined, ...(key === KEYS[0] ? ["false", "true"] : ["none", "resume_v1", "full"]),
    "", "banana", "__VOCATRYA_AB_UNSET__", "__anything__"].map((raw) => ({ key, raw })),
);
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (source: string) => {
  services: { app: { environment: string[] } };
} };

describe("Docker AB configuration contract", () => {
  it("uses parsed bare-key forwarding without AB decoding in the entrypoint", () => {
    const compose = yaml.load(fs.readFileSync(path.join(REPO, "docker-compose.yml"), "utf8"));
    const entries = compose.services.app.environment;
    for (const key of KEYS) {
      expect(entries.filter((entry) => entry.split("=", 1)[0] === key)).toEqual([key]);
    }
    const entrypoint = fs.readFileSync(path.join(REPO, "docker-entrypoint.sh"), "utf8");
    for (const key of KEYS) expect(entrypoint).not.toContain(key);
    const migrateAt = entrypoint.indexOf("prisma@6.19.0 migrate deploy");
    const bootstrapAt = entrypoint.indexOf("fresh-native-runtime/ensure-fresh-native.cjs");
    expect(migrateAt).toBeGreaterThanOrEqual(0);
    expect(bootstrapAt).toBeGreaterThan(migrateAt);
    expect(entrypoint.indexOf("node server.js")).toBeGreaterThan(bootstrapAt);
  });
});

// CLI coverage needs no daemon. Without Compose, the parsed contract above still runs.
const version = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 30_000 });
describe.skipIf(version.status !== 0)("Docker Compose effective AB environment", () => {
  let dir: string;
  let envFile: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "voc-compose-env-"));
    envFile = path.join(dir, "empty.env");
    fs.writeFileSync(envFile, "");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each(CASES)("preserves presence and raw value for $key=$raw", ({ key, raw }) => {
    const host = { ...process.env };
    for (const name of KEYS) delete host[name];
    // An empty env file excludes developer .env defaults from the absence case.
    if (raw !== undefined) host[key] = raw;
    const result = spawnSync("docker", [
      "compose", "--project-name", "vocatrya-env-test", "--env-file", envFile,
      "-f", path.join(REPO, "docker-compose.yml"), "config", "--format", "json",
    ], { cwd: dir, env: host, encoding: "utf8", timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(result.stdout) as {
      services: { app: { environment: Record<string, string | null> } };
    };
    const effective = config.services.app.environment;
    // Compose represents unresolved entries as null in its model; null is NOT
    // an empty container value. Only resolved strings become container env keys.
    const server: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    for (const name of KEYS) {
      const value = effective[name];
      if (value !== null && value !== undefined) server[name] = value;
    }
    if (raw === undefined) {
      expect(effective[key] == null).toBe(true);
      expect(Object.hasOwn(server, key)).toBe(false);
    } else {
      expect(Object.hasOwn(effective, key)).toBe(true);
      expect(effective[key]).toBe(raw);
      expect(Object.hasOwn(server, key)).toBe(true);
      expect(server[key]).toBe(raw);
    }
    const other = key === KEYS[0] ? KEYS[1] : KEYS[0];
    expect(Object.hasOwn(server, other)).toBe(false);
    const resolved = resolveEffectiveCareerRuntimeConfig(server, true);
    const side = key === KEYS[0] ? "feature" : "scope";
    expect(resolved.configSource[side]).toBe(raw === undefined ? "fresh-default" : "explicit-env");
    if (key === KEYS[0]) expect(resolved.featureEnabled).toBe(raw === undefined || raw === "true");
    else expect(resolved.rolloutScope).toBe(
      raw === undefined ? "full" : ["none", "resume_v1", "full"].includes(raw) ? raw : "none",
    );
  }, 40_000);
});
