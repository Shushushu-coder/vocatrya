// Phase C preload: expose a narrow, registry-keyed runtime surface. The
// renderer can ask for runtime metadata/detection/status by backendKind —
// it can never supply an executable, args, cwd, env, or a command string,
// and it cannot read profile credential files or the process environment.
//
// Phase D adds vocatryaAi: account-login operations keyed by a
// session-minted ticket plus a connectionId. Still no executable, args,
// env, profile path, or free-form command crosses the bridge.
//
// vocatryaDesktop adds the device-level lifecycle surface: boolean
// preferences (close-to-tray, launch minimized), the OS-owned login-item
// toggle whose state is verified by the main process, and window
// restore/quit. No paths, commands, or credentials cross this bridge.
const { contextBridge, ipcRenderer } = require("electron");

// A small synchronous snapshot keeps the existing immediate preference API.
// The main process accepts only validated snapshot values, never a path or key.
function preferenceRequest(channel, raw) {
  const result = ipcRenderer.sendSync(channel, raw);
  if (!result?.ok) throw new Error("Preferences storage unavailable");
  return result.value;
}
contextBridge.exposeInMainWorld("vocatryaInputPreferences", {
  read: () => preferenceRequest("inputPreferences:read"),
  write: (raw) => preferenceRequest("inputPreferences:write", raw),
});

// Mark Electron-hosted documents before first paint so CSS can reveal the
// desktop-only chrome (custom titlebar strip, window-drag regions). The
// marker is a plain DOM attribute — it grants the page no new capability;
// the window controls themselves stay native via titleBarOverlay.
if (typeof document !== "undefined" && typeof window !== "undefined") {
  const DESKTOP_ATTR = "data-desktop";
  const markDesktopShell = () =>
    document.documentElement?.setAttribute(DESKTOP_ATTR, "true");
  const armDesktopShell = () => {
    markDesktopShell();
    // App Router refreshes (e.g. locale switch) re-render the <html> element
    // and drop imperatively-set attributes. Re-assert the marker so the
    // desktop-only chrome survives any renderer re-render.
    new MutationObserver(() => {
      if (
        document.documentElement &&
        !document.documentElement.hasAttribute(DESKTOP_ATTR)
      ) {
        markDesktopShell();
      }
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: [DESKTOP_ATTR],
    });
  };
  if (document.documentElement) armDesktopShell();
  else window.addEventListener("DOMContentLoaded", armDesktopShell, { once: true });
}

contextBridge.exposeInMainWorld("vocatryaWindow", {
  setTheme: (theme, preference) => ipcRenderer.invoke("window:setTheme", theme, preference),
});

contextBridge.exposeInMainWorld("vocatryaResume", {
  printToPDF: (versionId) => ipcRenderer.invoke("resume:printToPDF", versionId),
  // Resume preview pane hidden/width snapshot — a device preference stored
  // beside input preferences so it survives the ephemeral backend port.
  readPreviewPreferences: () => preferenceRequest("resumePreviewPreferences:read"),
  writePreviewPreferences: (raw) => preferenceRequest("resumePreviewPreferences:write", raw),
});

const RUNTIME_CHANNELS = Object.freeze({
  list: "runtime:list",
  detect: "runtime:detect",
  getVersion: "runtime:getVersion",
  getStatus: "runtime:getStatus",
  getInstallInfo: "runtime:getInstallInfo",
  getUpdateInfo: "runtime:getUpdateInfo",
  checkUpdate: "runtime:checkUpdate",
});

const AI_CONNECTION_CHANNELS = Object.freeze({
  startLogin: "aiConnection:startLogin",
  cancelOperation: "aiConnection:cancelOperation",
  reconnect: "aiConnection:reconnect",
  disconnect: "aiConnection:disconnect",
  verify: "aiConnection:verify",
  listModels: "aiConnection:listModels",
  runSmoke: "aiConnection:runSmoke",
});

// Main → renderer events.
const AI_CONNECTION_EVENTS = Object.freeze({
  oauthUrl: "aiConnection:oauthUrl",
});

