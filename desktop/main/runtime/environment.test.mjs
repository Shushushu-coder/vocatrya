import { describe, expect, it } from "vitest";
import registry from "./registry.js";
import environment from "./environment.js";

const { getRuntimeDefinition } = registry;
const { buildRuntimeInvocationArgs, buildRuntimeProcessEnvironment } =
  environment;

const PROFILE_DIR = "C:\\Managed\\runtime-profiles\\rp_11111111-2222-3333-4444-555555555555";

const HOSTILE_BASE_ENV = {
  PATH: "C:\\Windows;C:\\Tools",
  TEMP: "C:\\Temp",
  USERPROFILE: "C:\\Users\\host",
  APPDATA: "C:\\Users\\host\\AppData\\Roaming",
  OPENAI_API_KEY: "sk-host-openai",
  ANTHROPIC_API_KEY: "sk-host-anthropic",
  GROK_API_KEY: "grok-host",
  XAI_API_KEY: "xai-host",
  GROK_DEPLOYMENT_KEY: "deploy-host",
  CURSOR_API_KEY: "cursor-host",
  COPILOT_GITHUB_TOKEN: "ghp_hostcopilot012345678901234567890",
  GH_TOKEN: "ghp_hostgh01234567890123456789012",
  GITHUB_TOKEN: "ghp_hostgithub0123456789012345678901",
  DEVIN_API_KEY: "devin-host",
  UNRELATED_SECRET: "should-not-pass",
};

describe("runtime process environment isolation", () => {
  it("starts from a controlled allowlist, not the full host env", () => {
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: getRuntimeDefinition("CODEX_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(env.PATH).toBe("C:\\Windows;C:\\Tools");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });

  it("injects CODEX_HOME and strips OpenAI credential env", () => {
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: getRuntimeDefinition("CODEX_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(env.CODEX_HOME).toBe(PROFILE_DIR);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
  });

  it("injects CLAUDE_CONFIG_DIR as an absolute managed path", () => {
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: getRuntimeDefinition("CLAUDE_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe(PROFILE_DIR);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("isolates Grok via GROK_HOME + per-profile leader socket, strips API keys", () => {
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: getRuntimeDefinition("GROK_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(env.GROK_HOME).toBe(PROFILE_DIR);
    expect(env.GROK_LEADER_SOCKET).toBe(`${PROFILE_DIR}\\grok-leader.sock`);
    expect(env.GROK_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.GROK_DEPLOYMENT_KEY).toBeUndefined();
  });

  it("isolates OpenCode via OPENCODE_CONFIG_DIR", () => {
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: getRuntimeDefinition("OPENCODE_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(env.OPENCODE_CONFIG_DIR).toBe(PROFILE_DIR);
  });

  it("isolates Cursor and strips CURSOR_API_KEY", () => {
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: getRuntimeDefinition("CURSOR_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(env.CURSOR_CONFIG_DIR).toBe(PROFILE_DIR);
    expect(env.CURSOR_API_KEY).toBeUndefined();
  });

  it("isolates Copilot and strips all ambient GitHub tokens", () => {
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: getRuntimeDefinition("COPILOT_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(env.COPILOT_HOME).toBe(PROFILE_DIR);
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("gives Devin isolated APPDATA/XDG/HOME roots plus --config metadata", () => {
    const devin = getRuntimeDefinition("DEVIN_RUNTIME");
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: devin,
      profileDir: PROFILE_DIR,
    });
    expect(env.APPDATA).toBe(`${PROFILE_DIR}\\appdata`);
    expect(env.XDG_CONFIG_HOME).toBe(`${PROFILE_DIR}\\xdg-config`);
    expect(env.XDG_DATA_HOME).toBe(`${PROFILE_DIR}\\xdg-data`);
    expect(env.HOME).toBe(`${PROFILE_DIR}\\home`);
    expect(env.USERPROFILE).toBe(`${PROFILE_DIR}\\home`);
    expect(env.DEVIN_API_KEY).toBeUndefined();
    expect(buildRuntimeInvocationArgs({ definition: devin, profileDir: PROFILE_DIR })).toEqual([
      "--config",
      `${PROFILE_DIR}\\config\\devin.toml`,
    ]);
    // Runtimes without invocation metadata contribute no extra args.
    expect(
      buildRuntimeInvocationArgs({
        definition: getRuntimeDefinition("CODEX_RUNTIME"),
        profileDir: PROFILE_DIR,
      }),
    ).toEqual([]);
  });

  it("strips cross-provider credentials for every runtime", () => {
    // A Codex spawn must not see a GitHub token; a Copilot spawn must not
    // see an OpenAI key. The strip set is the union across the registry.
    for (const kind of [
      "CODEX_RUNTIME",
      "CLAUDE_RUNTIME",
      "GROK_RUNTIME",
      "OPENCODE_RUNTIME",
      "CURSOR_RUNTIME",
      "COPILOT_RUNTIME",
      "DEVIN_RUNTIME",
    ]) {
      const env = buildRuntimeProcessEnvironment({
        baseEnv: HOSTILE_BASE_ENV,
        definition: getRuntimeDefinition(kind),
        profileDir: PROFILE_DIR,
      });
      for (const key of [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GROK_API_KEY",
        "XAI_API_KEY",
        "CURSOR_API_KEY",
        "COPILOT_GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "DEVIN_API_KEY",
      ]) {
        expect(env[key], `${kind} leaked ${key}`).toBeUndefined();
      }
    }
  });

  it("never mutates the caller env or process.env", () => {
    const base = { PATH: "x", GITHUB_TOKEN: "ghp_keep0123456789012345678901" };
    const snapshot = { ...base };
    const before = process.env.GITHUB_TOKEN;
    buildRuntimeProcessEnvironment({
      baseEnv: base,
      definition: getRuntimeDefinition("COPILOT_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(base).toEqual(snapshot);
    expect(process.env.GITHUB_TOKEN).toBe(before);
  });

  it("drops sensitive keys even when passed as extraEnv", () => {
    const env = buildRuntimeProcessEnvironment({
      baseEnv: {},
      definition: getRuntimeDefinition("CODEX_RUNTIME"),
      profileDir: PROFILE_DIR,
      extraEnv: { GITHUB_TOKEN: "ghp_bad01234567890123456789012", SAFE_FLAG: "1" },
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SAFE_FLAG).toBe("1");
  });
});
