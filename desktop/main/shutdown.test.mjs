import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQuitCoordinator,
  createReleaseHookRegistry,
  flushDefaultSession,
  registerDesktopReleaseHook,
  resetDesktopReleaseHooksForTests,
  runRegisteredReleaseHooks,
} from "./shutdown.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  resetDesktopReleaseHooksForTests();
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("quit coordinator", () => {
  it("releases owned resources once, then allows the final quit through", async () => {
    const order = [];
    const release = deferred();
    const first = { preventDefault: vi.fn() };
    const coordinator = createQuitCoordinator({
      beginQuit: () => order.push("begin"),
      markShuttingDown: () => order.push("mark"),
      runReleaseHooks: async () => order.push("hooks"),
      releaseResources: () => {
        order.push("release");
        return release.promise;
      },
      flushSession: async () => order.push("flush"),
      requestQuit: () => order.push("quit"),
    });

    coordinator.onBeforeQuit(first);
    await tick();
    expect(order).toEqual(["begin", "mark", "hooks", "release"]);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(coordinator.phase).toBe("releasing");

    const duplicate = { preventDefault: vi.fn() };
    coordinator.onBeforeQuit(duplicate);
    expect(duplicate.preventDefault).toHaveBeenCalledTimes(1);
    // A repeat quit still latches the quitting flag, but does not release twice.
    expect(order).toEqual(["begin", "mark", "hooks", "release", "begin"]);
    expect(order.filter((step) => step === "release")).toHaveLength(1);

    release.resolve();
    await tick();
    await tick();
    expect(order).toEqual(["begin", "mark", "hooks", "release", "begin", "flush", "quit"]);

    const finalQuit = { preventDefault: vi.fn() };
    coordinator.onBeforeQuit(finalQuit);
    expect(finalQuit.preventDefault).not.toHaveBeenCalled();
    expect(order.filter((step) => step === "quit")).toHaveLength(1);
    expect(coordinator.phase).toBe("released");
  });

  it("still requests quit when resource release throws", async () => {
    const requestQuit = vi.fn();
    const logger = { error: vi.fn() };
    const coordinator = createQuitCoordinator({
      beginQuit: () => {},
      releaseResources: async () => {
        throw new Error("backend kill failed");
      },
      requestQuit,
      logger,
    });
    coordinator.onBeforeQuit({ preventDefault: vi.fn() });
    await tick();
    await tick();
    expect(requestQuit).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
    expect(coordinator.phase).toBe("released");
  });

  it("does not treat a hidden window as quit: only onBeforeQuit releases", async () => {
    const releaseResources = vi.fn(async () => {});
    createQuitCoordinator({
      beginQuit: () => {},
      releaseResources,
      requestQuit: () => {},
    });
    await tick();
    expect(releaseResources).not.toHaveBeenCalled();
  });

  it("emits sanitized stage lines so a stalled quit leaves evidence", async () => {
    const lines = [];
    const logger = { error: vi.fn(), info: (line) => lines.push(line) };
    const coordinator = createQuitCoordinator({
      beginQuit: () => {},
      releaseResources: async () => {},
      flushSession: async () => {},
      requestQuit: () => {},
      logger,
    });
    coordinator.onBeforeQuit({ preventDefault: vi.fn() });
    await tick();
    await tick();
    expect(lines[0]).toBe("[desktop-quit] releasing owned resources");
    expect(lines).toContain("[desktop-quit] resources released");
    expect(lines).toContain("[desktop-quit] session flushed");
    expect(lines).toContain("[desktop-quit] requesting final quit");
    expect(lines.every((line) => line.startsWith("[desktop-quit]"))).toBe(true);
  });
});

describe("release hooks", () => {
  it("runs DateTime, Process, and Reminder seams before process teardown", async () => {
    const order = [];
    const unregister = registerDesktopReleaseHook(async () => {
      order.push("datetime");
    });
    registerDesktopReleaseHook(async () => {
      order.push("process");
    });
    const reminder = registerDesktopReleaseHook(async () => {
      order.push("reminder");
    });
    reminder();
    await runRegisteredReleaseHooks();
    unregister();
    expect(order).toEqual(["datetime", "process"]);
  });

  it("a timed-out hook does not reject the release", async () => {
    const registry = createReleaseHookRegistry();
    registry.register(() => new Promise(() => {}));
    const results = await registry.run(10);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error.message).toMatch(/timed out/);
  });
});

describe("session flush", () => {
  it("flushes storage and the cookie jar without reading cookie values", async () => {
    const session = {
      flushStorageData: vi.fn(),
      cookies: { flushStore: vi.fn(async () => {}) },
    };
    await flushDefaultSession(session);
    expect(session.flushStorageData).toHaveBeenCalledTimes(1);
    expect(session.cookies.flushStore).toHaveBeenCalledTimes(1);
  });

  it("resolves when the session store is absent", async () => {
    await expect(flushDefaultSession(null)).resolves.toBeUndefined();
  });
});
