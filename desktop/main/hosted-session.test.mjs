import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
const require = createRequire(import.meta.url);
const { createHostedSessionStore, resolveHostedSessionDirectory, startHostedSessionBroker } = require("./hosted-session.js");
const { buildDesktopLayout } = require("./local-data.js");
const token = "a".repeat(43);
function storage() { return { isEncryptionAvailable: () => true, encryptString: value => Buffer.from([...value].reverse().join("")), decryptString: value => [...value.toString()].reverse().join("") }; }
describe("hosted session directory selection", () => {
  it("isolates sessions under each dev data root config dir", () => {
    const rootA = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), "m2-root-a-")));
    const rootB = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), "m2-root-b-")));
    try {
      const stateRoot = path.join(os.tmpdir(), "shared-poc-state");
      const dirA = resolveHostedSessionDirectory({ isPackaged: false, foundationLayout: buildDesktopLayout(rootA), stateRoot });
      const dirB = resolveHostedSessionDirectory({ isPackaged: false, foundationLayout: buildDesktopLayout(rootB), stateRoot });
      expect(dirA).toBe(path.join(rootA, "config", "hosted-sessions"));
      expect(dirB).toBe(path.join(rootB, "config", "hosted-sessions"));
      expect(dirA).not.toBe(dirB);
      const store = createHostedSessionStore({ directory: dirA, safeStorage: storage() });
      store.save("local-a", token);
      expect(store.read("local-a")).toBe(token);
      expect(fs.readdirSync(dirA).length).toBe(1);
      store.clear("local-a");
      expect(store.read("local-a")).toBeNull();
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
  it("keeps the disposable state-root fallback when dev has no data-root override", () => {
    const stateRoot = path.join(os.tmpdir(), "vocatrya-poc-state");
    expect(resolveHostedSessionDirectory({ isPackaged: false, foundationLayout: null, stateRoot }))
      .toBe(path.join(stateRoot, "hosted-sessions"));
  });
  it("keeps the packaged state-root location even when the foundation layout is active", () => {
    const root = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), "m2-root-pkg-")));
    try {
      const stateRoot = path.join(root, "electron", "desktop-poc");
      expect(resolveHostedSessionDirectory({ isPackaged: true, foundationLayout: buildDesktopLayout(root), stateRoot }))
        .toBe(path.join(stateRoot, "hosted-sessions"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
describe("OS-backed hosted session boundary", () => {
  it("stores only ciphertext, binds local users, persists across restart and supports clear", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m2-session-"));
    const safeStorage = storage(); const distinctToken = "a".repeat(42) + "b";
    let server;
    try {
      const store = createHostedSessionStore({ directory, safeStorage }); store.save("local-a", distinctToken);
      expect(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0])).toString()).not.toContain(distinctToken);
      expect(createHostedSessionStore({ directory, safeStorage }).read("local-a")).toBe(distinctToken); expect(store.read("local-b")).toBeNull();
      const broker = await startHostedSessionBroker({ token: "internal-test", store }); server = broker.server;
      expect((await fetch(broker.url + "/session?localUserId=local-a")).status).toBe(401);
      const headers = { authorization: "Bearer internal-test" };
      expect(await (await fetch(broker.url + "/session?localUserId=local-a", { headers })).json()).toEqual({ token: distinctToken });
      expect((await fetch(broker.url + "/session?localUserId=local-b", { headers })).status).toBe(401);
      store.clear("local-a"); expect(store.read("local-a")).toBeNull();
    } finally { await new Promise(resolve => server ? server.close(resolve) : resolve()); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("backend write/clear channel persists encrypted sessions and rejects malformed input", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m2-session-"));
    let server;
    try {
      const store = createHostedSessionStore({ directory, safeStorage: storage() });
      const broker = await startHostedSessionBroker({ token: "internal-test", store }); server = broker.server;
      const headers = { authorization: "Bearer internal-test", "content-type": "application/json" };
      const userToken = "b".repeat(42) + "c";
      expect((await fetch(broker.url + "/session", { method: "PUT", headers, body: JSON.stringify({ localUserId: "local-a", token: userToken }) })).status).toBe(200);
      const saved = path.join(directory, fs.readdirSync(directory)[0]);
      expect(fs.readFileSync(saved).toString()).not.toContain(userToken);
      expect(await (await fetch(broker.url + "/session?localUserId=local-a", { headers })).json()).toEqual({ token: userToken });
      expect((await fetch(broker.url + "/session", { method: "PUT", body: JSON.stringify({ localUserId: "local-a", token: "c".repeat(43) }) })).status).toBe(401);
      for (const body of [{ localUserId: "local-a", token: "short" }, { localUserId: "", token: userToken }, "nope"]) {
        expect((await fetch(broker.url + "/session", { method: "PUT", headers, body: JSON.stringify(body) })).status).toBe(400);
      }
      expect((await fetch(broker.url + "/session", { method: "DELETE", headers })).status).toBe(400);
      expect((await fetch(broker.url + "/session?localUserId=local-a", { method: "DELETE" })).status).toBe(401);
      expect((await fetch(broker.url + "/session?localUserId=local-a", { method: "DELETE", headers })).status).toBe(200);
      expect((await fetch(broker.url + "/session?localUserId=local-a", { headers })).status).toBe(401);
      expect((await fetch(broker.url + "/session?localUserId=local-a", { method: "DELETE", headers })).status).toBe(200);
      expect((await fetch(broker.url + "/session?localUserId=local-a", { method: "PATCH", headers })).status).toBe(404);
    } finally { await new Promise(resolve => server ? server.close(resolve) : resolve()); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("fails closed with unavailable OS crypto or insecure fallback", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m2-session-"));
    try {
      for (const safeStorage of [{ ...storage(), isEncryptionAvailable: () => false }, { ...storage(), getSelectedStorageBackend: () => "basic_text" }]) {
        expect(() => createHostedSessionStore({ directory, safeStorage }).save("a", token)).toThrow(); expect(fs.readdirSync(directory)).toEqual([]);
      }
      const store = createHostedSessionStore({ directory, safeStorage: storage() }); store.save("a", token);
      for (const safeStorage of [{ ...storage(), isEncryptionAvailable: () => false }, { ...storage(), getSelectedStorageBackend: () => "basic_text" }]) {
        expect(() => createHostedSessionStore({ directory, safeStorage }).read("a")).toThrow();
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("converges a confirmed-dead session blob to no-session and removes it", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m2-session-"));
    let server;
    try {
      // Content that decrypts cleanly but is not a session token is provably
      // dead — read converges to null and drops the file.
      const store = createHostedSessionStore({ directory, safeStorage: storage() });
      for (const corrupt of ["corrupt", Buffer.alloc(0)]) {
        store.save("a", token);
        fs.writeFileSync(path.join(directory, fs.readdirSync(directory)[0]), corrupt);
        expect(store.read("a")).toBeNull();
        expect(fs.readdirSync(directory)).toEqual([]);
      }
      // The conditional clear cannot compare a dead blob, but the read's
      // self-heal already removed it — clear reports "not cleared" honestly.
      store.save("a", token);
      fs.writeFileSync(path.join(directory, fs.readdirSync(directory)[0]), "corrupt");
      expect(store.clear("a", token)).toBe(false);
      expect(fs.readdirSync(directory)).toEqual([]);
      // Broker level: a confirmed-dead file answers the same as no session.
      store.save("a", token);
      fs.writeFileSync(path.join(directory, fs.readdirSync(directory)[0]), "corrupt");
      const broker = await startHostedSessionBroker({ token: "internal-test", store }); server = broker.server;
      const headers = { authorization: "Bearer internal-test" };
      expect((await fetch(broker.url + "/session?localUserId=a", { headers })).status).toBe(401);
      expect(fs.readdirSync(directory)).toEqual([]);
    } finally { await new Promise(resolve => server ? server.close(resolve) : resolve()); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("keeps ciphertext and fails honestly when decryption itself is unavailable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m2-session-"));
    let server;
    try {
      // A decrypt throw cannot be distinguished from a temporarily
      // unavailable key — the blob must be kept and the failure surfaced
      // as a storage error, never collapsed to "no session" + deletion.
      const failingStorage = { ...storage(), decryptString: () => { throw new Error("os decrypt failed"); } };
      const store = createHostedSessionStore({ directory, safeStorage: failingStorage });
      store.save("a", token);
      const target = path.join(directory, fs.readdirSync(directory)[0]);
      expect(() => store.read("a")).toThrow();
      expect(fs.existsSync(target)).toBe(true);
      // A later working store can still recover the same session — proof
      // the ciphertext was preserved rather than dropped.
      expect(createHostedSessionStore({ directory, safeStorage: storage() }).read("a")).toBe(token);
      const broker = await startHostedSessionBroker({ token: "internal-test", store }); server = broker.server;
      const headers = { authorization: "Bearer internal-test" };
      expect((await fetch(broker.url + "/session?localUserId=a", { headers })).status).toBe(400);
      expect(fs.existsSync(target)).toBe(true);
      // Conditional clear must not drop ciphertext it cannot compare.
      expect(() => store.clear("a", token)).toThrow();
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target).length).toBeGreaterThan(0);
    } finally { await new Promise(resolve => server ? server.close(resolve) : resolve()); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("keeps transient filesystem failures distinct from an absent session", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m2-session-"));
    let server;
    try {
      const store = createHostedSessionStore({ directory, safeStorage: storage() });
      store.save("a", token);
      // A directory at the session path makes readFileSync fail with a
      // non-ENOENT error — transient storage faults must not collapse to
      // "no session" (which would silently desync UI and disk).
      const target = path.join(directory, fs.readdirSync(directory)[0]);
      fs.rmSync(target); fs.mkdirSync(target);
      expect(() => store.read("a")).toThrow();
      expect(fs.existsSync(target)).toBe(true);
      const broker = await startHostedSessionBroker({ token: "internal-test", store }); server = broker.server;
      const headers = { authorization: "Bearer internal-test" };
      expect((await fetch(broker.url + "/session?localUserId=a", { headers })).status).toBe(400);
      expect(fs.existsSync(target)).toBe(true);
    } finally { await new Promise(resolve => server ? server.close(resolve) : resolve()); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("logs sanitized request results without query, bearer or session material", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m2-session-"));
    let server;
    try {
      const lines = [];
      const logger = { info: (line) => lines.push(line) };
      const store = createHostedSessionStore({ directory, safeStorage: storage() });
      store.save("local-a", token);
      const broker = await startHostedSessionBroker({ token: "internal-test", store, logger }); server = broker.server;
      const headers = { authorization: "Bearer internal-test" };
      await fetch(broker.url + "/session?localUserId=local-a", { headers });
      await fetch(broker.url + "/session?localUserId=local-a");
      await fetch(broker.url + "/" + token);
      expect(lines.some(line => line.includes("GET /session -> 200"))).toBe(true);
      expect(lines.some(line => line.includes("GET /session -> 401"))).toBe(true);
      expect(lines.some(line => line.includes("GET unknown-route -> 401"))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain("local-a");
        expect(line).not.toContain(token);
        expect(line).not.toContain("internal-test");
      }
    } finally { await new Promise(resolve => server ? server.close(resolve) : resolve()); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
