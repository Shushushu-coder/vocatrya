import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopEnvironment, devToolsEndpoint, requestQuit, waitForValue, waitForInitialNavigation, withDeadline } from "./harness.mjs";

test("desktop spawn excludes ambient credentials, node mode, data roots and proxy overrides", () => {
  const env = desktopEnvironment({ PATH: "test-path", SystemRoot: "C:/Windows", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect", AUTH_SECRET: "real-secret", DATABASE_URL: "file:real.db", OPENAI_API_KEY: "real-key", HTTPS_PROXY: "http://proxy", VOCATRYA_DESKTOP_DATA_ROOT: "C:/real-profile" }, "E:/disposable/run");
  assert.equal(env.PATH, "test-path");
  assert.equal(env.VOCATRYA_DESKTOP_DATA_ROOT, "E:/disposable/run");
  assert.equal(env.VOCATRYA_AB_RUNTIME_ENABLED, "true");
  assert.equal(env.VOCATRYA_AB_ROLLOUT_SCOPE, "full");
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "AUTH_SECRET", "DATABASE_URL", "OPENAI_API_KEY", "HTTPS_PROXY"]) assert.equal(env[key], undefined);
});

test("CDP discovery accepts only a complete loopback port record", () => {
  assert.equal(devToolsEndpoint("45678\r\n/devtools/browser/test-id\r\n"), "http://127.0.0.1:45678");
  for (const value of ["", "45678", "0\n/devtools/browser/id", "65536\n/devtools/browser/id", "1234\nhttps://external.test", "1234\n/devtools/page/id"]) assert.equal(devToolsEndpoint(value), null);
});

test("readiness fails immediately when the owned Electron process exits", async () => {
  let probed = false;
  await assert.rejects(waitForValue("CDP readiness", () => { probed = true; }, { child: { exitCode: 0, signalCode: null } }), /Electron exited/);
  assert.equal(probed, false);
});

test("readiness distinguishes a backend value from later CDP readiness", async () => {
  let probes = 0;
  assert.equal(await waitForValue("CDP readiness", () => ++probes === 2 ? "endpoint" : null, { timeout: 1000 }), "endpoint");
  assert.equal(probes, 2);
  await assert.rejects(waitForValue("application window readiness", () => null, { timeout: 1 }), /application window readiness: timed out/);
});

test("hung quit IPC cannot block process cleanup indefinitely", async () => {
  const started = Date.now();
  await requestQuit({ evaluate: () => new Promise(() => {}) }, 20);
  assert.ok(Date.now() - started < 1000);
});

for (const authenticated of [false, true]) {
  test(`initial navigation waits for load and the ${authenticated ? "persisted session" : "sign-in"} destination`, async () => {
    let completeLoad;
    let ready = false;
    const pendingLoad = new Promise((resolve) => { completeLoad = resolve; });
    const page = {
      async waitForURL(matches, options) {
        const origin = "http://127.0.0.1:45678";
        assert.equal(matches(new URL(`${origin}${authenticated ? "/dashboard" : "/signin"}`)), true);
        assert.equal(matches(new URL(`${origin}${authenticated ? "/signin" : "/dashboard"}`)), false);
        assert.equal(matches(new URL(`http://localhost:45678${authenticated ? "/dashboard" : "/signin"}`)), false);
        assert.equal(options.waitUntil, "load");
        assert.equal(options.timeout, 60_000);
        await pendingLoad;
      },
    };
    const waiting = waitForInitialNavigation(page, "http://127.0.0.1:45678", authenticated).then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false);
    completeLoad();
    await waiting;
    assert.equal(ready, true);
  });
}

test("a hung cleanup or evidence operation has a deadline and preserves failures", async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), "cleanup", 10), /cleanup: timed out/);
  const original = new Error("original failure");
  await assert.rejects(withDeadline(Promise.reject(original), "cleanup", 10), (error) => error === original);
  assert.equal(await withDeadline(Promise.resolve("complete"), "cleanup", 10), "complete");
});
