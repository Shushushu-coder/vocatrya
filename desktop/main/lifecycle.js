// Vocatrya Windows desktop lifecycle: close-to-tray, tray restore, explicit
// quit, launch-minimized, and OS-owned login items.
//
// State contract:
// - closeToTray / startMinimized live in the app-owned device settings
//   document (desktop-settings.js) and are read live at decision time.
// - openAtLogin is OS state: it is read via the login-items adapter and every
//   write is verified by reading the OS state back. A reported value is
//   never optimistic — a write that does not land throws instead of faking
//   success.
// - quit() latches a quitting flag so the close-to-tray interception can
//   never swallow a real exit, and a hidden window is never presented as a
//   successful quit.
"use strict";

const LIFECYCLE_IPC_CHANNELS = Object.freeze({
  getState: "desktopLifecycle:getState",
  setCloseToTray: "desktopLifecycle:setCloseToTray",
  setStartMinimized: "desktopLifecycle:setStartMinimized",
  setOpenAtLogin: "desktopLifecycle:setOpenAtLogin",
  showWindow: "desktopLifecycle:showWindow",
  quit: "desktopLifecycle:quit",
});

// OS login items adapter. Windows uses the registry Run key via Electron's
// setLoginItemSettings with an explicit exe path: packaged launches
// Vocatrya.exe, development registers electron.exe with the app path so the
// entry still launches this app. macOS is handled by Electron natively;
// other platforms report unsupported instead of pretending to work.
function createLoginItemsAdapter({ app, platform = process.platform }) {
  const supported =
    (platform === "win32" || platform === "darwin") &&
    app &&
    typeof app.getLoginItemSettings === "function" &&
    typeof app.setLoginItemSettings === "function";
  if (!supported) {
    return { supported: false };
  }
  return {
    supported: true,
    getOpenAtLogin() {
      return Boolean(app.getLoginItemSettings().openAtLogin);
    },
    setOpenAtLogin(enabled) {
      if (platform === "win32") {
        app.setLoginItemSettings({
          openAtLogin: enabled,
          path: process.execPath,
          args: app.isPackaged ? [] : [app.getAppPath()],
        });
      } else {
        app.setLoginItemSettings({ openAtLogin: enabled });
      }
    },
  };
}

function readEnabledArgument(payload) {
  const enabled =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload.enabled
      : payload;
  if (typeof enabled !== "boolean") {
    throw new Error("Lifecycle setting payload requires a boolean enabled value");
  }
  return enabled;
}

