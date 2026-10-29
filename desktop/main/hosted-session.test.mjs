import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
const require = createRequire(import.meta.url);
const { createHostedSessionStore, startHostedSessionBroker } = require("./hosted-session.js");
const token = "a".repeat(43);
function storage() { return { isEncryptionAvailable: () => true, encryptString: value => Buffer.from([...value].reverse().join("")), decryptString: value => [...value.toString()].reverse().join("") }; }
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
  it("fails closed with unavailable OS crypto, insecure fallback or corrupt encrypted token", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "m2-session-"));
    try {
      for (const safeStorage of [{ ...storage(), isEncryptionAvailable: () => false }, { ...storage(), getSelectedStorageBackend: () => "basic_text" }]) {
        expect(() => createHostedSessionStore({ directory, safeStorage }).save("a", token)).toThrow(); expect(fs.readdirSync(directory)).toEqual([]);
      }
      const store = createHostedSessionStore({ directory, safeStorage: storage() }); store.save("a", token);
      fs.writeFileSync(path.join(directory, fs.readdirSync(directory)[0]), "corrupt"); expect(() => store.read("a")).toThrow();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
