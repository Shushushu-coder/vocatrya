import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { registerAgentRoleSlotsIpc } = createRequire(import.meta.url)("./agent-role-slots.js");
const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";

function record(generation, slots, activeRole = "pilot") {
  return JSON.stringify({ generation, activeRole, slots });
}

const cleared = record(2, {
  pilot: {
    conversationId: null,
    draft: null,
    context: { version: 1, items: [] },
    explicit: null,
  },
});

function bridge(filePath, fsImpl, origin = "http://127.0.0.1:54662") {
  const handlers = new Map();
  const mainFrame = { url: `${origin}/dashboard/myjobs/job-9` };
  const win = { isDestroyed: () => false, webContents: { mainFrame } };
  registerAgentRoleSlotsIpc({
    ipcMain: { on: (name, fn) => handlers.set(name, fn) },
    filePath,
    fsImpl,
    getWindow: () => win,
    getOrigin: () => origin,
  });
  return (operation, payload, overrides = {}) => {
    const event = { sender: win.webContents, senderFrame: mainFrame, ...overrides };
    handlers.get(`agentRoleSlots:${operation}`)(event, payload);
    return event.returnValue;
  };
}

describe("agent role slots across loopback ports", () => {
  it("keeps an explicit clear for one user when the renderer origin changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-agent-slots-"));
    try {
      const file = path.join(dir, "config", "agent-role-slots.json");
      const first = bridge(file, undefined, "http://127.0.0.1:54662");
      expect(first("read", userA)).toEqual({ ok: true, value: null });
      expect(first("write", { userId: userA, raw: cleared })).toEqual({ ok: true });
      const second = bridge(file, undefined, "http://127.0.0.1:62651");
      const restored = JSON.parse(second("read", userA).value);
      expect(restored.slots.pilot.context).toEqual({ version: 1, items: [] });
      expect(fs.readdirSync(path.dirname(file))).toEqual(["agent-role-slots.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolates users and data roots", () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-agent-root-a-"));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-agent-root-b-"));
    try {
      const fileA = path.join(rootA, "config", "agent-role-slots.json");
      const fileB = path.join(rootB, "config", "agent-role-slots.json");
      const storeA = bridge(fileA);
      const storeB = bridge(fileB);
      expect(storeA("write", { userId: userA, raw: cleared })).toEqual({ ok: true });
      expect(storeA("read", userB)).toEqual({ ok: true, value: null });
      expect(storeB("read", userA)).toEqual({ ok: true, value: null });
      const manual = record(1, {
        insight: {
          conversationId: "conv-b",
          draft: "only b",
          context: {
            version: 1,
            items: [{ kind: "job", entityId: "job-b", labelSnapshot: "B", source: "MANUAL" }],
          },
          explicit: null,
        },
      }, "insight");
      expect(storeA("write", { userId: userB, raw: manual })).toEqual({ ok: true });
      expect(JSON.parse(storeA("read", userA).value).slots.pilot.context.items).toEqual([]);
      expect(JSON.parse(storeA("read", userB).value).slots.insight.conversationId).toBe("conv-b");
      expect(storeB("read", userB)).toEqual({ ok: true, value: null });
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("rejects a stale generation and a failed write without replacing the clear", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-agent-stale-"));
    try {
      const file = path.join(dir, "config", "agent-role-slots.json");
      const store = bridge(file);
      expect(store("write", { userId: userA, raw: cleared })).toEqual({ ok: true });
      const older = record(1, {
        pilot: {
          conversationId: null,
          draft: null,
          context: {
            version: 1,
            items: [{ kind: "job", entityId: "job-a", labelSnapshot: "A", source: "AUTO" }],
          },
          explicit: null,
        },
      });
      expect(store("write", { userId: userA, raw: older })).toEqual({ ok: false, code: "stale" });
      expect(JSON.parse(store("read", userA).value).slots.pilot.context.items).toEqual([]);
      const failing = bridge(file, {
        readFileSync: fs.readFileSync,
        mkdirSync() {},
        writeFileSync() {},
        renameSync() { throw new Error("disk full"); },
        rmSync() {},
      });
      expect(failing("write", { userId: userA, raw: record(3, JSON.parse(cleared).slots) })).toEqual({
        ok: false,
        code: "unavailable",
      });
      expect(JSON.parse(fs.readFileSync(file, "utf8")).users[userA].generation).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects untrusted senders and does not replace a corrupt document", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-agent-corrupt-"));
    try {
      const file = path.join(dir, "config", "agent-role-slots.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{not json");
      const store = bridge(file);
      expect(store("read", userA, { sender: {} })).toEqual({ ok: false, code: "unavailable" });
      expect(store("write", { userId: userA, raw: cleared }, {
        senderFrame: { url: "http://127.0.0.1:9999/dashboard" },
      })).toEqual({ ok: false, code: "unavailable" });
      expect(store("write", { userId: userA, raw: cleared })).toEqual({ ok: false, code: "unavailable" });
      expect(fs.readFileSync(file, "utf8")).toBe("{not json");
      expect(store("write", { userId: "not-a-user", raw: cleared })).toEqual({ ok: false, code: "invalid" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
