// Validated device preference snapshot — the app-owned config file that a
// device-local renderer preference lives in so it outlives the backend's
// ephemeral loopback port. Callers supply the domain validator and the
// channel names; this module owns caching, atomic writes and sender checks.
const fs = require("node:fs");
const path = require("node:path");

function registerSnapshotPreferenceIpc({ ipcMain, filePath, getWindow, getOrigin, channels, validate, fsImpl = fs }) {
  let loaded = false;
  let snapshot = null;
  function read() {
    if (!loaded) {
      try { snapshot = validate(fsImpl.readFileSync(filePath, "utf8")); }
      catch (error) {
        // Missing/corrupt snapshots use defaults. I/O failures remain failures.
        if (error.code && error.code !== "ENOENT") throw error;
      }
      loaded = true;
    }
    return snapshot;
  }
  function write(raw) {
    const next = validate(raw);
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
    [channels.read]: () => read(),
    [channels.write]: (_event, raw) => write(raw),
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

module.exports = { registerSnapshotPreferenceIpc };
