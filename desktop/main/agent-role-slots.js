// Per-user agent role slots. The renderer localStorage is partitioned by
// the backend's ephemeral loopback port, so an explicit clear saved there
// disappears on the next launch. This document lives in the desktop config
// directory (one data root) and is keyed by user id, so a new port restores
// the same account without reading another account's drafts or context.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const AGENT_ROLE_SLOTS_FILE_NAME = "agent-role-slots.json";
const MAX_DOCUMENT_CHARS = 500_000;
const MAX_USERS = 20;
const ROLES = Object.freeze(["insight", "pilot", "reflect"]);
const USER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeExplicit(value) {
  if (!isPlainObject(value)) return null;
  const { connectionId, model } = value;
  if (typeof connectionId !== "string" || typeof model !== "string") return null;
  if (!connectionId || connectionId.length > 80 || !model || model.length > 200) return null;
  return { connectionId, model };
}

function sanitizeContext(value) {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.items)) return undefined;
  if (value.items.length > 20) return undefined;
  const items = [];
  for (const item of value.items) {
    if (!isPlainObject(item)) return undefined;
    if (item.kind !== "job" && item.kind !== "resume") return undefined;
    if (typeof item.entityId !== "string" || !item.entityId || item.entityId.length > 80) return undefined;
    if (typeof item.labelSnapshot !== "string" || item.labelSnapshot.length > 500) return undefined;
    if (item.source !== "AUTO" && item.source !== "MANUAL") return undefined;
    items.push({
      kind: item.kind,
      entityId: item.entityId,
      labelSnapshot: item.labelSnapshot,
      source: item.source,
    });
  }
  return { version: 1, items };
}

function sanitizeSlot(value) {
  if (!isPlainObject(value)) return null;
  const conversationId =
    typeof value.conversationId === "string" && value.conversationId && value.conversationId.length <= 80
      ? value.conversationId
      : null;
  const draft =
    typeof value.draft === "string" && value.draft && value.draft.length <= 100_000
      ? value.draft
      : null;
  const context = sanitizeContext(value.context);
  const explicit = sanitizeExplicit(value.explicit);
  if (!conversationId && !draft && !context && !explicit) return null;
  return { conversationId, draft, context, explicit };
}

function sanitizeRecord(value) {
  if (!isPlainObject(value)) return null;
  const generation = value.generation;
  if (!Number.isInteger(generation) || generation < 1 || generation > 1_000_000_000_000) return null;
  const activeRole = ROLES.includes(value.activeRole) ? value.activeRole : null;
  if (!isPlainObject(value.slots)) return null;
  const slots = {};
  for (const role of ROLES) {
    const slot = sanitizeSlot(value.slots[role]);
    if (slot) slots[role] = slot;
  }
  if (Object.keys(value.slots).some((key) => !ROLES.includes(key))) return null;
  return { generation, activeRole, slots };
}

function loadUsers(filePath, fsImpl) {
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true, users: {} };
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.users)) return { ok: false };
    return { ok: true, users: parsed.users };
  } catch {
    return { ok: false };
  }
}

function writeUsers(filePath, users, fsImpl) {
  const next = `${JSON.stringify({ version: 1, users })}\n`;
  if (next.length > MAX_DOCUMENT_CHARS) {
    const error = new Error("Agent role slot document is too large");
    error.code = "INVALID";
    throw error;
  }
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(temporary, next, "utf8");
    fsImpl.renameSync(temporary, filePath);
  } catch (error) {
    try { fsImpl.rmSync(temporary, { force: true }); } catch { /* Preserve the write failure. */ }
    throw error;
  }
}

function createAgentRoleSlotStore({ filePath, fsImpl = fs } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("Agent role slot file path is required");
  }

  function read(userId) {
    if (!USER_ID_RE.test(userId)) return null;
    const loaded = loadUsers(filePath, fsImpl);
    if (!loaded.ok) return null;
    const record = sanitizeRecord(loaded.users[userId]);
    return record ? JSON.stringify(record) : null;
  }

  function write(userId, raw) {
    if (!USER_ID_RE.test(userId)) {
      const error = new Error("Invalid agent slot owner");
      error.code = "INVALID";
      throw error;
    }
    if (typeof raw !== "string" || raw.length > MAX_DOCUMENT_CHARS) {
      const error = new Error("Invalid agent slot record");
      error.code = "INVALID";
      throw error;
    }
    const record = sanitizeRecord(JSON.parse(raw));
    if (!record) {
      const error = new Error("Invalid agent slot record");
      error.code = "INVALID";
      throw error;
    }
    const loaded = loadUsers(filePath, fsImpl);
    if (!loaded.ok) {
      const error = new Error("Agent role slot document is unreadable");
      error.code = "UNAVAILABLE";
      throw error;
    }
    const existing = sanitizeRecord(loaded.users[userId]);
    if (existing && record.generation <= existing.generation) {
      const error = new Error("Stale agent slot record");
      error.code = "STALE";
      throw error;
    }
    if (!existing && Object.keys(loaded.users).length >= MAX_USERS) {
      const error = new Error("Agent role slot document is full");
      error.code = "INVALID";
      throw error;
    }
    const users = { ...loaded.users, [userId]: record };
    writeUsers(filePath, users, fsImpl);
    return JSON.stringify(record);
  }

  return { filePath, read, write };
}

function trustedSender(event, getWindow, getOrigin) {
  const win = getWindow();
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
  if (event.senderFrame !== win.webContents.mainFrame) return false;
  try {
    return new URL(event.senderFrame.url).origin === getOrigin();
  } catch {
    return false;
  }
}

function registerAgentRoleSlotsIpc({ ipcMain, filePath, getWindow, getOrigin, fsImpl = fs }) {
  const store = createAgentRoleSlotStore({ filePath, fsImpl });
  ipcMain.on("agentRoleSlots:read", (event, userId) => {
    if (!trustedSender(event, getWindow, getOrigin)) {
      event.returnValue = { ok: false, code: "unavailable" };
      return;
    }
    try {
      event.returnValue = { ok: true, value: store.read(userId) };
    } catch {
      event.returnValue = { ok: false, code: "unavailable" };
    }
  });
  ipcMain.on("agentRoleSlots:write", (event, payload) => {
    if (!trustedSender(event, getWindow, getOrigin)) {
      event.returnValue = { ok: false, code: "unavailable" };
      return;
    }
    try {
      store.write(payload?.userId, payload?.raw);
      event.returnValue = { ok: true };
    } catch (error) {
      const code = error && error.code === "STALE"
        ? "stale"
        : error && error.code === "INVALID"
          ? "invalid"
          : "unavailable";
      event.returnValue = { ok: false, code };
    }
  });
  return store;
}

module.exports = {
  AGENT_ROLE_SLOTS_FILE_NAME,
  createAgentRoleSlotStore,
  registerAgentRoleSlotsIpc,
};
