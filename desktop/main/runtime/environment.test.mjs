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
  HOMEDRIVE: "C:",
  HOMEPATH: "\\Users\\host",
  APPDATA: "C:\\Users\\host\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\host\\AppData\\Local",
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

  it("isolates Grok via GROK_HOME + redirected home roots, strips API keys", () => {
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: getRuntimeDefinition("GROK_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(env.GROK_HOME).toBe(PROFILE_DIR);
    expect(env.GROK_LEADER_SOCKET).toBe(`${PROFILE_DIR}\\grok-leader.sock`);
    // Grok's compat scanners and folder-trust store resolve through ~ —
    // every home root must point inside the managed profile or host
    // ~/.claude.json / .grok markers leak in.
    expect(env.HOME).toBe(`${PROFILE_DIR}\\home`);
    expect(env.USERPROFILE).toBe(`${PROFILE_DIR}\\home`);
    expect(env.APPDATA).toBe(`${PROFILE_DIR}\\home\\AppData\\Roaming`);
    expect(env.LOCALAPPDATA).toBe(`${PROFILE_DIR}\\home\\AppData\\Local`);
    // The drive+path fallback pair is stripped so ~ can only resolve via
    // the redirected USERPROFILE.
    expect(env.HOMEDRIVE).toBeUndefined();
    expect(env.HOMEPATH).toBeUndefined();
    expect(env.GROK_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.GROK_DEPLOYMENT_KEY).toBeUndefined();
  });

  it("isolates OpenCode via all four XDG roots, not OPENCODE_CONFIG_DIR alone", () => {
    // Regression for the corrected Phase F1 boundary: opencode stores
    // auth.json under XDG_DATA_HOME\opencode — a lone config dir never
    // isolates credentials. Each root must be a distinct managed subdir.
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: getRuntimeDefinition("OPENCODE_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(env.XDG_DATA_HOME).toBe(`${PROFILE_DIR}\\data`);
    expect(env.XDG_CONFIG_HOME).toBe(`${PROFILE_DIR}\\config`);
    expect(env.XDG_CACHE_HOME).toBe(`${PROFILE_DIR}\\cache`);
    expect(env.XDG_STATE_HOME).toBe(`${PROFILE_DIR}\\state`);
    // Config override lives inside the managed config root — it is a
    // config/plugin override, never the credential boundary.
    expect(env.OPENCODE_CONFIG_DIR).toBe(`${PROFILE_DIR}\\config\\opencode`);
    // The host profile can never leak through as a fallback root.
    expect(env.HOME).toBe(`${PROFILE_DIR}\\home`);
    expect(env.USERPROFILE).toBe(`${PROFILE_DIR}\\home`);
    // Host env values that point at the real user profile are replaced.
    expect(env.XDG_DATA_HOME).not.toContain("C:\\Users\\host");
  });

  it("strips ambient provider credentials so OAuth routing is never bypassed", () => {
    // Spec §43: a hostile host env must not let API keys or GitHub tokens
    // silently override the managed OAuth session inside OpenCode.
    const hostile = {
      ...HOSTILE_BASE_ENV,
      OPENROUTER_API_KEY: "or-host",
      GOOGLE_GENERATIVE_AI_API_KEY: "g-host",
      OPENCODE_API_KEY: "oc-host",
    };
    const env = buildRuntimeProcessEnvironment({
      baseEnv: hostile,
      definition: getRuntimeDefinition("OPENCODE_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    for (const key of [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "XAI_API_KEY",
      "OPENROUTER_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "COPILOT_GITHUB_TOKEN",
      "OPENCODE_API_KEY",
    ]) {
      expect(env[key], `leaked ${key}`).toBeUndefined();
    }
    // The caller's env object is never mutated.
    expect(hostile.OPENAI_API_KEY).toBe("sk-host-openai");
  });

  it("isolates Cursor via APPDATA+home roots and strips credential overrides", () => {
    // Regression for the corrected Phase H boundary: cursor-agent persists
    // credentials in %APPDATA%\Cursor\auth.json — CURSOR_CONFIG_DIR alone
    // covers only cli-config.json and never isolates auth. APPDATA,
    // LOCALAPPDATA, HOME/USERPROFILE and the XDG roots all redirect into
    // the managed profile.
    const env = buildRuntimeProcessEnvironment({
      baseEnv: {
        ...HOSTILE_BASE_ENV,
        CURSOR_API_KEY: "ck-host",
        CURSOR_AUTH_TOKEN: "tok-host",
        CURSOR_API_ENDPOINT: "https://evil.example.com",
        CURSOR_WEBSITE_URL: "https://evil.example.com",
        AGENT_CLI_CREDENTIAL_STORE: "memory",
        CURSOR_MDM_SIGN_IN_POLICY_JSON: "{}",
      },
      definition: getRuntimeDefinition("CURSOR_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(env.CURSOR_CONFIG_DIR).toBe(`${PROFILE_DIR}\\config`);
    expect(env.APPDATA).toBe(`${PROFILE_DIR}\\appdata`);
    expect(env.LOCALAPPDATA).toBe(`${PROFILE_DIR}\\localappdata`);
    expect(env.HOME).toBe(`${PROFILE_DIR}\\home`);
    expect(env.USERPROFILE).toBe(`${PROFILE_DIR}\\home`);
    expect(env.XDG_CONFIG_HOME).toBe(`${PROFILE_DIR}\\xdg-config`);
    expect(env.XDG_DATA_HOME).toBe(`${PROFILE_DIR}\\xdg-data`);
    expect(env.XDG_CACHE_HOME).toBe(`${PROFILE_DIR}\\xdg-cache`);
    expect(env.XDG_STATE_HOME).toBe(`${PROFILE_DIR}\\xdg-state`);
    expect(env.HOMEDRIVE).toBeUndefined();
    expect(env.HOMEPATH).toBeUndefined();
    for (const key of [
      "CURSOR_API_KEY",
      "CURSOR_AUTH_TOKEN",
      "CURSOR_API_ENDPOINT",
      "CURSOR_WEBSITE_URL",
      "AGENT_CLI_CREDENTIAL_STORE",
      "CURSOR_MDM_SIGN_IN_POLICY_JSON",
    ]) {
      expect(env[key], `leaked ${key}`).toBeUndefined();
    }
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

  it("anchors Devin isolation on USERPROFILE, not --config", () => {
    // Verified against devin 3000.10.31: credentials resolve through
    // USERPROFILE (…\AppData\Roaming\devin\credentials.toml). APPDATA/XDG
    // are belt-and-suspenders; --config never moved credentials and is gone.
    const devin = getRuntimeDefinition("DEVIN_RUNTIME");
    const env = buildRuntimeProcessEnvironment({
      baseEnv: HOSTILE_BASE_ENV,
      definition: devin,
      profileDir: PROFILE_DIR,
    });
    const home = `${PROFILE_DIR}\\home`;
    expect(env.USERPROFILE).toBe(home);
    expect(env.HOME).toBe(home);
    expect(env.APPDATA).toBe(`${home}\\AppData\\Roaming`);
    expect(env.LOCALAPPDATA).toBe(`${home}\\AppData\\Local`);
    expect(env.XDG_CONFIG_HOME).toBe(`${PROFILE_DIR}\\xdg-config`);
    expect(env.XDG_DATA_HOME).toBe(`${PROFILE_DIR}\\xdg-data`);
    expect(env.HOMEDRIVE).toBeUndefined();
    expect(env.HOMEPATH).toBeUndefined();
    expect(env.DEVIN_API_KEY).toBeUndefined();
    expect(
      buildRuntimeInvocationArgs({ definition: devin, profileDir: PROFILE_DIR }),
    ).toEqual([]);
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

  it("preserves proxy/CA network env for every runtime", () => {
    // §48: credential stripping must never eat connectivity settings — the
    // account's proxy and custom CA bundle apply to all managed runtimes.
    const networked = {
      ...HOSTILE_BASE_ENV,
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "C:\\certs\\corp.pem",
    };
    for (const kind of [
      "CODEX_RUNTIME",
      "CLAUDE_RUNTIME",
      "GROK_RUNTIME",
      "OPENCODE_RUNTIME",
      "CURSOR_RUNTIME",
      "DEVIN_RUNTIME",
    ]) {
      const env = buildRuntimeProcessEnvironment({
        baseEnv: networked,
        definition: getRuntimeDefinition(kind),
        profileDir: PROFILE_DIR,
      });
      expect(env.HTTP_PROXY, kind).toBe("http://127.0.0.1:7897");
      expect(env.HTTPS_PROXY, kind).toBe("http://127.0.0.1:7897");
      expect(env.NO_PROXY, kind).toBe("localhost,127.0.0.1");
      expect(env.NODE_EXTRA_CA_CERTS, kind).toBe("C:\\certs\\corp.pem");
    }
  });

  it("restores browser-login passthrough roots only where the registry declares them", () => {
    const baseEnv = {
      PATH: "C:\\Windows",
      USERPROFILE: "C:\\Users\\real",
      APPDATA: "C:\\Users\\real\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\real\\AppData\\Local",
    };
    // Devin: APPDATA/LOCALAPPDATA pass back to the host for the browser
    // process only — USERPROFILE (credentials.toml boundary) stays managed.
    const devinLogin = buildRuntimeProcessEnvironment({
      baseEnv,
      definition: getRuntimeDefinition("DEVIN_RUNTIME"),
      profileDir: PROFILE_DIR,
      browserLogin: true,
    });
    expect(devinLogin.APPDATA).toBe("C:\\Users\\real\\AppData\\Roaming");
    expect(devinLogin.LOCALAPPDATA).toBe("C:\\Users\\real\\AppData\\Local");
    expect(devinLogin.USERPROFILE).toBe(`${PROFILE_DIR}\\home`);
    // Without browserLogin the roots stay redirected.
    const devinPlain = buildRuntimeProcessEnvironment({
      baseEnv,
      definition: getRuntimeDefinition("DEVIN_RUNTIME"),
      profileDir: PROFILE_DIR,
    });
    expect(devinPlain.APPDATA).not.toBe("C:\\Users\\real\\AppData\\Roaming");
    // No other runtime declares a passthrough — the flag is a no-op even
    // where APPDATA is a redirected root (Cursor manages APPDATA as its
    // credential boundary).
    const cursorLogin = buildRuntimeProcessEnvironment({
      baseEnv,
      definition: getRuntimeDefinition("CURSOR_RUNTIME"),
      profileDir: PROFILE_DIR,
      browserLogin: true,
    });
    expect(cursorLogin.APPDATA).toBe(`${PROFILE_DIR}\\appdata`);
    expect(cursorLogin.USERPROFILE).toBe(`${PROFILE_DIR}\\home`);
  });

  it("a credential-boundary passthrough declaration is refused", () => {
    // Registry-bug guard: even if a definition tried to passthrough its
    // credential root, the builder must not restore the host value.
    const definition = {
      ...getRuntimeDefinition("CODEX_RUNTIME"),
      profile: {
        ...getRuntimeDefinition("CODEX_RUNTIME").profile,
        browserLoginEnvPassthrough: ["CODEX_HOME"],
      },
    };
    const env = buildRuntimeProcessEnvironment({
      baseEnv: { PATH: "C:\\Windows", CODEX_HOME: "C:\\evil" },
      definition,
      profileDir: PROFILE_DIR,
      browserLogin: true,
    });
    expect(env.CODEX_HOME).toBe(PROFILE_DIR);
  });
});
