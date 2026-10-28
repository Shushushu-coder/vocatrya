// Device input preferences must outlive the backend's ephemeral loopback port.
const fs = require("node:fs");
const path = require("node:path");

function validateSnapshot(raw) {
  if (typeof raw !== "string" || raw.length > 1024) throw new Error("Invalid input preferences");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      !["newline", "next"].includes(value.enterBehavior) ||
      !["click", "end", "select-all"].includes(value.editEntry) ||
      !["always", "focus", "off"].includes(value.hintMode) ||
      typeof value.autoFocus !== "boolean") throw new Error("Invalid input preferences");
  return JSON.stringify(value);
}

function registerInputPreferencesIpc({ ipcMain, filePath, getWindow, getOrigin, fsImpl = fs }) {
  let loaded = false;
  let snapshot = null;
  function read() {
    if (!loaded) {
      try { snapshot = validateSnapshot(fsImpl.readFileSync(filePath, "utf8")); }
      catch (error) {
        // Missing/corrupt snapshots use defaults. I/O failures remain failures.
        if (error.code && error.code !== "ENOENT") throw error;
      }
      loaded = true;
    }
    return snapshot;
  }
  function write(raw) {
    const next = validateSnapshot(raw);
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    try {
      fsImpl.writeFileSync(temporary, next, "utf8");
      fsImpl.renameSync(temporary, filePath);
    } catch (error) {
      try { fsImpl.rmSync(temporary, { force: true }); } catch { /* Preserve write failure. */ }
      throw error;
    }
    snapshot = next;
    loaded = true;
    return next;
  }
  const handlers = {
    "inputPreferences:read": () => read(),
    "inputPreferences:write": (_event, raw) => write(raw),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.on(channel, (event, raw) => {
      try {
        const win = getWindow();
        if (!win || win.isDestroyed() || event.sender !== win.webContents ||
            event.senderFrame !== win.webContents.mainFrame ||
            new URL(event.senderFrame.url).origin !== getOrigin()) throw new Error("Untrusted sender");
        event.returnValue = { ok: true, value: handler(event, raw) };
      } catch {
        event.returnValue = { ok: false };
      }
    });
  }
}

module.exports = { registerInputPreferencesIpc };