contextBridge.exposeInMainWorld("vocatryaRuntime", {
  list: () => ipcRenderer.invoke(RUNTIME_CHANNELS.list),
  detect: (backendKind) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.detect, { backendKind }),
  getVersion: (backendKind) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.getVersion, { backendKind }),
  getStatus: (backendKind, runtimeProfileRef) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.getStatus, {
      backendKind,
      runtimeProfileRef,
    }),
  getInstallInfo: (backendKind) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.getInstallInfo, { backendKind }),
  getUpdateInfo: (backendKind) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.getUpdateInfo, { backendKind }),
  // Read-only upstream update check shared by the automatic mount-time
  // check and the manual recheck ({ force: true } bypasses the cache).
  checkUpdate: (backendKind, options) =>
    ipcRenderer.invoke(RUNTIME_CHANNELS.checkUpdate, {
      backendKind,
      force: options?.force === true,
    }),
});

contextBridge.exposeInMainWorld("vocatryaAi", {
  startLogin: ({ backendKind, ticket }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.startLogin, {
      backendKind,
      ticket,
    }),
  cancelOperation: ({ ticket, connectionId }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.cancelOperation, {
      ticket,
      connectionId,
    }),
  reconnect: ({ connectionId, ticket }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.reconnect, {
      connectionId,
      ticket,
    }),
  disconnect: ({ connectionId, ticket }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.disconnect, {
      connectionId,
      ticket,
    }),
  verify: ({ connectionId, ticket }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.verify, {
      connectionId,
      ticket,
    }),
  listModels: ({ connectionId, ticket }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.listModels, {
      connectionId,
      ticket,
    }),
  runSmoke: ({ connectionId, ticket, model }) =>
    ipcRenderer.invoke(AI_CONNECTION_CHANNELS.runSmoke, {
      connectionId,
      ticket,
      model,
    }),
  // Subscribe to the vendor OAuth authorize URL while a login runs —
  // for runtimes that cannot open a browser themselves. Returns an
  // unsubscribe function.
  onOAuthUrl: (callback) => {
    const listener = (_event, url) => {
      if (typeof url === "string") callback(url);
    };
    ipcRenderer.on(AI_CONNECTION_EVENTS.oauthUrl, listener);
    return () =>
      ipcRenderer.removeListener(AI_CONNECTION_EVENTS.oauthUrl, listener);
  },
});

const DESKTOP_LIFECYCLE_CHANNELS = Object.freeze({
  getState: "desktopLifecycle:getState",
  setCloseToTray: "desktopLifecycle:setCloseToTray",
  setStartMinimized: "desktopLifecycle:setStartMinimized",
  setOpenAtLogin: "desktopLifecycle:setOpenAtLogin",
  showWindow: "desktopLifecycle:showWindow",
  quit: "desktopLifecycle:quit",
});

const DESKTOP_SHORTCUT_CHANNELS = Object.freeze({
  getState: "desktopShortcuts:getState",
  setWindowBinding: "desktopShortcuts:setWindowBinding",
  setGlobalToggle: "desktopShortcuts:setGlobalToggle",
});

contextBridge.exposeInMainWorld("vocatryaDesktop", {
  getState: () => ipcRenderer.invoke(DESKTOP_LIFECYCLE_CHANNELS.getState),
  setCloseToTray: (enabled) =>
    ipcRenderer.invoke(DESKTOP_LIFECYCLE_CHANNELS.setCloseToTray, { enabled }),
  setStartMinimized: (enabled) =>
    ipcRenderer.invoke(DESKTOP_LIFECYCLE_CHANNELS.setStartMinimized, { enabled }),
  // OS-owned login item: resolves to the verified post-write state, rejects
  // when the OS write does not take effect.
  setOpenAtLogin: (enabled) =>
    ipcRenderer.invoke(DESKTOP_LIFECYCLE_CHANNELS.setOpenAtLogin, { enabled }),
  showWindow: () => ipcRenderer.invoke(DESKTOP_LIFECYCLE_CHANNELS.showWindow),
  quit: () => ipcRenderer.invoke(DESKTOP_LIFECYCLE_CHANNELS.quit),
  // Device keybindings: window-scope combos are canonical "Mod/Alt/Shift+Key"
  // strings (null clears a binding); the global toggle writes intent and
  // reports the live OS registration status back.
  getShortcutState: () =>
    ipcRenderer.invoke(DESKTOP_SHORTCUT_CHANNELS.getState),
  setWindowShortcut: (input) =>
    ipcRenderer.invoke(DESKTOP_SHORTCUT_CHANNELS.setWindowBinding, input),
  setGlobalShortcut: (input) =>
    ipcRenderer.invoke(DESKTOP_SHORTCUT_CHANNELS.setGlobalToggle, input),
});