function createDesktopLifecycle({
  app,
  Tray = null,
  Menu = null,
  nativeImage = null,
  trayIconPath = null,
  trayTooltip = "Vocatrya",
  trayOpenLabel = "打开 Vocatrya",
  trayQuitLabel = "退出 Vocatrya",
  settingsStore,
  loginItems,
  getWindow,
  createWindow = null,
  logger = console,
} = {}) {
  if (!app) throw new Error("app is required");
  if (!settingsStore) throw new Error("settingsStore is required");
  const resolveWindow = typeof getWindow === "function" ? getWindow : () => undefined;
  const loginItemsAdapter = loginItems || createLoginItemsAdapter({ app });

  let tray = null;
  let quitting = false;
  let creatingWindow = null;

  function liveWindow() {
    const win = resolveWindow();
    return win && !win.isDestroyed() ? win : null;
  }

  function isQuitting() {
    return quitting;
  }

  // before-quit entry point: once a real quit begins, every subsequent window
  // close must pass through — the close-to-tray interception only applies to
  // user-initiated closes while the app keeps running.
  function beginQuit() {
    quitting = true;
  }

  function quit() {
    beginQuit();
    app.quit();
  }

  function shouldStartMinimized() {
    return Boolean(settingsStore.read().startMinimized);
  }

  // Restore path shared by tray activation, tray menu, second-instance, and
  // IPC: a minimized window is restored, a tray-hidden window is shown again,
  // and a missing window (e.g. crashed while the app stayed up) is recreated.
  async function showMainWindow() {
    let win = liveWindow();
    if (!win) {
      if (typeof createWindow !== "function") return;
      // Recreating a destroyed window can fail while the backend is still
      // starting — surface the failure, and never let two restorations race
      // into duplicate windows.
      if (!creatingWindow) {
        creatingWindow = Promise.resolve()
          .then(() => createWindow())
          .catch((error) => {
            logger.error("Main window could not be recreated", error);
          })
          .finally(() => {
            creatingWindow = null;
          });
      }
      await creatingWindow;
      win = liveWindow();
      if (!win) return;
    }
    // show() before restore(): on Windows a hidden+minimized window must be
    // un-hidden first or restore() never reaches it.
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  // close interception: hides to the tray only when the user opted in AND a
  // tray exists to bring the window back — without a tray a hidden window
  // would be unreachable, so the close falls through to a normal quit.
  function attachWindow(window) {
    if (shouldStartMinimized()) {
      // On Windows, minimize() is a no-op on a never-shown window — the OS
      // only minimizes windows that are on screen. show()+minimize() in the
      // same ready-to-show tick opens the window already minimized without a
      // visible flash.
      window.once("ready-to-show", () => {
        if (window.isDestroyed()) return;
        if (!window.isVisible()) window.show();
        window.minimize();
      });
    }
    window.on("close", (event) => {
      if (quitting) return;
      if (!settingsStore.read().closeToTray || !tray) return;
      event.preventDefault();
      window.hide();
    });
  }

  function rebuildTrayMenu() {
    if (!tray || !Menu) return;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: trayOpenLabel, click: () => void showMainWindow() },
        { type: "separator" },
        { label: trayQuitLabel, click: () => quit() },
      ]),
    );
  }

  function ensureTray() {
    if (tray) return tray;
    if (!Tray) return null;
    try {
      let image = trayIconPath;
      if (nativeImage && trayIconPath) {
        const created = nativeImage.createFromPath(trayIconPath);
        if (!created.isEmpty()) image = created;
      }
      tray = new Tray(image);
      tray.setToolTip(trayTooltip);
      rebuildTrayMenu();
      tray.on("click", () => void showMainWindow());
      tray.on("double-click", () => void showMainWindow());
    } catch (error) {
      tray = null;
      logger.error("Desktop tray is unavailable; close-to-tray is disabled", error);
    }
    return tray;
  }

  function readOpenAtLogin() {
    if (!loginItemsAdapter || !loginItemsAdapter.supported) {
      return { supported: false, enabled: false, error: null };
    }
    try {
      return { supported: true, enabled: Boolean(loginItemsAdapter.getOpenAtLogin()), error: null };
    } catch (error) {
      return { supported: true, enabled: false, error };
    }
  }

  function getState() {
    const settings = settingsStore.read();
    const login = readOpenAtLogin();
    return {
      closeToTray: settings.closeToTray,
      // The interception only engages while a tray exists to restore from.
      closeToTrayActive: Boolean(settings.closeToTray && tray),
      startMinimized: settings.startMinimized,
      openAtLogin: login.enabled,
      openAtLoginSupported: login.supported,
      openAtLoginError: login.error ? login.error.message : null,
      trayAvailable: Boolean(tray),
    };
  }

  function updateBooleanSetting(key, enabled) {
    if (typeof enabled !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
    settingsStore.update({ [key]: enabled });
    return getState();
  }

  function setOpenAtLogin(enabled) {
    if (typeof enabled !== "boolean") {
      throw new Error("openAtLogin must be a boolean");
    }
    if (!loginItemsAdapter || !loginItemsAdapter.supported) {
      const error = new Error("Login items are not supported on this platform");
      error.code = "LOGIN_ITEM_UNSUPPORTED";
      throw error;
    }
    loginItemsAdapter.setOpenAtLogin(enabled);
    // Verify against the real OS state — a write that did not land (policy,
    // permissions, registry failure) is reported, never assumed.
    const actual = Boolean(loginItemsAdapter.getOpenAtLogin());
    if (actual !== enabled) {
      const error = new Error(
        `Login item write did not take effect: requested ${enabled}, system reports ${actual}`,
      );
      error.code = "LOGIN_ITEM_WRITE_FAILED";
      throw error;
    }
    return getState();
  }

  // Renderer-facing IPC. Like the window-theme bridge, every handler rejects
  // senders that are not the main window's own main frame on the backend
  // origin — the lifecycle surface gives no capability to other frames.
  function registerIpc(ipcMain, getOrigin) {
    function assertTrustedSender(event) {
      const win = liveWindow();
      const origin = typeof getOrigin === "function" ? getOrigin() : getOrigin;
      if (!win || typeof origin !== "string" || !origin) {
        throw new Error("Untrusted desktop lifecycle sender");
      }
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== origin
      ) {
        throw new Error("Untrusted desktop lifecycle sender");
      }
    }
    const handlers = {
      [LIFECYCLE_IPC_CHANNELS.getState]: () => getState(),
      [LIFECYCLE_IPC_CHANNELS.setCloseToTray]: (_event, payload) =>
        updateBooleanSetting("closeToTray", readEnabledArgument(payload)),
      [LIFECYCLE_IPC_CHANNELS.setStartMinimized]: (_event, payload) =>
        updateBooleanSetting("startMinimized", readEnabledArgument(payload)),
      [LIFECYCLE_IPC_CHANNELS.setOpenAtLogin]: (_event, payload) =>
        setOpenAtLogin(readEnabledArgument(payload)),
      [LIFECYCLE_IPC_CHANNELS.showWindow]: () => showMainWindow(),
      [LIFECYCLE_IPC_CHANNELS.quit]: () => quit(),
    };
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.handle(channel, (event, payload) => {
        assertTrustedSender(event);
        return handler(event, payload);
      });
    }
    return () => {
      for (const channel of Object.keys(handlers)) {
        ipcMain.removeHandler(channel);
      }
    };
  }

  function dispose() {
    const current = tray;
    tray = null;
    if (current) {
      try {
        current.destroy();
      } catch {
        // Teardown must never block an in-progress quit.
      }
    }
  }

  return {
    attachWindow,
    beginQuit,
    dispose,
    ensureTray,
    getState,
    isQuitting,
    quit,
    registerIpc,
    setOpenAtLogin,
    shouldStartMinimized,
    showMainWindow,
    get tray() {
      return tray;
    },
  };
}

module.exports = {
  LIFECYCLE_IPC_CHANNELS,
  createDesktopLifecycle,
  createLoginItemsAdapter,
};
