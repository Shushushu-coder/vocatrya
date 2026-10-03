const path = require("node:path");

// ICO 16/24px entries are explicit Optical symbols. All larger entries are
// byte-identical to static icon.ico, so Electron's ICON_BIG stays app identity.
function registerWindowThemeIpc({ ipcMain, nativeTheme, window, origin, assetsRoot, platform = process.platform }) {
  const channel = "window:setTheme";
  ipcMain.handle(channel, (event, theme, preference = theme) => {
    if (window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== origin) {
      throw new Error("Untrusted window theme sender");
    }
    if (theme !== "light" && theme !== "dark") throw new Error("Invalid resolved theme");
    if (preference !== "system" && preference !== theme) throw new Error("Invalid theme preference");
    if (platform !== "win32") return;
    // Match native chrome for explicit overrides, but leave the OS media query
    // live in System mode so next-themes can keep following system changes.
    nativeTheme.themeSource = preference;
    window.setIcon(path.join(assetsRoot, theme === "dark"
      ? "native-window-light-symbol.ico" : "native-window-dark-symbol.ico"));
  });
  return () => ipcMain.removeHandler(channel);
}

module.exports = { registerWindowThemeIpc };
