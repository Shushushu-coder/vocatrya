// True only inside the Electron main window: preload.js exposes the
// vocatryaWindow bridge there and nowhere else (web build, hidden print
// window, jsdom). This is the same signal the data-desktop CSS gate keys
// off, so JS and CSS never disagree about which chrome is live.
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && Boolean(window.vocatryaWindow);
}
