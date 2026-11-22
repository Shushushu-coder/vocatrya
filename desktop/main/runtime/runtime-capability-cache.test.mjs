import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import cacheModule from "./runtime-capability-cache.js";
import probeModule from "./devin-capability-probe.js";

const { createCapabilityCache } = cacheModule;
const { evaluateDevinProbe } = probeModule;
const K = "DEVIN_RUNTIME";

describe("runtime capability cache", () => {
  it("seeds PASS and treats unknown versions as unjudged", () => {
    const c = createCapabilityCache({});
    expect(c.verdict(K, "3000.10.31", "streaming")).toBe("PASS");
    expect(c.verdict(K, "3000.10.31", "structured")).toBe("PASS");
    expect(c.verdict(K, "3000.14.30821", "structured")).toBeNull();
    expect(c.verdict(K, "9.9.9", "streaming")).toBeNull();
  });

  it("probes an unknown version once, shares concurrent callers, caches", async () => {
    const c = createCapabilityCache({});
    const probe = vi.fn(async () => ({ streaming: "PASS", structured: "PASS" }));
    const [a, b] = await Promise.all([
      c.ensure(K, "9.9.9", "streaming", probe),
      c.ensure(K, "9.9.9", "structured", probe),
    ]);
    expect([a, b]).toEqual(["PASS", "PASS"]);
    await c.ensure(K, "9.9.9", "streaming", probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("caches FAIL/UNVERIFIED in memory; a cancelled probe caches nothing", async () => {
    const c = createCapabilityCache({});
    expect(await c.ensure(K, "1", "streaming", async () => ({ streaming: "FAIL", structured: "FAIL" }))).toBe("FAIL");
    expect(await c.ensure(K, "2", "streaming", async () => { throw new Error("x"); })).toBe("UNVERIFIED");
    expect(await c.ensure(K, "3", "streaming", async () => null)).toBe("UNVERIFIED");
    expect(c.verdict(K, "3", "streaming")).toBeNull();
  });

  it("persists PASS only; restart retries FAIL; clear forgets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capcache-"));
    const filePath = path.join(dir, "runtime-capabilities.json");
    const c = createCapabilityCache({ filePath });
    await c.ensure(K, "5.0", "streaming", async () => ({ streaming: "PASS", structured: "FAIL" }));
    const disk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(disk[K]["5.0"]).toMatchObject({ streaming: "PASS", structured: "FAIL" });
    const again = createCapabilityCache({ filePath });
    expect(again.verdict(K, "5.0", "streaming")).toBe("PASS");
    expect(again.verdict(K, "5.0", "structured")).toBeNull();
    again.clear(K);
    expect(again.verdict(K, "3000.10.31", "streaming")).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("overlay: unjudged allows attempt, FAIL rebinds so version checks refuse", async () => {
    const c = createCapabilityCache({});
    const base = {
      backendKind: K,
      execution: { streamingVerifiedRuntimeVersion: [] },
      structuredOutput: { verifiedRuntimeVersion: "3000.10.31" },
    };
    const pending = c.overlayDescriptor(base, "7.0");
    expect(pending.execution.streamingVerifiedRuntimeVersion).toBe("7.0");
    expect(pending.capabilityProbe.structured).toBe("PENDING");
    await c.ensure(K, "7.0", "streaming", async () => ({ streaming: "FAIL", structured: "FAIL" }));
    const failed = c.overlayDescriptor(base, "7.0");
    expect(failed.execution.streamingVerifiedRuntimeVersion).not.toContain("7.0");
    expect(failed.structuredOutput.verifiedRuntimeVersion).not.toBe("7.0");
    expect(failed.capabilityProbe.structured).toBe("FAIL");
  });

  it("a structured probe never downgrades a seeded streaming PASS", async () => {
    const c = createCapabilityCache({});
    const v = "3000.14.30821";
    const verdict = await c.ensure(K, v, "structured", async () => ({
      streaming: "UNVERIFIED",
      structured: "UNVERIFIED",
    }));
    expect(verdict).toBe("UNVERIFIED");
    expect(c.verdict(K, v, "streaming")).toBe("PASS");
  });

  it("a probe result on a seeded version survives two restarts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capcache-"));
    const filePath = path.join(dir, "runtime-capabilities.json");
    const v = "3000.14.30821";
    const first = createCapabilityCache({ filePath });
    await first.ensure(K, v, "structured", async () => ({ streaming: "PASS", structured: "PASS" }));
    const second = createCapabilityCache({ filePath });
    expect(second.verdict(K, v, "structured")).toBe("PASS");
    // An unrelated record rewrites the file; the seeded-version entry stays.
    await second.ensure(K, "8.0", "streaming", async () => ({ streaming: "PASS", structured: "PASS" }));
    const third = createCapabilityCache({ filePath });
    expect(third.verdict(K, v, "structured")).toBe("PASS");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("UNVERIFIED expires so a later login is retried without a restart", async () => {
    let clock = new Date("2026-11-21T00:00:00Z");
    const c = createCapabilityCache({ now: () => clock, unverifiedTtlMs: 1000 });
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ streaming: "UNVERIFIED", structured: "UNVERIFIED" })
      .mockResolvedValueOnce({ streaming: "PASS", structured: "PASS" });
    expect(await c.ensure(K, "9.1", "structured", probe)).toBe("UNVERIFIED");
    expect(await c.ensure(K, "9.1", "structured", probe)).toBe("UNVERIFIED");
    expect(probe).toHaveBeenCalledTimes(1);
    const base = {
      backendKind: K,
      execution: { streamingVerifiedRuntimeVersion: [] },
      structuredOutput: { verifiedRuntimeVersion: "3000.10.31" },
    };
    expect(c.overlayDescriptor(base, "9.1").structuredOutput.verifiedRuntimeVersion).not.toBe("9.1");
    clock = new Date(clock.getTime() + 2000);
    // Expired: the overlay lets the backend pre-flight through again ...
    expect(c.overlayDescriptor(base, "9.1").structuredOutput.verifiedRuntimeVersion).toBe("9.1");
    // ... and the gate re-probes.
    expect(await c.ensure(K, "9.1", "structured", probe)).toBe("PASS");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("FAIL does not expire within the process", async () => {
    let clock = new Date("2026-11-21T00:00:00Z");
    const c = createCapabilityCache({ now: () => clock, unverifiedTtlMs: 1000 });
    await c.ensure(K, "9.2", "structured", async () => ({ streaming: "FAIL", structured: "FAIL" }));
    clock = new Date(clock.getTime() + 60_000);
    expect(c.verdict(K, "9.2", "structured")).toBe("FAIL");
  });
});

describe("evaluateDevinProbe", () => {
  const ok = '{"probe":"VOCATRYA_CAPABILITY_PROBE","ok":true}';
  it("PASS on well-formed output", () => {
    expect(evaluateDevinProbe({ chunks: [ok], exitCode: 0 })).toEqual({ streaming: "PASS", structured: "PASS" });
  });
  it("structured FAIL on non-JSON, streaming still PASS", () => {
    expect(evaluateDevinProbe({ chunks: ["hello"], exitCode: 0 })).toEqual({ streaming: "PASS", structured: "FAIL" });
  });
  it("FAIL on empty output", () => {
    expect(evaluateDevinProbe({ chunks: [], exitCode: 0 })).toEqual({ streaming: "FAIL", structured: "FAIL" });
  });
});
