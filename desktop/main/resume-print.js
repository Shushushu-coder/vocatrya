const CHANNEL = "resume:printToPDF";

function registerResumePrintIpc({ ipcMain, BrowserWindow, window, origin, timeoutMs = 30_000 }) {
  const pending = new Map();
  const windows = new Set();
  let disposed = false;

  async function render(versionId) {
    let hidden;
    let timer;
    let phase = "load_failed";
    try {
      hidden = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true, contextIsolation: true, nodeIntegration: false,
          session: window.webContents.session,
          backgroundThrottling: false,
        },
      });
      windows.add(hidden);
      const url = `${origin}/resume-print/${encodeURIComponent(versionId)}`;
      const failure = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Print timed out"), { code: "timeout" })), timeoutMs);
        const blockForeign = (event, target) => {
          const targetUrl = typeof target === "string" ? target : event.url;
          let allowed = false;
          try { allowed = new URL(targetUrl).origin === origin; } catch { /* Deny malformed URLs. */ }
          if (!allowed) {
            event.preventDefault();
            reject(Object.assign(new Error("Print navigation blocked"), { code: "load_failed" }));
          }
        };
        hidden.webContents.on("will-navigate", blockForeign);
        hidden.webContents.on("will-frame-navigate", blockForeign);
        hidden.webContents.on("will-redirect", blockForeign);
        hidden.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        hidden.webContents.on("render-process-gone", () => reject(Object.assign(new Error("Print renderer stopped"), { code: "load_failed" })));
        hidden.on("closed", () => reject(Object.assign(new Error("Print window closed"), { code: "load_failed" })));
      });
      const work = (async () => {
        await hidden.loadURL(url);
        if (hidden.isDestroyed() || hidden.webContents.getURL() !== url) throw new Error("Print page did not load");
        await hidden.webContents.executeJavaScript(`new Promise(resolve => {
          const expected = ${JSON.stringify(versionId)};
          const check = () => {
            if (document.documentElement.dataset.resumePrintReady === expected) resolve(true);
            else setTimeout(check, 50);
          };
          check();
        })`);
        if (hidden.isDestroyed()) throw new Error("Print window closed");
        phase = "print_failed";
        const bytes = await hidden.webContents.printToPDF({
          pageSize: "A4", landscape: false, printBackground: true, preferCSSPageSize: true,
        });
        return { ok: true, bytes: new Uint8Array(bytes) };
      })();
      return await Promise.race([work, failure]);
    } catch (error) {
      return { ok: false, code: ["timeout", "load_failed", "print_failed"].includes(error.code) ? error.code : phase };
    } finally {
      clearTimeout(timer);
      if (hidden) {
        windows.delete(hidden);
        if (!hidden.isDestroyed()) hidden.destroy();
      }
    }
  }

  ipcMain.handle(CHANNEL, (event, versionId) => {
    let trusted = false;
    try {
      trusted = !disposed && !window.isDestroyed() && event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin;
    } catch { /* Deny missing frames and malformed origins. */ }
    if (!trusted) return { ok: false, code: "untrusted_sender" };
    if (typeof versionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(versionId)) {
      return { ok: false, code: "invalid_version_id" };
    }
    if (!pending.has(versionId)) {
      const operation = render(versionId).finally(() => pending.delete(versionId));
      pending.set(versionId, operation);
    }
    return pending.get(versionId);
  });

  return () => {
    disposed = true;
    ipcMain.removeHandler(CHANNEL);
    for (const hidden of windows) if (!hidden.isDestroyed()) hidden.destroy();
  };
}

module.exports = { CHANNEL, registerResumePrintIpc };
