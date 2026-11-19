const { registerResumePrintIpc } = require("./resume-print");
const { registerWindowThemeIpc } = require("./window-theme");

// Per-window IPC ownership for the main window. window:setTheme and
// resume:printToPDF are process-wide channels bound to ONE BrowserWindow —
// ipcMain rejects a second registration, so the next window can register
// only after the previous window released them.
//
// The release is armed on "closed" BEFORE the first loadURL settles: a
// window closed (or crashed) mid-load still frees its channels. When that
// "closed" never ran before the next registration, registering first
// releases whatever the destroyed window left behind. Once a newer window
// owns the surface a stale release from an old window is a no-op — it can
// never strip IPC owned by its replacement.
function createMainWindowIpcRegistry() {
  let activeRelease = null;

  function registerWindowIpc({ ipcMain, BrowserWindow, nativeTheme, window, origin, assetsRoot, titleBarOverlay }) {
    if (activeRelease) activeRelease();
    const unregisters = [];
    try {
      unregisters.push(registerResumePrintIpc({ ipcMain, BrowserWindow, window, origin }));
      unregisters.push(registerWindowThemeIpc({ ipcMain, nativeTheme, window, origin, assetsRoot, titleBarOverlay }));
    } catch (error) {
      // Never leak a half-registered surface: a duplicate-channel failure
      // rolls our handlers back and leaves the foreign owner untouched.
      for (const unregister of unregisters) unregister();
      throw error;
    }
    let released = false;
    const release = () => {
      if (released || activeRelease !== release) return;
      released = true;
      activeRelease = null;
      for (const unregister of unregisters) unregister();
    };
    activeRelease = release;
    window.once("closed", release);
    return release;
  }

  return { registerWindowIpc };
}

module.exports = { createMainWindowIpcRegistry };
