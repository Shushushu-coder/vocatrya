import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import proxyEnv from "./codex-proxy-env.js";
import environment from "./environment.js";
import registry from "./registry.js";
import codex from "./codex.js";

const { applyCodexProxyEnv, parseCodexProxyDotenv } = proxyEnv;
const { buildRuntimeProcessEnvironment } = environment;
const { getRuntimeDefinition } = registry;

const {
  buildCodexExecInvocation,
  buildCodexLoginInvocation,
  codexAdapter,
} = codex;

const tmpRoots = [];
function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-env-"));
  tmpRoots.push(root);
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(codexHome);
  return { root, dotenvPath: path.join(codexHome, ".env") };
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
  }
});

describe("parseCodexProxyDotenv", () => {
  it("keeps supported proxy keys and drops every other assignment", () => {
    const parsed = parseCodexProxyDotenv(`
# comment
export HTTPS_PROXY="http://127.0.0.1:7897"
HTTP_PROXY=http://127.0.0.1:7897
NO_PROXY=localhost,127.0.0.1
OPENAI_API_KEY=sk-should-not-pass
CODEX_HOME=C:\\evil
RANDOM_FLAG=1
`);
    expect(parsed).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:7897",
      HTTP_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1",
    });
  });
});

describe("managed Codex proxy parity", () => {
  const profileDir = "C:\\vocatrya\\profiles\\rp_test";

  it("fills managed Codex env from the user dotenv when the process has no proxy", () => {
    const { root, dotenvPath } = makeHome();
    fs.writeFileSync(
      dotenvPath,
      [
        "HTTP_PROXY=http://127.0.0.1:7897",
        "HTTPS_PROXY=http://127.0.0.1:7897",
        "ALL_PROXY=http://127.0.0.1:7897",
        "NO_PROXY=localhost,127.0.0.1,::1",
        "OPENAI_API_KEY=sk-leak",
      ].join("\n"),
    );
    const sourceBytes = fs.readFileSync(dotenvPath);
    const baseEnv = { PATH: "C:\\Windows", USERPROFILE: root };
    const env = applyCodexProxyEnv(
      buildRuntimeProcessEnvironment({
        baseEnv,
        definition: getRuntimeDefinition("CODEX_RUNTIME"),
        profileDir,
      }),
      baseEnv,
    );
    expect(env.CODEX_HOME).toBe(profileDir);
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.ALL_PROXY).toBe("http://127.0.0.1:7897");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(fs.readFileSync(dotenvPath)).toEqual(sourceBytes);
  });

  it("does not let the dotenv replace a proxy already present on the process", () => {
    const { root, dotenvPath } = makeHome();
    fs.writeFileSync(dotenvPath, "HTTPS_PROXY=http://127.0.0.1:1\n");
    const baseEnv = {
      PATH: "C:\\Windows",
      USERPROFILE: root,
      HTTPS_PROXY: "http://127.0.0.1:7897",
    };
    const env = applyCodexProxyEnv(
      buildRuntimeProcessEnvironment({
        baseEnv,
        definition: getRuntimeDefinition("CODEX_RUNTIME"),
        profileDir,
      }),
      baseEnv,
    );
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
  });

  it("leaves non-Codex runtimes unchanged", () => {
    const { root, dotenvPath } = makeHome();
    fs.writeFileSync(dotenvPath, "HTTPS_PROXY=http://127.0.0.1:7897\n");
    const baseEnv = { PATH: "C:\\Windows", USERPROFILE: root };
    const env = buildRuntimeProcessEnvironment({
      baseEnv,
      definition: getRuntimeDefinition("GROK_RUNTIME"),
      profileDir,
    });
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("gives exec and app-server the same proxy env", () => {
    const { root, dotenvPath } = makeHome();
    fs.writeFileSync(
      dotenvPath,
      "HTTPS_PROXY=http://127.0.0.1:7897\nHTTP_PROXY=http://127.0.0.1:7897\n",
    );
    const baseEnv = {
      PATH: "C:\\Windows",
      USERPROFILE: root,
      OPENAI_API_KEY: "sk-stripped",
    };
    const execInv = buildCodexExecInvocation({
      executablePath: "C:\\x\\codex.exe",
      profileDir,
      baseEnv,
      workingDirectory: root,
      outputFile: path.join(root, "last-message.txt"),
      model: "gpt-5.6-sol",
      prompt: "ping",
    });
    const streamInv = codexAdapter.buildStreamingInvocation({
      executablePath: "C:\\x\\codex.exe",
      profileDir,
      baseEnv,
      workingDirectory: root,
    });
    const loginInv = buildCodexLoginInvocation({
      executablePath: "C:\\x\\codex.exe",
      profileDir,
      baseEnv,
    });
    for (const inv of [execInv, streamInv, loginInv]) {
      expect(inv.env.CODEX_HOME).toBe(profileDir);
      expect(inv.env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
      expect(inv.env.HTTP_PROXY).toBe("http://127.0.0.1:7897");
      expect(inv.env.OPENAI_API_KEY).toBeUndefined();
    }
    expect(streamInv.args).toEqual(["app-server", "--listen", "stdio://"]);
  });

  it("is a no-op when the user dotenv is absent", () => {
    const baseEnv = { PATH: "C:\\Windows", USERPROFILE: "C:\\missing-user" };
    const env = applyCodexProxyEnv({}, baseEnv);
    expect(env).toEqual({});
  });
});
