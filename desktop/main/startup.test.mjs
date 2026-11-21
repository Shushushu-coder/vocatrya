import { describe, expect, it } from "vitest";
import { runStartupSequence, startupPageUrl } from "./startup.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("startup sequencing", () => {
  it("does not spawn the backend while the database phase is still running", async () => {
    const gate = deferred();
    let spawnCalls = 0;
    const sequence = runStartupSequence({
      prepareDatabase: () => gate.promise,
      startBackend: async () => {
        spawnCalls += 1;
        return { port: 1 };
      },
      createWindow: async () => {},
    });
    await tick();
    await tick();
    expect(spawnCalls).toBe(0);
    gate.resolve({ kind: "fresh-absent" });
    await sequence;
    expect(spawnCalls).toBe(1);
  });

  it("never starts the backend when database preparation fails", async () => {
    let spawnCalls = 0;
    let failure;
    await expect(
      runStartupSequence({
        prepareDatabase: async () => {
          throw new Error("database migration failed with exit code 1 (see C:\\logs\\migration.log)");
        },
        startBackend: async () => {
          spawnCalls += 1;
          return { port: 1 };
        },
        createWindow: async () => {},
        onFailure: async (error) => {
          failure = error;
        },
      }),
    ).rejects.toThrow(/migration failed/);
    expect(spawnCalls).toBe(0);
    expect(String(failure && failure.message)).toContain("migration.log");
  });

  it("runs database preparation exactly once across backend retries", async () => {
    let prepareCalls = 0;
    let spawnCalls = 0;
    await runStartupSequence({
      prepareDatabase: async () => {
        prepareCalls += 1;
        return { kind: "existing" };
      },
      startBackend: async () => {
        // Backend port/readiness retry loop lives inside startBackend.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          spawnCalls += 1;
          if (attempt < 2) continue;
          return { port: 43210 };
        }
        throw new Error("unreachable");
      },
      createWindow: async () => {},
    });
    expect(prepareCalls).toBe(1);
    expect(spawnCalls).toBe(3);
  });

  it("does not load the application page when the backend never becomes ready", async () => {
    let windowCalls = 0;
    await expect(
      runStartupSequence({
        prepareDatabase: async () => ({ kind: "fresh-absent" }),
        startBackend: async () => {
          throw new Error("readiness timed out");
        },
        createWindow: async () => {
          windowCalls += 1;
        },
      }),
    ).rejects.toThrow(/readiness/);
    expect(windowCalls).toBe(0);
  });
});

it("shows the embedded Vocatrya logo while startup is pending", () => {
  const logo = "data:image/png;base64,AAAA";
  const url = startupPageUrl(logo);
  const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  expect(html).toContain(`<img src="${logo}" alt="Vocatrya">`);
  expect(html).toContain("place-items: center");
  expect(html).toContain("default-src 'none'");
});
